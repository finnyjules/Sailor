/**
 * Post-processing effects for the Compositor — pure kernels + the canvas
 * effect chain shared by per-layer rendering (paintLayer) and the doc-level
 * post stack (paintLayerStack). Spatial params are normalized to canvas
 * width; `opts.W` is the logical width, `opts.scale` device px per logical px.
 *
 * Fixed chain order (applyEffectChain is the single source of truth):
 *   adjust → duotone → gradientMap → bloom → vignette → grain
 */

export interface AdjustEffect {
  type: 'adjust'
  brightness: number  // 1 = neutral, CSS brightness() multiplier, 0..2
  contrast: number    // 1 = neutral, 0..2
  saturation: number  // 1 = neutral, 0..2
  hue: number         // degrees, -180..180, 0 = neutral
  visible: boolean
}
export interface BloomEffect {
  type: 'bloom'
  threshold: number   // 0..1 — luminance cutoff for the bright pass
  radius: number      // blur radius, normalized to canvas width
  intensity: number   // 0..2 — strength of the additive composite
  visible: boolean
}
export interface GrainEffect {
  type: 'grain'
  amount: number      // 0..1 — composite alpha
  size: number        // 1..8 — noise texel scale
  visible: boolean
}
export interface VignetteEffect {
  type: 'vignette'
  amount: number      // 0..1 — darkening strength
  size: number        // 0..1 — inner radius where falloff starts
  softness: number    // 0..1 — falloff width
  visible: boolean
}
export interface DuotoneEffect {
  type: 'duotone'
  shadows: string     // hex colour mapped to luminance 0
  highlights: string  // hex colour mapped to luminance 1
  mix: number         // 0..1 — blend between original and duotone result
  visible: boolean
}
export interface GradientMapStop { pos: number; color: string }
export interface GradientMapEffect {
  type: 'gradientMap'
  stops: GradientMapStop[]  // {pos 0..1, hex}; sorted at apply; >= 1 stop
  contrast: number          // -1..1, 0 = neutral (luminance stretch around 0.5)
  mix: number               // 0..1 — blend original -> mapped
  visible: boolean
}
/** Depth of field. GPU-only — applied to layer content BEFORE the 2D chain, because
 *  defocus happens at the lens (grain is on the negative, vignette is the barrel).
 *  Needs a depth map; renders through untouched without one. */
export interface DofEffect {
  type: 'dof'
  focus: number          // 0..1 — normalized depth of the focal plane
  range: number          // 0..1 — depth band that stays sharp
  aperture: number       // 0..1 — max blur radius, NORMALIZED TO CANVAS WIDTH
  bladeCount: number     // 0..12 — iris sides; < 3 renders a circle
  bladeRotation: number  // 0..360 degrees
  bloomThreshold: number // 0..1 — linear-light luminance cutoff
  bloomStrength: number  // 0..4 — highlight boost before accumulation
  visible: boolean
}
/** A blurred, tinted halo OUTSIDE the layer's alpha, composited BEHIND it (destination-over).
 *  Built from the layer silhouette, blurred by `radius`, filled with `color` × `intensity`. */
export interface OuterGlowEffect {
  type: 'outer_glow'
  color: string       // hex/rgba (alpha allowed) — the halo colour
  radius: number      // blur radius / spread, normalized to canvas width
  intensity: number   // 0..2 — strength of the composite
  visible: boolean
}
/** The same blurred, tinted halo but INSIDE the layer's alpha, clipped to it (source-atop).
 *  Bleeds inward from the silhouette edge. */
export interface InnerGlowEffect {
  type: 'inner_glow'
  color: string       // hex/rgba (alpha allowed) — the halo colour
  radius: number      // blur radius / spread, normalized to canvas width
  intensity: number   // 0..2 — strength of the composite
  visible: boolean
}
/** A small curated set of real blend modes an overlay may composite through. Each maps to a
 *  `GlobalCompositeOperation`: `normal`→`source-over`, the rest are valid canvas blend ops by
 *  the same name. Kept short on purpose — a full 16-mode menu is a dead-control trap. */
export const OVERLAY_BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'soft-light'] as const
export type OverlayBlend = typeof OVERLAY_BLENDS[number]
/** Coerce an arbitrary stored value to a known blend, mirroring `booleanOpOf`. */
export function overlayBlendOf(v: unknown): OverlayBlend {
  return (OVERLAY_BLENDS as readonly string[]).includes(v as string) ? (v as OverlayBlend) : 'normal'
}
/** The canvas composite op for a blend — `normal` is plain source-over, the rest are the
 *  identically-named canvas blend modes. */
function overlayCompositeOp(b: OverlayBlend): GlobalCompositeOperation {
  return b === 'normal' ? 'source-over' : (b as GlobalCompositeOperation)
}

/** A flat colour painted over the layer at a blend + opacity, CLIPPED to the layer's alpha
 *  (source-atop semantics) — never grows outside the silhouette. */
export interface ColorOverlayEffect {
  type: 'color_overlay'
  color: string        // hex — the overlay colour
  blend: OverlayBlend  // how it composites onto the layer
  opacity: number      // 0..1 — composite strength
  visible: boolean
}
/** A two-colour linear gradient (`from`→`to`) at `angle` over the layer bounds, at a blend +
 *  opacity, CLIPPED to the layer's alpha. v1 is deliberately from/to only — a multi-stop editor
 *  with nowhere to edit the stops would be a dead control. */
export interface GradientOverlayEffect {
  type: 'gradient_overlay'
  from: string         // hex — gradient start colour
  to: string           // hex — gradient end colour
  angle: number        // 0..360 degrees, over the offscreen's own box
  blend: OverlayBlend
  opacity: number      // 0..1 — composite strength
  visible: boolean
}
/** Where the alpha-traced stroke sits relative to the layer's OWN silhouette edge. `inside`
 *  bands the full width WITHIN the alpha, `outside` the full width BEYOND it, `center` straddles
 *  it half in / half out. Kept small on purpose, mirroring OVERLAY_BLENDS. */
export const STROKE_ALPHA_ALIGNS = ['inside', 'center', 'outside'] as const
export type StrokeAlphaAlign = typeof STROKE_ALPHA_ALIGNS[number]
/** Coerce an arbitrary stored value to a known align, mirroring `overlayBlendOf`/`booleanOpOf`
 *  (invalid → 'center'). */
export function strokeAlphaAlignOf(v: unknown): StrokeAlphaAlign {
  return (STROKE_ALPHA_ALIGNS as readonly string[]).includes(v as string) ? (v as StrokeAlphaAlign) : 'center'
}
/** The band's reach from the alpha EDGE, in px, for a stroke of `widthPx` on the chosen side:
 *  `outerPx` = how far it extends OUTSIDE the silhouette (built by DILATION), `innerPx` = how far
 *  INSIDE (built by EROSION). inside = [edge−width, edge], center = [edge−width/2, edge+width/2],
 *  outside = [edge, edge+width]. Pure + exported so a test can prove the align math and the
 *  outward growth without a canvas. */
