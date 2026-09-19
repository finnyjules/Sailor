// The per-layer effect stack: kinds, canonical order, and the one read-through that
// turns ANY layer — old shape or new — into an ordered list of id-stamped instances.
//
// Why read-through rather than migrate-on-load: stored layers are read with a raw cast
// and no sanitize step (useLocalLayerEditor.ts's `localLayers` computed, plus five other
// raw read sites), so a migration would have to write to every frame just by opening it,
// and any read site that skipped it would render a layer differently from the others.
// `effectStackOf` gives every consumer the same answer with no writes at all; the move to
// the stored new shape happens only when the user actually edits a layer's effects
// (`writeStackToLayer`).
//
// Pure: no Vue, no canvas, no `document`. The four layer-local effect interfaces live here
// rather than in useCompositorLayers.ts (which is a composable) so this module can own the
// whole vocabulary without an import cycle; that file re-exports them, so every existing
// consumer is unaffected.
import { DEFAULT_TORN_EDGE, tornEdgeActive, type TornEdgeSpec } from './tornEdge'
import { DEFAULT_FEATHER, featherActive, type FeatherSpec } from './feather'
import { POST_EFFECT_DEFAULTS, type PostEffect } from './postEffects'
import type { ParamValue } from '~/lib/shaderfx/types'

// ── the four layer-local effects (moved verbatim from useCompositorLayers.ts) ──────────
// All distances normalized to canvas width, like every other dimension in the Compositor,
// so they survive resize/export unchanged.
export interface DropShadowEffect {
  type: 'drop_shadow'
  color: string   // rgba/hex (alpha allowed)
  x: number       // offset X, normalized to canvas width
  y: number       // offset Y, normalized to canvas width
  blur: number    // blur radius, normalized to canvas width
  visible: boolean
}
export interface LayerBlurEffect {
  type: 'layer_blur'
  radius: number  // blur radius, normalized to canvas width
  visible: boolean
}
/** Shadow cast inward from the layer's silhouette edge (Figma inner shadow). */
export interface InnerShadowEffect {
  type: 'inner_shadow'
  color: string
  x: number
  y: number
  blur: number
  visible: boolean
}
/** Blur what's BEHIND the layer, within its silhouette (Figma background blur). */
export interface BackgroundBlurEffect {
  type: 'background_blur'
  radius: number
  visible: boolean
}
/** F6: runs an input-sampling Shader Studio catalog effect over the layers BEHIND this
 *  layer, ADDITIVELY — the layer's own content still paints on top — clipped to its
 *  silhouette via `withBackdrop` (the same scaffolding `BackgroundBlurEffect` uses).
 *  Reachable from ANY layer including text, unlike the glass lens (`.fill`-only, which
 *  REPLACES the fill and is gated off text). Same field shape as `ShaderPixelEffect`
 *  (effectId/params/speed/seed) so the F5 picker (`shaderSpecFromEffect`,
 *  `derivedShaderFillControls`) works unchanged over either kind — this one samples the
 *  backdrop snapshot instead of the layer's own already-rendered pixels. */
export interface BackdropShaderEffect {
  type: 'backdrop_shader'
  visible: boolean
  effectId: string
  /** Keyed WITHOUT the `u_` prefix, same convention as `ShaderSpec.params`. */
  params: Record<string, ParamValue>
  speed: number
  /** varies the generative parts of the picked effect; 42 is the historical default. */
  seed: number
}
/** F6: masks/reveals the layer's OWN content by the LUMINANCE of the backdrop behind it.
 *  Unlike backdrop_shader (additive under the layer), this modulates the layer's own painted
 *  alpha: content shows where the backdrop is bright (lum ≥ threshold) by default; `invert`
 *  flips it. Pinned backdrop kind — it samples the backdrop, at most one per layer. */
export interface BackdropLuminanceMaskEffect {
  type: 'backdrop_luminance_mask'
  visible: boolean
  threshold: number
  softness: number
  invert: boolean
}
/** Torn edge and feather were fields on the layer (`layer.tornEdge`, `layer.feather`),
 *  which is exactly what pinned them to one position in the pipeline. As effects they
 *  carry the same spec fields and become orderable like everything else. */
