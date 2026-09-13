// Material factory for 3D Studio primitives. One module owns creation, in-place
// update, and disposal for every material type, so the engine stays lean and
// the Selection UI can share the same defaults (config.MATERIAL_DEFAULTS).
//
// Node-safety: matcap textures and picker thumbnails need a canvas; in non-DOM
// environments (vitest) those degrade to null/'' while the material classes and
// update logic stay fully testable.
import * as THREE from 'three'
// Every colour below comes from a StudioColor picker, which can emit 8-digit #rrggbbaa.
// THREE.Color has no alpha channel and renders 8-digit hex as WHITE (a console warning, no
// throw), so each one is stripped to 6 digits — an effect that doesn't implement transparency
// degrades to opaque rather than turning the object white.
import { stripAlpha } from '~/lib/color/convert'
import {
  MATERIAL_DEFAULTS, gradientAngles, gradientDirection, gradientStopsOf, rampStopsOf, opalStopsOf, screenOf,
  NO_BASE_COLOR,
  type GradientStop, type ReliefSpec, type SceneMaterial,
} from './config'
import { toHeightPixels } from './relief'
import { isResolvedTexture, textureMapFilename, ensureTextureFetched, type TextureManifest } from './textures'
import { applyImageTransform, imageWrapMode, seamlessWidth, seamlessCanvas, type NaturalSize } from './imageMap'
import {
  imageUniforms, writeImageUniforms, syncImageMapMatrix,
  IMAGE_FRAGMENT_PARS, IMAGE_PROJECT_VERTEX_GLSL, IMAGE_PROJECT_VERTEX_CALL,
  imageMapFragment, imageEmissiveMapFragment,
  type ImageUniforms,
} from './imageShader'
// The field module — the ONLY place a ShaderSpec becomes pixels (see its ownership contract).
// Scene3D is a second, independent consumer alongside Space Type/Shape Studio's
// ~/lib/spacetype/fills.ts: it never routes through `Fill`/`FILL_TYPES` (SceneMaterial has no
// such concept), just resolveField/beginFieldFrame directly, with its OWN per-engine ownership
// scoping below (shaderFillMaterials + refreshSceneShaderFields) — deliberately not reusing
// fills.ts's `_shaderFieldCache`/`withShaderFillContext`, so Scene3D's live-field ceiling and
// frozen count can never pool with, or be walked by, Space Type's or the Compositor's.
import { resolveField, withFieldFrame, type FieldRequest } from '~/lib/shaderfill/field'
import { DEFAULT_SHADER_SPEC, type ShaderSpec } from '~/lib/spacetype/fillTile'
import { paintTileBox } from '~/lib/compositor/paint'
import { applyFinish, updateFinishUniforms, finishKey } from './finishes'
import type { FinishTreatment } from './treatments'

const hasDOM = typeof document !== 'undefined'

// ── Matcaps: runtime-generated set (no bundled assets) ───────────────────────
export const MATCAP_IDS = ['chrome', 'clay', 'pearl', 'gold', 'carbon']

interface MatcapSpec { inner: string; mid: string; outer: string; highlight: number }
const MATCAP_SPECS: Record<string, MatcapSpec> = {
  chrome: { inner: '#f8fafc', mid: '#94a3b8', outer: '#1e293b', highlight: 0.9 },
  clay:   { inner: '#e7e2da', mid: '#b6aa99', outer: '#57503f', highlight: 0.25 },
  pearl:  { inner: '#fff7fb', mid: '#dcc8e8', outer: '#8e7a9d', highlight: 0.55 },
  gold:   { inner: '#fff3c4', mid: '#d9a441', outer: '#5c3a10', highlight: 0.8 },
  carbon: { inner: '#4b5563', mid: '#1f2937', outer: '#030712', highlight: 0.35 },
}

function drawMatcap(spec: MatcapSpec, size: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  // Sphere-shaded radial gradient, light from upper-left (matcap convention).
  const g = ctx.createRadialGradient(size * 0.38, size * 0.35, size * 0.05, size * 0.5, size * 0.5, size * 0.55)
  g.addColorStop(0, spec.inner)
  g.addColorStop(0.55, spec.mid)
  g.addColorStop(1, spec.outer)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  // Specular highlight dot.
  const h = ctx.createRadialGradient(size * 0.36, size * 0.32, 0, size * 0.36, size * 0.32, size * 0.16)
  h.addColorStop(0, `rgba(255,255,255,${spec.highlight})`)
  h.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = h
  ctx.fillRect(0, 0, size, size)
  return c
}

const matcapCache = new Map<string, THREE.Texture>()
/** Module-lifetime singleton textures — shared across materials, never disposed. */
function getMatcap(id: string): THREE.Texture | null {
  if (!hasDOM) return null
  const key = MATCAP_SPECS[id] ? id : MATCAP_IDS[0]!
  let t = matcapCache.get(key)
  if (!t) {
    t = new THREE.CanvasTexture(drawMatcap(MATCAP_SPECS[key]!, 256))
    t.colorSpace = THREE.SRGBColorSpace
    matcapCache.set(key, t)
  }
  return t
}

const thumbCache = new Map<string, string>()
export function matcapThumb(id: string): string {
  if (!hasDOM) return ''
  const key = MATCAP_SPECS[id] ? id : MATCAP_IDS[0]!
  let u = thumbCache.get(key)
  if (!u) { u = drawMatcap(MATCAP_SPECS[key]!, 64).toDataURL('image/png'); thumbCache.set(key, u) }
  return u
}

// ── Toon step ramp (per-material, disposed with it) ──────────────────────────
function toonRamp(steps: number): THREE.DataTexture {
  const n = Math.max(2, Math.min(5, Math.round(steps)))
  const data = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const v = Math.round((i / (n - 1)) * 255)
    data.set([v, v, v, 255], i * 4)
  }
  const t = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat)
  t.magFilter = t.minFilter = THREE.NearestFilter
  t.needsUpdate = true
  return t
}

// ── Image textures (cached per filename; failures broadcast to the UI) ───────
const imageCache = new Map<string, THREE.Texture>()
const errorSubs = new Set<(filename: string) => void>()
export function onTextureError(cb: (filename: string) => void): () => void {
  errorSubs.add(cb)
  return () => errorSubs.delete(cb)
}
/** Every live opalescent material, across every open Scene3D engine. Walked by `refreshOpalTime`
 *  once per host frame to write wall-clock seconds into each `uOpalTime` uniform — the only
 *  per-frame cost the opal material has, and only paid when the doc has a flowing opal (see
 *  `sceneHasOpalFlow`). Not owner-scoped like `shaderFillMaterials`: `uOpalTime` is just a shared
 *  monotonic clock, so a second open engine writing it is harmless. */
const opalMaterials = new Set<THREE.MeshStandardMaterial>()

// ── Shader-fill field textures (object anchor only) ──────────────────────────
// A live request is clamped to this square regardless of the mesh's actual screen size —
// matches resolveField's own LIVE_FIELD_PX ceiling (~/lib/shaderfill/field.ts), so live
// requests never get upscaled past what resolveField would hand back anyway.
const SHADER_FIELD_PX = 512
/** Placeholder ownerId for a `materialFor` call made with no engine in scope (unit tests,
 *  stray callers) — every field built under it shares one bucket, same fallback shape as
 *  fills.ts's UNOWNED. Real callers (SceneEngine) always pass their own stable `id`. */
const UNOWNED_SCENE3D = '__scene3d_unowned__'

/** Every live shaderFill material, across every open Scene3D engine — filtered by
 *  `userData.shaderOwnerId` in `refreshSceneShaderFields` so each engine's live-field ceiling
 *  and frozen count (via `beginFieldFrame`) apply per-engine, never pooled across engines and
 *  never touching Space Type/Shape Studio's separate cache in ~/lib/spacetype/fills.ts. Each
 *  entry also carries its current ShaderSpec in `userData.shaderSpec` (kept live by
 *  `updateMaterial`, read every frame by the refresh below) and owns exactly one
 *  THREE.CanvasTexture, reused for the material's whole lifetime — never reallocated per frame,
 *  per resolveField's ownership contract (its canvas is bound directly as `.image`, never
 *  copied). */
const shaderFillMaterials = new Set<THREE.Material>()

/** `/view` URL for an input-dir file. A slash-joined `filename` (`sailor_textures/Wood095/Color.jpg`)
 *  is split into ComfyUI's `subfolder` + basename — /view basenames `filename` itself, so the
 *  folder MUST travel in the separate query param. */
function inputViewUrl(filename: string): string {
  const i = filename.lastIndexOf('/')
  const q = new URLSearchParams({ filename: i >= 0 ? filename.slice(i + 1) : filename, type: 'input' })
  if (i >= 0) q.set('subfolder', filename.slice(0, i))
  return `/view?${q}`
}

/** `colorSpace` (I1 fix, final review): defaults to sRGB for the diffuse-map callers this was
 *  originally written for, but a REAL tangent-space normal map is non-colour data — sRGB-
 *  decoding it turns a flat texel (128,128,255) into ≈(0.216,0.216,1.0), which after `*2-1`
 *  reads as a steep tilt, so every "flat" region of every normal map read as tilted. Callers
 *  binding `.normalMap` (applyRelief below) pass `THREE.NoColorSpace`. The cache key folds in
 *  `colorSpace` for any non-default value so a diffuse `map` and a `.normalMap` that happen to
 *  share a filename never collide on one mis-decoded Texture instance. */
function getImageTexture(filename: string, colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace): THREE.Texture | null {
  if (!hasDOM || !filename) return null
  const key = colorSpace === THREE.SRGBColorSpace ? filename : `${colorSpace}:${filename}`
  let t = imageCache.get(key)
  if (!t) {
    const tex = new THREE.TextureLoader().load(
      inputViewUrl(filename),
      undefined,
      undefined,
      () => {
        // Only the SHARED cache's users reach here now — a user-supplied normal map, or a
        // relief source. The image material has owned its own Texture (and its own error
        // handler) since the image-options work, so there is no `.map` to drop from here.
        imageCache.delete(key)
        errorSubs.forEach((cb) => cb(filename))
      },
    )
    t = tex
    t.colorSpace = colorSpace
    imageCache.set(key, t)
  }
  return t
}

// ── Surface relief textures (height fields bound to .bumpMap) ────────────────
// C1/C2 redesign (final review of the surface-relief feature). The ORIGINAL design cached the
// CONVERTED canvas keyed by (filename, invert, contrast) and ran the client-side colour→height
// conversion a SECOND time before upload. Two bugs fell out of that:
//   C1 — `contrast` is a slider (StudioSlider fires on every `input` event), but it was folded
//        into the material's rebuild identity. Dragging 1→6 produced ~51 identity keys, each a
//        brand-new full-resolution canvas + fetch + decode + getImageData/putImageData, with
//        `heightCache` never evicted (~16MB/entry at 2048²) — and since a fresh THREE.Texture
//        wraps a BLANK canvas until its async `onload` fires, the relief visibly vanished for
//        the whole drag.
//   C2 — the client pre-converted before upload AND materials.ts converted again at build time.
//        Since toHeightPixels is idempotent on grayscale, "Brightness" and "Use as-is" produced
//        byte-identical output (Use-as-is did nothing), and a real Blender normal map uploaded
//        through the (default) Brightness path got luminance-flattened before it ever reached
//        storage — unrecoverable.
//
// The fix separates two lifetimes:
//  1. `reliefSourceCache` — the DECODED, UNCONVERTED source image (relief.image now stores the
//     user's ORIGINAL bytes — see Scene3DStudioSurface.vue's upload handlers), cached per
//     FILENAME ONLY. One fetch + one decode per filename, ever.
//  2. Each material's bumpMap is its OWN private canvas + Texture (tiling lives on THREE's
//     per-Texture `.repeat`, not on the Material, so sharing one Texture across materials — the
//     old design predating even C1/C2 — would make every object using that source tile
//     together the instant any one of them dragged the Tiling slider). It is painted from the
//     shared source above with its OWN invert/contrast. `contrast` repaints this same canvas IN
//     PLACE (`tex.userData.reliefSetContrast`, called from updateMaterial) — no rebuild, no
//     refetch, no new canvas, and `contrast` is deliberately EXCLUDED from `reliefKey` below.
//     `invert` still forces a rebuild (reliefKey), a deliberate, occasional toggle — but now
//     rebuilds cheaply, repainting from the ALREADY-cached source rather than re-fetching.
interface ReliefSourceEntry { canvas: HTMLCanvasElement; ready: boolean; subs: Set<() => void> }
const reliefSourceCache = new Map<string, ReliefSourceEntry>()

/** Long-edge cap for a relief SOURCE image (px). Bump is a low-frequency height
 *  field, so 2048 is already more detail than the derivative can show; the cap
 *  bounds the per-image memory cost (canvas + getImageData + height buffer + GPU
 *  texture) so a big photo used as a bump map can't spike memory into a context
 *  loss. Purely a downscale ceiling — smaller images are untouched. */
export const RELIEF_SOURCE_MAX = 2048

/** Fetch + decode an input-dir image exactly once per filename, however many materials
 *  reference it (C2 fix). `onReady` is queued if the decode hasn't completed yet; if it HAS
 *  (`entry.ready`), the caller is responsible for invoking its own paint immediately — this
 *  never calls back synchronously, so a caller can't assume it always will. */
function getReliefImageSource(filename: string, onReady: () => void): ReliefSourceEntry {
  let entry = reliefSourceCache.get(filename)
  if (entry) {
    if (!entry.ready) entry.subs.add(onReady)
    return entry
  }
  const canvas = document.createElement('canvas')
  entry = { canvas, ready: false, subs: new Set([onReady]) }
  reliefSourceCache.set(filename, entry)
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    // Cap the source to RELIEF_SOURCE_MAX on its long edge. A bump map is a
    // low-frequency height field — a full-resolution photo buys no visible relief
    // but costs a full-res canvas, a full-res getImageData + a second full-res
    // height buffer in toHeightPixels, and a large GPU texture. Left uncapped, a
    // multi-megapixel upload spikes memory hard enough to help lose the WebGL
    // context (the whole point of this hardening pass). Aspect is preserved so
    // tiling/UVs are unchanged; drawImage does the downscale in one step.
    const long = Math.max(img.naturalWidth, img.naturalHeight)
    const s = long > RELIEF_SOURCE_MAX ? RELIEF_SOURCE_MAX / long : 1
    canvas.width = Math.max(1, Math.round(img.naturalWidth * s))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * s))
    const ctx = canvas.getContext('2d')
    if (ctx) ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    entry!.ready = true
    const subs = entry!.subs
    entry!.subs = new Set()
    for (const cb of subs) cb()
  }
  img.src = inputViewUrl(filename)
  return entry
}

/** Minor 2 fix (final review): the canvas → getImageData → toHeightPixels → putImageData
 *  sequence used to exist in FOUR near-identical copies (here, buildHeightTextureFromSpec, and
 *  two in Scene3DStudioSurface.vue's upload handlers — the latter two are gone entirely now
 *  that conversion happens exactly once, at build time, here). This is the one shared core:
 *  draws `source` onto `dest` at (w, h) then converts its pixels to a height field in place. */
function paintHeightCanvas(dest: HTMLCanvasElement, source: CanvasImageSource, w: number, h: number, invert: boolean, contrast: number): void {
  dest.width = w
  dest.height = h
  const ctx = dest.getContext('2d')
  if (!ctx) return
  ctx.drawImage(source, 0, 0, w, h)
  const data = ctx.getImageData(0, 0, w, h)
  data.data.set(toHeightPixels(data.data, invert, contrast))
  ctx.putImageData(data, 0, 0)
}