export function strokeAlphaBand(widthPx: number, align: StrokeAlphaAlign): { outerPx: number; innerPx: number } {
  const w = Math.max(0, Number.isFinite(widthPx) ? widthPx : 0)
  if (align === 'inside') return { outerPx: 0, innerPx: w }
  if (align === 'outside') return { outerPx: w, innerPx: 0 }
  return { outerPx: w / 2, innerPx: w / 2 }
}

/** A stroke traced from the layer's OWN rasterised alpha edge — works on ANY layer (image /
 *  brush / shape), reading the raster silhouette, NOT a vector outline (distinct from the vector
 *  stroke stack). The band is `width·W` px wide at the edge, placed by `align`, filled with
 *  `color`. `outside`/`center` grow OUTSIDE the alpha (folded into the offscreen pad via
 *  `strokeAlphaOutwardPx`). Deterministic: a fixed-count ring dilation, no randomness. */
export interface StrokeFromAlphaEffect {
  type: 'stroke_from_alpha'
  width: number             // stroke width, normalized to canvas width
  align: StrokeAlphaAlign   // inside | center | outside, relative to the alpha edge
  color: string             // hex/rgba (alpha allowed) — the stroke colour
  visible: boolean
}
/** Linear motion blur: smear the layer along `angle` for `distance·W` px, as a multi-tap
 *  accumulation centred on the shape (so it blurs in place without drifting). Grows OUTSIDE the
 *  alpha along the axis (folded into the offscreen pad via `motionBlurOutwardPx`). Deterministic:
 *  a fixed tap count, no randomness. */
export interface DirectionalBlurEffect {
  type: 'directional_blur'
  angle: number       // 0..360 degrees — the smear direction
  distance: number    // total smear length, normalized to canvas width
  visible: boolean
}
/** Spin blur: rotate the layer about `(centerX, centerY)` (fractions of the box) back and forth
 *  by `amount`, accumulated over a fixed tap count. Grows OUTSIDE the alpha by a fraction of the
 *  layer extent (folded into the offscreen pad). Deterministic: no randomness. */
export interface RadialBlurEffect {
  type: 'radial_blur'
  centerX: number     // 0..1 — spin centre X, fraction of the offscreen box
  centerY: number     // 0..1 — spin centre Y, fraction of the offscreen box
  amount: number      // 0..1 — spin strength
  visible: boolean
}
/** Zoom blur: scale the layer about `(centerX, centerY)` in and out by `amount`, accumulated over
 *  a fixed tap count, so the shape radiates from the centre. Grows OUTSIDE the alpha by a fraction
 *  of the layer extent (folded into the offscreen pad). Deterministic: no randomness. */
export interface ZoomBlurEffect {
  type: 'zoom_blur'
  centerX: number     // 0..1 — zoom centre X, fraction of the offscreen box
  centerY: number     // 0..1 — zoom centre Y, fraction of the offscreen box
  amount: number      // 0..1 — radiating strength
  visible: boolean
}
/** Levels: remap the tonal range per channel. `black`/`white` (0..1) set the input range mapped
 *  to full black / full white; `gamma` (0.1..5) bends the midtones (>1 lightens, <1 darkens). RGB
 *  only, alpha untouched (the op is clipped to the layer). Identity at black 0 / white 1 / gamma 1.
 *  Deterministic. */
export interface LevelsEffect {
  type: 'levels'
  black: number       // 0..1 — input level mapped to output 0
  white: number       // 0..1 — input level mapped to output 255
  gamma: number       // 0.1..5 — midtone bend (1 = neutral)
  visible: boolean
}
/** Posterise: quantise each channel to `levels` evenly-spaced steps (2..32), flattening the
 *  gradients into bands. RGB only, alpha untouched. Deterministic. */
export interface PosteriseEffect {
  type: 'posterise'
  levels: number      // 2..32 — steps per channel (integer; rounded in the pass)
  visible: boolean
}
/** Threshold: drive every pixel to black or white by whether its luminance clears `cutoff`
 *  (0..1). RGB only, alpha untouched. Deterministic. */
export interface ThresholdEffect {
  type: 'threshold'
  cutoff: number      // 0..1 — luminance split point
  visible: boolean
}
/** Invert: mix each channel toward its inverse (255−v) by `amount` — 0 = off, 1 = full invert,
 *  0.5 = the midpoint. RGB only, alpha untouched. Deterministic. */
export interface InvertEffect {
  type: 'invert'
  amount: number      // 0..1 — how far toward the inverted colour
  visible: boolean
}
export type PostEffect = AdjustEffect | BloomEffect | GrainEffect | VignetteEffect | DuotoneEffect | GradientMapEffect | DofEffect | OuterGlowEffect | InnerGlowEffect | ColorOverlayEffect | GradientOverlayEffect | StrokeFromAlphaEffect | DirectionalBlurEffect | RadialBlurEffect | ZoomBlurEffect | LevelsEffect | PosteriseEffect | ThresholdEffect | InvertEffect

export const POST_EFFECT_DEFAULTS: Record<PostEffect['type'], PostEffect> = {
  adjust: { type: 'adjust', brightness: 1, contrast: 1, saturation: 1, hue: 0, visible: true },
  bloom: { type: 'bloom', threshold: 0.6, radius: 0.02, intensity: 0.8, visible: true },
  grain: { type: 'grain', amount: 0.25, size: 2, visible: true },
  vignette: { type: 'vignette', amount: 0.5, size: 0.5, softness: 0.5, visible: true },
  duotone: { type: 'duotone', shadows: '#1a1a40', highlights: '#ffe8d6', mix: 1, visible: true },
  gradientMap: {
    type: 'gradientMap',
    stops: [{ pos: 0, color: '#1a1a40' }, { pos: 0.5, color: '#c0397a' }, { pos: 1, color: '#ffe8d6' }],
    contrast: 0, mix: 0.85, visible: true,
  },
  dof: {
    type: 'dof', focus: 0.5, range: 0.15, aperture: 0.02,
    bladeCount: 6, bladeRotation: 0, bloomThreshold: 0.75, bloomStrength: 1.5,
    visible: true,
  },
  // A soft warm glow, visible the moment it is added; the colour card + dials tune it.
  outer_glow: { type: 'outer_glow', color: '#ffd9a0', radius: 0.02, intensity: 0.8, visible: true },
  inner_glow: { type: 'inner_glow', color: '#ffd9a0', radius: 0.02, intensity: 0.8, visible: true },
  // A mid grey multiplied over the layer — visibly tints the moment it is added; the colour
  // card + blend + opacity tune it.
  color_overlay: { type: 'color_overlay', color: '#808080', blend: 'multiply', opacity: 1, visible: true },
  // Two contrasting colours across the box at 0°, plainly overlaid — the gradient reads at once.
  gradient_overlay: { type: 'gradient_overlay', from: '#ff5b5b', to: '#4f8ad9', angle: 0, blend: 'normal', opacity: 1, visible: true },
  // A thin dark stroke straddling the alpha edge — visible the moment it is added; width, align
  // and colour tune it.
  stroke_from_alpha: { type: 'stroke_from_alpha', width: 0.006, align: 'center', color: '#111111', visible: true },
  // A short horizontal smear, plainly readable the moment it is added; angle + distance tune it.
  directional_blur: { type: 'directional_blur', angle: 0, distance: 0.03, visible: true },
  // A spin / zoom about the centre at a visible strength; the centre + amount tune each.
  radial_blur: { type: 'radial_blur', centerX: 0.5, centerY: 0.5, amount: 0.3, visible: true },
  zoom_blur: { type: 'zoom_blur', centerX: 0.5, centerY: 0.5, amount: 0.3, visible: true },
  // Identity by default (black 0 / white 1 / gamma 1) — the dials do the work once the user
  // touches them; a levels effect added at rest changes nothing.
  levels: { type: 'levels', black: 0, white: 1, gamma: 1, visible: true },
  // Six steps — plainly banded the moment it is added.
  posterise: { type: 'posterise', levels: 6, visible: true },
  // A mid split — a stark black/white the moment it is added.
  threshold: { type: 'threshold', cutoff: 0.5, visible: true },
  // Full invert — visibly flips the colours the moment it is added; amount tunes it.
  invert: { type: 'invert', amount: 1, visible: true },
}
export function defaultPostEffect(type: PostEffect['type']): PostEffect {
  return JSON.parse(JSON.stringify(POST_EFFECT_DEFAULTS[type])) as PostEffect
}

