import * as THREE from 'three'
import { type Fill, type ShaderSpec, hexBytes, patternImageData, ombrePicker, fillIsShader, effectiveTileFill, fillTileCanvas, fillTileKey } from './fillTile'
import { paintTileBox } from '~/lib/compositor/paint'
import { parseHexA, stripAlpha } from '~/lib/color/convert'
import { resolveField, withFieldFrame, type FieldRequest } from '~/lib/shaderfill/field'
import { specIdentityKey, resolveEffectParams } from '~/lib/shaderfill/descriptor'
// From catalogStore, NOT ~/lib/shaderfx/catalog: this module ends up in the
// Space Type embed bundle (via effects/index.ts), which must never bundle
// catalog.ts's `$fetch('/sailor/shader_effects')` — see catalogStore.ts's doc.
import { getEffectSync } from '~/lib/shaderfx/catalogStore'

/**
 * GPU/THREE fill builders. The CPU fill model (Fill, FILL_TYPES, parsing) and the 2D-canvas
 * tile builder live in ./fillTile (THREE-free, so the Frame-modal compositor can reuse them).
 * Re-exported here so existing importers of fills.ts (SpaceTypeSurface, etc.) are unchanged.
 */
export {
  type Fill, type FillType, FILL_TYPES, DEFAULT_FILL,
  fillIsTextured, parseFills, serializeFills, normalizeFill,
  hexBytes, patternImageData, ombrePicker, fillTileCanvas, fillTileKey,
} from './fillTile'

/** The fill's primary colour — used for solid fills and for cross-row gradient-mode lerps.
 *  Alpha is stripped: THREE.Color has no alpha channel and silently renders 8-digit hex WHITE.
 *  Read the alpha separately with fillAlpha(). */
export function fillPrimary(three: typeof THREE, fill: Fill): THREE.Color {
  return new three.Color(stripAlpha(fill.a))
}

/** The fill's alpha, 0–1. Legacy 6-digit fills are fully opaque. */
export function fillAlpha(fill: Fill): number {
  return parseHexA(fill.a).alpha
}

/** The fill's TEXT colour as a THREE.Color. Alpha is stripped for the same reason as
 *  fillPrimary: THREE.Color has no alpha channel and renders 8-digit hex as white.
 *  Read the alpha separately with fillTextAlpha(). */
export function fillTextColor(three: typeof THREE, fill: Fill): THREE.Color {
  return new three.Color(stripAlpha(fill.textColor))
}

/** The alpha of the fill's text colour, 0–1. Legacy 6-digit values are fully opaque. */
export function fillTextAlpha(fill: Fill): number {
  return parseHexA(fill.textColor).alpha
}

// ── Fill anchor (Task 5) ─────────────────────────────────────────────────────────────────
// Every uFill-sampling effect binds `uFillAnchor`/`uFillScreen` from these two helpers — the
// single central source, so no effect invents its own default or reads `fill.shader.anchor`
// directly. `uFillAnchor` picks the fill's UV space in the shader: 0 = object (glyph UV, the
// existing `uv * uFillTiling` behaviour), 1 = frame (screen space, `gl_FragCoord / uFillScreen`
// — the field stays fixed while the glyphs move over it). Only a shader fill actually carries
// an anchor (`ShaderSpec.anchor`); every other fill type has no field to detach from, so it's
// always object-anchored (0) regardless of anchor's stale/absent value.

/** 0 = object anchor, 1 = frame anchor — bind directly to a material's `uFillAnchor` uniform. */
export function fillAnchor(fill: Fill): number {
  return fillIsShader(fill) && fill.shader.anchor === 'frame' ? 1 : 0
}

/** The render-target resolution (pixels) for the shader-fill build CURRENTLY in progress.
 *  Only meaningful while `buildScene`/`setConfig` runs inside `withShaderFillContext` (see
 *  below); outside that window (should not happen on the real Space Type/Shape Studio paths)
 *  it falls back to `FALLBACK_FIELD_PX`. Kept for callers that just want the raw numbers;
 *  `fillScreenVec` below is what every `uFillScreen` uniform should actually bind to. */
export function fillScreenSize(): [number, number] {
  return [_activeContext.w, _activeContext.h]
}

/**
 * IMPORTANT 4 fix (final review): a frame-anchored fill's `uFillScreen` uniform used to be
 * `new three.Vector2(...fillScreenSize())` — a plain VALUE snapshot of the size at BUILD time,
 * baked once. `SpaceTypeEngine.setSize()` (engine.ts) deliberately resizes the renderer WITHOUT
 * a rebuild (a cheap live-resize path), and `W`/`H` aren't part of the effect's rebuild key
 * (`structuralSignature` in SpaceTypeSurface.vue), so a canvas resize left a frame-anchored
 * field dividing `gl_FragCoord` by the OLD resolution — silently wrong (shifted/scaled field)
 * until an unrelated edit happened to force a rebuild.
 *
 * Fix: every `uFillScreen` uniform for one owner now shares ONE mutable `THREE.Vector2`
 * object (keyed by `_activeContext.ownerId`, so two open engines never share one) — `.value`
 * IS that object, not a copy, so mutating its x/y later (via `updateLiveScreenSize` below)
 * propagates to the shader on the very next render with no rebuild needed, the same way a
 * `THREE.Texture`'s pixels can change in place without recompiling the material that samples
 * it. Call this INSIDE `buildScene`/`setConfig` (same synchronous-build requirement
 * `withShaderFillContext` already documents) — it reads `_activeContext` exactly like
 * `fillScreenSize()` does. */
