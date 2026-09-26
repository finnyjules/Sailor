/**
 * How the runner works each ported effect (step 3, R2): the worker op that
 * runs one picture, how a batch is worked (rule 5), and what a class may
 * declare about its work and output size before any pixel is decoded
 * (rule 7). Its classes are exactly shared/runner/effects.ts
 * EFFECT_CLASSES_PORTED (a test holds them equal).
 */
import type { EffectFamily } from '#shared/runner/effects'

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
}

export const EFFECTS: Readonly<Record<string, EffectSpec>> = {
  // ── effects-tone (R2.1 pilots): per pixel, exact ──
  AdjustExposure: { family: 'effects-tone', op: 'tone.AdjustExposure', batch: 'pure' },
  AdjustInvert: { family: 'effects-tone', op: 'tone.AdjustInvert', batch: 'pure' },
  AdjustThreshold: { family: 'effects-tone', op: 'tone.AdjustThreshold', batch: 'pure' },
}

/** The runner's spec for an effect class, or undefined when the class is not an effect it ports. */
export function effectSpec(classType: string): EffectSpec | undefined {
  return Object.prototype.hasOwnProperty.call(EFFECTS, classType) ? EFFECTS[classType] : undefined
}