/** Build a FRESH per-material Texture for an IMAGE relief source, wrapping a canvas this
 *  material exclusively owns, painted from the shared per-filename source (see
 *  `reliefSourceCache` above). `invert` is fixed for this texture's whole lifetime (a change
 *  rebuilds via `reliefKey`); `contrast` is NOT — `tex.userData.reliefSetContrast` lets
 *  `updateMaterial` repaint this same canvas in place on a contrast edit, reading the SAME
 *  cached source, never refetching.
 *  Returns null outside a browser — the unit suite runs in node, where the
 *  factory must still set bumpScale and simply bind no texture. */
function getHeightTexture(filename: string, invert: boolean, contrast: number): THREE.Texture | null {
  if (!hasDOM || !filename) return null
  const canvas = document.createElement('canvas')
  const tex = new THREE.Texture(canvas)
  let liveContrast = contrast
  const repaint = () => {
    const src = reliefSourceCache.get(filename)
    if (!src || !src.ready) return
    paintHeightCanvas(canvas, src.canvas, src.canvas.width, src.canvas.height, invert, liveContrast)
    tex.needsUpdate = true
  }
  tex.userData.reliefSetContrast = (c: number) => { liveContrast = c; repaint() }
  const entry = getReliefImageSource(filename, repaint)
  if (entry.ready) repaint()
  // A material disposed before its source image finishes loading would otherwise leave this
  // `repaint` closure (and the Texture/canvas it references) stuck in `entry.subs` forever —
  // unregister it on dispose (see disposeMaterial).
  else tex.userData.reliefUnsub = () => entry.subs.delete(repaint)
  return tex
}

/** RepeatWrapping is required — the default ClampToEdgeWrapping would smear the edge pixels
 *  across the whole surface instead of tiling the pattern. No-op on a null texture (a
 *  still-loading image, or a shader relief that hasn't resolved yet). */
function applyReliefTiling(tex: THREE.Texture | null, tiling: number): void {
  if (!tex) return
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(tiling, tiling)
}

/** Relief from a shader field: resolve the field, then run the SAME luminance
 *  transform as the image path. No per-effect height mode — every catalog effect
 *  gains relief with zero shader work. Not cached across materials: the spec can differ per
 *  material, and `reliefKey` already rebuilds when it (or `invert`) changes.
 *
 *  v1 relief is STATIC by decision: the field is resolved at t: 0 and the resulting
 *  CanvasTexture is never re-pointed on a healthy per-frame cadence — an animating
 *  effect used as relief renders frozen relief under an animating colour map, and
 *  that is accepted v1 behaviour, not a bug. The ONE exception (Task 5 fix) is a
 *  construction-time MISS (the shader-fx catalog hadn't resolved yet, so `resolveField`
 *  returned null and `bumpMap` was left permanently null): `refreshSceneShaderFields`
 *  now retries that specific material, ONCE, via `healReliefMaterials`/
 *  `reliefHealPending` below — a null→bound recovery, not a per-frame re-resolve. A
 *  material is removed from `reliefHealPending` the instant it heals, so it costs
 *  nothing on any later frame and is never re-pointed again after that.
 *
 *  `buildHeightTextureFromSpec` below is the shared core behind both the construction-time
 *  attempt (`getShaderHeightTexture`) and the later heal (`healReliefMaterials`), so a
 *  catalog miss now vs. a catalog hit later run the EXACT same pixels-to-height path. It
 *  calls `resolveField` directly — no `beginFieldFrame`/`withFieldFrame` span, no token —
 *  matching how this call has always been made here: relief is a one-shot resolve, never
 *  part of a live per-frame field batch, so it must never compete with an animating
 *  shaderFill for `LIVE_FIELD_CEILING` slots.
 *
 *  C1 fix: like the image path above, the RAW resolved field canvas (`src`) is kept alive in
 *  this texture's closure so a later contrast edit (`tex.userData.reliefSetContrast`) can
 *  repaint the owned canvas from it WITHOUT calling `resolveField` again — a GL readback is far
 *  more expensive than a canvas repaint, and re-resolving on every contrast tick would reproduce
 *  C1's per-tick cost under a different name. */
function buildHeightTextureFromSpec(spec: ShaderSpec, invert: boolean, contrast: number): THREE.Texture | null {
  if (typeof document === 'undefined') return null
  const src = resolveField({ spec, w: 512, h: 512, t: 0, fps: 30 })
  if (!src) return null

  const canvas = document.createElement('canvas')
  const tex = new THREE.CanvasTexture(canvas)
  let liveContrast = contrast
  const repaint = () => {
    paintHeightCanvas(canvas, src, src.width, src.height, invert, liveContrast)
    tex.needsUpdate = true
  }
  repaint()
  tex.userData.reliefSetContrast = (c: number) => { liveContrast = c; repaint() }
  return tex
}

function getShaderHeightTexture(mat: SceneMaterial, r: ReliefSpec): THREE.Texture | null {
  const spec = r.spec ?? mat.shader
  if (!spec) return null
  return buildHeightTextureFromSpec(spec, r.invert === true, r.contrast ?? MATERIAL_DEFAULTS.reliefContrast)
}

/** Materials whose shader-relief `bumpMap` is still null because `resolveField` missed at
 *  construction time (the shader-fx catalog hadn't resolved yet) — filtered by
 *  `userData.reliefOwnerId` in `refreshSceneShaderFields`, the same per-engine ownerId
 *  scoping `shaderFillMaterials` uses. This is a ONE-TIME heal, unlike that Set's `.map`
 *  heal: a material is REMOVED from here the instant its `bumpMap` binds, so a later
 *  `refreshSceneShaderFields` call never touches it again — relief stays static (see
 *  `buildHeightTextureFromSpec`'s doc): this only recovers a null→bound miss, it never
 *  re-resolves an already-bound one. */
const reliefHealPending = new Set<THREE.Material>()

/** Attempt the one-time relief heal for every material `ownerId` still has pending. A
 *  no-op the moment the Set is empty (the steady-state case once every relief has healed
 *  or no scene ever used a shader relief), so this costs nothing on an ordinary frame.
 *
 *  I2 fix (final review): tiling/contrast are read from the LIVE `SceneMaterial`
 *  (`m.userData.reliefMat`, stamped by `applyRelief` at construction), never from a
 *  construction-time snapshot. Cold load with a slow catalog → user picks Effect (miss,
 *  `bumpMap` null, queued here) → user drags Tiling/Contrast (updateMaterial's in-place block
 *  is a no-op while `bumpMap` is null) → catalog resolves → this heal used to bind with the
 *  STALE construction-time values, silently discarding the drag. Reading the live material
 *  fixes that for free — `invert` doesn't need the same treatment because changing it forces a
 *  rebuild (a brand-new material with the CURRENT invert baked in at construction; see
 *  `reliefKey`), so a still-pending heal entry's snapshotted `reliefInvert` can never go stale. */
function healReliefMaterials(ownerId: string): void {
  if (reliefHealPending.size === 0) return
  for (const m of reliefHealPending) {
    if (m.userData.reliefOwnerId !== ownerId) continue
    const spec = m.userData.reliefSpec as ShaderSpec | undefined
    if (!spec) { reliefHealPending.delete(m); continue }
    const invert = m.userData.reliefInvert === true
    const liveRelief = (m.userData.reliefMat as SceneMaterial | undefined)?.relief
    const contrast = liveRelief?.contrast ?? MATERIAL_DEFAULTS.reliefContrast
    const tiling = liveRelief?.tiling ?? MATERIAL_DEFAULTS.reliefTiling
    const tex = buildHeightTextureFromSpec(spec, invert, contrast)
    if (!tex) continue // still missing (catalog not resolved yet) — retry on a later call
    applyReliefTiling(tex, tiling)
    ;(m as THREE.MeshStandardMaterial).bumpMap = tex
    m.userData.reliefContrastApplied = contrast
    m.needsUpdate = true
    reliefHealPending.delete(m)
  }
}

/** Bind relief onto an already-constructed material. Applied AFTER per-type construction
 *  so it composes with every material type instead of being special-cased per branch.
 *
 *  MeshBasicMaterial (the `unlit` shaderFill class) has neither a bumpMap nor a normalMap
 *  slot — there is no lighting to perturb — so relief is skipped entirely rather than
 *  writing a property THREE will ignore. The UI disables the section to match. */
export function applyRelief(m: THREE.Material, mat: SceneMaterial, ownerId: string = UNOWNED_SCENE3D): void {
  const target = m as THREE.MeshStandardMaterial
  if (!('bumpMap' in target)) return

  const r = mat.relief
  reliefHealPending.delete(target) // always a fresh material instance here — defensive only
  if (r && r.source !== 'none') {
    const contrast = r.contrast ?? MATERIAL_DEFAULTS.reliefContrast
    const tex = r.source === 'image'
      ? (r.image ? getHeightTexture(r.image, r.invert === true, contrast) : null)
      : getShaderHeightTexture(mat, r)
    const tiling = r.tiling ?? MATERIAL_DEFAULTS.reliefTiling
    applyReliefTiling(tex, tiling)
    target.bumpMap = tex
    target.bumpScale = r.scale ?? MATERIAL_DEFAULTS.reliefScale
    // C1 fix: the contrast this texture was JUST painted at, so updateMaterial's in-place
    // block only repaints (getHeightTexture/buildHeightTextureFromSpec's `reliefSetContrast`)
    // when contrast has actually moved since — not on every unrelated property edit.
    target.userData.reliefContrastApplied = contrast
    // Item Task-5 heal: a shader relief that missed (catalog not loaded yet) gets queued
    // for `refreshSceneShaderFields` to retry — see `healReliefMaterials`'s doc. `mat.shader`
    // is the SAME fallback `getShaderHeightTexture` just used, so the heal resolves the exact
    // spec construction attempted, not a stale/different one. `reliefMat` (I2 fix) is a LIVE
    // reference to the SceneMaterial itself — the heal reads tiling/contrast off it directly
    // rather than a construction-time snapshot, so a slider drag that lands while `bumpMap` is
    // still null isn't silently lost (see healReliefMaterials's doc).
    if (!tex && r.source === 'shader') {
      const spec = r.spec ?? mat.shader
      if (spec) {
        target.userData.reliefSpec = spec
        target.userData.reliefInvert = r.invert === true
        target.userData.reliefMat = mat
        target.userData.reliefOwnerId = ownerId
        reliefHealPending.add(target)
      }
    }
  } else {
    target.bumpMap = null
  }

  // I1 fix: NoColorSpace — a normal map is non-colour data, not an sRGB-encoded photo (see
  // getImageTexture's doc).
  target.normalMap = mat.normalImage ? getImageTexture(mat.normalImage, THREE.NoColorSpace) : null
  target.needsUpdate = true
}

// ── ambientCG texture sets ────────────────────────────────────────────────────
// Only the three PBR-substrate types carry a real albedo/roughness/normal stack; the stylised
// types (toon/matcap/gradient/...) either have no such slots or would fight the look.
const TEXTURE_TYPES = new Set(['standard', 'glass', 'opalescent'])

function textureApplies(m: THREE.Material, mat: SceneMaterial): boolean {
  return TEXTURE_TYPES.has(mat.type) && 'map' in m && isResolvedTexture(mat.texture)
}

function setRepeat(tex: THREE.Texture | null, tiling: number): void {
  if (!tex) return
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(tiling, tiling)
}

/** Synchronous inner bind: given a manifest, point each slot at the cached texture.
 *  Stamps `userData.textureMaps` with what was bound so tests (node, no DOM → textures
 *  are null) and the heal path can see the decision, not just the slots. Exported under a
 *  test name only. */
export function __bindTextureMapsForTest(m: THREE.Material, mat: SceneMaterial, manifest: TextureManifest): void {
  bindTextureMaps(m, mat, manifest)
}

function bindTextureMaps(m: THREE.Material, mat: SceneMaterial, manifest: TextureManifest): void {
  if (!textureApplies(m, mat)) return
  const id = mat.texture!
  const t = m as THREE.MeshPhysicalMaterial
  // Live tiling, same reasoning as the relief heal's I2 fix above: `updateMaterial`'s in-place
  // block may have advanced `userData.textureTiling` while the manifest was in flight, so the
  // stamp — not the construction-time `SceneMaterial` — is the truth. Falling back to `mat`
  // keeps the direct (test/first-bind) call working before anything is stamped.
  const tiling = (m.userData.textureTiling as number | undefined) ?? mat.textureTiling ?? MATERIAL_DEFAULTS.textureTiling
  const has = (k: TextureManifest['maps'][number]) => manifest.maps.includes(k)
  const bound = new Set<TextureManifest['maps'][number]>()

  // One Texture PER MATERIAL, not the shared getImageTexture cache: `repeat` lives on the
  // Texture, so two objects tiling the same set differently need their own instances, and
  // in-place tiling (updateMaterial) must not reach into another object's maps. Cloning the
  // cached texture is wrong — Texture.clone() copies `image` at clone time, so a clone taken
  // before the async load finishes stays empty forever. The browser HTTP cache dedupes the
  // bytes; the decode is repeated per material, which is cheap at 1K.
  // The COST, stated honestly: a 1K RGBA map with mips is ~5 MB of VRAM, and a fully-mapped
  // set is six of them, so ~30 MB per textured material. A dozen objects on one set is
  // roughly 380 MB — and the visible failure is not a slow frame but WebGL context loss
  // (the whole canvas goes blank; see scene3d-webgl-context-loss-recovery).
  // The remedy when that ceiling is actually hit: a texture cache keyed by (set, map,
  // tiling) instead of per material. That key keeps the `repeat` correctness above — two
  // objects at different tilings still get different Textures — and turns in-place retile
  // from a mutation into a rebind, so it is a swap of this function's body, not a redesign.
  const tex = (k: TextureManifest['maps'][number], cs: THREE.ColorSpace) => {
    if (!hasDOM) return null
    const own = new THREE.TextureLoader().load(inputViewUrl(textureMapFilename(id, k)), undefined, undefined, () => {
      // Load failure: drop just this slot so the material degrades to the plain surface. Free
      // the dead Texture and un-stamp its key — `textureMaps` is what disposeMaterial and the
      // retile loop trust, so a key left behind claims a live map that is not there.
      for (const slot of ['map', 'roughnessMap', 'metalnessMap', 'normalMap', 'aoMap', 'bumpMap'] as const) {
        if ((t as any)[slot] === own) { (t as any)[slot] = null; t.needsUpdate = true }
      }
      own.dispose()
      const stamped = t.userData.textureMaps as string[] | undefined
      if (stamped) t.userData.textureMaps = stamped.filter((sk) => sk !== k)
    })
    own.colorSpace = cs
    setRepeat(own, tiling)
    return own
  }

  if (has('color')) { t.map = tex('color', THREE.SRGBColorSpace); bound.add('color') }
  if (has('roughness')) { t.roughnessMap = tex('roughness', THREE.NoColorSpace); bound.add('roughness') }
  if (has('metalness')) { t.metalnessMap = tex('metalness', THREE.NoColorSpace); bound.add('metalness') }
  if (has('normal') && !mat.normalImage) { t.normalMap = tex('normal', THREE.NoColorSpace); bound.add('normal') }
  if (has('ao')) {
    t.aoMap = tex('ao', THREE.NoColorSpace)
    // Pin the ao lookup to the primary UVs as a stated contract. three 0.171's Texture.channel
    // already defaults to 0; the explicit write is what keeps a future default change (or an
    // upstream uv1 default, as older docs describe) from silently moving the occlusion.
    if (t.aoMap) t.aoMap.channel = 0
    t.userData.textureAoChannel = 0
    bound.add('ao')
  }
  // Displacement → bump ONLY when the user has no relief of their own. An explicit relief
  // always wins (applyRelief already set bumpMap; leave it).
  const reliefOff = !mat.relief || mat.relief.source === 'none'
  if (has('displacement') && reliefOff) {
    t.bumpMap = tex('displacement', THREE.NoColorSpace)
    t.bumpScale = MATERIAL_DEFAULTS.reliefScale
    bound.add('displacement')
  }
  t.userData.textureId = id
  // Reported in the SET's own map order, not bind order: the stamp reads as "which of this
  // set's maps are live", and updateMaterial's retile loop is order-agnostic.
  t.userData.textureMaps = manifest.maps.filter((k) => bound.has(k))
  t.userData.textureTiling = tiling
  t.needsUpdate = true
}

