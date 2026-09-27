/**
 * How the runner works each ported effect (step 3, R2): the worker op that
 * runs one picture, how a batch is worked (rule 5), and what a class may
 * declare about its work and output size before any pixel is decoded
 * (rule 7). Its classes are exactly shared/runner/effects.ts
 * EFFECT_CLASSES_PORTED (a test holds them equal).
 */
import type { EffectFamily } from '#shared/runner/effects'
import { hexToRgb, parseDuotone, parseStops } from '#shared/runner/gradientStops'
import { asciiPrepare } from './asciiGlyphs'

export interface EffectSpec {
  family: EffectFamily
  /** The worker op that runs one picture (or one generator frame): '<core>.<fn>'. */
  op: string
  /**
   * 'pure': each file on its own (a file listed twice is worked on once);
   * 'coupled': state carried across the batch in file order (nothing is
   * deduplicated); 'generator': no picture input.
   */
  batch: 'pure' | 'coupled' | 'generator'
  /** Checked from widgets and the first picture's size before decoding (rule 7). */
  work?(widgets: Record<string, unknown>, size: { w: number; h: number } | null): number
  /** The output size when it isn't the input's (Crop, Resize, generators). */
  outSize?(widgets: Record<string, unknown>, size: { w: number; h: number } | null): { w: number; h: number }
  /**
   * The live preview's size when it is a picture of its own, not an output
   * (FrequencySeparation's low and high side by side): counted in the caps
   * with the outputs (rule 7).
   */
  previewSize?(widgets: Record<string, unknown>, size: { w: number; h: number } | null): { w: number; h: number } | null
  /**
   * The widgets as the core takes them, when some need reading on the main
   * thread first (R2.4: colour text, parsed as Python parses it by
   * shared/runner/gradientStops.ts, which the self-contained cores can't
   * import). Everything else keeps its value.
   */
  prepare?(widgets: Record<string, unknown>): Record<string, unknown>
}

const tone = (name: string, prepare?: EffectSpec['prepare']): EffectSpec => ({ family: 'effects-tone', op: `tone.${name}`, batch: 'pure', ...(prepare ? { prepare } : {}) })

// ── effects-blur (R2.5): the work each asks for (rule 7) ──
//
// work = pixels × channels × taps, at the size where the taps are worked
// (a blur past its downsampling threshold works on the smaller copy), in
// the units of EFFECT_MAX_WORK (0.37 × 10⁹ a second). The header can't
// tell 3 channels from 4, so every picture counts 4. Taps: a gaussian
// 2·ksize (separable), a motion line or Bokeh's disk its kernel's area, a
// Sobel 9 per kernel, a bilinear resize back up 4, a zoom 12 samples of 6.
// Outline works on the luma alone: two Sobels, its max-pool window and its
// per-pixel steps. Sparkle: its 9 × 9 peak pool over the luma, and max_n ·
// ks² for the star stamped at every kept peak (the number of kept peaks,
// not a per-pixel count).
//
// Measured on the development Mac (R2.5 report, 1024² × 4 in this thread):
// the separable gaussian runs at 0.8 × 10⁹ taps a second, well inside the
// unit; a direct convolution (kernels.ts correlate: a bounds check each
// tap) at 0.30–0.35 × 10⁹, so its taps count CONV_TAP = 1.5; a zoom sample
// (affine_grid + grid_sample) costs about 5 units a value, counted 6; the
// small Sobel and relief kernels carry a per-value overhead (the map passes
// around them) on top.

/** Channels counted per picture: the most a picture holds. */
const WORK_CHANNELS = 4
/** A direct convolution's tap, in gaussian-pass taps (measured, above). */
const CONV_TAP = 1.5
type Size = { w: number; h: number } | null
const px = (s: Size) => (s ? s.w * s.h : 0)
/** The nodes' gaussian width, 2·ceil(3σ) + 1. */
const ksizeOf = (sigma: number) => 2 * Math.ceil(3 * sigma) + 1
/** Pixels after an area resize by 1 / scale. */
const smallPx = (s: Size, scale: number) => (s ? Math.floor(s.h * (1 / scale)) * Math.floor(s.w * (1 / scale)) : 0)
/** A gaussian blur at `sigma` on `pixels` pixels. */
const gaussWork = (pixels: number, sigma: number) => pixels * WORK_CHANNELS * 2 * ksizeOf(sigma)
/** A blur past its threshold (Blur's gaussian, TiltShift): downsampled by max(1, int(r / 4)), then back up. */
function scaledGaussWork(s: Size, radius: number, always = false): number {
  const scale = Math.max(1, Math.trunc(radius / 4))
  const up = scale > 1 || always ? px(s) * WORK_CHANNELS * 4 : 0
  return gaussWork(scale > 1 || always ? smallPx(s, scale) : px(s), radius / scale) + up
}
const num = (w: Record<string, unknown>, k: string) => (typeof w[k] === 'number' ? w[k] as number : 0)
/** Python's round() of a float (half to even). */
const pyRound = (x: number) => { const r = Math.round(x); return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r }

