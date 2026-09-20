/**
 * CPU-only fill primitives — the type, the parser, and the 2D-canvas tile builder.
 *
 * Extracted from fills.ts (which keeps the THREE/GPU texture builders) so consumers
 * that only paint into a 2D canvas — the Frame-modal compositor — can import the fill
 * model + `fillTileCanvas` WITHOUT pulling THREE into their bundle. fills.ts re-exports
 * everything here, so Type Studio importers are unchanged.
 *
 * CIRCULAR IMPORT (intentional, safe): `~/lib/compositor/paint`'s `Paint`/`Gradient`
 * embed this module's `Fill`, and this module's `ShaderSpec.input` is `Paint` — so the
 * two modules import each other. Every cross-boundary value (`isGradient`/`isFill`
 * here, `effectiveTileFill`/`fillTileBox` there) is an `export function` declaration,
 * which ES modules hoist fully before either module's body runs, and neither module
 * calls the other's export at its own top level (only inside function bodies invoked
 * later) — so the cycle never observes a not-yet-initialized binding. Do not turn any
 * of these into `export const fn = () => …`, which is NOT hoisted and would break this.
 */
import { isGradient, isFill, sortedClampedStops, type Paint } from '~/lib/compositor/paint'
// The angle→axis trig for a linear gradient, shared with the SVG spine so a
// gradient tile and the `<linearGradient>` exported for it cannot drift. It is a
// pure numeric helper — importing it pulls no DOM, no model and no cycle
// (`lib/vector/svg` imports nothing at all).
import { gradientUnitAxis } from '~/lib/vector/svg'
import type { GradientStop, ParamValue } from '~/lib/shaderfx/types'
import { drawShape } from '~/lib/shapes/path2d'
import { shapeById } from '~/lib/shapes/catalog'

// Local, deliberately NOT imported from ~/lib/shaderfx/params. This module sits in
// a documented import cycle with ~/lib/compositor/paint (see the header), so every
// value import added here widens the graph that has to settle before
// DEFAULT_SHADER_SPEC is assigned. Keeping this a type-only import boundary is
// cheaper than reasoning about that each time. Mirrors isParamHex(): 3/4/6/8
// digits, because StudioColor emits #rrggbbaa.
const PARAM_HEX = /^#?([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

export type FillType = 'solid' | 'gradient' | 'ombre' | 'grid' | 'noise' | 'checkerboard' | 'stripes' | 'qr' | 'shader' | 'shapes' | 'paper'
/** `a`/`b` drive the slot's fill (stripe); `textColor` is the solid colour for type on that row.
 *  `angle` (degrees) applies to `stripes`/`gradient`/`ombre`/`shapes` (per-shape rotation) and to
 *  `paper` (fibre direction); `density` controls cell/stripe count, and grain fineness for `paper`.
 *  `shapeId`, `shapeSize`, `shapeGap`, `shapeFit` are only meaningful for `type === 'shapes'`.
 *  `grain` (0..1) is only meaningful for `type === 'paper'`: the grain strength, set only by
 *  `normalizeFill`. */
export interface Fill { type: FillType; a: string; b: string; textColor: string; angle: number; density: number; shader?: ShaderSpec; shapeId?: string; shapeSize?: number; shapeGap?: number; shapeFit?: ShapeFit; grain?: number }

/** How a `shapes` fill occupies its box. `'tile'` repeats the shape on the Size/Spacing grid
 *  (the historical — and still default — behaviour). `'fill'` and `'contain'` draw ONE shape:
 *  `'fill'` scales it to cover the box (the overflow is clipped), `'contain'` scales it to sit
 *  wholly inside. Size and Spacing are grid dials, so they are dead controls in the two
 *  single-shape modes and the picker hides them there. */
export type ShapeFit = 'tile' | 'fill' | 'contain'
/** Picker order. `'tile'` is the DEFAULT (and the only pre-`shapeFit` behaviour) but sits last
 *  because the two single-shape fits are the ones a user reaches for by name. */
export const SHAPE_FITS: ShapeFit[] = ['fill', 'contain', 'tile']

/** A shader fill runs `input` through a catalog effect against any `Paint` — a flat
 *  colour, a linear/radial gradient, or another (non-shader) `Fill`. `input` is NEVER
 *  itself a shader-typed `Fill` — depth-1 is enforced in normalizeFill/normalizePaint,
 *  because unbounded nesting hangs the renderer. */
export interface ShaderSpec {
  effectId: string
  /** Keyed WITHOUT the `u_` prefix. Values are numbers (float/enum), hex strings
   *  (`color`) or stop lists (`gradient`) — see ParamValue in ~/lib/shaderfx/types. */
  params: Record<string, ParamValue>
  anchor: 'object' | 'frame'
  speed: number
  /** varies the generative field; 42 is the historical default. */
  seed: number
  input: Paint
  /** True when this effect should sample what's already painted behind the layer (the
   *  compositor backdrop) rather than — or in addition to — its own `input`. Drives
   *  `isGlassLayer` in useCompositorLayers.ts; absent/false for every existing shader fill. */
  readsBackdrop?: boolean
  /** Which backdrop layer this effect reads, when more than the immediate one behind it
   *  is addressable. Optional — most glass effects just want "whatever is directly behind". */
  readsLayerKey?: string
}

