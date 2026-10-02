/**
 * The still-picture effects the runner computes itself (step 3, stage R2):
 * their families, their eligibility rows (built from the real node schemas,
 * ./effectSchemas.generated.ts), what their output slots carry, and the
 * limits every effect works within. Shared by the browser (routing, the
 * needs-the-engine names) and the server (the runner).
 *
 * A class has a row only once its port exists (EFFECT_CLASSES_PORTED, which
 * the server's effect table matches): with its family on, a class not yet
 * ported is still left to the engine.
 *
 * Imports nothing at run time but the generated schemas and the colour text
 * readers (./gradientStops.ts, pure): ./eligibility.ts builds its rule table
 * from effectRows() when it loads.
 */
import { EFFECT_SCHEMAS, type EffectSchema, type EffectSchemaFamily } from './effectSchemas.generated'
import { duotoneTextIsPortable, hexTextIsPortable, stopsTextIsPortable } from './gradientStops'
import { ASCII_DEFAULT, ASCII_GLYPH_CHARACTERS, ASCII_PRESETS } from './asciiGlyphSet.generated'
import type { RunnerFamily } from './families'
import type { InputCheckName, RunnerNodeRule, RunnerWidgetSpec } from './eligibility'
import type { ValueKind } from './values'
import { isLink } from './graph'
import { pyFloatOf, pyIntOf, pyTruthy } from './pyText'

export type EffectFamily = EffectSchemaFamily

/** Every effect family. */
export const EFFECT_FAMILIES: readonly EffectFamily[] = ['effects-tone', 'effects-blur', 'effects-cells', 'effects-warp', 'effects-mask', 'effects-noise']

/** The effects ported so far (R2.1: the three pilots; R2.4: the rest of effects-tone; R2.5: effects-blur; R2.6: effects-cells; R2.7: effects-warp; R2.8: effects-mask; R2.9: effects-noise). Each task adds its classes. */
export const EFFECT_CLASSES_PORTED: readonly string[] = [
  'AdjustExposure', 'AdjustInvert', 'AdjustThreshold',
  'AdjustBrightnessContrast', 'AdjustColor', 'AdjustCurves', 'AdjustLevels',
  'AdjustTemperature', 'AdjustVibrance', 'AdjustColorBalance', 'AdjustBlackWhite', 'AdjustPhotoFilter', 'AdjustGradientMap', 'AdjustChannelMixer', 'AdjustPosterize',
  'AdjustVignette', 'AdjustShadowsHighlights', 'Duotone', 'SplitToning',
  'GradientMap', 'Posterize', 'Hologram', 'TwoDLight', 'LightLeak', 'LensFlare', 'Caustics', 'Blinds', 'CrossHatch', 'Dither',
  'Sharpen', 'Denoise', 'AdjustGlow', 'HighPass', 'Emboss', 'FindEdges', 'Blur', 'Bokeh', 'TiltShift', 'FrequencySeparation', 'HeightmapRelief', 'Outline', 'Sparkle',
  'Pixelate', 'Halftone', 'Kuwahara', 'Ascii',
  'CropImage', 'ResizeImage', 'RotateImage', 'FlipImage', 'Pinch', 'Twirl', 'Wave', 'LensCorrection', 'Kaleidoscope', 'PolarCoords', 'Fisheye', 'ChromaticAberration', 'CRT', 'Mirror', 'GodRays',
  'Blend', 'ApplyMask', 'ThresholdMask', 'ColorRangeMask', 'MatteGrowShrink', 'MergeAlpha', 'Painter',
  'FilmGrain', 'Glitch', 'PerlinNoise', 'Voronoi', 'GradientGenerator', 'PaletteQuantize', 'ReactionDiffusion', 'Fractal', 'Stipple', 'FlowField', 'AddNoise',
]