const _liveScreenSizes = new Map<string, THREE.Vector2>()

export function fillScreenVec(three: typeof THREE): THREE.Vector2 {
  const id = _activeContext.ownerId
  let v = _liveScreenSizes.get(id)
  if (!v) { v = new three.Vector2(_activeContext.w, _activeContext.h); _liveScreenSizes.set(id, v) }
  return v
}

/** Refresh `ownerId`'s live `uFillScreen` value in place — call once per host frame (e.g. from
 *  `SpaceTypeEngine.renderFrameAt`, alongside `refreshLiveShaderFills`), passing the engine's
 *  CURRENT output size. A cheap no-op for an owner that has never called `fillScreenVec` (no
 *  frame-anchored fill exists for it), so an ordinary scene's frame loop pays nothing new. */
export function updateLiveScreenSize(ownerId: string, w: number, h: number): void {
  const v = _liveScreenSizes.get(ownerId)
  if (v) v.set(w, h)
}

// Textures are cached by (type|a|b) so repeated slots/rebuilds reuse one GPU texture. Module
// singletons (never disposed) — the set of distinct fills in a doc is tiny.
const _cache = new Map<string, THREE.Texture>()

// ── Shader (object-anchor) field textures ────────────────────────────────────────────────
// Fallback field size used only when shaderFieldTexture is somehow called with no active
// build context (see UNOWNED below) — should not happen on the real Space Type/Shape Studio
// paths, which always run inside withShaderFillContext. Matches resolveField's own
// LIVE_FIELD_PX ceiling (~/lib/shaderfill/field.ts).
const FALLBACK_FIELD_PX = 512

const UNOWNED = '__unowned__'

/** Identifies which `SpaceTypeEngine`/`ShapeEngine` instance a shader fill's texture belongs
 *  to, plus the size/bake-mode that instance wants it rendered at. Review fix (Task 4): the
 *  cache below used to be pooled globally across every open engine, so `refreshLiveShaderFills`
 *  re-resolved EVERY node's fields on EVERY node's frame tick (multiplying GPU work by the
 *  number of open engines) and `beginFieldFrame`'s LIVE_FIELD_CEILING was applied across all
 *  of them by insertion order — a node could report "frozen" for fields it does not own, or
 *  starve indefinitely behind an unrelated, possibly invisible node. Scoping by owner fixes
 *  both: each engine only ever asks for its own fields, so the ceiling and the frozen count
 *  are per-surface, matching `beginFieldFrame`'s own doc ("per surface per frame"). */
interface ShaderFillBuildContext { ownerId: string; w: number; h: number; bake: boolean }
let _activeContext: ShaderFillBuildContext = { ownerId: UNOWNED, w: FALLBACK_FIELD_PX, h: FALLBACK_FIELD_PX, bake: false }

/**
 * Run `fn` (a SYNCHRONOUS material-build call — `effect.buildScene()` / `ShapeEngine.setConfig()`)
 * with `ctx` as the "current" shader-fill build context, so `shaderFieldTexture` — called deep
 * inside `fn`, from any of the ~20 effect modules, none of which have an engine/owner reference
 * in scope — knows which engine is asking without threading an `ownerId` parameter through
 * every one of their `fillShaderTexture()`/`fillTexture()` call sites.
 *
 * Safe ONLY BECAUSE `buildScene`/`setConfig` are synchronous (no `await` anywhere in either
 * current implementation — see the comment at each call site): JS is single-threaded, so as
 * long as that holds, nothing can run between the `set` below and the matching `restore` and
 * observe or clobber the wrong owner — two engines' builds can never interleave. This is a load-
 * bearing assumption, not just an optimisation: if it silently broke (a `buildScene` gaining an
 * `await`), fields would get attributed to whichever build happens to still be active, with no
 * error — exactly this feature's recurring failure mode, arriving by a new route. So this
 * throws on RE-ENTRY instead of nesting/queueing: a caller entering while another owner's
 * context is still active means the synchronous assumption already broke, and that must fail
 * loudly at the moment it breaks, not degrade into silent misattribution. If `buildScene` ever
 * needs to become async, this whole scheme must be replaced with real ownerId parameter-
 * threading through `shaderFieldTexture`'s callers instead.
 */
