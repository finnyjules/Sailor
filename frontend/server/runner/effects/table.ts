/**
 * How the runner works each ported effect (step 3, R2): the worker op that
 * runs one picture, how a batch is worked (rule 5), and what a class may
 * declare about its work and output size before any pixel is decoded
 * (rule 7). Its classes are exactly shared/runner/effects.ts
 * EFFECT_CLASSES_PORTED (a test holds them equal).
 */
import { EFFECT_WIDGET_SIZES, effectOutSize, generatorWork, type EffectFamily } from '#shared/runner/effects'
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
  /**
   * The inputs' batches must be equal (R2.8: Merge alpha's torch.cat doesn't
   * broadcast a batch of one against more); otherwise rule 5's equal-or-one.
   */
  equalBatches?: true
  /**
   * Two passes over the batch (R2.9: Palette quantize samples every picture,
   * then snaps each): the plan hands the worker every picture once with
   * nothing wanted back, then again for the outputs.
   */
  gather?: true
  /** The op draws from a seed the plan derives from the node's settings and files (R2.9: Add noise, ruling (e)); handed in as `seed`. */
  seeded?: true
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

// ── effects-warp (R2.7): the work each asks for (rule 7) ──
//
// In the same units (0.37 × 10⁹ a second), every picture counted at 4
// channels. Measured on the development Mac (R2.7 report: each op at 1024²
// × 4 in this thread, the constants set so every op's time at the unit's
// rate is at or above its measured time): a grid_sample reads 4 taps a value
// (GRID_VALUE a value) and each warp's grid (linspace, the transcendental
// functions, the products) costs GRID_PIXEL a pixel (Rotate's affine_grid
// alike); Chromatic aberration (and CRT's chroma step) samples one channel
// at each of three grids (CHROMA_GRID a pixel each); God rays a simpler grid
// and the running sum each sample (GODRAYS_PIXEL). Crop, Flip, Mirror and
// Resize at 1 copy (COPY_VALUE a value). Resize works over its output: a
// bilinear, bicubic or nearest value costs RESIZE_VALUE of its mode; area
// reads every input value once (AREA_IN) and writes the output.

const GRID_VALUE = 6
const GRID_PIXEL = 28
const CHROMA_GRID = 14
const GODRAYS_PIXEL = 6
const COPY_VALUE = 4
const RESIZE_VALUE: Readonly<Record<string, number>> = { bilinear: 6, bicubic: 40, nearest: 4, area: 4 }
const AREA_IN = 6

const warp = (name: string, work: NonNullable<EffectSpec['work']>, extra: Partial<EffectSpec> = {}): EffectSpec =>
  ({ family: 'effects-warp', op: `warp.${name}`, batch: 'pure', work, ...extra })

/** One grid warp over the picture: its grid, and the grid_sample of every channel. */
const gridWork = (s: Size) => px(s) * (WORK_CHANNELS * GRID_VALUE + GRID_PIXEL)
/** The chroma step: three channels, each sampled at its own grid. */
const chromaWork = (s: Size) => px(s) * 3 * (GRID_VALUE + CHROMA_GRID)
/** A copy of every value. */
const copyWork = (s: Size) => px(s) * WORK_CHANNELS * COPY_VALUE

/** Resize's work: its mode's cost a value over the output (area: every input value once, too). */
function resizeWork(w: Record<string, unknown>, s: Size): number {
  const scale = num(w, 'scale')
  if (!s || scale === 1) return copyWork(s)
  const out = Math.floor(s.w * scale) * Math.floor(s.h * scale)
  const mode = typeof w.mode === 'string' && Object.prototype.hasOwnProperty.call(RESIZE_VALUE, w.mode) ? w.mode : 'bicubic'
  return out * WORK_CHANNELS * RESIZE_VALUE[mode]! + (mode === 'area' ? px(s) * WORK_CHANNELS * AREA_IN : 0)
}

// ── effects-mask (R2.8): the work each asks for (rule 7) ──
//
// In the same units (0.37 × 10⁹ a second), every picture counted at 4
// channels. Measured on the development Mac (R2.8 report: each op at 1024²
// × 4 in this thread, the constants set so every op's time at the unit's
// rate is at or above its measured time): a per-value step (a blend mode, a
// product, a clamp) MASK_VALUE a value; a bilinear resize of the top or the
// mask RESIZE_VALUE.bilinear a value, counted whether or not the sizes differ
// (the header of the second input isn't read for it); a luma or a colour
// distance MASK_PIXEL a pixel; Matte grow / shrink's max pool, taken one side
// at a time, POOL_STEP a step (2k a pixel), and its feather the gaussian's
// 2·ksize taps a pixel on one channel.

const MASK_VALUE = 4
const MASK_PIXEL = 12
const POOL_STEP = 2

