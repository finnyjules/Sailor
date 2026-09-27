/**
 * Face swap (FaceSwap) on Easel's advanced face swap, fal (family face-swap).
 * Replaces InsightFace inswapper (non-commercial). The node's settings as the
 * request sends them; one reading for the builder and the pre-hold check.
 * Pure; relative imports only.
 */
type Inputs = Record<string, unknown>

export const EASEL_FACE_SWAP_APP = 'easel-ai/advanced-face-swap'
export const FACE_SWAP_GENDERS = ['male', 'female', 'non-binary'] as const
export type FaceSwapGender = typeof FACE_SWAP_GENDERS[number]
/** The node's "Keep hair from" → Easel's workflow_type. */
export const FACE_SWAP_HAIR = { target: 'target_hair', face: 'user_hair' } as const

export const FACE_SWAP_NEEDS_GENDER = 'Pick the face’s gender on the node.'
export const FACE_SWAP_ONE_PICTURE = 'Face swap takes one picture. For video, use Person swap (video).'

export function faceSwapGender(inputs: Inputs): FaceSwapGender | null {
  const g = inputs.gender
  return typeof g === 'string' && (FACE_SWAP_GENDERS as readonly string[]).includes(g) ? g as FaceSwapGender : null
}

export function faceSwapWorkflow(inputs: Inputs): 'target_hair' | 'user_hair' {
  return inputs.keep_hair_from === 'face' ? FACE_SWAP_HAIR.face : FACE_SWAP_HAIR.target
}