/** All fill types, in picker order. SINGLE SOURCE OF TRUTH — imported by every fill dropdown. */
export const FILL_TYPES: FillType[] = ['solid', 'gradient', 'ombre', 'grid', 'noise', 'checkerboard', 'stripes', 'qr', 'shader', 'shapes', 'paper']
export const DEFAULT_FILL: Fill = { type: 'solid', a: '#ffffff', b: '#000000', textColor: '#ffffff', angle: 45, density: 8 }

export const DEFAULT_SHADER_SPEC: ShaderSpec = {
  effectId: 'fbm_warp', params: {}, anchor: 'object', speed: 1, seed: 42,
  input: { type: 'gradient', a: '#ffffff', b: '#000000', textColor: '#ffffff', angle: 45, density: 8 },
}

/** The "Holographic" fill-picker entry. Deliberately a PRESET, not a FILL_TYPES member:
 *  canvas-painted fill types cannot do per-pixel iridescence, and a shader fill in that
 *  path already degrades to its input (see fills.ts's fillTexture). Twelve modules read
 *  FILL_TYPES, and one leak from it has already reached a 3D texture path.
 *  Shares `DEFAULT_SHADER_SPEC.input` by reference (see below) — consumers must
 *  `structuredClone` this preset before assigning it onto a fill (both pickers do);
 *  never mutate it in place. */
export const HOLOGRAPHIC_FILL_PRESET: Fill = {
  ...DEFAULT_FILL,
  type: 'shader',
  shader: {
    effectId: 'holographic_surface',
    // Keyed WITHOUT the `u_` prefix — see ShaderSpec's doc above.
    // Verified against shader_effects/manifest.json's current defaults.
    // `metallic` is the GLSL name; its label is "Silver wash" since the look changed
    // from diffraction foil to sticker vinyl (see the spec's Controls table).
    params: { surface: 0, scale: 4, iridescence: 0.78, bands: 3, angle: 0,
              shimmer: 0.25, metallic: 0.6, sheen: 0.5, glow: 0.5, crinkle: 1.0, tint: '#aab0b8', mix: 0 },
    anchor: 'object',
    speed: 1,
    seed: 42,
    // Required by ShaderSpec and ignored by a generative effect, exactly as the other
    // twenty generative effects behave inside a shader fill.
    input: DEFAULT_SHADER_SPEC.input,
  },
}

/** True when `f` is a shader fill actually carrying a spec (vs. `type: 'shader'` with no spec yet). */
export function fillIsShader(f: Fill): f is Fill & { shader: ShaderSpec } {
  return f.type === 'shader' && !!f.shader
}

/** What the fill-picker's type dropdown should show as selected for `fill`: a plain
 *  `FillType`, or the synthetic `'holographic'` entry when `fill` is a shader fill
 *  wrapping the `holographic_surface` effect. Shared by FillControl.vue's `currentType`
 *  and SpaceTypeSurface.vue's `arrayFillSelectValue` so the two pickers can't drift. */
export function fillPickerType(fill: Fill): FillType | 'holographic' {
  return (fill.type === 'shader' && fill.shader?.effectId === 'holographic_surface') ? 'holographic' : fill.type
}

/** Paint equivalent of `effectiveTileFill` below — unwraps a shader-typed `Fill` exactly
 *  one level so the shader-INPUT rasterisation path (`paintTileBox`, via `getInputTile`)
 *  never re-enters the field renderer with a stale descriptor. Passes a string, a
 *  `Gradient`, or a non-shader `Fill` through UNCHANGED (same reference) — only a
 *  shader-typed `Fill` is unwrapped. Never returns a shader-typed value: falls back to
 *  the default shader input if `shader` — or its own `input`, however deeply malformed —
 *  is somehow absent/shader-typed itself, and cannot loop because it only ever unwraps
 *  one level. Guard is explicit (`isFill(p) && p.type === 'shader'`) rather than relying
 *  on `undefined !== 'shader'`, so a non-Fill Paint can never accidentally satisfy it. */
export function effectiveTilePaint(p: Paint): Paint {
  if (!(isFill(p) && p.type === 'shader')) return p
  const input = p.shader?.input ?? DEFAULT_SHADER_SPEC.input
  return isFill(input) && input.type === 'shader' ? DEFAULT_SHADER_SPEC.input : input
}

/** Resolve the fill that should actually be rasterised by the FILL-ONLY CPU tile builders
 *  below (`fillTileCanvas`/`fillTileBox`) and the THREE seeds in fills.ts/materials.ts —
 *  every one of which can only paint a `Fill`, never a bare colour string or a `Gradient`.
 *  Delegates to `effectiveTilePaint` above (the general Paint-unwrap) so the two can never
 *  silently disagree about what a shader fill unwraps to; when that unwrap yields something
 *  that ISN'T a `Fill` (the shader's configured input is a `Gradient`/string, now that
 *  `ShaderSpec.input` accepts any `Paint`), there is no `Fill` representation of it for
 *  these CPU-only consumers to rasterise, so this degrades the same way the "shader somehow
 *  absent" case always has: the default shader input's plain gradient, never nothing. The
 *  live-field-capable callers (`getInputTile`, `paintTileBox`) use `effectiveTilePaint`
 *  directly instead, so a Gradient/string input is never lossily downgraded on THAT path. */