export interface TornEdgeEffect extends TornEdgeSpec { type: 'torn_edge'; visible: boolean }
export interface FeatherEffect extends FeatherSpec { type: 'feather'; visible: boolean }

// ── the four geometry effects (F2): transform a vector layer's outline BEFORE it
// rasterises. Dial fields here are the minimal defaults `createEffect` needs; the full
// per-kind controls (join behaviour, fillet math, noise shaping) land in Tasks 3/4.
export interface TrimEffect { type: 'trim'; start: number; end: number; offset: number; visible: boolean }
export interface OffsetEffect { type: 'offset'; distance: number; visible: boolean }
export interface RoundCornersEffect { type: 'round_corners'; radius: number; visible: boolean }
export interface RoughenEffect { type: 'roughen'; amount: number; detail: number; seed: number; visible: boolean }

/** The four paper.js boolean ops the F3 `boolean` effect exposes. Defined here — the effect
 *  stack owns the whole effect vocabulary — and re-used by `booleanGeometry.ts` (the paper
 *  bridge) via a type-only import, so the two never drift. */
export type BooleanOp = 'unite' | 'subtract' | 'intersect' | 'exclude'
/** Combine this vector layer's outline with a SIBLING layer's outline (via the F3 sibling
 *  rail, `refLayerId`) using a paper.js boolean op. `refLayerId` is a `StackKey` (`l:<id>`)
 *  mirroring `maskedByKey`; a missing/dangling/self/non-vector ref makes the effect a no-op. */
export interface BooleanEffect { type: 'boolean'; op: BooleanOp; refLayerId?: string; visible: boolean }
/** Blend this vector layer's outline TOWARD a SIBLING layer's outline (via the same F3 sibling
 *  rail, `refLayerId`) by `amount` — 0 keeps the layer's own shape, 1 becomes the sibling's
 *  shape (in this layer's frame). The blend maths live in `app/lib/vector/morph.ts` (pure,
 *  synchronous — no paper.js). A missing/dangling/self/non-vector ref, or `amount ≈ 0`, makes
 *  the effect a no-op. */
export interface MorphEffect { type: 'morph'; amount: number; refLayerId?: string; visible: boolean }
/** Displace this vector layer's outline through one of four mesh-warp FIELDS (F3), relative
 *  to the layer's own bounding box: `bulge`/`pinch` push the outline out/in radially, `wave`
 *  shears it sinusoidally, `twist` rotates it about the centre. SELF-ONLY — no sibling rail.
 *  The field maths live in `app/lib/compositor/meshWarp.ts` (pure). `amount ≈ 0` is a no-op.
 *  `frequency` is read only by the `wave` field. */
export interface WarpEffect { type: 'warp'; field: 'bulge' | 'pinch' | 'wave' | 'twist'; amount: number; frequency: number; visible: boolean }
/** A SOLID directional shadow BODY swept from this vector layer's outline along `angle`
 *  (degrees) for `length` (a fraction of canvas width, ×W to px), filled in `color` BENEATH
 *  the shape's own fill + stroke (F3). SELF-ONLY — no sibling rail. Architecturally unlike the
 *  other geometry kinds: it is not a `d → d` outline transform but a SECOND coloured fill, so
 *  `applyGeometry` no-ops it (it reads the final outline the other kinds built) and the body is
 *  painted directly in `drawLayerContent`. The body maths live in `geometryEffects.longShadowBody`
 *  (pure). `length ≈ 0` paints nothing. */
export interface LongShadowEffect { type: 'long_shadow'; angle: number; length: number; color: string; visible: boolean }
/** Fragment this vector layer's outline into Voronoi cells with a `gap` between them (F3), so
 *  the shape reads as shattered tiles filled with its OWN paint. Unlike long shadow this IS a
 *  `d → d` outline transform: `applyGeometry` returns a compound `d` of the gapped, clipped
 *  cells. `cells` sets the fragment count, `gap` the inward shrink per cell (a fraction of
 *  canvas width, ×W to px), `seed` the deterministic scatter. SELF-ONLY — no sibling rail.
 *  The cell maths live in `app/lib/compositor/voronoi.ts` (pure); the clip-to-outline reuses
 *  the warmed paper.js scope in `booleanGeometry.ts`. `cells ≤ 0` or a cold/empty result is a
 *  pass-through (the shape unchanged). */
