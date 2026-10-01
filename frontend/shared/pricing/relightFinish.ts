/** Nano Banana 2 "Finish" for Relight (spec 2026-09-30, stage 3). One call per
 *  Finish click: the layer's photo (original) + the live relit preview (guide)
 *  in, one realistic photo out. Price pinned to the EXISTING price-book row for
 *  'fal-ai/nano-banana-2/edit' — see price-book.unit.spec.ts / relight-finish-route.unit.spec.ts. */
import { creditsForUsd } from './markup'

export const FINISH_APP = 'fal-ai/nano-banana-2/edit'
/** Matches the price-book row for FINISH_APP exactly (pinned by a unit test) — do not edit independently. */
export const FINISH_USD = 0.08
export const finishCredits = (): number => creditsForUsd(FINISH_USD)

/** Fixed server-side prompt (never sent by the client) — verbatim from the plan's Global Constraints. */
export const RELIGHT_FINISH_PROMPT =
  "Relight image 1 so its lighting matches image 2: the same light direction, colour, intensity and " +
  "falloff. Image 2 is only a rough lighting preview — take nothing but the lighting from it. Remove " +
  "image 1's original lighting where it conflicts, and add physically correct shadows (including cast " +
  "shadows on the floor or background) and bounce light. Keep the subject, composition, framing, " +
  "textures and every detail of image 1 exactly the same."
