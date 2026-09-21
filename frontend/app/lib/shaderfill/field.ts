/**
 * Turns a ShaderFill into pixels — the ONLY place in the product that does so.
 * Every surface (Space Type, Shape Studio, frames, Scene3D) goes through here, which
 * is what keeps bake and preview from drifting: same function, different resolution.
 *
 * Rendering is a readback bridge: the shared `shaderFx` WebGL2 singleton renders the
 * field, and we blit its canvas into a per-field 2D canvas. shaderFx's own canvas is
 * only valid until the next call, so the blit MUST happen before anything else renders.
 */
import { effectiveTilePaint, type ShaderSpec } from '~/lib/spacetype/fillTile'
import { paintTileBox } from '~/lib/compositor/paint'
import { shaderFx, expandPasses, type Uniforms, type ShaderPass } from '~/lib/shaderfx/renderer'
// Deliberately from catalogStore, NOT ~/lib/shaderfx/catalog: this module (via
// ~/lib/spacetype/fills.ts) is on the Space Type embed's render path, and
// catalog.ts is where `$fetch('/sailor/shader_effects')` lives. Importing it
// directly here would bundle that call into the embed regardless of whether it
// ever runs. See kickCatalogFetch's doc below for how the self-heal retry still
// works without this module ever importing the fetcher.
import { getEffectSync, refetchShaderFxCatalog } from '~/lib/shaderfx/catalogStore'
import type { EffectDef, EffectTextureDef, ParamValue } from '~/lib/shaderfx/types'
import { toUniforms } from '~/lib/shaderfx/params'
import { fieldKey, quantizeTime, planFields, resolveEffectParams, inputKey, LIVE_FIELD_CEILING } from './descriptor'

export interface FieldRequest {
  spec: ShaderSpec; w: number; h: number; t: number; fps: number
  /** Bake renders at the requested size; live playback is clamped to LIVE_FIELD_PX. */
  bake?: boolean
}

/** Cumulative counters for the cache, reset by `clearFieldCache`. `renders` is the
 *  number of times `shaderFx.render` actually ran — the number that proves (or
 *  disproves) batching, since a cache hit costs zero GPU work. `tileHits`/`tileMisses`
 *  are the SEPARATE input-tile cache (see `tileCache` below) — an animated field's
 *  OWN key changes every frame (so `hits`/`misses` above are dominated by misses for
 *  live fields by construction), but its `spec.input` is almost always unchanged
 *  frame to frame, so `tileHits` should be high even when `hits` is near zero. A low
 *  `tileHits` rate on an animated field is the signal that the input-tile cache isn't
 *  doing its job (e.g. a caller mutating `spec.input` needlessly every frame).
 *
 *  `tokenMismatches` (final review, Important 3) is UNCONDITIONAL — not gated on
 *  `import.meta.dev` like the `console.error` in `resolveField` is — so a production
 *  build, the bench hooks, and any test can assert it stays zero without needing dev
 *  mode. It only increments on a REAL HOST-ISOLATION violation (see `resolveField`'s
 *  doc): a call made with a genuine, still-open span's token while a DIFFERENT span
 *  is the one currently installed. A stale token presented with no span open at all
 *  (e.g. a hit-test calling `resolveField` outside any `withFieldFrame`, final review
 *  Important 2) is not a violation and must never move this counter — see the
 *  `_frameOpen` gate in `resolveField`. */
export interface FieldStats { renders: number; hits: number; misses: number; tileHits: number; tileMisses: number; tokenMismatches: number }

/**
 * Sized as a small multiple of LIVE_FIELD_CEILING rather than a bare number, so the
 * two stay related if the ceiling is ever retuned. This cache's durable beneficiaries
 * are FROZEN (`speed: 0`) fields and OVER-CEILING fields — the ones `resolveField`
 * pins to a stable `t=0` fallback key (see `planFields`/the `key` fallback below) —
 * because those are the only entries that survive more than one animation frame;
 * an animated, under-ceiling field gets a brand-new key every quantized time step and
 * misses the cache by construction. Up to LIVE_FIELD_CEILING live fields each insert
 * one such never-repeating entry per frame, competing for this cache's slots against
 * the durable ones, so sizing it as `LIVE_FIELD_CEILING × N` gives the durable
 * entries roughly N frames of live churn before an LRU eviction can reach them — not
 * a guarantee (see below), just headroom. `8` is not a measurement like
 * LIVE_FIELD_CEILING itself is; it is small enough that the memory bound below stays
 * modest and large enough to not evict everything on the very next frame.
 *
 * Memory: CACHE_MAX × 512² × 4 bytes (RGBA8, the live-clamp size — see LIVE_FIELD_PX)
 * ≈ 33 MB at the current 32, retained on this module-level singleton that every
 * studio surface will eventually share. That budget, not a round number, is the
 * actual ceiling on how large this should get without deliberately re-budgeting it.
 *
 * This is NOT a guarantee that a frozen/over-ceiling entry survives indefinitely:
 * the field-count=8 sweep in the Task 3 report showed this cache imperfectly
 * defending even that narrower job — 4 live fields churning through the 32 slots
 * evicted the 4 frozen fallback entries roughly every 8 iterations, forcing periodic
 * re-renders of work that is architecturally supposed to be free. That measurement
 * predates the recency refresh in `resolveField`: eviction was FIFO-by-insertion at
 * the time, so a frozen entry aged out on a fixed schedule no matter how often it was
 * read. It is now a true LRU, which should protect entries that are hit every frame —
 * re-measure before citing that 224-vs-200 figure again. Raising the
 * multiplier would help that specific case but is a real memory/eviction trade-off,
 * not a bug fix — left as-is per review (this cache is reviewed and works; changing
 * its behaviour needs its own measurement, the way LIVE_FIELD_CEILING got one).
 */
const CACHE_MAX = LIVE_FIELD_CEILING * 8
/** Live fields are capped so an on-canvas node cannot ask for a 4K readback per frame.
 *  Bakes opt out via `bake: true` — same function, same time, different resolution,
 *  which is what keeps preview and bake from drifting. */
const LIVE_FIELD_PX = 512