export interface ShatterEffect { type: 'shatter'; cells: number; gap: number; seed: number; visible: boolean }

// ── F5: the shader-catalog-as-a-pass pixel effect ──────────────────────────────────────
/** Runs an input-sampling Shader Studio catalog effect over this layer's OWN already-
 *  rendered pixels — a GPU pass, reorderable alongside the other pixel effects (`regionOf`
 *  falls through to `'pixel'` for it, same as every other non-backdrop/geometry/stamp kind).
 *  A deliberate SUBSET of `ShaderSpec` (~/lib/spacetype/fillTile.ts) minus the fill-only
 *  fields — `anchor`, `input`, `readsBackdrop`, `readsLayerKey` — none of which apply to a
 *  pass over the layer's own content (there is no separate `input` Paint to anchor or read
 *  a backdrop/sibling through: the layer's own rendered pixels ARE the input). Task 1 is the
 *  model only — no render, no UI; see the F5 plan for the GPU pass (Task 2) and picker
 *  (Task 3). `params` uses the SAME `ParamValue` vocabulary as the shader fill so the picked
 *  effect's dials (`derivedShaderFillControls`) work unchanged over either shape. */
export interface ShaderPixelEffect {
  type: 'shader'
  id?: string
  // Required (not `visible?:`), matching every sibling `LayerEffect` variant: an optional
  // `visible` here breaks `applyPasses`'s `{ type: string; visible: boolean }[]` parameter
  // at its one call site in useCompositorLayers.ts (bodyPasses' default-case dispatch),
  // where `shader` flows through structurally today even though it isn't a member of that
  // function's own `PASS_TYPES` set (so it's a runtime no-op there until Task 2's real
  // `case 'shader'` intercepts it first).
  visible: boolean
  effectId: string
  /** Keyed WITHOUT the `u_` prefix, same convention as `ShaderSpec.params`. */
  params: Record<string, ParamValue>
  speed: number
  /** varies the generative parts of the picked effect; 42 is the historical default. */
  seed: number
}

// ── F7: print-look RECIPE pixel effects ────────────────────────────────────────────────
/** Print LOOKS that, at paint time, EXPAND into an ordered sequence of the existing
 *  postEffects.ts passes (see `app/lib/compositor/recipes.ts` — `expandRecipe`). A recipe is
 *  an ordinary orderable PIXEL-region member of the stack (not pinned, not geometry): it
 *  reorders among the other pixel kinds, duplicates, and sits in the pixel band of
 *  EFFECT_ORDER. Each holds a few high-level dials; the expansion maps those dials onto the
 *  already-tuned primitive passes, so there is no new render machinery. */
export interface RisographEffect   { type: 'risograph';   visible: boolean; ink: string; inkTwo: string; levels: number; grain: number; contrast: number }
export interface PhotocopyEffect   { type: 'photocopy';   visible: boolean; threshold: number; dirt: number; contrast: number }
export interface LetterpressEffect { type: 'letterpress'; visible: boolean; depth: number; ink: string; paper: number }

export type LayerEffect =
  | DropShadowEffect | LayerBlurEffect | InnerShadowEffect | BackgroundBlurEffect
  | BackdropShaderEffect
  | BackdropLuminanceMaskEffect
  | TornEdgeEffect | FeatherEffect
  | TrimEffect | OffsetEffect | RoundCornersEffect | RoughenEffect | BooleanEffect | MorphEffect | WarpEffect | LongShadowEffect | ShatterEffect
  | ShaderPixelEffect
  | RisographEffect | PhotocopyEffect | LetterpressEffect
  | PostEffect

/** A stored effect, addressed by a stable id. */
export type EffectInstance = LayerEffect & { id: string }

export type EffectKind = LayerEffect['type']

