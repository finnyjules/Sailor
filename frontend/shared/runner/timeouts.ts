/**
 * How long the runner waits on a provider job (server/runner/engine.ts
 * waitForResult), shared with the canvas so its no-news watchdog
 * (app/layouts/default.vue RUNNER_STAGE_STALL_MS) is sized from the same
 * numbers. Pure; no imports.
 *
 * A video gets 30 minutes to make, and a video the service hasn't started
 * yet may wait up to 2 hours in its queue (Task C, 2026-09-25: a Wan 3.0 job
 * sat ~25 minutes in fal's queue at position 138 and finished at ~28 of the
 * 30, so a busier moment would have cancelled a job fal was about to run).
 * Once it starts, it gets the 30 minutes from the start (the start is saved
 * on the request, so a restart doesn't give it a fresh 30). So a video waits
 * at most 2 h 30 min, well inside the runner hold's 24 hours (holdSweep.ts
 * RUNNER_HOLD_TTL_MS). Pictures keep their 5 minutes, queued or not.
 */
export interface RunnerTimeouts {
  imageMs: number
  videoMs: number
  /** How long a picture the service hasn't started may wait (absent = imageMs). */
  imageQueueMs?: number
  /** How long a video the service hasn't started may wait (absent = videoMs). */
  videoQueueMs?: number
}

export const RUNNER_TIMEOUTS: Readonly<Required<Pick<RunnerTimeouts, 'imageMs' | 'videoMs' | 'videoQueueMs'>>> = {
  imageMs: 5 * 60_000,
  videoMs: 30 * 60_000,
  videoQueueMs: 2 * 60 * 60_000,
}

/**
 * The longest one provider job can keep a stage waiting: the queue allowance
 * then the run limit (2 h 30 min).
 */
export const RUNNER_LONGEST_WAIT_MS = RUNNER_TIMEOUTS.videoQueueMs + RUNNER_TIMEOUTS.videoMs

/**
 * The canvas's no-news watchdog for a runner stage: longer than the longest
 * wait plus 10 minutes (2 h 40 min). A job waiting in a queue can send no
 * news for all of it (Replicate reports no queue position, and fal's may not
 * move), so a shorter watchdog would call a run stalled while the server
 * still waits and may finish and charge it. Only a stage that ended without
 * any closing event (a lost stream, a crashed server) trips it.
 */
export const RUNNER_STAGE_STALL_MS = RUNNER_LONGEST_WAIT_MS + 10 * 60_000