export function withShaderFillContext<T>(ctx: ShaderFillBuildContext, fn: () => T): T {
  if (_activeContext.ownerId !== UNOWNED) {
    throw new Error(
      `withShaderFillContext: re-entered for owner "${ctx.ownerId}" while owner ` +
      `"${_activeContext.ownerId}"'s build is still in progress. This means a build ` +
      `(SpaceTypeEngine.build() / ShapeEngine.setConfig()) is no longer synchronous — see this ` +
      `function's doc comment.`,
    )
  }
  _activeContext = ctx
  try { return fn() } finally { _activeContext = { ownerId: UNOWNED, w: FALLBACK_FIELD_PX, h: FALLBACK_FIELD_PX, bake: false } }
}

interface LiveShaderFillEntry { tex: THREE.CanvasTexture; spec: ShaderSpec; ownerId: string }
// Bounded per-owner (final review, Important 6) — bounding by explicit owner lifetime
// ALONE (cleared in clearShaderFillOwner() when an engine disposes) assumed the set of
// distinct specs one owner ever registers stays small ("live engines × fills per
// engine"), which held until a rebuild's key could change out from under an entry that
// never got cleaned up (see shaderFieldTexture's doc below): param churn on one fill
// during a catalog outage (e.g. dragging a slider while resolveEffectParams keeps
// falling back to raw params) registers a FRESH orphaned entry — and its own
// CanvasTexture/canvas — per distinct raw param combination, none of them ever
// reachable again once the slider moves on, and none of them ever evicted. Capped
// PER-OWNER (not globally) so churn on one owner can never evict another, unrelated
// owner's live entries — only that owner's own stale ones, oldest first (insertion
// order), which are exactly the entries a rebuild has already stopped pointing at.
const SHADER_FIELD_CACHE_MAX_PER_OWNER = 32
const _shaderFieldCache = new Map<string, LiveShaderFillEntry>()

/** Evict the OLDEST entry belonging to `ownerId` (if any) — called right before
 *  inserting a NEW one for that owner once it's at the per-owner cap. Disposes the
 *  evicted entry's texture, same as `clearShaderFillOwner`; safe because an entry only
 *  survives to become "oldest" by never being re-hit (a cache HIT doesn't reinsert —
 *  unlike field.ts's LRU caches, there is no live-material recency signal to preserve
 *  here beyond insertion order, and the entry actually still driving a visible material
 *  is always the just-inserted (freshest) one for that spec identity). */
function evictOldestForOwner(ownerId: string): void {
  for (const [key, entry] of _shaderFieldCache) {
    if (entry.ownerId !== ownerId) continue
    entry.tex.dispose()
    _shaderFieldCache.delete(key)
    return
  }
}

/** Resolve a shader fill spec to its live field texture — the ONLY place Space Type/Shape
 *  Studio materials get a shader fill's `uFill` texture from. Reused across BOTH
 *  `fillTexture` and `fillShaderTexture` (the latter delegates to the former for any
 *  non-solid fill), so every consumer of either goes through here.
 *
 *  Binds resolveField's canvas DIRECTLY as the CanvasTexture source — never copied, per its
 *  ownership contract (~/lib/shaderfill/field.ts). Falls back to the INPUT fill's own texture
 *  when the field can't be produced yet (unknown effect not loaded, WebGL context loss) —
 *  resolveField returns null in both cases, and the user must see the input fill, never an
 *  empty/blank shape. A cache entry IS made on a fallback (see the CRITICAL fix below) — the
 *  next per-frame refresh (or the next material rebuild) finds that entry and heals it in
 *  place rather than freezing on the fallback forever.
 *
 *  KEY DOMAIN INVARIANT (final review, Important 6 — read this before changing how `key` is
 *  computed): the key must be computed in the SAME param domain the entry will later be
 *  healed into, i.e. it must not change just because `getEffectSync` starts returning
 *  non-null. Keys on the spec's RAW `params` — NOT `resolveEffectParams`'s resolved output —
 *  for exactly that reason: `effect` is null (unresolved) on a catalog-load-race miss and
 *  non-null on every rebuild after the catalog lands, so a key derived from the RESOLVED
 *  params (defaults filled in, unknown keys dropped) is a DIFFERENT string in each case for
 *  the identical authored spec. That used to register a SECOND entry (and a second
 *  `CanvasTexture` + canvas) the moment the catalog landed and an unrelated edit triggered a
 *  rebuild, orphaning the first (miss) entry — never reachable again, but still walked and
 *  re-resolved every frame by `refreshLiveShaderFills` below, forever. Keying on the raw spec
 *  is stable across that transition, so a rebuild after a miss reuses (and — via
 *  `refreshLiveShaderFills`'s per-frame loop — heals) the SAME entry instead of doubling it.
 *  The trade-off: `params: {}` and `params: { amount: <the effect's own default> }` — pixel
 *  identical once resolved — now key as two distinct entries/textures rather than collapsing
 *  to one; a minor, bounded memory cost (see `SHADER_FIELD_CACHE_MAX_PER_OWNER` above), not a
 *  correctness one — `resolveField`'s OWN cache (`~/lib/shaderfill/field.ts`) still keys the
 *  actual GPU render on resolved params, so the batching/dedup that matters for render cost
 *  is untouched by this.
 *
 *  CRITICAL fix (final review, residual Item 2): a `resolveField` MISS used to return the
 *  input fill's texture directly and insert NOTHING into `_shaderFieldCache` — but
 *  `refreshLiveShaderFills` below only ever iterates EXISTING entries, so a miss with no
 *  entry could never be found and healed by a later frame; only a fresh
 *  `withShaderFillContext` build (a full rebuild, not the per-frame preview loop) could
 *  retry, and Space Type/Shape Studio's node cards only rebuild on mount + a debounced
 *  config change. A hard-reload racing the catalog fetch is therefore a GUARANTEED miss on
 *  first build, and it fell back to the input fill FOREVER even though the rAF preview kept
 *  calling `refreshLiveShaderFills` every frame — there was simply no cache entry there for
 *  it to retry. Fixed by ALWAYS registering an entry, hit or miss, mirroring how
 *  `materialFor` in ~/lib/scene3d/materials.ts always adds its material to
 *  `shaderFillMaterials` regardless of whether its `.map` build succeeded. The texture must
 *  be a DEDICATED (never shared) `CanvasTexture` — reusing a fallback texture pooled in
 *  `_cache`/`_shaderCache` below would mean a later `refreshLiveShaderFills` swap of `.image`
 *  silently corrupts every OTHER, unrelated fill still displaying that same pooled texture.
 *  Seeded with the rasterised input tile on a miss (identical pixels to the old fallback, so
 *  the very first frame looks the same either way) — the difference is this entry now
 *  EXISTS, so the owning engine's next per-frame refresh can swap it to the real field the
 *  moment `resolveField` succeeds (itself kicked by field.ts's own `kickCatalogFetch`). */
