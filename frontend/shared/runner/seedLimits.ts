/**
 * Seeds a provider takes below the node's own widget maximum (R3.12 fix
 * round 1). The canvas rerolls an unlocked seed before every Run
 * (VueNodeCanvas.vue randomizeSeedsOnLiveState); drawn up to the widget's
 * max (0xFFFFFFFF), about half the draws would be a seed the provider
 * refuses — after the hold on the runner, after the call on the ComfyUI
 * path. The reroll draws within min(widget max, provider max) instead.
 *
 * Only classes whose every call is capped are listed (by class, then widget
 * name). Model-level caps inside the generators (Ideogram V2/V3 and Qwen
 * Image 3 on Generate an image, Wan 3.0 and HappyHorse 1.1 on Generate a
 * video) are folded into range by their builders, so they need no row;
 * Separate text from image (Ideogram Layerize) already declares 0x7FFFFFFF
 * as its widget max.
 *
 * Pure; relative imports only (the app, Nitro and vitest all load it).
 */
import { IDEOGRAM_SEED_MAX } from './imageExtras'

export const PROVIDER_SEED_MAX: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  // Text effect: Ideogram V3 Turbo's `seed` maximum (Flux Kontext Pro, its restyle model, takes any).
  TextEffectNode: { seed: IDEOGRAM_SEED_MAX },
  // Generate face references: Ideogram Character's `seed` maximum.
  ConsistentFaceNode: { seed: IDEOGRAM_SEED_MAX },
}

const LARGEST = 2 ** 53 - 1

/** The largest seed a reroll may draw for this widget: min(widget max, the provider's), never past 2^53 − 1. */
export function seedRerollMax(classType: string, widgetName: string, widgetMax: unknown): number {
  const own = Math.min(Number(widgetMax) || LARGEST, LARGEST)
  const row = Object.prototype.hasOwnProperty.call(PROVIDER_SEED_MAX, classType) ? PROVIDER_SEED_MAX[classType]! : undefined
  const cap = row && Object.prototype.hasOwnProperty.call(row, widgetName) ? row[widgetName]! : LARGEST
  return Math.min(own, cap)
}

/** A rerolled seed in 0 … seedRerollMax − 1 (the canvas's draw, `random` in [0, 1)). */
export function rerolledSeed(classType: string, widgetName: string, widgetMax: unknown, random: () => number = Math.random): number {
  return Math.floor(random() * seedRerollMax(classType, widgetName, widgetMax))
}
