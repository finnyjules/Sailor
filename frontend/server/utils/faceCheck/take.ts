/**
 * Face score for a video take's frames (spec: Checks, Task 9). Pure —
 * compares an already-approved face against up to 3 frames the caller
 * decoded from the take; no IO, so it unit-tests without a network.
 * The route (take-check.post.ts) supplies `compare` (AWS Rekognition for
 * Photo characters, the Claude vision judge for Anime) and its own
 * `readTakeFrames` request validator.
 */
import type { CheckVerdict } from '#shared/characters/types'
import { verdictFor } from './plan'
import { FaceCheckError } from './rekognition'

export interface TakeScoreResult {
  scores: (number | null)[]
  best: number | null
  verdict: CheckVerdict
}

/**
 * Compares `face` (source) against each of `frames` (target). A frame with
 * no detectable face on either side (`FaceCheckError('no-face-either')`)
 * scores `null` for that frame only — the face itself was already checked
 * when it was approved. Any other error rethrows and stops the pass.
 */
export async function scoreTake(
  frames: Buffer[],
  face: Buffer,
  compare: (source: Buffer, target: Buffer) => Promise<number | null>,
): Promise<TakeScoreResult> {
  const scores: (number | null)[] = []
  for (const frame of frames) {
    try {
      scores.push(await compare(face, frame))
    } catch (e) {
      if (e instanceof FaceCheckError && e.code === 'no-face-either') { scores.push(null); continue }
      throw e
    }
  }
  const best = scores.reduce<number | null>((acc, s) => (s !== null && (acc === null || s > acc) ? s : acc), null)
  return { scores, best, verdict: verdictFor(best) }
}

const FRAME_PREFIX = 'data:image/jpeg;base64,'
const MAX_FRAME_BYTES = 2 * 1024 * 1024
export const TAKE_FRAMES_ERROR = 'Send one to three pictures from the take.'

/**
 * Validates and decodes the route body's `frames`: 1–3 JPEG data URLs, each
 * decoding to at most 2 MB. Returns the decoded buffers, or the plain-words
 * error to answer 400 with.
 */
export function readTakeFrames(body: unknown): Buffer[] | string {
  const frames = (body as { frames?: unknown } | null)?.frames
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 3) return TAKE_FRAMES_ERROR
  const out: Buffer[] = []
  for (const f of frames) {
    if (typeof f !== 'string' || !f.startsWith(FRAME_PREFIX)) return TAKE_FRAMES_ERROR
    let buf: Buffer
    try { buf = Buffer.from(f.slice(FRAME_PREFIX.length), 'base64') }
    catch { return TAKE_FRAMES_ERROR }
    if (!buf.length || buf.length > MAX_FRAME_BYTES) return TAKE_FRAMES_ERROR
    out.push(buf)
  }
  return out
}
