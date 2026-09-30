/**
 * Relight stage 3 ("Finish" with Nano Banana 2, spec 2026-09-30-relight-stage3-finish, Task 2):
 * the two patches that make applying/reverting the Finish result a single undo step each. Pure —
 * no DOM, no network, no Vue — so both are plain unit-tested (relight-finish.unit.spec.ts).
 *
 * Global Constraint (the plan, "Applying the result is one undo step"): a single
 * `setLocal(layerId, { filename, crop: <reset>, ...writeStackToLayer(stack without Relight) })`.
 * The result IS the box crop the request rendered from, so the crop must reset to whatever makes
 * a same-aspect image fill the box — see `finishApplyPatch` below. Removing the Relight row in
 * the SAME write matters: left in place, the effect would immediately relight the *finished*
 * photo and ask for a fresh, paid surfaces read of it.
 */
import { effectStackOf, removeEffect, writeStackToLayer, type StackHost } from '~/lib/compositor/effectStack'
import type { ImageCrop } from '~/composables/useCompositorLayers'

/** The minimal shape both patches need — an image (or wired) layer's photo, its crop, and its
 *  effect stack. `FinishableLayer` rather than the full `LocalLayer` union so this file stays a
 *  small, pure leaf (same reasoning as `relightSurfaceRefs.ts`'s `RelightLayerLike`). */
export interface FinishableLayer extends StackHost {
  filename: string
  crop?: ImageCrop
  id: string
}

export type FinishPatch = { filename: string; crop: ImageCrop | undefined } & ReturnType<typeof writeStackToLayer>

/**
 * The result becomes the layer's photo. `crop` resets to `undefined`: the picture Finish returns
 * IS the box's own pixels (`renderRelightPair`'s `w`×`h`, the box scaled to ≤1536px), so an
 * `ImageCrop` (`{ fit: 'cover', fx, fy }`, which covers a box whose aspect DIFFERS from the
 * source) has nothing left to do — the box IS the source now. `crop: undefined` is the layer's
 * plain "stretch to the box" default, which for an image already shaped exactly like the box is
 * a 1:1 draw, not a stretch. `relightId` is the id of the Relight entry that produced the guide;
 * it is removed here rather than left in place (see the file header).
 */
export function finishApplyPatch(layer: FinishableLayer, filename: string, relightId: string): FinishPatch {
  const stack = removeEffect(effectStackOf(layer), relightId)
  return { filename, crop: undefined, ...writeStackToLayer(stack) }
}

/**
 * Captured from the layer BEFORE the Finish request is sent (never after) — the exact
 * `{ filename, crop, stack }` a Revert restores. "Try again" resends the same stored
 * (original, guide) pair and only swaps `filename` on success, so Revert must still land back on
 * what was on the layer before the FIRST send, not before the most recent one.
 */
export function finishRevertPatch(layer: FinishableLayer): FinishPatch {
  return { filename: layer.filename, crop: layer.crop, ...writeStackToLayer(effectStackOf(layer)) }
}