/** Each effect class's family (every generated class, ported or not). */
export const EFFECT_FAMILY_OF: Readonly<Record<string, EffectFamily>> = Object.fromEntries(
  Object.entries(EFFECT_SCHEMAS).map(([cls, s]) => [cls, s.family]),
)

/** The schema of a ported effect class, or undefined. */
export function effectSchemaOf(classType: string): EffectSchema | undefined {
  return EFFECT_CLASSES_PORTED.includes(classType) && Object.prototype.hasOwnProperty.call(EFFECT_SCHEMAS, classType)
    ? EFFECT_SCHEMAS[classType]
    : undefined
}

/** Whether an effect class is taken with these families on: its family, and `cards` (FAMILY_REQUIRES). */
export function effectFamilyOn(classType: string, families: ReadonlySet<RunnerFamily>): boolean {
  const family = Object.prototype.hasOwnProperty.call(EFFECT_FAMILY_OF, classType) ? EFFECT_FAMILY_OF[classType] : undefined
  return !!family && families.has(family) && families.has('cards')
}

// ── Widgets as execute() receives them ───────────────────────────────────────

/** A widget as ComfyUI's validate_inputs converts it (int(), float(), str(), bool()); eligibility has checked it converts. */
function widgetValue(type: string, v: unknown): unknown {
  if (v === undefined) return undefined
  switch (type) {
    case 'FLOAT': return typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : typeof v === 'string' ? pyFloatOf(v) : v
    case 'INT': return typeof v === 'number' ? Math.trunc(v) : typeof v === 'boolean' ? Number(v) : typeof v === 'string' ? pyIntOf(v) : v
    case 'BOOLEAN': return pyTruthy(v)
    case 'STRING':
    case 'COLOR':
      if (typeof v === 'string') return v
      if (typeof v === 'boolean') return v ? 'True' : 'False'
      return v === null ? 'None' : String(v)
    default: return v
  }
}

/** The node's widgets as its execute() receives them. */
export function effectParams(schema: EffectSchema, inputs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, w] of Object.entries(schema.widgets)) {
    const v = widgetValue(w.type, inputs[name])
    if (v !== undefined) out[name] = v
  }
  return out
}

// ── Limits (rule 7) ──────────────────────────────────────────────────────────

/** The largest picture an effect reads or makes: 8192 × 8192 pixels. */
export const EFFECT_MAX_PICTURE_PIXELS = 8192 * 8192
/** Hosted, a shared server: 4096² (eligibility.ts HOSTED_MAX_FRAME_ARTBOARD_PIXELS, the same number). */
export const EFFECT_HOSTED_MAX_PICTURE_PIXELS = 4096 * 4096
/**
 * The most work (pixel·steps, EffectSpec.work: pixels × channels × taps for
 * a convolution) one effect may ask for, so the heaviest allowed case
 * finishes in under 60 s. Measured on the development Mac (R2.1 report): a
 * float32 2,049-tap pass with reflect edges works through 0.37 × 10⁹ taps a
 * second, so 16 × 2³⁰ (17.2 × 10⁹) takes about 46 s. A 2k-tap separable
 * pass over 8192² × 4 (1.1 × 10¹² taps, about 49 minutes) is far over it.
 */
export const EFFECT_MAX_WORK = 16 * 1024 * 1024 * 1024

export const EFFECT_PICTURE_TOO_LARGE = 'This picture is too large for this effect (more than 8192 × 8192 pixels). Use a smaller picture.'
export const EFFECT_PICTURE_TOO_LARGE_HOSTED = 'This picture is too large for this effect (more than 4096 × 4096 pixels). Use a smaller picture.'
export const EFFECT_PICTURES_TOO_LARGE = 'The pictures this effect reads are too large to work on together (more than 268 million pixels). Use fewer or smaller pictures.'
export const EFFECT_PICTURE_ANIMATED = 'This picture is animated, and effects here take single pictures only. Save it as a PNG and load it again.'
/**
 * Classes the runner takes only up to a smaller picture than the effects'
 * cap (R2.7, the "warp" parity class): Kaleidoscope's grid (atan2, cos, sin
 * of torch's SLEEF, not correctly rounded) drifts from Python's by up to
 * 0.52 of a level at 4096² and 1.13 (an 8-bit ±2) at 8192², so it is taken
 * up to 4096² (R2.7 report, round 2). Checked before any pixel is decoded.
 */