/**
 * The order the pipeline applies these in, and therefore: the order an old-shape layer's
 * effects are sorted into (which is what makes an unedited document render identically),
 * the order the add menu lists them, and where a pinned kind sits.
 */
export const EFFECT_ORDER = [
  'background_blur', 'backdrop_shader', 'backdrop_luminance_mask', 'dof', 'trim', 'offset', 'round_corners', 'roughen', 'boolean', 'morph', 'warp', 'shatter', 'long_shadow', 'inner_shadow', 'inner_glow',
  'adjust', 'levels', 'posterise', 'threshold', 'invert', 'duotone', 'gradientMap', 'color_overlay', 'gradient_overlay', 'stroke_from_alpha', 'shader',
  'bloom', 'vignette', 'grain', 'torn_edge', 'feather', 'rough_edge', 'ink_bleed', 'risograph', 'photocopy', 'letterpress',
  'directional_blur', 'radial_blur', 'zoom_blur', 'layer_blur', 'outer_glow', 'drop_shadow',
] as const satisfies readonly EffectKind[]

/** Pinned for structural reasons, not convenience:
 *  - background_blur samples the backdrop BEFORE the layer paints, so it has no position
 *    inside the layer's own pass list;
 *  - backdrop_shader (F6) samples the backdrop the same way, via the same `withBackdrop`
 *    scaffolding — coexists with background_blur (both are additive backdrop treatments);
 *  - dof needs its depth map aligned to the layer's own pixels, before the layer is
 *    rotated/scaled into frame space, and runs on the GPU against a box-sized source;
 *  - drop_shadow is derived from the finished silhouette at stamp time.
 *  At most one of each per layer, and they never move. */
export const PINNED_KINDS = ['background_blur', 'backdrop_shader', 'backdrop_luminance_mask', 'dof', 'drop_shadow'] as const satisfies readonly EffectKind[]
export const ORDERABLE_KINDS = EFFECT_ORDER.filter(
  (k): k is Exclude<EffectKind, typeof PINNED_KINDS[number]> => !(PINNED_KINDS as readonly string[]).includes(k),
)

/** The geometry kinds: they transform a vector layer's outline BEFORE rasterise,
 *  so they sit in their own region — after the backdrop pins, before every pixel kind —
 *  and reorder only among themselves (`regionOf`, `canReorder`). Contiguous in EFFECT_ORDER.
 *  `boolean` (F3) combines the outline with a sibling layer's outline via paper.js; `morph` (F3)
 *  blends the outline toward a sibling layer's outline. */
export const GEOMETRY_KINDS = ['trim', 'offset', 'round_corners', 'roughen', 'boolean', 'morph', 'warp', 'shatter', 'long_shadow'] as const satisfies readonly EffectKind[]
export const isGeometryKind = (k: EffectKind): boolean =>
  (GEOMETRY_KINDS as readonly string[]).includes(k)

/** Where a kind sits in the pipeline, coarser than `EFFECT_ORDER`: `backdrop` samples/depth-maps
 *  before the layer paints, `geometry` transforms the outline before rasterise, `pixel` runs as
 *  a canvas pass over the rasterised layer, `stamp` is derived from the finished silhouette.
 *  Reorder and add both respect regions: an effect only ever moves within its own region. */
export type EffectRegion = 'backdrop' | 'geometry' | 'pixel' | 'stamp'
export function regionOf(kind: EffectKind): EffectRegion {
  if (kind === 'background_blur' || kind === 'backdrop_shader' || kind === 'backdrop_luminance_mask' || kind === 'dof') return 'backdrop'
  if (kind === 'drop_shadow') return 'stamp'
  if (isGeometryKind(kind)) return 'geometry'
  return 'pixel'
}