function fieldSize(req: FieldRequest): { w: number; h: number } {
  if (req.bake) return { w: req.w, h: req.h }
  const k = Math.min(1, LIVE_FIELD_PX / Math.max(req.w, req.h, 1))
  return { w: Math.max(1, Math.round(req.w * k)), h: Math.max(1, Math.round(req.h * k)) }
}

const cache = new Map<string, HTMLCanvasElement>()
let liveKeys = new Set<string>()
let stats: FieldStats = { renders: 0, hits: 0, misses: 0, tileHits: 0, tileMisses: 0, tokenMismatches: 0 }

/**
 * Cache of the RASTERISED INPUT TILE (`paintTileBox(effectiveTilePaint(spec.input), w,
 * h)`), keyed on the input paint + size — deliberately NOT on time, effect, params, or
 * anchor, unlike `cache` above. `spec.input` is time-invariant: an animated field's
 * `t` changes every frame but its input paint almost never does, yet without this it
 * was being fully re-rasterised on the CPU every single frame regardless. Built once
 * per distinct (input, size) pair and reused for the entire animation, across every
 * consumer sharing that input — the same batching principle `cache`/`fieldKey` apply
 * to the full render, just applied one layer down to the part that's actually
 * constant. 100% hit rate in practice (see the Task 3 report's sweep numbers) — cheap
 * and correct, kept even after the output-canvas pool (which measured zero benefit
 * and was removed, see `resolveField`'s doc) was taken back out.
 *
 * Sized the same as `cache` for the same reason (a small multiple of
 * LIVE_FIELD_CEILING, same memory-order-of-magnitude justification) — see CACHE_MAX
 * above for the full reasoning, which applies here unchanged.
 */
const tileCache = new Map<string, HTMLCanvasElement>()
const TILE_CACHE_MAX = CACHE_MAX

/** `inputKey(input)` always returns a well-formed JSON array string ending in `]`
 *  (see descriptor.ts) — no valid JSON array output can have trailing characters, so
 *  appending a fixed `#WxH` suffix after it can never collide with a differently
 *  shaped input producing the same composite string, without needing `encode()`'s
 *  full array-position disambiguation here too. */
function tileKey(input: ShaderSpec['input'], w: number, h: number): string {
  return `${inputKey(input)}#${w}x${h}`
}

function getInputTile(input: ShaderSpec['input'], w: number, h: number): HTMLCanvasElement {
  const key = tileKey(input, w, h)
  const hit = tileCache.get(key)
  if (hit) { stats.tileHits++; return hit }
  stats.tileMisses++
  // The shader's input image is the nested paint (string | Gradient | Fill),
  // rasterised on the CPU via paintTileBox. Depth-1 nesting is enforced only at the
  // normalizeFill/normalizePaint boundary, not in the type system — a
  // hand-constructed spec can still carry a shader fill as its input, so unwrap
  // defensively via effectiveTilePaint rather than reading `input` directly (see
  // fillTile.ts) — a shader-typed Fill reaching paintTileBox unrasterised would
  // otherwise risk re-entering the field renderer with a stale descriptor. NOTE:
  // `tileKey` above already keys on the SAME unwrap via `inputKey`, so key and
  // cached content agree by construction.
  const tile = paintTileBox(effectiveTilePaint(input), w, h)
  if (tileCache.size >= TILE_CACHE_MAX) {
    const oldest = tileCache.keys().next().value
    if (oldest) tileCache.delete(oldest)
  }
  tileCache.set(key, tile)
  return tile
}

/**
 * Self-heal for CRITICAL 1 of the final review: `getEffectSync` only ever returns
 * non-null once SOMETHING on the page has awaited `fetchShaderFxCatalog()` — and
 * the complete set of callers that do that is 4 studio Surface modals + the dev
 * bench (see catalog.ts). No node card and no Compositor render path calls it, so
 * a saved shader fill rendered by any OTHER host (a Frame card on reload, a
 * one-shot Shape/Scene3D bake, …) fell back to its input fill FOREVER — nothing
 * ever kicked the fetch, let alone retried it.
 *
 * Fix: every `resolve()` miss kicks a refetch itself, bounded by `CATALOG_RETRY_MAX`
 * attempts with backoff (see `kickCatalogFetch`). It does so via
 * `refetchShaderFxCatalog()` (~/lib/shaderfx/catalogStore), NOT by importing
 * catalog.ts's `fetchShaderFxCatalog` directly — this module sits on the Space
 * Type embed's render path (via ~/lib/spacetype/fills.ts), which must never bundle
 * `$fetch('/sailor/shader_effects')` (see catalogStore.ts's "Self-heal hook" doc
 * for the full reasoning). In practice this makes no difference to any real
 * Studio host: every one of them already imports catalog.ts elsewhere to kick the
 * INITIAL fetch, which registers it as the refetch target too. Only a context that
 * never imports catalog.ts at all (the embed adapters) sees `refetchShaderFxCatalog()`
 * return null — treated below exactly like a failed fetch attempt.
 *
 * Callers that already re-invoke `resolveField` every frame AND already have a
 * cache entry to retry against (Space Type/Shape Studio/Scene3D's rAF previews,
 * once a MISS also registers an entry — see shaderFieldTexture's/materialFor's own
 * docs) self-heal for free the very next successful frame once the catalog lands —
 * "no ordering dependency anywhere", per the review. A host with no per-frame loop
 * of its own (a one-shot bake) needs an explicit `await fetchShaderFxCatalog()`
 * before it ever builds (see the Space Type/Shape Studio bake call sites), or the
 * `onFieldCatalogReady` nudge below, for a host that renders once and stops
 * (e.g. ArtifactFrameNode's static renderStack).
 */
const CATALOG_RETRY_MAX = 6
const CATALOG_RETRY_BASE_MS = 500
const CATALOG_RETRY_MAX_MS = 20000

let _catalogRetry: Promise<void> | null = null
/**
 * True once `fetchShaderFxCatalog()` has resolved successfully at least once.
 * Gates `kickCatalogFetch` so a miss caused by "the effect genuinely isn't in an
 * ALREADY-loaded catalog" (a renamed effect in a saved project) doesn't keep
 * re-fetching the same cached, already-resolved promise forever — Important 4 of
 * the final review: before this flag existed, every such miss (one per live field
 * per host frame) called `fetchShaderFxCatalog()` again, which returned the SAME
 * resolved promise (catalog.ts memoizes it), attached a FRESH `.then`, and that
 * `.then` fired on the next microtask regardless — a request that never actually
 * re-fetched anything over the network, but did re-notify every
 * `onFieldCatalogReady` subscriber once per miss instead of once per load (one
 * extra full repaint of every Frame node per frame, forever). `retryFieldCatalog`
 * below is the only thing that clears this, for a caller that wants to force a
 * re-check (an explicit "retry" affordance, or an edit that repoints a fill at a
 * different effect id) after this module stops trying on its own.
 */