export function effectiveTileFill(fill: Fill): Fill {
  const p = effectiveTilePaint(fill)
  if (isFill(p)) return p
  // DEFAULT_SHADER_SPEC.input is documented to stay a Fill (see its own declaration
  // above) even though its STATIC type widened to Paint alongside ShaderSpec.input —
  // `isFill` re-narrows that guarantee for the type checker rather than casting past
  // it, with DEFAULT_FILL as an (unreachable in practice) belt-and-suspenders fallback.
  return isFill(DEFAULT_SHADER_SPEC.input) ? DEFAULT_SHADER_SPEC.input : DEFAULT_FILL
}

/** True when the fill needs a texture/pattern (anything but a flat colour). */
export function fillIsTextured(fill: Fill): boolean { return fill.type !== 'solid' }

/** Parse the JSON param string into a non-empty Fill[] (tolerant of junk/legacy values). */
export function parseFills(raw: unknown): Fill[] {
  if (typeof raw !== 'string' || !raw) return [{ ...DEFAULT_FILL }]
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr) || !arr.length) return [{ ...DEFAULT_FILL }]
    return arr.map((f: unknown): Fill => normalizeFill(f))
  } catch { return [{ ...DEFAULT_FILL }] }
}

/** Coerce an unknown value into a valid Fill, filling defaults for missing/bad fields.
 *  `depth` tracks recursion into a shader fill's `input`: at depth 1 the `shader` type is
 *  refused (collapsed to the default shader input's type), enforcing depth-1 nesting. */
export function normalizeFill(f: unknown, depth = 0): Fill {
  const o = (f ?? {}) as Record<string, unknown>
  let type = FILL_TYPES.includes(o.type as FillType) ? (o.type as FillType) : 'solid'
  // Was `DEFAULT_SHADER_SPEC.input.type` — only meaningful while the default shader
  // input was guaranteed to be a Fill. Now that `ShaderSpec.input` is `Paint`, that
  // expression's static type is `Paint['type']`, which includes `undefined` (a bare
  // colour string has no `.type`) — neither `undefined` nor a Gradient's `'linear'`/
  // `'radial'` is a valid `FillType`. The literal is what the default has always
  // actually been (see DEFAULT_SHADER_SPEC above); spelling it out avoids depending on
  // that constant's shape staying a Fill forever.
  if (type === 'shader' && depth > 0) type = 'gradient'
  const base: Fill = {
    type,
    a: typeof o.a === 'string' ? o.a : '#ffffff',
    b: typeof o.b === 'string' ? o.b : '#000000',
    textColor: typeof o.textColor === 'string' ? o.textColor : '#ffffff',
    angle: typeof o.angle === 'number' ? o.angle : 45,
    density: typeof o.density === 'number' ? o.density : 8,
  }
  // `shapeId` is only ever set for a `shapes` fill — a bad/missing id defaults to
  // 'sparkle' here so every downstream consumer (the tile painters below) can
  // assume `fill.shapeId` is a real id whenever `fill.type === 'shapes'`.
  if (type === 'shapes') {
    // `shapeId` defaults to 'sparkle' so every downstream consumer can assume a real id.
    // `shapeSize`/`shapeGap` are tile fractions; when absent they are DERIVED from `density`
    // (0.76/0.24 split reproduces the pre-size/gap look — cells filled 1 − 2·0.12 = 0.76),
    // so an old shapes fill (only `density`) migrates to the exact same appearance.
    const cl = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
    base.shapeId = typeof o.shapeId === 'string' ? o.shapeId : 'sparkle'
    const d = cl(typeof o.density === 'number' ? o.density : 8, 1, 64)
    base.shapeSize = typeof o.shapeSize === 'number' ? cl(o.shapeSize, 0.01, 0.6) : 0.76 / d
    base.shapeGap  = typeof o.shapeGap  === 'number' ? cl(o.shapeGap,  0,    0.6) : 0.24 / d
    // `shapeFit` defaults to 'tile' — the only behaviour that existed before it, so every
    // saved shapes fill migrates to exactly the look it had.
    base.shapeFit = (SHAPE_FITS as string[]).includes(o.shapeFit as string) ? (o.shapeFit as ShapeFit) : 'tile'
  }
  // `grain` (0..1) is only meaningful for a `paper` fill — the grain strength. Default 0.4,
  // clamped, so every downstream consumer can assume a real number whenever `type === 'paper'`.
  if (type === 'paper') {
    base.grain = typeof o.grain === 'number' ? Math.max(0, Math.min(1, o.grain)) : 0.4
  }
  if (type !== 'shader') return base            // a spec on a non-shader fill is dropped
  return { ...base, shader: normalizeShaderSpec(o.shader, depth) }
}

/** Coerce an unknown value into a valid ShaderSpec, recursing into `input` at `depth + 1`
 *  so the depth-1 guard in normalizeFill applies to it. Exported so other config schemas that
 *  carry a bare `ShaderSpec` (not wrapped in a full `Fill`) — e.g. `shapefx/config.ts`'s
 *  `SurfaceFill.shader` — can reuse the same sanitizing/defaulting logic `normalizeFill` uses
 *  for its own `shader` field, rather than a second hand-rolled copy. Call with `depth: 0` at
 *  the top level. */
