// frontend/app/lib/frame/gridTemplates.ts
//
// Grid TEMPLATES — the playgrnd grid/composition family (Oddgrid, Modular, Parcel,
// Mosh, Static) as one-click presets. In playgrnd these five tools SHARE a single
// grid generator; in Sailor that substrate is two engines — the Frame's generative
// `deal` layer (whole-frame compositions that bake) and Pattern Studio's tileable
// `dealtgrid` texture mode. A template therefore carries BOTH engine configs, tuned
// so the same NAMED look reads faithfully on each surface (the two engines seed
// differently, so a template cannot be one shared number — it is two expressions of
// one character).
//
// The values below come from reading each tool's actual composition, not its slider
// names: Modular = a clean Swiss modular grid of equal tiles; Oddgrid = an uneven
// grid of varied-size tiles; Parcel = land-parcel subdivision (a few big units among
// small ones); Mosh = dense glitch rect bands; Static = tiny near-random pixel
// regions. They are starting points meant to be tasted and tuned, not final.

import type { DealVocab } from '~/lib/compositor/dealVocab'

/** The Frame `deal` layer's tunable shape (a subset of DealLayer — the fields a
 *  template sets; grid.mode is forced to 'generated' when a template is applied). */
export interface DealTemplateConfig {
  vocab: DealVocab
  density: number          // 0..1 fraction of cells kept
  cellInset: number        // 0..0.4 per-cell inset
  gen: {
    colRange: [number, number]
    rowRange: [number, number]
    regularity: number     // 0 free … 1 equal
    merge: boolean
    mergeMaxSpan: number
    symmetry: 'none' | 'mirror'
  }
}

/** Pattern Studio's `dealtgrid` texture params a template sets. `vocab` selects the
 *  role-colour family (see the dealt-grid `dgVocab` control); structure is cells /
 *  density / size-variance. Tileable, so no merge/symmetry — the character comes
 *  from cell count and variance. */
export interface DealtGridTemplateConfig {
  dgCells: number          // 2..24 cells across
  dgDensity: number        // 0.15..1
  dgSizeVar: number        // 0..1
  vocab: DealVocab
}

export interface GridTemplate {
  id: string               // stable key; also the agent word ("oddgrid", "modular", …)
  name: string             // UI label
  blurb: string            // one line, plain language, for the picker tooltip / agent hint
  deal: DealTemplateConfig
  pattern: DealtGridTemplateConfig
}

export const GRID_TEMPLATES: readonly GridTemplate[] = [
  {
    id: 'modular',
    name: 'Modular',
    blurb: 'A clean Swiss modular grid — equal cells, every cell filled.',
    deal: {
      vocab: 'brand', density: 1, cellInset: 0.04,
      gen: { colRange: [6, 6], rowRange: [4, 4], regularity: 1, merge: false, mergeMaxSpan: 1, symmetry: 'none' },
    },
    pattern: { dgCells: 8, dgDensity: 1, dgSizeVar: 0, vocab: 'brand' },
  },
  {
    id: 'oddgrid',
    name: 'Oddgrid',
    blurb: 'An uneven grid of varied-size tiles — merged units, loose spacing.',
    deal: {
      vocab: 'brand', density: 1, cellInset: 0.02,
      gen: { colRange: [5, 7], rowRange: [3, 5], regularity: 0.35, merge: true, mergeMaxSpan: 3, symmetry: 'none' },
    },
    pattern: { dgCells: 10, dgDensity: 1, dgSizeVar: 0.5, vocab: 'brand' },
  },
  {
    id: 'parcel',
    name: 'Parcel',
    blurb: 'Land-parcel subdivision — a few big blocks among many small ones.',
    deal: {
      vocab: 'warm', density: 1, cellInset: 0.015,
      gen: { colRange: [6, 8], rowRange: [4, 6], regularity: 0.55, merge: true, mergeMaxSpan: 4, symmetry: 'none' },
    },
    pattern: { dgCells: 12, dgDensity: 1, dgSizeVar: 0.25, vocab: 'warm' },
  },
  {
    id: 'mosh',
    name: 'Mosh',
    blurb: 'Dense glitch rect bands — packed, chaotic, some cells dropped.',
    deal: {
      vocab: 'brand', density: 0.85, cellInset: 0,
      gen: { colRange: [8, 12], rowRange: [6, 10], regularity: 0.2, merge: true, mergeMaxSpan: 5, symmetry: 'none' },
    },
    pattern: { dgCells: 16, dgDensity: 0.8, dgSizeVar: 0.7, vocab: 'brand' },
  },
  {
    id: 'static',
    name: 'Static',
    blurb: 'Tiny near-random pixel regions — TV static, mostly monochrome.',
    deal: {
      vocab: 'mono', density: 0.7, cellInset: 0,
      gen: { colRange: [14, 18], rowRange: [10, 14], regularity: 0.1, merge: false, mergeMaxSpan: 1, symmetry: 'none' },
    },
    pattern: { dgCells: 22, dgDensity: 0.6, dgSizeVar: 0.1, vocab: 'mono' },
  },
] as const

/** Look a template up by id (the agent word / picker key). */
export function gridTemplate(id: string): GridTemplate | undefined {
  return GRID_TEMPLATES.find(t => t.id === id)
}

/** The template ids, for control options / agent enums. */
export const GRID_TEMPLATE_IDS: readonly string[] = GRID_TEMPLATES.map(t => t.id)