let _catalogLoaded = false
/** Consecutive failed fetch attempts since the last success (or since
 *  `retryFieldCatalog` last reset it) — bounds the retry storm from a backend
 *  that's genuinely down (Important 4: without a cap, a live host renders a miss
 *  every frame, and every miss used to kick a brand new `$fetch`). Capped at
 *  `CATALOG_RETRY_MAX`; once reached, `kickCatalogFetch` stops trying on its own
 *  until `retryFieldCatalog()` is called. */
let _catalogRetryCount = 0
const _catalogReadySubs = new Set<() => void>()

function kickCatalogFetch(): void {
  // Loaded at least once already: a further miss means the requested effect id
  // just isn't (or isn't yet) in THAT catalog, not that the fetch itself needs
  // retrying — re-fetching the same resolved promise can't fix that, and doing it
  // anyway is Important 4's request-storm/over-notify bug (see `_catalogLoaded`'s
  // doc). Stop here; `retryFieldCatalog()` is the explicit escape hatch.
  if (_catalogLoaded) return
  if (_catalogRetry) return                          // already in flight — dedupe
  if (_catalogRetryCount >= CATALOG_RETRY_MAX) return // gave up — see retryFieldCatalog
  const attempt = _catalogRetryCount++
  const delay = attempt === 0 ? 0 : Math.min(CATALOG_RETRY_MAX_MS, CATALOG_RETRY_BASE_MS * 2 ** (attempt - 1))
  _catalogRetry = new Promise<void>((resolve) => { setTimeout(resolve, delay) })
    .then(() => {
      // refetchShaderFxCatalog() (~/lib/shaderfx/catalogStore) delegates to
      // whatever registered itself via setShaderFxRefetcher — normally catalog.ts's
      // fetchShaderFxCatalog. It returns null when nothing has (a context that
      // never imported catalog.ts at all, i.e. the embed adapters) — turned into an
      // ordinary rejection here so the SAME backoff/give-up bookkeeping below
      // applies either way. resolveField/resolve() must never throw, that's the
      // whole point of this module's graceful fallback.
      const p = refetchShaderFxCatalog()
      if (!p) throw new Error('shaderfx: no catalog refetcher registered')
      return p
    })
    .then(() => {
      _catalogLoaded = true
      _catalogRetryCount = 0
      notifyFieldReady()
    })
    .catch(() => { /* still failing — the NEXT miss retries with backoff, up to CATALOG_RETRY_MAX */ })
    .finally(() => { _catalogRetry = null })
}

/** Explicit escape hatch out of `kickCatalogFetch`'s two stop conditions (already
 *  loaded once, or gave up after `CATALOG_RETRY_MAX` attempts) — call from a
 *  manual "retry" affordance, or when an edit repoints a fill at a possibly
 *  different effect id. Doesn't fetch anything itself; it just re-arms
 *  `kickCatalogFetch` so the NEXT `resolveField`/`beginFieldFrame`/`withFieldFrame`
 *  miss (there is always one soon, for any live field still on a fallback) fetches
 *  again. */
export function retryFieldCatalog(): void {
  _catalogLoaded = false
  _catalogRetryCount = 0
}

/** Subscribe to be notified once (per successful catalog load) after a `resolveField`
 *  miss kicked a retry that lands. For a host with no per-frame render loop of its own
 *  (a static canvas, a one-shot bake) — a host that DOES already re-render every frame
 *  (Space Type's preview rAF) doesn't need this, since its next `resolveField` call
 *  simply succeeds once the catalog is cached. Returns an unsubscribe function. */
export function onFieldCatalogReady(cb: () => void): () => void {
  _catalogReadySubs.add(cb)
  return () => { _catalogReadySubs.delete(cb) }
}

/** Fire the "something this module was waiting on has landed" signal — a successful
 *  catalog load, or a declared texture finishing its download (see `ensureTextureImage`).
 *  Copied before iterating so a subscriber that unsubscribes itself inside the callback
 *  (a host tearing down on the repaint it just asked for) can't mutate the live set. */
function notifyFieldReady(): void {
  for (const cb of [..._catalogReadySubs]) cb()
}

/**
 * An effect can declare TEXTURES in its manifest (`EffectDef.textures`) — today only
 * the ASCII effect's `glyph_atlas.png`, bound as `u_glyphs` and accompanied by the
 * numbers that describe its layout (`u_glyphCount`, `u_glyphRows`).
 *
 * `buildPasses` used to pass `undefined` for textures and never emitted the companion
 * numbers, so on EVERY path that goes through this module — a Frame layer effect, a
 * Space Type fill, a Shape Studio or Scene3D material — the ASCII shapes that sample
 * the atlas (Hash, Matrix, Binary, Braille, Morse, Dots, Slashes) sampled an unbound
 * sampler with a glyph count of 0 and drew nothing at all. Only Shader Studio and the
 * texturefx stylize path (~/lib/texturefx/stylize.ts `loadEffectTextures`, the
 * precedent this follows) ever loaded them.
 *
 * The Images live here, at module scope, for two reasons: one download per atlas for
 * the page, and — more importantly — ONE STABLE OBJECT per atlas. The renderer's
 * extra-texture cache is keyed on the source object's identity and bounded at 32
 * (see `extraTexCache` in ~/lib/shaderfx/renderer.ts), so handing it a fresh Image
 * per frame would re-upload the atlas every frame and evict everything else.
 */
const _texImages = new Map<string, HTMLImageElement>()
/** Fast path for `fieldEffectReady`, which is called every frame: the catalog hands
 *  back the SAME `EffectTextureDef` objects until a refetch replaces the catalog, so
 *  this skips rebuilding the `file + v` key string on the steady-state call. The Map
 *  above stays the canonical store, keyed so two effects declaring the same atlas
 *  share one Image (and therefore one GL texture). */