export function normalizeShaderSpec(s: unknown, depth: number): ShaderSpec {
  const o = (s ?? {}) as Record<string, unknown>
  // Accepts all three ParamValue shapes. A whitelist of `number` alone would drop
  // colour and gradient params here at the persistence boundary — silently, so the
  // fill would reload with the effect's default colours and look merely "wrong".
  const params: Record<string, ParamValue> = {}
  if (o.params && typeof o.params === 'object') {
    for (const [k, v] of Object.entries(o.params as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) params[k] = v
      else if (typeof v === 'string' && PARAM_HEX.test(v.trim())) params[k] = v
      else if (Array.isArray(v) && v.every(s => s && typeof s === 'object'
        && typeof (s as GradientStop).color === 'string' && Number.isFinite((s as GradientStop).pos))) {
        params[k] = v as GradientStop[]
      }
    }
  }
  return {
    effectId: typeof o.effectId === 'string' && o.effectId ? o.effectId : DEFAULT_SHADER_SPEC.effectId,
    params,
    anchor: o.anchor === 'frame' ? 'frame' : 'object',
    speed: typeof o.speed === 'number' && Number.isFinite(o.speed) ? o.speed : 1,
    seed: typeof o.seed === 'number' && Number.isFinite(o.seed) ? o.seed : DEFAULT_SHADER_SPEC.seed,
    input: normalizePaint(o.input ?? DEFAULT_SHADER_SPEC.input, depth + 1),
  }
}

/** Coerce an unknown value into a valid `Paint` — the `Paint`-widened sibling of
 *  `normalizeFill` for `ShaderSpec.input`. Routing order is a MIGRATION-SAFETY
 *  condition, not a style choice:
 *   1. a string passes through as-is (a flat CSS colour is already a valid Paint)
 *   2. an object shaped like a `Gradient` (`isGradient`) is normalised as one —
 *      offsets coerced to finite numbers clamped 0..1, colors coerced to strings,
 *      entries that aren't even shaped like a stop dropped outright; an empty result
 *      falls back to the default shader input (never an empty-stops gradient); `angle`
 *      normalised for `linear`
 *   3. EVERYTHING ELSE — including `null`, `undefined`, and junk — falls through to
 *      `normalizeFill`, exactly as it always has. This is deliberately NOT gated on
 *      `isFill(p)`: `isFill` requires both `a` and `density` to be present, but a
 *      persisted or hand-edited `Fill` missing either field is currently *repaired* by
 *      `normalizeFill` (defaults fill the gap), not dropped. Gating on `isFill` here
 *      would instead route that same value to the Gradient-or-fallback arms above and
 *      silently drop it to `DEFAULT_SHADER_SPEC.input` — a real data loss on already-
 *      saved projects. Routing "by exclusion" (arms 1 and 2 first, everything else
 *      falls through) preserves `normalizeFill`'s existing total-function/repair
 *      behaviour exactly. */
export function normalizePaint(p: unknown, depth: number): Paint {
  if (typeof p === 'string') return p
  if (isGradient(p as Paint | undefined)) return normalizeGradient(p as Record<string, unknown>)
  return normalizeFill(p, depth)
}

function normalizeGradient(g: Record<string, unknown>): Paint {
  const rawStops = Array.isArray(g.stops) ? g.stops : []
  const stops = rawStops
    .filter((s: unknown): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s: Record<string, unknown>) => ({
      offset: typeof s.offset === 'number' && Number.isFinite(s.offset) ? Math.max(0, Math.min(1, s.offset)) : 0,
      color: typeof s.color === 'string' ? s.color : '#000000',
    }))
  // DEFAULT_SHADER_SPEC.input is a Fill (a gradient-typed one), not a Gradient — an
  // empty stop array falls back to it directly, deliberately changing ARM rather than
  // producing a zero-stop Gradient, mirroring normalizeFill's own "coerce junk to
  // something valid, never throw" contract one level up at the Paint level.
  if (!stops.length) return DEFAULT_SHADER_SPEC.input
  const sorted = sortedClampedStops(stops)
  if (g.type === 'radial') return { type: 'radial', stops: sorted }
  const angle = typeof g.angle === 'number' && Number.isFinite(g.angle) ? g.angle : 0
  return { type: 'linear', angle, stops: sorted }
}

export function serializeFills(fills: Fill[]): string { return JSON.stringify(fills) }

/**
 * The representative solid colour of any Paint-like value (string | Gradient | Fill),
 * for code paths that can only take a flat CSS colour — SVG export, animated per-char
 * text, a caret. Structural (no type import): `a` ⇒ Fill, `stops` ⇒ Gradient.
 */
export function paintPrimaryColor(p: unknown, fallback = '#000000'): string {
  if (typeof p === 'string') return p
  if (p && typeof p === 'object') {
    const o = p as { a?: string; stops?: Array<{ color?: string }> }
    if (typeof o.a === 'string') return o.a
    if (Array.isArray(o.stops)) return o.stops[0]?.color ?? fallback
  }
  return fallback
}

/** Parse a `#rrggbb` (or `#rrggbbaa`) hex to raw sRGB bytes (canvas is sRGB — do NOT go
 *  through THREE.Color, whose components are linear-light and would write the wrong bytes).
 *  8-digit input has its alpha pair stripped first — bit-shifting the full 32-bit value would
 *  overflow to the wrong bytes rather than the rgb component. */
