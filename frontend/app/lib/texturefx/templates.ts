// frontend/app/lib/texturefx/templates.ts
//
// Applying the SHARED grid templates (Modular / Oddgrid / Parcel / Mosh / Static —
// lib/frame/gridTemplates.ts) to Pattern Studio's tileable `dealtgrid` texture mode.
// A template is a one-click starting point: picking one writes the individual
// dealt-grid dials (Cells / Density / Size variance) and the colour vocabulary
// (dgVocab) from the template's `.pattern`. It is a convenience that expands to the
// same controls the user could set by hand, so after applying every dial stays live
// and tweakable — the template value is not sticky.

import type { Params } from '~/lib/spacetype/effect'
import { gridTemplate } from '~/lib/frame/gridTemplates'

// The 'Template' select's neutral value — no template applied (hand-tuned / custom).
// Lives here (not controls.ts) so the sentinel travels with the apply logic.
export const DEALTGRID_TEMPLATE_NONE = '—'

/**
 * Write a shared grid template into a dealt-grid params bag, in place.
 * Sets dgCells / dgDensity / dgSizeVar / dgVocab from `gridTemplate(id).pattern`
 * and records the choice in dgTemplate. The neutral sentinel or an unknown id only
 * records the choice (the dials keep whatever they hold). Returns the same bag for
 * chaining. Reuse of the global `seed` is intentional — a template sets structure and
 * palette, not the shuffle.
 */
export function applyGridTemplate(params: Params, id: string): Params {
  const bag = params as Record<string, unknown>
  bag.dgTemplate = id
  const t = id === DEALTGRID_TEMPLATE_NONE ? undefined : gridTemplate(id)
  if (t) {
    const { dgCells, dgDensity, dgSizeVar, vocab } = t.pattern
    bag.dgCells = dgCells
    bag.dgDensity = dgDensity
    bag.dgSizeVar = dgSizeVar
    bag.dgVocab = vocab
  }
  return params
}