export const EFFECT_CLASS_MAX_PIXELS: Readonly<Record<string, number>> = { Kaleidoscope: 4096 * 4096 }
export const EFFECT_PICTURE_TOO_LARGE_FOR_CLASS = 'This effect works on pictures up to 4096 × 4096 pixels. Use a smaller picture.'

/** The largest picture this class reads or makes, and the words for one past it. */
export function effectPictureCap(classType: string, hosted: boolean): { max: number; message: string } {
  const base = hosted
    ? { max: EFFECT_HOSTED_MAX_PICTURE_PIXELS, message: EFFECT_PICTURE_TOO_LARGE_HOSTED }
    : { max: EFFECT_MAX_PICTURE_PIXELS, message: EFFECT_PICTURE_TOO_LARGE }
  const own = Object.prototype.hasOwnProperty.call(EFFECT_CLASS_MAX_PIXELS, classType) ? EFFECT_CLASS_MAX_PIXELS[classType]! : Infinity
  return own < base.max ? { max: own, message: EFFECT_PICTURE_TOO_LARGE_FOR_CLASS } : base
}

export const EFFECT_TOO_MUCH_WORK = 'This effect would take too long on a picture this size. Use a smaller picture or a lighter setting.'

/** Where Python raises, the runner fails the node with these words (rule 6), keyed as the cores throw them. */
export const EFFECT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  EFFECT_NEEDS_RGB: 'This effect can’t work on a picture with see-through parts',
  EFFECT_PICTURE_TOO_SMALL: 'This picture is too small for this setting. Lower the setting or use a larger picture.',
  EFFECT_BATCHES_DIFFER: 'The pictures this effect combines come in different numbers',
  // R2.9: Film grain below size 1 makes a noise field larger than the picture, which Python can't add to it.
  EFFECT_GRAIN_TOO_FINE: 'This grain size is too fine for this picture. Use a grain size of 1 or more.',
}

// ── The live preview's name (rule 4) ─────────────────────────────────────────

/** server/runner/results.ts PREVIEW_NAME_RE, the name rule savePreviewAs keeps to (a test holds them equal). */
export const EFFECT_PREVIEW_NAME_RE = /^[\p{L}\p{N}_.-]{1,200}$/u

/** save_live_preview's name for a node: `live_preview_<node id>.png`, or null when the runner can't write it. */
export function effectPreviewName(nodeId: string): string | null {
  const name = `live_preview_${nodeId}.png`
  return EFFECT_PREVIEW_NAME_RE.test(name) ? name : null
}

// ── Output sizes and work known from the widgets (rule 7) ────────────────────

/** The generators (R2.9): no picture in; their size and their work are known from their widgets. */
export const EFFECT_GENERATOR_CLASSES: readonly string[] = ['PerlinNoise', 'Voronoi', 'GradientGenerator', 'ReactionDiffusion', 'Fractal']

/**
 * A number widget as ComfyUI's validation converts it (int() truncates a
 * float; text as Python reads it), or null when it isn't known here (a
 * link, text Python refuses).
 */
function widgetNumber(v: unknown, int: boolean): number | null {
  let n: number | null = null
  if (typeof v === 'number') n = v
  else if (typeof v === 'boolean') n = Number(v)
  else if (typeof v === 'string') n = int ? pyIntOf(v) : pyFloatOf(v)
  if (n === null || !Number.isFinite(n)) return null
  return int ? Math.trunc(n) : n
}