/** Bind an ambientCG texture set onto an already-constructed material. Async: the manifest
 *  comes from the fetch route (cached per id per session); until it lands the material
 *  renders untextured, then the maps bind and `needsUpdate` fires — same shape as the
 *  relief heal. Applied AFTER applyRelief so an explicit relief's bump survives. */
export function applyTextureSet(m: THREE.Material, mat: SceneMaterial, finishes?: FinishTreatment[]): void {
  if (m.userData.disposed) return // nothing left to bind onto — see the .then guard below
  if (!textureApplies(m, mat)) return
  // Stamped BEFORE the DOM guard: updateMaterial's in-place tiling block keys off
  // `userData.textureId`, and it must retile a material whose maps are still in flight (or,
  // under node, never bind at all) rather than silently dropping the new tiling.
  m.userData.textureId = mat.texture
  m.userData.textureTiling = mat.textureTiling ?? MATERIAL_DEFAULTS.textureTiling
  if (!hasDOM) return // node/unit tests: no TextureLoader, nothing to bind
  const id = mat.texture!
  ensureTextureFetched(id).then((manifest) => {
    // A disposed material still awaiting its texture set must not be re-populated — same
    // hazard as `reliefHealPending`, and checked BEFORE the identity guard because disposal
    // leaves `identity` intact (a delete-during-fetch, or an A→B→A flip inside the fetch
    // window, passes that guard) and these six textures could never be freed again.
    if (m.userData.disposed) return
    // The material may have been rebuilt while we waited; only bind if it still wants this
    // exact set. `finishes` must match what `materialFor` stamped `m.userData.identity` with
    // (S5) — omitting it here would make this guard mismatch forever on any material that
    // also carries a finish, since `m.userData.identity` would carry a `|fin:` suffix this
    // recomputed key never would.
    if (m.userData.identity !== identityKey(mat, finishes)) return
    bindTextureMaps(m, mat, manifest)
    // Swallowed deliberately, and NOT because something else reports it: the picker row only
    // shows an error for a fetch the picker itself started. On document load, or when an
    // agent sets `texture`, nothing surfaces — the material just stays untextured, which is
    // the spec's stated behaviour for this path (error table: "silent, keeps the plain
    // surface"). Anything louder here would fire on every reopened document while
    // ambientcg.com is down.
  }).catch(() => {})
}

// ── Fresnel / gradient: LIT materials (Spline-style layers over lighting) ────
// Both are MeshStandardMaterials with onBeforeCompile injections, so the full
// standard pipeline (sun, env, shadows, tone mapping) applies. An unlit
// ShaderMaterial flattens the surface — that was the original gradient bug.

// Fresnel: base colour is the lit albedo; the rim is added as emissive glow so
// it reads over any lighting (like Spline's Fresnel layer).
const FRESNEL_FRAG_DECL = /* glsl */ `#include <common>
uniform vec3 uRim; uniform float uPower;`
const FRESNEL_FRAG_BODY = /* glsl */ `#include <emissivemap_fragment>
{
  float rim = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), uPower);
  totalEmissiveRadiance += uRim * rim;
}`

// Gradient: object-space colour ramp driving the albedo. Two program variants:
//  - smooth: one ramp across the whole object (per-pixel, object bbox range).
//  - facet:  runs on the engine's flat-shaded geometry variant, which carries
//    per-face extent attributes (aFaceMin/aFaceMax). uMode picks between
//    faceted (1: one flat tone per facet, sampled at the provoking vertex) and
//    prismatic (2: the FULL ramp swept across each facet individually — the
//    ShapeStudio cut-gem look). `flat` varyings ride through three's GLSL3
//    prefix (`varying` → in/out) verbatim.
const GRADIENT_SMOOTH_VERT_DECL = /* glsl */ `#include <common>
varying vec3 vGradPos;`
const GRADIENT_SMOOTH_VERT_BODY = /* glsl */ `#include <begin_vertex>
vGradPos = position;`
// Shared ramp maths. `t` is normalised over the bounding box *projected onto the
// ramp direction*: r = dot(|dir|, halfExtent) is the box's half-width along dir,
// so t = (dot(p - centre, dir) + r) / 2r spans exactly 0..1 across the shape.
// For a unit axis this is algebraically identical to the old per-axis
// (p - lo) / (hi - lo) — numerator and denominator both, guard included — so the
// x/y/z presets reproduce the previous look bit for bit.
const GRADIENT_RAMP_FN = /* glsl */ `
float gradT(vec3 p, vec3 bmin, vec3 bmax) {
  vec3 centre = (bmin + bmax) * 0.5;
  vec3 halfExt = (bmax - bmin) * 0.5;
  float t;
  if (uType == 1) {
    t = length(p - centre) / max(length(halfExt), 1e-5);
  } else {
    float r = dot(abs(uDir), halfExt);
    t = (dot(p - centre, uDir) + r) / max(2.0 * r, 1e-5);
  }
  return clamp(t, 0.0, 1.0);
}
vec3 gradSample(float t) {
  return texture2D(uRamp, vec2(clamp((t - 0.5) / uSpread + 0.5 - uOffset, 0.0, 1.0), 0.5)).rgb;
}`

const GRADIENT_UNIFORM_DECL = /* glsl */ `
uniform sampler2D uRamp;
uniform vec3 uBoxMin; uniform vec3 uBoxMax;
uniform vec3 uDir; uniform int uType;
uniform float uOffset; uniform float uSpread;`

const GRADIENT_SMOOTH_FRAG_DECL = /* glsl */ `#include <common>
${GRADIENT_UNIFORM_DECL}
varying vec3 vGradPos;
${GRADIENT_RAMP_FN}`
const GRADIENT_SMOOTH_FRAG_BODY = /* glsl */ `#include <color_fragment>
{
  diffuseColor.rgb = gradSample(gradT(vGradPos, uBoxMin, uBoxMax));
}`

const GRADIENT_FACET_VERT_DECL = /* glsl */ `#include <common>
attribute vec3 aFaceMin;
attribute vec3 aFaceMax;
attribute float aFaceRand;
varying vec3 vGradPos;
flat varying vec3 vGradFlat;
flat varying vec3 vFaceMin;
flat varying vec3 vFaceMax;
flat varying float vFaceRand;`
const GRADIENT_FACET_VERT_BODY = /* glsl */ `#include <begin_vertex>
vGradPos = position;
vGradFlat = position;
vFaceMin = aFaceMin;
vFaceMax = aFaceMax;
vFaceRand = aFaceRand;`
const GRADIENT_FACET_FRAG_DECL = /* glsl */ `#include <common>
${GRADIENT_UNIFORM_DECL}
uniform int uMode;
varying vec3 vGradPos;
flat varying vec3 vGradFlat;
flat varying vec3 vFaceMin;
flat varying vec3 vFaceMax;
flat varying float vFaceRand;
${GRADIENT_RAMP_FN}`
const GRADIENT_FACET_FRAG_BODY = /* glsl */ `#include <color_fragment>
{
  float t;
  if (uMode == 2) {
    // prismatic: full ramp across THIS face's own extent
    t = gradT(vGradPos, vFaceMin, vFaceMax);
  } else if (uMode == 3) {
    // scatter: one random discrete swatch per face (6 buckets)
    t = (floor(vFaceRand * 6.0) + 0.5) / 6.0;
  } else if (uMode == 4) {
    // ombre: per-face ramp sample nudged by a per-face dither → stippled bands
    t = gradT(vGradFlat, uBoxMin, uBoxMax) + (vFaceRand - 0.5) * 0.15;
  } else {
    // faceted (1): one flat tone per face against the whole-object box
    t = gradT(vGradFlat, uBoxMin, uBoxMax);
  }
  diffuseColor.rgb = gradSample(clamp(t, 0.0, 1.0));
}`

// uMode uniform for the facet program: faceted (1, default) / prismatic (2) /
// scatter (3) / ombre (4) — see GRADIENT_FACET_FRAG_BODY above.
const FACET_UMODE: Record<string, number> = { faceted: 1, prismatic: 2, scatter: 3, ombre: 4 }
const facetUMode = (shading: string | undefined): number => FACET_UMODE[shading ?? 'faceted'] ?? 1

/** The holographic foil's roughness from its Gloss dial: brushed (0.55) at 0, mirror (0.04)
 *  at 1. The only place the foil's roughness is decided — it has no roughness row of its own. */
export const holoRoughness = (gloss: number): number => 0.55 + (0.04 - 0.55) * Math.min(1, Math.max(0, gloss))

// ── Opalescent: thin-film / holographic spectrum ────────────────────────────
// A MeshStandardMaterial like fresnel/gradient — the full lit pipeline still runs, so the form
// reads as a soft 3D body, not a flat decal. Unlike gradient (a SPATIAL ramp along a world
// axis), the opal driver `s` comes from the view-space NORMAL and the FRESNEL angle, so the
// spectrum flows and shifts as the object turns — the opal signature. It samples the SAME ramp
// LUT the gradient material uses (buildRampTexture over gradientStopsOf), so any palette works.
//
// Injects ONLY in the fragment shader, at `emissivemap_fragment` (exactly where fresnel injects)
// — that is AFTER `normal`/`vViewPosition` are computed but BEFORE `material.diffuseColor` is
// assigned from `diffuseColor` in `lights_physical_fragment`, so overwriting `diffuseColor.rgb`
// here feeds the rainbow through the standard lighting. No vertex injection and no custom
// varyings: `normal` (view space) and `vViewPosition` are three's own built-ins.
const OPAL_FRAG_DECL = /* glsl */ `#include <common>
uniform sampler2D uRamp;
uniform float uHueShift;   // spectrum rotation, pre-normalised to 0..1 (degrees/360)
uniform float uFrequency;  // rainbow bands across the surface
uniform float uAngleMix;   // 0 = normal-driven, 1 = fresnel/view-driven
uniform float uStrength;   // rainbow vs the lit base colour
uniform float uOpalTime;   // wall-clock seconds (0 for a still opal)
uniform float uFlow;`      /* time drift speed; s advances by uOpalTime*uFlow */
const OPAL_FRAG_BODY = /* glsl */ `#include <emissivemap_fragment>
{
  vec3 nrm = normalize( normal );
  vec3 vdir = normalize( vViewPosition );
  // fres: 0 face-on (centre), 1 at the grazing rim — the classic opal edge shift.
  float fres = pow( 1.0 - clamp( abs( dot( nrm, vdir ) ), 0.0, 1.0 ), 1.5 );
  // nterm: 0..1 from the view-space normal's up component — a smooth field across the body
  // that turns with the object.
  float nterm = nrm.y * 0.5 + 0.5;
  float s = mix( nterm, fres, clamp( uAngleMix, 0.0, 1.0 ) );
  s = fract( s * uFrequency + uHueShift + uOpalTime * uFlow );
  vec3 rainbow = texture2D( uRamp, vec2( s, 0.5 ) ).rgb;
  diffuseColor.rgb = mix( diffuseColor.rgb, rainbow, clamp( uStrength, 0.0, 1.0 ) );
}`

// ── Holographic foil: diffraction-grating rainbow over a metal ──────────────
// A sibling of opalescent, not a mode of it. Opal is a thin film steered by the surface
// normal / fresnel angle; foil is a diffraction GRATING: the rainbow position comes from the
// half vector between the key light and the view (`H`), projected onto a grating direction
// (`tang`) that lies in the surface's tangent plane and is turned by the Grating angle dial.
// `u = dot(tang, H)` is the position across the sweep (−1..1); its magnitude walks the same
// ramp LUT the opal/gradient materials sample. The Flakes dial jitters the grating angle per
// object-local cell so the clean streak breaks into glitter — hence the ONE vertex injection:
// `vHoloPos = transformed` (object space, so the cells stick to the surface as it moves).
// `holoHash`, not `rand`: three's `<common>` already owns `rand`.
//
// Fragment injection at `emissivemap_fragment`, exactly like opal: after `normal` /
// `vViewPosition` / `totalEmissiveRadiance` exist, before `lights_physical_fragment` turns
// `diffuseColor` into the specular colour (metalness 1). The rainbow is ADDED as emissive
// (dispersed light glows) AND tints `diffuseColor` so the metal's reflections take it too.
// `directionalLights[0]` is the engine's sun (added at construction, so it is index 0); with
// no directional light at all the sweep is driven from straight ahead.
const HOLO_VERT_DECL = /* glsl */ `#include <common>
varying vec3 vHoloPos;`
const HOLO_VERT_BODY = /* glsl */ `#include <worldpos_vertex>
vHoloPos = transformed;`
const HOLO_FRAG_DECL = /* glsl */ `#include <common>
varying vec3 vHoloPos;
uniform sampler2D uRamp;
uniform float uStrength;   // rainbow glow over the metal (0..2)
uniform float uBands;      // rainbow repeats across one sweep
uniform float uAngle;      // grating angle, degrees
uniform float uFlakes;     // 0 = clean linear foil, 1 = every flake a random grating
uniform float uFlakeSize;  // object-local cell size
uniform float uHueShift;   // spectrum rotation, pre-normalised to 0..1 (degrees/360)
float holoHash( vec3 p ) {
  p = fract( p * 0.3183099 + vec3( 0.1, 0.2, 0.3 ) );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}`
const HOLO_FRAG_BODY = /* glsl */ `#include <emissivemap_fragment>
{
  vec3 nrm = normalize( normal );
  vec3 vdir = normalize( vViewPosition );
  #if NUM_DIR_LIGHTS > 0
    vec3 ldir = normalize( directionalLights[ 0 ].direction );
  #else
    vec3 ldir = vec3( 0.0, 0.0, 1.0 );
  #endif
  vec3 h = normalize( ldir + vdir );
  // Tangent frame from the view-space normal; ref is up unless the normal is near-vertical.
  vec3 ref = abs( nrm.y ) < 0.95 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
  vec3 t0 = normalize( cross( ref, nrm ) );
  vec3 b0 = cross( nrm, t0 );
  vec3 cell = floor( vHoloPos / max( uFlakeSize, 1e-3 ) );
  float jitter = ( holoHash( cell ) - 0.5 ) * 6.2831853 * uFlakes;
  float a = radians( uAngle ) + jitter;
  vec3 tang = t0 * cos( a ) + b0 * sin( a );
  float u = dot( tang, h );
  float au = abs( u );
  float s = fract( au * uBands + uHueShift );
  vec3 rainbow = texture2D( uRamp, vec2( s, 0.5 ) ).rgb;
  // Zero order (plain specular) stays white; the sweep fades out at its edges; and it lives
  // near the highlight like a real foil.
  float env = smoothstep( 0.02, 0.12, au ) * ( 1.0 - smoothstep( 0.55, 0.95, au ) );
  env *= pow( clamp( dot( nrm, h ), 0.0, 1.0 ), 2.0 );
  totalEmissiveRadiance += rainbow * env * uStrength;
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * ( 0.35 + rainbow ), env * min( uStrength, 1.0 ) * 0.7 );
}`

