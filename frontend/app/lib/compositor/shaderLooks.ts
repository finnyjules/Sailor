/**
 * The compositor AGENT's curated vocabulary for the two PICKER shader-effect kinds
 * (F5 `shader`, F6 `backdrop_shader`). Both carry an `effectId` naming a Shader
 * Studio catalog effect; the UI lets a user pick any input-sampling effect, but the
 * agent is taught a small, named-look SUBSET (Julien's call — mosaic-Look precedent),
 * NOT the whole ~80-effect catalog (too many chars for the hint budget) and NOT
 * picker-only (the agent could then never add one at all).
 *
 * Each entry's `effectId` MUST be a real catalog id whose GLSL SAMPLES `u_image0`
 * (`effectReadsInput` true — the same picker-eligibility gate F5/F6 use): a look that
 * ignored its input would silently overwrite the layer's own pixels instead of
 * processing them. `tests/unit/shader-looks.unit.spec.ts` pins every id here against
 * the on-disk catalog through `effectReadsInput`, so a typo'd or generative id fails
 * a unit rather than shipping a dead look.
 *
 * Pure and network-free — safe to import from the agent surface.
 */
export interface ShaderLook {
  /** The human word the model names the look by (spaces ok, case-insensitive). */
  word: string
  /** The catalog effect id it resolves to (input-sampling — see the module doc). */
  effectId: string
}

/** The curated looks, each a recognisable print/photo treatment named in plain words.
 *  Every `effectId` is verified input-sampling (see shader-looks.unit.spec.ts). */
export const SHADER_LOOK_WORDS: ShaderLook[] = [
  { word: 'chromatic aberration', effectId: 'chromatic_aberration' },
  { word: 'liquify', effectId: 'liquify' },
  { word: 'halftone', effectId: 'halftone' },
  { word: 'pixelate', effectId: 'pixelate' },
  { word: 'hue shift', effectId: 'hue_shift' },
  { word: 'dot screen', effectId: 'dot_screen' },
  { word: 'crosshatch', effectId: 'crosshatch' },
  { word: 'oil paint', effectId: 'oil_paint' },
]

/** Normalise for matching: lower-case, treat `_`/`-` as spaces, collapse runs of
 *  whitespace. So "Hue Shift", "hue_shift" and "hue-shift" all match one entry. */
const norm = (s: string): string => s.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')

/** Resolve a model-supplied look WORD (case-insensitive, spaces/underscores/hyphens
 *  interchangeable) OR a curated effectId to its catalog effectId; null for anything
 *  not in the curated set (an arbitrary/unknown id is rejected, not silently applied). */
export function resolveShaderLook(wordOrId: string): string | null {
  const q = norm(String(wordOrId ?? ''))
  if (!q) return null
  for (const l of SHADER_LOOK_WORDS) {
    if (norm(l.word) === q || norm(l.effectId) === q) return l.effectId
  }
  return null
}