const _texByDef = new WeakMap<EffectTextureDef, HTMLImageElement>()

/** `/sailor/shader_effects/assets/<file>?v=<mtime>` — the same route and the same
 *  cache-busting version `assetUrl` in ~/lib/shaderfx/catalog builds, deliberately
 *  rebuilt here rather than imported: catalog.ts owns `$fetch('/sailor/shader_effects')`
 *  and registers the refetcher at module scope, and this module must not pull it into
 *  the Space Type embed bundle (see the catalogStore import note at the top of this
 *  file). Keep the two in step if that route ever moves. */
function textureAssetUrl(file: string, v?: string | number): string {
  const base = `/sailor/shader_effects/assets/${encodeURIComponent(file)}`
  return v != null ? `${base}?v=${encodeURIComponent(String(v))}` : base
}

/** The cached Image for one declared texture, starting its download the first time it
 *  is asked for and never again (a failed load stays failed — `complete` goes true with
 *  `naturalWidth` 0, so `textureLoaded` below keeps returning false rather than
 *  retrying forever). Returns null where there is no DOM `Image` at all (a unit test,
 *  an SSR pass): the caller then behaves exactly as this module did before textures
 *  existed, never throws. */
function ensureTextureImage(t: EffectTextureDef): HTMLImageElement | null {
  const fast = _texByDef.get(t)
  if (fast) return fast
  if (typeof Image === 'undefined') return null
  const key = `${t.file}@${t.v ?? ''}`
  let img = _texImages.get(key)
  if (!img) {
    img = new Image()
    img.crossOrigin = 'anonymous'
    // A host with no per-frame loop (a static Frame card, a one-shot bake) has nothing
    // that would notice the atlas arriving — same problem, and the same fix, as the
    // catalog landing late. See `onFieldCatalogReady`.
    img.addEventListener('load', () => { notifyFieldReady() })
    img.src = textureAssetUrl(t.file, t.v)
    _texImages.set(key, img)
  }
  _texByDef.set(t, img)
  return img
}

function textureLoaded(img: HTMLImageElement): boolean {
  return img.complete && img.naturalWidth > 0
}

/**
 * True when `effectId` can render EVERYTHING it declares: it is in the loaded catalog
 * AND every texture it declares has finished loading. An effect with no textures is
 * ready as soon as the catalog is.
 *
 * A `false` is not just a report — it KICKS whatever is missing (the bounded catalog
 * retry; one image download per missing texture, ever) and, when a texture lands,
 * notifies the `onFieldCatalogReady` subscribers, so a host with no frame loop
 * repaints. Callers that must not draw a half-built look (the Frame's dither
 * transition falls back to its Dissolve mask until this is true) poll it every frame,
 * which is why the ready path allocates nothing.
 */
export function fieldEffectReady(effectId: string): boolean {
  const effect = getEffectSync(effectId)
  if (!effect) { kickCatalogFetch(); return false }
  const defs = effect.textures
  if (!defs || defs.length === 0) return true
  let ready = true
  for (const t of defs) {
    const img = ensureTextureImage(t)
    // Keep going rather than returning early: every missing texture should have its
    // one download started by this call, not one per subsequent frame.
    if (!img || !textureLoaded(img)) ready = false
  }
  return ready
}

/** The LOADED subset of `effect`'s declared textures, plus the companion uniforms of
 *  exactly those textures — an atlas that hasn't arrived must not bring its
 *  `u_glyphCount` with it, or the shader picks a glyph index out of an unbound
 *  sampler. Returns `undefined` textures when nothing is loaded, which is the literal
 *  argument `buildPasses` passed before this existed: an effect whose textures are
 *  still loading renders exactly as it does today. */
function loadedEffectTextures(effect: EffectDef): { textures?: Record<string, TexImageSource>; uniforms?: Record<string, number> } {
  const defs = effect.textures
  if (!defs || defs.length === 0) return {}
  let textures: Record<string, TexImageSource> | undefined
  let uniforms: Record<string, number> | undefined
  for (const t of defs) {
    const img = ensureTextureImage(t)
    if (!img || !textureLoaded(img)) continue
    ;(textures ??= {})[t.uniform] = img
    if (t.extraUniforms) Object.assign(uniforms ??= {}, t.extraUniforms)
  }
  return { textures, uniforms }
}

/**
 * Resolve the effect def and a params-NORMALIZED copy of `spec` together, so every
 * caller below keys and renders off the same resolved params (see descriptor.ts's
 * `resolveEffectParams` doc). Falls back to the raw, un-normalized spec when the
 * effect isn't in the catalog yet (e.g. the page's `fetchShaderFxCatalog()` call
 * hasn't resolved) — that only costs a little batching hit rate for one frame, it
 * never produces wrong pixels, because `resolveField` still refuses to render
 * without an effect def either way.
 */
function resolve(spec: ShaderSpec): { effect: EffectDef | null; spec: ShaderSpec } {
  const effect = getEffectSync(spec.effectId)
  if (!effect) { kickCatalogFetch(); return { effect: null, spec } }
  return { effect, spec: { ...spec, params: resolveEffectParams(effect, spec.params) } }
}