// ── Screen finish: print-style dot/line/cross screen ─────────────────────────
// A print-style dot/line/cross screen anchored to the mesh's own UVs, sized by
// the LIT result. Injected AFTER lighting at <opaque_fragment> — the one chunk every built-in
// material shares where `outgoingLight` and `diffuseColor.a` both exist — so it composes with
// gradient/fresnel/opal (which inject at color_fragment/emissivemap_fragment) and with toon,
// matcap and basic. Reads the `uv` attribute through its OWN varying: three's vertex prefix
// always declares `attribute vec2 uv;`, so this never depends on USE_UV or on a texture being
// bound. Kinds (pattern/gap/ink) are uniforms so switching them never recompiles.
const SCREEN_VERT_PARS = /* glsl */ `#include <uv_pars_vertex>
varying vec2 vScrUv;`
const SCREEN_VERT_BODY = /* glsl */ `#include <uv_vertex>
vScrUv = uv;`
const SCREEN_FRAG_PARS = /* glsl */ `#include <uv_pars_fragment>
varying vec2 vScrUv;
uniform float uScrPattern; uniform float uScrDensity; uniform float uScrAngle; uniform float uScrContrast;
uniform float uScrSoft; uniform float uScrMisreg; uniform float uScrInvert;
uniform float uScrGapMode; uniform vec3 uScrGapColor; uniform float uScrInkMode; uniform vec3 uScrInkColor;
// Coverage 0..1 of ink at grid position p for brightness lum. Dot AREA follows lum, so a
// half-bright cell is half covered; lines/cross use lum as the half-width.
float scrCoverage(vec2 p, float lum) {
  vec2 cell = fract(p) - 0.5;
  // Both axes, because p is rotated: at 90° the cell varies along y while fwidth(p.x) is
  // ~0, which would collapse the anti-aliasing term to nothing. Floored above zero so a
  // fully-degenerate derivative can never make smoothstep's edges equal.
  float soft = max(uScrSoft * 0.25 + max(fwidth(p.x), fwidth(p.y)) * 0.75, 1e-4);
  if (uScrPattern < 0.5) {
    float r = sqrt(lum) * 0.7071;
    return 1.0 - smoothstep(r - soft, r + soft, length(cell));
  }
  float hw = lum * 0.5;
  float ly = 1.0 - smoothstep(hw - soft, hw + soft, abs(cell.y));
  if (uScrPattern < 1.5) return ly;
  float lx = 1.0 - smoothstep(hw - soft, hw + soft, abs(cell.x));
  return max(lx, ly);
}`
// Replaces <opaque_fragment> outright (its OPAQUE clamp is reproduced; the transmission alpha
// branch is not — glass never gets a screen).
const SCREEN_FRAG_BODY = /* glsl */ `
#ifdef OPAQUE
diffuseColor.a = 1.0;
#endif
{
  float c = cos(uScrAngle), s = sin(uScrAngle);
  // Same rotation form as the repo's 2D screens (dot_screen/halftone): rotating the sampling coordinates this way turns the VISIBLE pattern counter-clockwise for a rising Angle.
  vec2 p = mat2(c, -s, s, c) * vScrUv * uScrDensity;
  float lum = clamp(dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  lum = pow(lum, uScrContrast);
  if (uScrInvert > 0.5) lum = 1.0 - lum;
  float shift = uScrMisreg * 0.35;
  vec3 cov = vec3(scrCoverage(p + vec2(shift, 0.0), lum), scrCoverage(p, lum), scrCoverage(p - vec2(shift, 0.0), lum));
  vec3 ink = uScrInkMode < 0.5 ? outgoingLight : uScrInkColor;
  if (uScrGapMode < 0.5) {
    float a = max(cov.r, max(cov.g, cov.b));
    // Fully-open gaps leave the fragment entirely: alphaTest cannot do this job, because
    // three runs <alphatest_fragment> BEFORE lighting, against diffuseColor.a, which knows
    // nothing about the screen coverage computed here. Discarding keeps depthWrite on for
    // the dots while the gaps write no depth, so an object behind still shows through.
    if (a < 0.02) discard;
    gl_FragColor = vec4(ink * cov / max(a, 1e-4), a * diffuseColor.a);
  } else {
    gl_FragColor = vec4(mix(uScrGapColor, ink, cov), diffuseColor.a);
  }
}`
const SCREEN_PATTERN_INDEX: Record<string, number> = { dots: 0, lines: 1, cross: 2 }

/** Write the doc's screen dials into an existing material's screen uniforms (in place). */
function writeScreenUniforms(u: Record<string, { value: unknown }>, s: ReturnType<typeof screenOf>): void {
  u.uScrPattern!.value = SCREEN_PATTERN_INDEX[s.pattern] ?? 0
  u.uScrDensity!.value = s.density
  u.uScrAngle!.value = (s.angle * Math.PI) / 180
  u.uScrContrast!.value = s.contrast
  u.uScrSoft!.value = s.softness
  u.uScrMisreg!.value = s.misregister
  u.uScrInvert!.value = s.invert ? 1 : 0
  u.uScrGapMode!.value = s.gap === 'colour' ? 1 : 0
  ;(u.uScrGapColor!.value as THREE.Color).set(stripAlpha(s.gapColor))
  u.uScrInkMode!.value = s.ink === 'colour' ? 1 : 0
  ;(u.uScrInkColor!.value as THREE.Color).set(stripAlpha(s.inkColor))
}

/** The screen finish: chains a post-lighting screen onto whatever `onBeforeCompile` the
 *  material already carries. No-op for glass and for `pattern: 'none'` (so a screen-less
 *  material is byte-identical to before this feature existed). */
export function applyScreen(m: THREE.Material, mat: SceneMaterial): void {
  if (mat.type === 'glass') return
  const s = screenOf(mat)
  if (s.pattern === 'none') return
  const u: Record<string, { value: unknown }> = {
    uScrPattern: { value: 0 }, uScrDensity: { value: 0 }, uScrAngle: { value: 0 }, uScrContrast: { value: 1 },
    uScrSoft: { value: 0 }, uScrMisreg: { value: 0 }, uScrInvert: { value: 0 },
    uScrGapMode: { value: 0 }, uScrGapColor: { value: new THREE.Color('#ffffff') },
    uScrInkMode: { value: 0 }, uScrInkColor: { value: new THREE.Color('#111111') },
  }
  writeScreenUniforms(u, s)
  // Read EAGERLY, before onBeforeCompile is reassigned. Three's default
  // customProgramCacheKey returns `this.onBeforeCompile.toString()` at call time, so a
  // lazily-bound `prevKey()` would hash the screen wrapper below — one identical source
  // string for every screened material — rather than whatever the base material's own
  // injection contributed. Safe to snapshot: every key applyScreen can sit on top of
  // (three's default, and the fresnel/gradient/opal constants) is already settled by this
  // point. The one step that follows — applyVaryTint — snapshots eagerly for the same
  // reason, and so composes with this key rather than racing it.
  const baseKey = String(m.customProgramCacheKey())
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer)
    Object.assign(shader.uniforms, u)
    shader.vertexShader = shader.vertexShader
      .replace('#include <uv_pars_vertex>', SCREEN_VERT_PARS)
      .replace('#include <uv_vertex>', SCREEN_VERT_BODY)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <uv_pars_fragment>', SCREEN_FRAG_PARS)
      .replace('#include <opaque_fragment>', SCREEN_FRAG_BODY)
  }
  m.customProgramCacheKey = () => `${baseKey}|screen`
  m.userData.screenUniforms = u
  // Transparent gaps: alpha in the gaps, depth writes kept so the dots still occlude. The
  // shader `discard`s fully-open gaps, so they write no depth either (no alphaTest here —
  // it runs before lighting and would never see the coverage, while still forcing an extra
  // shadow-program variant). Colour gaps stay opaque.
  m.userData.screenTransparent = s.gap === 'transparent'
  if (m.userData.screenTransparent) { m.transparent = true; m.depthWrite = true }
}

// ── Gradient ramp LUT ────────────────────────────────────────────────────────
const RAMP_WIDTH = 256

/** Build the 256×1 sRGB LUT the gradient shader samples. Colours interpolate in
 *  sRGB between adjacent stops — the same space a CSS `linear-gradient` uses, so
 *  the ramp editor's preview and the rendered object agree. Beyond the outermost
 *  stops the edge colour floods.
 *
 *  Input need NOT be sorted: the endpoint flood and the monotonic `seg` walk
 *  below both assume ascending `pos`, so an unsorted array would render a
 *  glitched ramp. The ramp editor deliberately keeps its working array
 *  unsorted mid-drag (sorting live would make the dragged handle jump under
 *  the cursor), and that array reaches here on every pointermove. Sorting a
 *  copy here — at most 8 entries — makes this self-defending rather than
 *  leaving a precondition every future caller has to remember. */
export function buildRampTexture(stops: GradientStop[]): THREE.DataTexture {
  // getHex(SRGBColorSpace) undoes three's sRGB→linear ingest, giving back the
  // authored 8-bit channels; the texture's colorSpace re-decodes them on sample.
  const srgb = [...stops].sort((a, b) => a.pos - b.pos).map((s) => {
    const hex = new THREE.Color(stripAlpha(s.color)).getHex(THREE.SRGBColorSpace)
    return { pos: s.pos, r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 }
  })
  const data = new Uint8Array(RAMP_WIDTH * 4)
  const first = srgb[0]!
  const last = srgb[srgb.length - 1]!
  let seg = 0
  for (let i = 0; i < RAMP_WIDTH; i++) {
    const x = i / (RAMP_WIDTH - 1)
    let r: number, g: number, b: number
    if (x <= first.pos) { r = first.r; g = first.g; b = first.b }
    else if (x >= last.pos) { r = last.r; g = last.g; b = last.b }
    else {
      while (seg < srgb.length - 2 && x > srgb[seg + 1]!.pos) seg++
      const a = srgb[seg]!, c = srgb[seg + 1]!
      const span = c.pos - a.pos
      const f = span > 0 ? (x - a.pos) / span : 1
      r = a.r + (c.r - a.r) * f
      g = a.g + (c.g - a.g) * f
      b = a.b + (c.b - a.b) * f
    }
    data.set([Math.round(r), Math.round(g), Math.round(b), 255], i * 4)
  }
  const t = new THREE.DataTexture(data, RAMP_WIDTH, 1, THREE.RGBAFormat)
  t.colorSpace = THREE.SRGBColorSpace
  t.magFilter = t.minFilter = THREE.LinearFilter
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
  t.needsUpdate = true
  return t
}

/** Cheap change detector: the LUT is rebuilt only when this string moves. */
function rampSignature(stops: GradientStop[]): string {
  return stops.map((s) => `${s.pos}:${s.color}`).join('|')
}

// ── Physical surface (standard + glass share one builder) ────────────────────
/** Apply every physical-surface param from the doc onto a MeshPhysicalMaterial.
 *  Shared by creation and in-place update so the two can never drift. */
function applyPhysical(p: THREE.MeshPhysicalMaterial, mat: SceneMaterial): void {
  const isGlass = mat.type === 'glass'
  p.color.set(stripAlpha(mat.color))
  p.roughness = mat.roughness
  p.metalness = mat.metalness
  p.transmission = mat.transmission ?? (isGlass ? MATERIAL_DEFAULTS.transmission : 0)
  p.ior = mat.ior ?? MATERIAL_DEFAULTS.ior
  p.thickness = mat.thickness ?? MATERIAL_DEFAULTS.thickness
  // Transmissive surfaces render double-sided so refraction reaches the object's
  // own back walls and interior facets — a solid glass gem rather than a hollow
  // shell. Opaque surfaces stay single-sided (alpha opacity is a flat front-face
  // fade by design; Transmission is the physical see-through path).
  p.side = p.transmission > 0 ? THREE.DoubleSide : THREE.FrontSide
  p.clearcoat = mat.clearcoat ?? MATERIAL_DEFAULTS.clearcoat
  p.clearcoatRoughness = mat.clearcoatRoughness ?? MATERIAL_DEFAULTS.clearcoatRoughness
  p.sheen = mat.sheen ?? MATERIAL_DEFAULTS.sheen
  p.sheenColor.set(stripAlpha(mat.sheenColor ?? MATERIAL_DEFAULTS.sheenColor))
  p.emissive.set(stripAlpha(mat.emissive ?? MATERIAL_DEFAULTS.emissive))
  p.emissiveIntensity = mat.emissiveIntensity ?? MATERIAL_DEFAULTS.emissiveIntensity
  p.opacity = mat.opacity ?? MATERIAL_DEFAULTS.opacity
  // A screen with transparent gaps owns `transparent` too — an unrelated slider drag must not
  // flip it back to opaque (see applyScreen).
  p.transparent = p.opacity < 1 || p.userData.screenTransparent === true
  p.dispersion = mat.dispersion ?? MATERIAL_DEFAULTS.dispersion
  p.attenuationColor.set(stripAlpha(mat.attenuationColor ?? MATERIAL_DEFAULTS.attenuationColor))
  const att = mat.attenuationDistance ?? MATERIAL_DEFAULTS.attenuationDistance
  p.attenuationDistance = att > 0 ? att : Infinity
  p.iridescence = mat.iridescence ?? MATERIAL_DEFAULTS.iridescence
  p.iridescenceIOR = mat.iridescenceIOR ?? MATERIAL_DEFAULTS.iridescenceIOR
  p.envMapIntensity = mat.envMapIntensity ?? MATERIAL_DEFAULTS.envMapIntensity
}

/**
 * The image material's transparency, shared by the build and the in-place update so the
 * two can never disagree.
 *
 * Two independent paths, deliberately:
 *  - `imageAlpha` honours the FILE's own alpha channel. It moves the material into the
 *    sorted, blended render list, which is why it is off by default rather than always on.
 *  - `imageCutout` is `alphaTest`: fragments below the threshold leave the shader with
 *    `discard`, so a sticker or a cut-out leaf gets a hard edge, writes depth, and needs no
 *    sorting at all. Only meaningful alongside `imageAlpha` — with no alpha channel every
 *    fragment is 1.0 and the test never fires — so it is gated on it.
 *  - `opacity` fades the whole surface, and forces `transparent` on its own.
 *
 * Both `transparent` and a zero-crossing of `alphaTest` are PROGRAM DEFINE boundaries that
 * three does not manage for us (unlike transmission/clearcoat/sheen, whose setters
 * self-recompile). Bump `needsUpdate` on a crossing and NEVER on a plain slider move
 * inside a range, or every tick recompiles the shader.
 *
 * KNOWN LIMITATION (documented, not fixed — Minor 10 of the final review): `imageCutout`'s
 * `discard` lives entirely inside this material's own `onBeforeCompile` injection
 * (imageShader.ts's `imageMapFragment`), which three does not carry over to the shadow
 * DEPTH material it builds for shadow-casting. So a cutout picture under any non-`uv`
 * projection casts a shadow shaped by the mesh's own UVs (or none), not by the projected
 * silhouette the viewer actually sees — the cast shadow's outline can disagree with the
 * cutout's visible edge.
 */
function applyImageTransparency(m: THREE.Material, mat: SceneMaterial): void {
  const wasTransparent = m.transparent
  const wasCutting = m.alphaTest > 0
  const useAlpha = mat.imageAlpha === true
  const opacity = mat.opacity ?? MATERIAL_DEFAULTS.opacity
  m.opacity = opacity
  m.alphaTest = useAlpha ? (mat.imageCutout ?? MATERIAL_DEFAULTS.imageCutout) : 0
  // A pure cutout is NOT transparent: it discards, writes depth, and sorts like an opaque
  // surface — which is the whole reason to reach for it.
  // A screen with transparent gaps owns `transparent` too (see applyScreen) — the same
  // precedent applyPhysical already follows for the standard/glass branch. Without this
  // clause, the FIRST unrelated dial move after construction (identityKey unchanged, so
  // this runs via updateMaterial rather than a rebuild) clobbers the screen's own
  // `transparent = true` back to whatever imageAlpha/opacity alone would produce — the
  // halftone gaps go opaque mid-session even though nothing about the screen changed.
  m.transparent = opacity < 1 || (useAlpha && m.alphaTest === 0) || m.userData.screenTransparent === true
  if (m.transparent !== wasTransparent || (m.alphaTest > 0) !== wasCutting) m.needsUpdate = true
}

