/**
 * Server video and sound work (step 3, stage R5): the limits and the words.
 * Pure, no imports: the media module (server/media/) and the browser's own
 * checks read the same numbers.
 *
 * The limits are the controller's ruling (f). Hosted: a video up to 2 GiB and
 * 10 minutes, frames up to 4096 × 4096, a frame batch up to 600 frames and
 * 600 × 1920 × 1080 pixels, a sound up to 512 MiB and 30 minutes, 4 GiB of kept
 * files per run. Local: Python's own limits (10,000 frames, 8192²) and an hour.
 */

export interface MediaCaps {
  videoBytes: number; soundBytes: number
  videoSeconds: number; soundSeconds: number
  /** One frame, w·h. */
  framePixels: number
  /** A frame batch: its count, and count·w·h. */
  batchFrames: number; batchPixels: number
  /** channels·samples decoded at once. */
  soundSamples: number
  keptBytesPerRun: number
  /**
   * R6 ruling (i), the video and sound effects: the 8-bit frames one node may
   * hold at once (bytes), the sound samples one node may hold (channels ·
   * samples, its inputs and output together), and the work one node may ask
   * for (pixel·steps, server/runner/video/table.ts VideoEffectSpec.work).
   * Past any of them the workflow is left to the engine before the run.
   * Locally R5's own caps only (these are unbounded).
   */
  heldFrameBytes: number
  effectSoundSamples: number
  effectWork: number
}

const GiB = 1024 ** 3
const MiB = 1024 ** 2

/**
 * R6 ruling (i): the most work one video effect may ask for in hosted, in
 * pixel·steps (server/runner/video/table.ts VideoEffectSpec.work: every pixel
 * decoded and every pixel made counts VIDEO_IO_WORK_PER_PIXEL, and an
 * effect's own arithmetic its steps). Measured on the development Mac (R6.1
 * report, 24 frames of 1080p noise through the real plan): the slowest pilot
 * (ping-pong, every frame held and handed over) moved 2.8 × 10⁷ units a
 * second, Frame trail 5.4 × 10⁷, Trim 3.6 × 10⁷. At the slowest, ten minutes
 * (the media job limit every one of the node's processes lives under) is
 * 1.7 × 10¹⁰ units; the budget is half that.
 */
export const EFFECT_WORK_HOSTED = 8_000_000_000

export const MEDIA_CAPS: { readonly local: Readonly<MediaCaps>; readonly hosted: Readonly<MediaCaps> } = {
  hosted: {
    videoBytes: 2 * GiB,
    soundBytes: 512 * MiB,
    videoSeconds: 10 * 60,
    soundSeconds: 30 * 60,
    framePixels: 4096 * 4096,
    batchFrames: 600,
    batchPixels: 600 * 1920 * 1080,
    // A 30-minute stereo sound at 48 kHz.
    soundSamples: 2 * 48000 * 30 * 60,
    keptBytesPerRun: 4 * GiB,
    // About 86 frames of 1080p.
    heldFrameBytes: 512 * MiB,
    // Ten minutes of stereo sound at 48 kHz.
    effectSoundSamples: 2 * 48000 * 10 * 60,
    effectWork: EFFECT_WORK_HOSTED,
  },
  local: {
    // Python has no file size limit: the machine is the person's own.
    videoBytes: Number.POSITIVE_INFINITY,
    soundBytes: Number.POSITIVE_INFINITY,
    videoSeconds: 60 * 60,
    soundSeconds: 60 * 60,
    framePixels: 8192 * 8192,
    batchFrames: 10_000,
    batchPixels: 10_000 * 8192 * 8192,
    // An hour of stereo sound at 48 kHz.
    soundSamples: 2 * 48000 * 60 * 60,
    keptBytesPerRun: Number.POSITIVE_INFINITY,
    heldFrameBytes: Number.POSITIVE_INFINITY,
    effectSoundSamples: Number.POSITIVE_INFINITY,
    effectWork: Number.POSITIVE_INFINITY,
  },
}

/** R6.1: the tool processes one node runs under its lease (server/media/run.ts mediaLease): two decodes and an encode. */
export const MEDIA_LEASE_PROCESSES = 3

export type MediaWord =
  | 'tooBig' | 'tooLong' | 'tooManyFrames' | 'unreadable' | 'noVideo' | 'noSound'
  | 'oddSize' | 'stopped' | 'timedOut' | 'failed' | 'sizeChanged' | 'oddRate' | 'busy'

/** What a person reads when media work can't go on: sentence case, plain words, short enough for a node. */
export const MEDIA_WORDS: Readonly<Record<MediaWord, string>> = {
  tooBig: 'This file is too large to work with here',
  tooLong: 'This video or sound is too long to work with here',
  tooManyFrames: 'This video has too many frames to work with here',
  unreadable: 'This file can’t be read as a video or sound',
  noVideo: 'This file has no video in it',
  noSound: 'This file has no sound in it',
  oddSize: 'A video needs an even width and height',
  stopped: 'Stopped',
  timedOut: 'This took too long, so it was stopped',
  failed: 'The video tools couldn’t finish this',
  sizeChanged: 'This video’s frames change size partway through',
  oddRate: 'This sound’s sample rate is too unusual to convert for Opus',
  busy: 'Sailor is busy with other videos right now, so try again in a moment',
}

/** Rule 5: how long one job may run. */
export const MEDIA_JOB_TIMEOUT_MS = { hosted: 10 * 60_000, local: 30 * 60_000, route: 30_000 } as const
/** Rule 6: a header probe's own time limit. */
export const MEDIA_PROBE_TIMEOUT_MS = 10_000
/** A whole-file packet scan's own time limit grows by a millisecond per this many bytes (20 MB a second) on top of the probe's. */
export const MEDIA_SCAN_BYTES_PER_MS = 20_000
/** Rule 6: how much of a file a header probe may read (`-probesize`, bytes; `-analyzeduration`, µs). PyAV's own defaults. */
export const MEDIA_PROBESIZE = 5_000_000
export const MEDIA_ANALYZEDURATION = 5_000_000
/** Rule 6: every job's allocation cap (`-max_alloc`). */
export const MEDIA_MAX_ALLOC = 536_870_912
/** Rule 5: jobs one person may run at once. */
export const MEDIA_JOBS_PER_USER = { hosted: 1, local: 2 } as const
/** Rule 5: the thumbnail and waveform routes' own slots, so a long render never blocks one. */
export const MEDIA_ROUTE_SLOTS = 2
/**
 * R5.6 fix round 1: the routes' share per person in hosted — one running and
 * four waiting; past that a route job is refused at once (MEDIA_WORDS.busy).
 */
export const MEDIA_ROUTE_JOBS_PER_USER = { running: 1, waiting: 4 } as const
/** R5.6 fix round 1: the longest a route job waits for a slot (then MEDIA_WORDS.busy); waiting counts against its 30 s. */
export const MEDIA_ROUTE_WAIT_MS = 10_000
/** Rule 5: the most stderr kept from one job (logged, never shown). */
export const MEDIA_STDERR_BYTES = 64 * 1024