/** Call once per host frame with every field the frame wants. Decides which stay live
 *  and which freeze, so the ceiling is applied per surface per frame.
 *
 *  LIVE_FIELD_CEILING exists to protect INTERACTIVE framerate (a 30fps preview budget
 *  has no room for arbitrarily many live readbacks). A bake has no frame budget — it
 *  is a one-shot export, not a loop competing for 33ms — so `req.bake` requests are
 *  exempt from the ceiling entirely: every bake-requested descriptor stays live,
 *  however many there are. Only non-bake requests are still subject to
 *  `planFields`/LIVE_FIELD_CEILING. Before this split, a single mixed or bake-only
 *  call still ran every descriptor (bake and live alike) through the SAME ceiling, so
 *  any export of a scene with more than LIVE_FIELD_CEILING distinct shader-fill
 *  descriptors silently froze the 5th-and-beyond fill at t=0 — independent of tab
 *  visibility, a real correctness bug rather than a harness artefact. Fixed here
 *  (rather than in each of the four call sites) so every surface inherits the fix.
 *
 *  HOST-ISOLATION INVARIANT (Important 6 of the final review — read this before adding
 *  a fifth host): this call and every `resolveField` call that consumes the `liveKeys`
 *  it sets MUST run as ONE synchronous span, with NO interleaving `await`. `liveKeys`
 *  is module-global, not scoped per host; if a host's `beginFieldFrame` → resolveField
 *  loop is broken up by an `await`, a DIFFERENT host's `beginFieldFrame` call can land
 *  in the gap, silently reassign `liveKeys` out from under the first host, and freeze
 *  its fields at t=0 — the same failure class `withShaderFillContext` in
 *  ~/lib/spacetype/fills.ts guards for the build-time context, just on the render-time
 *  context instead.
 *
 *  REGRESSION FIX (final review, Item 1): this used to THROW on re-entry. That crashed
 *  a live render path on entirely legitimate arrangements too — two strictly
 *  SEQUENTIAL, non-overlapping spans (e.g. the dev bench's several helper functions,
 *  none of which ever called `endFieldFrame()`) are not a violation, and the throw
 *  couldn't tell the difference. Worse, `_frameOpen` had NO `try/finally` at any real
 *  call site, so an unrelated exception mid-span (a broken canvas op, a WebGL hiccup)
 *  left it stuck true PROCESS-WIDE — every host's next `beginFieldFrame` then threw
 *  too, and since every rAF-driven preview re-arms itself AFTER the render call, every
 *  preview loop on the page died permanently (Vue error boundaries don't catch rAF
 *  callbacks — only a page reload recovered). Fixed by three changes:
 *   1. `withFieldFrame` below makes the span STRUCTURAL (a `try`/`finally`, exactly
 *      the shape `withShaderFillContext` already uses) instead of a begin/end PAIR a
 *      caller can forget to close — every real host and the bench are migrated to it.
 *      Prefer it for any new call site; `beginFieldFrame`/`endFieldFrame` stay exported
 *      for anything that genuinely needs manual control, but no longer throw.
 *   2. The real invariant (a second host's span landing inside this one, reassigning
 *      `liveKeys` out from under it) is now detected with a TOKEN: `beginFieldFrame`/
 *      `withFieldFrame` return one, and `resolveField(req, token)` compares it against
 *      whichever span most recently installed `liveKeys` — a mismatch means exactly
 *      the interleaving this system exists to catch, caught at the exact call that's
 *      now wrong, not by crashing an unrelated one.
 *   3. Neither path throws. A residual violation (which should not happen on any
 *      migrated host) is a `console.error` in dev only, plus AUTO-RECOVERY — the stale
 *      span is closed and the call proceeds with whatever the current state is. A
 *      silent wrong-pixels bug must never become a permanent freeze.
 *
 *  THE ACTUAL CURRENT RULE (final review, Important 2 — this replaced the old throw-based
 *  detection above, and nothing previously stated it directly): a `token` is only
 *  MEANINGFUL while `_frameOpen` is true for the span that produced it. `endFieldFrame`/
 *  `withFieldFrame`'s `finally` are not "guards that detect a violation" — they just close
 *  `_frameOpen`; detection happens entirely in `resolveField`, and only by comparing a
 *  caller's token against `_liveKeysToken` WHILE `_frameOpen` is true. A call made with a
 *  token from a span that has ALREADY closed (no span open at all when the call happens —
 *  e.g. a hit-test that re-runs `resolveShaderFill` outside any `withFieldFrame`, final
 *  review Important 2) is not a violation and must not be reported as one: with no span
 *  open, there is no "currently installed" owner to have been reassigned out from under
 *  anyone. `resolveField` below gates its comparison on `_frameOpen` for exactly this
 *  reason, and separately treats `token === 0` as the same "no span" sentinel as omitting
 *  the argument (real tokens from `_frameToken` start at 1) — a caller with no span open
 *  should reset its own remembered token to `0` rather than replaying a stale nonzero one. */
let _frameOpen = false
let _frameToken = 0
/** The token the CURRENTLY-installed `liveKeys` belongs to. `resolveField` compares a
 *  caller-supplied token against this to detect the HOST-ISOLATION violation above. */
let _liveKeysToken = 0

function openFieldFrame(requests: FieldRequest[]): { frozenCount: number; token: number } {
  if (_frameOpen && import.meta.dev) {
    console.error(
      '[shaderfill] beginFieldFrame/withFieldFrame: re-entered while a previous span was ' +
      'still open (no matching endFieldFrame()/withFieldFrame return happened first) — this ' +
      'does NOT close or recover anything: `_frameOpen` is simply re-set to the `true` value ' +
      'it already held, and this call proceeds regardless. Nothing gets stuck, though — each ' +
      'span (the first host\'s and this one\'s) still closes itself independently via its own ' +
      'withFieldFrame try/finally (or an explicit endFieldFrame()), so `_frameOpen` reliably ' +
      'ends up false again once both have run their course. What actually happened is real: ' +
      'two hosts\' beginFieldFrame/resolveField spans overlapped, `liveKeys`/`_liveKeysToken` ' +
      'now belong to THIS (second) span, and the FIRST host\'s own subsequent ' +
      'resolveField(req, token) calls will separately report a token mismatch, at the exact ' +
      'call site that is now stale — see this module\'s HOST-ISOLATION doc above beginFieldFrame.',
    )
  }
  _frameOpen = true
  _frameToken++
  const token = _frameToken
  const liveCandidates: string[] = []
  const bakeKeys: string[] = []
  for (const r of requests) {
    const { w, h } = fieldSize(r)
    const { spec } = resolve(r.spec)
    const key = fieldKey(spec, w, h, quantizeTime(r.t, r.fps))
    ;(r.bake ? bakeKeys : liveCandidates).push(key)
  }
  const { live, frozen } = planFields(liveCandidates)
  liveKeys = new Set([...live, ...bakeKeys])
  _liveKeysToken = token
  return { frozenCount: frozen.length, token }
}

function closeFieldFrame(): void {
  _frameOpen = false
}

/** Manual open/close pair — prefer `withFieldFrame` below for any new call site (it
 *  can't be left unpaired). Kept for callers that need to hold the span open across
 *  non-trivial control flow `withFieldFrame`'s single callback can't express cleanly.
 *  Never throws; see the HOST-ISOLATION doc above for what changed and why. */
