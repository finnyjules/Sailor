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

export type RunStatus = 'running' | 'paused' | 'done' | 'error' | 'stopped'

export interface OutputFile {
  filename: string
  subfolder: string
  type: 'output' | 'input' | 'temp'
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
  queuePosition: number | null
  /** Replicate only: how many times this request was sent again after a platform hiccup (absent = 0). */
  retries?: number
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
   * What the start of the run measured of each sync-3 lip-sync's files (F22
   * fix round 1, the tight hold): their lengths, which the hold is priced
   * from, and the sha256 of the bytes measured. At the node's turn the files
   * must still be exactly these, or the node is refused. Absent (older runs,
   * nodes not measured): the hold is the 60 s cap.
   */
  measured?: Record<string, MeasuredMedia>
}

/** One sync-3 node's files as measured at the start of the run. */
export interface MeasuredMedia {
  seconds: { audio?: number | null; video?: number | null }
  sha: { video: string; audio: string }
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