const mask = (name: string, work: NonNullable<EffectSpec['work']>, extra: Partial<EffectSpec> = {}): EffectSpec =>
  ({ family: 'effects-mask', op: `mask.${name}`, batch: 'pure', work, ...extra })

/** Matte grow / shrink's work: its max pool one side at a time, and its feather on one channel. */
function matteWork(w: Record<string, unknown>, s: Size): number {
  const amount = num(w, 'amount')
  const feather = num(w, 'feather')
  const kk = amount !== 0 ? Math.abs(pyRound(amount)) * 2 + 1 : 1
  return px(s) * ((kk > 1 ? 2 * kk * POOL_STEP : 0) + (feather > 0 ? 2 * ksizeOf(feather) : 0) + 3 * MASK_VALUE)
}

/** The output size of a class that changes it (effectOutSize), else the input's. */
const sizedBy = (cls: string): EffectSpec['outSize'] => (w, s) => (s ? effectOutSize(cls, w, s) ?? s : { w: 0, h: 0 })

// ── effects-noise (R2.9): the work each asks for (rule 7) ──
//
// In the same units (0.37 × 10⁹ a second), every picture counted at 4
// channels. Measured on the development Mac (R2.9 report: each op at 1024²
// (a generator at its largest) in this thread, the constants set so every
// op's time at the unit's rate is at or above its measured time). The
// generators' own work comes from their widgets alone
// (shared/runner/effects.ts generatorWork, the same numbers the eligibility
// check reads). Film grain: its noise drawn and resized, and its per-pixel
// grain (GRAIN_PIXEL); Glitch: its rolls (COPY_VALUE a value, three
// passes); Palette quantize: a distance per sample and centre per iteration
// and per pixel and centre (PALETTE_DISTANCE), and its area sample; Stipple:
// its luma, pow, pool and stamp (STIPPLE_PIXEL); Flow field: its two value
// noises and its grid (FLOW_PIXEL) and the grid_sample of every channel
// (GRID_VALUE); Add noise: a draw and an add a value (NOISE_VALUE).

const GRAIN_PIXEL = 40
const PALETTE_DISTANCE = 8
const STIPPLE_PIXEL = 40
const FLOW_PIXEL = 60
const NOISE_VALUE = 24

const noise = (name: string, batch: EffectSpec['batch'], work: NonNullable<EffectSpec['work']>, extra: Partial<EffectSpec> = {}): EffectSpec =>
  ({ family: 'effects-noise', op: `noise.${name}`, batch, work, ...extra })

/** A generator: its size and work from its widgets alone. */
const generator = (name: string): EffectSpec => noise(name, 'generator', w => generatorWork(name, w) ?? 0, {
  outSize: w => EFFECT_WIDGET_SIZES[name]!(w) ?? { w: 0, h: 0 },
})

/**
 * Film grain's output size: the picture's, except below size 1, where a side
 * of 1 grows to the noise field's (max(2, int(1 / size)), torch's broadcast).
 */