/**
 * Bind the picture as its own emissive map, so it lights itself — a screen, a sign, a
 * light-box. Reuses the SAME Texture object as `.map` rather than loading a second copy:
 * the UV transform, the wrap mode and the tiling all travel with it for free, which is
 * exactly what you want (the glow must line up with the picture).
 *
 * Binding an emissive map with a BLACK `emissive` colour renders nothing at all — three
 * multiplies the two — so the colour is driven to white alongside the map and back to
 * black when the glow is off, rather than being exposed as a second control.
 *
 * A no-op on MeshBasicMaterial (the flat variant): there is no emissive slot, and there is
 * no lighting model for one to feed.
 */
function applyImageGlow(m: THREE.Material, mat: SceneMaterial): void {
  const s = m as THREE.MeshStandardMaterial
  if (!('emissiveMap' in s)) return
  const glow = mat.imageGlow ?? MATERIAL_DEFAULTS.imageGlow
  const on = glow > 0 && !!s.map
  const wasOn = !!s.emissiveMap
  s.emissiveMap = on ? s.map : null
  s.emissive.set(on ? '#ffffff' : '#000000')
  s.emissiveIntensity = on ? glow : 1
  // USE_EMISSIVEMAP is a program define three does not manage on assignment.
  if (on !== wasOn) s.needsUpdate = true
}

/**
 * A Texture the image material owns OUTRIGHT, rather than the shared per-filename
 * `imageCache`.
 *
 * Required by the feature: `repeat`, `offset`, `rotation` and `wrapS/wrapT` live on the
 * TEXTURE, so two objects showing the same file at different tilings need two Textures.
 * And it fixes a bug the shared cache had all along — `disposeMaterial` calls
 * `map.dispose()`, which freed a texture every other material on that filename was still
 * drawing with, blanking them.
 *
 * The cost is the same one `bindTextureMaps` already accepts one function below: the
 * browser's HTTP cache dedupes the BYTES, so only the decode is repeated per material.
 *
 * Cloning a cached Texture is NOT an alternative: `Texture.clone()` copies `.image` by
 * value at clone time, so a clone taken before the async load resolves stays empty forever.
 */
function ownedImageTexture(m: THREE.Material, mat: SceneMaterial): THREE.Texture | null {
  const filename = mat.image ?? ''
  if (!hasDOM || !filename) return null
  const tex = new THREE.TextureLoader().load(
    inputViewUrl(filename),
    (loaded) => {
      // A material disposed while its file was still downloading must not be touched —
      // same hazard, and the same guard, as reliefHealPending and applyTextureSet.
      if (m.userData.disposed) return
      // The natural pixel size exists only now, so Fit's cover/contain were identity
      // transforms until this point and settle here. `imageSpec` is the LIVE material —
      // the user may have moved four sliders while the file was in flight.
      const src = loaded.image as { width?: number; height?: number } | undefined
      if (src?.width && src?.height) m.userData.imageNatural = { w: src.width, h: src.height }
      const spec = m.userData.imageSpec as SceneMaterial | undefined
      // The PRISTINE decoded picture, kept alive in this Texture's own userData for the
      // whole material's lifetime — so a LATER Seamless change (see imageSetSeamless below)
      // can re-blend from the untouched source instead of re-blending an already-blended
      // canvas (which would drift) or re-fetching/re-decoding the file (Important 3, final
      // review — the fix mirrors the relief C1 fix's `reliefSetContrast`: keep the source,
      // repaint the SAME texture's canvas in place, never rebuild the material for a slider).
      const rawSource = loaded.image as CanvasImageSource
      tex.userData.imageRawSource = rawSource
      // Seamless pre-pass: repaint the decoded picture into a canvas whose opposite edges
      // have been cross-faded, then point the SAME Texture at it. Done here rather than at
      // build time because it needs the decoded pixels, and only when the dial is non-zero
      // so an untouched picture keeps its own bytes and its own memory footprint.
      const width = spec ? seamlessWidth(spec) : 0
      if (width > 0 && src?.width && src?.height) {
        const blended = seamlessCanvas(rawSource, src.width, src.height, width)
        if (blended) { loaded.image = blended; loaded.needsUpdate = true }
      }
      m.userData.imageSeamlessApplied = width
      // C1-style in-place repaint: re-blend from the pristine `imageRawSource` at a NEW
      // width and repoint this SAME Texture's `.image` at the fresh canvas — no TextureLoader
      // fetch, no decode, no material rebuild. `updateMaterial`'s in-place block calls this
      // only when the Seamless dial has actually moved since the last paint (mirrors
      // `reliefContrastApplied`'s guard), so an unrelated dial edit never re-blends for
      // nothing. A no-op until the natural size is known (`imageNatural` unset) — the same
      // guard `applyImageTransform` already relies on elsewhere in this closure.
      tex.userData.imageSetSeamless = (w: number) => {
        const natural = m.userData.imageNatural as NaturalSize | undefined
        if (!natural) return
        const raw = tex.userData.imageRawSource as CanvasImageSource | undefined
        if (!raw) return
        const rebl = w > 0 ? seamlessCanvas(raw, natural.w, natural.h, w) : null
        tex.image = rebl ?? raw
        tex.needsUpdate = true
      }
      if (spec) applyImageTransform(loaded, spec, m.userData.imageNatural as NaturalSize | undefined)
      // A projected picture (Fit's cover/contain feeding into uImgMapTx) settles once the
      // natural size lands — without this, a projection keeps the identity-transform matrix
      // it was built with until the NEXT dial move triggers updateMaterial.
      const u = m.userData.imageUniforms as ImageUniforms | undefined
      if (u) syncImageMapMatrix(u, loaded)
    },
    undefined,
    () => {
      // A material disposed while its file was still downloading must not be touched — same
      // guard as onLoad above. Without it, a request that fails AFTER disposeMaterial already
      // ran would null `.map`/bump `needsUpdate` on a dead material, dispose `tex` a SECOND
      // time (disposeMaterial already disposed it), and surface a load-failure notice for a
      // file the user has already swapped away from (Finding 3, image-material follow-ups).
      if (m.userData.disposed) return
      const s = m as THREE.MeshStandardMaterial
      if (s.map === tex) { s.map = null; s.needsUpdate = true }
      // applyImageGlow binds the emissive map to this SAME Texture instance (see its doc) —
      // left pointing at a disposed texture, `emissiveMap` would still read USE_EMISSIVEMAP
      // against dead GPU data instead of degrading alongside `.map`.
      if (s.emissiveMap === tex) { s.emissiveMap = null; s.needsUpdate = true }
      tex.dispose()
      errorSubs.forEach((cb) => cb(filename))
    },
  )
  tex.colorSpace = THREE.SRGBColorSpace
  // Finding 2 fix: prime wrapS/wrapT + the userData stamp to match `mat.imageWrap` BEFORE
  // this texture is handed out. The caller applies the full transform immediately after
  // (with `natural: null`, since the image hasn't decoded yet) — without this priming, that
  // first `applyImageTransform` call always sees a fresh `undefined` stamp and bumps
  // `needsUpdate` on a texture with no image yet, which three warns about on every build. A
  // LATER genuine wrap-mode change still bumps normally: that call compares against this same
  // stamp and finds it changed.
  const { key, wrap } = imageWrapMode(mat)
  tex.wrapS = tex.wrapT = wrap
  tex.userData.imageWrapApplied = key
  return tex
}

/** True when this geometry is a Cloner-merged clone set carrying the Vary per-copy
 *  colour attribute, AND this material type has a base colour to mix it against.
 *
 *  `NO_BASE_COLOR` — the set naming those types, with the reasoning for each entry —
 *  lives in config.ts rather than here, so this RENDER-side rule and the inspector's own
 *  gate (`varyColorable` in controls.ts, which hides the Cloner's Colour control for
 *  exactly these types) read ONE list and cannot drift apart. controls.ts must stay
 *  three-free, so it cannot import this module.
 *
 *  Gated on the `varyTint` STAMP `mergeClones` writes, never on the presence of a
 *  `color` attribute: `GLTFLoader` maps a glTF `COLOR_0` to an attribute of exactly
 *  that name and vertex-coloured GLBs are common, so testing for the attribute would
 *  mistake every such model for a clone set and silently change how an existing scene
 *  renders the moment a material override is on. */
export function hasVertexTint(mat: SceneMaterial, geometry?: THREE.BufferGeometry): boolean {
  if (!geometry || NO_BASE_COLOR.has(mat.type)) return false
  return geometry.userData.varyTint === true
}

/** The Vary blend amount: 0 = the plain material colour, 1 = the pure palette colour.
 *  Missing/garbage reads as 1, which is what the dial's own default is. Clamped
 *  because it reaches a shader uniform.
 *
 *  Passed EXPLICITLY by the caller (`materialFor`/`updateMaterial` take it beside the
 *  geometry) rather than read off `geometry.userData`. It used to ride on the merged
 *  geometry as a stamp, which worked only because `varyColorStrength` was a
 *  `MODIFIER_SPECS` key that `geoKeyFor` hashed — so every tick of the Colour strength
 *  slider disposed the geometry and re-merged all N clone copies to produce
 *  byte-identical vertex data, and any future edit that (correctly) noticed the
 *  strength is not baked into vertices and dropped it from the key would have killed
 *  the dial silently. The strength is a MATERIAL property; this is the parameter that
 *  says so. */
function varyStrengthOf(strength?: number): number {
  return typeof strength === 'number' && Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1
}

// Mix from whatever the material's own pipeline put in `diffuseColor.rgb` — captured
// BEFORE `<color_fragment>` runs — toward this copy's vertex colour. Reissues the real
// `<color_fragment>` chunk first, so `vColor` is declared (three emits
// `color_pars_fragment` under USE_COLOR, which `vertexColors` turns on) and the
// material's own varying setup is untouched. `.rgb` rather than a bare `vColor` so a
// four-component colour attribute (USE_COLOR_ALPHA → `vColor` is a vec4) still
// compiles; the Cloner writes three components.
//
// The chunk's own body is `diffuseColor.rgb *= vColor` — that multiply runs SECOND,
// against `#include <color_fragment>` on its own line (three's include regex only
// matches at line-start). Mixing from `diffuseColor.rgb` at that point would read the
// ALREADY-multiplied value — material colour times palette colour — not the material
// colour, so strength 0 would render a near-black smear instead of the plain material
// colour. `varyBase` captures the pre-multiply value so the mix's low end is honest at
// every strength, including 1 (pure palette colour, same as before).
const VARY_TINT_FRAG_BODY = /* glsl */ `vec3 varyBase = diffuseColor.rgb;
#include <color_fragment>
diffuseColor.rgb = mix( varyBase, vColor.rgb, uVaryStrength );`

// The declaration for the uniform the body above reads. PREPENDED to the fragment source
// rather than injected at a chunk anchor, because by the time this runs every anchor a
// declaration could reasonably use has already been consumed by an injection that ran
// earlier in the chain: `applyVaryTint` calls `prev` FIRST, so fresnel and holographic have
// already taken `#include <common>`, and `applyScreen` has already taken
// `#include <uv_pars_fragment>` (its own PARS site). A `.replace` whose needle is gone is a
// SILENT no-op — that is exactly how the missing declaration shipped green — so the safe
// site is the one no injection can consume: the top of the string. Three builds its
// `#version` / precision / `#define` prefix separately in WebGLProgram and concatenates it
// ahead of `shader.fragmentShader`, so a bare global declaration here still lands after the
// version directive, and it sits above the `#define STANDARD` / `#define TOON` / … first
// line of every ShaderLib fragment without disturbing it (a uniform declaration depends on
// no define). Valid for all seven tinted types — standard, glass, phong, toon, matcap,
// fresnel, holographic — because it depends on nothing in their sources at all.
const VARY_TINT_FRAG_PARS = /* glsl */ `uniform float uVaryStrength;
`

/** Cloner Vary per-copy colour: chains a `<color_fragment>` mix onto whatever
 *  `onBeforeCompile` the material already carries. Modelled on `applyScreen` above,
 *  including the eager cache-key snapshot — read that function's comment.
 *
 *  Deliberately does NOT touch the base colour. The first version of this feature set
 *  `.color` to white so the palette read true; every in-place branch of `updateMaterial`
 *  rewrites the base colour from the doc, so the neutralisation lasted exactly one sync.
 *  Mixing in the shader cannot be clobbered that way, and it gives `varyColorStrength`
 *  something to mean. */
export function applyVaryTint(m: THREE.Material, varyStrength?: number): void {
  const c = m as THREE.Material & { vertexColors?: boolean }
  c.vertexColors = true
  // Held OUTSIDE the compile closure (as applyScreen holds its uniform bag) so
  // updateMaterial can write the strength in place, with no rebuild, per dial tick.
  const u: Record<string, { value: unknown }> = { uVaryStrength: { value: varyStrengthOf(varyStrength) } }
  // Read EAGERLY, before onBeforeCompile is reassigned — same hazard applyScreen
  // documents at length: three's default customProgramCacheKey returns
  // `this.onBeforeCompile.toString()` at CALL time, so a lazily-bound `prevKey()` would
  // hash the wrapper installed below — one identical source string for every tinted
  // material — instead of whatever the base material's own injection contributed, and
  // a tinted fresnel would then share a compiled program with a tinted toon.
  const baseKey = String(m.customProgramCacheKey())
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    // The material's own injection runs FIRST: fresnel/holographic replace `<common>`
    // and `<emissivemap_fragment>`, and applyScreen replaces `<uv_*>`/`<opaque_fragment>`
    // — none of them consume `<color_fragment>`, so the token is still there for us, and
    // both of those blocks read `diffuseColor` AFTER this mix has written it.
    prev.call(m, shader, renderer)
    Object.assign(shader.uniforms, u)
    shader.fragmentShader = VARY_TINT_FRAG_PARS + shader.fragmentShader
      .replace('#include <color_fragment>', VARY_TINT_FRAG_BODY)
  }
  m.customProgramCacheKey = () => `${baseKey}|varyTint`
  m.userData.vertexTint = true
  m.userData.varyUniforms = u
}

// ── Factory ──────────────────────────────────────────────────────────────────
/** `ownerId` scopes a `shaderFill` material's live field to the calling engine (see
 *  `shaderFillMaterials`'s doc) — SceneEngine always passes its own stable `id`; callers with
 *  no engine in scope (unit tests) fall back to a shared UNOWNED bucket. Ignored by every other
 *  material type.
 *
 *  `varyStrength` is the Cloner Vary blend amount — only meaningful when `geometry` carries
 *  the `varyTint` stamp. Omitted means 1 (the dial's own default), so every existing caller
 *  keeps its behaviour exactly. */