function shaderFieldTexture(three: typeof THREE, spec: ShaderSpec): THREE.Texture {
  const ctx = _activeContext
  const effect = getEffectSync(spec.effectId)
  const resolvedSpec = effect ? { ...spec, params: resolveEffectParams(effect, spec.params) } : spec
  // See the KEY DOMAIN INVARIANT doc above: always the RAW spec, never resolvedSpec.
  const key = `${ctx.ownerId}::${specIdentityKey(spec)}`
  const hit = _shaderFieldCache.get(key)
  if (hit) return hit.tex

  const canvas = resolveField({ spec, w: ctx.w, h: ctx.h, t: 0, fps: 30, bake: ctx.bake })
  // spec.input is a Paint (string | Gradient | Fill) — paintTileBox handles the
  // shader-typed-Fill unwrap internally, same fallback the old
  // fillTileBox(effectiveTileFill(...)) pairing produced for a Fill input, now
  // extended to render an actual gradient/colour tile instead of downgrading one.
  const initial = canvas ?? paintTileBox(spec.input, ctx.w, ctx.h)
  const tex = new three.CanvasTexture(initial)
  tex.wrapS = tex.wrapT = three.ClampToEdgeWrapping
  tex.colorSpace = three.SRGBColorSpace
  tex.needsUpdate = true

  let ownerCount = 0
  for (const e of _shaderFieldCache.values()) if (e.ownerId === ctx.ownerId) ownerCount++
  if (ownerCount >= SHADER_FIELD_CACHE_MAX_PER_OWNER) evictOldestForOwner(ctx.ownerId)

  _shaderFieldCache.set(key, { tex, spec: resolvedSpec, ownerId: ctx.ownerId })
  return tex
}

/** Advance every shader-fill texture OWNED BY `ownerId` to time `t` (seconds), reusing each
 *  entry's SAME THREE.CanvasTexture object — set `.image`/`needsUpdate` in place rather than
 *  allocating a new CanvasTexture per frame, per resolveField's ownership contract. Effects
 *  never call this themselves: they only hold the texture object `fillShaderTexture`/
 *  `fillTexture` handed them at build time (stashed in a material's `uFill` uniform); this is
 *  the ONE place that keeps it moving frame to frame, generically across every effect, with no
 *  per-effect changes needed. Call once per host frame, BEFORE the THREE render call, with the
 *  CALLING engine's own id — see SpaceTypeEngine.renderFrameAt. Scoped to `ownerId` so
 *  `beginFieldFrame`'s LIVE_FIELD_CEILING (and the frozen-field count it returns) applies PER
 *  SURFACE, not pooled across every open engine (see ShaderFillBuildContext's doc).
 *
 *  `w`/`h`/`bake` size the request — pass the engine's actual output size and whether this
 *  frame is a final export bake (unclamped) vs a live preview (clamped to
 *  resolveField's LIVE_FIELD_PX), matching the preview/bake split `field.ts` documents.
 *
 *  Returns the frozen-field count from beginFieldFrame so the surface can show a hint when a
 *  fill is capped at a still frame instead of animating — never truncate silently. */