function filmGrainSize(w: Record<string, unknown>, s: Size): { w: number; h: number } {
  if (!s) return { w: 0, h: 0 }
  const size = num(w, 'size')
  if (num(w, 'amount') <= 0 || size > 1) return s
  const grow = (side: number) => (side === 1 ? Math.max(2, Math.trunc(1 / size)) : side)
  return { w: grow(s.w), h: grow(s.h) }
}

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
  // ── effects-warp (R2.7) ──
  CropImage: warp('CropImage', (_w, s) => copyWork(s), { outSize: sizedBy('CropImage') }),
  ResizeImage: warp('ResizeImage', resizeWork, { outSize: sizedBy('ResizeImage') }),
  RotateImage: warp('RotateImage', (_w, s) => gridWork(s)),
  FlipImage: warp('FlipImage', (_w, s) => copyWork(s)),
  Pinch: warp('Pinch', (_w, s) => gridWork(s)),
  Twirl: warp('Twirl', (_w, s) => gridWork(s)),
  Wave: warp('Wave', (_w, s) => gridWork(s)),
  LensCorrection: warp('LensCorrection', (_w, s) => gridWork(s)),
  Kaleidoscope: warp('Kaleidoscope', (_w, s) => gridWork(s)),
  PolarCoords: warp('PolarCoords', (_w, s) => gridWork(s)),
  Fisheye: warp('Fisheye', (_w, s) => gridWork(s)),
  ChromaticAberration: warp('ChromaticAberration', (_w, s) => chromaWork(s)),
  // A barrel, the chroma step, then the scanlines and stripes (a pass each).
  CRT: warp('CRT', (_w, s) => gridWork(s) + chromaWork(s) + 2 * copyWork(s)),
  // `samples` grid_samples of every channel, each with its grid and the running sum.
  GodRays: warp('GodRays', (w, s) => Math.max(1, Math.trunc(num(w, 'samples'))) * px(s) * (WORK_CHANNELS * GRID_VALUE + GODRAYS_PIXEL) + copyWork(s)),
  Mirror: warp('Mirror', (_w, s) => copyWork(s)),
  // ── effects-mask (R2.8): exact, but Matte grow / shrink's feather (library) ──
  // Blend carries nothing across its batch, but its base and top are paired by index (the brief: coupled).
  Blend: mask('Blend', (_w, s) => px(s) * WORK_CHANNELS * (3 * MASK_VALUE + RESIZE_VALUE.bilinear!), { batch: 'coupled' }),
  ApplyMask: mask('ApplyMask', (_w, s) => px(s) * (WORK_CHANNELS * 2 * MASK_VALUE + RESIZE_VALUE.bilinear!)),
  ThresholdMask: mask('ThresholdMask', (_w, s) => px(s) * (MASK_PIXEL + WORK_CHANNELS * 2 * MASK_VALUE)),
  ColorRangeMask: mask('ColorRangeMask', (_w, s) => px(s) * (MASK_PIXEL + WORK_CHANNELS * 2 * MASK_VALUE)),
  MatteGrowShrink: mask('MatteGrowShrink', matteWork),
  MergeAlpha: mask('MergeAlpha', (_w, s) => px(s) * (WORK_CHANNELS * 2 * MASK_VALUE + RESIZE_VALUE.bilinear!), { equalBatches: true }),
  // Painter has a plan of its own (effects/painter.ts): the base's first picture and a painter file.
  Painter: mask('Painter', (w, s) => painterWork(w, s, null), { batch: 'coupled' }),
  // ── effects-noise (R2.9) ──
  // One noise field for the whole batch (coupled, as the brief has it: nothing deduplicated).
  FilmGrain: noise('FilmGrain', 'coupled', (w, s) => (num(w, 'amount') <= 0 ? copyWork(s) : px(filmGrainSize(w, s)) * GRAIN_PIXEL), { outSize: filmGrainSize }),
  // The same shifts for every picture of the batch (one draw per slice, per execute).
  Glitch: noise('Glitch', 'coupled', (_w, s) => 3 * copyWork(s)),
  PerlinNoise: generator('PerlinNoise'),
  Voronoi: generator('Voronoi'),
  GradientGenerator: generator('GradientGenerator'),
  // One k-means over every picture's sample: two passes (gather).
  PaletteQuantize: noise('PaletteQuantize', 'coupled', (w, s) => {
    const kk = Math.max(2, Math.trunc(num(w, 'colors')))
    const side = s ? Math.min(96, s.w, s.h) : 0
    return (side * side * kk * Math.max(1, Math.trunc(num(w, 'iterations'))) + px(s) * kk) * PALETTE_DISTANCE + copyWork(s)
  }, { gather: true }),
  ReactionDiffusion: generator('ReactionDiffusion'),
  Fractal: generator('Fractal'),
  // rand over (b, sh, sw), b-major: one stream across the batch.
  Stipple: noise('Stipple', 'coupled', (_w, s) => px(s) * STIPPLE_PIXEL, {
    prepare: w => ({ ...w, dot: hexToRgb(String(w.dot_color), [0, 0, 0]), bg: hexToRgb(String(w.bg_color), [1, 1, 1]) }),
  }),
  // The same field for every picture.
  FlowField: noise('FlowField', 'pure', (_w, s) => px(s) * (WORK_CHANNELS * GRID_VALUE + FLOW_PIXEL)),
  // One draw over the whole batch, from the node's own seed.
  AddNoise: noise('AddNoise', 'coupled', (_w, s) => px(s) * WORK_CHANNELS * NOISE_VALUE, { seeded: true }),
}

/**
 * Painter's work: the canvas's composite, and Pillow's Lanczos of the painter
 * file when its size differs (each pass's taps, 2·ceil(3·scale) + 1 a value,
 * 4 bands). `size`: the picture wired in (the canvas), else width × height;
 * `file`: the painter file's size.
 */
export function painterWork(w: Record<string, unknown>, size: Size, file: Size): number {
  const canvas = size ?? { w: Math.trunc(num(w, 'width')), h: Math.trunc(num(w, 'height')) }
  let work = px(canvas) * WORK_CHANNELS * 3 * MASK_VALUE
  if (file && (file.w !== canvas.w || file.h !== canvas.h)) {
    const taps = (inSize: number, out: number) => 2 * Math.ceil(3 * Math.max(1, inSize / out)) + 1
    if (file.w !== canvas.w) work += canvas.w * file.h * 4 * taps(file.w, canvas.w)
    if (file.h !== canvas.h) work += canvas.w * canvas.h * 4 * taps(file.h, canvas.h)
    work += px(file) * 4 * 2
  }
  return work
}

/** The runner's spec for an effect class, or undefined when the class is not an effect it ports. */
export function effectSpec(classType: string): EffectSpec | undefined {
  return Object.prototype.hasOwnProperty.call(EFFECTS, classType) ? EFFECTS[classType] : undefined
}
