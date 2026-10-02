/**
 * Face swap (FaceSwap) on fal's face swap (family face-swap; LC1, 2026-10-01:
 * Easel's advanced face swap answered 503 three times, so ruling (b) moved the
 * family to `fal-ai/face-swap`, Easel kept as the way back). Replaces
 * InsightFace inswapper (non-commercial). The node's settings as Easel's
 * request sends them; fal's face swap takes only the two pictures.
 *
 * Fix round 1 (controller ruling, sentence-case / no-identifiers): the
 * node's own combo values are human-readable sentence case, the same as
 * this repo's Python combos commonly are ('Square', 'Portrait') — a canvas
 * combo renders its stored value raw, with no per-option label mechanism
 * (see the report). Easel's own lowercase enums are read off these.
 *
 * Pure; relative imports only.
 */
type Inputs = Record<string, unknown>

export const EASEL_FACE_SWAP_APP = 'easel-ai/advanced-face-swap'
/** The app Face swap calls (LC1, ruling (b)): fal's face swap, $0.001 a picture. */
export const FAL_FACE_SWAP_APP = 'fal-ai/face-swap'

/** The node's Gender combo, sentence case. */
export const FACE_SWAP_GENDER_OPTIONS = ['Not chosen', 'Male', 'Female', 'Non-binary'] as const
export type FaceSwapGenderOption = typeof FACE_SWAP_GENDER_OPTIONS[number]
export const FACE_SWAP_GENDER_DEFAULT: FaceSwapGenderOption = 'Not chosen'

export type FaceSwapGender = 'male' | 'female' | 'non-binary'
/** The node's Gender → Easel's gender_0. */
const FACE_SWAP_GENDER_TO_EASEL: Readonly<Record<string, FaceSwapGender>> = {
  Male: 'male', Female: 'female', 'Non-binary': 'non-binary',
}

/** The node's Keep hair from combo, sentence case. */
export const FACE_SWAP_HAIR_OPTIONS = ['The picture', 'The face photo'] as const
export type FaceSwapHairOption = typeof FACE_SWAP_HAIR_OPTIONS[number]
export const FACE_SWAP_HAIR_DEFAULT: FaceSwapHairOption = 'The picture'

/** The node's Keep hair from → Easel's workflow_type. */
export const FACE_SWAP_HAIR = { target: 'target_hair', face: 'user_hair' } as const

export const FACE_SWAP_NEEDS_GENDER = 'Pick the face’s gender on the node.'
export const FACE_SWAP_ONE_PICTURE = 'Face swap takes one picture. For video, use Person swap (video).'

/** Easel's gender_0, or null: nothing picked yet ("Not chosen"), or anything unreadable. */
export function faceSwapGender(inputs: Inputs): FaceSwapGender | null {
  const g = inputs.gender
  return typeof g === 'string' && Object.prototype.hasOwnProperty.call(FACE_SWAP_GENDER_TO_EASEL, g)
    ? FACE_SWAP_GENDER_TO_EASEL[g]!
    : null
}

export function faceSwapWorkflow(inputs: Inputs): 'target_hair' | 'user_hair' {
  return inputs.keep_hair_from === 'The face photo' ? FACE_SWAP_HAIR.face : FACE_SWAP_HAIR.target
}