export function refreshLiveShaderFills(ownerId: string, t: number, fps: number, w: number, h: number, bake: boolean): { frozenCount: number } {
  const entries: LiveShaderFillEntry[] = []
  for (const e of _shaderFieldCache.values()) if (e.ownerId === ownerId) entries.push(e)
  if (entries.length === 0) return { frozenCount: 0 }
  const requests: FieldRequest[] = entries.map(e => ({ spec: e.spec, w, h, t, fps, bake }))
  // withFieldFrame owns the begin/end pairing in a try/finally (see its doc in
  // ~/lib/shaderfill/field.ts) — a throw anywhere in the loop below can no longer leave
  // the module-global field-frame span stuck open.
  return withFieldFrame(requests, (frozenCount, token) => {
    for (let i = 0; i < entries.length; i++) {
      const canvas = resolveField(requests[i]!, token)
      if (!canvas) continue                          // keep showing the last good frame
      const entry = entries[i]!
      if (entry.tex.image !== canvas) {
        entry.tex.image = canvas
        entry.tex.needsUpdate = true
      }
    }
    return { frozenCount }
  })
}

/** Drop every shader-fill texture owned by `ownerId`, disposing its GPU texture. Call when
 *  the owning engine is disposed — see the ownership-scoping doc above. Not called on every
 *  rebuild/effect switch (only on disposal): a `SpaceTypeEngine` pools built roots
 *  (`ROOT_CACHE_LIMIT`, see engine.ts) and swaps a cached root back in WITHOUT calling
 *  `buildScene`/`shaderFieldTexture` again, so clearing this owner's whole cache on every
 *  rebuild would strand that cached root's materials with textures nothing refreshes anymore
 *  the next time it's swapped back in. Left un-evicted between rebuilds, this owner's cache
 *  stays bounded by "distinct shader fills across this engine's currently pooled roots" —
 *  small by the same reasoning `ROOT_CACHE_LIMIT` relies on. */
export function clearShaderFillOwner(ownerId: string): void {
  for (const [key, entry] of _shaderFieldCache) {
    if (entry.ownerId !== ownerId) continue
    entry.tex.dispose()
    _shaderFieldCache.delete(key)
  }
  _liveScreenSizes.delete(ownerId)   // see fillScreenVec's doc — one Vector2 per owner
}

/** Build (or fetch cached) the tiling texture for a fill. Returns null for `solid`. Shader
 *  fills resolve through shaderFieldTexture (the live field, or a graceful fallback to the
 *  input fill) — never through the switch below, which has no shader case and would
 *  otherwise silently fall into the qr branch. */
export function fillTexture(three: typeof THREE, fill: Fill): THREE.Texture | null {
  if (fillIsShader(fill)) return shaderFieldTexture(three, fill.shader)
  if (fill.type === 'shader') return fillTexture(three, effectiveTileFill(fill))   // no spec yet — degrade to input
  if (fill.type === 'solid') return null
  // shapeId is only meaningful for `shapes`; include it in the key so two shape patterns that
  // share colours/density/angle but differ in shape don't alias to the same cached texture.
  const key = fillTileKey(fill)
  const hit = _cache.get(key)
  if (hit) return hit
  const t = fill.type === 'gradient' ? gradientRamp(three, fill.a, fill.b)
    : fill.type === 'ombre' ? ombreTex(three, fill.a, fill.b, fill.angle)
    : fill.type === 'grid' ? gridTex(three, fill.a, fill.b, fill.density)
    : fill.type === 'noise' ? noiseTex(three, fill.a, fill.b)
    : fill.type === 'checkerboard' ? checkerboardTex(three, fill.a, fill.b, fill.density)
    : fill.type === 'stripes' ? stripesTex(three, fill.a, fill.b, fill.angle, fill.density)
    : fill.type === 'shapes' ? shapesTex(three, fill)
    : fill.type === 'paper' ? paperTex(three, fill)
    : qrTex(three, fill.a, fill.b, fill.density)
  _cache.set(key, t)
  return t
}

// GLSL sRGB→linear decode for fill textures sampled MANUALLY in custom shaders (three only
// auto-decodes textures bound to known material slots like `map`, not raw texture2D calls).
// Without this the canvas colours render washed-out/faded. WebGL1-safe (step, not bvec mix).
export const SRGB_TO_LINEAR_GLSL =
  'vec3 stLin(vec3 c){ return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(vec3(0.04045), c)); }'

// ── Shader path ───────────────────────────────────────────────────────────────────────────
// Effects that paint through a custom ShaderMaterial sample the fill as a 2D texture. So every
// fill (including solid) resolves to a texture here — solid becomes a 1×1 swatch. The shader
// reads `texture2D(uFillTex, uv * uFillTiling)`; tiling makes grid/noise repeat without needing
// per-use texture.repeat (which custom shaders don't auto-apply).
const _shaderCache = new Map<string, THREE.Texture>()