/** Shared param bounds — the panel sliders and the agent's sanitizer both obey these. */
export const POST_FX_PARAM_CLAMP: Record<string, Record<string, [number, number]>> = {
  adjust: { brightness: [0, 2], contrast: [0, 2], saturation: [0, 2], hue: [-180, 180] },
  bloom: { threshold: [0, 1], radius: [0, 0.5], intensity: [0, 2] },
  grain: { amount: [0, 1], size: [1, 8] },
  vignette: { amount: [0, 1], size: [0, 1], softness: [0, 1] },
  duotone: { mix: [0, 1] },
  gradientMap: { contrast: [-1, 1], mix: [0, 1] },
  dof: {
    focus: [0, 1], range: [0, 1], aperture: [0, 1],
    bladeCount: [0, 12], bladeRotation: [0, 360],
    bloomThreshold: [0, 1], bloomStrength: [0, 4],
  },
  // `color` is non-numeric, so it is not clamped (matches duotone's colours).
  outer_glow: { radius: [0, 0.5], intensity: [0, 2] },
  inner_glow: { radius: [0, 0.5], intensity: [0, 2] },
  // Colours (`color`/`from`/`to`) and `blend` are non-numeric, so only the numeric dials clamp.
  color_overlay: { opacity: [0, 1] },
  gradient_overlay: { opacity: [0, 1], angle: [0, 360] },
  // `color` and `align` are non-numeric, so only `width` clamps (agent whitelist for the two is Task 8).
  stroke_from_alpha: { width: [0, 0.2] },
  // Every motion-blur param is numeric, so the generic sanitizer drives all three fully —
  // no Task-8 whitelist is needed for this family.
  directional_blur: { angle: [0, 360], distance: [0, 0.2] },
  radial_blur: { centerX: [0, 1], centerY: [0, 1], amount: [0, 1] },
  zoom_blur: { centerX: [0, 1], centerY: [0, 1], amount: [0, 1] },
  // Every tone-op param is numeric, so the generic sanitizer drives all four fully — no Task-8
  // whitelist is needed for this family. `levels` is an integer step count (rounded in the pass).
  levels: { black: [0, 1], white: [0, 1], gamma: [0.1, 5] },
  posterise: { levels: [2, 32] },
  threshold: { cutoff: [0, 1] },
  invert: { amount: [0, 1] },
}

const CHAIN_TYPES = new Set<string>(['adjust', 'duotone', 'gradientMap', 'bloom', 'vignette', 'grain', 'outer_glow', 'inner_glow', 'color_overlay', 'gradient_overlay', 'stroke_from_alpha', 'directional_blur', 'radial_blur', 'zoom_blur', 'levels', 'posterise', 'threshold', 'invert'])
export const isChainEffect = (e: { type: string }): e is PostEffect => CHAIN_TYPES.has(e.type)
export const chainActive = (effects?: { type: string; visible?: boolean }[]): boolean =>
  !!effects?.some(e => e.visible !== false && CHAIN_TYPES.has(e.type))

/** GPU-stage effects. Deliberately DISJOINT from CHAIN_TYPES: applyEffectChain must
 *  never see these, or they'd be silently skipped while appearing to be handled. */
export const GPU_TYPES = new Set<string>(['dof'])
export const isGpuEffect = (e: { type: string }): e is DofEffect => GPU_TYPES.has(e.type)
export const gpuActive = (effects?: { type: string; visible?: boolean }[]): boolean =>
  !!effects?.some(e => e.visible !== false && GPU_TYPES.has(e.type))

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const clamp01 = (v: number) => clamp(v, 0, 1)

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = (hex || '').replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  if (h.length === 8) h = h.slice(0, 6) // 8-digit hex: strip alpha
  const n = parseInt(h.slice(0, 6), 16)
  if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 }
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/** CSS filter string for an adjust effect — '' when every param is neutral. */
export function adjustFilterString(fx: AdjustEffect): string {
  const b = clamp(fx.brightness ?? 1, 0, 2)
  const c = clamp(fx.contrast ?? 1, 0, 2)
  const s = clamp(fx.saturation ?? 1, 0, 2)
  const h = clamp(fx.hue ?? 0, -180, 180)
  const parts: string[] = []
  if (b !== 1) parts.push(`brightness(${b})`)
  if (c !== 1) parts.push(`contrast(${c})`)
  if (s !== 1) parts.push(`saturate(${s})`)
  if (h !== 0) parts.push(`hue-rotate(${h}deg)`)
  return parts.join(' ')
}

/** Deterministic PRNG bytes (mulberry32) — grain must render identically every
 *  frame/bake or motion sequences shimmer. */
export function noiseBytes(seed: number, count: number): Uint8Array {
  let a = seed >>> 0
  const out = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    out[i] = ((t ^ (t >>> 14)) >>> 0) & 255
  }
  return out
}

/** Bloom bright pass: zero the alpha of every pixel whose luminance is below
 *  threshold. Hard cutoff — the subsequent blur softens the knee. */
export function brightPassInPlace(data: Uint8ClampedArray, threshold: number): void {
  const t = clamp01(threshold) * 255
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    if (lum < t) data[i + 3] = 0
  }
}

