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
  note?: string
}

export type TakeCompareResult = number | null | { verdict: CheckVerdict; note?: string }

/** Ranks a verdict for "best across frames" when the checker gives verdicts, not scores (Ruling G): match > unsure > different > no-face. */
const VERDICT_RANK: Record<CheckVerdict, number> = { match: 3, unsure: 2, different: 1, 'no-face': 0 }

/**
 * Compares `face` (source) against each of `frames` (target). A frame with
 * no detectable face on either side (`FaceCheckError('no-face-either')`)
 * scores `null` for that frame only — the face itself was already checked
 * when it was approved. Any other error rethrows and stops the pass.
 *
 * `compare` returns either a similarity score (Photo/AWS) or a verdict
 * object (Anime/vision — no similarity scale exists there, so the vision
 * checker never invents one; Ruling G). Numeric results behave exactly as
 * before: `best` is the highest non-null score, `verdict = verdictFor(best)`.
 * If any frame returned a verdict object, `best` is `null` and `verdict` is
 * the best verdict across every frame (numeric frames converted with
 * `verdictFor` first), ranked match > unsure > different > no-face; `note`
 * is that winning frame's note, when it has one.
 */
export async function scoreTake(
  frames: Buffer[],
  face: Buffer,
  compare: (source: Buffer, target: Buffer) => Promise<TakeCompareResult>,
): Promise<TakeScoreResult> {
  const scores: (number | null)[] = []
  const verdicts: { verdict: CheckVerdict; note?: string }[] = []
  let anyVerdict = false
  for (const frame of frames) {
    let r: TakeCompareResult
    try { r = await compare(face, frame) }
    catch (e) {
      if (e instanceof FaceCheckError && e.code === 'no-face-either') {
        scores.push(null)
        verdicts.push({ verdict: 'no-face' })
        continue
      }
      throw e
    }
    if (r !== null && typeof r === 'object') {
      anyVerdict = true
      scores.push(null)
      verdicts.push({ verdict: r.verdict, note: r.note })
    }
    else {
      scores.push(r)
      verdicts.push({ verdict: verdictFor(r) })
    }
  }
  if (!anyVerdict) {
    const best = scores.reduce<number | null>((acc, s) => (s !== null && (acc === null || s > acc) ? s : acc), null)
    return { scores, best, verdict: verdictFor(best) }
  }
  let bestIdx = 0
  for (let i = 1; i < verdicts.length; i++) {
    if (VERDICT_RANK[verdicts[i]!.verdict] > VERDICT_RANK[verdicts[bestIdx]!.verdict]) bestIdx = i
  }
  const winner = verdicts[bestIdx]!
  return winner.note
    ? { scores, best: null, verdict: winner.verdict, note: winner.note }
    : { scores, best: null, verdict: winner.verdict }
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