export function fillShaderTexture(three: typeof THREE, fill: Fill): THREE.Texture {
  if (fill.type !== 'solid') return fillTexture(three, fill)!   // gradient/grid/noise/shader already textures
  const key = `solid|${fill.a}`
  const hit = _shaderCache.get(key)
  if (hit) return hit
  const c = document.createElement('canvas'); c.width = 1; c.height = 1
  const ctx = c.getContext('2d')!
  ctx.fillStyle = fill.a; ctx.fillRect(0, 0, 1, 1)
  const t = new three.CanvasTexture(c); t.wrapS = t.wrapT = three.ClampToEdgeWrapping
  t.colorSpace = three.SRGBColorSpace
  _shaderCache.set(key, t)
  return t
}

/** How many times the fill texture tiles per unit UV (patterned fills repeat; solid/gradient = 1). */
export function fillTiling(fill: Fill): number {
  if (fill.type === 'noise') return 3
  return 1
}

/**
 * Stack a fill LIST into one vertical atlas (band i = fill i), so a single shader can paint a
 * per-segment palette of textured fills: sample at `v = (slot + localV) / count`. `flipY=false`
 * ⇒ canvas-y maps straight to texture-v (band i at v∈[i/n,(i+1)/n]). Cached by the fills' recipe.
 */
const _atlasCache = new Map<string, THREE.Texture>()

export function fillAtlasTexture(three: typeof THREE, fills: Fill[]): THREE.Texture {
  // shapeId only matters for `shapes`; fold it in so two shape patterns that differ only by shape
  // (same colours/density/angle) don't collide onto one cached atlas (mirrors fillTexture's key).
  const key = fills.map(f => `${f.type}:${f.a}:${f.b}:${f.angle}:${f.density}${f.type === 'shapes' ? ':' + (f.shapeId ?? 'sparkle') + ':' + f.shapeSize + ':' + f.shapeGap + ':' + (f.shapeFit ?? 'tile') : f.type === 'paper' ? ':' + String(f.grain ?? 0.4) : ''}`).join('|')
  const hit = _atlasCache.get(key)
  if (hit) return hit
  const BAND = 256, W = 256, nb = Math.max(1, fills.length)
  const c = document.createElement('canvas'); c.width = W; c.height = BAND * nb
  const ctx = c.getContext('2d')!
  fills.forEach((fill, i) => {
    const y0 = i * BAND
    if (fill.type === 'gradient') {
      const g = ctx.createLinearGradient(0, y0, 0, y0 + BAND)
      g.addColorStop(0, fill.a); g.addColorStop(1, fill.b)
      ctx.fillStyle = g; ctx.fillRect(0, y0, W, BAND)
    } else if (fill.type === 'ombre') {
      ctx.putImageData(patternImageData(W, BAND, hexBytes(fill.a), hexBytes(fill.b), ombrePicker(W, BAND, fill.angle)), 0, y0)
    } else if (fill.type === 'grid') {
      const d = Math.max(1, Math.round(fill.density)), step = W / d
      ctx.fillStyle = fill.a; ctx.fillRect(0, y0, W, BAND)
      ctx.strokeStyle = fill.b; ctx.lineWidth = Math.max(1, Math.round(4 * (3 / d)))
      for (let gx = 0; gx <= d; gx++) { ctx.beginPath(); ctx.moveTo(gx * step, y0); ctx.lineTo(gx * step, y0 + BAND); ctx.stroke() }
      for (let gy = 0; gy <= d; gy++) { ctx.beginPath(); ctx.moveTo(0, y0 + gy * step); ctx.lineTo(W, y0 + gy * step); ctx.stroke() }
    } else if (fill.type === 'noise') {
      const dark = hexBytes(fill.a), light = hexBytes(fill.b)
      const img = ctx.createImageData(W, BAND)
      for (let p = 0; p < img.data.length; p += 4) {
        const px = (p / 4) % W, py = Math.floor((p / 4) / W) + y0
        const h = Math.sin((px * 12.9898 + py * 78.233)) * 43758.5453
        const f = (h - Math.floor(h)) < 0.5 ? 0 : 1
        img.data[p] = dark[0] + (light[0] - dark[0]) * f
        img.data[p + 1] = dark[1] + (light[1] - dark[1]) * f
        img.data[p + 2] = dark[2] + (light[2] - dark[2]) * f
        img.data[p + 3] = 255
      }
      ctx.putImageData(img, 0, y0)
    } else if (fill.type === 'checkerboard') {
      drawPatternBand(ctx, fill, y0, W, BAND)
    } else if (fill.type === 'stripes') {
      drawPatternBand(ctx, fill, y0, W, BAND)
    } else if (fill.type === 'qr') {
      drawPatternBand(ctx, fill, y0, W, BAND)
    } else if (fill.type === 'shapes') {
      // Stamp the shared shape tile into this band (the band is exactly one BAND×BAND tile cell),
      // so shutter/coil copies get tiled shapes instead of a flat colour. Transparent bg survives.
      ctx.drawImage(fillTileCanvas(fill, BAND), 0, y0)
    } else if (fill.type === 'paper') {
      // Stamp the shared paper tile into this band (one BAND×BAND cell), so per-segment
      // palettes get real grain instead of a flat colour.
      ctx.drawImage(fillTileCanvas(fill, BAND), 0, y0)
    } else {
      ctx.fillStyle = fill.a; ctx.fillRect(0, y0, W, BAND)
    }
  })
  const t = new three.CanvasTexture(c)
  t.flipY = false
  t.wrapS = three.RepeatWrapping
  t.wrapT = three.ClampToEdgeWrapping
  t.colorSpace = three.SRGBColorSpace
  _atlasCache.set(key, t)
  return t
}

