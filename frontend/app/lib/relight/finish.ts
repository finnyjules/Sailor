/**
 * Relight stage 3 ("Finish" with Nano Banana 2, spec 2026-09-30-relight-stage3-finish, Task 2):
 * the two patches that make applying/reverting the Finish result a single undo step each, plus
 * the eligibility check both `renderRelightPair` (useCompositorLayers.ts) and Task 3's button
 * share. Pure — no DOM, no network, no Vue — so all three are plain unit-tested
 * (relight-finish.unit.spec.ts).
 *
 * Global Constraint (the plan, "Applying the result is one undo step"): a single
 * `setLocal(layerId, { filename, crop: <reset>, ...writeStackToLayer(stack without Relight) })`.
 * Removing the Relight row in the SAME write matters: left in place, the effect would
 * immediately relight the *finished* photo and ask for a fresh, paid surfaces read of it.
 */
import { effectStackOf, removeEffect, writeStackToLayer, type StackHost } from '~/lib/compositor/effectStack'
import type { ImageCrop } from '~/composables/useCompositorLayers'

/** The minimal shape both patches need — an image layer's photo, its crop, and its effect
 *  stack. `FinishableLayer` rather than the full `LocalLayer` union so this file stays a small,
 *  pure leaf (same reasoning as `relightSurfaceRefs.ts`'s `RelightLayerLike`). */
export interface FinishableLayer extends StackHost {
  filename: string
  crop?: ImageCrop
  id: string
}

/**
 * Finish is offered (and `renderRelightPair` runs) only for a plain, still IMAGE layer with a
 * file behind it: `kind === 'image'` (never `wired` — there is no stable file to hand fal, and
 * Relight itself keys a wired layer's depth by its live `/view` URL, not a filename fal could
 * fetch), a `filename`, and no living-image `clip` — a clip layer's frame changes every tick
 * (`isClipLayer` in `paintLayer`), so "the photo" isn't a stable thing to send or to become the
 * result of Keep.
 */
export function canFinishRelight(layer: { kind: string; filename?: string; clip?: unknown }): boolean {
  return layer.kind === 'image' && !!layer.filename && !layer.clip
}

export type FinishPatch = { filename: string; crop: ImageCrop | undefined } & ReturnType<typeof writeStackToLayer>

/**
 * The result becomes the layer's photo. `crop` becomes a centred cover crop (`{ fit: 'cover' }`,
 * `fx`/`fy` defaulting to 0.5 — see `coverSourceRect`) rather than clearing it: Nano Banana 2 is
 * not guaranteed to return exactly the request's pixel aspect, so the layer must still CROP the
 * result to fill its box (the same as any photo with a mismatched aspect) instead of stretching
 * it — a stretch would visibly distort the finished photo whenever the model's aspect drifts by
 * even a pixel. `relightId` is the id of the Relight entry that produced the guide; it is removed
 * here (never left in place — see the file header) but every OTHER effect, and `tint`/`tintBlend`/
 * `tintOpacity` in particular, are untouched: Finish keeps tint a live, non-destructive property
 * that still paints over the new photo exactly as it did over the old one (`renderRelightPair`
 * renders the sent pair WITHOUT the tint wash — see its own doc comment — so tint is never baked
 * into the model's input or output).
 */
export function finishApplyPatch(layer: FinishableLayer, filename: string, relightId: string): FinishPatch {
  const stack = removeEffect(effectStackOf(layer), relightId)
  return { filename, crop: { fit: 'cover' }, ...writeStackToLayer(stack) }
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