/** UI copy: sentence case, human names, never the stored `type`. */
export const EFFECT_LABELS: Record<EffectKind, string> = {
  background_blur: 'Background blur',
  backdrop_shader: 'Backdrop shader',
  backdrop_luminance_mask: 'Backdrop luminance mask',
  dof: 'Depth of field',
  trim: 'Trim path',
  offset: 'Offset path',
  round_corners: 'Round corners',
  roughen: 'Roughen',
  boolean: 'Combine shapes',
  morph: 'Morph to shape',
  warp: 'Warp',
  shatter: 'Shatter',
  long_shadow: 'Long shadow',
  inner_shadow: 'Inner shadow',
  inner_glow: 'Inner glow',
  outer_glow: 'Outer glow',
  adjust: 'Adjust',
  levels: 'Levels',
  posterise: 'Posterise',
  threshold: 'Threshold',
  invert: 'Invert',
  duotone: 'Duotone',
  gradientMap: 'Gradient map',
  color_overlay: 'Colour overlay',
  gradient_overlay: 'Gradient overlay',
  stroke_from_alpha: 'Stroke from alpha',
  shader: 'Shader',
  directional_blur: 'Directional blur',
  radial_blur: 'Radial blur',
  zoom_blur: 'Zoom blur',
  bloom: 'Bloom',
  vignette: 'Vignette',
  grain: 'Grain',
  torn_edge: 'Torn edge',
  feather: 'Feather',
  rough_edge: 'Rough edge',
  ink_bleed: 'Ink bleed',
  risograph: 'Risograph',
  photocopy: 'Photocopy',
  letterpress: 'Letterpress',
  layer_blur: 'Layer blur',
  drop_shadow: 'Drop shadow',
}

const ORDER_INDEX = new Map<string, number>(EFFECT_ORDER.map((k, i) => [k, i]))

export const isEffectKind = (v: unknown): v is EffectKind =>
  typeof v === 'string' && ORDER_INDEX.has(v)
export const isPinnedKind = (k: EffectKind): boolean =>
  (PINNED_KINDS as readonly string[]).includes(k)

/** Dial defaults per kind. The six chain kinds plus dof come from the shared post
 *  defaults; the rest are declared here, matching what the panels create today. */
const LOCAL_DEFAULTS: Record<string, Omit<LayerEffect, 'type'> & Record<string, unknown>> = {
  drop_shadow: { color: 'rgba(0,0,0,0.35)', x: 0, y: 0.01, blur: 0.02, visible: true },
  layer_blur: { radius: 0.01, visible: true },
  inner_shadow: { color: 'rgba(0,0,0,0.35)', x: 0, y: 0.01, blur: 0.02, visible: true },
  background_blur: { radius: 0.02, visible: true },
  // Same catalog default as `shader` (a confirmed real input-sampling effect — see that
  // entry's comment) — but speed 0: a freshly-added backdrop treatment must NOT start
  // spinning the live loop (the F5 lesson: `animated` def + nonzero speed together drive
  // hasAnimatedShaderFill, so speed 0 keeps a fresh backdrop_shader inert until the user
  // deliberately dials in motion). `params: {}` lets the picked effect's own catalog
  // defaults show through until tuned.
  backdrop_shader: { effectId: 'chromatic_aberration', params: {}, speed: 0, seed: 42, visible: true },
  // F6: reveal the layer's own content where the backdrop is bright, over a soft mid band.
  backdrop_luminance_mask: { threshold: 0.5, softness: 0.25, invert: false, visible: true },
  torn_edge: { ...DEFAULT_TORN_EDGE, visible: true },
  feather: { ...DEFAULT_FEATHER, visible: true },
  trim: { start: 0, end: 1, offset: 0, visible: true },
  offset: { distance: 0.01, visible: true },
  round_corners: { radius: 0.02, visible: true },
  roughen: { amount: 0.02, detail: 8, seed: 1, visible: true },
  // No `refLayerId` default: a fresh boolean points at nothing (no-op) until the picker
  // sets a sibling. `unite` is the least-surprising default op.
  boolean: { op: 'unite', visible: true },
  // Like boolean, no `refLayerId` default — a fresh morph is a no-op until the picker sets a
  // sibling. `amount: 0.5` so it visibly blends halfway once a sibling is chosen.
  morph: { amount: 0.5, visible: true },
  // A fresh warp visibly bulges: a positive amount on the radial field, a wave frequency
  // ready for when the user switches the field to `wave`.
  warp: { field: 'bulge', amount: 0.3, frequency: 3, visible: true },
  // A fresh long shadow casts down-right (45°) for 5% of the width in a soft black —
  // immediately visible against the shape once added; the colour card tunes it.
  long_shadow: { angle: 45, length: 0.05, color: 'rgba(0,0,0,0.35)', visible: true },
  // A fresh shatter breaks the shape into a dozen cells with a hairline gap (0.4% of the
  // width) — visibly fragmented the moment it is added; cells/gap/seed tune it.
  shatter: { cells: 12, gap: 0.004, seed: 1, visible: true },
  // `chromatic_aberration` is a real input-sampling catalog effect (it samples
  // `u_image0` per-channel with a small offset — see effectReadsInput/READS_INPUT_RE in
  // ~/lib/shaderfx/catalogStore.ts) rather than a generative field: a fresh shader effect
  // visibly, subtly processes the layer's own pixels the moment it's added, instead of
  // silently overwriting them (the F5 plan's picker-eligibility gate). `params: {}` lets
  // the picked effect's own catalog defaults show through until the user tunes a dial.
  shader: { effectId: 'chromatic_aberration', params: {}, speed: 1, seed: 42, visible: true },
  // F7 print recipes: high-level dials only; `expandRecipe` (recipes.ts) maps them onto the
  // primitive passes at paint time. Defaults are readable starting looks the controller tunes
  // by eye in the live gate.
  risograph:   { ink: '#2b3a8c', inkTwo: '#e03a6d', levels: 4, grain: 0.16, contrast: 1.12, visible: true },
  photocopy:   { threshold: 0.5, dirt: 0.2, contrast: 1.4, visible: true },
  letterpress: { depth: 0.5, ink: '#2a2a2a', paper: 0.3, visible: true },
}