/** Vertical A→B gradient ramp (a at top, b at bottom). */
function gradientRamp(three: typeof THREE, a: string, b: string): THREE.Texture {
  const c = document.createElement('canvas'); c.width = 4; c.height = 256
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0, a); g.addColorStop(1, b)
  ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 256)
  const t = new three.CanvasTexture(c); t.wrapS = t.wrapT = three.ClampToEdgeWrapping
  t.colorSpace = three.SRGBColorSpace
  return t
}

/** Ombre dither for an EXTRUDE side wall: the grainy fade runs along V (the extrude depth) and
 *  the perimeter (U) tiles. ClampToEdge on V so the whole 0→1 depth is ONE fade (no repeat banding),
 *  unlike the tiled grid/noise side textures. Solid `a` at the near face → grain → solid `b` at the far. */
export function ombreSideTexture(three: typeof THREE, a: string, b: string): THREE.Texture {
  const N = 256
  const c = document.createElement('canvas'); c.width = N; c.height = N
  const ctx = c.getContext('2d')!
  // angle 90 → fade along the canvas height (V); flipY (CanvasTexture default) puts V=0 at the bottom.
  ctx.putImageData(patternImageData(N, N, hexBytes(a), hexBytes(b), ombrePicker(N, N, 90)), 0, 0)
  const t = new three.CanvasTexture(c)
  t.colorSpace = three.SRGBColorSpace
  t.wrapS = three.RepeatWrapping
  t.wrapT = three.ClampToEdgeWrapping
  t.magFilter = three.NearestFilter; t.minFilter = three.NearestFilter
  t.generateMipmaps = false
  return t
}

/** Standard filtering for fill pattern textures: crisp edges up close (nearest magnification)
 *  but anti-aliased when minified on tilted/receding geometry (mipmaps + anisotropy). Replaces
 *  the old NearestFilter-without-mipmaps, which shimmered/aliased on the wavy bands. */
function tunePattern(three: typeof THREE, t: THREE.Texture): void {
  t.colorSpace = three.SRGBColorSpace
  t.wrapS = t.wrapT = three.RepeatWrapping
  t.generateMipmaps = true
  t.magFilter = three.NearestFilter
  t.minFilter = three.NearestMipmapLinearFilter
  t.anisotropy = 8
}

function ombreTex(three: typeof THREE, a: string, b: string, angle: number): THREE.Texture {
  const N = 256
  const c = document.createElement('canvas'); c.width = N; c.height = N
  const ctx = c.getContext('2d')!
  ctx.putImageData(patternImageData(N, N, hexBytes(a), hexBytes(b), ombrePicker(N, N, angle)), 0, 0)
  const t = new three.CanvasTexture(c)
  tunePattern(three, t)
  return t
}

/** Grid: `a` cell fill + `b` border lines. */
// Tiled library-shape pattern. Reuses the 2D canvas tile builder (the same one the compositor
// swatch and box render use), so the GPU surface matches the CPU render exactly. A transparent
// background (b='none'/'') survives as real alpha through CanvasTexture. 512px keeps the motifs
// crisp at high density; tunePattern sets SRGB + RepeatWrapping so it tiles seamlessly.
function shapesTex(three: typeof THREE, fill: Fill): THREE.Texture {
  const t = new three.CanvasTexture(fillTileCanvas(fill, 512))
  tunePattern(three, t)
  return t
}

/** Paper: the same CPU tile builder the swatch/box render use, so the GPU surface matches the
 *  CPU render exactly. 512px keeps the grain crisp; tunePattern sets SRGB + RepeatWrapping. */
function paperTex(three: typeof THREE, fill: Fill): THREE.Texture {
  const t = new three.CanvasTexture(fillTileCanvas(fill, 512))
  tunePattern(three, t)
  return t
}

