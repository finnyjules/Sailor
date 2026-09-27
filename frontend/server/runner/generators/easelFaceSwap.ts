/**
 * Face swap on Easel (family face-swap), fal, no backup (Replicate has no
 * Easel). Written from tests/unit/fixtures/provider-schemas/fal/easel-ai__advanced-face-swap.json:
 *   face_image_0   the node's source_face (the face to use), as {url}: the
 *                  schema's Image type is an object (allOf $ref Image, no
 *                  bare-string alternative), never a plain string
 *   gender_0       the node's Gender (required by Easel; no default)
 *   target_image   the node's target_frames (first frame only; a batch is refused before the hold), as {url}
 *   workflow_type  the node's "Keep hair from": target_hair / user_hair
 *   upscale        true (the schema's default, sent so it can't change)
 * Not sent: face_image_1 / gender_1 (a second face), detailer (beta).
 */
import { EASEL_FACE_SWAP_APP, FACE_SWAP_NEEDS_GENDER, faceSwapGender, faceSwapWorkflow } from '#shared/runner/faceSwap'
import type { ServiceCall } from './twins'

export function easelFaceSwap(o: { face: string, target: string, inputs: Record<string, unknown> }): ServiceCall {
  const gender = faceSwapGender(o.inputs)
  if (!gender) throw new Error(FACE_SWAP_NEEDS_GENDER)
  return {
    provider: 'fal',
    endpoint: EASEL_FACE_SWAP_APP,
    payload: {
      face_image_0: { url: o.face },
      gender_0: gender,
      target_image: { url: o.target },
      workflow_type: faceSwapWorkflow(o.inputs),
      upscale: true,
    },
  }
}
