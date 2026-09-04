// frontend/app/lib/studio/moves/timelineDrag.ts
/**
 * PURE band-drag math for `MoveTimeline.vue` — a generalization of
 * `lib/scene3d/motion/timeline.ts`'s `resizeTransition`/`setClipOffset`/
 * `snapSeconds` to the shared `{at, duration}` band shape (`Move`, see
 * `./types.ts`) instead of 3D Studio's `ObjectMotion` (`offset`/`in`/`out`).
 * The scene3d file is untouched — this is a NEW copy, not a refactor of it,
 * so 3D Studio's own timeline keeps its own math.
 *
 * NOTHING here may import from `lib/vectortype`.
 */

const MIN_DURATION = 0.05

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)

/** Snaps `sec` to the nearest of `targets` within `epsSec`; passes through unchanged otherwise. */
export function snapSeconds(sec: number, targets: number[], epsSec = 0.08): number {
  let best = sec
  let bestD = epsSec
  for (const t of targets) {
    const dd = Math.abs(sec - t)
    if (dd <= bestD) {
      best = t
      bestD = dd
    }
  }
  return best
}

/** New `at` for a band body dragged by `deltaSec`, clamped to `[0, clip]` — a band can't start before the clip or past its end. */
export function moveBand(at: number, deltaSec: number, clip: number): number {
  return clamp(at + deltaSec, 0, Math.max(0, clip))
}

export interface Band { at: number; duration: number }

/**
 * New `{at, duration}` for a band edge dragged by `deltaSec`.
 * - `'right'`: only `duration` changes — grown/shrunk, floored at
 *   `MIN_DURATION` and capped so the band never runs past `clip`.
 * - `'left'`: `at` shifts by `deltaSec` (clamped to `[0, at+duration-MIN
 *   _DURATION]` so the band keeps at least `MIN_DURATION` seconds), and
 *   `duration` shrinks/grows to keep the band's right edge fixed.
 */
export function resizeBand(band: Band, edge: 'left' | 'right', deltaSec: number, clip: number): Band {
  if (edge === 'right') {
    const duration = clamp(band.duration + deltaSec, MIN_DURATION, Math.max(MIN_DURATION, clip - band.at))
    return { at: band.at, duration }
  }
  const rightEdge = band.at + band.duration
  const at = clamp(band.at + deltaSec, 0, rightEdge - MIN_DURATION)
  return { at, duration: rightEdge - at }
}

export interface TimelineView { start: number; end: number }

/** Candidate labelled-tick steps (seconds), coarsest that clears the ~56px target wins. */
export const NICE_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

/**
 * `mm:ss` timecode for a ruler label. When the major step is sub-second, one
 * decimal of the fractional part is appended IF nonzero (`00:01.5`), so
 * fine-grained rulers still read distinctly; whole seconds stay `00:02`.
 */
export function fmtTimecode(t: number, majorStep: number): string {
  const minutes = Math.floor(t / 60)
  const secs = Math.floor(t % 60)
  const mm = String(minutes).padStart(2, '0')
  const ss = String(secs).padStart(2, '0')
  if (majorStep < 1) {
    const frac = Math.round((t - Math.floor(t)) * 10) / 10
    if (frac > 1e-6) return `${mm}:${ss}.${Math.round(frac * 10)}`
  }
  return `${mm}:${ss}`
}

/**
 * Two-tier ruler ticks for the current view. MAJORS use the coarsest
 * `NICE_STEPS` value clearing ~56px and carry `mm:ss` labels; MINORS
 * subdivide each major into four (majorStep / 4) and are unlabelled, with
 * any minor coinciding with a major dropped. `leftPct` for both maps the
 * tick time into the `[view.start, view.end]` window as a 0..100 percentage.
 */
export function rulerTicks(view: TimelineView, trackWidth: number): {
  major: { t: number; leftPct: number; label: string }[]
  minor: { t: number; leftPct: number }[]
} {
  const viewLen = Math.max(0.001, view.end - view.start)
  const secPerPx = viewLen / Math.max(1, trackWidth)
  const rawStep = secPerPx * 56 // ~56px between labelled ticks
  const majorStep = NICE_STEPS.find(s => s >= rawStep) ?? NICE_STEPS[NICE_STEPS.length - 1]!
  const minorStep = majorStep / 4
  const pct = (t: number) => ((t - view.start) / viewLen) * 100

  const major: { t: number; leftPct: number; label: string }[] = []
  const firstMajor = Math.ceil(view.start / majorStep) * majorStep
  for (let t = firstMajor; t <= view.end + 1e-6; t += majorStep) {
    major.push({ t, leftPct: pct(t), label: fmtTimecode(t, majorStep) })
  }

  const minor: { t: number; leftPct: number }[] = []
  const firstMinor = Math.ceil(view.start / minorStep) * minorStep
  for (let t = firstMinor; t <= view.end + 1e-6; t += minorStep) {
    // Skip minors that land on a major (within 1e-6 of an integer multiple of majorStep).
    const ratio = t / majorStep
    if (Math.abs(ratio - Math.round(ratio)) < 1e-6) continue
    minor.push({ t, leftPct: pct(t) })
  }

  return { major, minor }
}

/**
 * Maps a move's window (`[at, at+duration]` for a transition, `[at, clip]`
 * for a loop — same window `moveWindows` in `./phase.ts` computes) into the
 * `[view.start, view.end]` zoom window as CSS percentages, clamped to
 * `0..100` so a band that runs off either edge of the current view is
 * simply cropped rather than producing negative/over-100 layout values.
 */
export function bandRect(move: { at: number; duration: number; loop: boolean }, view: TimelineView, clip: number): { leftPct: number; widthPct: number } {
  const viewLen = Math.max(0.001, view.end - view.start)
  const windowEnd = move.loop ? clip : move.at + move.duration
  const clampPct = (v: number) => clamp(v, 0, 100)
  const rawLeft = ((move.at - view.start) / viewLen) * 100
  const rawRight = ((windowEnd - view.start) / viewLen) * 100
  const leftPct = clampPct(Math.min(rawLeft, rawRight))
  const rightPct = clampPct(Math.max(rawLeft, rawRight))
  return { leftPct, widthPct: Math.max(0, rightPct - leftPct) }
}