export function materialFor(
  mat: SceneMaterial,
  geometry?: THREE.BufferGeometry,
  ownerId: string = UNOWNED_SCENE3D,
  varyStrength?: number,
  finishes?: FinishTreatment[],
): THREE.Material {
  let m: THREE.Material
  switch (mat.type) {
    case 'toon': {
      const t = new THREE.MeshToonMaterial({ color: mat.color })
      t.gradientMap = toonRamp(mat.toonSteps ?? MATERIAL_DEFAULTS.toonSteps)
      m = t
      break
    }
    // Phong is a DELIBERATE stylistic choice, not a legacy leftover — see MaterialType's doc
    // in config.ts. MeshPhongMaterial's specular/shininess model has no roughness/metalness
    // concept, so neither is set here; it renders a hard glossy highlight the PBR types
    // (standard/glass) cannot reproduce regardless of how their roughness is tuned.
    case 'phong': {
      const ph = new THREE.MeshPhongMaterial()
      ph.color.set(stripAlpha(mat.color))
      ph.shininess = mat.shininess ?? MATERIAL_DEFAULTS.shininess
      ph.specular.set(stripAlpha(mat.specular ?? MATERIAL_DEFAULTS.specular))
      ph.emissive.set(stripAlpha(mat.emissive ?? MATERIAL_DEFAULTS.emissive))
      ph.emissiveIntensity = mat.emissiveIntensity ?? MATERIAL_DEFAULTS.emissiveIntensity
      m = ph
      break
    }
    case 'matcap': {
      const t = new THREE.MeshMatcapMaterial()
      const tex = getMatcap(mat.matcap ?? MATERIAL_DEFAULTS.matcap)
      if (tex) t.matcap = tex
      m = t
      break
    }
    case 'fresnel': {
      // Lit fresnel: base colour is standard albedo, rim added as emissive.
      const fresnelUniforms = {
        uRim: { value: new THREE.Color(stripAlpha(mat.fresnelColor ?? MATERIAL_DEFAULTS.fresnelColor)) },
        uPower: { value: mat.fresnelPower ?? MATERIAL_DEFAULTS.fresnelPower },
      }
      const f = new THREE.MeshStandardMaterial({ color: mat.color, roughness: mat.roughness, metalness: mat.metalness })
      f.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, fresnelUniforms)
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', FRESNEL_FRAG_DECL)
          .replace('#include <emissivemap_fragment>', FRESNEL_FRAG_BODY)
      }
      f.customProgramCacheKey = () => 'scene3d-fresnel'
      f.userData.fresnelUniforms = fresnelUniforms
      m = f
      break
    }
    case 'gradient': {
      // Bounding range comes from the geometry so the ramp always spans the
      // shape exactly; falls back to the unit-ish primitive envelope.
      let boxMin = new THREE.Vector3(-0.55, -0.55, -0.55)
      let boxMax = new THREE.Vector3(0.55, 0.55, 0.55)
      if (geometry) {
        if (!geometry.boundingBox) geometry.computeBoundingBox()
        if (geometry.boundingBox) { boxMin = geometry.boundingBox.min.clone(); boxMax = geometry.boundingBox.max.clone() }
      }
      // Uniform objects live outside the compile closure: onBeforeCompile wires
      // these same objects into the program, so updateMaterial can mutate
      // .value at any time (before or after first compile) and it just works.
      const shading = mat.gradientShading ?? MATERIAL_DEFAULTS.gradientShading
      // Program split: 'smooth' runs on plain geometry; 'faceted'/'prismatic'
      // share the facet program, which reads the engine's per-face extent
      // attributes (aFaceMin/aFaceMax on the flat-shaded geometry variant) and
      // switches between them with the uMode uniform (in-place). Crossing the
      // smooth↔facet boundary rebuilds via identityKey.
      const facetProgram = shading !== 'smooth'
      const stops = rampStopsOf(mat)
      const { yaw, pitch } = gradientAngles(mat)
      const gradUniforms: Record<string, { value: unknown }> = {
        uRamp: { value: buildRampTexture(stops) },
        uBoxMin: { value: boxMin },
        uBoxMax: { value: boxMax },
        uDir: { value: new THREE.Vector3(...gradientDirection(yaw, pitch)) },
        uType: { value: (mat.gradientType ?? MATERIAL_DEFAULTS.gradientType) === 'radial' ? 1 : 0 },
        uOffset: { value: mat.gradientOffset ?? MATERIAL_DEFAULTS.gradientOffset },
        uSpread: { value: mat.gradientSpread ?? MATERIAL_DEFAULTS.gradientSpread },
      }
      if (facetProgram) gradUniforms.uMode = { value: facetUMode(shading) }
      const g = new THREE.MeshStandardMaterial({ roughness: mat.roughness, metalness: mat.metalness })
      g.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, gradUniforms)
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', facetProgram ? GRADIENT_FACET_VERT_DECL : GRADIENT_SMOOTH_VERT_DECL)
          .replace('#include <begin_vertex>', facetProgram ? GRADIENT_FACET_VERT_BODY : GRADIENT_SMOOTH_VERT_BODY)
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', facetProgram ? GRADIENT_FACET_FRAG_DECL : GRADIENT_SMOOTH_FRAG_DECL)
          .replace('#include <color_fragment>', facetProgram ? GRADIENT_FACET_FRAG_BODY : GRADIENT_SMOOTH_FRAG_BODY)
      }
      // Same-variant gradient materials share one program (uniforms differ per
      // material); without a key, three would reuse the plain-standard program
      // and skip our injection — or recompile per material.
      g.customProgramCacheKey = () => (facetProgram ? 'scene3d-gradient-facet' : 'scene3d-gradient-smooth')
      g.userData.gradUniforms = gradUniforms
      g.userData.rampSig = rampSignature(stops)
      m = g
      break
    }
    case 'opalescent': {
      const stops = opalStopsOf(mat)
      // Uniform objects live outside the compile closure so updateMaterial can mutate their
      // `.value` before or after first compile — exactly the gradient/fresnel pattern.
      const opalUniforms: Record<string, { value: unknown }> = {
        uRamp: { value: buildRampTexture(stops) },
        uHueShift: { value: (mat.opalHueShift ?? MATERIAL_DEFAULTS.opalHueShift) / 360 },
        uFrequency: { value: mat.opalFrequency ?? MATERIAL_DEFAULTS.opalFrequency },
        uAngleMix: { value: mat.opalAngleMix ?? MATERIAL_DEFAULTS.opalAngleMix },
        uStrength: { value: mat.opalStrength ?? MATERIAL_DEFAULTS.opalStrength },
        uOpalTime: { value: 0 },
        uFlow: { value: mat.opalFlowSpeed ?? MATERIAL_DEFAULTS.opalFlowSpeed },
      }
      // MeshPhysicalMaterial (a superset of Standard — same meshphysical fragment base, so the
      // emissivemap injection point is identical) so opal can carry a clearcoat + reflection
      // punch: matte soap-bubble at clearcoat 0, wet chrome-holo as it rises. metalness (already
      // exposed) makes the rainbow tint the reflections.
      const o = new THREE.MeshPhysicalMaterial({
        color: stripAlpha(mat.color), roughness: mat.roughness, metalness: mat.metalness,
      })
      o.clearcoat = mat.clearcoat ?? MATERIAL_DEFAULTS.clearcoat
      o.clearcoatRoughness = mat.clearcoatRoughness ?? MATERIAL_DEFAULTS.clearcoatRoughness
      o.envMapIntensity = mat.envMapIntensity ?? MATERIAL_DEFAULTS.envMapIntensity
      o.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, opalUniforms)
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', OPAL_FRAG_DECL)
          .replace('#include <emissivemap_fragment>', OPAL_FRAG_BODY)
      }
      o.customProgramCacheKey = () => 'scene3d-opalescent'
      o.userData.opalUniforms = opalUniforms
      o.userData.rampSig = rampSignature(stops)
      opalMaterials.add(o)
      m = o
      break
    }
    case 'holographic': {
      const stops = opalStopsOf(mat)
      // Uniform objects live outside the compile closure so updateMaterial can mutate their
      // `.value` before or after first compile — the opal/gradient/fresnel pattern. Nothing is
      // time-driven, so no tracking Set and no per-frame refresh.
      const holoUniforms: Record<string, { value: unknown }> = {
        uRamp: { value: buildRampTexture(stops) },
        uStrength: { value: mat.holoStrength ?? MATERIAL_DEFAULTS.holoStrength },
        uBands: { value: mat.holoBands ?? MATERIAL_DEFAULTS.holoBands },
        uAngle: { value: mat.holoAngle ?? MATERIAL_DEFAULTS.holoAngle },
        uFlakes: { value: mat.holoFlakes ?? MATERIAL_DEFAULTS.holoFlakes },
        uFlakeSize: { value: mat.holoFlakeSize ?? MATERIAL_DEFAULTS.holoFlakeSize },
        uHueShift: { value: (mat.holoHueShift ?? MATERIAL_DEFAULTS.holoHueShift) / 360 },
      }
      // A foil IS metal: metalness is pinned at 1 and roughness comes from the Gloss dial, so
      // neither shared PBR row is offered (nothing is a dead control). The physical coat +
      // reflection knobs are shared with opal — a laminated sticker at clearcoat 1.
      const hmat = new THREE.MeshPhysicalMaterial({
        color: stripAlpha(mat.color), metalness: 1,
        roughness: holoRoughness(mat.holoGloss ?? MATERIAL_DEFAULTS.holoGloss),
      })
      hmat.clearcoat = mat.clearcoat ?? MATERIAL_DEFAULTS.clearcoat
      hmat.clearcoatRoughness = mat.clearcoatRoughness ?? MATERIAL_DEFAULTS.clearcoatRoughness
      hmat.envMapIntensity = mat.envMapIntensity ?? MATERIAL_DEFAULTS.envMapIntensity
      hmat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, holoUniforms)
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', HOLO_VERT_DECL)
          .replace('#include <worldpos_vertex>', HOLO_VERT_BODY)
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', HOLO_FRAG_DECL)
          .replace('#include <emissivemap_fragment>', HOLO_FRAG_BODY)
      }
      hmat.customProgramCacheKey = () => 'scene3d-holographic'
      hmat.userData.holoUniforms = holoUniforms
      hmat.userData.rampSig = rampSignature(stops)
      m = hmat
      break
    }
    // The uploaded-picture material. Its options live in four places, deliberately:
    //   • Texture properties (wrap, tiling, fit, offset, rotation, flip) — imageMap.ts,
    //     applied to the Texture THIS material owns (ownedImageTexture below). Free at
    //     draw time.
    //   • Material properties (tint, transparency, cutout, opacity, glow, flat) — here
    //     and in updateMaterial's `case 'image':`, via applyImageTransparency/
    //     applyImageGlow.
    //   • Uniforms (brightness, contrast, saturation, projection) — imageShader.ts's
    //     IMAGE_FRAGMENT_PARS (renamed from IMAGE_ADJUST_GLSL once it grew the whole
    //     projection library), injected unconditionally with identity defaults so no
    //     dial recompiles.
    //   • Pixels (seamless) — imageMap.ts's seamlessCanvas, run on decode AND repainted in
    //     place on a later Seamless change (`imageSetSeamless`, Important 3 of the final
    //     review — see its doc on `ownedImageTexture`'s onLoad).
    // Three things rebuild the material (see identityKey below): the file, `unlit`
    // (Basic vs Standard class), and 'box' projection (its own three-sample triplanar
    // program). Everything else updates in place, which is what keeps a slider drag from
    // stalling — `seamless` USED to be a fourth (a discrete-decision rebuild, so the
    // reasoning went), but it shipped as a continuous slider (and an animatable one), so a
    // drag/keyframe rebuilt the material — fresh TextureLoader fetch, decode, and five
    // canvases — on every tick. It now repaints its owned Texture's canvas in place instead,
    // like relief's `contrast` (the C1 fix) — see `imageSetSeamless`.
    // The glow (emissive) splice samples through the SAME projected coordinate as the
    // diffuse map — imageShader.ts's shared `sailorImageUv` helper and, under box
    // projection, the shared `sailorTriplanarSample` blend — so a box-projected glow
    // never drifts off the picture it is supposed to be lighting — getting that wrong
    // was a real bug worth remembering.
    case 'image': {
      // `unlit` picks the CLASS, exactly as it does for shaderFill: Basic shows the
      // picture's own pixels flat (a photo, a logo, a screenshot), Standard lets the
      // scene's lights shade it. MeshBasicMaterial has no roughness/metalness slot, so
      // neither is written on that branch — and applyRelief already skips a material
      // with no bumpMap slot, so the relief section degrades on its own.
      const tint = stripAlpha(mat.imageTint ?? MATERIAL_DEFAULTS.imageTint)
      // Both classes declare `map`, so this stays a real union rather than the
      // widened-then-cast `THREE.Material` a later PBR write could silently compile onto.
      const t: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial = mat.unlit === true
        ? new THREE.MeshBasicMaterial({ color: tint })
        : new THREE.MeshStandardMaterial({ color: tint, roughness: mat.roughness, metalness: mat.metalness })
      // The live spec, re-stamped by updateMaterial below and read by the loader's onLoad
      // (which fires long after this function returns). Same pattern shaderFill uses with
      // `userData.shaderSpec` for refreshSceneShaderFields.
      t.userData.imageSpec = mat
      const tex = ownedImageTexture(t, mat)
      if (tex) {
        t.map = tex
        // Natural size is unknown until the file decodes, so Fit is an identity transform
        // on this first pass; onLoad re-applies with the real dimensions.
        applyImageTransform(tex, mat, null)
      }
      t.userData.imageFilename = mat.image ?? ''
      // The width THIS build's onLoad will paint at (or already has, if the file was
      // cached and resolved synchronously-ish) — matches `reliefContrastApplied`'s stamp so
      // the FIRST updateMaterial call, if nothing actually changed, doesn't re-blend for
      // nothing (see the in-place block's `imageSeamlessApplied` guard below).
      t.userData.imageSeamlessApplied = seamlessWidth(mat)
      applyImageTransparency(t, mat)
      applyImageGlow(t, mat)
      // Colour adjustments + projection: always injected, identity/UV by default — see
      // imageShader.ts on why this is unconditional rather than gated on a non-neutral value.
      // Bounds come from the geometry passed in here at BUILD time, then kept fresh by
      // engine.ts's per-sync `refreshImageBounds` call — the same in-place treatment the
      // gradient material's uBoxMin/uBoxMax already get (Important 2 of the final review;
      // see refreshImageBounds's doc in imageShader.ts).
      const isBox = (mat.imageProjection ?? MATERIAL_DEFAULTS.imageProjection) === 'box'
      const iu = imageUniforms(mat, geometry)
      // syncImageMapMatrix must run here too: without it a projected picture ignores
      // Tiling/Offset/Rotation/Fit until the first updateMaterial call moves a dial.
      if (tex) syncImageMapMatrix(iu, tex)
      t.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, iu)
        shader.vertexShader = shader.vertexShader
          .replace('void main() {', `${IMAGE_PROJECT_VERTEX_GLSL}\nvoid main() {`)
          .replace('#include <begin_vertex>', IMAGE_PROJECT_VERTEX_CALL)
        // emissivemap_fragment replacement is a no-op on the unlit (Basic) variant's
        // fragment shader — it has no such include (see applyImageGlow's doc) — so this
        // splice is safe to run unconditionally on both variants.
        shader.fragmentShader = shader.fragmentShader
          .replace('void main() {', `${IMAGE_FRAGMENT_PARS}\nvoid main() {`)
          .replace('#include <map_fragment>', imageMapFragment(isBox))
          .replace('#include <emissivemap_fragment>', imageEmissiveMapFragment(isBox))
      }
      // Without this, three pools the compiled program with every OTHER material that has
      // the same feature defines — including materials with no injection at all. 'box' is a
      // separate PROGRAM (three texture samples instead of one), so it needs its own key —
      // the other four modes share a program and switch on a uniform (see identityKey).
      t.customProgramCacheKey = () => `scene3d-image:${isBox ? 'box' : 'single'}`
      t.userData.imageUniforms = iu
      m = t
      break
    }
    case 'shaderFill': {
      // Object anchor only (Scene3D's whole scope — see the field's doc on SceneMaterial.shader
      // in config.ts): `.map` samples through the mesh's own UV attribute exactly like `image`
      // above, so `spec.anchor` is never read here — a `frame`-anchored spec (frame anchor needs
      // onBeforeCompile screen-space injection, like `fresnel`'s rim above — a later task) just
      // renders as `object`, silently and correctly per the brief.
      const spec = mat.shader ?? DEFAULT_SHADER_SPEC
      const canvas = resolveField({ spec, w: SHADER_FIELD_PX, h: SHADER_FIELD_PX, t: 0, fps: 30 })
      // Item 7 fix (final review): a miss (catalog not loaded yet / WebGL hiccup) used to
      // leave `.map` NULL — every other host (Space Type/Shape Studio's shaderFieldTexture in
      // ~/lib/spacetype/fills.ts) already falls back to the rasterised INPUT fill's own pixels
      // on a miss, so Scene3D was the one place a shader-fill miss rendered a flat white mesh
      // instead of the same graceful gradient/pattern fallback every other surface shows. In a
      // real (DOM) environment `tex2` is now ALWAYS a real CanvasTexture — seeded with the
      // input tile on a miss, identical in spirit to fills.ts's own
      // `initial = canvas ?? paintTileBox(...)`. `hasDOM` keeps this module's own node-safety
      // contract (see its top-of-file doc — matcap/picker thumbnails degrade the same way):
      // `paintTileBox` needs `document.createElement('canvas')`, unavailable in the node-env
      // unit tests, so a miss in that environment still degrades to `.map = null` exactly as
      // before, rather than throwing. The healing path (`refreshSceneShaderFields`'s `else`
      // branch below) still repoints `.map` to a freshly-resolved field the moment one becomes
      // available, unchanged either way. `spec.input` is a Paint (string | Gradient | Fill);
      // paintTileBox handles the shader-typed-Fill unwrap internally (see its own doc).
      const initial = canvas ?? (hasDOM ? paintTileBox(spec.input, SHADER_FIELD_PX, SHADER_FIELD_PX) : null)
      const tex2 = initial ? new THREE.CanvasTexture(initial) : null
      if (tex2) { tex2.colorSpace = THREE.SRGBColorSpace; tex2.wrapS = tex2.wrapT = THREE.ClampToEdgeWrapping }
      const unlit = mat.unlit === true
      // Unlit uses Basic so the field glows flat (no scene-light shading, the point of the
      // toggle for a self-lit look); otherwise Standard so scene lights shade the field like
      // any other surface.
      const t: THREE.Material = unlit
        ? new THREE.MeshBasicMaterial({ color: '#ffffff', map: tex2 })
        : new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: mat.roughness, metalness: mat.metalness, map: tex2 })
      t.userData.shaderSpec = spec
      t.userData.shaderOwnerId = ownerId
      shaderFillMaterials.add(t)
      m = t
      break
    }
    case 'glass':
    case 'standard':
    default: {
      const p = new THREE.MeshPhysicalMaterial()
      applyPhysical(p, mat)
      m = p
      break
    }
  }
  m.userData.matType = mat.type
  m.userData.identity = identityKey(mat, finishes)
  applyRelief(m, mat, ownerId)
  applyTextureSet(m, mat, finishes)
  applyScreen(m, mat)
  // Cloner Vary: the merged clone geometry carries one colour per copy, and a SINGLE
  // material shows all of them through vertexColors plus a shader mix (applyVaryTint).
  // Last, so it chains on top of every injection above — including applyScreen's.
  if (hasVertexTint(mat, geometry)) applyVaryTint(m, varyStrength)
  // Finishes (S5): the topmost coat, chained after every other injection above (including
  // Vary) — a finish overlays the object's ALREADY-tinted/screened surface. `?? []` is the
  // byte-identical default: a caller with no opinion gets the pre-S5 material exactly.
  applyFinish(m, finishes ?? [])
  return m
}

