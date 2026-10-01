/**
 * The runner's written-down state. One RunRecord per run, saved after every
 * change, so a restarted server can pick up exactly where it was.
 *
 *   run   — one press of Run (or Re-roll ×N): the workflow plus N takes
 *   take  — one version of the workflow with its own seeds
 *   leg   — one stretch of running (Run, or a Gate button) — `${runId}.${n}`
 *   stage — what one take is charged for in one leg — `${legId}.t${take}`
 */
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'

export type RunStatus = 'running' | 'paused' | 'done' | 'error' | 'stopped'

export interface OutputFile {
  filename: string
  subfolder: string
  /**
   * 'kept': bytes the runner made itself and keeps for the run by their
   * sha256 (./keptBytes.ts; subfolder = the run id). Never an asset, never
   * served by /view, never a file a workflow names.
   */
  type: 'output' | 'input' | 'temp' | 'kept'
}

/**
 * What one output slot of a runner node hands on (R0, step 3 spec):
 *   files    pictures, videos or sounds, as today; `list` marks a ComfyUI
 *            output list (is_output_list): the next node runs once per item
 *   mask     ComfyUI MASK values, one 16-bit greyscale PNG per frame (./pictures/mask.ts)
 *   text     a STRING (and a Moodboard's taste)
 *   number   an INT (`int`) or a FLOAT
 *   boolean  a BOOLEAN
 *   json     a STRING holding JSON, exactly as the Python node prints it
 *   glb      a 3D model address, and Sailor's saved copy when there is one
 *   frames   an IMAGE batch from a video (R5.2): one kept FFV1 file of exact 8-bit RGB frames
 *   video    a video a node assembled (R5.2, Python's VideoFromComponents): its
 *            frames, sound and rate, encoded only when saved or shown. A video
 *            file (LoadVideo, the Video card, a paid video) stays `files`.
 * A sound stays `files`, with a `sound` note saying how Python decodes it.
 */
export type RunnerValue =
  /**
   * `tensors` (R2.1 fix round 1): an effect's pictures also as the float32
   * tensors it made, one kept file per picture beside `files`, which the next
   * effect or Frame reads instead of the 8-bit PNG (as Python hands the float on).
   */
  | {
    kind: 'files'; files: OutputFile[]; list?: true; tensors?: OutputFile[]
    /** R5.2: a sound, and how Python turns it into its AUDIO. Absent on a value kept before R5 (read by its maker: server/media/values.ts soundNoteOf). */
    sound?: SoundNote
  }
  /**
   * `tensors` (R2.8 fix round 1): the masks also as the float32 tensors their
   * node made, one kept file per mask beside `files` (the 16-bit PNGs), which
   * an effect or a Frame reads instead, as Python hands the float mask on.
   */
  | { kind: 'mask'; files: OutputFile[]; tensors?: OutputFile[] }
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number; int: boolean }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'json'; text: string }
  | { kind: 'glb'; url: string; file: OutputFile | null }
  /** An IMAGE batch from a video: one kept FFV1 file of exact 8-bit RGB frames (`count` frames of `w` × `h`). */
  | { kind: 'frames'; file: OutputFile; count: number; w: number; h: number }
  /** CreateVideo's VIDEO (Python's VideoFromComponents): encoded only when saved or shown. */
  | {
    kind: 'video'
    frames: { file: OutputFile; count: number; w: number; h: number }
    /** The rate as the node holds it (a float; saved at Fraction(round(fps · 1000), 1000)). */
    fps: number
    sound: { file: OutputFile; note: SoundNote } | null
  }

/**
 * How Python turns a sound file into its AUDIO (R5.2), set by the node that
 * makes the value: 'load' (nodes_audio.py load(): LoadAudio, the cards),
 * 'download' (nodes_replicate.py _download_url_to_audio_dict: the paid sound
 * nodes), 'exact' (a float WAV the runner wrote itself: the samples as they are).
 */
export interface SoundNote {
  decode: 'load' | 'download' | 'exact'
}

/** Who a request went to. */
export type RunnerProvider = 'fal' | 'replicate'

export interface PendingRequest {
  /** Absent on requests saved before 2026-09-24: those went to fal. */
  provider?: RunnerProvider
  requestId: string
  statusUrl: string
  responseUrl: string
  cancelUrl: string
  submittedAt: number
  /**
   * When the runner first saw the service start the job (absent: not seen
   * started yet). Saved so a restart doesn't give a started job a fresh run
   * limit (engine.ts waitForResult).
   */
  startedAt?: number
  queuePosition: number | null
  /** Replicate only: how many times this request was sent again after a platform hiccup (absent = 0). */
  retries?: number
}

/**
 * A provider job Sailor asked to cancel whose cancel the provider has not
 * confirmed yet (cancelCheck.ts). It is kept on the run and asked about again
 * in the background — across restarts — until the provider says the job is
 * over, because a job that runs anyway bills Sailor with nothing charged to
 * the user. Removed once confirmed; kept with `gaveUpAt` if it never is.
 */