/** Gradient-map RGB toward shadows→highlights by luminance; alpha untouched. */
export function duotoneInPlace(
  data: Uint8ClampedArray,
  shadows: { r: number; g: number; b: number },
  highlights: { r: number; g: number; b: number },
  mix: number,
): void {
  const m = clamp01(mix)
  if (m === 0) return
  for (let i = 0; i < data.length; i += 4) {
    const lum = (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255
    data[i] = data[i]! + (shadows.r + (highlights.r - shadows.r) * lum - data[i]!) * m
    data[i + 1] = data[i + 1]! + (shadows.g + (highlights.g - shadows.g) * lum - data[i + 1]!) * m
    data[i + 2] = data[i + 2]! + (shadows.b + (highlights.b - shadows.b) * lum - data[i + 2]!) * m
  }
}

/** Gradient-map RGB by luminance across an arbitrary multi-stop ramp; alpha
 *  untouched. `contrast` (-1..1) stretches luminance around 0.5 before the
 *  lookup; `mix` blends toward the mapped colour. Mirrors gradient_map.frag but
 *  runs on the CPU (a gradient map is cheap; no GPU stage needed). */
export function gradientMapInPlace(
  data: Uint8ClampedArray,
  stops: GradientMapStop[],
  contrast: number,
  mix: number,
): void {
  const m = clamp01(mix)
  if (m === 0 || !stops.length) return
  const ramp = stops.map(s => ({ pos: clamp01(s.pos), rgb: hexToRgb(s.color) }))
    .sort((a, b) => a.pos - b.pos)
  const c = 1 + clamp(contrast, -1, 1)
  const n = ramp.length
  for (let i = 0; i < data.length; i += 4) {
    let lum = (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255
    lum = clamp01((lum - 0.5) * c + 0.5)
    let r: number, g: number, b: number
    if (lum <= ramp[0]!.pos) { r = ramp[0]!.rgb.r; g = ramp[0]!.rgb.g; b = ramp[0]!.rgb.b }
    else if (lum >= ramp[n - 1]!.pos) { r = ramp[n - 1]!.rgb.r; g = ramp[n - 1]!.rgb.g; b = ramp[n - 1]!.rgb.b }
    else {
      let hi = 1
      while (hi < n && ramp[hi]!.pos < lum) hi++
      const a = ramp[hi - 1]!, bb = ramp[hi]!
      const span = bb.pos - a.pos
      const f = span <= 1e-6 ? 0 : (lum - a.pos) / span
      r = a.rgb.r + (bb.rgb.r - a.rgb.r) * f
      g = a.rgb.g + (bb.rgb.g - a.rgb.g) * f
      b = a.rgb.b + (bb.rgb.b - a.rgb.b) * f
    }
    data[i] = data[i]! + (r - data[i]!) * m
    data[i + 1] = data[i + 1]! + (g - data[i + 1]!) * m
    data[i + 2] = data[i + 2]! + (b - data[i + 2]!) * m
  }
}

/** Levels: remap each RGB channel through a black/white/gamma curve, alpha untouched. `black`
 *  and `white` (0..1) set the input window mapped to output 0..255; `gamma` (0.1..5) bends the
 *  midtones (>1 lightens). Builds a 256-entry LUT once, then maps the three colour bytes of every
 *  pixel; the fourth byte (alpha) is never written, so the op stays clipped to the layer. Identity
 *  (black 0 / white 1 / gamma 1) early-returns unchanged. */
export function levelsInPlace(
  data: Uint8ClampedArray,
  { black, white, gamma }: { black: number; white: number; gamma: number },
): void {
  const b = clamp01(black), w = clamp01(white), g = clamp(gamma, 0.1, 5)
  if (b === 0 && w === 1 && g === 1) return
  const denom = Math.max(1e-6, w - b)
  const invG = 1 / g
  const lut = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.round(Math.pow(clamp01((i / 255 - b) / denom), invG) * 255)
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]!]!
    data[i + 1] = lut[data[i + 1]!]!
    data[i + 2] = lut[data[i + 2]!]!
  }
}

/** Posterise: quantise each RGB channel to `levels` (2..32) evenly-spaced steps via a LUT, alpha
 *  untouched. Exactly `levels` distinct output values are possible per channel. */
export function posteriseInPlace(data: Uint8ClampedArray, levels: number): void {
  const n = Math.max(2, Math.min(32, Math.round(Number.isFinite(levels) ? levels : 6)))
  const steps = n - 1
  const lut = new Uint8ClampedArray(256)
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.round((Math.round((i / 255) * steps) / steps) * 255)
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]!]!
    data[i + 1] = lut[data[i + 1]!]!
    data[i + 2] = lut[data[i + 2]!]!
  }
}

/** Threshold: set each pixel to black or white by whether its luminance clears `cutoff` (0..1),
 *  alpha untouched. Every RGB byte becomes 0 or 255. */
export function thresholdInPlace(data: Uint8ClampedArray, cutoff: number): void {
  const t = clamp01(cutoff) * 255
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
    const v = lum >= t ? 255 : 0
    data[i] = v
    data[i + 1] = v
    data[i + 2] = v
  }
}

/** Invert: lerp each RGB channel toward its inverse (255−v) by `amount` (0..1), alpha untouched.
 *  amount 0 early-returns unchanged; amount 1 is a full invert; 0.5 lands on the 127.5 midpoint. */
export function invertInPlace(data: Uint8ClampedArray, amount: number): void {
  const a = clamp01(amount)
  if (a === 0) return
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i]! + (255 - 2 * data[i]!) * a
    data[i + 1] = data[i + 1]! + (255 - 2 * data[i + 1]!) * a
    data[i + 2] = data[i + 2]! + (255 - 2 * data[i + 2]!) * a
  }
}

/** Radial-gradient stops (fractions of the half-diagonal) for a vignette.
 *  softness 0 still keeps a minimal ramp so the edge never bands. */
export function vignetteStops(size: number, softness: number): { inner: number; outer: number } {
  const inner = clamp01(size)
  const outer = Math.min(1.5, inner + Math.max(0.02, clamp01(softness)))
  return { inner, outer }
}

// ── Canvas chain (appended to frontend/app/lib/compositor/postEffects.ts) ────

function mkCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}
function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = mkCanvas(src.width, src.height)
  c.getContext('2d')?.drawImage(src, 0, 0)
  return c
}

// Cached 128×128 mid-gray noise tile. Fixed seed: grain must be identical
// across renders/bakes (motion frames would shimmer otherwise).
let _grainTile: HTMLCanvasElement | null = null
export function grainTile(): HTMLCanvasElement {
  if (_grainTile) return _grainTile
  const N = 128
  const c = mkCanvas(N, N)
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(N, N)
  const bytes = noiseBytes(0x5a1108, N * N)
  for (let i = 0; i < N * N; i++) {
    const v = bytes[i]!
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  _grainTile = c
  return c
}

type PassOpts = { W: number; scale?: number }

function passAdjust(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: AdjustEffect, _opts: PassOpts): void {
  const f = adjustFilterString(e)
  if (!f) return
  const src = cloneCanvas(off)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, off.width, off.height)
  ctx.filter = f
  ctx.drawImage(src, 0, 0)
  ctx.restore()
}

function passDuotone(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: DuotoneEffect, _opts: PassOpts): void {
  if (!(e.mix > 0)) return
  const img = ctx.getImageData(0, 0, off.width, off.height)
  duotoneInPlace(img.data, hexToRgb(e.shadows), hexToRgb(e.highlights), e.mix)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(img, 0, 0)
  ctx.restore()
}

function passGradientMap(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: GradientMapEffect, _opts: PassOpts): void {
  if (!(e.mix > 0 && e.stops.length)) return
  const img = ctx.getImageData(0, 0, off.width, off.height)
  gradientMapInPlace(img.data, e.stops, e.contrast, e.mix)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(img, 0, 0)
  ctx.restore()
}