function defaultsFor(kind: EffectKind): Record<string, unknown> {
  const local = LOCAL_DEFAULTS[kind]
  // Deep clone here too: a shallow spread hands every new `shader` effect the SAME
  // `params: {}` object reference, so tuning one layer's shader params would mutate
  // every other freshly-created shader effect's params too (see the POST_EFFECT_DEFAULTS
  // clone below, which exists for the identical reason with `stops`).
  if (local) return JSON.parse(JSON.stringify(local)) as Record<string, unknown>
  const post = POST_EFFECT_DEFAULTS[kind as PostEffect['type']]
  // Deep clone, matching `defaultPostEffect`: a shallow spread would hand every new
  // gradient map the SAME `stops` array, so editing one layer's stops would edit them all.
  return post ? (JSON.parse(JSON.stringify(post)) as Record<string, unknown>) : { visible: true }
}

let idCounter = 0
/** A fresh id for a real mutation. Reads use deterministic ids instead — see `effectStackOf`. */
export function newEffectId(): string {
  return `fx_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}_${++idCounter}`
}

export function createEffect(kind: EffectKind): EffectInstance {
  return { ...defaultsFor(kind), type: kind, visible: true, id: newEffectId() } as EffectInstance
}

export interface StackHost {
  effects?: unknown[]
  tornEdge?: TornEdgeSpec
  feather?: FeatherSpec
}

/**
 * ANY layer's ordered, id-stamped stack.
 *
 * New shape (every entry carries a string id): the stored array IS the user's order —
 * returned untouched.
 *
 * Old shape (any entry lacks an id): stamp DETERMINISTIC ids (`fx:<type>:<ordinal>` —
 * a random id per read would break selection and motion targets across re-reads), fold
 * the legacy `tornEdge`/`feather` fields in at their pipeline positions, drop unknown
 * kinds, and sort into EFFECT_ORDER. Same-type entries keep their relative order.
 */