/** A generator's width × height from its widgets, or null. */
function generatorSize(inputs: Record<string, unknown>): { w: number; h: number } | null {
  const w = widgetNumber(inputs.width, true)
  const h = widgetNumber(inputs.height, true)
  return w !== null && h !== null && w > 0 && h > 0 ? { w, h } : null
}

/** The output size an effect's widgets decide on their own (the generators, R2.9), or null when it depends on the picture. */
export const EFFECT_WIDGET_SIZES: Readonly<Record<string, (inputs: Record<string, unknown>) => { w: number; h: number } | null>> =
  Object.fromEntries(EFFECT_GENERATOR_CLASSES.map(cls => [cls, generatorSize]))

/**
 * The work of reading, quantising and encoding a value (server/runner/effects/
 * plan.ts, measured in the R2.1 fix round): 6 units a value, 4 values a pixel,
 * in and out.
 */
export const EFFECT_IO_WORK_PER_VALUE = 6

/**
 * Each generator's own work from its widgets, in EffectSpec.work's units
 * (0.37 × 10⁹ a second), measured on the development Mac (R2.9 report: each
 * at a heavy setting in this thread, the constant set so its time at the
 * unit's rate is at or above the measured time): Perlin noise per octave a
 * bicubic value a pixel (PERLIN_PIXEL) and its random grid (RAND_VALUE a
 * value: below scale 1 the grid outgrows the picture); Voronoi a site's
 * distance and its topk step a pixel (VORONOI_SITE); Gradient its one pass
 * (GRADIENT_PIXEL); Reaction-diffusion an iteration's two Winograd laplacians
 * and its update a pixel (REACTION_STEP); Fractal an iteration of a pixel
 * still escaping (FRACTAL_STEP: every pixel counted at every iteration, the
 * most it can take).
 */
export const EFFECT_GENERATOR_UNITS = { PERLIN_PIXEL: 40, RAND_VALUE: 6, VORONOI_SITE: 4, GRADIENT_PIXEL: 6, REACTION_STEP: 24, FRACTAL_STEP: 5 } as const

/** A generator's own work from its widgets (null: not a generator, or a widget not known here). */
export function generatorWork(classType: string, inputs: Record<string, unknown>): number | null {
  if (!EFFECT_GENERATOR_CLASSES.includes(classType)) return null
  const size = generatorSize(inputs)
  if (!size) return null
  const px = size.w * size.h
  const U = EFFECT_GENERATOR_UNITS
  const int = (k: string) => widgetNumber(inputs[k], true)
  switch (classType) {
    case 'PerlinNoise': {
      const o = int('octaves')
      let sc = widgetNumber(inputs.scale, false)
      if (o === null || sc === null || !(sc > 0)) return null
      // Each octave's random grid (max(2, int(side / sc) + 1) a side; sc halves every octave) and its bicubic.
      let work = 0
      for (let i = 0; i < o; i++) {
        const grid = Math.max(2, Math.trunc(size.w / sc) + 1) * Math.max(2, Math.trunc(size.h / sc) + 1)
        work += px * U.PERLIN_PIXEL + grid * U.RAND_VALUE
        sc /= 2
      }
      return work
    }
    case 'Voronoi': { const n = int('points'); return n === null ? null : px * Math.max(0, n) * U.VORONOI_SITE }
    case 'GradientGenerator': return px * U.GRADIENT_PIXEL
    case 'ReactionDiffusion': { const it = int('iterations'); return it === null ? null : px * Math.max(0, it) * U.REACTION_STEP }
    default: { const it = int('max_iter'); return it === null ? null : px * Math.max(0, it) * U.FRACTAL_STEP }
  }
}

// ── Memory (R2.9 fix round 1) ────────────────────────────────────────────────

/**
 * The most float32 values one array an effect allocates may hold: 8192² × 4
 * (1 GiB, the largest picture's own tensor), and 4096² × 4 (256 MiB) hosted.
 * The time budget doesn't bound memory (Perlin noise's grid below scale 1
 * outgrows the picture while its work stays cheap).
 */
