// F7 print recipes: a print LOOK (risograph / photocopy / letterpress) is nothing more than
// a PURE function from its few high-level dials to an ordered list of the existing
// `postEffects.ts` passes. `useCompositorLayers.ts` drops that list into `applyPasses` at
// paint time, so there is no new render machinery — a recipe reuses posterise / gradientMap /
// grain / adjust / threshold / ink_bleed / rough_edge, all already tuned and tested.
//
// Pure: no canvas, no DOM. Imports the recipe interfaces type-only from effectStack.ts and
// `PostEffect` + `defaultPostEffect` from postEffects.ts (postEffects keeps its one-way
// independence — it never imports from here). Unit-testable with zero canvas.
import { defaultPostEffect, type PostEffect } from './postEffects'
import type { RisographEffect, PhotocopyEffect, LetterpressEffect } from './effectStack'

export const RECIPE_KINDS = ['risograph', 'photocopy', 'letterpress'] as const
export type RecipeKind = typeof RECIPE_KINDS[number]
export const isRecipeKind = (k: string): k is RecipeKind =>
  (RECIPE_KINDS as readonly string[]).includes(k)

/** The unprinted paper the risograph tone ramp fades up into at the highlights. Named so it
 *  is easy to tune by eye in the live gate. */
const RISO_PAPER = '#f4f1e6'

/** Photocopy `dirt` dial → the ragged-alpha jitter amplitude. `rough_edge.amount` is 0..1
 *  normalised to canvas width, so a full dirt still wants only a small torn amplitude — this keeps
 *  the boundary grubby, not shredded. Named so the controller can tune the edge by eye. */
const PHOTOCOPY_EDGE_PER_DIRT = 0.03
/** Photocopy `dirt` dial → toner-speckle grain composite alpha (clamped to 1). >1 so a modest dirt
 *  still reads as gritty toner over the crushed tone. */
const PHOTOCOPY_GRAIN_PER_DIRT = 1.2

/**
 * Expand a print recipe into the ordered `PostEffect[]` that produces its look. Each entry is
 * a full effect built from `defaultPostEffect(type)` + the dial-derived overrides, always
 * `visible: true`. Risograph is implemented; photocopy and letterpress return `[]` (a visible
 * no-op — safe) until their own tasks fill them in.
 */
export function expandRecipe(e: RisographEffect | PhotocopyEffect | LetterpressEffect): PostEffect[] {
  switch (e.type) {
    case 'risograph': {
      // contrast bump → flatten to a few ink levels → map tone onto a paper→ink→inkTwo ramp →
      // paper grain. `gradientMap` maps luminance 0 → stop pos 0 and luminance 1 → pos 1
      // (confirmed against gradientMapInPlace), so shadows take the darker ink and highlights
      // fade up into the paper.
      // `defaultPostEffect(type)` is typed as the whole `PostEffect` union (its signature can't
      // narrow by the string arg), so spreading + overriding distributes across every member;
      // each `as PostEffect` re-narrows the literal back to the single kind it actually is.
      const out: PostEffect[] = []
      if (e.contrast !== 1) out.push({ ...defaultPostEffect('adjust'), contrast: e.contrast, visible: true } as PostEffect)
      out.push({ ...defaultPostEffect('posterise'), levels: e.levels, visible: true } as PostEffect)
      out.push({
        ...defaultPostEffect('gradientMap'), mix: 1,
        stops: [{ pos: 0, color: e.inkTwo }, { pos: 0.5, color: e.ink }, { pos: 1, color: RISO_PAPER }],
        visible: true,
      } as PostEffect)
      if (e.grain > 0) out.push({ ...defaultPostEffect('grain'), amount: e.grain, visible: true } as PostEffect)
      return out
    }
    case 'photocopy': {
      // A harsh xerox: bump contrast → crush tone to near-1-bit black/white (the copier core) →
      // a dirty, degraded edge + toner speckle, both driven by the one `dirt` dial.
      const out: PostEffect[] = []
      if (e.contrast !== 1) out.push({ ...defaultPostEffect('adjust'), contrast: e.contrast, visible: true } as PostEffect)
      // `threshold.cutoff` (0..1) IS the threshold dial — drive every pixel to black or white by
      // whether its luminance clears the cutoff. This is the 1-bit crush that reads as a photocopy.
      out.push({ ...defaultPostEffect('threshold'), cutoff: e.threshold, visible: true } as PostEffect)
      if (e.dirt > 0) {
        // rough_edge jitters the alpha boundary (grows outward — fine for a grubby copied edge,
        // already handled by the offscreen pad); grain lays toner speckle over the crushed tone.
        out.push({ ...defaultPostEffect('rough_edge'), amount: e.dirt * PHOTOCOPY_EDGE_PER_DIRT, visible: true } as PostEffect)
        out.push({ ...defaultPostEffect('grain'), amount: Math.min(1, e.dirt * PHOTOCOPY_GRAIN_PER_DIRT), visible: true } as PostEffect)
      }
      return out
    }
    // Letterpress (Task 3): a `[]` expansion is a visible no-op, safe until its own task fills in
    // its composition.
    case 'letterpress':
      return []
    default:
      return []
  }
}