export function effectStackOf(layer: StackHost | null | undefined): EffectInstance[] {
  const raw = Array.isArray(layer?.effects) ? layer!.effects : []
  const known = raw.filter(
    (e): e is Record<string, unknown> =>
      !!e && typeof e === 'object' && isEffectKind((e as { type?: unknown }).type),
  )
  const allIded = known.length > 0 && known.every(e => typeof e.id === 'string' && e.id !== '')
  // A new-shape layer that ALSO still carries a live legacy `tornEdge`/`feather` field can only
  // come from an older build editing a new document; it has no trustworthy order for the legacy
  // pass, so it falls through to the old-shape branch and is re-sorted into EFFECT_ORDER — the
  // safe answer there, since that is exactly where those two fields used to run.
  if (allIded && !tornEdgeActive(layer?.tornEdge) && !featherActive(layer?.feather)) {
    // `visible` is normalised the same way as in the old-shape branch, so a stored entry with
    // the field missing reads as visible in BOTH shapes.
    return known.map(e => ({ ...e, visible: e.visible !== false })) as unknown as EffectInstance[]
  }
  const seen = new Map<string, number>()
  const stamp = (e: Record<string, unknown>): EffectInstance => {
    const type = e.type as EffectKind
    const n = seen.get(type) ?? 0
    seen.set(type, n + 1)
    // Always MINT the id here, never keep a stored one: a partially id-stamped list would
    // otherwise let a kept id collide with a freshly minted `fx:<type>:<ordinal>`.
    return { ...e, id: `fx:${type}:${n}`, visible: e.visible !== false } as EffectInstance
  }
  const out: EffectInstance[] = known.map(stamp)
  if (tornEdgeActive(layer?.tornEdge)) out.push(stamp({ ...layer!.tornEdge, type: 'torn_edge' }))
  if (featherActive(layer?.feather)) out.push(stamp({ ...layer!.feather, type: 'feather' }))
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (ORDER_INDEX.get(a.e.type) ?? 0) - (ORDER_INDEX.get(b.e.type) ?? 0) || a.i - b.i)
    .map(x => x.e)
}

/** The patch that stores a stack on a layer and retires the legacy fields. */
export function writeStackToLayer(stack: EffectInstance[]): {
  effects: EffectInstance[]; tornEdge: undefined; feather: undefined
} {
  return { effects: stack, tornEdge: undefined, feather: undefined }
}

export const pinnedEffect = (stack: EffectInstance[], kind: EffectKind): EffectInstance | undefined =>
  stack.find(e => e.type === kind)

/** The freely orderable PIXEL entries, in list order — what `paintLayer` runs as canvas
 *  passes, feeding `splitTrailingBlurs`/`rasterablePasses`/`applyPasses`. Geometry kinds are
 *  excluded here (not just from the pinned set): they transform the outline before rasterise
 *  and must never reach a 2D canvas pass — `useCompositorLayers.ts`'s `layerGeometryEffects`
 *  reads them separately (via `isGeometryKind`) to build the computed outline `d`. */
export const orderablePasses = (stack: EffectInstance[]): EffectInstance[] =>
  stack.filter(e => !isPinnedKind(e.type) && !isGeometryKind(e.type))

/** Split a pass list into the passes that run on the offscreen and the TRAILING layer blurs.
 *  A blur with nothing orderable after it is applied as the stamp's `ctx.filter` — exactly where
 *  the legacy code applied its one blur, which is what keeps an unedited layer byte-identical:
 *  a blur pass into the offscreen re-quantizes once more and clips the bleed the drop shadow
 *  used to see at the frame edge. A blur FOLLOWED by another pass (only possible after a user
 *  reorder) must be a real pass, since the stamp filter runs last by construction. */
export function splitTrailingBlurs<T extends { type: string }>(
  passes: readonly T[],
): { body: T[]; trailing: T[] } {
  let i = passes.length
  while (i > 0 && passes[i - 1]!.type === 'layer_blur') i--
  return { body: passes.slice(0, i), trailing: passes.slice(i) }
}

/**
 * True when the whole pass list can be baked into the layer's own silhouette raster.
 *
 * The raster bakes torn edge + feather into the layer's box, so it may only be used when
 * EVERY pass is one the raster knows (torn edge / feather / layer blur), at least one edge
 * pass is actually present (nothing to bake otherwise), and every layer blur comes AFTER
 * the last edge pass — the legacy order. A blur before an edge pass would come out the wrong
 * way round, since the raster applies the edges first by construction.
 */