function passLevels(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: LevelsEffect, _opts: PassOpts): void {
  const black = clamp01(e.black ?? 0), white = clamp01(e.white ?? 1), gamma = clamp(e.gamma ?? 1, 0.1, 5)
  if (black === 0 && white === 1 && gamma === 1) return // identity — nothing to do
  const img = ctx.getImageData(0, 0, off.width, off.height)
  levelsInPlace(img.data, { black, white, gamma })
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(img, 0, 0)
  ctx.restore()
}

function passPosterise(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: PosteriseEffect, _opts: PassOpts): void {
  const img = ctx.getImageData(0, 0, off.width, off.height)
  posteriseInPlace(img.data, e.levels ?? 6)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(img, 0, 0)
  ctx.restore()
}

function passThreshold(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: ThresholdEffect, _opts: PassOpts): void {
  const img = ctx.getImageData(0, 0, off.width, off.height)
  thresholdInPlace(img.data, e.cutoff ?? 0.5)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(img, 0, 0)
  ctx.restore()
}

function passInvert(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: InvertEffect, _opts: PassOpts): void {
  const a = clamp01(e.amount ?? 1)
  if (!(a > 0)) return // amount 0 = identity
  const img = ctx.getImageData(0, 0, off.width, off.height)
  invertInPlace(img.data, a)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.putImageData(img, 0, 0)
  ctx.restore()
}

function passBloom(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: BloomEffect, opts: PassOpts): void {
  if (!(e.intensity > 0 && e.radius > 0)) return
  const scale = opts.scale ?? 1
  const bp = cloneCanvas(off)
  const bctx = bp.getContext('2d')
  if (bctx) {
    const img = bctx.getImageData(0, 0, bp.width, bp.height)
    brightPassInPlace(img.data, e.threshold)
    bctx.putImageData(img, 0, 0)
    const blurred = mkCanvas(off.width, off.height)
    const blctx = blurred.getContext('2d')
    if (blctx) {
      blctx.filter = `blur(${Math.max(0, e.radius * opts.W * scale)}px)`
      blctx.drawImage(bp, 0, 0)
      blctx.filter = 'none'
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'lighter'
      const k = Math.min(2, Math.max(0, e.intensity))
      ctx.globalAlpha = Math.min(1, k)
      ctx.drawImage(blurred, 0, 0)
      if (k > 1) { ctx.globalAlpha = k - 1; ctx.drawImage(blurred, 0, 0) }
      ctx.restore()
    }
  }
}