const blur = (name: string, work: NonNullable<EffectSpec['work']>, prepare?: EffectSpec['prepare']): EffectSpec =>
  ({ family: 'effects-blur', op: `blur.${name}`, batch: 'pure', work, ...(prepare ? { prepare } : {}) })

/** Blur's work by its type. */
function blurWork(w: Record<string, unknown>, s: Size): number {
  if (w.type === 'gaussian' && num(w, 'radius') > 0) return scaledGaussWork(s, num(w, 'radius'))
  if (w.type === 'motion' && num(w, 'length') > 0) {
    const length = pyRound(num(w, 'length'))
    const scale = Math.max(1, Math.trunc(length / 8))
    const line = scale > 1 ? Math.max(2, pyRound(length / scale)) : length
    const side = line <= 1 ? 1 : line % 2 === 1 ? line : line + 1
    return (scale > 1 ? smallPx(s, scale) : px(s)) * WORK_CHANNELS * side * side * CONV_TAP + (scale > 1 ? px(s) * WORK_CHANNELS * 4 : 0)
  }
  if (w.type === 'zoom' && num(w, 'strength') > 0) return px(s) * WORK_CHANNELS * 12 * 6
  return 0
}

/** Bokeh's work: its disk over the (downsampled) picture, and the resize back. */
function bokehWork(w: Record<string, unknown>, s: Size): number {
  const radius = num(w, 'radius')
  if (radius <= 0) return 0
  const scale = Math.max(1, Math.trunc(radius / 5))
  const side = 2 * Math.ceil(radius / scale) + 1
  return (scale > 1 ? smallPx(s, scale) : px(s)) * WORK_CHANNELS * side * side * CONV_TAP + (scale > 1 ? px(s) * WORK_CHANNELS * 4 : 0)
}

/** Sparkle's work: the peak pool, and the star stamped at up to max_n peaks. */
function sparkleWork(w: Record<string, unknown>, s: Size): number {
  const maxN = Math.max(1, Math.trunc(num(w, 'max_density') * (s?.h ?? 0) * (s?.w ?? 0)))
  const ks = Math.trunc(num(w, 'size')) * 2 + 1
  return px(s) * 81 + Math.min(maxN, px(s)) * ks * ks
}

/** Outline's work: two Sobels and its max-pool window, on the luma. */
function outlineWork(w: Record<string, unknown>, s: Size): number {
  const k = Math.max(1, pyRound(num(w, 'thickness')))
  return px(s) * (2 * 9 * CONV_TAP + (k > 1 ? (2 * k + 1) ** 2 : 0) + 10)
}

// ── effects-cells (R2.6): the work each asks for (rule 7) ──
//
// In the same units (0.37 × 10⁹ a second), every picture counted at 4
// channels. Measured on the development Mac (R2.6 report: each op at 1024²
// in this thread, calibrated so every op stays at or under the unit):
// Pixelate's area and nearest passes CELLS_PASS a value each; Halftone its
// per-pixel geometry (HALFTONE_PIXEL) and its luma's avg_pool2d, the
// cell² window at every pixel of the (h + 1) × (w + 1) pool; Kuwahara its
// two avg_pool2ds, (r + 1)² taps a value each, and its per-pixel quadrant
// pick; Ascii a fixed ASCII_PIXEL a value (its pools visit each pixel once).

const CELLS_PASS = 4
const HALFTONE_PIXEL = 24
const POOL_TAP = 1.5
const KUWAHARA_PIXEL = 24
const ASCII_PIXEL = 24

const cells = (name: string, work: NonNullable<EffectSpec['work']>, extra: Partial<EffectSpec> = {}): EffectSpec =>
  ({ family: 'effects-cells', op: `cells.${name}`, batch: 'pure', work, ...extra })

/** Pixels one pixel larger each way (Halftone's even cell, Kuwahara's odd radius: the pool's size). */
const px1 = (s: Size) => (s ? (s.w + 1) * (s.h + 1) : 0)

/** Kuwahara's radius as its execute reads it. */
const kuwaharaR = (w: Record<string, unknown>) => Math.max(1, Math.trunc(num(w, 'radius')))

