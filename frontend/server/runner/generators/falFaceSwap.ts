/**
 * Face swap on fal's face swap (family face-swap), fal, no backup (Replicate
 * has no such app). LC1 (2026-10-01), the user's ruling (b): Easel's advanced
 * face swap answered 503 "Application is not available" on three live checks,
 * so the family moved here. Easel stays written (easelFaceSwap.ts) as the way
 * back if this app (hidden from fal's gallery) goes away.
 *
 * Written from tests/unit/fixtures/provider-schemas/fal/fal-ai__face-swap.json
 * (two required strings, nothing else):
 *   base_image_url  the node's target_frames (first frame only; a batch is refused before the hold)
 *   swap_image_url  the node's source_face (the face to use)
 * The node's Gender and Keep hair from aren't sent: this app has neither (it
 * keeps the picture's hair). Its answer is `{ image: { url } }`; with no face
 * found in either picture it hands back the target picture (billed all the same).
 */
import { FAL_FACE_SWAP_APP } from '#shared/runner/faceSwap'
import type { ServiceCall } from './twins'

export function falFaceSwap(o: { face: string, target: string }): ServiceCall {
  return {
    provider: 'fal',
    endpoint: FAL_FACE_SWAP_APP,
    payload: { base_image_url: o.target, swap_image_url: o.face },
  }
}