function passVignette(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: VignetteEffect, _opts: PassOpts): void {
  if (!(e.amount > 0)) return
  const w = off.width, h = off.height
  const R = Math.hypot(w, h) / 2
  const { inner, outer } = vignetteStops(e.size, e.softness)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  // source-atop = clip to existing alpha, so a per-layer vignette never
  // halos beyond the silhouette (doc snapshots are opaque where content is).
  ctx.globalCompositeOperation = 'source-atop'
  const g = ctx.createRadialGradient(w / 2, h / 2, inner * R, w / 2, h / 2, outer * R)
  g.addColorStop(0, 'rgba(0,0,0,0)')
  g.addColorStop(1, `rgba(0,0,0,${Math.min(1, Math.max(0, e.amount))})`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  ctx.restore()
}

function passGrain(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: GrainEffect, opts: PassOpts): void {
  if (!(e.amount > 0)) return
  const scale = opts.scale ?? 1
  const gc = mkCanvas(off.width, off.height)
  const gctx = gc.getContext('2d')
  if (gctx) {
    const pat = gctx.createPattern(grainTile(), 'repeat')
    if (pat) {
      const s = Math.max(1, e.size) * scale
      gctx.save()
      gctx.scale(s, s)
      gctx.fillStyle = pat
      gctx.fillRect(0, 0, gc.width / s, gc.height / s)
      gctx.restore()
      gctx.globalCompositeOperation = 'destination-in'
      gctx.drawImage(off, 0, 0) // clip noise to the layer/content alpha
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'overlay'
      ctx.globalAlpha = Math.min(1, Math.max(0, e.amount))
      ctx.drawImage(gc, 0, 0)
      ctx.restore()
    }
  }
}

/** Outer glow: a blurred, tinted copy of the layer SILHOUETTE composited BEHIND the layer.
 *  Recolour the offscreen's own alpha to `color` (source-in), blur it by `radius`, then draw it
 *  UNDER the layer (destination-over) at `intensity`. It grows OUTSIDE the alpha; on a box-sized
 *  raster it relies on the offscreen's outward pad (see `outerGlowOutwardPx` in
 *  useCompositorLayers.ts), but on the per-layer path here `off` is the full device canvas.
 *  Deterministic: no randomness. */
function passOuterGlow(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: OuterGlowEffect, opts: PassOpts): void {
  if (!(e.intensity > 0 && e.radius > 0)) return
  const scale = opts.scale ?? 1
  const scratch = cloneCanvas(off)            // the layer's own pixels + alpha
  const sctx = scratch.getContext('2d')
  if (!sctx) return
  // Recolour to the glow colour, keeping the silhouette alpha (source-in fill).
  sctx.save()
  sctx.setTransform(1, 0, 0, 1, 0, 0)
  sctx.globalCompositeOperation = 'source-in'
  sctx.fillStyle = e.color || '#ffffff'
  sctx.fillRect(0, 0, scratch.width, scratch.height)
  sctx.restore()
  applyBlurPass(scratch, Math.max(0, e.radius * opts.W * scale))
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  // destination-over = paint the halo BEHIND everything already on the offscreen.
  ctx.globalCompositeOperation = 'destination-over'
  const k = Math.min(2, Math.max(0, e.intensity))
  ctx.globalAlpha = Math.min(1, k)
  ctx.drawImage(scratch, 0, 0)
  if (k > 1) { ctx.globalAlpha = k - 1; ctx.drawImage(scratch, 0, 0) }
  ctx.restore()
}

/** Inner glow: a blurred, tinted halo hugging the INSIDE of the silhouette edge, clipped to the
 *  layer alpha. Fill a scratch with `color` everywhere, knock the layer's alpha OUT of it
 *  (destination-out) so the tint remains only OUTSIDE the silhouette, blur it so it bleeds back
 *  across the edge, then draw it clipped to the layer (source-atop) at `intensity`. Stays within
 *  bounds. Deterministic: no randomness. */
function passInnerGlow(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: InnerGlowEffect, opts: PassOpts): void {
  if (!(e.intensity > 0 && e.radius > 0)) return
  const scale = opts.scale ?? 1
  const scratch = mkCanvas(off.width, off.height)
  const sctx = scratch.getContext('2d')
  if (!sctx) return
  sctx.save()
  sctx.setTransform(1, 0, 0, 1, 0, 0)
  sctx.fillStyle = e.color || '#ffffff'
  sctx.fillRect(0, 0, scratch.width, scratch.height)
  // Remove the layer's own silhouette, leaving tint only OUTSIDE it — the edge source.
  sctx.globalCompositeOperation = 'destination-out'
  sctx.drawImage(off, 0, 0)
  sctx.restore()
  applyBlurPass(scratch, Math.max(0, e.radius * opts.W * scale))
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  // source-atop = keep only the part of the blurred tint that lands ON the layer's alpha.
  ctx.globalCompositeOperation = 'source-atop'
  const k = Math.min(2, Math.max(0, e.intensity))
  ctx.globalAlpha = Math.min(1, k)
  ctx.drawImage(scratch, 0, 0)
  if (k > 1) { ctx.globalAlpha = k - 1; ctx.drawImage(scratch, 0, 0) }
  ctx.restore()
}

/** Endpoints of the gradient axis across a `w×h` box for a given `angle` (degrees), centred and
 *  spanning the box's full projection onto that direction so the ramp always covers the box.
 *  Pure + deterministic; exported so a test can prove the direction is consumed. */
export function gradientOverlayAxis(w: number, h: number, angle: number): { x0: number; y0: number; x1: number; y1: number } {
  const a = ((angle % 360) + 360) % 360 * Math.PI / 180
  const dx = Math.cos(a), dy = Math.sin(a)
  const cx = w / 2, cy = h / 2
  const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2
  return { x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half }
}

// ── Motion blur (directional / radial / zoom): shared tap accumulation ────────────────────
/** Fixed tap count for every motion-blur pass — deterministic (no randomness), and enough
 *  samples that the smear reads smooth without becoming costly. */
export const MOTION_BLUR_SAMPLES = 14
/** Full angular swing (radians) a `radial_blur` spins through at `amount` 1 — split half each way
 *  about the tap midpoint. ~34°, a strong but not dizzying spin. */
export const RADIAL_BLUR_MAX_ANGLE = 0.6
/** Full scale swing a `zoom_blur` radiates through at `amount` 1 (scales span 1±0.15) — split
 *  half each way about the tap midpoint. */
export const ZOOM_BLUR_MAX_SCALE = 0.3

/** The centred multiplier for tap `i` of `n`: `(i + 0.5) / n − 0.5`, symmetric about 0 so the
 *  accumulation blurs IN PLACE (the extreme taps are ±`motionSampleSpan(n)`, equal and opposite,
 *  so the shape never drifts). Pure + exported so a test can prove the centring. */
export function motionTapMultipliers(n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push((i + 0.5) / n - 0.5)
  return out
}
/** The magnitude of the OUTERMOST centred tap multiplier for `n` taps — `0.5 − 0.5/n`. The pass
 *  reaches this fraction of its full swing at the extremes, so the outward-pad math and the pass
 *  read the same number. */
export function motionSampleSpan(n: number): number {
  return n > 0 ? Math.max(0, (n - 1) / (2 * n)) : 0
}

/** Per-tap pixel offsets for a directional blur of `distancePx` along `angleDeg`, centred so the
 *  taps straddle the shape (Σ ≈ 0). Pure + deterministic; exported so a test can prove distance +
 *  angle are consumed and 0 distance is the identity. */
export function directionalBlurTaps(angleDeg: number, distancePx: number, n: number): { dx: number; dy: number }[] {
  const a = ((((angleDeg || 0) % 360) + 360) % 360) * Math.PI / 180
  const ux = Math.cos(a), uy = Math.sin(a)
  const d = Math.max(0, Number.isFinite(distancePx) ? distancePx : 0)
  return motionTapMultipliers(n).map(m => ({ dx: ux * d * m, dy: uy * d * m }))
}
/** Per-tap rotation angles (radians) for a radial (spin) blur of `amount`, centred about 0. */
export function radialBlurTaps(amount: number, n: number): number[] {
  const swing = clamp01(amount) * RADIAL_BLUR_MAX_ANGLE
  return motionTapMultipliers(n).map(m => swing * m)
}
/** Per-tap scale factors for a zoom blur of `amount`, centred about 1. */
export function zoomBlurTaps(amount: number, n: number): number[] {
  const swing = clamp01(amount) * ZOOM_BLUR_MAX_SCALE
  return motionTapMultipliers(n).map(m => 1 + swing * m)
}

/** Colour overlay: fill a scratch with `color`, knock it down to the layer's own alpha
 *  (destination-in), then composite that onto the layer at the chosen blend, scaled by
 *  `opacity`. The alpha-clip on the scratch keeps the fill WITHIN the silhouette while the
 *  blend mode still applies — no double-composite, no outward growth. Deterministic. */
function passColorOverlay(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: ColorOverlayEffect, _opts: PassOpts): void {
  const opacity = clamp01(e.opacity ?? 1)
  if (!(opacity > 0)) return
  const scratch = mkCanvas(off.width, off.height)
  const sctx = scratch.getContext('2d')
  if (!sctx) return
  sctx.fillStyle = e.color || '#000000'
  sctx.fillRect(0, 0, scratch.width, scratch.height)
  // Clip the flat fill to the layer's alpha — the overlay lives only where the layer paints.
  sctx.globalCompositeOperation = 'destination-in'
  sctx.drawImage(off, 0, 0)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = overlayCompositeOp(overlayBlendOf(e.blend))
  ctx.globalAlpha = opacity
  ctx.drawImage(scratch, 0, 0)
  ctx.restore()
}

/** Gradient overlay: the same alpha-clipped composite as colour overlay, but the scratch is
 *  filled with a two-colour linear gradient (`from`→`to`) along `angle` over the offscreen's own
 *  box. Deterministic. */
function passGradientOverlay(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: GradientOverlayEffect, _opts: PassOpts): void {
  const opacity = clamp01(e.opacity ?? 1)
  if (!(opacity > 0)) return
  const scratch = mkCanvas(off.width, off.height)
  const sctx = scratch.getContext('2d')
  if (!sctx) return
  const { x0, y0, x1, y1 } = gradientOverlayAxis(scratch.width, scratch.height, e.angle ?? 0)
  const g = sctx.createLinearGradient(x0, y0, x1, y1)
  g.addColorStop(0, e.from || '#000000')
  g.addColorStop(1, e.to || '#ffffff')
  sctx.fillStyle = g
  sctx.fillRect(0, 0, scratch.width, scratch.height)
  sctx.globalCompositeOperation = 'destination-in'
  sctx.drawImage(off, 0, 0)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = overlayCompositeOp(overlayBlendOf(e.blend))
  ctx.globalAlpha = opacity
  ctx.drawImage(scratch, 0, 0)
  ctx.restore()
}

/** Multi-sample ring dilation: draw `src` once at the origin then at a fixed ring of offsets of
 *  radius `rPx`, so the union grows the silhouette outward by ≈`rPx`. Fixed sample count + phase
 *  ⇒ deterministic. `rPx ≤ 0` is a plain copy. Mirrors the `useRegionFx` ring-dilate technique. */
const STROKE_ALPHA_SAMPLES = 24
function ringDilate(dctx: CanvasRenderingContext2D, src: HTMLCanvasElement, rPx: number): void {
  dctx.drawImage(src, 0, 0)
  if (!(rPx > 0)) return
  for (let i = 0; i < STROKE_ALPHA_SAMPLES; i++) {
    const a = (i / STROKE_ALPHA_SAMPLES) * Math.PI * 2
    dctx.drawImage(src, Math.cos(a) * rPx, Math.sin(a) * rPx)
  }
}

/** A scratch whose alpha is `src`'s silhouette ERODED inward by `rPx`, via the complement-dilation
 *  identity erode(A, r) = A \ dilate(¬A, r): grow the exterior inward by `rPx`, then knock it out
 *  of a copy of `src`. `rPx ≤ 0` is a plain copy of `src`. Deterministic. */
function erodeSilhouette(src: HTMLCanvasElement, rPx: number): HTMLCanvasElement {
  const out = cloneCanvas(src)
  if (!(rPx > 0)) return out
  const octx = out.getContext('2d')
  if (!octx) return out
  // Exterior = an opaque field with the silhouette knocked out.
  const ext = mkCanvas(src.width, src.height)
  const ectx = ext.getContext('2d')
  if (!ectx) return out
  ectx.fillStyle = '#000000'
  ectx.fillRect(0, 0, ext.width, ext.height)
  ectx.globalCompositeOperation = 'destination-out'
  ectx.drawImage(src, 0, 0)
  // Grow the exterior inward by rPx.
  const grown = mkCanvas(src.width, src.height)
  const gctx = grown.getContext('2d')
  if (!gctx) return out
  ringDilate(gctx, ext, rPx)
  // eroded = src minus the grown exterior.
  octx.save()
  octx.setTransform(1, 0, 0, 1, 0, 0)
  octx.globalCompositeOperation = 'destination-out'
  octx.drawImage(grown, 0, 0)
  octx.restore()
  return out
}

/** Stroke from alpha: trace a band of `color`, `width·W` px wide, at the layer's OWN rasterised
 *  alpha edge, on the `align` side. Build the OUTER boundary by dilating the alpha by `outerPx`,
 *  recolour that dilated silhouette to `color` (source-in), then knock out the alpha ERODED by
 *  `innerPx` so only the band survives, and composite it onto the offscreen. `outside`/`center`
 *  paint OUTSIDE the alpha (the pad holds them). Deterministic. */
function passStrokeFromAlpha(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: StrokeFromAlphaEffect, opts: PassOpts): void {
  const scale = opts.scale ?? 1
  const widthPx = Math.max(0, e.width ?? 0) * opts.W * scale
  if (!(widthPx > 0)) return
  const { outerPx, innerPx } = strokeAlphaBand(widthPx, strokeAlphaAlignOf(e.align))
  const band = mkCanvas(off.width, off.height)
  const bctx = band.getContext('2d')
  if (!bctx) return
  // Outer boundary: the alpha dilated outward by outerPx (a plain copy when outerPx is 0).
  ringDilate(bctx, off, outerPx)
  // Recolour the dilated silhouette to the stroke colour, keeping its alpha.
  bctx.save()
  bctx.setTransform(1, 0, 0, 1, 0, 0)
  bctx.globalCompositeOperation = 'source-in'
  bctx.fillStyle = e.color || '#000000'
  bctx.fillRect(0, 0, band.width, band.height)
  // Inner boundary: knock the alpha eroded by innerPx out of the fill, leaving the ring band.
  bctx.globalCompositeOperation = 'destination-out'
  bctx.drawImage(erodeSilhouette(off, innerPx), 0, 0)
  bctx.restore()
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(band, 0, 0)
  ctx.restore()
}

/** Directional (linear) motion blur: accumulate `MOTION_BLUR_SAMPLES` copies of the layer, each
 *  shifted along `angle` by a centred fraction of `distance·W` px and composited at `1/N` alpha,
 *  so the shape smears in place. Clear the offscreen and redraw the accumulation onto it (replace).
 *  Deterministic: a fixed tap count, no randomness. */
function passDirectionalBlur(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: DirectionalBlurEffect, opts: PassOpts): void {
  const scale = opts.scale ?? 1
  const distPx = Math.max(0, e.distance ?? 0) * opts.W * scale
  if (!(distPx > 0)) return
  const taps = directionalBlurTaps(e.angle ?? 0, distPx, MOTION_BLUR_SAMPLES)
  const src = cloneCanvas(off)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, off.width, off.height)
  ctx.globalAlpha = 1 / taps.length
  for (const t of taps) ctx.drawImage(src, t.dx, t.dy)
  ctx.restore()
}