export const EFFECT_MAX_VALUES = 8192 * 8192 * 4
export const EFFECT_HOSTED_MAX_VALUES = 4096 * 4096 * 4
export const EFFECT_TOO_MUCH_MEMORY = 'This effect would need too much memory at this setting. Use a smaller picture or a lighter setting.'

/**
 * The largest single array (float32 values) the runner's port of an
 * effects-noise class allocates, from its widgets and (a picture class) its
 * picture's size, every picture counted at 4 channels; null when the class
 * has no count here (the earlier families: their largest is their picture,
 * give or take a padded copy; R2.9 report) or a widget isn't known here.
 *   Perlin noise — its largest octave's random grid (max(2, int(side / sc) + 1)
 *                  a side, sc halving every octave), or its 3-channel output;
 *   the other generators — their 3-channel output (Reaction-diffusion's state
 *                  and padded copies are single planes);
 *   Film grain   — its noise field (max(2, int(side / size)) a side) or its
 *                  output (a side of 1 grows to the field's below size 1);
 *   the other picture classes — the picture (Palette quantize's samples are
 *                  96² a picture; Add noise's draw one picture's values at a time).
 */
export function effectPeakValues(classType: string, inputs: Record<string, unknown>, size: { w: number; h: number } | null): number | null {
  if (EFFECT_GENERATOR_CLASSES.includes(classType)) {
    const s = generatorSize(inputs)
    if (!s) return null
    let peak = 3 * s.w * s.h
    if (classType === 'PerlinNoise') {
      const o = widgetNumber(inputs.octaves, true)
      let sc = widgetNumber(inputs.scale, false)
      if (o === null || sc === null || !(sc > 0)) return null
      for (let i = 0; i < o; i++) {
        peak = Math.max(peak, Math.max(2, Math.trunc(s.w / sc) + 1) * Math.max(2, Math.trunc(s.h / sc) + 1))
        sc /= 2
      }
    }
    return peak
  }
  if (!size || !Object.prototype.hasOwnProperty.call(EFFECT_FAMILY_OF, classType) || EFFECT_FAMILY_OF[classType] !== 'effects-noise') return null
  let peak = 4 * size.w * size.h
  if (classType === 'FilmGrain') {
    const grain = widgetNumber(inputs.size, false)
    if (grain === null || !(grain > 0)) return null
    const gh = Math.max(2, Math.trunc(size.h / grain))
    const gw = Math.max(2, Math.trunc(size.w / grain))
    peak = Math.max(peak, gh * gw, 4 * (size.h === 1 ? gh : size.h) * (size.w === 1 ? gw : size.w))
  }
  return peak
}

/** Whether an effect's largest single array fits the memory cap (unknown: yes, checked where it can be). */
export function effectPeakFits(classType: string, inputs: Record<string, unknown>, size: { w: number; h: number } | null, hosted: boolean): boolean {
  const peak = effectPeakValues(classType, inputs, size)
  return peak === null || peak <= (hosted ? EFFECT_HOSTED_MAX_VALUES : EFFECT_MAX_VALUES)
}

/**
 * Whether what an effect's widgets decide on their own fits: its output size
 * within the caps, its largest array within the memory cap (R2.9 fix round 1),
 * and a generator's work (its own and its output's I/O, as
 * planEffect counts it) within EFFECT_MAX_WORK. Anything not known from the
 * widgets is checked at the node's turn. Over it, the node is left to the
 * engine (R2.9: Reaction-diffusion at 1024² × 3000, say).
 */
export function effectOutputSizeFits(classType: string, inputs: Record<string, unknown>, hosted: boolean): boolean {
  const size = Object.prototype.hasOwnProperty.call(EFFECT_WIDGET_SIZES, classType) ? EFFECT_WIDGET_SIZES[classType]!(inputs) : null
  if (!size) return true
  if (size.w * size.h > (hosted ? EFFECT_HOSTED_MAX_PICTURE_PIXELS : EFFECT_MAX_PICTURE_PIXELS)) return false
  if (!effectPeakFits(classType, inputs, null, hosted)) return false
  const work = generatorWork(classType, inputs)
  return work === null || work + EFFECT_IO_WORK_PER_VALUE * 4 * size.w * size.h <= EFFECT_MAX_WORK
}