export function hexBytes(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const s = h.length === 3 ? h.split('').map(ch => ch + ch).join('') : h.length === 8 ? h.slice(0, 6) : h
  const n = parseInt(s, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// ── The patterned fills' shared cell maths ──────────────────────────────────
//
// `grid`, `checkerboard`, `stripes` and `qr` are all "chop the box into square
// cells and colour some of them `b`". Everything below states ONE of the rules
// that decides which, and every renderer of these four fills calls them rather
// than spelling the arithmetic out again:
//
//   - `fillTileBox` (this file)          — the CPU tile the Compositor and Vector
//                                           Type's canvas paint with
//   - `fillTileCanvas` (this file)       — the square swatch tile
//   - `paintToVectorPaint` (lib/paint/toVector) — the `<pattern>` the SVG export
//                                           writes, which must be the SAME
//                                           geometry as the pixels, not a second
//                                           derivation of it
//
// That last consumer is why these are functions at all. A mirrored renderer
// drifts (see the warning at `lib/texturefx/fills.ts:22`), and pattern drift is
// invisible: both surfaces still show a checkerboard.

/**
 * The cell edge of a patterned fill, in whatever units `boxW` is given in —
 * tile pixels for the CPU tiles, document units for the SVG export.
 *
 * SQUARE cells: the same edge is used on both axes, so a pattern never
 * stretches on a non-square shape.
 *
 * Deliberately NOT rounded to whole pixels. `fillTileBox` used to round, which
 * made a fill's cell size depend on the RASTER RESOLUTION its tile happened to
 * be built at: a 1× card and a 2× bake of the same shape put their cell
 * boundaries at different fractions of the box (up to half a cell of drift by
 * the far edge), and the density control delivered `round(W/d)` cells rather
 * than the `d` it promises. `fillTileCanvas` below and the THREE textures in
 * `fills.ts` never rounded — this is the odd one out being brought into line,
 * which is also what makes a resolution-independent vector export able to match
 * the canvas at all.
 */
export function fillPatternCell(boxW: number, density: number): number {
  const d = Math.max(1, Math.round(Number.isFinite(density) ? density : 1))
  const w = Number.isFinite(boxW) && boxW > 0 ? boxW : 0
  return Math.max(2, w / d)
}

/** Checkerboard: cell `(cx, cy)` takes colour `b` on the odd diagonals, so
 *  `(0, 0)` is `a`. */
export function checkerCellIsB(cx: number, cy: number): boolean {
  return (cx + cy) % 2 === 1
}

/** Stripes: band `k` (the cell index along the stripe direction) takes colour
 *  `b` when odd. Written for a SIGNED `k` because an SVG `<pattern>` tiles into
 *  negative band indices where the canvas — which only ever samples pixels
 *  inside the box — does not. `-1` is odd, and `-1 % 2` is `-1` in JS, so the
 *  `!== 0` test (rather than `=== 1`) is load-bearing. */
export function stripeBandIsB(k: number): boolean {
  return k % 2 !== 0
}

/** QR: a deterministic per-CELL hash, so the "code" is stable across renders and
 *  across surfaces. `> 0.45` makes it slightly denser than half. */
export function qrCellIsB(cx: number, cy: number): boolean {
  const v = Math.sin(cx * 12.9898 + cy * 78.233 + cx * cy * 3.71) * 43758.5453
  return (v - Math.floor(v)) > 0.45
}

/** Grid: the border line's width for a `cell`-wide cell, in the same units.
 *  8 % of the cell, with a hairline floor of one unit so a dense grid still has
 *  visible lines. (The floor is the one part of this that is not resolution
 *  independent — at 2× it is half a logical pixel — but it only bites on cells
 *  under 12.5 units, where the line is sub-pixel either way.) */
export function gridLineWidth(cell: number): number {
  return Math.max(1, cell * 0.08)
}

/** Ombre: a GRAINY / pointillist A→B fade at `angle` degrees — each pixel is colB with probability
 *  = its position along the gradient (else colA), so the two colours mix as scattered dots whose
 *  density shifts across the fade (solid A → grain → solid B). Deterministic hash for stable dots. */
export function ombrePicker(w: number, h: number, angle: number): (px: number, py: number) => boolean {
  const rad = (angle * Math.PI) / 180, dx = Math.cos(rad), dy = Math.sin(rad)
  const cor = [0, w * dx, h * dy, w * dx + h * dy]
  const pmin = Math.min(...cor), range = (Math.max(...cor) - pmin) || 1
  return (px, py) => {
    const t = (px * dx + py * dy - pmin) / range            // 0→1 along the fade direction
    const hsh = Math.sin(px * 12.9898 + py * 78.233) * 43758.5453
    return (hsh - Math.floor(hsh)) < t                       // colB density grows with t
  }
}

/** Per-pixel A/B image from a boolean picker — the shared core of every patterned tile. */
export function patternImageData(w: number, h: number, colA: [number, number, number], colB: [number, number, number], picker: (px: number, py: number) => boolean): ImageData {
  const img = new ImageData(w, h)
  for (let i = 0; i < img.data.length; i += 4) {
    const px = (i / 4) % w, py = Math.floor((i / 4) / w)
    const useB = picker(px, py)
    img.data[i] = useB ? colB[0] : colA[0]
    img.data[i + 1] = useB ? colB[1] : colA[1]
    img.data[i + 2] = useB ? colB[2] : colA[2]
    img.data[i + 3] = 255
  }
  return img
}

/** Paint the fill's library shape onto a size-agnostic tile, in one of three fits.
 *
 *  `'fill'` / `'contain'` draw a SINGLE shape across the whole tile — cover (overflow
 *  clipped by the tile) and letterboxed-inside respectively. Size and Spacing play no
 *  part in either.
 *
 *  `'tile'` (the default) repeats the shape on a grid whose COUNT is derived from
 *  `shapeSize` + `shapeGap` (both tile fractions): each cell spans `size + gap`, so
 *  `cols = round(1 / (size + gap))` whole cells fit across (keeping the square tile
 *  seamless), and the shape fills `size / (size + gap)` of its cell. Bigger size ⇒ larger
 *  shapes / fewer of them; bigger gap ⇒ same shapes with more air around each.
 *
 *  Cells are SQUARE: the cell edge comes from the WIDTH, and the row count is however many
 *  of those square cells the height needs (centred, so the overhang crops evenly top and
 *  bottom rather than leaving a dead band). Rows used to be the same `d` as columns, which
 *  made the cell as oblong as the box; drawShape fits its ink with a single uniform scale,
 *  so on a non-square box that left a permanent strip of air along the long axis — air no
 *  amount of Spacing = 0 could close. With square cells, `gap = 0` really does put adjacent
 *  shape boxes edge to edge. */
function paintShapesTile(ctx: CanvasRenderingContext2D, fill: Fill, W: number, H: number): void {
  const shape = shapeById(fill.shapeId ?? '') ?? shapeById('sparkle')!
  const bg = fill.b
  if (bg && bg !== 'none') { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H) }
  const rot = (fill.angle * Math.PI) / 180

  // ── Single-shape fits ────────────────────────────────────────────────────────────
  const fit: ShapeFit = fill.shapeFit ?? 'tile'
  if (fit !== 'tile') {
    const [, , sbw, sbh] = shape.box
    // `contain` IS drawShape's own behaviour on the whole tile (it fits by `min` and
    // centres). `fill` needs the covering rect computed here and handed in, because
    // drawShape has no `max` mode — feeding it the cover-sized box makes its `min`
    // land on exactly the cover scale.
    let x = 0, y = 0, w = W, h = H
    if (fit === 'fill' && sbw > 0 && sbh > 0) {
      const s = Math.max(W / sbw, H / sbh)
      w = sbw * s; h = sbh * s; x = (W - w) / 2; y = (H - h) / 2
    }
    if (rot) {
      ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(rot); ctx.translate(-W / 2, -H / 2)
      drawShape(ctx, shape, { x, y, w, h, fill: fill.a })
      ctx.restore()
    } else {
      drawShape(ctx, shape, { x, y, w, h, fill: fill.a })
    }
    return
  }

  // ── Tiled grid ───────────────────────────────────────────────────────────────────
  // Self-migrate: a fill that skipped normalizeFill (e.g. a compositor Paint fed straight to the
  // tile builder) may carry only the legacy `density`. Derive size/gap from it with the same
  // 0.76/0.24 split normalizeFill uses, so a density-only shapes fill renders at its saved count
  // here too — not a flat fallback. Explicit size/gap always win.
  const dDen = Math.max(1, Math.min(64, fill.density || 8))
  const size = Math.max(0.01, Math.min(0.6, fill.shapeSize ?? 0.76 / dDen))
  const gap  = Math.max(0,    Math.min(0.6, fill.shapeGap  ?? 0.24 / dDen))
  const cellFrac = Math.max(0.02, size + gap)
  const fillFrac = Math.max(0.02, Math.min(1, size / cellFrac))
  const cols = Math.max(1, Math.min(64, Math.round(1 / cellFrac)))
  const cw = W / cols, ch = cw                                  // square cells
  const rows = Math.max(1, Math.min(64, Math.ceil(H / ch)))
  const y0 = (H - rows * ch) / 2                                // centre the overhang
  for (let iy = 0; iy < rows; iy++) for (let ix = 0; ix < cols; ix++) {
    const cx = (ix + 0.5) * cw, cy = y0 + (iy + 0.5) * ch
    const bw = cw * fillFrac, bh = ch * fillFrac
    if (rot) {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot); ctx.translate(-cx, -cy)
      drawShape(ctx, shape, { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh, fill: fill.a })
      ctx.restore()
    } else {
      drawShape(ctx, shape, { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh, fill: fill.a })
    }
  }
}