export interface UnconfirmedCancel {
  provider: RunnerProvider
  requestId: string
  statusUrl: string
  cancelUrl: string
  /** When the first cancel was tried. */
  since: number
  /** Cancel-and-look rounds tried so far. */
  tries: number
  /** The job's status at the last real answer (IN_QUEUE / IN_PROGRESS), if any. */
  lastStatus: string | null
  lastError: string | null
  /** Set when the background retries stopped without a confirmation (reported). */
  gaveUpAt?: number
}

/**
 * One call of a node that makes several (a `pipeline` plan, R3.1), written
 * down before it is sent and again when it has an answer, so a restarted
 * server replays the calls that finished and never sends one twice. The
 * finished calls' `usd` is what a failed or stopped node is charged for
 * (ruling (f)).
 */
export interface CallRecord {
  /** Stable within the node (e.g. 'cutout', 'fill', 'nb-1'): a resumed run matches calls by it. */
  key: string
  provider: RunnerProvider; endpoint: string; payload: Record<string, unknown>
  request: PendingRequest | null
  status: 'sent' | 'done' | 'error'
  usd: number
  /** The answer, kept so a resumed run replays it instead of calling again. */
  answer?: { result: unknown; raw: string | null; urls: string[] }
  /**
   * The planned call's fingerprint (./fingerprint.ts: its endpoint and body,
   * handed-off links as the sha256 of their bytes), taken when it was first
   * written down: a resumed run's call must match it, or the node fails.
   */
  fingerprint?: string
  /** Set once this call was moved to its backup service (as NodeRecord.switchedFrom). */
  switchedFrom?: NodeRecord['switchedFrom']
  /**
   * The call finished but a file of its answer could not be downloaded or
   * kept (R3.1 fix round 1): not delivered, so not charged (Sailor absorbs
   * it; reported as runner.download.lost). Also set (R3.17 fix round 1,
   * PipelineIO.undelivered) when its answer named no file, what it delivered
   * couldn't be kept, or Sailor failed with it afterwards.
   */
  lost?: true
  /**
   * Files the node saved from this call's answer, by the node's own key
   * (R3.6 fix round 1: Layerize an image's layers): a resumed node reuses
   * them instead of downloading and saving them again under new names.
   */
  saved?: Record<string, OutputFile>
}

export type NodeStatus = 'waiting' | 'running' | 'done' | 'error' | 'skipped' | 'paused' | 'dropped' | 'stopped'

export interface NodeRecord {
  status: NodeStatus
  classType: string
  /** Leg index this record was last run in. */
  leg: number | null
  /** Provider endpoint the request went to (a fal app, or a Replicate model). */
  endpoint: string | null
  /** The exact request body sent to the provider. */
  payload: Record<string, unknown> | null
  /** Set only when the request may be reused (explicit seed). */
  fingerprint: string | null
  request: PendingRequest | null
  outputs: OutputFile[]
  /**
   * The files of an output after the first, by output slot, for a node that
   * makes more than one (the Frame's protect_mask, slot 1, Task F11b). Absent:
   * every slot reads `outputs`.
   */
  slotOutputs?: Record<number, OutputFile[]>
  /**
   * What each output slot hands on (R0). Absent on records written before
   * step 3, and on nodes that only make files the old way: every slot then
   * reads `outputs` (or `slotOutputs`). When present, `outputs` lists every
   * file the values name (records, Gate choices and Assets read it).
   */
  values?: Record<number, RunnerValue>
  /**
   * Blend scene's kept subject (Task F11b fix round 1): the sha256 of the
   * picture sent and of the Frame's mask, kept in the runner's held store
   * from the send until the node finishes (a resumed node composites from them).
   */
  keepHeld?: { base: string | null; mask: string }
  /** True when an earlier identical result was handed back (charged nothing). */
  reused: boolean
  /** This node's price in credits (0 for result cards and Gates). */
  credits: number
  startedAt: number | null
  endedAt: number | null
  error: string | null
  /**
   * Set once this node was moved to the backup service (at most once): the
   * service it was first sent to, and that request's id (null when the send
   * itself failed, so no job existed there). `request` is then the backup's.
   */
  switchedFrom?: {
    provider: RunnerProvider
    requestId: string | null
    /** Present while that first job's cancel is unconfirmed: it is tried again after the switch, and on Stop. */
    cancelUrl?: string
  }
  /** The service that made this node's result (absent: nothing made yet, or a reused result). */
  servedBy?: RunnerProvider
  /** A `pipeline` node's calls, in the order they were first sent (R3.1). Absent on every other node. */
  calls?: CallRecord[]
  /**
   * R6 ruling (j): the kept frame batches and sounds its values name that were
   * let go once every node reading them had finished (their file names). A
   * node still to run that reads one has this node run again first
   * (keptRelease.ts reviveReleased). Absent: nothing let go.
   */
  released?: string[]
}