/**
 * The output size of an effect that changes the picture's size, from its
 * widgets (as its execute() receives them) and its input's size (R2.7), or
 * null when it keeps the input's size. Resize: floor(side · scale) each side
 * (F.interpolate's scale_factor; scale 1 is a plain clamp). Crop: x0 =
 * int(left·w), x1 = max(x0 + 1, int(w − right·w)), the same down the side
 * (nodes_geometry.py:34-41, in doubles). Used before any pixel is decoded:
 * at the start of the take when the picture's header can be read (an Image
 * card's or LoadImage's file), else at the node's turn (effects/plan.ts).
 */
export function effectOutSize(classType: string, widgets: Record<string, unknown>, size: { w: number; h: number }): { w: number; h: number } | null {
  const num = (k: string) => (typeof widgets[k] === 'number' ? widgets[k] as number : 0)
  if (classType === 'ResizeImage') {
    const s = num('scale')
    return s === 1 ? null : { w: Math.floor(size.w * s), h: Math.floor(size.h * s) }
  }
  if (classType === 'CropImage') {
    const x0 = Math.trunc(num('left') * size.w)
    const x1 = Math.max(x0 + 1, Math.trunc(size.w - num('right') * size.w))
    const y0 = Math.trunc(num('top') * size.h)
    const y1 = Math.max(y0 + 1, Math.trunc(size.h - num('bottom') * size.h))
    return { w: Math.min(x1, size.w) - x0, h: Math.min(y1, size.h) - y0 }
  }
  return null
}

/** The classes whose output size effectOutSize knows (they change the picture's size). */
export const EFFECT_RESIZING_CLASSES: readonly string[] = ['ResizeImage', 'CropImage']

/** The classes whose picture is sized at the start of the take from a loader's header: those that resize it, and those with a cap of their own. */
export const EFFECT_START_SIZED_CLASSES: readonly string[] = [...EFFECT_RESIZING_CLASSES, ...Object.keys(EFFECT_CLASS_MAX_PIXELS)]

// ── Colour text (R2.4) ───────────────────────────────────────────────────────

/**
 * The text widgets an effect reads as colours, and how: a hex colour
 * (_hex_to_rgb), gradient stops (parse_stops) or a duotone pair
 * (parse_duotone). The runner takes the node only while it reads that text
 * exactly as Python does (./gradientStops.ts `*TextIsPortable`).
 */
export const EFFECT_TEXT_WIDGETS: Readonly<Record<string, Readonly<Record<string, 'hex' | 'stops' | 'duotone'>>>> = {
  AdjustGradientMap: { stops: 'stops' },
  Duotone: { duotone: 'duotone' },
  GradientMap: { dark_color: 'hex', light_color: 'hex' },
  TwoDLight: { color: 'hex' },
  Outline: { line_color: 'hex', fill_color: 'hex' },
  Stipple: { dot_color: 'hex', bg_color: 'hex' },
}

/** Whether the runner reads an effect's colour text as Python does (nothing to read: yes). */
export function effectTextIsPortable(classType: string, inputs: Record<string, unknown>): boolean {
  const widgets = Object.prototype.hasOwnProperty.call(EFFECT_TEXT_WIDGETS, classType) ? EFFECT_TEXT_WIDGETS[classType]! : {}
  return Object.entries(widgets).every(([name, kind]) =>
    kind === 'hex' ? hexTextIsPortable(inputs[name]) : kind === 'stops' ? stopsTextIsPortable(inputs[name]) : duotoneTextIsPortable(inputs[name]))
}