/** Deterministic per-cell hash in [0,1) — the seed for paper's grain and fibre placement.
 *  Fixed constants (no time, no Math.random) so a paper tile is byte-stable across renders,
 *  which is what lets it tile and raster-export without shimmer. */
function paperHash(cx: number, cy: number): number {
  const v = Math.sin(cx * 127.1 + cy * 311.7) * 43758.5453
  return v - Math.floor(v)
}

/** Smooth value noise in [0,1): the per-lattice-point `paperHash` bilinearly interpolated with a
 *  smoothstep fade, so a grain SCALE larger than one pixel reads as soft organic mottle rather than
 *  the hard, flat pixel-blocks a `floor(px/cell)` sampling produced (which "blew up" at low
 *  density). `s` is the lattice spacing in pixels; `s === 1` collapses back to per-pixel `paperHash`
 *  at integer coordinates. */
function paperValueNoise(x: number, y: number, s: number): number {
  const gx = x / s, gy = y / s
  const x0 = Math.floor(gx), y0 = Math.floor(gy)
  const fx = gx - x0, fy = gy - y0
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy)   // smoothstep fade
  const n00 = paperHash(x0, y0), n10 = paperHash(x0 + 1, y0)
  const n01 = paperHash(x0, y0 + 1), n11 = paperHash(x0 + 1, y0 + 1)
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v
}