export interface TakeRecord {
  index: number
  /** This take's workflow — its own seeds; Redo bumps them here. */
  prompt: ApiPrompt
  nodes: Record<string, NodeRecord>
  /** Gates this take was let through. */
  openGates: string[]
  /** Gates where this take was not picked — nothing behind them runs. */
  droppedGates: string[]
  /**
   * What the start of the run measured of each media node's files (F22 fix
   * round 1, the tight hold; ./nodeMedia.ts: sync-3 lip-syncs, and Topaz
   * video upscales, F23): their lengths (and a video's size and frame rate,
   * where the price reads them), which the hold is priced from, and the
   * sha256 of the bytes measured. At the node's turn the files must still be
   * exactly these, or the node is refused. Absent (older runs, nodes not
   * measured): the hold is the price's ceiling (the 60 s cap).
   */
  measured?: Record<string, MeasuredMedia>
  /**
   * The capped pictures chosen at the start of the run (R3.H fix round 2),
   * by pictureHandoff.ts handoffKey: the bytes kept for the run (a JPEG is
   * kept as `.bin`), their format, and whether they keep see-through parts.
   * The node's turn sends them as they are.
   */
  handoffs?: Record<string, { file: OutputFile; format: 'png' | 'jpeg'; alpha: boolean }>
}

/** One media node's files as measured at the start of the run. */
export interface MeasuredMedia {
  /** shared/pricing/clipSettings.ts InputSeconds: the lengths, and a video's size and frame rate. */
  seconds: {
    audio?: number | null
    video?: number | null
    videoWidth?: number | null
    videoHeight?: number | null
    videoFps?: number | null
    /** R7 (ruling (f)): the pictures a local-model node works through, counted at the start (./localModelStart.ts). */
    frames?: number | null
  }
  /** The sha256 of each file's bytes, by its part (a sync-3 node has both; a Topaz node only its video). */
  sha: { video?: string; audio?: string }
  /**
   * Upscale and Enhance detail (R3.5, hosted): the pixels of the picture the
   * node is sent, as the start of the run sized it (repairSizes.ts; its
   * `seconds` and `sha` are empty). The hold is priced on it.
   */
  pixels?: number
  /**
   * R3.5 fix round 1: `pixels` is a predicted size held with its margin
   * (repairSizes.ts predictedHoldPixels), not one read from a file: at the
   * node's turn the picture is refused only when larger than `pixels`.
   */
  predicted?: true
  /**
   * Pose Mannequin (R3.15 fix round 1): the saved pose it names was read at
   * the start of the run and loads, so it makes no call: held at nothing
   * (paidNoCall's `savedPoseLoads`). Its `seconds` and `sha` are empty.
   */
  savedPose?: true
}

export type LegAction = 'run' | 'continue' | 'again' | 'redo' | 'restart'

export interface LegRecord {
  index: number
  id: string
  action: LegAction
  gateId: string | null
  takes: number[]
  status: 'running' | 'done'
  startedAt: number
  endedAt: number | null
  /**
   * The runner families switched on when this leg's hold was taken: a node
   * whose model depends on one that changed since is refused at its turn
   * (switches.ts). Absent on legs written before it was recorded.
   */
  families?: RunnerFamily[]
}

export interface StageCharge {
  stageKey: string
  leg: number
  take: number
  /** Credits held up front: every generator the stage may run (+ base, once per run). */
  estimate: number
  includesBase: boolean
  holdId: number | null
  /** 'free' = nothing held (local mode, or a stage that costs nothing). */
  state: 'held' | 'free' | 'settled' | 'released'
  /** Credits actually charged, once the stage has finished. */
  actual: number | null
  finished: boolean
  /**
   * The nodes this take runs in this leg, written down when the leg opens.
   * Charging, outputs and records read this set, so nodes that finished before
   * a restart still count. Absent on charges saved before 2026-09-23.
   */
  nodeIds?: string[]
}

export interface RunRecord {
  id: string
  userId: string | null
  canvasId: string | null
  projectUuid: string | null
  projectName: string | null
  /** The canvas workflow exactly as it was when Run was pressed (Open workflow reopens it). */
  workflow: unknown
  createdAt: number
  updatedAt: number
  status: RunStatus
  takes: TakeRecord[]
  legs: LegRecord[]
  charges: StageCharge[]
  /** The flat per-render credit has been charged for this run. */
  baseCharged: boolean
  /** Stop was pressed while this run was going. */
  stopRequested: boolean
  /** Provider jobs whose cancel is not confirmed yet (absent: none). */
  unconfirmedCancels?: UnconfirmedCancel[]
}

export function stageKeyOf(legId: string, take: number): string {
  return `${legId}.t${take}`
}

export function emptyNodeRecord(classType: string): NodeRecord {
  return {
    status: 'waiting', classType, leg: null, endpoint: null, payload: null, fingerprint: null,
    request: null, outputs: [], reused: false, credits: 0, startedAt: null, endedAt: null, error: null,
  }
}