// ── Ascii's characters (R2.6) ────────────────────────────────────────────────

const GLYPHS: ReadonlySet<string> = new Set([...ASCII_GLYPH_CHARACTERS])

/**
 * The ramp the Ascii node draws with (nodes_glsl_stylize.py:275-281), one
 * character per code point: its preset's, or with `custom` the text when it
 * has at least two characters (else _ASCII_DEFAULT). Null when a custom text
 * isn't a string (str() of a number the runner can't read as Python writes it).
 */
export function asciiRampOf(preset: unknown, characters: unknown): string[] | null {
  if (preset !== 'custom') {
    const ramp = typeof preset === 'string' && Object.prototype.hasOwnProperty.call(ASCII_PRESETS, preset) ? ASCII_PRESETS[preset]! : ASCII_DEFAULT
    return [...ramp]
  }
  if (typeof characters !== 'string') return null
  const chars = [...characters]
  return chars.length >= 2 ? chars : [...ASCII_DEFAULT]
}

/** Whether every character of the ramp an Ascii node draws is in the runner's glyph atlas (server/runner/effects/asciiGlyphs.bin). */
export function asciiGlyphsArePortable(inputs: Record<string, unknown>): boolean {
  const ramp = asciiRampOf(inputs.preset, inputs.characters)
  return !!ramp && ramp.every(ch => GLYPHS.has(ch))
}

// ── Painter (R2.8) ───────────────────────────────────────────────────────────

/**
 * Painter's bg_color as its own hex_to_rgb reads it (nodes_painter.py:16-23):
 * every leading '#' stripped; not six characters (code points) → black; six
 * hex digits → each pair / 255. Null for six characters Python's int(…, 16)
 * would read otherwise or refuse (a sign, a space, a letter past f): left to
 * the engine. Not text at all: null too.
 */
export function painterColourOf(text: unknown): [number, number, number] | null {
  if (typeof text !== 'string') return null
  let i = 0
  while (text[i] === '#') i++
  const hex = text.slice(i)
  if ([...hex].length !== 6) return [0, 0, 0]
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
  return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255]
}

/**
 * Whether the runner reads Painter's painter file name as Python does
 * (`mask and mask.strip()`, then folder_paths.get_annotated_filepath): none
 * (empty or blank), or a plain relative name, optionally with one space and
 * `[input]`, `[output]` or `[temp]` after it; no surrounding spaces, no
 * blank but the space, no control character, no backslash, no empty, '.' or
 * '..' part (so no absolute path). Anything else is left to the engine.
 */
export function painterFileIsPortable(text: unknown): boolean {
  if (typeof text !== 'string') return false
  // Python's strip() and JavaScript's trim() agree on the plain space alone: any other blank or control character is Python's to read.
  if (/[^\S ]|[\x00-\x1f\x7f-\x9f]/.test(text)) return false
  if (!text.trim()) return true
  if (text !== text.trim() || text.includes('\\')) return false
  const m = /^(.*) \[(?:input|output|temp)\]$/.exec(text)
  const name = m ? m[1]! : text
  if (/\[(?:input|output|temp)\]$/.test(name) || name !== name.trim()) return false
  return name.split('/').every(p => p !== '' && p !== '.' && p !== '..')
}

/** Painter's inputs the runner reads as Python does: its file name, and (with no picture wired in) its colour. */
export function painterInputsArePortable(inputs: Record<string, unknown>): boolean {
  if (!painterFileIsPortable(inputs.mask)) return false
  return isLink(inputs.image) || painterColourOf(inputs.bg_color) !== null
}

/** The input checks a class carries beyond every effect's own (R2.4's colour text, R2.6's characters, R2.8's Painter). */
function extraChecks(cls: string): InputCheckName[] {
  if (Object.prototype.hasOwnProperty.call(EFFECT_TEXT_WIDGETS, cls)) return ['effect-text']
  if (cls === 'Ascii') return ['ascii-glyphs']
  if (cls === 'Painter') return ['painter']
  return []
}

