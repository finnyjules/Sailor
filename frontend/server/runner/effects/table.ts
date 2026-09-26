/**
 * How the runner works each ported effect (step 3, R2): the worker op that
 * runs one picture, how a batch is worked (rule 5), and what a class may
 * declare about its work and output size before any pixel is decoded
 * (rule 7). Its classes are exactly shared/runner/effects.ts
 * EFFECT_CLASSES_PORTED (a test holds them equal).
 */
import type { EffectFamily } from '#shared/runner/effects'
import { hexToRgb, parseDuotone, parseStops } from '#shared/runner/gradientStops'

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
   * The widgets as the core takes them, when some need reading on the main
   * thread first (R2.4: colour text, parsed as Python parses it by
   * shared/runner/gradientStops.ts, which the self-contained cores can't
   * import). Everything else keeps its value.
   */
  prepare?(widgets: Record<string, unknown>): Record<string, unknown>
}

const tone = (name: string, prepare?: EffectSpec['prepare']): EffectSpec => ({ family: 'effects-tone', op: `tone.${name}`, batch: 'pure', ...(prepare ? { prepare } : {}) })

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
}

/** The runner's spec for an effect class, or undefined when the class is not an effect it ports. */
export function effectSpec(classType: string): EffectSpec | undefined {
  return Object.prototype.hasOwnProperty.call(EFFECTS, classType) ? EFFECTS[classType] : undefined
}