/**
 * Paper grain as a pure ImageData: base colour `a` speckled toward the grain tint `b` on the
 * dark side and toward white on the light side, giving paper "tooth". `grain` (0..1) scales the
 * speckle strength; `density` sets grain fineness — higher density = a finer grain lattice. The
 * grain is a fine per-pixel tooth blended with a `density`-scaled soft mottle (`paperValueNoise`),
 * so the whole density range stays paper-like and never pixelates into flat blocks. Exported so it
 * can be unit-tested without a DOM canvas.
 */
export function paperImageData(w: number, h: number, fill: Fill): ImageData {
  const base = hexBytes(fill.a), tint = hexBytes(fill.b)
  const grain = Math.max(0, Math.min(1, fill.grain ?? 0.4))
  // Grain lattice spacing in px: higher density ⇒ finer. Bounded to [1,8] so the coarse end is a
  // soft mottle (interpolated), never the 24px flat blocks the old `24/density` cell produced.
  const scale = Math.max(1, Math.min(8, 24 / Math.max(1, fill.density || 1)))
  const img = new ImageData(w, h)
  for (let i = 0; i < img.data.length; i += 4) {
    const px = (i / 4) % w, py = Math.floor((i / 4) / w)
    // Fine per-pixel tooth (0.3) keeps grain at every density; the density-scaled mottle (0.7)
    // is what the Density control actually moves — fine speckle ⇄ soft coarse grain.
    const n = 0.3 * paperHash(px, py) + 0.7 * paperValueNoise(px, py, scale)   // 0..1
    const k = (n - 0.5) * 2 * grain                                     // -grain..+grain
    for (let ch = 0; ch < 3; ch++) {
      const target = k >= 0 ? tint[ch]! : 255                           // dark fleck → tint, light fleck → white
      img.data[i + ch] = Math.round(base[ch]! + (target - base[ch]!) * Math.abs(k))
    }
    img.data[i + 3] = 255
  }
  return img
}

/** Paint a paper fill onto a size-agnostic tile: the grain image, then a few faint directional
 *  fibre streaks along `angle` tinted toward `b`. Fibre count/opacity grow with `grain`.
 *  Deterministic (seeded via paperHash). */
export function paintPaperTile(ctx: CanvasRenderingContext2D, fill: Fill, W: number, H: number): void {
  ctx.putImageData(paperImageData(W, H, fill), 0, 0)
  const grain = Math.max(0, Math.min(1, fill.grain ?? 0.4))
  const count = Math.round(6 + grain * 18)
  const rad = (fill.angle * Math.PI) / 180, dx = Math.cos(rad), dy = Math.sin(rad)
  const maxLen = Math.max(W, H)
  ctx.save()
  ctx.strokeStyle = fill.b
  ctx.globalAlpha = 0.05 + grain * 0.08
  ctx.lineWidth = 1
  for (let i = 0; i < count; i++) {
    const cx = paperHash(i, 7) * W, cy = paperHash(i, 13) * H
    const len = (0.1 + paperHash(i, 19) * 0.25) * maxLen
    ctx.beginPath()
    ctx.moveTo(cx - dx * len / 2, cy - dy * len / 2)
    ctx.lineTo(cx + dx * len / 2, cy + dy * len / 2)
    ctx.stroke()
  }
  ctx.restore()
}

/** The cache key for a fill's rendered tile — the `type|a|b|angle|density|<type-extra>` recipe
 *  shared by every 2D tile cache (fillTexture, resolve.ts, sliceGlitch.ts). Centralised so a new
 *  per-type field (like `shapes`' shapeId or `paper`'s grain) is threaded through every cache at
 *  once, instead of being added to some keys and silently missed in others. Callers that also key
 *  on tile SIZE append their own `|WxH`. (The vertical atlas in fills.ts uses a different
 *  `:`-separated multi-fill format and intentionally does NOT use this.) */
export function fillTileKey(fill: Fill): string {
  const extra = fill.type === 'shapes'
    ? (fill.shapeId ?? 'sparkle') + ':' + fill.shapeSize + ':' + fill.shapeGap + ':' + (fill.shapeFit ?? 'tile')
    : fill.type === 'paper'
    ? String(fill.grain ?? 0.4)
    : ''
  return `${fill.type}|${fill.a}|${fill.b}|${fill.angle}|${fill.density}|${extra}`
}

/**
 * Build a tileable 2D canvas for a fill — the CPU companion to the THREE texture path.
 * `solid` returns a flat swatch; `gradient` a vertical A→B ramp; the rest reuse the same
 * pixel pickers as the GPU textures so the look matches. `shader` has no CPU renderer yet,
 * so it degrades to its `input` fill via `effectiveTileFill` (see there).
 */