export function beginFieldFrame(requests: FieldRequest[]): { frozenCount: number; token: number } {
  return openFieldFrame(requests)
}

/** Close the synchronous span `beginFieldFrame` opened — call once, immediately after
 *  the LAST `resolveField` call in this host's per-frame loop, in a `finally` so an
 *  exception in between still closes it (or better: use `withFieldFrame`, which does
 *  this for you). */
export function endFieldFrame(): void {
  closeFieldFrame()
}

/**
 * Structural replacement for the `beginFieldFrame`/…/`endFieldFrame` pairing above —
 * every real host (Space Type/Shape Studio's `refreshLiveShaderFills`, Scene3D's
 * `refreshSceneShaderFields`, the Compositor's `paintLayerStack`) and the dev bench are
 * migrated to this. Owns the pairing in a `try`/`finally`, mirroring
 * `withShaderFillContext` in ~/lib/spacetype/fills.ts: an exception thrown by `fn` (a
 * broken canvas op, a WebGL hiccup, anything) still closes the span, so `_frameOpen`
 * can never get stuck true — the regression this whole rewrite fixes (see the
 * HOST-ISOLATION doc above `beginFieldFrame`).
 *
 * `fn` receives the `frozenCount` and a `token` — pass that token into every
 * `resolveField(req, token)` call made inside `fn` (directly, or via a per-host context
 * object that carries it, e.g. the Compositor's `_fieldCtx.token`) so a call that runs
 * AFTER another host's span interleaved (the one case that indicates the invariant
 * actually broke) is detected AT THAT CALL, not by crashing the render path.
 */
export function withFieldFrame<T>(requests: FieldRequest[], fn: (frozenCount: number, token: number) => T): T {
  const { frozenCount, token } = openFieldFrame(requests)
  try {
    return fn(frozenCount, token)
  } finally {
    closeFieldFrame()
  }
}

/**
 * Resolve a `FieldRequest` to pixels — the ONLY function in the product that turns a
 * shader fill into a canvas. Returns `null` when the field can't be rendered (effect
 * not loaded yet, or a WebGL context loss); callers fall back to the input fill.
 *
 * OWNERSHIP CONTRACT — read this before consuming the return value, and read it again
 * before "optimizing" it (Tasks 4, 6, 7 all consume this; none should have to
 * re-derive it, and getting it wrong is how the ~4x regression in the Task 3 report's
 * later addenda happened):
 *
 *  - The returned `HTMLCanvasElement` is OWNED by this module's field cache. A
 *    consumer may bind it DIRECTLY as a texture source (e.g. `new
 *    THREE.CanvasTexture(out)`, or any other GPU upload that reads the canvas) —
 *    that is the intended, cheap usage.
 *  - It is NEVER mutated in place to hold a different descriptor's pixels. A cache
 *    entry, once created, keeps its own canvas for its own key for as long as that
 *    entry survives an LRU eviction; eviction removes the entry from `cache` and
 *    stops handing that canvas out for NEW requests, but does not touch the canvas
 *    itself. A consumer holding a reference from before an eviction keeps a
 *    perfectly valid, unchanged canvas — normal GC semantics, nothing this module
 *    does deliberately keeps it alive or recycles it out from under a holder.
 *  - It remains valid for as long as the consumer holds a reference. Re-resolving
 *    every frame (calling `resolveField` again with the same or updated `t`) is the
 *    intended usage, not an escape hatch — for an animated field that's a fresh
 *    canvas each frame by construction (see `cache`'s doc above); for a frozen or
 *    cache-hit field it's the SAME canvas object returned again, cheaply.
 *  - Consumers MUST NOT COPY it (`drawImage` into their own canvas, `getImageData`,
 *    etc.) as a matter of course. This was tried (an earlier revision had every
 *    consumer path implicitly copy through the bench's own display canvas) and
 *    measured as the dominant cost in a ~4x regression against the direct-`shaderFx`
 *    baseline — copying is exactly the overhead this module exists to let every
 *    surface avoid paying independently. Bind it directly.
 *  - A canvas POOL (recycling evicted output canvases for reuse) was tried and
 *    removed: it measured no benefit, AND it made direct binding actively unsafe — a
 *    consumer holding a reference across an eviction could have its texture start
 *    showing a DIFFERENT descriptor's pixels the moment the recycled canvas got
 *    reused, silently. Do not reintroduce pooling without re-solving that hazard;
 *    see the Task 3 report for the full history.
 *
 * `token`, when passed, is the token `beginFieldFrame`/`withFieldFrame` returned for
 * the span this call believes it's still inside. A mismatch against the CURRENTLY
 * installed `liveKeys`' token, WHILE a span is actually open (`_frameOpen`), means a
 * different host's span landed in between (the HOST-ISOLATION violation documented
 * above `beginFieldFrame`) — logged as a dev-only `console.error` at the exact call
 * site that's now stale, and counted in `fieldStats().tokenMismatches` unconditionally
 * (final review, Important 3), never thrown.
 *
 * Omit `token` (as every pre-migration/ad-hoc caller does, e.g. a single build-time
 * resolve outside any span) to skip the check entirely and just read whatever
 * `liveKeys` currently holds. `token === 0` is treated identically to omitting it —
 * `_frameToken` starts at 0 and its first real value is 1, so 0 is never a genuine
 * span's token; a caller that keeps its own token in a mutable field (the Compositor's
 * `_fieldCtx.token`, final review Important 2) should reset that field to `0` once its
 * own span closes, rather than leaving the last real token sitting there to be replayed
 * on every call made outside any span (a hit-test between frames, for example) — that
 * replay is not a violation (see the HOST-ISOLATION doc's "ACTUAL CURRENT RULE" above),
 * and warning about it every time blames an interleaving that never happened. The
 * `_frameOpen` gate below is the same protection from the other direction: with no span
 * open at all, there is no "currently installed" owner for a stale token to have been
 * reassigned out from under.
 */