/** Painter writes no live preview (its ui is a PreviewImage of its own name): no preview-name check. */
const ownChecks = (cls: string): InputCheckName[] => (cls === 'Painter' ? ['effect-output-size'] : ['effect-preview-name', 'effect-output-size'])

// ── Rows (rule 1) ────────────────────────────────────────────────────────────

/** A generated widget as ComfyUI's validation reads it (a COLOR is validated as nothing more than a value). */
function widgetSpec(w: EffectSchema['widgets'][string]): RunnerWidgetSpec {
  const type = w.type === 'COLOR' ? 'STRING' : w.type
  return {
    type,
    ...(w.required ? { required: true } : {}),
    ...(w.min !== undefined ? { min: w.min } : {}),
    ...(w.max !== undefined ? { max: w.max } : {}),
    ...(w.options ? { options: w.options } : {}),
  }
}

/**
 * The rule row of each ported effect: its family; a local render (it writes a
 * live preview, so it counts as work, controller ruling (a)); its widgets as
 * ComfyUI validates them; its required pictures and masks linked; each IMAGE
 * input a picture and each MASK input a mask value; the node id fit for the
 * preview's name, an output size from the widgets within the caps, any
 * colour text read as Python reads it (EFFECT_TEXT_WIDGETS), and Ascii's
 * characters all in the runner's glyph atlas ('ascii-glyphs').
 */
export function effectRows(): Record<string, RunnerNodeRule> {
  const rows: Record<string, RunnerNodeRule> = {}
  for (const cls of EFFECT_CLASSES_PORTED) {
    const s = EFFECT_SCHEMAS[cls]!
    const required = [...s.images, ...s.masks].filter(i => i.required).map(i => i.name)
    rows[cls] = {
      family: s.family,
      local: 'render',
      ...(required.length ? { mustLink: required, required } : {}),
      ...(s.images.length ? { imageInputs: s.images.map(i => i.name) } : {}),
      ...(s.masks.length ? { valueInputs: Object.fromEntries(s.masks.map(m => [m.name, ['mask'] as const])) } : {}),
      widgets: Object.fromEntries(Object.entries(s.widgets).map(([k, w]) => [k, widgetSpec(w)])),
      inputCheck: [...ownChecks(cls), ...extraChecks(cls)],
    }
  }
  return rows
}

/** Each ported effect's family, for SWITCHED_CLASSES (a class known only while its family is on). */
export function effectSwitchedClasses(): Record<string, RunnerFamily> {
  return Object.fromEntries(EFFECT_CLASSES_PORTED.map(cls => [cls, EFFECT_SCHEMAS[cls]!.family]))
}

/** The output slots of each ported effect that carry a mask (the others carry pictures). */
export const EFFECT_OUTPUT_KINDS: Readonly<Record<string, Readonly<Record<number, ValueKind>>>> = Object.fromEntries(
  EFFECT_CLASSES_PORTED
    .map(cls => [cls, Object.fromEntries(EFFECT_SCHEMAS[cls]!.outputs.flatMap((o, i) => o === 'mask' ? [[i, 'mask' as const]] : []))] as const)
    .filter(([, kinds]) => Object.keys(kinds).length > 0),
)

/** The picture output slots of each ported effect. */
export const EFFECT_PICTURE_OUTPUTS: Readonly<Record<string, readonly number[]>> = Object.fromEntries(
  EFFECT_CLASSES_PORTED.map(cls => [cls, EFFECT_SCHEMAS[cls]!.outputs.flatMap((o, i) => o === 'image' ? [i] : [])]),
)

/** The ported effects that are ComfyUI output nodes (validate.ts RUNNER_OUTPUT_CLASSES). */
export const EFFECT_OUTPUT_NODES: readonly string[] = EFFECT_CLASSES_PORTED.filter(cls => EFFECT_SCHEMAS[cls]!.outputNode)