/** The part of relief that forces a material REBUILD: which texture object is bound.
 *  `scale`, `tiling`, AND (as of the C1 fix) `contrast` all update IN PLACE — a slider drag
 *  must never rebuild per tick — so all three are deliberately EXCLUDED from this key.
 *  `contrast` used to be included here on the reasoning that it changes the height PIXELS at
 *  texture-build time, so the bound texture was "a different texture, not just a uniform on an
 *  existing one" — true, but `contrast` is a CONTINUOUS slider (StudioSlider fires on every
 *  `input` event during a drag), unlike `invert`'s discrete toggle, so that reasoning produced
 *  ~51 material rebuilds (and ~51 fresh canvases behind them) for one drag gesture (C1 of the
 *  final review). The fix keeps the SAME texture object across a contrast change and repaints
 *  its canvas in place instead (`getHeightTexture`/`buildHeightTextureFromSpec`'s
 *  `reliefSetContrast`, invoked from `updateMaterial`'s in-place block below).
 *  `invert` still rebuilds: it changes which pixels are drawn (light head-to-tail) just like
 *  `contrast` does, but it's a one-shot toggle/click, not a drag, so the occasional rebuild is
 *  harmless and it avoids adding a second live-mutable knob to the paint closure. */
function reliefKey(mat: SceneMaterial): string {
  const r = mat.relief
  const relief = !r || r.source === 'none'
    ? '-'
    : r.source === 'image'
      ? `i:${r.image ?? ''}:${r.invert ? 1 : 0}`
      : `s:${r.spec ? JSON.stringify(r.spec) : ''}:${r.invert ? 1 : 0}`
  return `|${relief}|n:${mat.normalImage ?? ''}|t:${mat.texture ?? ''}`
}

/** The two screen boundaries that need a rebuild: off↔on (the injection exists or not) and the
 *  gap mode (it flips `transparent`, which moves the material between render lists). Every
 *  other screen dial is a uniform written in place by updateMaterial. */
function screenKey(mat: SceneMaterial): string {
  if (mat.type === 'glass') return '|scr:-'
  const s = screenOf(mat)
  return s.pattern === 'none' ? '|scr:-' : `|scr:${s.gap === 'transparent' ? 't' : 'c'}`
}

/** Params that require a rebuild when they change (texture/ramp identity). `finishes` folds in
 *  the ordered finish-kind list (finishKey) — an added/removed/reordered finish is a program
 *  boundary (a different shader body entirely), while a finish's own DIALS update in place via
 *  `updateFinishUniforms`, exactly like the screen dials above. */
function identityKey(mat: SceneMaterial, finishes?: FinishTreatment[]): string {
  return baseIdentityKey(mat) + reliefKey(mat) + screenKey(mat) + finishKey(finishes ?? [])
}

function baseIdentityKey(mat: SceneMaterial): string {
  switch (mat.type) {
    case 'toon': return `toon:${mat.toonSteps ?? MATERIAL_DEFAULTS.toonSteps}`
    case 'matcap': return `matcap:${mat.matcap ?? MATERIAL_DEFAULTS.matcap}`
    // `unlit` picks the CLASS, and 'box' picks the PROGRAM (three texture samples rather
    // than one) — both need a rebuild. Every other image option is a uniform or a Texture
    // property and updates in place.
    case 'image': {
      const box = (mat.imageProjection ?? MATERIAL_DEFAULTS.imageProjection) === 'box' ? 1 : 0
      // Seamless does NOT belong here (Important 3, final review): it USED to be folded in
      // on the reasoning that it changes the PIXELS, not a uniform, and is "a discrete
      // decision the user makes once" — but it shipped as a continuous 0–0.45 slider (and
      // an animatable one), so that reasoning produced ~45 full material rebuilds — a fresh
      // TextureLoader fetch + decode + five canvases each — for one drag gesture. The fix
      // keeps the SAME owned Texture across a Seamless change and repaints its canvas in
      // place instead, the same C1-fix shape relief.contrast already uses (see
      // `imageSetSeamless` on `ownedImageTexture`'s onLoad, and the in-place block in
      // `updateMaterial` below).
      return `image:${mat.image ?? ''}:${mat.unlit === true ? 1 : 0}:${box}`
    }
    // `unlit` picks the THREE material CLASS (Basic vs Standard) — that boundary needs a
    // rebuild; the effect/params/speed/input inside `shader` are refreshed in place every
    // frame by refreshSceneShaderFields, never through this identity (see updateMaterial).
    case 'shaderFill': return `shaderFill:${mat.unlit === true ? 1 : 0}`
    // Program variant boundary: smooth vs facet (faceted/prismatic share the
    // facet program and switch via the uMode uniform in place).
    case 'gradient':
      return `gradient:${(mat.gradientShading ?? MATERIAL_DEFAULTS.gradientShading) === 'smooth' ? 'smooth' : 'facet'}`
    default: return mat.type
  }
}

export function updateMaterial(
  m: THREE.Material,
  mat: SceneMaterial,
  geometry?: THREE.BufferGeometry,
  varyStrength?: number,
  finishes?: FinishTreatment[],
): boolean {
  const fin = finishes ?? []
  if (m.userData.matType !== mat.type || m.userData.identity !== identityKey(mat, fin)) return false
  // Vertex-colour state is a property of the GEOMETRY, not of `mat`, so it
  // cannot ride in identityKey. Crossing this boundary needs a rebuild: three
  // bakes vertexColors into the compiled program. Callers that pass no geometry
  // (unit tests, and any path with no mesh in hand) keep the old behaviour.
  if (geometry && (m.userData.vertexTint === true) !== hasVertexTint(mat, geometry)) return false
  // Finish dials update IN PLACE, like the screen/vary uniforms below — a slider drag must
  // never rebuild. `updateFinishUniforms` returns false only on a mismatch identityKey's
  // finishKey (above) should already have caught (kind list/order); kept as its own guard
  // for a boundary identityKey does not fold in yet (a matcap id change, Task 3).
  if (!updateFinishUniforms(m, fin)) return false
  // Vary colour STRENGTH is a uniform, not a program boundary — write it in place, like
  // the screen dials below, so dragging the Colour strength slider never rebuilds. Only
  // the tint on/off crossing (the guard above) forces a rebuild. Gated on the parameter
  // being SUPPLIED (not on `geometry`): a caller that passes no strength has no opinion
  // about it, and must leave whatever the material already holds alone rather than
  // silently resetting the uniform to the default 1.
  const vu = m.userData.varyUniforms as Record<string, { value: unknown }> | undefined
  if (vu && varyStrength !== undefined) vu.uVaryStrength!.value = varyStrengthOf(varyStrength)
  // Screen dials update in place (the identity guard above already forced a rebuild for the
  // two boundaries that need one).
  const su = m.userData.screenUniforms as Record<string, { value: unknown }> | undefined
  if (su) writeScreenUniforms(su, screenOf(mat))
  // Relief SCALE, TILING, and (C1 fix) CONTRAST are the in-place updates here — a slider drag
  // must not rebuild per tick. `invert` never reaches this block: identityKey includes it, so
  // a change fails the identity guard above and forces a rebuild instead.
  const rt = m as THREE.MeshStandardMaterial
  if ('bumpScale' in rt && mat.relief && mat.relief.source !== 'none') {
    rt.bumpScale = mat.relief.scale ?? MATERIAL_DEFAULTS.reliefScale
    if (rt.bumpMap) {
      const t = mat.relief.tiling ?? MATERIAL_DEFAULTS.reliefTiling
      rt.bumpMap.repeat.set(t, t)
      // C1 fix: repaint the bumpMap's OWN canvas from its already-cached source instead of
      // rebuilding — only when contrast actually moved since the last paint (construction or
      // the previous repaint both stamp `reliefContrastApplied`), so an unrelated edit (e.g.
      // Depth/Tiling alone) never re-triggers a canvas repaint it doesn't need.
      const c = mat.relief.contrast ?? MATERIAL_DEFAULTS.reliefContrast
      if (m.userData.reliefContrastApplied !== c) {
        m.userData.reliefContrastApplied = c
        ;(rt.bumpMap.userData.reliefSetContrast as ((c: number) => void) | undefined)?.(c)
      }
    }
  }
  // Texture-set tiling updates in place, like relief tiling — a slider drag must not rebuild.
  if (m.userData.textureId) {
    const tt = mat.textureTiling ?? MATERIAL_DEFAULTS.textureTiling
    if (m.userData.textureTiling !== tt) {
      m.userData.textureTiling = tt
      const t = m as THREE.MeshPhysicalMaterial
      // Only the slots THIS set bound — an explicit relief's bumpMap is not ours to retile.
      const slotOf: Record<string, THREE.Texture | null> = {
        color: t.map, roughness: t.roughnessMap, metalness: t.metalnessMap,
        normal: t.normalMap, ao: t.aoMap, displacement: t.bumpMap,
      }
      for (const k of (m.userData.textureMaps as string[] | undefined) ?? []) slotOf[k]?.repeat.set(tt, tt)
    }
  }
  switch (mat.type) {
    case 'standard':
    case 'glass': {
      const p = m as THREE.MeshPhysicalMaterial
      const wasTransparent = p.transparent
      applyPhysical(p, mat)
      // Recompile only on define-boundary crossings. three's MeshPhysicalMaterial
      // setters self-recompile when a feature define toggles across zero
      // (transmission/clearcoat/sheen/iridescence/dispersion), so we must NOT
      // re-bump those. The one define-affecting property three does NOT manage is
      // `transparent` (a base Material field, toggled here by opacity < 1), which
      // swaps the render list — bump it ourselves. Plain slider movement within an
      // enabled range never recompiles (per-tick jank).
      if (p.transparent !== wasTransparent) p.needsUpdate = true
      // NB: `side` (set in applyPhysical) flips DoubleSide↔FrontSide exactly as
      // transmission crosses zero — the same crossing at which three's transmission
      // setter self-recompiles — so that recompile already picks up the new side
      // define. No extra needsUpdate bump here, or the crossing would recompile twice.
      return true
    }
    case 'toon': {
      (m as THREE.MeshToonMaterial).color.set(stripAlpha(mat.color))
      return true
    }
    case 'phong': {
      const ph = m as THREE.MeshPhongMaterial
      ph.color.set(stripAlpha(mat.color))
      ph.shininess = mat.shininess ?? MATERIAL_DEFAULTS.shininess
      ph.specular.set(stripAlpha(mat.specular ?? MATERIAL_DEFAULTS.specular))
      ph.emissive.set(stripAlpha(mat.emissive ?? MATERIAL_DEFAULTS.emissive))
      ph.emissiveIntensity = mat.emissiveIntensity ?? MATERIAL_DEFAULTS.emissiveIntensity
      return true
    }
    case 'matcap':
      return true // nothing tweakable in place; id changes rebuild via identity
    case 'fresnel': {
      // Lit fresnel: base colour on the material, rim/power in injected uniforms.
      const f = m as THREE.MeshStandardMaterial
      f.color.set(stripAlpha(mat.color)); f.roughness = mat.roughness; f.metalness = mat.metalness
      const u = m.userData.fresnelUniforms as { uRim: { value: THREE.Color }; uPower: { value: number } }
      u.uRim.value.set(stripAlpha(mat.fresnelColor ?? MATERIAL_DEFAULTS.fresnelColor))
      u.uPower.value = mat.fresnelPower ?? MATERIAL_DEFAULTS.fresnelPower
      return true
    }
    case 'gradient': {
      // Lit gradient: the ramp lives in injected uniforms (userData.gradUniforms),
      // shared by reference with the compiled program — mutate and done.
      // (identityKey already forced a rebuild if the smooth↔facet program
      // boundary was crossed, so uMode only exists when it's mutable.)
      const u = m.userData.gradUniforms as {
        uRamp: { value: THREE.DataTexture }
        uDir: { value: THREE.Vector3 }
        uType: { value: number }; uOffset: { value: number }; uSpread: { value: number }
        uMode?: { value: number }
      }
      // The LUT is the only expensive part — rebuild it only when the stops
      // actually moved, and dispose the texture we're replacing.
      const sig = rampSignature(rampStopsOf(mat))
      if (sig !== m.userData.rampSig) {
        u.uRamp.value?.dispose()
        u.uRamp.value = buildRampTexture(rampStopsOf(mat))
        m.userData.rampSig = sig
      }
      const { yaw, pitch } = gradientAngles(mat)
      u.uDir.value.set(...gradientDirection(yaw, pitch))
      u.uType.value = (mat.gradientType ?? MATERIAL_DEFAULTS.gradientType) === 'radial' ? 1 : 0
      u.uOffset.value = mat.gradientOffset ?? MATERIAL_DEFAULTS.gradientOffset
      u.uSpread.value = mat.gradientSpread ?? MATERIAL_DEFAULTS.gradientSpread
      if (u.uMode) u.uMode.value = facetUMode(mat.gradientShading ?? MATERIAL_DEFAULTS.gradientShading)
      return true
    }
    case 'opalescent': {
      // The spectrum LUT + steering scalars all live in injected uniforms shared by reference
      // with the compiled program — mutate in place. Colour/roughness/metalness + the physical
      // coat/reflection are real MeshPhysicalMaterial fields (the lit substrate). uOpalTime is
      // written per-frame by refreshOpalTime, never here.
      const o = m as THREE.MeshPhysicalMaterial
      o.color.set(stripAlpha(mat.color)); o.roughness = mat.roughness; o.metalness = mat.metalness
      // clearcoat crossing zero toggles three's USE_CLEARCOAT define → three self-recompiles,
      // which re-runs our onBeforeCompile against the SAME opalUniforms objects (held outside the
      // closure) and re-injects — so the rainbow survives the coat turning on/off. No manual
      // needsUpdate bump (that would double-recompile at the crossing).
      o.clearcoat = mat.clearcoat ?? MATERIAL_DEFAULTS.clearcoat
      o.clearcoatRoughness = mat.clearcoatRoughness ?? MATERIAL_DEFAULTS.clearcoatRoughness
      o.envMapIntensity = mat.envMapIntensity ?? MATERIAL_DEFAULTS.envMapIntensity
      const u = m.userData.opalUniforms as {
        uRamp: { value: THREE.DataTexture }
        uHueShift: { value: number }; uFrequency: { value: number }; uAngleMix: { value: number }
        uStrength: { value: number }; uFlow: { value: number }
      }
      // Rebuild the LUT only when the stops actually moved, disposing the one we replace.
      const sig = rampSignature(opalStopsOf(mat))
      if (sig !== m.userData.rampSig) {
        u.uRamp.value?.dispose()
        u.uRamp.value = buildRampTexture(opalStopsOf(mat))
        m.userData.rampSig = sig
      }
      u.uHueShift.value = (mat.opalHueShift ?? MATERIAL_DEFAULTS.opalHueShift) / 360
      u.uFrequency.value = mat.opalFrequency ?? MATERIAL_DEFAULTS.opalFrequency
      u.uAngleMix.value = mat.opalAngleMix ?? MATERIAL_DEFAULTS.opalAngleMix
      u.uStrength.value = mat.opalStrength ?? MATERIAL_DEFAULTS.opalStrength
      u.uFlow.value = mat.opalFlowSpeed ?? MATERIAL_DEFAULTS.opalFlowSpeed
      return true
    }
    case 'holographic': {
      // Same shape as opal: the LUT + steering scalars are injected uniforms shared by
      // reference with the compiled program, mutated in place; tint/gloss/coat/reflection are
      // real MeshPhysicalMaterial fields. metalness stays pinned at 1. A clearcoat zero
      // crossing self-recompiles through three (USE_CLEARCOAT) against the SAME holoUniforms
      // objects, so the foil survives the coat toggling — no manual needsUpdate.
      const hmat = m as THREE.MeshPhysicalMaterial
      hmat.color.set(stripAlpha(mat.color))
      hmat.metalness = 1
      hmat.roughness = holoRoughness(mat.holoGloss ?? MATERIAL_DEFAULTS.holoGloss)
      hmat.clearcoat = mat.clearcoat ?? MATERIAL_DEFAULTS.clearcoat
      hmat.clearcoatRoughness = mat.clearcoatRoughness ?? MATERIAL_DEFAULTS.clearcoatRoughness
      hmat.envMapIntensity = mat.envMapIntensity ?? MATERIAL_DEFAULTS.envMapIntensity
      const u = m.userData.holoUniforms as {
        uRamp: { value: THREE.DataTexture }
        uStrength: { value: number }; uBands: { value: number }; uAngle: { value: number }
        uFlakes: { value: number }; uFlakeSize: { value: number }; uHueShift: { value: number }
      }
      // Rebuild the LUT only when the stops actually moved, disposing the one we replace.
      const sig = rampSignature(opalStopsOf(mat))
      if (sig !== m.userData.rampSig) {
        u.uRamp.value?.dispose()
        u.uRamp.value = buildRampTexture(opalStopsOf(mat))
        m.userData.rampSig = sig
      }
      u.uStrength.value = mat.holoStrength ?? MATERIAL_DEFAULTS.holoStrength
      u.uBands.value = mat.holoBands ?? MATERIAL_DEFAULTS.holoBands
      u.uAngle.value = mat.holoAngle ?? MATERIAL_DEFAULTS.holoAngle
      u.uFlakes.value = mat.holoFlakes ?? MATERIAL_DEFAULTS.holoFlakes
      u.uFlakeSize.value = mat.holoFlakeSize ?? MATERIAL_DEFAULTS.holoFlakeSize
      u.uHueShift.value = (mat.holoHueShift ?? MATERIAL_DEFAULTS.holoHueShift) / 360
      return true
    }
    case 'image': {
      const s = m as THREE.MeshStandardMaterial
      s.color.set(stripAlpha(mat.imageTint ?? MATERIAL_DEFAULTS.imageTint))
      // roughness/metalness exist only on the Standard (lit) variant. The identity guard
      // above already rebuilt if `unlit` moved, so this branch is guaranteed to still be
      // holding the class it was built as.
      if (mat.unlit !== true) { s.roughness = mat.roughness; s.metalness = mat.metalness }
      // Re-stamp before touching the map: the async onLoad reads this, and a file still in
      // flight must settle onto the CURRENT dials, not the ones it was built with.
      m.userData.imageSpec = mat
      if (s.map) applyImageTransform(s.map, mat, m.userData.imageNatural as NaturalSize | undefined)
      // Seamless (Important 3, final review): repaint the OWNED texture's canvas in place —
      // the same C1-fix shape as relief.contrast's `reliefContrastApplied` guard just above
      // in this file — only when the dial has actually moved since the last paint, so an
      // unrelated edit (Tint, Brightness, Tiling…) never re-blends for nothing. Tracked on
      // `m.userData` (not gated on `s.map`) so this stays correct even while the file is
      // still in flight — see `imageSetSeamless`'s own no-op guard for that case.
      const seamW = seamlessWidth(mat)
      if (m.userData.imageSeamlessApplied !== seamW) {
        m.userData.imageSeamlessApplied = seamW
        ;(s.map?.userData.imageSetSeamless as ((w: number) => void) | undefined)?.(seamW)
      }
      applyImageTransparency(m, mat)
      applyImageGlow(m, mat)
      const iu = m.userData.imageUniforms as ImageUniforms | undefined
      if (iu) {
        writeImageUniforms(iu, mat)
        // The UV matrix is what carries tiling/offset/rotation/fit into a projected
        // sample — without this, those dials would silently stop applying under any
        // projection but 'uv' the moment this update path (rather than the build path)
        // is the one moving them.
        syncImageMapMatrix(iu, s.map)
      }
      return true
    }
    case 'shaderFill': {
      // Re-stamp the live spec so the NEXT refreshSceneShaderFields call (the surface's
      // per-frame loop) picks up an effect/param/speed/input edit without a material rebuild —
      // the identity boundary above is `unlit` only, so we're guaranteed still holding the
      // right THREE class here. roughness/metalness only exist on the Standard (lit) variant.
      m.userData.shaderSpec = mat.shader ?? DEFAULT_SHADER_SPEC
      if (mat.unlit !== true) {
        const s = m as THREE.MeshStandardMaterial
        s.roughness = mat.roughness; s.metalness = mat.metalness
      }
      return true
    }
  }
  return false
}

