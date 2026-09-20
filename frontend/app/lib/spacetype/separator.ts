/**
 * The separator: a library shape painted between word repeats in the tile
 * texture, so "SAILOR ✦ SAILOR ✦" rides every tile-based effect.
 *
 * Three pieces, one file: the controls (appended once, at registration, to
 * every eligible effect — never pasted into 22 effect modules), the eligibility
 * rule, and the resolver both tile-option builders call so the modal, the node
 * card, the clip renderer, the headless bake and the embed cannot disagree.
 */
import type { ControlSpec, Params, SpaceTypeEffect } from './effect'
import { RAW_WORD_EFFECTS, PER_GLYPH_EFFECTS, isShowcaseEffectId } from './effect'
import { shapeById, SHAPE_NONE, type LibraryShape } from '~/lib/shapes/catalog'

export const SEPARATOR_DEFAULT_SIZE = 0.7
export const SEPARATOR_DEFAULT_GAP = 1

/** Size is a fraction of cap height; spacing is quarter-ems on each side of the shape. */
export const SEPARATOR_CONTROLS: ControlSpec[] = [
  { key: 'separator', label: 'Separator', kind: 'shape', default: SHAPE_NONE, group: 'Type',
    hint: 'A shape drawn between repeats of the text, or none.' },
  { key: 'separatorSize', label: 'Separator size', kind: 'slider', min: 0.3, max: 1.5, step: 0.05, default: SEPARATOR_DEFAULT_SIZE,
    group: 'Type', showIf: { key: 'separator', notEquals: SHAPE_NONE } },
  { key: 'separatorGap', label: 'Separator spacing', kind: 'slider', min: 0, max: 3, step: 0.05, default: SEPARATOR_DEFAULT_GAP,
    group: 'Type', showIf: { key: 'separator', notEquals: SHAPE_NONE } },
]

/** Per-glyph effects whose layout can carry the separator as an extra glyph (charLayout's `separator`). */
export const PER_GLYPH_SEPARATOR_READY: ReadonlySet<string> = new Set(['cylinder'])

/** Tile-based effects, plus per-glyph effects that opted in via PER_GLYPH_SEPARATOR_READY:
 *  raw-word effects have no tile gap; the rest of the per-glyph effects never sample the tile. */
export function separatorEligible(effectId: string): boolean {
  if (RAW_WORD_EFFECTS.has(effectId)) return false
  // Showcase lays out its own tiles (cards, words, letters) and never samples the tile atlas.
  if (isShowcaseEffectId(effectId)) return false
  return !PER_GLYPH_EFFECTS.has(effectId) || PER_GLYPH_SEPARATOR_READY.has(effectId)
}

/**
 * A NEW effect object with the controls appended (no mutation, so module
 * evaluation order cannot matter — see memory "eager module const + init
 * order"). Ineligible effects and already-injected ones are returned as-is.
 */
export function withSeparatorControls(effect: SpaceTypeEffect): SpaceTypeEffect {
  if (!separatorEligible(effect.id)) return effect
  if (effect.controls.some(c => c.key === 'separator')) return effect
  // Per-glyph effects (cylinder) place glyphs at uniform angles by index — separatorGap
  // only pads the tile atlas, which cylinder never samples, so the dial does nothing
  // visible there. Tile-based effects keep all three controls.
  const controls = PER_GLYPH_SEPARATOR_READY.has(effect.id)
    ? SEPARATOR_CONTROLS.filter(c => c.key !== 'separatorGap')
    : SEPARATOR_CONTROLS
  return { ...effect, controls: [...effect.controls, ...controls] }
}

export interface SeparatorSpec {
  shape: LibraryShape
  /** Fraction of cap height. */
  size: number
  /** Quarter-ems on each side of the shape. */
  gap: number
}

/** Undefined for none, an unknown id (catalog churn degrades to no separator), or an ineligible effect. */
export function separatorFromParams(effectId: string, p: Params): SeparatorSpec | undefined {
  if (!separatorEligible(effectId)) return undefined
  const id = String(p.separator ?? SHAPE_NONE)
  if (id === SHAPE_NONE) return undefined
  const shape = shapeById(id)
  if (!shape) return undefined
  const size = Number(p.separatorSize)
  const gap = Number(p.separatorGap)
  return {
    shape,
    size: Number.isFinite(size) ? size : SEPARATOR_DEFAULT_SIZE,
    gap: Number.isFinite(gap) ? gap : SEPARATOR_DEFAULT_GAP,
  }
}