export const EFFECTS: Readonly<Record<string, EffectSpec>> = {
  // ── effects-tone (R2.1 pilots): per pixel, exact ──
  AdjustExposure: { family: 'effects-tone', op: 'tone.AdjustExposure', batch: 'pure' },
  AdjustInvert: { family: 'effects-tone', op: 'tone.AdjustInvert', batch: 'pure' },
  AdjustThreshold: { family: 'effects-tone', op: 'tone.AdjustThreshold', batch: 'pure' },
  // ── effects-tone (R2.4): per pixel ──
  AdjustBrightnessContrast: tone('AdjustBrightnessContrast'),
  AdjustColor: tone('AdjustColor'),
  AdjustCurves: tone('AdjustCurves'),
  AdjustLevels: tone('AdjustLevels'),
  AdjustTemperature: tone('AdjustTemperature'),
  AdjustVibrance: tone('AdjustVibrance'),
  AdjustColorBalance: tone('AdjustColorBalance'),
  AdjustBlackWhite: tone('AdjustBlackWhite'),
  AdjustPhotoFilter: tone('AdjustPhotoFilter'),
  AdjustGradientMap: tone('AdjustGradientMap', w => ({ ...w, stops: parseStops(w.stops) })),
  AdjustChannelMixer: tone('AdjustChannelMixer'),
  AdjustPosterize: tone('AdjustPosterize'),
  AdjustVignette: tone('AdjustVignette'),
  AdjustShadowsHighlights: tone('AdjustShadowsHighlights'),
  Duotone: tone('Duotone', (w) => {
    const [shadow, highlight] = parseDuotone(w.duotone)
    return { ...w, colours: [hexToRgb(shadow, [0.1, 0.1, 0.3]), hexToRgb(highlight, [1.0, 0.8, 0.4])] }
  }),
  SplitToning: tone('SplitToning'),
  GradientMap: tone('GradientMap', w => ({ ...w, dark: hexToRgb(String(w.dark_color), [0, 0, 0]), light: hexToRgb(String(w.light_color), [1, 1, 1]) })),
  Posterize: tone('Posterize'),
  Hologram: tone('Hologram'),
  TwoDLight: tone('TwoDLight', w => ({ ...w, colour: hexToRgb(String(w.color), [1, 1, 1]) })),
  LightLeak: tone('LightLeak'),
  LensFlare: tone('LensFlare'),
  Caustics: tone('Caustics'),
  Blinds: tone('Blinds'),
  CrossHatch: tone('CrossHatch'),
  Dither: tone('Dither'),
  // ── effects-blur (R2.5): convolution, library ──
  Sharpen: blur('Sharpen', (w, s) => (num(w, 'amount') === 0 ? 0 : gaussWork(px(s), num(w, 'radius')))),
  Denoise: blur('Denoise', (w, s) => (num(w, 'strength') <= 0 ? 0 : gaussWork(px(s), num(w, 'strength')))),
  AdjustGlow: blur('AdjustGlow', (w, s) => (num(w, 'intensity') <= 0 || num(w, 'radius') <= 0 ? 0 : scaledGaussWork(s, num(w, 'radius'), true))),
  HighPass: blur('HighPass', (w, s) => gaussWork(px(s), num(w, 'radius'))),
  Emboss: blur('Emboss', (_w, s) => px(s) * WORK_CHANNELS * (9 * CONV_TAP + 4)),
  FindEdges: blur('FindEdges', (_w, s) => px(s) * WORK_CHANNELS * (2 * 9 * CONV_TAP + 4)),
  Blur: blur('Blur', blurWork),
  Bokeh: blur('Bokeh', bokehWork),
  TiltShift: blur('TiltShift', (w, s) => scaledGaussWork(s, num(w, 'blur'))),
  FrequencySeparation: {
    ...blur('FrequencySeparation', (w, s) => gaussWork(px(s), num(w, 'radius'))),
    // show = combined: low and high side by side, 2w × h (show = high previews output 1, already counted).
    previewSize: (w, s) => (w.show === 'combined' && s ? { w: 2 * s.w, h: s.h } : null),
  },
  HeightmapRelief: blur('HeightmapRelief', (_w, s) => px(s) * (2 * 9 * CONV_TAP + 20)),
  Outline: blur('Outline', outlineWork, w => ({ ...w, line: hexToRgb(String(w.line_color), [0, 0, 0]), fill: hexToRgb(String(w.fill_color), [1, 1, 1]) })),
  Sparkle: blur('Sparkle', sparkleWork),
  // ── effects-cells (R2.6): exact ──
  Pixelate: cells('Pixelate', (_w, s) => px(s) * WORK_CHANNELS * 2 * CELLS_PASS),
  Halftone: cells('Halftone', (w, s) => px(s) * HALFTONE_PIXEL + px1(s) * num(w, 'cell_size') ** 2 * POOL_TAP),
  Kuwahara: cells('Kuwahara', (w, s) => px1(s) * (WORK_CHANNELS * 2 * (kuwaharaR(w) + 1) ** 2 * POOL_TAP + KUWAHARA_PIXEL), {
    // An odd radius pools with an even window: the output is one pixel larger each way.
    outSize: (w, s) => (s && kuwaharaR(w) % 2 === 1 ? { w: s.w + 1, h: s.h + 1 } : s ?? { w: 0, h: 0 }),
  }),
  Ascii: cells('Ascii', (_w, s) => px(s) * WORK_CHANNELS * ASCII_PIXEL, { prepare: asciiPrepare }),
}

/** The runner's spec for an effect class, or undefined when the class is not an effect it ports. */
export function effectSpec(classType: string): EffectSpec | undefined {
  return Object.prototype.hasOwnProperty.call(EFFECTS, classType) ? EFFECTS[classType] : undefined
}