export function fillTileCanvas(fillIn: Fill, size = 128): HTMLCanvasElement {
  const fill = effectiveTileFill(fillIn)
  const c = document.createElement('canvas'); c.width = size; c.height = size
  const ctx = c.getContext('2d')!
  if (fill.type === 'solid') { ctx.fillStyle = fill.a; ctx.fillRect(0, 0, size, size); return c }
  if (fill.type === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, 0, size); g.addColorStop(0, fill.a); g.addColorStop(1, fill.b)
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size); return c
  }
  if (fill.type === 'ombre') {
    ctx.putImageData(patternImageData(size, size, hexBytes(fill.a), hexBytes(fill.b), ombrePicker(size, size, fill.angle)), 0, 0)
    return c
  }
  if (fill.type === 'grid') {
    const d = Math.max(1, Math.round(fill.density)), step = size / d
    ctx.fillStyle = fill.a; ctx.fillRect(0, 0, size, size)
    ctx.strokeStyle = fill.b; ctx.lineWidth = Math.max(1, Math.round(6 * (3 / d)))
    for (let i = 0; i <= d; i++) {
      ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step, size); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, i * step); ctx.lineTo(size, i * step); ctx.stroke()
    }
    return c
  }
  if (fill.type === 'shapes') { paintShapesTile(ctx, fill, size, size); return c }
  if (fill.type === 'paper') { paintPaperTile(ctx, fill, size, size); return c }
  const colA = hexBytes(fill.a), colB = hexBytes(fill.b), d = Math.max(2, Math.round(fill.density))
  // The swatch keeps its own `max(2, …)` density floor (which predates the box
  // tile's `max(1, …)`), but WHICH cell is `b` comes from the shared predicates
  // above — that rule, not the cell size, is what the export has to reproduce.
  const step = size / d
  const picker: (px: number, py: number) => boolean =
    fill.type === 'checkerboard' ? (px, py) => checkerCellIsB(Math.floor(px / step), Math.floor(py / step))
    : fill.type === 'stripes' ? (() => {
        const rad = (fill.angle * Math.PI) / 180, dx = Math.cos(rad), dy = Math.sin(rad)
        return (px: number, py: number) => stripeBandIsB(Math.floor((px * dx + py * dy) / step))
      })()
    : fill.type === 'noise' ? (px, py) => { const h = Math.sin(px * 12.9898 + py * 78.233) * 43758.5453; return (h - Math.floor(h)) >= 0.5 }
    : (px, py) => qrCellIsB(Math.floor(px / step), Math.floor(py / step))
  ctx.putImageData(patternImageData(size, size, colA, colB, picker), 0, 0)
  return c
}

/**
 * Box-aware tile: build a (w×h) tile sized to a shape's actual on-screen pixels, so
 * the fill stays CRISP (no upscaling a 128px tile) and patterns use SQUARE cells
 * (cell px = w/density, applied on both axes) so they never stretch on a non-square
 * shape. `gradient` honours `angle` here (the square `fillTileCanvas` is vertical-only);
 * `ombre` fades across the box at its angle. `shader` degrades to its `input` fill, same as
 * `fillTileCanvas` above. Used by the compositor's resolveFill.
 */
export function fillTileBox(fillIn: Fill, w: number, h: number): HTMLCanvasElement {
  const fill = effectiveTileFill(fillIn)
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h))
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const ctx = c.getContext('2d')!
  if (fill.type === 'solid') { ctx.fillStyle = fill.a; ctx.fillRect(0, 0, W, H); return c }
  if (fill.type === 'gradient') {
    // Corner-origin: the unit axis scaled onto the tile. Was `W/2 ± cos·W/2`
    // written out here, which is the same arithmetic — the shared helper is what
    // makes the SVG export the same GEOMETRY rather than the same intention.
    const ax = gradientUnitAxis(fill.angle)
    const g = ctx.createLinearGradient(ax.x1 * W, ax.y1 * H, ax.x2 * W, ax.y2 * H)
    g.addColorStop(0, fill.a); g.addColorStop(1, fill.b)
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); return c
  }
  if (fill.type === 'ombre') {
    ctx.putImageData(patternImageData(W, H, hexBytes(fill.a), hexBytes(fill.b), ombrePicker(W, H, fill.angle)), 0, 0)
    return c
  }
  if (fill.type === 'shapes') { paintShapesTile(ctx, fill, W, H); return c }
  if (fill.type === 'paper') { paintPaperTile(ctx, fill, W, H); return c }
  // THE cell edge, and the same call the `<pattern>` emitter makes with the box
  // in document units — see `fillPatternCell`, including why it no longer rounds.
  const cell = fillPatternCell(W, fill.density)
  if (fill.type === 'grid') {
    ctx.fillStyle = fill.a; ctx.fillRect(0, 0, W, H)
    ctx.strokeStyle = fill.b; ctx.lineWidth = gridLineWidth(cell)
    for (let x = 0; x <= W + cell; x += cell) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke() }
    for (let y = 0; y <= H + cell; y += cell) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke() }
    return c
  }
  const colA = hexBytes(fill.a), colB = hexBytes(fill.b)
  const picker: (px: number, py: number) => boolean =
    fill.type === 'checkerboard' ? (px, py) => checkerCellIsB(Math.floor(px / cell), Math.floor(py / cell))
    : fill.type === 'stripes' ? (() => {
        const rad = (fill.angle * Math.PI) / 180, dx = Math.cos(rad), dy = Math.sin(rad)
        return (px: number, py: number) => stripeBandIsB(Math.floor((px * dx + py * dy) / cell))
      })()
    : fill.type === 'noise' ? (px, py) => { const v = Math.sin(px * 12.9898 + py * 78.233) * 43758.5453; return (v - Math.floor(v)) >= 0.5 }
    : (px, py) => qrCellIsB(Math.floor(px / cell), Math.floor(py / cell))
  ctx.putImageData(patternImageData(W, H, colA, colB, picker), 0, 0)
  return c
}