/**
 * Shared by `resolveField` (below) and `renderFieldWithBase` (the external-backdrop
 * entry point for the glass-lens feature): given an already-resolved `effect`/`spec`
 * pair (see `resolve()` above — both callers already have one, for different reasons:
 * `resolveField` needs it for `fieldKey` before it even knows whether this is a cache
 * hit, `renderFieldWithBase` resolves it fresh since it has no cache to have already
 * done that for), reapplies the `u_` prefix to `spec.params` and runs them through the
 * SAME `toUniforms` expansion the studio uses, then expands that into ping-pong
 * `passes` via `expandPasses`. Kept as ONE function so the two render paths can never
 * drift on how a `ShaderSpec` becomes uniforms/passes — see `resolveField`'s inline
 * version of this before the Task 3 extraction for the duplicated shape this replaces.
 *
 * Pure: does not touch `tileCache`/`cache`/`stats`, and does not itself call
 * `shaderFx.render` — callers own their own caching (or, for `renderFieldWithBase`,
 * deliberately have none) and their own base texture.
 */
function buildPasses(effect: EffectDef, spec: ShaderSpec, t: number): ShaderPass[] {
  // u_hasShape is zeroed on EVERY field render, always. A shape-following effect
  // (glass_lens/crystal/liquid_metal) declares it, and the Frame's glass paint sets it
  // to 1 (with the layer silhouette in u_shape) via renderFieldWithBase's `shape` merge.
  // The renderer is a shared singleton whose per-program uniforms persist across draws,
  // so without this reset a later render of the SAME effect that passes no shape (a 3D
  // material, a Space Type fill) would inherit the last Compositor render's u_hasShape=1
  // and paint the previous layer's silhouette. getUniformLocation returns null for effects
  // that don't declare it, so this is inert everywhere else — the u_hasInput precedent.
  const uniforms: Uniforms = { u_time: t, u_seed: spec.seed, u_hasInput: 1, u_hasShape: 0 }
  const byUniform: Record<string, ParamValue> = {}
  for (const [k, v] of Object.entries(spec.params)) byUniform[`u_${k}`] = v
  Object.assign(uniforms, toUniforms(effect, byUniform))
  // The effect's own declared textures (an ASCII glyph atlas) and the numbers that
  // describe them — only the ones that have actually loaded. See `loadedEffectTextures`.
  const { textures, uniforms: texUniforms } = loadedEffectTextures(effect)
  if (texUniforms) Object.assign(uniforms, texUniforms)
  return expandPasses(effect.id, effect.source, uniforms, textures, effect.passes ?? 1)
}

/**
 * Renders `spec`'s shader field with an EXTERNALLY supplied `base` bound as `u_image0`
 * instead of `spec.input` — the entry point the glass-lens feature (a later task) uses
 * to feed a live snapshot of the compositor backdrop through a shader field, rather
 * than the field's own rasterised input Paint.
 *
 * Deliberately bypasses BOTH `field.ts` caches: `tileCache` (keyed on `spec.input`,
 * which is irrelevant here — `base` is the caller's own canvas, not derived from
 * `spec.input` at all) and the field-output `cache` (keyed on a `t`/anchor-aware
 * descriptor this call has no equivalent of, and whose whole point — reusing a render
 * across frames — doesn't hold when the caller passes a fresh live backdrop every
 * frame). Every call is a fresh `shaderFx.render`, same as a `cache` miss in
 * `resolveField` below.
 *
 * Renders at a fixed `t = 0` — this entry point's signature (spec, base, w, h) has no
 * time/fps input to quantize, unlike `FieldRequest`. A caller that needs the field to
 * animate over a live backdrop supplies that via `spec` itself (e.g. baking the phase
 * into `spec.params`); extending this signature with a time input is for whichever
 * later task's paint-loop caller actually needs it, not this one.
 *
 * Unlike `resolveField`, this does NOT swallow a missing-effect/context-loss failure
 * into a `null` return — the declared return type is a plain `HTMLCanvasElement`, and
 * the brief's own sketch of this function has no such fallback. A caller (the glass
 * paint-loop task) is expected to hold this precondition the same way every one-shot
 * bake call site already does elsewhere in this module: don't call this before the
 * shaderfx catalog has loaded (`await fetchShaderFxCatalog()` / `onFieldCatalogReady`).
 */
/**
 * What the Frame hands a shape-following lens (an effect whose manifest says
 * `followsShape`): the layer's silhouette as a soft height field bound as `u_shape`
 * (0 outside, 1 deep inside, 0.5 on the edge — blurred by the glass thickness), and
 * the uniforms that stand in for the effect's own centre and radius. Built by
 * `applyGlassFromLayer`; consumed only through `renderFieldWithBase`.
 */
export interface LensShape {
  texture: HTMLCanvasElement | OffscreenCanvas
  uniforms: Record<string, number>
}

/** True when `spec`'s effect can take a layer silhouette (manifest `followsShape`). */
export function effectFollowsShape(spec: ShaderSpec): boolean {
  return resolve(spec).effect?.followsShape === true
}

export function renderFieldWithBase(
  spec: ShaderSpec,
  base: HTMLCanvasElement | OffscreenCanvas,
  w: number,
  h: number,
  shape?: LensShape,
  t = 0,   // elapsed/scrub time (PRE-speed) → scaled by the fill's Speed below, then u_time;
           // the glass paint path must pass it or an animated shape-following fill (Chrome,
           // Nebula, Liquid metal…) renders frozen at t = 0.
  /** Merged into EVERY pass AFTER the effect's own uniforms (and after `shape`'s), so
   *  a caller can set a uniform the effect itself also writes. This is how a built-in
   *  MODE SWITCH that has no manifest param reaches the shader — `u_matte: 1` for the
   *  Frame dither transition's ASCII matte. Omitted, the passes are byte-for-byte what
   *  they were. A switch set here is reset to its default on every OTHER draw by the
   *  renderer, not by this call (BUILTIN_PASS_DEFAULTS in ~/lib/shaderfx/renderer.ts). */
  extraUniforms?: Record<string, number>,
): HTMLCanvasElement {
  const { effect, spec: resolvedSpec } = resolve(spec)
  if (!effect) {
    throw new Error(`renderFieldWithBase: effect "${spec.effectId}" is not in the loaded shaderfx catalog`)
  }
  // Fold the fill's own Speed (fill.shader.speed) into the clock, exactly as the
  // resolveField path does below. The glass/Frame paint path is the ONLY way a
  // shape-following fill renders, so without this its frozen Speed slider is dead
  // (u_time never scales by speed) and every such fill animates at one fixed rate.
  // speed 0 = frozen. This is also what lets the single Speed control drive the ~38
  // effects whose duplicate u_speed slider is now hidden (see derivedShaderFillControls).
  const sp = typeof resolvedSpec.speed === 'number' ? resolvedSpec.speed : 1
  let passes = buildPasses(effect, resolvedSpec, sp === 0 ? 0 : t * sp)
  if (shape) passes = passes.map(p => ({ ...p, uniforms: { ...p.uniforms, ...shape.uniforms } }))
  if (extraUniforms) passes = passes.map(p => ({ ...p, uniforms: { ...p.uniforms, ...extraUniforms } }))
  // render() RETURNS the canvas, valid only until the next render call — same
  // ownership contract as resolveField's `rendered` below.
  return shaderFx.render(passes, base, w, h, shape ? { u_shape: shape.texture } : undefined)
}