function gridTex(three: typeof THREE, a: string, b: string, density: number): THREE.Texture {
  const N = 512, d = Math.max(1, Math.round(density)), step = N / d
  const c = document.createElement('canvas'); c.width = N; c.height = N
  const ctx = c.getContext('2d')!
  ctx.fillStyle = a; ctx.fillRect(0, 0, N, N)
  ctx.strokeStyle = b; ctx.lineWidth = Math.max(1, Math.round(6 * (3 / d)))
  for (let i = 0; i <= d; i++) {
    ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step, N); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(0, i * step); ctx.lineTo(N, i * step); ctx.stroke()
  }
  const t = new three.CanvasTexture(c)
  tunePattern(three, t)
  return t
}

/** Hard-threshold black/white-style grain between `a` (dark) and `b` (light), crisp at angles. */
function noiseTex(three: typeof THREE, a: string, b: string): THREE.Texture {
  const dark = hexBytes(a), light = hexBytes(b)
  const N = 256
  const c = document.createElement('canvas'); c.width = N; c.height = N
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(N, N)
  for (let i = 0; i < img.data.length; i += 4) {
    // Deterministic hash grain, hard-thresholded so the two colours stay distinct (no grey mush).
    const h = Math.sin(i * 12.9898) * 43758.5453
    const f = (h - Math.floor(h)) < 0.5 ? 0 : 1
    img.data[i] = dark[0] + (light[0] - dark[0]) * f
    img.data[i + 1] = dark[1] + (light[1] - dark[1]) * f
    img.data[i + 2] = dark[2] + (light[2] - dark[2]) * f
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const t = new three.CanvasTexture(c)
  tunePattern(three, t)
  return t
}


function drawPatternBand(ctx: CanvasRenderingContext2D, fill: Fill, y0: number, w: number, h: number) {
  const colA = hexBytes(fill.a), colB = hexBytes(fill.b)
  const d = Math.max(2, Math.round(fill.density))
  const img = fill.type === 'checkerboard'
    ? patternImageData(w, h, colA, colB, (px, py) => (Math.floor(px * d / w) + Math.floor(py * d / h)) % 2 === 1)
    : fill.type === 'stripes'
      ? (() => {
          const rad = (fill.angle * Math.PI) / 180
          const dx = Math.cos(rad), dy = Math.sin(rad)
          return patternImageData(w, h, colA, colB, (px, py) => {
            const proj = px * dx + py * dy
            return Math.floor(proj / (w / d)) % 2 !== 0
          })
        })()
      : patternImageData(w, h, colA, colB, (px, py) => {
          const cx = Math.floor(px * d / w), cy = Math.floor(py * d / h)
          const v = Math.sin((cx * 12.9898 + cy * 78.233 + cx * cy * 3.71)) * 43758.5453
          return (v - Math.floor(v)) > 0.45
        })
  ctx.putImageData(img, 0, y0)
}

// ── Standalone fill textures for new pattern types ───────────────────────────

function checkerboardTex(three: typeof THREE, a: string, b: string, density: number): THREE.Texture {
  const N = 512, d = Math.max(2, Math.round(density))
  const colA = hexBytes(a), colB = hexBytes(b)
  const c = document.createElement('canvas'); c.width = N; c.height = N
  const ctx = c.getContext('2d')!
  ctx.putImageData(patternImageData(N, N, colA, colB, (px, py) =>
    (Math.floor(px * d / N) + Math.floor(py * d / N)) % 2 === 1), 0, 0)
  const t = new three.CanvasTexture(c)
  tunePattern(three, t)
  return t
}

function stripesTex(three: typeof THREE, a: string, b: string, angle: number, density: number): THREE.Texture {
  const N = 512, d = Math.max(2, Math.round(density))
  const colA = hexBytes(a), colB = hexBytes(b)
  const rad = (angle * Math.PI) / 180
  const dx = Math.cos(rad), dy = Math.sin(rad)
  const c = document.createElement('canvas'); c.width = N; c.height = N
  const ctx = c.getContext('2d')!
  ctx.putImageData(patternImageData(N, N, colA, colB, (px, py) => {
    const proj = px * dx + py * dy
    return Math.floor(proj / (N / d)) % 2 !== 0
  }), 0, 0)
  const t = new three.CanvasTexture(c)
  tunePattern(three, t)
  return t
}

function qrTex(three: typeof THREE, a: string, b: string, density: number): THREE.Texture {
  const N = 512, d = Math.max(2, Math.round(density))
  const colA = hexBytes(a), colB = hexBytes(b)
  const c = document.createElement('canvas'); c.width = N; c.height = N
  const ctx = c.getContext('2d')!
  ctx.putImageData(patternImageData(N, N, colA, colB, (px, py) => {
    const cx = Math.floor(px * d / N), cy = Math.floor(py * d / N)
    const v = Math.sin((cx * 12.9898 + cy * 78.233 + cx * cy * 3.71)) * 43758.5453
    return (v - Math.floor(v)) > 0.45
  }), 0, 0)
  const t = new three.CanvasTexture(c)
  tunePattern(three, t)
  return t
}