/** Radial (spin) motion blur: accumulate `MOTION_BLUR_SAMPLES` copies of the layer, each rotated
 *  about `(centerX·w, centerY·h)` by a centred fraction of the full swing and composited at `1/N`
 *  alpha. Clear the offscreen and redraw the accumulation (replace). Deterministic. */
function passRadialBlur(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: RadialBlurEffect, _opts: PassOpts): void {
  const amount = clamp01(e.amount ?? 0)
  if (!(amount > 0)) return
  const angs = radialBlurTaps(amount, MOTION_BLUR_SAMPLES)
  const cx = clamp01(e.centerX ?? 0.5) * off.width
  const cy = clamp01(e.centerY ?? 0.5) * off.height
  const src = cloneCanvas(off)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, off.width, off.height)
  ctx.globalAlpha = 1 / angs.length
  for (const th of angs) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.translate(cx, cy)
    ctx.rotate(th)
    ctx.translate(-cx, -cy)
    ctx.drawImage(src, 0, 0)
  }
  ctx.restore()
}

/** Zoom motion blur: accumulate `MOTION_BLUR_SAMPLES` copies of the layer, each scaled about
 *  `(centerX·w, centerY·h)` by a centred fraction of the full scale swing and composited at `1/N`
 *  alpha, so the shape radiates from the centre. Clear the offscreen and redraw the accumulation
 *  (replace). Deterministic. */
function passZoomBlur(ctx: CanvasRenderingContext2D, off: HTMLCanvasElement, e: ZoomBlurEffect, _opts: PassOpts): void {
  const amount = clamp01(e.amount ?? 0)
  if (!(amount > 0)) return
  const factors = zoomBlurTaps(amount, MOTION_BLUR_SAMPLES)
  const cx = clamp01(e.centerX ?? 0.5) * off.width
  const cy = clamp01(e.centerY ?? 0.5) * off.height
  const src = cloneCanvas(off)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, off.width, off.height)
  ctx.globalAlpha = 1 / factors.length
  for (const f of factors) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.translate(cx, cy)
    ctx.scale(f, f)
    ctx.translate(-cx, -cy)
    ctx.drawImage(src, 0, 0)
  }
  ctx.restore()
}

/** The kinds this module owns as 2D passes over a layer/document offscreen. Everything
 *  else in a layer's stack (inner shadow, torn edge, feather, layer blur, drop shadow,
 *  background blur, dof) is applied by the caller at its own structural position. */
const PASS_TYPES = new Set<string>(['adjust', 'duotone', 'gradientMap', 'bloom', 'vignette', 'grain', 'outer_glow', 'inner_glow', 'color_overlay', 'gradient_overlay', 'stroke_from_alpha', 'directional_blur', 'radial_blur', 'zoom_blur', 'levels', 'posterise', 'threshold', 'invert'])