export function resolveField(req: FieldRequest, token?: number): HTMLCanvasElement | null {
  if (token !== undefined && token !== 0 && _frameOpen && token !== _liveKeysToken) {
    stats.tokenMismatches++
    if (import.meta.dev) {
      console.error(
        `[shaderfill] resolveField: called with token ${token}, but the currently-live span ` +
        `belongs to token ${_liveKeysToken} — this call landed after a DIFFERENT host's ` +
        'beginFieldFrame/withFieldFrame reassigned liveKeys out from under it (see the ' +
        'HOST-ISOLATION doc above beginFieldFrame). Falling back to the CURRENT liveKeys ' +
        'rather than crashing — this field may render frozen at t=0 for this call.',
      )
    }
  }
  const { w, h } = fieldSize(req)
  const { effect, spec } = resolve(req.spec)
  const tq = quantizeTime(req.t, req.fps)
  const liveKey = fieldKey(spec, w, h, tq)
  // Not live this frame -> fall back to the frozen (t=0) variant of the same descriptor.
  const key = liveKeys.size === 0 || liveKeys.has(liveKey) ? liveKey : fieldKey(spec, w, h, 0)
  const hit = cache.get(key)
  if (hit) {
    stats.hits++
    // Refresh recency so eviction is genuinely least-RECENTLY-used. Without this a
    // Map is FIFO-by-insertion, which evicts frozen/over-ceiling entries even though
    // they are read every single frame — precisely the entries this cache exists for.
    // Re-inserting moves the key to the end of the iteration order.
    cache.delete(key); cache.set(key, hit)
    return hit
  }
  stats.misses++

  if (!effect) return null                        // caller falls back to the input fill

  // The input tile is time-invariant (spec.input doesn't change as the field
  // animates) — cached separately from the full render, keyed on input+size only,
  // not on time/effect/params. See `getInputTile`/`tileCache` above.
  const base = getInputTile(spec.input, w, h)
  const t = spec.speed === 0 ? 0 : tq * spec.speed
  // spec.params is already the full resolved set (defaults + valid overrides, unknown
  // keys dropped) from `resolve()` above — `buildPasses` reapplies the `u_` prefix and
  // runs it through the SAME `toUniforms` expansion the studio uses, so a colour
  // becomes a vec3 and a gradient becomes its indexed arrays here exactly as it does
  // there. A hand-rolled copy of that expansion is how the two paths would drift.
  const passes = buildPasses(effect, spec, t)

  let rendered: HTMLCanvasElement
  try {
    // render() RETURNS the canvas, valid only until the next render call.
    stats.renders++
    rendered = shaderFx.render(passes, base, w, h)
  } catch {
    return null                                    // context loss -> input fill
  }
  // A fresh canvas per miss, NOT pooled/recycled — see the ownership contract above.
  // An evicted entry's canvas is simply dropped (left for GC); a consumer holding a
  // reference to it keeps a valid, unchanged canvas, which is what makes direct
  // texture binding safe.
  const out = document.createElement('canvas')
  out.width = w; out.height = h
  out.getContext('2d')!.drawImage(rendered, 0, 0)    // must precede the next shaderFx call

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value          // Map preserves insertion order
    if (oldest) cache.delete(oldest)
  }
  cache.set(key, out)
  return out
}

/** Resets the render caches and counters. Does NOT reset `_frameToken`/`_liveKeysToken`
 *  (final review, Important 3, doc correction) — those only need to keep producing
 *  fresh, mutually-distinct values across `beginFieldFrame`/`withFieldFrame` calls,
 *  which holds regardless of what number they start counting from; there is nothing
 *  "stale" about carrying them across a `clearFieldCache()` for a test/bench call to
 *  reset. `_frameOpen` IS reset (see the comment below), so the two are not a matched
 *  pair — don't read "resets frame state" as "resets every module-level `let` this file
 *  owns". */
export function clearFieldCache(): void {
  cache.clear()
  tileCache.clear()
  liveKeys = new Set()
  stats = { renders: 0, hits: 0, misses: 0, tileHits: 0, tileMisses: 0, tokenMismatches: 0 }
  // Test isolation: a test that throws/returns before its matching endFieldFrame()
  // (or simply doesn't model a full host loop) would otherwise leave a stuck
  // `_frameOpen = true` that pollutes the NEXT test's first beginFieldFrame/
  // withFieldFrame call with a spurious dev console.error for a reason that has
  // nothing to do with that test. (No longer a THROW since the Item 1 fix — but
  // still worth resetting cleanly.) Deliberately does NOT reset the catalog-retry
  // state (`_catalogLoaded`/`_catalogRetryCount`) — that tracks real fetch progress,
  // not per-test/per-measurement cache state, and callers like the bench's own
  // sweep call this between blocks without wanting to re-trigger a fetch storm.
  _frameOpen = false
}

/** Cumulative counts since the last `clearFieldCache()`. `renders`/`hits`/`misses`
 *  prove (in the bench's `__benchBatch()` hook, and in production debugging) that
 *  identical descriptors collapse to one render regardless of how many consumers ask
 *  for them. `tileHits`/`tileMisses` are the separate input-tile cache (see
 *  `getInputTile`) — the evidence that an animated field's time-invariant input is
 *  actually being reused across frames instead of re-rasterised on every one. */
export function fieldStats(): FieldStats { return { ...stats } }
