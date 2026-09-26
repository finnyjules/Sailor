import { effectReadsInput, getEffectSync, resolveEffectId } from '~/lib/shaderfx/catalogStore'
import { addEffect, type EffectInstance } from '~/lib/compositor/effectStack'
import { myEffectIdOf } from '~/lib/myEffects/defs'

export interface BrushEffect {
  id: string
  label: string
  swatch: string /* CSS background */
}

/** The 7 curated painted effects, in order. Swatches lifted from the prototype's
 *  EFFECTS table (docs/superpowers/specs/assets/2026-09-26-shader-brush-prototype.html). */
export const BRUSH_EFFECTS: readonly BrushEffect[] = [
  { id: 'water_ripple', label: 'Ripple', swatch: 'repeating-radial-gradient(circle at 50% 50%, #7fb8ff 0 3px, #22406e 3px 6px)' },
  { id: 'blinds', label: 'Reeded glass', swatch: 'repeating-linear-gradient(90deg, #cfe6ff 0 3px, #5d7ea8 3px 5px, #eaf4ff 5px 6px)' },
  { id: 'bloom', label: 'Glow', swatch: 'radial-gradient(circle, #fff6d6 0 20%, #ffb35c 45%, #3a1d10 80%)' },
  { id: 'bayer_dither', label: 'Dither', swatch: 'repeating-conic-gradient(#f5ead4 0 25%, #1c1a3a 0 50%) 0 0 / 6px 6px' },
  { id: 'chromatic_aberration', label: 'Colour split', swatch: 'linear-gradient(90deg, #ff3b5c 0 33%, #3bff9d 33% 66%, #3b6bff 66%)' },
  { id: 'pixelate', label: 'Pixels', swatch: 'conic-gradient(#b94a7c 0 25%, #f5a35a 0 50%, #5b2d63 0 75%, #ffd08a 0) 0 0 / 13px 13px' },
  { id: 'gaussian_blur', label: 'Frost', swatch: 'radial-gradient(circle at 35% 35%, #ffffff, #cfd9e6 55%, #8d9bb0)' },
] as const

export const DEFAULT_BRUSH_EFFECT = 'water_ripple'

/** Paint gallery: generative defs, or defs in the 'material' category. */
export function paintGalleryInclude(def: { id: string; generative?: boolean; category?: string }): boolean {
  return def.generative === true || def.category === 'material'
}

/** Effect gallery: defs whose shader reads its input texture. */
export function effectGalleryInclude(def: { id: string }): boolean {
  return effectReadsInput(def.id)
}

/** Curated label when the id is one of the 7; otherwise the catalogue def's name; otherwise 'Effect'. */
export function brushEffectLabel(id: string): string {
  const curated = BRUSH_EFFECTS.find(e => e.id === id)
  if (curated) return curated.label
  return getEffectSync(id)?.name ?? 'Effect'
}

/** A painted-effect layer's fill. Never drawn (showPaint: false), but its alpha scales the
 *  coverage that drives the effect through destination-in, so it is always opaque white:
 *  a toolbar colour carrying alpha would weaken the effect for good. */
export const EFFECT_LAYER_FILL = '#ffffff'

/** `stack` with its one backdrop_shader running `effectId`: an existing one switches effect
 *  (params reset, since they are per-effect) and is shown again if hidden; with none, one is
 *  added exactly as a new painted-effect layer gets it (addEffect's defaults, speed 0). */
export function withPaintedEffect(stack: EffectInstance[], effectId: string): EffectInstance[] {
  if (stack.some(e => e.type === 'backdrop_shader')) {
    return stack.map(e => (e.type === 'backdrop_shader' ? { ...e, effectId, params: {}, visible: true } : e))
  }
  return addEffect(stack, 'backdrop_shader')
    .map(e => (e.type === 'backdrop_shader' ? { ...e, effectId, speed: 0 } : e))
}

/** True when a remembered brush id (the toolbar's effect or shader paint) no longer names an
 *  effect in `effects`. Resolves legacy aliases; pinned My effect ids (`mine_x~vN`) are in the
 *  catalogue as their own defs. A My effect id is never judged stale before the My effects
 *  library has loaded, since the catalogue publishes the built-ins first. */
export function brushIdIsStale(id: string, effects: readonly { id: string }[], myEffectsLoaded: boolean): boolean {
  const want = resolveEffectId(id)
  if (effects.some(e => e.id === want)) return false
  return !myEffectIdOf(id) || myEffectsLoaded
}