export function disposeMaterial(m: THREE.Material): void {
  // Dispose textures the material exclusively owns. Matcaps are shared
  // module-lifetime singletons — skip them.
  if ((m as THREE.MeshToonMaterial).isMaterial && (m as any).gradientMap) (m as any).gradientMap.dispose()
  if (m.userData.matType === 'shaderFill') shaderFillMaterials.delete(m)
  if (m.userData.matType === 'opalescent') opalMaterials.delete(m as THREE.MeshStandardMaterial)
  reliefHealPending.delete(m) // a disposed material still awaiting its relief heal must not leak
  m.userData.disposed = true // ...and an in-flight applyTextureSet must not bind onto it (see its .then)
  // The gradient ramp LUT is owned by exactly one material — as are the opal and holographic
  // ramps (each its own uniform bucket), so dispose whichever this material carries.
  const ramp = (m.userData.gradUniforms as { uRamp?: { value?: THREE.Texture } } | undefined)?.uRamp?.value
    ?? (m.userData.opalUniforms as { uRamp?: { value?: THREE.Texture } } | undefined)?.uRamp?.value
    ?? (m.userData.holoUniforms as { uRamp?: { value?: THREE.Texture } } | undefined)?.uRamp?.value
  if (ramp) ramp.dispose()
  // Bump/height texture: EXCLUSIVELY owned by this material — every relief texture (image OR
  // shader) is a private per-material canvas + Texture (see the C1/C2 redesign doc at the top
  // of the relief section), so it is always safe to dispose here directly. The image-relief
  // case additionally unregisters its (possibly still-pending) repaint callback from the
  // shared per-filename `reliefSourceCache` via `reliefUnsub` — otherwise a material disposed
  // before its source image finishes loading would leave that closure (and the canvas/Texture
  // it references) stuck in the cache entry's `subs` Set forever.
  const bumpMap = (m as THREE.MeshStandardMaterial).bumpMap
  if (bumpMap) {
    (bumpMap.userData.reliefUnsub as (() => void) | undefined)?.()
    bumpMap.dispose()
  }
  const map = (m as THREE.MeshStandardMaterial).map
  if (map) map.dispose()
  // ambientCG texture set: bindTextureMaps builds a Texture PER MATERIAL for every slot it
  // binds (see its doc), so the slots THIS set bound are exclusively ours to free. `map` and
  // `bumpMap` are already disposed above; the other four would otherwise leak a full-size GPU
  // texture on every rebuild. Gated on `textureMaps` rather than on the slots being non-null:
  // a `normalMap` the set did NOT bind is the user's own, and comes from the SHARED imageCache.
  const setMaps = (m.userData.textureMaps as string[] | undefined) ?? []
  if (setMaps.length) {
    const ts = m as THREE.MeshPhysicalMaterial
    if (setMaps.includes('roughness')) ts.roughnessMap?.dispose()
    if (setMaps.includes('metalness')) ts.metalnessMap?.dispose()
    if (setMaps.includes('normal')) ts.normalMap?.dispose()
    if (setMaps.includes('ao')) ts.aoMap?.dispose()
  }
  m.dispose()
}

/** Write wall-clock seconds into every live opalescent material's `uOpalTime` uniform so its
 *  spectrum drifts. Call once per host frame, BEFORE `engine.render()`, and only when the doc
 *  actually has a flowing opal (see `sceneHasOpalFlow`) — with `uFlow` 0 the term is multiplied
 *  out, so a still opal costs nothing and the gate keeps ordinary scenes off this path. */
export function refreshOpalTime(elapsedSec: number): void {
  opalMaterials.forEach((mm) => {
    const u = mm.userData.opalUniforms as { uOpalTime?: { value: number } } | undefined
    if (u?.uOpalTime) u.uOpalTime.value = elapsedSec
  })
}

/** Advance every shaderFill material OWNED BY `ownerId` (one Scene3D engine instance) to time
 *  `t` seconds, reusing each material's SAME `THREE.CanvasTexture` — set `.image`/`needsUpdate`
 *  in place, never allocate a new CanvasTexture per frame, per resolveField's ownership
 *  contract (~/lib/shaderfill/field.ts). Call once per host frame, BEFORE `engine.render()`,
 *  and only when the current doc actually has a shaderFill material (see `sceneHasShaderFill`
 *  in config.ts) — an owner with no shaderFill materials is a cheap no-op below regardless, this
 *  is so an ordinary scene's frame loop never starts paying new per-frame cost it never paid.
 *
 *  Mirrors `refreshLiveShaderFills` in ~/lib/spacetype/fills.ts (same beginFieldFrame/
 *  resolveField pairing, same "per-owner ceiling" shape) but is a SEPARATE cache/scope —
 *  `beginFieldFrame` is called here with ONLY this owner's requests, so its LIVE_FIELD_CEILING
 *  and the frozen count it returns apply per Scene3D engine, never pooled with (or walkable by)
 *  Space Type's or the Compositor's fields, which live entirely in that other module.
 *
 *  Returns the frozen-field count so the surface can show a hint when a field is capped at a
 *  still frame instead of animating — no silent caps, same rule as every other surface.
 *
 *  `bake`/`w`/`h` (Important 5 of the final review): a still export (renderPasses) wants the
 *  ACTUAL output resolution, unclamped — before this, every caller left `bake` at its default
 *  `false` and `w`/`h` at the fixed `SHADER_FIELD_PX` (== resolveField's own LIVE_FIELD_PX
 *  clamp), so passing `bake: true` here was inert: `fieldSize()` in field.ts only skips its
 *  clamp when `bake` is true AND w/h differ from the clamp size, and they never did. `w`/`h`
 *  default to `SHADER_FIELD_PX` so every existing (live-preview) call site is unaffected.
 *
 *  Task 5 fix: also runs `healReliefMaterials(ownerId)` FIRST, unconditionally — a relief-only
 *  scene (no shaderFill material anywhere) has an empty `entries` below and returns early, so
 *  the relief heal has to happen before that early return or a relief-only doc would never get
 *  healed at all. This is why `sceneHasShaderFill` (config.ts) was widened to also gate on a
 *  shader relief: without that, this function is never even called for a relief-only scene. */
export function refreshSceneShaderFields(
  ownerId: string, t: number, fps: number, bake = false, w = SHADER_FIELD_PX, h = SHADER_FIELD_PX,
): { frozenCount: number } {
  healReliefMaterials(ownerId)

  const entries: THREE.Material[] = []
  for (const m of shaderFillMaterials) if (m.userData.shaderOwnerId === ownerId) entries.push(m)
  if (entries.length === 0) return { frozenCount: 0 }
  const requests: FieldRequest[] = entries.map((m) => ({
    spec: m.userData.shaderSpec as ShaderSpec, w, h, t, fps, bake,
  }))
  // withFieldFrame owns the begin/end pairing in a try/finally (see its doc in
  // ~/lib/shaderfill/field.ts) — a throw anywhere in the loop below can no longer leave
  // the module-global field-frame span stuck open.
  return withFieldFrame(requests, (frozenCount, token) => {
    for (let i = 0; i < entries.length; i++) {
      const canvas = resolveField(requests[i]!, token)
      if (!canvas) continue                          // keep showing the last good frame
      const mat = entries[i] as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial
      const tex = mat.map as THREE.CanvasTexture | null
      if (tex) {
        // CRITICAL 2 fix: the common case — a texture already exists (materialFor built it
        // successfully), just repoint it at the newest canvas in place, per resolveField's
        // ownership contract (bind directly, never copy).
        if (tex.image !== canvas) { tex.image = canvas; tex.needsUpdate = true }
      } else {
        // Defensive only, should not fire in practice since Item 7 (final review):
        // `materialFor`'s `tex2` is now ALWAYS a real CanvasTexture (seeded with the input
        // fill's own pixels on a miss, never null) — `.map` should never actually be null for
        // a `shaderFill` material anymore. Originally this healed a material-creation-time
        // race where `tex2 = canvas ? new THREE.CanvasTexture(canvas) : null` really did leave
        // `.map` null FOREVER (this branch used to be `if (tex && ...)` and silently no-op on
        // a null map); kept as a safety net rather than assuming that invariant always holds.
        const newTex = new THREE.CanvasTexture(canvas)
        newTex.colorSpace = THREE.SRGBColorSpace
        newTex.wrapS = newTex.wrapT = THREE.ClampToEdgeWrapping
        mat.map = newTex
        mat.needsUpdate = true
      }
    }
    return { frozenCount }
  })
}
