// frontend/app/lib/texturefx/templates.ts
//
// One-click presets for Pattern Studio's tileable `dealtgrid` texture mode. A preset
// is a starting point named for its STRUCTURE (how even, how loose, how dense) —
// picking one writes the individual dealt-grid dials (Cells / Density / Size
// variance) and the colour vocabulary (dgVocab). It is a convenience that expands to
// the same controls the user could set by hand, so after applying every dial stays
// live and tweakable — the preset value is not sticky.
//
// These are NOT the playgrnd grid tools (Modular / Parcel / Mosh live as Frame deal
// generators under lib/compositor; Oddgrid / Static are Shader Studio generatives) —
// the dealt grid is its own rigid tileable pattern, so its presets carry plain
// structural names rather than borrowing those tools' names.

import type { Params } from '~/lib/spacetype/effect'
import type { DealVocab } from '~/lib/compositor/dealVocab'

// The 'Preset' select's neutral value — no preset applied (hand-tuned / custom).
// Lives here (not controls.ts) so the sentinel travels with the apply logic.
export const DEALTGRID_TEMPLATE_NONE = '—'

/** The dealt-grid params a preset sets. `vocab` selects the role-colour family (see
 *  the dealt-grid `dgVocab` control); structure is cells / density / size-variance.
 *  Tileable, so no merge/symmetry — the character comes from count and variance. */
export interface DealtGridPreset {
  dgCells: number          // 2..24 cells across
  dgDensity: number        // 0.15..1
  dgSizeVar: number        // 0..1
  vocab: DealVocab
}

export const DEALTGRID_PRESETS: Readonly<Record<string, DealtGridPreset>> = {
  Even:   { dgCells: 8,  dgDensity: 1,   dgSizeVar: 0,    vocab: 'brand' },  // equal cells, every one filled
  Loose:  { dgCells: 10, dgDensity: 1,   dgSizeVar: 0.5,  vocab: 'brand' },  // varied tile sizes, open gutters
  Dense:  { dgCells: 12, dgDensity: 1,   dgSizeVar: 0.25, vocab: 'warm' },   // finer, mostly flush, warm inks
  Packed: { dgCells: 16, dgDensity: 0.8, dgSizeVar: 0.7,  vocab: 'brand' },  // tight, uneven, a few cells dropped
  Fine:   { dgCells: 22, dgDensity: 0.6, dgSizeVar: 0.1,  vocab: 'mono' },   // tiny sparse cells, mostly grey
}

/** The preset names, in picker order (also the agent words). */
export const DEALTGRID_PRESET_IDS: readonly string[] = Object.keys(DEALTGRID_PRESETS)

/**
 * Write a dealt-grid preset into a params bag, in place.
 * Sets dgCells / dgDensity / dgSizeVar / dgVocab from `DEALTGRID_PRESETS[id]` and
 * records the choice in dgTemplate. The neutral sentinel or an unknown id only
 * records the choice (the dials keep whatever they hold). Returns the same bag for
 * chaining. Reuse of the global `seed` is intentional — a preset sets structure and
 * palette, not the shuffle.
 */
export function applyGridTemplate(params: Params, id: string): Params {
  const bag = params as Record<string, unknown>
  bag.dgTemplate = id
  const t = id === DEALTGRID_TEMPLATE_NONE ? undefined : DEALTGRID_PRESETS[id]
  if (t) {
    bag.dgCells = t.dgCells
    bag.dgDensity = t.dgDensity
    bag.dgSizeVar = t.dgSizeVar
    bag.dgVocab = t.vocab
  }
  return params
}