/**
 * Apply passes in ARRAY ORDER — the per-layer entry point. Order is the caller's, so the
 * same two effects in two orders produce two different images, and a kind may repeat.
 * Entries this module does not own, and invisible entries, are skipped.
 */
export function applyPasses(
  off: HTMLCanvasElement,
  passes: readonly { type: string; visible: boolean }[],
  opts: PassOpts,
): void {
  if (!passes.length) return
  const ctx = off.getContext('2d')
  if (!ctx) return
  for (const e of passes) {
    if (!e.visible || !PASS_TYPES.has(e.type)) continue
    switch (e.type) {
      case 'adjust': passAdjust(ctx, off, e as unknown as AdjustEffect, opts); break
      case 'duotone': passDuotone(ctx, off, e as unknown as DuotoneEffect, opts); break
      case 'gradientMap': passGradientMap(ctx, off, e as unknown as GradientMapEffect, opts); break
      case 'bloom': passBloom(ctx, off, e as unknown as BloomEffect, opts); break
      case 'vignette': passVignette(ctx, off, e as unknown as VignetteEffect, opts); break
      case 'grain': passGrain(ctx, off, e as unknown as GrainEffect, opts); break
      case 'outer_glow': passOuterGlow(ctx, off, e as unknown as OuterGlowEffect, opts); break
      case 'inner_glow': passInnerGlow(ctx, off, e as unknown as InnerGlowEffect, opts); break
      case 'color_overlay': passColorOverlay(ctx, off, e as unknown as ColorOverlayEffect, opts); break
      case 'gradient_overlay': passGradientOverlay(ctx, off, e as unknown as GradientOverlayEffect, opts); break
      case 'stroke_from_alpha': passStrokeFromAlpha(ctx, off, e as unknown as StrokeFromAlphaEffect, opts); break
      case 'directional_blur': passDirectionalBlur(ctx, off, e as unknown as DirectionalBlurEffect, opts); break
      case 'radial_blur': passRadialBlur(ctx, off, e as unknown as RadialBlurEffect, opts); break
      case 'zoom_blur': passZoomBlur(ctx, off, e as unknown as ZoomBlurEffect, opts); break
      case 'levels': passLevels(ctx, off, e as unknown as LevelsEffect, opts); break
      case 'posterise': passPosterise(ctx, off, e as unknown as PosteriseEffect, opts); break
      case 'threshold': passThreshold(ctx, off, e as unknown as ThresholdEffect, opts); break
      case 'invert': passInvert(ctx, off, e as unknown as InvertEffect, opts); break
    }
  }
}

/**
 * Gaussian blur of the whole offscreen — the per-layer `layer_blur` effect as a pass.
 *
 * Used ONLY for a blur that is followed by another pass, which is reachable only after a user
 * reorders the stack. A TRAILING blur stays where the legacy code put it: a CSS filter on the
 * stamp's `drawImage` (the canvas applies filter → shadow → composite, so the drop shadow
 * follows the blurred silhouette). That is not the same picture as this pass, so the two are
 * not interchangeable: blurring into the offscreen re-quantizes to 8 bits once more, and it
 * clips the blur's bleed at the offscreen's bounds, where a stamp-time filter lets the bleed
 * past them — visible as a band along a frame edge when the blurred layer also casts a drop
 * shadow. The stamp keeps the trailing case so an unedited layer renders byte-identically.
 *
 * `radiusPx` is already in DEVICE pixels (the caller multiplies by `W * scale`), and takes a
 * number rather than the effect so this module keeps its one-way independence from
 * effectStack.ts.
 */
export function applyBlurPass(off: HTMLCanvasElement, radiusPx: number): void {
  if (!(radiusPx > 0)) return
  const ctx = off.getContext('2d')
  if (!ctx) return
  const src = cloneCanvas(off)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, off.width, off.height)
  ctx.filter = `blur(${radiusPx}px)`
  ctx.drawImage(src, 0, 0)
  ctx.filter = 'none'
  ctx.restore()
}

// Overlays slot in with the colour family: after the tone/luminance recolours
// (adjust→duotone→gradientMap), before the light/texture passes (bloom→vignette→grain) and
// the trailing outer glow. A flat/gradient fill over the surface belongs on top of the graded
// colour but under bloom's bright pass and grain.
// stroke_from_alpha rides just after the overlays: a stroke reads as ON TOP of the graded fill
// and its colour/gradient overlays, but UNDER the light/texture passes (bloom→vignette→grain) and
// the trailing outer glow, so bloom can bloom the bright stroke and the glow haloes behind it.
// The motion blurs (directional→radial→zoom) sit just after the stroke and BEFORE bloom: the
// layer's full colour/overlay/stroke look is settled, then smeared, so bloom blooms the smeared
// highlights and grain/vignette dress the moved image — a blur after grain would drag the texture.
// The tone ops (levels → posterise → threshold → invert) sit in the colour-grade region, right
// after `adjust` and before `duotone`/`gradientMap`: adjust sets brightness/contrast, the tone ops
// then reshape the luminance curve (remap / band / clip / flip), and the colour maps read that
// reshaped luminance to place colour. Grouped and ordered levels→posterise→threshold→invert, the
// gentlest tonal move to the harshest.
const CHAIN_ORDER = ['inner_glow', 'adjust', 'levels', 'posterise', 'threshold', 'invert', 'duotone', 'gradientMap', 'color_overlay', 'gradient_overlay', 'stroke_from_alpha', 'directional_blur', 'radial_blur', 'zoom_blur', 'bloom', 'vignette', 'grain', 'outer_glow']

/**
 * The FIXED-ORDER entry point, unchanged in behaviour: one instance per type (the first VISIBLE
 * entry of each type), applied in the canonical chain order whatever the array says.
 * `applyStackPost` (the document-level post stack) uses this, and that stack's stored array
 * order is arbitrary — sorting here is what keeps every existing document rendering exactly
 * as it did.
 */
export function applyEffectChain(
  off: HTMLCanvasElement,
  effects: PostEffect[],
  opts: PassOpts,
): void {
  const first = new Map<string, PostEffect>()
  for (const e of effects) if (e.visible && !first.has(e.type)) first.set(e.type, e)
  applyPasses(off, CHAIN_ORDER.map(t => first.get(t)).filter((e): e is PostEffect => !!e), opts)
}

/**
 * Doc-level post pass: snapshot the device canvas, run the chain on it, stamp
 * it back in identity space. Called by paintLayerStack when `post` is active.
 */
export function applyStackPost(ctx: CanvasRenderingContext2D, post: PostEffect[], W: number): void {
  const dev = ctx.canvas
  const t = ctx.getTransform()
  const snap = mkCanvas(dev.width, dev.height)
  const sctx = snap.getContext('2d')
  if (!sctx) return
  sctx.drawImage(dev, 0, 0)
  applyEffectChain(snap, post, { W, scale: t.a || 1 })
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, dev.width, dev.height)
  ctx.drawImage(snap, 0, 0)
  ctx.restore()
}