export function rasterablePasses(passes: readonly { type: string }[]): boolean {
  let lastEdge = -1
  for (let i = 0; i < passes.length; i++) {
    const t = passes[i]!.type
    if (t === 'torn_edge' || t === 'feather') lastEdge = i
    else if (t !== 'layer_blur') return false
  }
  if (lastEdge < 0) return false
  const firstBlur = passes.findIndex(e => e.type === 'layer_blur')
  return firstBlur === -1 || firstBlur > lastEdge
}

/** Insert a new effect. A pinned kind lands at its canonical position and is refused if
 *  already present; an orderable kind is appended after the last entry IN THE SAME REGION
 *  (`regionOf`) — e.g. a second `trim` lands at the end of the geometry region, never after
 *  a pixel kind, and a pixel kind still lands at the end of the pixel region as before. */
export function addEffect(stack: EffectInstance[], kind: EffectKind): EffectInstance[] {
  if (isPinnedKind(kind) && stack.some(e => e.type === kind)) return stack
  const fresh = createEffect(kind)
  const target = ORDER_INDEX.get(kind) ?? 0
  if (isPinnedKind(kind)) {
    const at = stack.findIndex(e => (ORDER_INDEX.get(e.type) ?? 0) > target)
    return at === -1 ? [...stack, fresh] : [...stack.slice(0, at), fresh, ...stack.slice(at)]
  }
  // An orderable kind goes to the END of its own region: right after the last entry sharing
  // `regionOf(kind)`, which keeps it before a drop shadow and after a background blur / dof,
  // and keeps geometry kinds bunched together ahead of every pixel kind.
  const region = regionOf(kind)
  const lastSameRegion = stack.reduce((acc, e, i) => (regionOf(e.type) === region ? i : acc), -1)
  if (lastSameRegion >= 0) {
    const at = lastSameRegion + 1
    return [...stack.slice(0, at), fresh, ...stack.slice(at)]
  }
  // Nothing in this region yet: sit before the first entry of a later-sorting kind.
  const at = stack.findIndex(e => (ORDER_INDEX.get(e.type) ?? 0) > target)
  return at === -1 ? [...stack, fresh] : [...stack.slice(0, at), fresh, ...stack.slice(at)]
}

export function removeEffect(stack: EffectInstance[], id: string): EffectInstance[] {
  const next = stack.filter(e => e.id !== id)
  return next.length === stack.length ? stack : next
}

/** A copy directly after the original, with a fresh id. Pinned kinds cannot duplicate. */
export function duplicateEffect(stack: EffectInstance[], id: string): EffectInstance[] {
  const i = stack.findIndex(e => e.id === id)
  if (i === -1 || isPinnedKind(stack[i]!.type)) return stack
  // Deep clone for the same reason `defaultsFor` does: a shallow copy would share the
  // original's nested dials (a gradient map's `stops`) with its duplicate.
  const copy = { ...(JSON.parse(JSON.stringify(stack[i]!)) as EffectInstance), id: newEffectId() }
  return [...stack.slice(0, i + 1), copy, ...stack.slice(i + 1)]
}

/** True when `fromId` may be dropped onto `toId`: both exist, both orderable, not the same,
 *  and in the SAME REGION — a geometry kind reorders only against another geometry kind,
 *  never against a pixel kind (they never cross into each other's region). */
export function canReorder(stack: EffectInstance[], fromId: string, toId: string): boolean {
  if (fromId === toId) return false
  const from = stack.find(e => e.id === fromId)
  const to = stack.find(e => e.id === toId)
  return !!from && !!to && !isPinnedKind(from.type) && !isPinnedKind(to.type)
    && regionOf(from.type) === regionOf(to.type)
}

/** Move `fromId` to `toId`'s position. A move touching a pinned row is a no-op. */
export function reorderEffect(stack: EffectInstance[], fromId: string, toId: string): EffectInstance[] {
  if (!canReorder(stack, fromId, toId)) return stack
  const next = [...stack]
  const from = next.findIndex(e => e.id === fromId)
  // `to` must be read from `next` BEFORE the splice below removes `from` — reading it
  // after (against the already-shortened array) yields a stale index that silently
  // undoes the move for a forward drag (from < to).
  const to = next.findIndex(e => e.id === toId)
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved!)
  return next
}
