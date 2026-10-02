/**
 * Clips past one call's frames (step 3, R11.7, ruling (j)): the arithmetic
 * Slow motion (AI)'s run cuts its clip by and its price holds by, in one place
 * so the two can never disagree (as ./soundPieces.ts for long sounds and
 * ./upscaleTiles.ts for large pictures).
 *
 * A clip of T frames longer than one call takes (`limit`, RIFE's 240) is cut
 * into segments of at most `limit` frames that share their boundary frame:
 * segment k starts on the frame segment k − 1 ended on. Each is slowed down
 * on its own, (n − 1)·m + 1 frames for n in; joined, each segment after the
 * first drops its first frame (the shared one, already the previous segment's
 * last), so the clip comes out at (T − 1)·m + 1 frames, the boundary frame
 * neither doubled nor dropped. The segment count is a function of T alone and
 * never falls as T falls, so a run that reads no more frames than were
 * measured before the hold never makes more calls than were held.
 *
 * Pure: no imports, so the price module and the server read the same rule.
 */

/** The most frames one RIFE call is sent (the old per-call cap, ruling (g)'s 240: 10 s at 24 fps). */
export const RIFE_SEGMENT_FRAMES = 240

/** One segment: its first frame in the clip, and how many frames it holds (the boundary frame counted in both neighbours). */
export interface ClipSegment {
  start: number
  count: number
}

function checkLimit(limit: number): void {
  if (!(Number.isInteger(limit) && limit >= 2)) throw new Error('A segment must hold at least two frames')
}

/**
 * How many segments a clip of `frames` makes: one for `limit` frames or fewer
 * (or under two), else 1 + ⌈(T − limit) / (limit − 1)⌉ (each further segment
 * adds limit − 1 new frames, its first being the shared one).
 */
export function clipSegmentCount(frames: number, limit = RIFE_SEGMENT_FRAMES): number {
  checkLimit(limit)
  const t = Math.trunc(frames)
  if (!(t > limit)) return 1
  return 1 + Math.ceil((t - limit) / (limit - 1))
}

/**
 * The segments of a clip of `frames` (at least two), in order: all of `limit`
 * frames but the last, which holds what is left (at least two frames: the
 * shared one and one more). Under two frames: none (the clip is handed on).
 */
export function clipSegments(frames: number, limit = RIFE_SEGMENT_FRAMES): ClipSegment[] {
  checkLimit(limit)
  const t = Math.trunc(frames)
  if (!(t >= 2)) return []
  const out: ClipSegment[] = []
  let start = 0
  while (start < t - 1) {
    const count = Math.min(limit, t - start)
    out.push({ start, count })
    start += count - 1
  }
  return out
}

/** The frames a segment of `count` frames comes out at, slowed down `m` times (Python's (n − 1)·m + 1). */
export function segmentOutputFrames(count: number, m: number): number {
  return count < 2 || m < 2 ? count : (count - 1) * m + 1
}

/**
 * Where each segment's output goes in the joined clip: segment k's output
 * frame i is the clip's frame `start·m + i`; the joined clip takes it for
 * every i but a later segment's first (i = 0, the shared frame).
 */
export function segmentOutputStart(segment: ClipSegment, m: number): number {
  return segment.start * m
}
