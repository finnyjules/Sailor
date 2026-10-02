/**
 * The Sailor runner. A run is a written-down to-do list: every node's state
 * is saved before and after each outside call, so a restarted server reads
 * the list back and carries on (reattach). A leg runs every node it can
 * reach, in parallel where the graph allows, until each take has finished,
 * failed or paused at a Gate. Money is held per take before a leg starts and
 * charged exactly when it ends. See docs/superpowers/specs/2026-09-22-sailor-runner-and-gate-design.md.
 */
import { FRAME_RENDER_TYPES, PROVIDER_TYPES, isRunnerEligible, rendersLocally, svgReaderProblems } from '#shared/runner/eligibility'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { staticWiredTexts } from '#shared/runner/staticValues'
import { withStaticSpeechText } from '#shared/runner/audioGen'
import { NO_OUTPUTS_MESSAGE, NO_VALID_OUTPUTS_MESSAGE, prunedAny, pruneInvalidOutputs, type ComfyNodeError } from '#shared/runner/validate'
import { blockedModelUses, blockedModelsResponse } from '#shared/runner/blockedModels'
import { retiredPromptRefusal } from '../utils/blockedModels'
import {
  GATE_CLASS, dependenciesOf, downstreamNodes, isLink, legNodes, upstreamStage,
  type ApiLink, type ApiPrompt, type TakeGateState,
} from '#shared/runner/graph'
import { RUNNER_NOT_ELIGIBLE, RUNNER_SOUND_TOO_LONG, type GateChoice, type RunnerMessage } from '#shared/runner/messages'
import { RUNNER_TIMEOUTS, type RunnerTimeouts } from '#shared/runner/timeouts'
import { MeterRefusalError } from '../utils/requestMeter'
import { BASE_RENDER_CREDITS, UnpricedGraphError } from '../utils/priceBook'
import { deliveredToOutput, outputReadsOf } from '../utils/renderCredit'
import { extractGraphPromptText } from '../utils/graphPromptText'
import { FalError, isProviderNetworkError, percentFromLogs, type FalStatus, type OutputMedia, type ProviderClient } from './falQueue'
import { ReplicateError } from './replicateQueue'
import { cancelAndConfirm, type CancelCheck } from './cancelCheck'
import { planNode, type DeriveIO, type PipelineCall, type ProviderBackup } from './executors'
import { rawTextOf } from './rawJson'
import { callsCredits } from '#shared/pricing/pipelinePrice'
import { ANSWER_MAX_BYTES, answerCap, answerExt, checkAnswerBytes, type AnswerKind } from './answerDownload'
import { answerRgbPng } from './pictures/pythonView'
import type { KeepStep } from './compositor/keep'
import { createMemoryHeldBytes, type HeldBytes } from './heldBytes'
import { createMemoryKeptBytes, withRunCap, type KeptBytes, type KeptExt } from './keptBytes'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { TURNTABLE_CLASS } from '#shared/runner/turntable'
import { turntableKeptBytes } from './generators/turntable'
import { createFileAccess } from './fileAccess'
import type { BackupSettings } from './config'
import { checkedInputFile, handedOffPictureProblem, inputFileCaps, linkedFileCheck, measuredInputProblem, pictureChangedWords, pictureOverMarginWords, hostedRequestProblems, requestProblems, unreadableInputWords } from './requestRules'
import { predictedHoldPixels, startPictureSizes } from './repairSizes'
import { isReusable, requestFingerprint } from './fingerprint'
import { gen3dTextSent } from '#shared/runner/gen3d'
import { NOT_YOURS, assertFilesOwned, collectInputFiles, parseInputFileRef, unsafeLutNames, unsafeSoundNames, unsafeWaveformNames, type OwnershipCheck } from './inputs'
import { shotRefFilenames, shotRefSizeProblem } from './shotRefs'
import { parseJsonObject } from './generators/opts'
import { cardPictureFiles, cardPictureRefusal } from './cards/bakeReplay'
import { loraStartProblem } from './loraFiles'
import { handoffKey, handoffPngName, loaderHandoffBytes, loaderHandoffs, loaderSourceOf, madeHandoffBytes, madeSourceOf, type HandoffCaps, type LoaderHandoff, type LoaderSource, type MadeSource } from './pictureHandoff'
import { sha256Hex } from './handoff'
import { handoffRefusal } from './pictures/handoffView'
import { effectOutRefusal } from './effects/plan'
import { PICTURE_ANIMATED, pictureHasFrames, pictureMeta, pictureRefusal } from './pictures/pythonView'
import { extraPromptText, hasOutputNode, measuredInput, nodeCredits, stageEstimateParts, unpricedProviderNode, type Metering } from './metering'
import { poseStartProblem } from './generators/nanoExtras'
import { loadAudioStartProblems, soundStreamProblem } from './media/soundNodes'
import { loadVideoStartProblems, videoFileVerdict } from './media/videoNodes'
import { frameStartProblems, framesSoundVerdict } from './media/frameNodes'
import { hasVideoEffect, keptPeak, lutStartProblems, mediaEffectRefusals, mediaEffectStartProblems, nearLimit, needsExactCount, waveformStartProblems } from './video/start'
import { frameShapes, videoSourceShapeOf } from './video/shapes'
import { hasLocalModelPicture, localModelStartProblems, soundBoundOf } from './localModelStart'
import { lensStartRefusal } from './cards/lensBlur'
import { keepStartRefusal } from './compositor/keep'
import { vocalsStemMaxBytes } from './generators/localModels'
import {
  LOCAL_MODEL_WORDS, VOCALS_CLASS, VOCALS_RATE, VOCALS_WORDS, WHISPER_CLASS, WHISPER_RATE, WHISPER_WORDS, isLocalModelClass, vocalsCeilingSeconds, vocalsMaxSeconds,
  soundReadOnlyByPieces, vocalsStemsReadable, whisperCeilingSeconds, whisperMaxSeconds,
} from '#shared/runner/localModels'
import { perFrameCredits } from '#shared/pricing/nodePrice'
import { hasSoundEffect, soundEffectRefusals, soundEffectStartProblems, soundKeptBytes, soundShapes, soundSourceShapeOf } from './video/soundShapes'
import { markReleased, reviveReleased, spentKeptMedia } from './keptRelease'
import { MEDIA_EFFECT_FAMILIES } from '#shared/runner/mediaEffects'
import { ev, type RunEvents, type SwitchReason } from './events'
import { mediaNodeKind, nodeMediaChangedWords, nodeMediaCheck, nodeMediaFiles } from './nodeMedia'
import { pythonWavOf, silentCardAt, soundMakerOf, vocalsSoundOf, whisperWavOf, type PythonWav } from './soundWav'
import { removeSoundPieces } from '../media/split'
import { cardSilenceFor } from './soundInMedia'
import { lipsyncUploadProblem } from './soundInMedia'
import { SOUND_FILE_MISSING } from './media/soundNodes'
import { switchedSinceHold } from './switches'
import { measuredMediaChanged, mediaWasMeasured } from './mediaInputs'
import type { InputSeconds } from '#shared/pricing/clipSettings'
import type { Handoff } from './handoff'
import type { ResultStore } from './results'
import { runIdOf, userKeyOf, type RunStore } from './store'
import {
  emptyNodeRecord, stageKeyOf,
  type CallRecord, type LegAction, type LegRecord, type NodeRecord, type OutputFile, type PendingRequest, type RunRecord, type RunStatus,
  type RunnerProvider, type RunnerValue, type StageCharge, type TakeRecord, type MeasuredMedia, type UnconfirmedCancel,
} from './types'
import { checkValue, filesOf, filesOfValues, slotValue, withWiredValues } from './values'

export class RunStopped extends Error {
  constructor() { super('Stopped'); this.name = 'RunStopped' }
}

export function createLimiter(limit: number) {
  const active = new Map<string, number>()
  const queues = new Map<string, Array<() => void>>()
  return {
    async acquire(key: string, signal: AbortSignal): Promise<void> {
      if (signal.aborted) throw new RunStopped()
      const n = active.get(key) ?? 0
      if (n < limit) { active.set(key, n + 1); return }
      await new Promise<void>((resolve, reject) => {
        const q = queues.get(key) ?? []
        queues.set(key, q)
        const onAbort = () => {
          const i = q.indexOf(grant)
          if (i >= 0) q.splice(i, 1)
          reject(new RunStopped())
        }
        const grant = () => { signal.removeEventListener('abort', onAbort); resolve() }
        signal.addEventListener('abort', onAbort, { once: true })
        q.push(grant)
      })
    },
    release(key: string): void {
      const next = queues.get(key)?.shift()
      if (next) { next(); return } // the slot passes straight to the next in line
      const n = (active.get(key) ?? 1) - 1
      if (n <= 0) active.delete(key)
      else active.set(key, n)
    },
    inFlight: (key: string) => active.get(key) ?? 0,
    waiting: (key: string) => queues.get(key)?.length ?? 0,
  }
}

/** What counts against MAX_QUEUED_CALLS: provider calls, and Frame renders (one worker renders them in turn). */
/** Work that waits its turn: a provider call, or a local render (the Audio card on its media row too, R5.3 fix round 1). */
const isQueuedWork = (classType: string, inputs: Record<string, unknown> = {}, families: ReadonlySet<RunnerFamily> = NO_FAMILIES) =>
  PROVIDER_TYPES.has(classType) || rendersLocally(classType, inputs, families)

/** A file's identity: its folder type, subfolder and name. */
const outputKeyOf = (f: OutputFile) => `${f.type}:${f.subfolder}:${f.filename}`

/** The files the prompts' LoadImage nodes read. */
function loadImageFiles(prompts: ApiPrompt[]): OutputFile[] {
  const out = new Map<string, OutputFile>()
  for (const p of prompts) {
    for (const n of Object.values(p)) {
      if (n.class_type !== 'LoadImage') continue
      const f = parseInputFileRef(n.inputs?.image)
      if (f) out.set(`${f.type}:${f.subfolder}:${f.filename}`, f)
    }
  }
  return [...out.values()]
}

/** A loaded picture (a LoadImage's file, uploaded just before the run) that is gone. */
export const LOADED_PICTURE_MISSING = 'A picture this workflow needs is missing. Run it again.'

const FINISHED_BADLY = new Set(['error', 'skipped', 'stopped', 'dropped'])

export function gateStateOf(take: TakeRecord): TakeGateState {
  const done = new Set<string>()
  const dropped = new Set<string>(take.droppedGates)
  for (const [id, n] of Object.entries(take.nodes)) {
    if (n.status === 'done') done.add(id)
    else if (FINISHED_BADLY.has(n.status)) dropped.add(id)
  }
  return { done, open: new Set(take.openGates), dropped }
}

export interface StageRecordSummary {
  run: RunRecord
  take: TakeRecord
  leg: LegRecord
  charge: StageCharge
  outputs: OutputFile[]
  nodeTypes: string[]
  ts: number
  /** Which service made each provider node's new result (present when any did). */
  servedBy?: Record<string, RunnerProvider>
}

export interface EngineDeps {
  store: RunStore
  /** One queue client per provider; a plan or a saved request names which. */
  providers: Record<RunnerProvider, ProviderClient>
  results: ResultStore
  handoff: Handoff
  metering: Metering
  events: RunEvents
  ownership: OwnershipCheck
  records: { write(s: StageRecordSummary): Promise<void> }
  /**
   * Downloads an answer's file under the safe-fetch policy for its kind
   * (answerDownload.ts, through falQueue.ts downloadResult): over `maxBytes`
   * it fails plainly; `signal` (the run's Stop) ends it.
   */
  download(url: string, o?: { maxBytes?: number; signal?: AbortSignal; kind?: AnswerKind }): Promise<{ bytes: Uint8Array; contentType: string | null }>
  hosted(): boolean
  /** The runner families switched on, server side (the authority). None when absent. */
  families?(): ReadonlySet<RunnerFamily>
  /** The backup-service switch (config.ts runnerBackup). Absent: never switch. */
  backup?(): BackupSettings
  webhookUrl(): string | null
  now(): number
  sleep(ms: number, signal: AbortSignal): Promise<void>
  newId(): string
  perUserLimit: number
  maxTakes: number
  /**
   * How long a provider job may take (RunnerTimeouts). `imageMs`/`videoMs`:
   * from the send, or from the start once the service starts it. The queue
   * allowance (`imageQueueMs`/`videoQueueMs`, absent = the same as the run
   * limit): how long a job the service says is still waiting to start may
   * wait before it is cancelled.
   */
  timeouts: RunnerTimeouts
  pollDelayMs(attempt: number): number
  reportError(e: unknown, ctx: Record<string, unknown>): void
  /**
   * Bytes a node keeps between its send and its result, outside ComfyUI's
   * temp folder (Blend scene's kept subject, Task F11b fix round 1). Absent:
   * kept in memory (tests).
   */
  held?: HeldBytes
  /** Bytes the runner makes itself (./keptBytes.ts). Absent: kept in memory (tests). */
  kept?: KeptBytes
}

export interface StartRunInput {
  userId: string | null
  takes: unknown
  workflow: unknown
  canvasId: string | null
  projectUuid: string | null
  projectName: string | null
  /**
   * The request's own signal (R7.7 fix round 1): aborted when the caller goes
   * away while the run is being started. The start of the run's media work
   * (probes, the sound-in WAVs it measures) runs under it, so a closed request
   * leaves no tool process or worker job behind and holds no media slot.
   */
  signal?: AbortSignal
}

export interface LegStarted {
  runId: string
  legId: string
  promptIds: string[]
  /** ComfyUI's node_errors for outputs dropped because they fail validation (present only then). */
  nodeErrors?: Record<string, ComfyNodeError>
}
/** A run's price before it starts (quoteRun): the credits it holds, the provider dollars they stand for, and whether a node is held on a bound. */
export interface RunQuote { usd: number; credits: number; upTo: boolean }
export type GateActionName = 'continue' | 'redo' | 'restart'
export interface GateActionInput { userId: string | null; runId: string; gateId: string; action: GateActionName; takes?: number[] }
export interface PausedGate { runId: string; promptId: string; nodeId: string; choices: GateChoice[]; picked: number[] }
/** Which service made a result is not shown here (ruling 5): it is on the saved node (`servedBy`) and in the generation record. */
export interface RunnerRecordView {
  runId: string
  promptId: string
  workflow: unknown
  createdAt: number
  endedAt: number | null
  credits: number | null
  prompt: string | null
  nodeTypes: string[]
  projectUuid: string | null
  projectName: string | null
}

type TakeOutcome = 'done' | 'error' | 'stopped' | 'paused'

interface LiveRun {
  run: RunRecord
  ctl: AbortController
  legPromise: Promise<void> | null
  saving: Promise<void>
}

/** Provider calls one user may have queued or in flight across all their runs. */
export const MAX_QUEUED_CALLS = 32
const refuse = (message: string, status: number, data?: unknown) => new MeterRefusalError(message, status, data)
/** A request saved before requests named their provider went to fal. */
const providerOf = (req: PendingRequest): RunnerProvider => req.provider ?? 'fal'
/**
 * A Replicate prediction that failed with a platform hiccup is sent again at
 * most this many more times, as nodes_replicate.py `_TRANSIENT_FAIL_RETRIES`
 * does, waiting 2 s × the attempt first. A failed prediction is not billed,
 * so the stage's charge is unchanged. fal failures are never sent again.
 */
export const REPLICATE_TRANSIENT_RETRIES = 2
/**
 * A send that failed with no job created at the service: no answer at all,
 * or a 5xx or 429 on submit. Such a send goes straight to the backup. A 4xx
 * refusal (a bad request) is the request's fault and is not switched.
 * "No job created" is an assumption: a timeout or a 502 can come after the
 * service accepted the job, which then runs there too and bills Sailor
 * (never the user, who is charged once at the node's price).
 */
export function isSubmitOutage(e: unknown): boolean {
  if (isProviderNetworkError(e)) return true
  if (!(e instanceof FalError || e instanceof ReplicateError) || e.status == null) return false
  return e.status >= 500 || e.status === 429
}
/** What a saved result is filed under: fal keeps its bare endpoint (results saved before 2026-09-24 still match). */
const fingerprintEndpoint = (provider: RunnerProvider, endpoint: string): string =>
  provider === 'fal' ? endpoint : `${provider}:${endpoint}`

/**
 * What a provider job is sent with and waits on: a node's record, or one call
 * of a pipeline (CallRecord, R3.1). Sending, the Replicate re-send and the
 * switch to a backup write the request down on it.
 */
type Sendable = Pick<NodeRecord, 'request' | 'switchedFrom'> & { endpoint: string | null; payload: Record<string, unknown> | null }

/** A job's result in a node's words (a time-out names it). */
const MEDIA_NOUN: Record<OutputMedia, string> = { image: 'image', video: 'video', audio: 'sound', glb: '3D model', svg: 'SVG', value: 'answer' }
/** When the provider's answer names no file to download. */
const NO_FILE: Record<Exclude<OutputMedia, 'value'>, string> = {
  image: 'The provider returned no image', video: 'The provider returned no video',
  audio: 'The provider returned no sound', glb: 'The provider returned no 3D model',
  svg: 'The provider returned no SVG',
}
/** A leg whose nodes would keep more files than the run may hold (R3.17 fix round 1), refused before the hold. */
export const KEPT_ROOM_REFUSED = 'This run would keep more video than Sailor can hold for one run. Run fewer turntables with extra views at once.'
/** R7.8 fix round 1: the same, where the clips, slowed clips or separated stems a run keeps don't fit. */
export const KEPT_ROOM_MEDIA_REFUSED = 'This run would keep more video or sound than Sailor can hold for one run. Run fewer or shorter clips and songs at once.'
/** A resumed pipeline call that is no longer the call written down (the F12 rule). */
export const PIPELINE_CALL_CHANGED = 'This step changed while it was running, so it was stopped. Run it again.'

/** Kept bytes' extension by a hand-off's name (keptBytes.ts). */
function keptExtOf(name: string): KeptExt {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return ext === 'png' || ext === 'glb' || ext === 'json' ? ext : 'bin'
}

/** A saved output file's address, as the canvas reads it (a 3D file's value, R3.1). */
function viewUrlOf(f: OutputFile): string {
  return `/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder)}&type=${f.type}`
}

/** The provider jobs a node may have out: its own request, and a pipeline's calls sent and not answered. */
function sentRequests(rec: NodeRecord): PendingRequest[] {
  const out: PendingRequest[] = rec.request ? [rec.request] : []
  for (const c of rec.calls ?? []) if (c.status === 'sent' && c.request) out.push(c.request)
  return out
}

/** Larger than this, the workflow is not stored (Open workflow then falls back, with its toast). */
export const MAX_STORED_WORKFLOW_CHARS = 2_000_000

export { RUNNER_TIMEOUTS, type RunnerTimeouts }

/** "30 minutes", "2 hours", "1 hour" — a limit in words for a node's message. */
function limitWords(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}
/**
 * Extra time past the deadline before a node is cancelled even when the
 * provider (fal or Replicate) has never given a real (non-transient) answer.
 * Without this, a restart-time gap in the provider's key (FAL_KEY or
 * NUXT_REPLICATE_TOKEN), or a status URL that only ever returns 5xx, keeps
 * `asked` false forever and the wait loop never ends — see waitForResult.
 */
const GRACE_MS = 5 * 60_000

/**
 * A cancel is only believed once the provider confirms it (cancelCheck.ts).
 * While the node waits, it is tried this many times more, these waits apart;
 * after that it is written down on the run and left to the background.
 */
export const INLINE_CANCEL_WAITS_MS = [2_000, 5_000]
/** Background tries of an unconfirmed cancel: these waits, then the last one again and again. */
export const CANCEL_WATCH_WAITS_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000]
/** The background tries stop, and say so, after this long without a confirmation. */
export const CANCEL_WATCH_GIVE_UP_MS = 48 * 60 * 60_000
/** What a node says when its job's cancel is not confirmed: it never claims "cancelled". */
const NOT_CONFIRMED = 'Sailor asked the service to stop it and is checking that it has'

function storableWorkflow(workflow: unknown): unknown {
  if (workflow == null) return null
  let text: string | undefined
  try { text = JSON.stringify(workflow) }
  catch { return null }
  return text != null && text.length <= MAX_STORED_WORKFLOW_CHARS ? workflow : null
}

/** What a link reads: the source node's value on that slot (values.ts slotValue; pre-R0 records read as before). */
function valueAt(take: TakeRecord): (link: [string, number]) => RunnerValue | undefined {
  return ([from, slot]) => slotValue(take.nodes[from], slot)
}

/**
 * The files a link reads: the node's outputs, or for a later output slot of a
 * node that keeps one (the Frame's protect_mask, `slotOutputs`) that slot's
 * files; for a node with values, the files its value on that slot names.
 */
function filesAt(take: TakeRecord): (link: [string, number]) => OutputFile[] {
  const at = valueAt(take)
  return link => filesOf(at(link))
}

/** A request's fingerprint body: with a kept subject, its mask and edge too (the saved result depends on them). */
function withKeep(payload: Record<string, unknown>, keep: KeepStep | undefined): Record<string, unknown> {
  return keep ? { ...payload, sailor_keep_subject: keep.fingerprint } : payload
}

function plainError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.length > 300 ? `${m.slice(0, 299)}…` : m
}

function pausedChoices(run: RunRecord): Map<string, GateChoice[]> {
  const gates = new Map<string, GateChoice[]>()
  for (const t of run.takes) {
    for (const [id, n] of Object.entries(t.nodes)) {
      if (n.status !== 'paused') continue
      const list = gates.get(id) ?? []
      list.push({ take: t.index, files: n.outputs })
      gates.set(id, list)
    }
  }
  return gates
}

/** Applies a Gate button to a copy of the run. Pure; throws a refusal the browser can show. */
export function applyGateAction(
  run: RunRecord,
  gateId: string,
  action: GateActionName,
  picked: number[] | undefined,
): { legAction: LegAction; legTakes: number[] } {
  const paused = run.takes.filter(t => t.nodes[gateId]?.status === 'paused').map(t => t.index)
  // Resetting a node also resets everything that read from it (an Image card
  // showing the old picture), the way ComfyUI re-runs a changed node's dependents.
  const reset = (take: TakeRecord, ids: Iterable<string>) => {
    const all = new Set(ids)
    let grew = true
    while (grew) {
      grew = false
      for (const id of Object.keys(take.prompt)) {
        if (!all.has(id) && dependenciesOf(take.prompt, id).some(d => all.has(d))) { all.add(id); grew = true }
      }
    }
    for (const id of all) take.nodes[id] = emptyNodeRecord(take.prompt[id]!.class_type)
  }
  // Server.py's Redo rule, with the spec's one change: 0 means random and stays 0.
  const bumpSeeds = (take: TakeRecord, ids: Iterable<string>) => {
    for (const id of ids) {
      const inputs = take.prompt[id]!.inputs
      for (const k of ['seed', 'noise_seed']) {
        const v = inputs[k]
        if (typeof v === 'number' && Number.isInteger(v) && v > 0) inputs[k] = v + 1
      }
    }
  }

  if (action === 'continue') {
    if (paused.length) {
      const wanted = picked ?? (paused.length === 1 ? paused : [])
      const chosen = [...new Set(wanted)].filter(i => paused.includes(i)).sort((a, b) => a - b)
      if (!chosen.length) throw refuse('Tick at least one picture to continue with', 400)
      for (const i of paused) {
        const take = run.takes[i]!
        if (chosen.includes(i)) {
          if (!take.openGates.includes(gateId)) take.openGates.push(gateId)
          take.droppedGates = take.droppedGates.filter(g => g !== gateId)
          take.nodes[gateId]!.status = 'done'
        }
        else {
          if (!take.droppedGates.includes(gateId)) take.droppedGates.push(gateId)
          take.nodes[gateId]!.status = 'dropped'
        }
      }
      return { legAction: 'continue', legTakes: chosen }
    }
    // Continue after the run finished: everything after the Gate again, from the kept picture.
    const passed = run.takes
      .filter(t => t.openGates.includes(gateId) && t.nodes[gateId]?.status === 'done')
      .map(t => t.index)
    const chosen = [...new Set(picked ?? passed)].filter(i => passed.includes(i)).sort((a, b) => a - b)
    if (!chosen.length) throw refuse('There is nothing past this Gate to run again', 409)
    for (const i of chosen) {
      const take = run.takes[i]!
      const down = downstreamNodes(take.prompt, gateId)
      reset(take, down)
      bumpSeeds(take, down)
      // Later Gates close again, so each of their reviews still happens.
      const laterGates = new Set([...down].filter(id => take.prompt[id]?.class_type === GATE_CLASS))
      take.openGates = take.openGates.filter(g => !laterGates.has(g))
      take.droppedGates = take.droppedGates.filter(g => !laterGates.has(g))
    }
    return { legAction: 'again', legTakes: chosen }
  }

  if (action === 'redo') {
    if (!paused.length) throw refuse('Redo works while the Gate is paused', 409)
    for (const i of paused) {
      const take = run.takes[i]!
      const stage = upstreamStage(take.prompt, gateId)
      reset(take, [...stage, gateId])
      bumpSeeds(take, stage)
    }
    return { legAction: 'redo', legTakes: paused }
  }

  // restart
  for (const take of run.takes) {
    reset(take, Object.keys(take.prompt))
    take.openGates = []
    take.droppedGates = []
  }
  return { legAction: 'restart', legTakes: run.takes.map(t => t.index) }
}

export function createEngine(deps: EngineDeps) {
  const held = deps.held ?? createMemoryHeldBytes()
  // A run's kept files are capped (R5.2, MEDIA_CAPS.keptBytesPerRun: hosted 4 GiB) and swept with it, as before.
  const kept = withRunCap(deps.kept ?? createMemoryKeptBytes(), () => (deps.hosted() ? MEDIA_CAPS.hosted : MEDIA_CAPS.local).keptBytesPerRun)
  /**
   * A capped input's caps for the hand-off (R3.H fix round 2): the model's,
   * and a backup's only while backups run and its route has one.
   */
  const handoffCapsOf = (classType: string, inputs: Record<string, unknown>, families: ReadonlySet<RunnerFamily>): HandoffCaps | null => {
    const caps = inputFileCaps(classType, inputs, families, !!deps.backup?.().enabled)
    return caps ? { cap: caps.cap, ...(caps.backupCap !== undefined ? { backupCap: caps.backupCap } : {}) } : null
  }
  const files = createFileAccess(deps.results, kept)
  const live = new Map<string, LiveRun>()
  const locks = new Map<string, Promise<unknown>>()
  const wakers = new Map<string, () => void>()
  const limiter = createLimiter(deps.perUserLimit)
  // Every runner message names the canvas its run belongs to, so a browser
  // window only applies it to that canvas (and ignores other projects' runs).
  const forCanvas = (run: RunRecord, m: RunnerMessage): RunnerMessage => ({ ...m, data: { ...m.data, canvas_id: run.canvasId } })
  const publish = (run: RunRecord, m: RunnerMessage) => deps.events.publish(userKeyOf(run.userId), forCanvas(run, m))

  /** The queue client for a provider. */
  function clientFor(provider: RunnerProvider): ProviderClient {
    const client = deps.providers[provider]
    if (!client) throw new Error(`Unknown provider: ${String(provider)}`)
    return client
  }
  /** fal calls /api/webhooks/fal back; there is no Replicate webhook route, so Replicate is polled only. */
  function webhookFor(provider: RunnerProvider): string | null {
    return provider === 'fal' ? deps.webhookUrl() : null
  }
  // ── Cancels the provider must confirm ─────────────────────────────────
  // Background re-tries of unconfirmed cancels, by request id.
  const watchers = new Map<string, Promise<void>>()
  const cancelSleep = (ms: number) => deps.sleep(ms, new AbortController().signal)
  const cancelMeta = (runId: string, c: Pick<UnconfirmedCancel, 'provider' | 'requestId'>) => ({ runId, provider: c.provider, requestId: c.requestId })

  /**
   * Cancel a job and wait (briefly) for the provider to confirm it is over.
   * Unconfirmed, the job is written down on the run and asked about again in
   * the background until it is (watchCancel): the caller must then not say
   * it was cancelled. A job that runs after an unconfirmed cancel would bill
   * Sailor with nothing charged to the user.
   */
  async function confirmCancel(run: RunRecord, req: Pick<PendingRequest, 'provider' | 'requestId' | 'statusUrl' | 'cancelUrl'>, o: { tries?: number } = {}): Promise<CancelCheck> {
    const provider = providerOf(req as PendingRequest)
    let check: CancelCheck
    try {
      check = await cancelAndConfirm(clientFor(provider), req, {
        tries: o.tries ?? INLINE_CANCEL_WAITS_MS.length + 1,
        waitMs: i => INLINE_CANCEL_WAITS_MS[Math.min(i, INLINE_CANCEL_WAITS_MS.length - 1)]!,
        sleep: cancelSleep,
      })
    }
    catch (e) { check = { confirmed: false, lastStatus: null, lastError: plainError(e) } }
    if (!check.confirmed) {
      await watchCancel(run, { provider, requestId: req.requestId, statusUrl: req.statusUrl, cancelUrl: req.cancelUrl }, check, o.tries ?? INLINE_CANCEL_WAITS_MS.length + 1)
    }
    return check
  }

  /** Write an unconfirmed cancel down on the run (so a restart picks it up) and start asking again in the background. */
  async function watchCancel(
    run: RunRecord, job: Pick<UnconfirmedCancel, 'provider' | 'requestId' | 'statusUrl' | 'cancelUrl'>,
    check: { lastStatus: string | null; lastError: string | null }, tries: number,
  ): Promise<void> {
    const list = run.unconfirmedCancels ??= []
    const entry = list.find(c => c.requestId === job.requestId)
    if (entry) Object.assign(entry, { tries: entry.tries + tries, lastStatus: check.lastStatus, lastError: check.lastError })
    else list.push({ ...job, since: deps.now(), tries, lastStatus: check.lastStatus, lastError: check.lastError })
    deps.reportError(new Error(`${job.provider} has not confirmed the cancel of ${job.requestId}; checking again in the background`), {
      site: 'runner.cancel.unconfirmed', ...cancelMeta(run.id, job), lastStatus: check.lastStatus, lastError: check.lastError,
    })
    await persist(run).catch(e => deps.reportError(e, { site: 'runner.cancel.save', ...cancelMeta(run.id, job) }))
    startCancelWatch(run.id, job.requestId)
  }

  /** Change a run's unconfirmed cancel on the freshest copy of the run (live, or the store's), under the run's lock. */
  async function updateCancel(runId: string, requestId: string, fn: (run: RunRecord, c: UnconfirmedCancel) => void): Promise<void> {
    await withRunLock(runId, async () => {
      const e = live.get(runId)
      const run = e?.run ?? await deps.store.get(runId)
      const c = run?.unconfirmedCancels?.find(x => x.requestId === requestId)
      if (!run || !c) return
      fn(run, c)
      if (e) await persist(run)
      else { run.updatedAt = deps.now(); await deps.store.save(run) }
    }).catch(e => deps.reportError(e, { site: 'runner.cancel.save', runId, requestId }))
  }

  function startCancelWatch(runId: string, requestId: string): void {
    if (watchers.has(requestId)) return
    const p = watchLoop(runId, requestId)
      .catch(e => deps.reportError(e, { site: 'runner.cancel.watch', runId, requestId }))
      .finally(() => watchers.delete(requestId))
    watchers.set(requestId, p)
  }

  /** Ask again, with growing waits, until the provider confirms the job is over or CANCEL_WATCH_GIVE_UP_MS passes. */
  async function watchLoop(runId: string, requestId: string): Promise<void> {
    for (let round = 0; ; round++) {
      await cancelSleep(CANCEL_WATCH_WAITS_MS[Math.min(round, CANCEL_WATCH_WAITS_MS.length - 1)]!)
      const run = live.get(runId)?.run ?? await deps.store.get(runId)
      const c = run?.unconfirmedCancels?.find(x => x.requestId === requestId)
      if (!c || c.gaveUpAt != null) return
      let check: CancelCheck
      try { check = await cancelAndConfirm(clientFor(c.provider), c, { tries: 1, waitMs: () => 0, sleep: cancelSleep }) }
      catch (e) { check = { confirmed: false, lastStatus: null, lastError: plainError(e) } }
      if (check.confirmed) {
        if (check.ended === 'finished') {
          // It ran after all: the provider billed Sailor for a result nobody was charged for.
          deps.reportError(new Error(`${c.provider} job ${requestId} finished after Sailor cancelled it; the provider billed it`), { site: 'runner.cancel.ran-anyway', ...cancelMeta(runId, c) })
        }
        await updateCancel(runId, requestId, (r) => {
          r.unconfirmedCancels = r.unconfirmedCancels!.filter(x => x.requestId !== requestId)
          if (!r.unconfirmedCancels.length) delete r.unconfirmedCancels
          // A first job left behind by a backup switch: its cancel is confirmed now.
          for (const t of r.takes) {
            for (const n of Object.values(t.nodes)) {
              if (n.switchedFrom?.requestId === requestId) delete n.switchedFrom.cancelUrl
              for (const c of n.calls ?? []) if (c.switchedFrom?.requestId === requestId) delete c.switchedFrom.cancelUrl
            }
          }
        })
        return
      }
      const giveUp = deps.now() - c.since >= CANCEL_WATCH_GIVE_UP_MS
      console.warn(`[runner] ${c.provider} has still not confirmed the cancel of ${requestId} (status ${check.lastStatus ?? 'unknown'}${check.lastError ? `, ${check.lastError}` : ''})`)
      await updateCancel(runId, requestId, (_r, x) => {
        x.tries++
        x.lastStatus = check.lastStatus
        x.lastError = check.lastError
        if (giveUp) x.gaveUpAt = deps.now()
      })
      if (giveUp) {
        deps.reportError(new Error(`Gave up checking the cancel of ${c.provider} job ${requestId}: it may still run and bill Sailor`), {
          site: 'runner.cancel.gave-up', ...cancelMeta(runId, c), lastStatus: check.lastStatus, lastError: check.lastError,
        })
        return
      }
    }
  }

  /** Tests: wait until every background cancel check has ended. */
  async function cancelChecksSettled(): Promise<void> {
    while (watchers.size) await Promise.all([...watchers.values()])
  }

  /** Send the node's written-down request (rec.endpoint, rec.payload) to `provider`, and write the request down. */
  async function submitRequest(run: RunRecord, rec: Sendable, provider: RunnerProvider, signal: AbortSignal): Promise<PendingRequest> {
    // A Stop can land while a switch is under way; nothing may go out after it.
    if (signal.aborted) throw new RunStopped()
    const sub = await clientFor(provider).submit(rec.endpoint!, rec.payload!, { webhookUrl: webhookFor(provider) })
    const req: PendingRequest = {
      provider,
      requestId: sub.requestId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl,
      cancelUrl: sub.cancelUrl, submittedAt: deps.now(), queuePosition: sub.queuePosition,
    }
    rec.request = req
    await persist(run)
    return req
  }

  /**
   * Move a node to its backup service, once. The switch is written down
   * before the backup is sent (request null, switchedFrom set), so a restart
   * in between sends the backup, never the first service again. The node's
   * price and the stage's hold are untouched: it is charged once. A crash
   * while the backup's send is in flight can leave a stray job at the
   * backup (sent again on restart); Sailor absorbs its cost.
   */
  async function sendToBackup(
    run: RunRecord, rec: Sendable, backup: ProviderBackup, from: NonNullable<NodeRecord['switchedFrom']>,
    reason: SwitchReason, stageKey: string, nodeId: string, signal: AbortSignal,
  ): Promise<PendingRequest> {
    // After Stop: no switch, and no switch notice.
    if (signal.aborted) throw new RunStopped()
    rec.switchedFrom = from
    rec.endpoint = backup.endpoint
    rec.payload = backup.payload
    rec.request = null
    await persist(run)
    publish(run, ev.providerSwitch(stageKey, nodeId, from.provider, backup.provider, reason))
    return submitRequest(run, rec, backup.provider, signal)
  }

  /**
   * One call of a pipeline (R3.1). Looked up on the node's record by its key:
   * a finished call gives back its kept answer; one sent before a restart is
   * waited on (sent again only if its send never got a request back, as a
   * provider node's is); any other is written down, then sent, with its
   * backup under the backup rules, and its answer written down. A resumed call
   * that is no longer the call written down (its endpoint or body changed,
   * handed-off files compared by their bytes) fails the node plainly, and the
   * recorded request is cancelled (the F12 rule). A call that fails at the
   * provider is marked so (never charged); Stop leaves it `sent` for the
   * node's Stop to cancel.
   */
  async function pipelineCall(
    run: RunRecord, rec: NodeRecord, c: PipelineCall,
    o: { stageKey: string; nodeId: string; userKey: string; signal: AbortSignal; backupSettings: BackupSettings; noBackup: boolean },
  ): Promise<NonNullable<CallRecord['answer']>> {
    const { stageKey, nodeId, userKey, signal } = o
    const calls = rec.calls ??= []
    const fp = requestFingerprint(fingerprintEndpoint(c.provider, c.endpoint), c.payload, u => deps.handoff.hashOf(u))
    let cr = calls.find(x => x.key === c.key)
    if (cr && cr.status !== 'error') {
      if (cr.fingerprint !== fp) {
        if (cr.status === 'sent' && cr.request) await confirmCancel(run, cr.request)
        throw new Error(PIPELINE_CALL_CHANGED)
      }
      if (cr.status === 'done' && cr.answer) return cr.answer
    }
    if (signal.aborted) throw new RunStopped()
    if (!cr || cr.status === 'error' || (cr.status === 'done' && !cr.answer)) {
      const fresh: CallRecord = { key: c.key, provider: c.provider, endpoint: c.endpoint, payload: c.payload, request: null, status: 'sent', usd: c.usd, fingerprint: fp }
      if (cr) calls[calls.indexOf(cr)] = fresh
      else calls.push(fresh)
      cr = fresh
      await persist(run)
    }
    const call = cr
    const backup = o.backupSettings.enabled && c.backup && !o.noBackup ? c.backup : null
    await limiter.acquire(userKey, signal)
    let result: unknown
    try {
      if (signal.aborted) throw new RunStopped()
      if (!call.request) {
        if (call.switchedFrom && backup) await submitRequest(run, call, backup.provider, signal)
        else {
          if (call.switchedFrom) {
            // Switched, but the backup is gone now (switched off): back to the first service.
            delete call.switchedFrom
            call.endpoint = c.endpoint
            call.payload = c.payload
          }
          try { await submitRequest(run, call, c.provider, signal) }
          catch (e) {
            if (!backup || signal.aborted || !isSubmitOutage(e)) throw e
            await sendToBackup(run, call, backup, { provider: c.provider, requestId: null }, 'send-failed', stageKey, nodeId, signal)
          }
        }
      }
      result = await waitForResult(run, call, stageKey, nodeId, c.wait ?? (c.media === 'video' ? 'video' : 'image'), signal, backup, o.backupSettings.stallMs, MEDIA_NOUN[c.media])
    }
    catch (e) {
      if (!(e instanceof RunStopped) && !signal.aborted) {
        call.status = 'error'
        await persist(run).catch(err => deps.reportError(err, { site: 'runner.call.save', stageKey, node: nodeId, call: c.key }))
      }
      throw e
    }
    finally {
      limiter.release(userKey)
    }
    call.provider = providerOf(call.request!)
    const urls = c.media === 'value' ? [] : clientFor(call.provider).outputUrls(result, c.media)
    call.answer = { result, raw: rawTextOf(result), urls }
    // A call priced by what it made (R3.6): charged that, never above its hold.
    if (c.usdOf) call.usd = answeredUsd(c, call.answer, stageKey, nodeId)
    call.status = 'done'
    await persist(run)
    return call.answer
  }

  /**
   * A pipeline call's price basis from its answer (PipelineCall.usdOf, R3.6):
   * only a finite figure of zero or more is believed, and never above the
   * call's hold (`c.usd`); anything else charges the hold, reported.
   */
  function answeredUsd(c: PipelineCall, answer: NonNullable<CallRecord['answer']>, stageKey: string, nodeId: string): number {
    let usd: unknown
    try { usd = c.usdOf!(answer.result, answer.raw) }
    catch (e) { usd = e instanceof Error ? e.message : String(e) }
    if (usd == null) return c.usd
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
      deps.reportError(new Error(`This step’s answer gave a price Sailor can’t read (${String(usd)}); charged the hold`), {
        site: 'runner.charge.unreadable', stageKey, node: nodeId, call: c.key, charge: String(usd), hold: c.usd,
      })
      return c.usd
    }
    if (usd > c.usd) {
      deps.reportError(new Error(`A price of $${usd} is above this call’s hold of $${c.usd}; charged the hold`), {
        site: 'runner.charge.above-hold', stageKey, node: nodeId, call: c.key, charge: usd, hold: c.usd,
      })
      return c.usd
    }
    return usd
  }

  /**
   * A pipeline's download that failed or couldn't be kept (fix round 1): the
   * call whose answer named the file is not delivered, so not charged (Sailor
   * absorbs it), and it is reported.
   */
  async function lostDownload(run: RunRecord, rec: NodeRecord, url: string, e: unknown, stageKey: string, nodeId: string): Promise<void> {
    const call = rec.calls?.find(c => c.status === 'done' && !!c.answer
      && (c.answer.urls.includes(url) || JSON.stringify(c.answer.result ?? null).includes(JSON.stringify(url).slice(1, -1))))
    if (call) call.lost = true
    deps.reportError(e, { site: 'runner.download.lost', stageKey, node: nodeId, url, call: call?.key ?? null })
    await persist(run).catch(err => deps.reportError(err, { site: 'runner.call.save', stageKey, node: nodeId }))
  }

  /**
   * What one node is charged in its stage: a finished node's credits (a
   * reused one: nothing); a pipeline's (R3.1, ruling (f)), whether it ended
   * done, failed or stopped, the sum of each finished and delivered call's
   * credits (shared/pricing/pipelinePrice.ts, the hold's calculation), never
   * above its hold (reported when it would be).
   */
  function chargeableCredits(rec: NodeRecord, stageKey: string, nodeId: string): number {
    if (rec.calls) {
      // Each call's credits from the one per-call calculation (the hold's), summed: never a marked-up sum of dollars.
      // A per-frame node (R7, USER ruling, fix round 1): its delivered frames' dollars added up, marked up once.
      const delivered = rec.calls.filter(c => c.status === 'done' && !c.lost)
      const credits = isLocalModelClass(rec.classType) ? perFrameCredits(delivered) : callsCredits(delivered)
      if (credits > rec.credits) {
        deps.reportError(new Error(`A charge of ${credits} credits is above this step’s hold of ${rec.credits}; charged the hold`), {
          site: 'runner.charge.above-hold', stageKey, node: nodeId, charge: credits, hold: rec.credits,
        })
        return rec.credits
      }
      return credits
    }
    return rec.status === 'done' && !rec.reused ? rec.credits : 0
  }

  function entryFor(run: RunRecord): LiveRun {
    let e = live.get(run.id)
    if (!e) {
      e = { run, ctl: new AbortController(), legPromise: null, saving: Promise.resolve() }
      live.set(run.id, e)
    }
    return e
  }

  async function loadEntry(runId: string): Promise<LiveRun | null> {
    const e = live.get(runId)
    if (e) return e
    const run = await deps.store.get(runId)
    return run ? entryFor(run) : null
  }

  /** Save a snapshot of the run; saves of one run land in order. */
  function persist(run: RunRecord): Promise<void> {
    run.updatedAt = deps.now()
    const snap = JSON.parse(JSON.stringify(run)) as RunRecord
    const e = entryFor(run)
    e.saving = e.saving.catch(() => {}).then(() => deps.store.save(snap))
    return e.saving
  }

  function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(runId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    locks.set(runId, next)
    return next.finally(() => { if (locks.get(runId) === next) locks.delete(runId) })
  }

  async function sleepOrWake(ms: number, requestId: string, runSignal: AbortSignal): Promise<void> {
    if (runSignal.aborted) return
    const ctl = new AbortController()
    const wake = () => ctl.abort()
    wakers.set(requestId, wake)
    runSignal.addEventListener('abort', wake, { once: true })
    try { await deps.sleep(ms, ctl.signal) }
    finally {
      runSignal.removeEventListener('abort', wake)
      if (wakers.get(requestId) === wake) wakers.delete(requestId)
    }
  }

  /**
   * The run's kept room, checked before a leg's hold (R3.17 fix round 1): the
   * files the leg's nodes will keep for the run at most (a Turntable with
   * views: its arcs' clips and the stitched file's work copy,
   * turntableKeptBytes), on top of what the run keeps already, must fit the
   * run's cap (MEDIA_CAPS.keptBytesPerRun); else the leg is refused plainly
   * before anything is held or sent. R7.8 fix round 1: with the R7 nodes'
   * own kept files too (TakeRecord.keptUpTo: Vocal separator's two stems, a
   * clip's batch and masks, Slow motion (AI)'s batch), so none is refused
   * only after its service was paid.
   */
  async function keptRoomBeforeHold(run: RunRecord, takeIdx: number[]): Promise<void> {
    const room = keptRoomNeeded(run.takes, takeIdx)
    if (!room) return
    keptRoomCheck(room, (await kept.runBytes(run.id)) + (await kept.workBytes(run.id)))
  }

  /** What a leg's takes will keep for the run at most (keptRoomBeforeHold), or null when nothing is counted. */
  function keptRoomNeeded(takes: readonly TakeRecord[], takeIdx: number[]): { need: number; media: number } | null {
    const cap = (deps.hosted() ? MEDIA_CAPS.hosted : MEDIA_CAPS.local).keptBytesPerRun
    if (!Number.isFinite(cap)) return null
    let need = 0
    let media = 0
    for (const t of takeIdx) {
      const take = takes[t]!
      for (const id of legNodes(take.prompt, gateStateOf(take))) {
        const n = take.prompt[id]
        if (n?.class_type === TURNTABLE_CLASS) need += turntableKeptBytes(n.inputs ?? {})
        const own = take.keptUpTo?.[id]
        if (typeof own === 'number' && own > 0 && take.nodes[id]?.status !== 'done') media += own
      }
    }
    return need || media ? { need, media } : null
  }

  /** Refuses a leg whose kept files, on top of `used`, wouldn't fit the run's kept room. */
  function keptRoomCheck(room: { need: number; media: number }, used: number): void {
    const cap = (deps.hosted() ? MEDIA_CAPS.hosted : MEDIA_CAPS.local).keptBytesPerRun
    if (used + room.need + room.media > cap) throw refuse(room.media ? KEPT_ROOM_MEDIA_REFUSED : KEPT_ROOM_REFUSED, 413)
  }

  /**
   * R6 ruling (j): lets go of every kept frame batch and sound no node will
   * read any more (keptRelease.ts spentKeptMedia), writing its name on its
   * holders' records. Only in a leg with an R6 family on: with them all off,
   * the run keeps what it made until it ends, exactly as before.
   */
  async function releaseSpent(run: RunRecord, leg: LegRecord): Promise<void> {
    if (!(leg.families ?? []).some(f => (MEDIA_EFFECT_FAMILIES as readonly string[]).includes(f))) return
    const spent = spentKeptMedia(run)
    if (!spent.length) return
    let any = false
    for (const s of spent) {
      // Asked again inside the run's kept lock, just before the file goes (R6.1 fix round 1): a node that has
      // made the same bytes again since (another take's) keeps it.
      const still = () => spentKeptMedia(run).some(x => x.file.subfolder === s.file.subfolder && x.file.filename === s.file.filename)
      if (!(await kept.release(run.id, s.file, { still }))) continue
      markReleased(s.file, s.holders)
      any = true
    }
    if (any) await persist(run)
  }

  // ── Opening a leg: price, hold, write down ─────────────────────────────
  /**
   * Each take's hold for a leg: the one price calculation the hold and the
   * quote (R8.0, quoteRun) both read, so the price shown covers the hold.
   */
  function legPrices(takes: readonly TakeRecord[], takeIdx: number[], baseCharged: boolean, families: ReadonlySet<RunnerFamily>) {
    return takeIdx.map((t) => {
      const take = takes[t]!
      const nodes = legNodes(take.prompt, gateStateOf(take))
      // Every take's hold covers the render credit (a hold is an upper bound);
      // which take actually pays it is only known once one makes something.
      const includesBase = !baseCharged && hasOutputNode(take.prompt)
      let parts: ReturnType<typeof stageEstimateParts>
      // Media nodes (sync-3, Topaz) hold the price of what the start of the run measured (TakeRecord.measured); none, the ceiling.
      try { parts = stageEstimateParts(take.prompt, nodes, includesBase, families, take.measured) }
      catch (e) {
        if (e instanceof UnpricedGraphError) throw refuse('A model in this workflow has no price yet', 500)
        throw e
      }
      return { t, nodes, includesBase, estimate: parts.credits, usd: parts.usd, upTo: parts.upTo }
    })
  }

  async function openLeg(run: RunRecord, action: LegAction, gateId: string | null, takeIdx: number[]): Promise<LegRecord> {
    const index = run.legs.length
    const legId = `${run.id}.${index}`
    const charges: StageCharge[] = []
    // The switches this leg's hold is priced with, written down on the leg:
    // a node whose model depends on one that changes before its turn is refused then (switches.ts).
    const families = deps.families?.() ?? NO_FAMILIES
    await keptRoomBeforeHold(run, takeIdx)
    try {
      for (const { t, nodes, includesBase, estimate } of legPrices(run.takes, takeIdx, run.baseCharged, families)) {
        const stageKey = stageKeyOf(legId, t)
        const holdId = await deps.metering.hold(run.userId, stageKey, estimate)
        charges.push({ stageKey, leg: index, take: t, estimate, includesBase, holdId, state: holdId == null ? 'free' : 'held', actual: null, finished: false, nodeIds: [...nodes] })
      }
    }
    catch (e) {
      for (const c of charges) await deps.metering.finish(run.userId, c, 0).catch(() => {})
      throw e
    }
    const leg: LegRecord = { index, id: legId, action, gateId, takes: takeIdx, status: 'running', startedAt: deps.now(), endedAt: null, families: [...families] }
    run.legs.push(leg)
    run.charges.push(...charges)
    run.status = 'running'
    run.stopRequested = false
    return leg
  }

  function launch(run: RunRecord, leg: LegRecord): void {
    const e = entryFor(run)
    e.run = run
    // A Stop that landed after the leg was opened but before this point must
    // stick: keep the aborted signal so the leg ends at once and drops its holds.
    if (e.ctl.signal.aborted && !run.stopRequested) e.ctl = new AbortController()
    const signal = e.ctl.signal
    e.legPromise = runLeg(run, leg, signal).catch((err) => {
      deps.reportError(err, { site: 'runner.leg', runId: run.id, legId: leg.id })
    })
  }

  // ── Running a leg ──────────────────────────────────────────────────────
  async function runLeg(run: RunRecord, leg: LegRecord, signal: AbortSignal): Promise<void> {
    let outcomes: TakeOutcome[] = []
    try {
      const results = await Promise.allSettled(leg.takes.map(t => runTakeLeg(run, run.takes[t]!, leg, signal)))
      outcomes = results.map((r, i) => {
        if (r.status === 'fulfilled') return r.value
        deps.reportError(r.reason, { site: 'runner.take', runId: run.id, legId: leg.id, take: leg.takes[i] })
        return 'error'
      })
    }
    finally {
      // The leg always ends, even when a take or a save failed: a leg left
      // 'running' would refuse Gate actions and replay a phantom "running".
      leg.status = 'done'
      leg.endedAt = deps.now()
      const gates = pausedChoices(run)
      let status: RunStatus
      if (gates.size) status = 'paused'
      else if (run.stopRequested || outcomes.includes('stopped')) status = 'stopped'
      else if (outcomes.length && outcomes.every(o => o === 'error')) status = 'error'
      else status = 'done'
      run.status = status
      let saved = true
      try { await persist(run) }
      catch (e) {
        saved = false
        deps.reportError(e, { site: 'runner.leg.save', runId: run.id, legId: leg.id })
      }
      for (const [gateId, choices] of gates) {
        publish(run, ev.gatePaused(leg.id, run.id, gateId, choices, choices.length === 1 ? [choices[0]!.take] : []))
      }
      // A finished run lives on in the store only. Kept in memory when its
      // last save failed, so the in-memory truth is not lost to a stale copy.
      if (saved && (status === 'done' || status === 'error' || status === 'stopped') && live.get(run.id)?.run === run) {
        live.delete(run.id)
      }
    }
  }

  /** The nodes one take ran in one leg: written down when the leg opened (older charges: every node last run in this leg). */
  function stageNodeIds(take: TakeRecord, charge: StageCharge, legIndex: number): string[] {
    const planned = charge.nodeIds ? new Set(charge.nodeIds) : null
    return Object.entries(take.nodes)
      .filter(([id, n]) => n.leg === legIndex && (!planned || planned.has(id)))
      .map(([id]) => id)
  }

  function takeOutcome(take: TakeRecord, legIndex: number): TakeOutcome {
    const ns = Object.values(take.nodes).filter(n => n.leg === legIndex)
    if (ns.some(n => n.status === 'stopped')) return 'stopped'
    if (ns.some(n => n.status === 'error')) return 'error'
    if (ns.some(n => n.status === 'paused')) return 'paused'
    return 'done'
  }

  async function runTakeLeg(run: RunRecord, take: TakeRecord, leg: LegRecord, signal: AbortSignal): Promise<TakeOutcome> {
    const stageKey = stageKeyOf(leg.id, take.index)
    const charge = run.charges.find(c => c.stageKey === stageKey)!
    if (charge.finished) return takeOutcome(take, leg.index)

    publish(run, ev.start(stageKey))
    // A value let go after its readers finished (R6 ruling (j)) that a node still to run reads has its
    // maker run again first (a restart, a later leg): free, and the same bytes.
    reviveReleased(take)
    const nodes = legNodes(take.prompt, gateStateOf(take))
    for (const id of nodes) {
      const rec = take.nodes[id]!
      if (rec.status !== 'running') rec.status = 'waiting'
      rec.leg = leg.index
    }

    const pending = new Set(nodes)
    const inflight = new Map<string, Promise<void>>()
    const failed = (id: string) => FINISHED_BADLY.has(take.nodes[id]!.status)
    while (pending.size || inflight.size) {
      for (const id of [...pending]) {
        const deps_ = dependenciesOf(take.prompt, id).filter(d => nodes.has(d))
        if (deps_.some(failed)) {
          pending.delete(id)
          const rec = take.nodes[id]!
          rec.status = 'skipped'
          rec.error = 'An earlier step did not finish'
          continue
        }
        if (deps_.some(d => pending.has(d) || inflight.has(d))) continue
        pending.delete(id)
        inflight.set(id, execNode(run, take, leg, id, signal))
      }
      if (!inflight.size) {
        for (const id of pending) take.nodes[id]!.status = 'skipped'
        break
      }
      const doneId = await Promise.race([...inflight].map(([id, p]) => p.then(() => id)))
      inflight.delete(doneId)
      // R6 ruling (j): the batches and sounds every reader of which has finished are let go now.
      await releaseSpent(run, leg).catch(e => deps.reportError(e, { site: 'runner.kept.release', runId: run.id }))
    }

    // Charge exactly what was made (reused results are free); the flat
    // render credit rides on the first stage that makes something — a
    // finished Frame render counts, as the Python path charges it. The
    // check and the set below must stay together, with no await between.
    // Everything this take ran in this leg counts, including nodes that
    // finished before a restart (legNodes above no longer lists those).
    const legIds = stageNodeIds(take, charge, leg.index)
    const charged = new Map(legIds.map(id => [id, chargeableCredits(take.nodes[id]!, stageKey, id)]))
    let actual = legIds.reduce((s, id) => s + charged.get(id)!, 0)
    // A take that failed or was stopped earns the render credit only when it
    // delivered something to an output (renderCredit.ts, the same rule as the
    // ComfyUI path's partial charge): the finished calls of a node that failed
    // are charged, the render credit is not. A take that finished earns it on
    // any charge or any finished local render, as before.
    const ended = takeOutcome(take, leg.index)
    // A local render: LOCAL_RENDER_TYPES, and the Audio card on its media row (R5.3), by the leg's own families.
    const legFamilies: ReadonlySet<RunnerFamily> = new Set(leg.families ?? [])
    const renderedHere = (id: string) => rendersLocally(take.nodes[id]!.classType, take.prompt[id]?.inputs ?? {}, legFamilies)
    let earnsBase: boolean
    if (ended === 'error' || ended === 'stopped') {
      const ran = new Set(legIds.filter(id => take.nodes[id]!.status === 'done' && !take.nodes[id]!.reused))
      const made = new Set([...ran].filter(id => charged.get(id)! > 0 || FRAME_RENDER_TYPES.has(take.nodes[id]!.classType)))
      earnsBase = deliveredToOutput(outputReadsOf(take.prompt), ran, made)
    }
    else earnsBase = actual > 0 || legIds.some(id => take.nodes[id]!.status === 'done' && renderedHere(id))
    if (charge.includesBase && earnsBase && !run.baseCharged) {
      actual += BASE_RENDER_CREDITS
      run.baseCharged = true
    }
    try { await deps.metering.finish(run.userId, charge, actual) }
    catch (e) {
      charge.finished = true
      deps.reportError(e, { site: 'runner.finish', stageKey, actual })
    }
    // A failed save must not swallow the closing event below.
    await persist(run).catch(e => deps.reportError(e, { site: 'runner.stage.save', stageKey }))

    const outcome = takeOutcome(take, leg.index)
    const credits = deps.hosted() ? (charge.actual ?? 0) : null
    // Only what this stage newly made: a reused result is an earlier run's
    // file, already recorded then. Nothing new → no record at all.
    const outputs: OutputFile[] = []
    const listed = new Set<string>()
    // Which service made each result, so a switched job's cost can be checked later.
    const servedBy: Record<string, RunnerProvider> = {}
    for (const id of legIds) {
      const rec = take.nodes[id]!
      // A node that handed its picture on (no call, so no endpoint) made nothing new.
      // A local render made its own files; those in the output folder are Save image's assets (R1.5).
      // A pipeline (R3.1) made something when one of its calls finished.
      const made = (rec.endpoint !== null && PROVIDER_TYPES.has(rec.classType)) || renderedHere(id)
        || !!rec.calls?.some(c => c.status === 'done')
      if (rec.status === 'done' && !rec.reused && made) {
        // The Audio card hands its sound on as its own output (R5.3 fix round 1, Important 1), and the
        // Video card its video (R5.4): only the files the card saved itself are new; what it hands on
        // was made (and listed) by its maker.
        const handedOn = (rec.classType === 'Audio' || rec.classType === 'Video') && rec.values ? new Set(filesOfValues(rec.values).map(outputKeyOf)) : null
        for (const f of rec.outputs) {
          if (f.type !== 'output' || handedOn?.has(outputKeyOf(f))) continue
          // Each file once in the stage's history.
          if (listed.has(outputKeyOf(f))) continue
          listed.add(outputKeyOf(f))
          outputs.push(f)
        }
        if (rec.servedBy) servedBy[id] = rec.servedBy
      }
    }
    if (outputs.length) {
      const nodeTypes = [...new Set(legIds.filter(id => take.nodes[id]!.status === 'done').map(id => take.nodes[id]!.classType))]
      await deps.records.write({ run, take, leg, charge, outputs, nodeTypes, ts: deps.now(), ...(Object.keys(servedBy).length ? { servedBy } : {}) })
        .catch(e => deps.reportError(e, { site: 'runner.record', stageKey }))
    }
    if (outcome === 'error') {
      const [id, rec] = Object.entries(take.nodes).find(([i, n]) => legIds.includes(i) && n.status === 'error')!
      publish(run, ev.error(stageKey, id, rec.classType, rec.error ?? 'Something went wrong', { runId: run.id, credits }))
    }
    else {
      publish(run, ev.success(stageKey, { runId: run.id, credits, stopped: outcome === 'stopped' }))
    }
    return outcome
  }

  async function execNode(run: RunRecord, take: TakeRecord, leg: LegRecord, id: string, signal: AbortSignal): Promise<void> {
    const rec: NodeRecord = take.nodes[id]!
    const stageKey = stageKeyOf(leg.id, take.index)
    const userKey = userKeyOf(run.userId)
    // This node turn's own held bytes (heldBytes.ts), let go when it finishes.
    const holder = `t${take.index}_${id.replace(/[^A-Za-z0-9_-]/g, '_')}`
    let heldUsed = false
    // R11.5: the folders of long sounds converted for this turn (Whisper's, Vocal separator's pieces), removed when it ends.
    const pieceDirs: string[] = []
    // Each job is cancelled once in this turn, however many paths reach it.
    const cancelledHere = new Set<string>()
    const cancelOnce = async (req: PendingRequest) => {
      if (cancelledHere.has(req.requestId)) return
      cancelledHere.add(req.requestId)
      await confirmCancel(run, req, { tries: 1 })
    }
    const hold = {
      put: (b: Uint8Array) => { heldUsed = true; return held.put(run.id, holder, b) },
      get: (sha: string) => held.get(run.id, holder, sha),
    }
    try {
      if (signal.aborted) throw new RunStopped()
      // A pipeline (R3.1) resumes when a call of it was written down: its calls carry the requests.
      const resuming = rec.status === 'running' && (!!rec.request || !!rec.calls?.some(c => c.status !== 'error'))
      rec.status = 'running'
      rec.error = null
      if (!resuming) rec.startedAt = deps.now()
      await persist(run)
      publish(run, ev.executing(stageKey, id))

      const families = deps.families?.() ?? NO_FAMILIES
      // A node whose model depends on a switch that changed since this leg's
      // hold (a class moved onto a newer model, a runner-only model) is never
      // sent: it fails here, before anything is read or handed off, and its
      // hold is released (switches.ts; F23 fix round 1 for Topaz, final fix F2
      // for every such node). A resumed node's job is already sent and priced
      // at submit, so it carries on.
      const switched = resuming ? null : switchedSinceHold(take.prompt[id], families, leg.families ? new Set(leg.families) : undefined)
      if (switched) throw new Error(switched)
      // One read of each file for this node's turn (F22 fix round 1): what is
      // measured and priced here is exactly what the hand-off uploads
      // (handoff.ts toUrlBytes, keyed by the bytes' sha256), so a file
      // overwritten meanwhile can never be charged as one thing and sent as another.
      const reads = new Map<string, Promise<Uint8Array>>()
      const readOnce = (f: OutputFile): Promise<Uint8Array> => {
        const key = `${f.type}:${f.subfolder}:${f.filename}`
        let p = reads.get(key)
        if (!p) { p = files.read(f); reads.set(key, p) }
        return p
      }
      // A sound-in node's WAV (R3.10, ./soundWav.ts): made once for this turn from what the wire
      // brought, so the WAV measured and charged (nodeMediaCheck) is the very one the plan sends.
      const wavs = new Map<string, Promise<PythonWav>>()
      // R7.7: Whisper transcribe sends the whole sound as 16 kHz mono (soundWav.ts whisperWavOf), not R3.10's first 60 s;
      // R7.8: Vocal separator the whole sound as Python's stereo, a 16-bit FLAC (soundWav.ts vocalsSoundOf).
      const nodeClass = take.prompt[id]!.class_type
      const soundOf = nodeClass === WHISPER_CLASS ? whisperWavOf : nodeClass === VOCALS_CLASS ? vocalsSoundOf : pythonWavOf
      const soundWavOnce = (link: ApiLink): Promise<PythonWav> => {
        const key = `${link[0]}:${link[1]}`
        let p = wavs.get(key)
        if (!p) {
          // An Audio card's 1 s of silence (fix round 1, Important), as Python's card hands it on.
          if (silentCardAt(take.prompt, link)) p = Promise.resolve(cardSilenceFor(nodeClass))
          else {
            const value = valueAt(take)(link) ?? { kind: 'files' as const, files: filesAt(take)(link) }
            const io = { access: files, userId: run.userId, hosted: deps.hosted(), signal, pieceDirs }
            p = soundOf(value, soundMakerOf(take.prompt, link), io)
          }
          wavs.set(key, p)
        }
        return p
      }
      // Sync lips' upload in hosted (fix round 1, Minor 5): there, and within the video caps, from its header.
      const videoUploadProblem = (f: OutputFile) => lipsyncUploadProblem(f, { access: files, userId: run.userId, hosted: deps.hosted(), signal })
      // Resuming a request already sent before a restart (F22 fix round 2):
      // nothing is measured, checked or handed off again, and the credits
      // written down at submit stand. The job is running (and billing) at the
      // service; a file changed since can't refuse it now.
      // The size of the picture a size-priced node is sent, measured before
      // anything is handed off: a picture above the input cap (any
      // size-priced node: FLUX.2 edit, Rotate camera on 2511;
      // requestRules.ts) fails the node here, before the hand-off or the
      // call; its hold is released.
      // Hosted, a picture whose size can't be read is refused too (Task G1):
      // it could be larger than the cap its price stops at.
      const measured = resuming ? { unreadable: false } as Awaited<ReturnType<typeof measuredInput>> : await measuredInput(take.prompt[id]!, filesAt(take), readOnce, families)
      const inputPixels = measured.pixels
      const tooLarge = measuredInputProblem(take.prompt[id]!.class_type, inputPixels, families, take.prompt[id]!.inputs ?? {})
        ?? (deps.hosted() && measured.unreadable ? unreadableInputWords(take.prompt[id]!.class_type) : null)
      if (tooLarge) throw new Error(tooLarge)
      // Upscale and Enhance detail (R3.5): the hold was priced on the size the
      // start of the run measured (repairSizes.ts); a picture that would now
      // cost more (a file changed meanwhile) is refused, its hold released.
      // A predicted size (fix round 1) was held with a margin: refused only
      // above it; inside it, charged at the real size (never above the hold).
      const held = resuming ? undefined : take.measured?.[id]
      if (held?.pixels !== undefined) {
        const over = held.predicted
          ? (inputPixels ?? Number.POSITIVE_INFINITY) > held.pixels
          : nodeCredits(take.prompt[id]!, inputPixels, families) > nodeCredits(take.prompt[id]!, held.pixels, families)
        if (over) throw new Error(held.predicted ? pictureOverMarginWords(take.prompt[id]!.class_type) : pictureChangedWords(take.prompt[id]!.class_type))
      }
      // A file its model refuses (Product shot on Bria: over 12 MB, or not
      // JPEG, PNG or WebP; HappyHorse 1.1: over 20 MB; requestRules.ts),
      // before the hand-off; one too large by its size on disk is refused
      // before it is read. Reads nothing for any other node. The size read
      // goes to planNode, which drops a backup that can't take it.
      // A loader's picture (R3.H, ./pictureHandoff.ts) is handed off as the PNG
      // of the loader's tensor, made once for this turn from the loader's own
      // file: the file cap is judged on it, and it is what is sent.
      // The capped input (Bria, HappyHorse 1.1, Seedance 2.0, Kling 3.0): over a
      // cap, a JPEG of the same picture is sent instead (R3.H fix), a backup's
      // cap counted while backups run and the route has one (fix round 2).
      const nodeInputs = take.prompt[id]!.inputs ?? {}
      const cappedName = checkedInputFile(take.prompt[id]!.class_type, families, nodeInputs.model, nodeInputs)
      const capsOf = (link: unknown): HandoffCaps | null => {
        const capped = cappedName ? nodeInputs[cappedName] : undefined
        if (!isLink(capped) || !isLink(link) || capped[0] !== link[0] || capped[1] !== link[1]) return null
        return handoffCapsOf(take.prompt[id]!.class_type, nodeInputs, families)
      }
      const views = new Map<string, Promise<LoaderHandoff>>()
      const handedOffPicture = (src: LoaderSource, caps: HandoffCaps | null) => {
        const key = `${src.file.type}:${src.file.subfolder}:${src.file.filename}:${src.kind.keepsAlpha ? 'a' : ''}:${caps ? `${caps.cap}/${caps.backupCap ?? ''}` : ''}`
        let p = views.get(key)
        if (!p) {
          p = readOnce(src.file).then(async (b) => {
            // Chosen at the start of the run (fix round 2): the same bytes, not encoded again.
            const chosen = caps ? take.handoffs?.[handoffKey(sha256Hex(b), src.kind, caps)] : undefined
            if (chosen) {
              try { return { bytes: await kept.read(chosen.file), made: true, format: chosen.format, alpha: chosen.alpha } }
              catch { /* gone: made again below, the same bytes */ }
            }
            return loaderHandoffBytes(b, src.kind, signal, caps)
          })
          views.set(key, p)
        }
        return p
      }
      const loaderAt = (link: unknown) => loaderSourceOf(take.prompt, link, families)
      // A picture made in the run (R3.H2): the tensor the node that made it
      // hands on (./pictureHandoff.ts madeSourceOf), made once for this turn
      // from the file the wire brings; judged, fingerprinted and sent as those bytes.
      const madeAt = (link: unknown) => loaderAt(link) ? null : madeSourceOf(take.prompt, link, families, n => !!take.nodes[n]?.request)
      const handedOffMade = (file: OutputFile, src: MadeSource, caps: HandoffCaps | null) => {
        const key = `made:${file.type}:${file.subfolder}:${file.filename}:${src.view}:${caps ? `${caps.cap}/${caps.backupCap ?? ''}` : ''}`
        let p = views.get(key)
        if (!p) {
          p = readOnce(file).then(b => madeHandoffBytes(b, src.view, caps))
          views.set(key, p)
        }
        return p
      }
      const fileCheck = resuming ? { problem: null } as Awaited<ReturnType<typeof linkedFileCheck>> : await linkedFileCheck(take.prompt[id]!, filesAt(take), readOnce, families, f => files.size(f), (link) => {
        const src = loaderAt(link)
        if (src) return handedOffPicture(src, capsOf(link))
        const made = madeAt(link)
        const file = made ? filesAt(take)(link)[0] : undefined
        return made && file ? handedOffMade(file, made, capsOf(link)) : null
      })
      if (fileCheck.problem) throw new Error(fileCheck.problem)
      // A media node (./nodeMedia.ts: sync-3 lip-sync, F22; Topaz video
      // upscale, F23): its files read and measured again now, before the
      // hand-off. A file that no longer fits fails the node here (its hold is
      // released); what is measured is what it is planned and charged on.
      let inputSeconds: InputSeconds | undefined
      const media = resuming ? null : await nodeMediaCheck(take.prompt, id, {
        read: readOnce, size: f => files.size(f), strict: deps.hosted(), filesFrom: filesAt(take), soundWav: soundWavOnce, videoUploadProblem,
      })
      if (media) {
        if (media.problem !== null) throw new Error(media.problem)
        // R7.7: a Whisper sound longer than this place sends (one whose maker couldn't be bounded before the
        // hold, or within a source's second of slack) stops here, before the hand-off and the call; R7.8: a
        // Vocal separator's the same.
        const heard = media.measured.seconds.audio
        const longest = wholeSoundCap(take.prompt[id]!.class_type, deps.hosted() ? 'hosted' : 'local')
        // R11.5: past one call's cap it runs in pieces; past the ceiling it stops here.
        if (longest && typeof heard === 'number' && heard > longest.ceiling) throw new Error(longest.words)
        // R11.5: where it runs decides whether its sound is one call or pieces, so it is priced with its place, as held.
        const seconds = longest ? { ...media.measured.seconds, place: deps.hosted() ? 'hosted' as const : 'local' as const } : media.measured.seconds
        // The tight hold (F22 fix round 1): the files must be the ones the start
        // of the run measured and held for, and cost no more.
        const recorded = take.measured && Object.prototype.hasOwnProperty.call(take.measured, id) ? take.measured[id] : undefined
        // R7.7: a record with nothing measured (Whisper's sound made in the run: only its place) is held at its
        // ceiling; only its price is compared.
        if (recorded && ((mediaWasMeasured(recorded) && measuredMediaChanged(recorded, media.measured))
          || nodeCredits(take.prompt[id]!, undefined, families, seconds) > nodeCredits(take.prompt[id]!, undefined, families, recorded.seconds))) {
          throw new Error(nodeMediaChangedWords(take.prompt[id]))
        }
        inputSeconds = seconds
      }
      // R7 (ruling (f)): a local-model node is priced (and planned) on the pictures the start of the run
      // counted and held for; its plan refuses more (./generators/localModels.ts).
      if (!inputSeconds && isLocalModelClass(take.prompt[id]!.class_type)) inputSeconds = take.measured?.[id]?.seconds
      // What planning reads of the media (Topaz sets its factor from the video's
      // size): this turn's measurement, or on resume the one recorded at the
      // start of the run, so the resumed plan (kept only for its backup) can be
      // rebuilt and the node keeps its request and credits (F23 fix round 1).
      const planMeasured = inputSeconds
        ?? (resuming && take.measured && Object.prototype.hasOwnProperty.call(take.measured, id) ? take.measured[id]!.seconds : undefined)

      // Text a wire brought that the start of the run could not know (a value
      // made in the run) is moderated now, before the request exists (R0.5).
      // Texts the start already checked are skipped. A resumed node's request
      // was sent (and checked) before the restart.
      if (!resuming && PROVIDER_TYPES.has(take.prompt[id]!.class_type)) {
        const wired = withWiredValues(take.prompt, id, valueAt(take))
        if (wired.injected.length) {
          const known = new Set(staticWiredTexts(take.prompt))
          const node = take.prompt[id]!
          for (const { input, text } of wired.injected) {
            // Multi-View's prompt only where it is sent (Rodin), R3.9 fix round 2.
            if (!known.has(text) && gen3dTextSent(node.class_type, input, node.inputs ?? {})) await deps.metering.moderateText(text)
          }
        }
      }

      // The node's inputs as its builder reads them (R0): every wire that
      // carries a value replaced by that value. The take keeps the workflow
      // as sent: price, hold and charge read the wires (a wired input is
      // priced at its most expensive, as the badge shows it). Worked out
      // inside planWith, so a value missing while resuming takes the
      // cancel-the-sent-job-first path below.
      const planWith = async (toUrl: (f: OutputFile) => Promise<string>, imageToUrl?: (f: OutputFile, link: ApiLink) => Promise<string>, bytesToUrl?: (f: OutputFile, b: Uint8Array) => Promise<string>) => planNode({
        prompt: withWiredValues(take.prompt, id, valueAt(take)).prompt,
        nodeId: id,
        filesFrom: filesAt(take),
        valueFrom: valueAt(take),
        toUrl,
        ...(imageToUrl ? { imageToUrl } : {}),
        ...(bytesToUrl ? { bytesToUrl } : {}),
        gateOpen: take.openGates.includes(id),
        readFile: readOnce,
        hosted: deps.hosted(),
        families,
        ...(fileCheck.bytes !== undefined ? { inputBytes: fileCheck.bytes } : {}),
        ...(planMeasured ? { measured: planMeasured } : {}),
        hold,
        ...(resuming && rec.keepHeld ? { keepHeld: rec.keepHeld } : {}),
        ...(inputPixels !== undefined ? { inputPixels } : {}),
        priceInputs: take.prompt[id]!.inputs,
        soundWav: soundWavOnce,
        // A resumed node's job is already running: a sound-in node takes its links from the request
        // written down, never decoding or uploading its sound again (fix round 1, Minor 2).
        ...(resuming && rec.payload ? { recordedPayload: rec.payload } : {}),
      })
      const handOff = async (f: OutputFile) => deps.handoff.toUrlBytes(f, await readOnce(f))
      // A picture wired into an IMAGE input: from a loader, the PNG of its tensor (R3.H).
      const imageHandOff = async (f: OutputFile, link: ApiLink) => {
        const src = loaderAt(link)
        if (!src) {
          // Made in the run (R3.H2): the file the builder picked, as its node's tensor.
          const made = madeAt(link)
          if (!made) return handOff(f)
          const sent = await handedOffMade(f, made, capsOf(link))
          return deps.handoff.toUrlBytes(sent.made ? handoffPngName(f, sent.format) : f, sent.bytes)
        }
        const sent = await handedOffPicture(src, capsOf(link))
        return deps.handoff.toUrlBytes(sent.made ? handoffPngName(src.file, sent.format) : src.file, sent.bytes)
      }
      // Resuming: the request written down is kept (and its price); the plan is
      // rebuilt only for its backup. If it can't be rebuilt now (a file gone),
      // the node carries on waiting for its job, with no backup.
      let resumedWithoutBackup = false
      // Bytes a node made from one of its files (R3.15, Pose Mannequin's mannequin render).
      const bytesHandOff = (f: OutputFile, b: Uint8Array) => deps.handoff.toUrlBytes(f, b)
      let plan: Awaited<ReturnType<typeof planNode>>
      if (!resuming) plan = await planWith(handOff, imageHandOff, bytesHandOff)
      else {
        try { plan = await planWith(handOff, imageHandOff, bytesHandOff) }
        catch {
          resumedWithoutBackup = true
          try { plan = await planWith(async () => '', async () => '', async () => '') }
          catch (e) {
            // The plan can't be rebuilt at all now (its rules changed since
            // the request was sent, or what it was planned from is gone): the
            // job sent before the restart is cancelled before the node fails,
            // so no provider job is left running and billing (F23 re-review
            // minor 1; final fix F12). The node's hold is released.
            for (const req of sentRequests(rec)) await confirmCancel(run, req)
            throw e
          }
        }
      }
      // The files' bytes are not kept for the provider wait (up to 30 minutes).
      reads.clear()
      wavs.clear()
      views.clear()
      // Files saved into the output folder (Save image, R1.5; a pipeline's
      // saves, R3.1): the run's assets, owned by the user and listed in the take's record.
      const assets: OutputFile[] = []
      /** A saved file's bookkeeping: an output is the run's asset; an input file is the user's own. */
      const recordSaved = async (f: OutputFile, folder: 'output' | 'temp' | 'input') => {
        if (folder === 'output') {
          await deps.metering.addOutput(run.userId, stageKey, f)
          assets.push(f)
        }
        // Saved into the input folder (R3.6, Layerize an image's layers): recorded
        // under the runner's own kind, so the user owns it (inputs.ts), but not an asset.
        if (folder === 'input') await deps.metering.addSavedInput(run.userId, stageKey, f)
        return f
      }
      const deriveIO = (): DeriveIO => ({
        read: readOnce,
        keep: (bytes, ext) => kept.put(run.id, bytes, ext),
        saveAsset: async (bytes, o) => {
          const folder = o.folder ?? 'output'
          const f = await deps.results.save(bytes, {
            userId: run.userId, prefix: o.prefix, ext: o.ext, folder,
            ...(o.subfolder !== undefined ? { subfolder: o.subfolder } : {}),
            ...(o.counter ? { counter: o.counter } : {}),
          })
          return recordSaved(f, folder)
        },
        // A file the video tools wrote (R5.3, the sound nodes): moved into place, never read into memory.
        ...(deps.results.saveFromPath
          ? {
              saveAssetFromPath: async (path: string, o: Parameters<NonNullable<DeriveIO['saveAssetFromPath']>>[1]) => {
                const folder = o.folder ?? 'output'
                const f = await deps.results.saveFromPath!(path, {
                  userId: run.userId, prefix: o.prefix, ext: o.ext, folder,
                  ...(o.subfolder !== undefined ? { subfolder: o.subfolder } : {}),
                  ...(o.counter ? { counter: o.counter } : {}),
                  // R5.5: Save video frames' own name, a counter only on a clash (ruling h).
                  ...(o.exact ? { exact: true as const } : {}),
                })
                return recordSaved(f, folder)
              },
            }
          : {}),
        savePreview: (bytes, o) => deps.results.saveLivePreview(bytes, { nodeId: o.nodeId ?? id, userId: run.userId }),
        savePreviewAs: (bytes, o) => deps.results.savePreviewAs(bytes, { filename: o.filename, userId: run.userId }),
        hosted: deps.hosted(),
        signal,
        nodeId: id,
        runWorkflow: run.workflow,
        runPrompt: take.prompt,
        media: { access: files, kept, runId: run.id, userId: run.userId, hosted: deps.hosted(), signal },
      })
      // Computed here from the node's inputs (the cards, R0/R1): no provider, no charge.
      if (plan.kind === 'derive') {
        const made = await plan.derive(deriveIO())
        if (signal.aborted) throw new RunStopped()
        for (const v of Object.values(made.values)) checkValue(v)
        rec.values = made.values
        rec.outputs = [...filesOfValues(made.values), ...assets]
        rec.status = 'done'
        rec.endedAt = deps.now()
        await persist(run)
        if (made.ui) publish(run, ev.executed(stageKey, id, made.ui))
        return
      }
      const backupSettings = deps.backup?.() ?? { enabled: false, stallMs: 0 }
      // Several provider calls (R3.1): each written down before it is sent and
      // when it has its answer (pipelineCall). Held at the node's price and
      // charged for the calls that finished (the stage charge, chargeableCredits).
      if (plan.kind === 'pipeline') {
        if (!resuming) rec.credits = nodeCredits(take.prompt[id]!, inputPixels, families, inputSeconds)
        // Blend's cleaned kept subject (R8.1 live-check fix): its kept bytes recorded, so a resumed node lays the same original.
        if (plan.keep && !resuming) rec.keepHeld = plan.keep.held
        rec.calls ??= []
        await persist(run)
        // The node's own signal (fix round 1): a failed or finished pipeline
        // ends every call of it still waiting, sending or in flight.
        const nodeCtl = new AbortController()
        const nodeSignal = AbortSignal.any([signal, nodeCtl.signal])
        const inflight = new Set<Promise<unknown>>()
        const settleCalls = async () => {
          if (!inflight.size) return
          nodeCtl.abort()
          for (const req of sentRequests(rec)) await cancelOnce(req)
          await Promise.allSettled([...inflight])
          // A send that was under way when the node ended got its request after the first round.
          for (const req of sentRequests(rec)) await cancelOnce(req)
        }
        let made: Awaited<ReturnType<typeof plan.run>>
        try {
          made = await plan.run({
            ...deriveIO(),
            signal: nodeSignal,
            call: (c) => {
              const p = pipelineCall(run, rec, c, { stageKey, nodeId: id, userKey, signal: nodeSignal, backupSettings, noBackup: resumedWithoutBackup })
              inflight.add(p)
              void p.catch(() => {}).finally(() => inflight.delete(p))
              return p
            },
            download: async (url, o) => {
              const kind = o?.kind ?? 'image'
              try {
                const got = await deps.download(url, { maxBytes: answerCap(kind, o?.maxBytes), signal: nodeSignal, kind })
                checkAnswerBytes(kind, got.bytes)
                return got
              }
              catch (e) {
                // A file the node goes on without (R3.6, Layerize's layer JSON) leaves its call delivered.
                if (!nodeSignal.aborted && o?.optional) deps.reportError(e, { site: 'runner.download.optional', stageKey, node: id, url })
                else if (!nodeSignal.aborted) await lostDownload(run, rec, url, e, stageKey, id)
                throw e
              }
            },
            savedOnce: async (callKey, key, make) => {
              const cr = rec.calls?.find(c => c.key === callKey && c.status === 'done')
              const prior = cr?.saved && Object.prototype.hasOwnProperty.call(cr.saved, key) ? cr.saved[key] : undefined
              if (prior && await files.exists(prior)) return prior
              const f = await make()
              if (cr) {
                (cr.saved ??= {})[key] = f
                await persist(run)
              }
              return f
            },
            recorded: (key) => {
              const cr = rec.calls?.find(c => c.key === key && c.status !== 'error')
              return cr ? cr.payload : null
            },
            // A text the node made in the run and sends on (R3.14), moderated as a wired text is at its turn (hosted only).
            moderateText: text => deps.metering.moderateText(text),
            // R3.17 fix round 1: a finished call that delivered nothing usable is charged 0 (Sailor absorbs it).
            undelivered: async (key, why) => {
              const cr = rec.calls?.find(c => c.key === key && c.status === 'done')
              if (!cr || cr.lost) return
              cr.lost = true
              deps.reportError(new Error(`A step of this node delivered nothing usable (${why}); not charged`), {
                site: why === 'sailor-fault' ? 'runner.charge.absorbed' : 'runner.call.undelivered', stageKey, node: id, call: key, why,
              })
              await persist(run).catch(err => deps.reportError(err, { site: 'runner.call.save', stageKey, node: id, call: key }))
            },
            handOff: async (bytes, name) => {
              const f = await kept.put(run.id, bytes, keptExtOf(name))
              // Uploaded under the node's own name (its type goes by it); remembered by the bytes.
              return deps.handoff.toUrlBytes({ ...f, filename: name }, bytes)
            },
            toUrl: handOff,
          })
        }
        finally {
          // No call record is written after the node's final save: every call has settled first.
          await settleCalls()
        }
        if (signal.aborted) throw new RunStopped()
        for (const v of Object.values(made.values)) checkValue(v)
        rec.values = made.values
        // An asset a value names too (R3.6: a layerizer's picture) is listed once.
        const named = filesOfValues(made.values)
        const same = (a: OutputFile, b: OutputFile) => a.type === b.type && a.subfolder === b.subfolder && a.filename === b.filename
        rec.outputs = [...named, ...assets.filter(a => !named.some(f => same(f, a)))]
        rec.status = 'done'
        rec.endedAt = deps.now()
        await persist(run).catch(e => deps.reportError(e, { site: 'runner.node.save', stageKey, node: id }))
        if (made.ui) publish(run, ev.executed(stageKey, id, made.ui))
        return
      }
      // Rendered here (the Frame): no provider, no charge, not an asset.
      if (plan.kind === 'local') {
        const made = await plan.render(signal)
        if (signal.aborted) throw new RunStopped()
        const file = await deps.results.saveLivePreview(made.image, { nodeId: id, userId: run.userId })
        rec.outputs = [file]
        // The Frame's protect_mask, when a node reads it (Blend scene's
        // keep_subject, Task F11b): its second output, saved beside it.
        if (made.protectMask) rec.slotOutputs = { 1: [await deps.results.saveLivePreview(made.protectMask, { nodeId: `${id}_protect_mask`, userId: run.userId })] }
        else delete rec.slotOutputs
        rec.status = 'done'
        rec.endedAt = deps.now()
        await persist(run)
        const ui = plan.uiFor([file])
        if (ui) publish(run, ev.executed(stageKey, id, ui))
        return
      }
      if (plan.kind === 'pass') {
        rec.outputs = plan.files
        rec.status = 'done'
        rec.endedAt = deps.now()
        await persist(run)
        if (plan.ui) publish(run, ev.executed(stageKey, id, plan.ui))
        return
      }
      if (plan.kind === 'pause') {
        rec.outputs = plan.files
        // A value held at a closed Gate (R0.4): Continue marks the Gate done, and this is what it hands on.
        if (plan.values) rec.values = plan.values
        else delete rec.values
        rec.status = 'paused'
        rec.endedAt = deps.now()
        await persist(run)
        return
      }

      // A node already moved to its backup keeps the backup's request as written down;
      // a resumed one keeps the request it was sent.
      if (!rec.switchedFrom && !resuming) {
        rec.endpoint = plan.endpoint
        rec.payload = plan.payload
      }
      // Written down with the request, so a resumed node composites from the same kept bytes.
      if (plan.keep && !resuming) rec.keepHeld = plan.keep.held
      const backup = backupSettings.enabled && plan.backup && !resumedWithoutBackup ? plan.backup : null
      // Priced on the measured picture where the price depends on its size
      // (FLUX.2 edit; Rotate camera on 2511), and on the measured media where
      // it depends on them (sync-3 lip-sync; Topaz video upscale), measured
      // before planning.
      // A speech text a card decides before the run is priced at its length (R3.8 fix round 1), as the hold was.
      if (!resuming) rec.credits = nodeCredits(withStaticSpeechText(take.prompt)[id]!, inputPixels, families, inputSeconds)
      // A predicted size (fix round 1): the real size's price, never above what was held for it.
      if (!resuming && held?.predicted && held.pixels !== undefined) rec.credits = Math.min(rec.credits, nodeCredits(take.prompt[id]!, held.pixels, families))
      const fp = resuming
        ? rec.fingerprint
        // Reused with an explicit seed; an LLM text node's request by itself (ruling (d)).
        : isReusable(plan.payload) || plan.reuse === 'same-request'
          ? requestFingerprint(fingerprintEndpoint(plan.provider, plan.endpoint), withKeep(plan.payload, plan.keep), u => deps.handoff.hashOf(u))
          : null
      rec.fingerprint = fp

      if (fp && !rec.request) {
        const prior = await deps.store.getResult(userKey, fp)
        const priorFiles = prior?.files ?? []
        const priorHasValues = !!prior?.values && Object.keys(prior.values).length > 0
        if (prior && (priorFiles.length || priorHasValues) && (await Promise.all(priorFiles.map(f => files.exists(f)))).every(Boolean)) {
          for (const f of priorFiles) await deps.metering.addOutput(run.userId, stageKey, f)
          rec.outputs = priorFiles
          if (priorHasValues) rec.values = prior.values
          rec.reused = true
          rec.status = 'done'
          rec.endedAt = deps.now()
          await persist(run)
          const ui = plan.uiFor(priorFiles, priorHasValues ? prior.values : undefined)
          if (ui) publish(run, ev.executed(stageKey, id, ui))
          return
        }
      }
      rec.reused = false

      await limiter.acquire(userKey, signal)
      let result: unknown
      try {
        // A Stop can land while the slot is being handed over; nothing may go out after it.
        if (signal.aborted) throw new RunStopped()
        if (!rec.request) {
          if (rec.switchedFrom && backup) {
            // A restart landed between writing the switch down and sending the
            // backup. If that send had reached the backup, its job is a stray (Sailor absorbs it).
            await submitRequest(run, rec, backup.provider, signal)
          }
          else {
            if (rec.switchedFrom) {
              // Switched, but the backup is gone now (switched off): back to the first service.
              delete rec.switchedFrom
              rec.endpoint = plan.endpoint
              rec.payload = plan.payload
            }
            try { await submitRequest(run, rec, plan.provider, signal) }
            catch (e) {
              if (!backup || signal.aborted || !isSubmitOutage(e)) throw e
              await sendToBackup(run, rec, backup, { provider: plan.provider, requestId: null }, 'send-failed', stageKey, id, signal)
            }
          }
        }
        // A 3D file waits as a video does; a sound or a value as a picture, unless the plan says video.
        const wait = plan.wait ?? (plan.media === 'video' || plan.media === 'glb' ? 'video' : 'image')
        result = await waitForResult(run, rec, stageKey, id, wait, signal, backup, backupSettings.stallMs, MEDIA_NOUN[plan.media])
      }
      finally {
        limiter.release(userKey)
      }
      // A token-priced node is charged what its answer says it used, never above its hold.
      if (plan.chargeOf) {
        const used = plan.chargeOf(result)
        // Only a finite count of zero or more is believed, rounded up to whole
        // credits; anything else (NaN, negative, infinite, not a number) charges the hold.
        if (used != null) {
          if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) {
            deps.reportError(new Error(`This step’s answer gave a charge Sailor can’t read (${String(used)}); charged the hold`), {
              site: 'runner.charge.unreadable', stageKey, node: id, charge: String(used), hold: rec.credits,
            })
          }
          else {
            const credits = Math.ceil(used)
            if (credits > rec.credits) {
              deps.reportError(new Error(`A charge of ${credits} credits is above this step’s hold of ${rec.credits}; charged the hold`), {
                site: 'runner.charge.above-hold', stageKey, node: id, charge: credits, hold: rec.credits,
              })
            }
            rec.credits = Math.min(rec.credits, credits)
          }
        }
      }

      /** Files the result for reuse; made on the backup, also under the backup's own request, so the same settings reuse it either way. */
      const fileResult = async (entry: { files: OutputFile[]; values?: Record<number, RunnerValue> }) => {
        if (fp) await deps.store.putResult(userKey, fp, entry).catch(e => deps.reportError(e, { site: 'runner.putResult' }))
        const servedBy = rec.servedBy
        if (servedBy && rec.switchedFrom && rec.payload && isReusable(rec.payload)) {
          const backupFp = requestFingerprint(fingerprintEndpoint(servedBy, rec.endpoint!), withKeep(rec.payload, plan.keep), u => deps.handoff.hashOf(u))
          if (backupFp !== fp) await deps.store.putResult(userKey, backupFp, entry).catch(e => deps.reportError(e, { site: 'runner.putResult' }))
        }
      }
      if (plan.media === 'value') {
        if (!plan.valuesOf) throw new Error('This step has no way to read its answer')
        const values = plan.valuesOf(result, rawTextOf(result))
        for (const v of Object.values(values)) checkValue(v)
        rec.values = values
        rec.outputs = filesOfValues(values)
        // Files a value names (masks, pictures, a 3D file) are the run's outputs, as the derive branch's assets are.
        for (const f of rec.outputs) await deps.metering.addOutput(run.userId, stageKey, f)
        rec.status = 'done'
        rec.servedBy = providerOf(rec.request!)
        rec.endedAt = deps.now()
        await fileResult({ files: rec.outputs, values })
        await persist(run).catch(e => deps.reportError(e, { site: 'runner.node.save', stageKey, node: id }))
        const ui = plan.uiFor(rec.outputs, values)
        if (ui) publish(run, ev.executed(stageKey, id, ui))
        return
      }
      let urls = plan.urlsOf ? plan.urlsOf(result) : clientFor(providerOf(rec.request!)).outputUrls(result, plan.media)
      // Python reads `_first_output_url`: only the first is downloaded.
      if (plan.take === 'first') urls = urls.slice(0, 1)
      if (!urls.length) throw new Error(NO_FILE[plan.media])
      // Every file goes through the safe-fetch policy, capped by its kind; a
      // sound or a 3D file is checked by its bytes, and every extension comes
      // from its kind's list (answerDownload.ts). A file lost here fails the
      // node after its call: not charged (Sailor absorbs it), reported.
      const kind: AnswerKind = plan.media
      const fetchAnswer = async (url: string, keep: (bytes: Uint8Array, contentType: string | null) => Promise<OutputFile>): Promise<OutputFile> => {
        try {
          // Stop ends a download under way; a file already downloaded is kept (made and billed), as before.
          const { bytes, contentType } = await deps.download(url, { maxBytes: ANSWER_MAX_BYTES[kind], signal, kind })
          return await keep(bytes, contentType)
        }
        catch (e) {
          if (!(e instanceof RunStopped) && !signal.aborted) {
            deps.reportError(e, { site: 'runner.download.lost', stageKey, node: id, provider: providerOf(rec.request!), requestId: rec.request!.requestId, url })
          }
          throw e
        }
      }
      const saved: OutputFile[] = []
      if (plan.media === 'glb' || plan.media === 'svg') {
        // A 3D file (spec ruling 1, R3 ruling (k)), or a Recraft SVG model's SVG
        // (R11.4): Sailor's own copy, checked by its bytes, saved in the user's
        // output folder as an asset, handed on as a `glb` / `svg` value naming
        // it. Python hands on the 3D file's provider link, which expires, and
        // can't decode the SVG at all.
        const media = plan.media
        const url = urls[0]!
        const file = await fetchAnswer(url, (bytes, contentType) =>
          deps.results.save(bytes, { userId: run.userId, prefix: plan.prefix, ext: answerExt(media, bytes, contentType, url) }))
        await deps.metering.addOutput(run.userId, stageKey, file)
        const values: Record<number, RunnerValue> = { 0: media === 'glb' ? { kind: 'glb', url: viewUrlOf(file), file } : { kind: 'svg', url: viewUrlOf(file), file } }
        for (const v of Object.values(values)) checkValue(v)
        rec.values = values
        rec.outputs = [file]
        rec.status = 'done'
        rec.servedBy = providerOf(rec.request!)
        rec.endedAt = deps.now()
        await fileResult({ files: rec.outputs, values })
        await persist(run).catch(e => deps.reportError(e, { site: 'runner.node.save', stageKey, node: id }))
        const ui = plan.uiFor(rec.outputs)
        if (ui) publish(run, ev.executed(stageKey, id, ui))
        return
      }
      if (plan.keep) {
        // Blend scene's kept subject (Task F11b): Python reads the first
        // answer only, lays it under the kept region, and saves that as a PNG.
        const keepStep = plan.keep
        const file = await fetchAnswer(urls[0]!, async (bytes) => {
          const png = await keepStep.apply(bytes, signal)
          if (signal.aborted) throw new RunStopped()
          return deps.results.save(png, { userId: run.userId, prefix: plan.prefix, ext: 'png' })
        })
        await deps.metering.addOutput(run.userId, stageKey, file)
        saved.push(file)
      }
      else {
        for (const url of urls) {
          const file = await fetchAnswer(url, async (bytes, contentType) => plan.rgb
            // Python drops alpha before it saves (rule 3): the RGB PNG of the decoded pixels.
            ? deps.results.save(await answerRgbPng(bytes), { userId: run.userId, prefix: plan.prefix, ext: 'png' })
            : deps.results.save(bytes, { userId: run.userId, prefix: plan.prefix, ext: answerExt(kind, bytes, contentType, url) }))
          await deps.metering.addOutput(run.userId, stageKey, file)
          saved.push(file)
        }
      }
      rec.outputs = saved
      rec.status = 'done'
      rec.servedBy = providerOf(rec.request!)
      rec.endedAt = deps.now()
      await fileResult({ files: saved })
      // The result is made, kept and billed: a failed save here must not turn
      // the node into an error. The stage's closing save writes it down again.
      await persist(run).catch(e => deps.reportError(e, { site: 'runner.node.save', stageKey, node: id }))
      const ui = plan.uiFor(saved)
      if (ui) publish(run, ev.executed(stageKey, id, ui))
    }
    catch (e) {
      if (e instanceof RunStopped || signal.aborted) {
        rec.status = 'stopped'
        rec.error = null
        // Stop may have landed while this request was being sent, before
        // Stop could see its id: cancel it here so nothing is left running.
        // A pipeline's call in flight too (R3.1).
        for (const req of sentRequests(rec)) await cancelOnce(req)
      }
      else {
        rec.status = 'error'
        rec.error = plainError(e)
      }
      rec.endedAt = deps.now()
      await persist(run).catch(() => {})
    }
    finally {
      // R11.5: a long sound converted for this turn goes with it (done, failed or stopped).
      for (const dir of pieceDirs) await removeSoundPieces({ dir })
      // A finished node lets its held bytes go; one still waiting (a restart
      // mid-wait never gets here) keeps them for its resume.
      if ((heldUsed || rec.keepHeld) && (rec.status === 'done' || rec.status === 'error' || rec.status === 'stopped')) {
        await held.drop(run.id, holder).catch(e => deps.reportError(e, { site: 'runner.held.drop', node: id }))
      }
    }
  }

  /**
   * Ask the first service to cancel a job that never started, before it is
   * sent to the backup. Its status is looked at once more just before the
   * cancel, so a job that has just started is kept (this narrows the race;
   * a job that starts between that look and the cancel is cancelled and
   * switched all the same — Sailor absorbs the partial run).
   * After the cancel it is looked at again: only the provider saying the job
   * is over counts as cancelled (an accepted cancel is only a request).
   *   'cancelled'   — the provider confirmed it: switch.
   *   'keep'        — the job had already finished or started: keep it, no switch.
   *   'unconfirmed' — the cancel failed or is not applied, and the job is
   *                   still waiting: switch anyway (ruling 2). The first job
   *                   may still run and bill Sailor — never the user, who is
   *                   charged once. Its cancel is asked about again in the
   *                   background until the provider confirms it (watchCancel).
   */
  async function cancelledForSwitch(client: ProviderClient, req: PendingRequest): Promise<'cancelled' | 'keep' | 'unconfirmed'> {
    try {
      const now = await client.status(req.statusUrl, { logs: false })
      if (!now.transient && now.status !== 'IN_QUEUE') return 'keep'
    }
    catch { /* no answer: go on and cancel */ }
    let outcome: unknown
    try { outcome = await client.cancel(req.cancelUrl) }
    catch { outcome = null }
    if (outcome === 'already-done') return 'keep'
    try {
      const again = await client.status(req.statusUrl, { logs: false })
      if (!again.transient) {
        if (again.status === 'IN_QUEUE') return 'unconfirmed'
        if (again.status === 'COMPLETED' && again.error) return 'cancelled'
        return 'keep' // started, or finished with a result
      }
    }
    catch { /* no answer */ }
    // No real answer to the look: the cancel's own answer decides. Replicate's
    // 'cancelled' is the prediction reading canceled; anything else is not known.
    if (outcome === 'cancelled') return 'cancelled'
    return outcome === 'requested' ? 'unconfirmed' : 'keep'
  }

  /**
   * `media` sets the time limits (a picture's or a video's); `noun` names the
   * result in a time-out's words (default: the media's own word).
   */
  async function waitForResult(
    run: RunRecord, rec: Sendable, stageKey: string, nodeId: string, media: 'image' | 'video', signal: AbortSignal,
    backup: ProviderBackup | null = null, stallMs = 0, noun: string = media,
  ): Promise<unknown> {
    let req = rec.request!
    let provider = providerOf(req)
    let client = clientFor(provider)
    // Set once the first service has been asked to give the job up and kept it: no second try.
    let keepFirst = false
    const limitMs = media === 'video' ? deps.timeouts.videoMs : deps.timeouts.imageMs
    // A job the service says is still waiting to start may wait this long
    // from its send (never less than the run limit); once it starts, it gets
    // the run limit from the start (`req.startedAt`: the time it was first
    // seen started, saved on the request so a restart keeps it, and taken no
    // later than the queue allowance, so the whole wait is bounded by queue +
    // run limit).
    const queueMs = Math.max(limitMs, (media === 'video' ? deps.timeouts.videoQueueMs : deps.timeouts.imageQueueMs) ?? 0)
    // The provider's last real answer said the job is waiting to start.
    let queued = false
    const deadline = () => req.startedAt != null
      ? Math.min(req.startedAt, req.submittedAt + queueMs) + limitMs
      : req.submittedAt + (queued ? queueMs : limitMs)
    let attempt = 0
    // Only a real answer from the provider counts as having asked: a blip says nothing.
    let asked = false
    let lastPos: number | null = req.queuePosition
    let lastPct = -1
    let started = false
    if (lastPos != null && lastPos > 0) publish(run, ev.queuePosition(stageKey, nodeId, lastPos))
    for (;;) {
      if (signal.aborted) throw new RunStopped()
      // Ask the provider at least once before giving up: after a restart the
      // request may already have finished while the server was down.
      // The limit runs from the current request's send (or its start, see
      // `deadline`): after a switch to the backup it starts again, so a
      // node's total wait can reach the stall time plus the limit. The
      // message speaks of the service, so it stays true.
      if (asked && deps.now() > deadline()) {
        // Past a queue allowance longer than the run limit: say so. Otherwise the run limit's words.
        const stillQueued = queued && req.startedAt == null && queueMs > limitMs
        const check = await confirmCancel(run, req)
        // It finished just as it was cancelled: the result is made and billed, so it is kept.
        if (check.confirmed && check.ended === 'finished' && check.status) {
          if (provider === 'replicate' && check.status.raw != null) return check.status.raw
          try { return await client.result(req.responseUrl) }
          catch { /* not fetchable: fail as a time-out */ }
        }
        const late = stillQueued
          ? `The service hadn’t started this ${noun} after ${limitWords(queueMs)} in its queue`
          : `The service took more than ${limitWords(limitMs)} to make this ${noun}`
        throw new Error(check.confirmed ? `${late}, so it was cancelled` : `${late}. ${NOT_CONFIRMED}`)
      }
      // Outer limit that applies even when the provider never gave a real
      // answer (a status URL stuck returning 5xx, or a network error on every
      // poll): do not wait on `asked` forever, or the node — and its limiter
      // slot and queued-call count — never frees up. `attempt > 0` still gives
      // the provider one chance to answer first, the same reasoning as the
      // `asked` check above: after a restart the deadline is measured from
      // the original submit time, and a real answer waiting at the provider
      // must still be fetched.
      // A provider that answered "still queued" once and then only fails
      // transiently keeps the queue allowance (`queued` is its last real
      // answer): the check above, not this one, cancels it at the send + the
      // queue allowance (2 h for a video), so it is bounded at 2 h, not 30
      // minutes + the grace. This outer limit only ever meets a provider that
      // has never answered, whose deadline is the run limit.
      if (attempt > 0 && deps.now() > deadline() + GRACE_MS) {
        const check = await confirmCancel(run, req)
        throw new Error(check.confirmed
          ? 'The provider did not answer, so the request was cancelled'
          : `The provider did not answer. ${NOT_CONFIRMED}`)
      }
      let s: FalStatus
      try { s = await client.status(req.statusUrl, { logs: started }) }
      catch (e) {
        if (!isProviderNetworkError(e)) throw e
        s = { status: 'UNKNOWN', queuePosition: null, logs: [], error: null, transient: true, raw: null }
      }
      if (!s.transient) {
        asked = true
        queued = s.status === 'IN_QUEUE'
        if (s.status === 'IN_QUEUE') {
          if (s.queuePosition != null && s.queuePosition !== lastPos) {
            lastPos = s.queuePosition
            req.queuePosition = lastPos
            publish(run, ev.queuePosition(stageKey, nodeId, lastPos))
          }
          // Still waiting to start after the stall time (measured from the
          // saved send time, so it survives a restart): move it to the
          // backup, once. A job that has started is never moved — it may
          // already be billed.
          if (backup && stallMs > 0 && !rec.switchedFrom && !started && !keepFirst && deps.now() - req.submittedAt >= stallMs) {
            const cancel = await cancelledForSwitch(client, req)
            if (cancel !== 'keep') {
              const from = { provider, requestId: req.requestId, ...(cancel === 'unconfirmed' ? { cancelUrl: req.cancelUrl } : {}) }
              const first = req
              req = await sendToBackup(run, rec, backup, from, 'slow-start', stageKey, nodeId, signal)
              if (cancel === 'unconfirmed') await watchCancel(run, { provider: from.provider, requestId: first.requestId, statusUrl: first.statusUrl, cancelUrl: first.cancelUrl }, { lastStatus: 'IN_QUEUE', lastError: null }, 1)
              provider = backup.provider
              client = clientFor(provider)
              queued = false
              attempt = 0
              asked = false
              lastPos = req.queuePosition
              lastPct = -1
              started = false
              if (lastPos != null && lastPos > 0) publish(run, ev.queuePosition(stageKey, nodeId, lastPos))
              continue
            }
            keepFirst = true
            // The job there may have finished meanwhile: ask again straight away.
            continue
          }
        }
        else if (s.status === 'IN_PROGRESS') {
          if (!started) {
            started = true
            if (req.startedAt == null) {
              req.startedAt = deps.now()
              // Saved in the background: persist snapshots the run now and
              // queues its saves in order, so the wait isn't held up by it.
              void persist(run).catch(e => deps.reportError(e, { site: 'runner.node.started', stageKey, node: nodeId }))
            }
            req.queuePosition = null
            if (lastPos != null) publish(run, ev.queuePosition(stageKey, nodeId, 0)) // 0 = started
            lastPos = null
          }
          const pct = percentFromLogs(s.logs)
          if (pct != null && pct !== lastPct) {
            lastPct = pct
            publish(run, ev.progress(stageKey, nodeId, pct))
          }
        }
        else if (s.status === 'COMPLETED') {
          if (s.error) {
            const retries = req.retries ?? 0
            if (!(provider === 'replicate' && s.retryable && retries < REPLICATE_TRANSIENT_RETRIES && rec.endpoint && rec.payload)) {
              throw new Error(s.error)
            }
            // A Replicate hiccup: wait, send the same request again, and write
            // the new one down before waiting on it. Nothing more is charged.
            // waitForResult only runs inside runNode's limiter slot, so the
            // backoff and the re-run hold that slot: no other call slips in.
            await sleepOrWake(2000 * (retries + 1), req.requestId, signal)
            if (signal.aborted) throw new RunStopped()
            const sub = await client.submit(rec.endpoint, rec.payload, { webhookUrl: webhookFor(provider) })
            req = {
              provider, requestId: sub.requestId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl,
              cancelUrl: sub.cancelUrl, submittedAt: deps.now(), queuePosition: sub.queuePosition, retries: retries + 1,
            }
            rec.request = req
            await persist(run)
            queued = false
            attempt = 0
            asked = false
            lastPos = req.queuePosition
            lastPct = -1
            started = false
            keepFirst = false
            continue
          }
          // Replicate's own status body already carries the finished
          // prediction (Python never does a second GET): use it directly
          // and skip the extra round trip when it is there.
          if (provider === 'replicate' && s.raw != null) return s.raw
          // The provider has made (and billed) it: a network error fetching
          // it is tried again on the next turn, until the time limit.
          try { return await client.result(req.responseUrl) }
          catch (e) { if (!isProviderNetworkError(e)) throw e }
        }
        else {
          throw new Error(`The provider stopped this request (${s.status})`)
        }
      }
      await sleepOrWake(deps.pollDelayMs(attempt++), req.requestId, signal)
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────
  /** Provider calls this user has waiting or running, across the running legs of their runs. */
  function queuedCalls(userId: string | null): number {
    let n = 0
    for (const { run } of live.values()) {
      if (run.userId !== userId) continue
      for (const leg of run.legs) {
        if (leg.status !== 'running') continue
        for (const t of leg.takes) {
          const take = run.takes[t]!
          const charge = run.charges.find(c => c.stageKey === stageKeyOf(leg.id, t))
          if (!charge || charge.finished) continue
          for (const id of charge.nodeIds ?? stageNodeIds(take, charge, leg.index)) {
            const rec = take.nodes[id]
            if (!rec) continue
            if (isQueuedWork(rec.classType, take.prompt[id]?.inputs, new Set(leg.families ?? [])) && (rec.status === 'waiting' || rec.status === 'running')) n++
          }
        }
      }
    }
    return n
  }

  /**
   * The start of a run up to its hold (R8.0): every check, refusal and
   * measurement the start makes, in its order, with nothing held, stored or
   * kept. startRun and quoteRun both begin here, so a quote refuses what a
   * run would and is priced on the same measurements.
   */
  async function prepareStart(i: StartRunInput) {
    const takes = i.takes
    if (!Array.isArray(takes) || !takes.length) throw refuse('There is nothing to run', 400)
    if (takes.length > deps.maxTakes) throw refuse(`At most ${deps.maxTakes} versions can run at once`, 400)
    // The server's families decide; a browser that disagrees is refused, with
    // a marker it reads as "run this on ComfyUI instead" (isRunnerDeclined).
    const families = deps.families?.() ?? NO_FAMILIES
    // A retired partner node an output reads (Task R4.1) is refused first,
    // before anything is checked, priced or held, in ComfyUI's 400 shape and
    // with no marker: it can't run on ComfyUI either (shared/runner/retired.ts).
    // One no output reads is left to pruning, as ComfyUI leaves it: the
    // eligibility below declines the workflow (a class the runner doesn't
    // know), and the ComfyUI path prunes the node and runs the rest.
    for (const p of takes) {
      const retired = retiredPromptRefusal(p)
      if (retired) throw refuse(retired.error.message, 400, { node_errors: retired.node_errors })
    }
    // ComfyUI's validate_prompt first: outputs that fail validation are
    // dropped with what only they need (shared/runner/validate.ts); the rest
    // is what runs, is checked, priced and held. Nothing of a dropped node runs.
    const prompts: ApiPrompt[] = []
    let nodeErrors: Record<string, ComfyNodeError> | undefined
    for (const p of takes) {
      if (!p || typeof p !== 'object') throw refuse('This workflow can’t run on the Sailor runner', 400, { reason: RUNNER_NOT_ELIGIBLE })
      const pruned = pruneInvalidOutputs(p as ApiPrompt, families)
      // ComfyUI: "Prompt has no outputs" (R3.8 fix round 1) or "Prompt outputs failed
      // validation". No marker: ComfyUI would refuse it too. Nothing is held.
      if (pruned.noOutputs) throw refuse(NO_OUTPUTS_MESSAGE, 400)
      if (pruned.failed) throw refuse(NO_VALID_OUTPUTS_MESSAGE, 400, { node_errors: pruned.nodeErrors })
      // R11.4: a model with no price yet (ruling (p)) never runs, and a Recraft SVG model's SVG wired
      // into a node that needs a picture can't be read: both refused now, before anything is priced or
      // held, and with no marker, since ComfyUI can't run either (shared/runner/blockedModels.ts, svgImage.ts).
      const unpriced = blockedModelUses(pruned.prompt, { families, runnerTakes: true }).filter(u => u.reason === 'unpriced')
      if (unpriced.length) {
        const body = blockedModelsResponse(pruned.prompt, unpriced, { families })
        throw refuse(body.error.message, 400, { node_errors: body.node_errors })
      }
      const svgReader = svgReaderProblems(pruned.prompt, families)[0]
      if (svgReader) throw refuse(svgReader.message, 400, { nodeId: svgReader.nodeId, classType: svgReader.classType })
      if (!isRunnerEligible(pruned.prompt, families, { hosted: deps.hosted(), afterPruning: prunedAny(pruned) })) {
        throw refuse('This workflow can’t run on the Sailor runner', 400, { reason: RUNNER_NOT_ELIGIBLE })
      }
      if (pruned.dropped.length) nodeErrors ??= pruned.nodeErrors
      prompts.push(pruned.prompt)
    }
    // A discontinued model is refused before anything is priced or held,
    // with the same words as the browser (shared/runner/blockedModels.ts).
    // Sailor never swaps in another model.
    for (const p of prompts) {
      const uses = blockedModelUses(p, { families, runnerTakes: true })
      if (!uses.length) continue
      const body = blockedModelsResponse(p, uses, { families })
      throw refuse(body.error.message, 400, { node_errors: body.node_errors })
    }
    // A request no provider takes (a Nano Banana prompt under 3 characters,
    // too many Seedance references) is refused before anything is held
    // (requestRules.ts; planNode checks the built request again). `runner`
    // adds the rules only a runner run has (Krea 2's prompt, F17).
    for (const p of prompts) {
      // Hosted: a cloned voice (R3.8, ruling (j)) too.
      const problem = requestProblems(p, { runner: true })[0] ?? (deps.hosted() ? hostedRequestProblems(p)[0] : undefined)
      if (problem) throw refuse(problem.message, 400, { nodeId: problem.nodeId, classType: problem.classType })
      // A LoRA picked by name (R3.13): one ComfyUI lists, its sidecar within its cap.
      const lora = await loraStartProblem(p, { hosted: deps.hosted() })
      if (lora) throw refuse(lora.message, 400, { nodeId: lora.nodeId, classType: lora.classType })
    }
    // Fail closed on price, before anything is held: a provider node that
    // prices at 0 (a class the price book misses by name) never runs free.
    if (deps.hosted()) {
      for (const p of prompts) {
        let unpriced: string | null
        try { unpriced = unpricedProviderNode(withStaticSpeechText(p), undefined, n => nodeCredits(n, undefined, families)) }
        catch (e) {
          if (e instanceof UnpricedGraphError) throw refuse('A model in this workflow has no price yet', 500)
          throw e
        }
        if (unpriced != null) throw refuse('This step has no price yet, so it can’t run', 500, { nodeId: unpriced, classType: p[unpriced]!.class_type })
      }
    }
    const noGates: TakeGateState = { done: new Set(), open: new Set(), dropped: new Set() }
    const wanted = prompts.reduce((n, p) => n + [...legNodes(p, noGates)].filter(id => isQueuedWork(p[id]!.class_type, p[id]!.inputs, families)).length, 0)
    if (queuedCalls(i.userId) + wanted > MAX_QUEUED_CALLS) throw refuse('You have too many runs waiting. Try again when one finishes.', 429)
    await deps.metering.spendGuard(i.userId)
    const inputFiles = new Map<string, OutputFile>()
    for (const p of prompts) for (const f of collectInputFiles(p, families)) inputFiles.set(`${f.type}:${f.subfolder}:${f.filename}`, f)
    // R5.5 fix round 2: Save video frames' sound is judged by its name alone, never by whether it is there
    // (that would tell a hosted user whether another user's file exists). A name that isn't a plain file in
    // the folders is never the user's own: the same refusal as another user's file.
    if (deps.hosted()) {
      for (const p of prompts) {
        // R6.4: a LUT's .cube file the same way (rule 8): absolute, or climbing out of its folder, is never theirs.
        // R6.7: Audio waveform's sound too.
        const [bad] = [...unsafeSoundNames(p), ...unsafeLutNames(p, families), ...unsafeWaveformNames(p, families)]
        if (bad !== undefined) throw new MeterRefusalError(NOT_YOURS, 403, { file: bad })
      }
    }
    // A Film a shot's reference links (`/view?…&type=input` in its options,
    // Task 4; a preset shot's too, R3.11): the runner resolves them into
    // provider links, so they must be the caller's own files too. Generate a
    // video resolves none.
    for (const p of prompts) {
      for (const n of Object.values(p)) {
        if (n.class_type !== 'FilmShotNode' || isLink(n.inputs?.model_options)) continue
        for (const filename of shotRefFilenames(parseJsonObject(n.inputs?.model_options))) {
          inputFiles.set(`input::${filename}`, { filename, subfolder: '', type: 'input' })
        }
      }
    }
    await assertFilesOwned([...inputFiles.values()], i.userId, deps.hosted(), deps.ownership)
    // Seedance 2.0 references: at most 15 s of video and 15 s of sound in all,
    // measured from their input files; hosted refuses one it can't measure
    // (S1b fix round 2). Loaded here so this change stays in one place.
    const { runnerReferenceProblems } = await import('../utils/graphInputSeconds')
    const tooLong = await runnerReferenceProblems(prompts, {
      readFile: f => files.read(f), strict: deps.hosted(),
      assertOwned: fs => assertFilesOwned(fs, i.userId, deps.hosted(), deps.ownership),
    })
    if (tooLong) throw refuse(tooLong.message, 400, { nodeId: tooLong.nodeId, classType: tooLong.classType })
    // A Film a shot's reference files go as their raw bytes (as Python sends them): one over its
    // service's stated cap is refused now, before the hold (R3.11 fix round 1).
    for (const p of prompts) {
      const big = await shotRefSizeProblem(p, !!deps.backup?.().enabled, f => files.size(f))
      if (big) throw refuse(big.message, 400, { nodeId: big.nodeId, classType: big.classType })
    }
    // Media nodes (./nodeMedia.ts: sync-3 lip-sync, F22; Topaz video upscale,
    // F23): their files must be the caller's own (hosted), and the model must
    // be able to take them: read and measured now, before anything is held.
    // The node's turn reads them again. What was measured is recorded on the
    // take (the tight hold, F22 fix round 1).
    const measured: Record<string, MeasuredMedia>[] = prompts.map(() => ({}))
    // R7.8 fix round 1: what each R7 node keeps for the run at most (TakeRecord.keptUpTo).
    const keptUpTo: Record<string, number>[] = prompts.map(() => ({}))
    // The request going away stops this media work (R7.7 fix round 1): every probe and decode below
    // runs under its signal (each tool job in its own media slot, given back when it is killed).
    const startSignal = i.signal
    const stoppedWords = (e: unknown) => (startSignal?.aborted ? MEDIA_WORDS.stopped : null) ?? (e instanceof Error ? e.message : String(e))
    for (const [index, p] of prompts.entries()) {
      // R7.7 fix round 1: Whisper transcribe's sound bounded before the hold from its maker (R6.9's
      // sound start pass: headers and the sound effects' widgets, probes only — nothing is decoded);
      // R7.8: Vocal separator's the same.
      let whisperShapes: Awaited<ReturnType<typeof soundShapes>> | null = null
      for (const [nodeId, n] of Object.entries(p)) {
        if (!mediaNodeKind(n)) continue
        await assertFilesOwned(nodeMediaFiles(p, nodeId), i.userId, deps.hosted(), deps.ownership)
        const place = deps.hosted() ? 'hosted' as const : 'local' as const
        const longest = wholeSoundCap(n.class_type, place)
        const media = await nodeMediaCheck(p, nodeId, {
          read: f => files.read(f), size: f => files.size(f), strict: deps.hosted(),
          // A sound-in node's sound named by the prompt (R3.10): Python's WAV of it, as `load` reads the file
          // (its first 60 s), under the request's signal. Whisper transcribe's and Vocal separator's whole sound
          // isn't decoded here (bounded below).
          ...(longest ? {} : {
            soundFileWav: async (f: OutputFile) => {
              if (!(await files.exists(f))) throw new Error(SOUND_FILE_MISSING)
              return pythonWavOf({ kind: 'files', files: [f], sound: { decode: 'load' } }, 'LoadAudio', { access: files, userId: i.userId, hosted: deps.hosted(), signal: startSignal })
            },
          }),
          videoUploadProblem: f => lipsyncUploadProblem(f, { access: files, userId: i.userId, hosted: deps.hosted(), signal: startSignal }),
          // R11.3 fix round 1: a wired sound's shape, from the same start pass (headers and known silences
          // only), so Kling's 5 MB is judged on the WAV it will be sent before the hold.
          soundShape: async (link: ApiLink) => {
            whisperShapes ??= await soundShapes(p, families, soundSourceShapeOf({ prompt: p, access: files, userId: i.userId, hosted: deps.hosted(), signal: startSignal }))
            return whisperShapes.get(`${link[0]}:${link[1]}`) ?? null
          },
        })
        if (startSignal?.aborted) throw refuse(MEDIA_WORDS.stopped, 400, { nodeId, classType: n.class_type })
        if (longest) {
          const cap = longest.seconds
          // R11.5: past one call's cap the sound runs in pieces; past the ceiling it is refused.
          const ceiling = longest.ceiling
          if (media && media.problem !== null) throw refuse(media.problem, 400, { nodeId, classType: n.class_type })
          // The empty Audio card's second of silence is measured exactly (its WAV, as at the turn).
          if (media) {
            measured[index]![nodeId] = { ...media.measured, seconds: { ...media.measured.seconds, place } }
            const kept = wholeSoundKeptBytes(n.class_type, Math.min(media.measured.seconds.audio ?? cap, ceiling), cap)
            if (kept) keptUpTo[index]![nodeId] = kept
            continue
          }
          const link = n.inputs?.audio
          let found: { seconds: number; exact: boolean } | null = null
          if (isLink(link)) {
            try {
              whisperShapes ??= await soundShapes(p, families, soundSourceShapeOf({ prompt: p, access: files, userId: i.userId, hosted: deps.hosted(), signal: startSignal }))
            }
            catch (e) { throw refuse(stoppedWords(e), 400, { nodeId, classType: n.class_type }) }
            if (startSignal?.aborted) throw refuse(MEDIA_WORDS.stopped, 400, { nodeId, classType: n.class_type })
            found = soundBoundOf(p, link, whisperShapes)
          }
          const bound = found ? found.seconds : null
          // Longer than the node sends here: refused plainly, before anything is held or run. A source's
          // bound is its header's length plus a second, so a loaded file is refused just when its own
          // length passes the cap; within that second the node's turn is the backstop. R7.8 (R7.7's
          // re-review): Vocal separator adds that second only where a header source (or a music node's
          // duration) is in the chain, so an exact chain past the cap is refused here too.
          const slack = n.class_type === VOCALS_CLASS && found?.exact ? 0 : 1
          // R11.5: past one call's cap the sound runs in pieces; only past the hard ceiling is it refused. A
          // Vocal separator's joined stems must also stay readable by the node after it (R5's sound cap).
          const overCeiling = bound !== null && bound > ceiling + slack + 1e-3
          const unreadable = bound !== null && n.class_type === VOCALS_CLASS && !vocalsStemsReadable(Math.min(bound, ceiling), place)
          if (overCeiling || unreadable) throw refuse(longest.words, 400, { nodeId, classType: n.class_type, reason: RUNNER_SOUND_TOO_LONG })
          // Held on the bound (or, where the maker can't be bounded, on one call's longest sound); the node's
          // turn measures the WAV it sends and is charged on that, never above the hold (a longer one is refused
          // there, before anything is sent).
          measured[index]![nodeId] = { seconds: { place, ...(bound !== null ? { audioUpTo: Math.min(bound, ceiling) } : {}) }, sha: {} }
          // Its two stems (and, in pieces, the converted sound) are kept for the run: counted against the kept
          // room before the hold.
          const kept = wholeSoundKeptBytes(n.class_type, bound !== null ? Math.min(bound, ceiling) : cap, cap)
          if (kept) keptUpTo[index]![nodeId] = kept
          continue
        }
        if (!media) continue
        if (media.problem !== null) throw refuse(media.problem, 400, { nodeId, classType: n.class_type })
        measured[index]![nodeId] = media.measured
      }
    }
    // A LoadImage's file (a Frame's baked layer or mask, or with cards on a
    // picture fed to anything) is uploaded just before: one that is gone fails
    // now, before anything runs or is charged.
    for (const f of loadImageFiles(prompts)) {
      if (!(await files.exists(f))) throw refuse(LOADED_PICTURE_MISSING, 400, { file: f.filename })
    }
    // Load audio's validate_inputs (R5.3): a sound file that isn't there is refused now, as
    // ComfyUI refuses the prompt ("Invalid audio file"), before anything runs or is held.
    for (const p of prompts) {
      const missing = await loadAudioStartProblems(p, f => files.exists(f), (f, nodeId) => soundStreamProblem(files, f, i.userId, undefined, { anyLength: soundReadOnlyByPieces(p, nodeId) }))
      if (missing) throw refuse(missing.message, 400, { nodeId: missing.nodeId, classType: missing.classType, ...(missing.file ? { file: missing.file } : {}) })
    }
    // Load video's validate_inputs (R5.4): a video file that isn't there is refused now ("Invalid
    // video file"), and so is one with no picture in it or over the caps (from its header, rule 6),
    // before anything runs or is held. A file the build can't read, and a Video card export the
    // runner can't do (fix round 1), leave the whole workflow to the engine (RUNNER_NOT_ELIGIBLE):
    // switching media-video on never makes a working graph fail.
    for (const p of prompts) {
      const bad = await loadVideoStartProblems(p, f => files.exists(f), (f, o) => videoFileVerdict(files, f, { userId: i.userId, hosted: deps.hosted(), card: o.card }), families)
      if (bad) throw refuse(bad.message, 400, { nodeId: bad.nodeId, classType: bad.classType, ...(bad.file ? { file: bad.file } : {}), ...(bad.engine ? { reason: RUNNER_NOT_ELIGIBLE } : {}) })
    }
    // Load video frames' validate_inputs and Save video frames' sound (R5.5), the same way: a file
    // that isn't there is refused (a missing sound is skipped at its turn, as Python skips it); one
    // the build can't read leaves the whole workflow to the engine.
    for (const p of prompts) {
      const bad = await frameStartProblems(p, f => files.exists(f), f => videoFileVerdict(files, f, { userId: i.userId, hosted: deps.hosted() }), f => framesSoundVerdict(files, f, { userId: i.userId }))
      if (bad) throw refuse(bad.message, 400, { nodeId: bad.nodeId, classType: bad.classType, ...(bad.file ? { file: bad.file } : {}), ...(bad.engine ? { reason: RUNNER_NOT_ELIGIBLE } : {}) })
    }
    // The video effects' start pass (R6 rule 3, ./video/start.ts): every frame batch's count and size
    // through the chain, from the sources' headers and the widgets; a node past a limit (frames held,
    // work, the batch caps, the run's kept total) or reading a source the build can't read leaves the
    // whole workflow to the engine (RUNNER_NOT_ELIGIBLE), never a refusal.
    // Every figure is a true upper bound (R6.1 fix round 1): a source's frames from its header, its packets
    // counted where the file's rate varies or a hosted figure lands within 10% of its limit. Several takes run
    // side by side: none lets go of anything for the others, and each counts the others' kept bytes.
    if (prompts.some(p => hasVideoEffect(p, families))) {
      // The LUT's file (R6.4): one that isn't there or won't load is refused plainly now (Python would hand
      // the frames on silently); in hosted, one past ruling (p)'s size leaves the workflow to the engine.
      for (const p of prompts) {
        const lut = await lutStartProblems(p, families, { hosted: deps.hosted(), exists: f => files.exists(f), size: f => files.size(f), read: f => files.read(f) })
        if (lut) throw refuse(lut.message, 400, { nodeId: lut.nodeId, classType: lut.classType, ...(lut.engine ? { reason: RUNNER_NOT_ELIGIBLE } : {}) })
        // Audio waveform's sound (R6.7): a name outside the folders (local), a file over the size cap or a rate
        // past the runner's bound leaves the workflow to the engine; a missing or unreadable one is Python's silence.
        const wave = await waveformStartProblems(p, families, { access: files, userId: i.userId, hosted: deps.hosted() })
        if (wave) throw refuse(wave.message, 400, { nodeId: wave.nodeId, classType: wave.classType, reason: RUNNER_NOT_ELIGIBLE })
      }
      const shapeAll = async (count: boolean) => Promise.all(prompts.map(p => frameShapes(p, families,
        videoSourceShapeOf({ prompt: p, access: files, userId: i.userId, hosted: deps.hosted(), signal: i.signal, count }))))
      let shapes = await shapeAll(false)
      const several = prompts.length > 1
      const keptOf = (k: number) => {
        const peak = keptPeak(prompts[k]!, families, shapes[k]!, { release: false })
        return peak ? peak.bytes : Number.POSITIVE_INFINITY
      }
      const others = (k: number) => (several ? prompts.reduce((sum, _p, j) => (j === k ? sum : sum + keptOf(j)), 0) : 0)
      const opts = (k: number) => ({ hosted: deps.hosted(), shapes: shapes[k]!, release: !several, keptOthers: others(k) })
      if (prompts.some((p, k) => nearLimit(p, families, opts(k)) || needsExactCount(p, families, shapes[k]!))) shapes = await shapeAll(true)
      // Where Python itself raises on a count known exactly (Motion blur (time) on more than one frame): refused
      // now, before the hold, in the node's own words (R6.2 fix round 1); never a run that fails after paid nodes.
      for (const [k, p] of prompts.entries()) {
        const raises = mediaEffectRefusals(p, families, shapes[k]!)
        if (raises) throw refuse(raises.message, 400, { nodeId: raises.nodeId, classType: raises.classType })
      }
      for (const [k, p] of prompts.entries()) {
        if (!hasVideoEffect(p, families) && !several) continue
        const bad = await mediaEffectStartProblems(p, families, opts(k))
        if (bad) throw refuse(bad.message, 400, { nodeId: bad.nodeId, classType: bad.classType, reason: RUNNER_NOT_ELIGIBLE })
      }
    }
    // R7 (ruling (f)): each local-model picture node's pictures (a clip's frames, one call each) counted
    // before the hold, a true upper bound (./localModelStart.ts), and recorded on the take: the hold and
    // the charge are priced on it, and its turn refuses more. A count that can't be known, or one over the
    // frame cap, leaves the whole workflow to the engine (RUNNER_NOT_ELIGIBLE), never a refusal.
    // A clip's batches (its own, its cut-out's, its masks) are kept while the run goes on: in hosted, every
    // take's together must fit the run's kept room, else the workflow is left to the engine too.
    let localKept = 0
    for (const [index, p] of prompts.entries()) {
      if (!hasLocalModelPicture(p, families)) continue
      const counted = await localModelStartProblems(p, families, {
        hosted: deps.hosted(),
        shapes: () => frameShapes(p, families, videoSourceShapeOf({ prompt: p, access: files, userId: i.userId, hosted: deps.hosted(), signal: i.signal, count: true })),
        // R7.2: a loaded picture's header, for a service's largest picture (Upscale (2×)).
        read: f => files.read(f),
      })
      // R7.3 fix round 1: what Python itself fails on (Object removal's mask of another size) is refused plainly, before the hold.
      if (counted.refused) throw refuse(counted.refused.message, 400, { nodeId: counted.refused.nodeId, classType: counted.refused.classType })
      if (counted.problem) throw refuse(counted.problem.message, 400, { nodeId: counted.problem.nodeId, classType: counted.problem.classType, reason: RUNNER_NOT_ELIGIBLE })
      localKept += counted.keptBytes
      if (localKept > (deps.hosted() ? MEDIA_CAPS.hosted : MEDIA_CAPS.local).keptBytesPerRun) {
        const [nodeId] = Object.keys(counted.counts)
        throw refuse(LOCAL_MODEL_WORDS.overCap, 400, { nodeId, classType: nodeId ? p[nodeId]?.class_type : undefined, reason: RUNNER_NOT_ELIGIBLE })
      }
      for (const [nodeId, bytes] of Object.entries(counted.keptByNode ?? {})) keptUpTo[index]![nodeId] = bytes
      for (const [nodeId, frames] of Object.entries(counted.counts)) {
        const was = measured[index]![nodeId]
        // R7.6: Slow motion (AI) is priced by its clip's frame size too.
        const size = counted.sizes?.[nodeId]
        const sized = size ? { videoWidth: size.w, videoHeight: size.h, place: size.place } : {}
        // R7.11: Upscale (2×) is priced by the largest picture it sends.
        const picture = counted.pictures?.[nodeId]
        const pictured = typeof picture === 'number' ? { picturePixels: picture } : {}
        measured[index]![nodeId] = { ...(was ?? {}), seconds: { ...(was?.seconds ?? {}), frames, ...sized, ...pictured }, sha: was?.sha ?? {} }
      }
    }
    // The sound effects' start pass (R6.9, ./video/soundShapes.ts): every sound's rate, channels and length
    // through the chain, from the sources' headers and the widgets. Where Python itself raises on what is known
    // now (a sound's channels, a trim of no samples) it is refused in the node's words; a node past a limit (the
    // sound held at once, the sound caps, the run's kept total with the video effects' peak) or reading a sound
    // that can't be known before the run leaves the whole workflow to the engine (RUNNER_NOT_ELIGIBLE).
    if (prompts.some(p => hasSoundEffect(p, families))) {
      const all = await Promise.all(prompts.map(p => soundShapes(p, families, soundSourceShapeOf({ prompt: p, access: files, userId: i.userId, hosted: deps.hosted(), signal: i.signal }))))
      for (const [k, p] of prompts.entries()) {
        const raised = soundEffectRefusals(p, families, all[k]!)
        if (raised) throw refuse(raised.message, 400, { nodeId: raised.nodeId, classType: raised.classType })
      }
      // Kept bytes: every take's sounds, never let go, and every take's video peak (several takes run side by side).
      let keptAll = 0
      for (const [k, p] of prompts.entries()) {
        keptAll += soundKeptBytes(p, families, all[k]!)
        if (hasVideoEffect(p, families)) {
          const shapes = await frameShapes(p, families, videoSourceShapeOf({ prompt: p, access: files, userId: i.userId, hosted: deps.hosted(), signal: i.signal, count: true }))
          const peak = keptPeak(p, families, shapes, { release: prompts.length === 1 })
          keptAll += peak ? peak.bytes : Number.POSITIVE_INFINITY
        }
      }
      for (const [k, p] of prompts.entries()) {
        const bad = soundEffectStartProblems(p, families, { hosted: deps.hosted(), sounds: all[k]!, keptOther: keptAll - soundKeptBytes(p, families, all[k]!) })
        if (bad) throw refuse(bad.message, 400, { nodeId: bad.nodeId, classType: bad.classType, reason: RUNNER_NOT_ELIGIBLE })
      }
    }
    // The picture cards' files (R1.3 follow-up): one a card would refuse at its
    // turn (16-bit, 32-bit, CMYK, a see-through GIF, a kind sharp can't read)
    // is refused now, from its header, before anything is held. A file that
    // isn't there is left to the card (3D Studio's placeholder, the Text
    // cards' own failure). The card's own refusal stays as the backstop.
    for (const p of prompts) {
      for (const c of cardPictureFiles(p, families)) {
        let bytes: Uint8Array
        try { bytes = await files.read(c.file) }
        catch { continue }
        const why = await pictureRefusal(bytes)
        if (why) throw refuse(cardPictureRefusal(c.classType, why), 400, { nodeId: c.nodeId, classType: c.classType, file: c.file.filename })
        // Save image / Preview image behind a loader (R1.5): Python saves every frame of an animation.
        if (c.oneFrame && pictureHasFrames(await pictureMeta(bytes), bytes)) {
          throw refuse(c.animated ?? PICTURE_ANIMATED, 400, { nodeId: c.nodeId, classType: c.classType, file: c.file.filename })
        }
        // An effect that changes the picture's size (R2.7): its output within the caps, from the header.
        if (c.resized) {
          const tooLarge = effectOutRefusal(c.resized, c.classType, await pictureMeta(bytes), deps.hosted())
          if (tooLarge) throw refuse(tooLarge, 400, { nodeId: c.resized.nodeId, classType: c.resized.classType, file: c.file.filename })
        }
      }
    }
    // Lens · Depth of field (R7.9 fix round 1): its picture bounded now, and its blur's work from that bound
    // and its settings (Python's, or the fast path's reduced levels): one no reduction fits is refused
    // plainly, before anything is held or any paid node runs. An unbounded picture keeps the turn's check.
    for (const p of prompts) {
      const lens = await lensStartRefusal(p, families, { hosted: deps.hosted(), read: f => files.read(f) })
      if (lens) throw refuse(lens.message, 400, { nodeId: lens.nodeId, classType: lens.classType })
      // Blend scene's kept subject from Image to mask (R8.1): its mask and picture within the keep step's cap, from their headers.
      const keep = await keepStartRefusal(p, { hosted: deps.hosted(), read: f => files.read(f) })
      if (keep) throw refuse(keep.message, 400, { nodeId: keep.nodeId, classType: keep.classType })
    }
    // Pose Mannequin (R3.15): its saved pictures read as Python would open them,
    // before anything is held: one Python reads its own way refused, and
    // (hosted) a saved pose named but not loading refused (Python would fall
    // through to a call). A saved pose that loads makes no call: recorded on
    // the take, so it is held at nothing (fix round 1).
    for (const [index, p] of prompts.entries()) {
      const savedPoses = new Set<string>()
      const pose = await poseStartProblem(p, f => files.read(f), deps.hosted(), savedPoses)
      if (pose) throw refuse(pose.message, pose.status ?? 400, { nodeId: pose.nodeId, classType: pose.classType })
      for (const nodeId of savedPoses) measured[index]![nodeId] = { seconds: {}, sha: {}, savedPose: true }
    }
    // A loader's picture a paid node hands off (R3.H, ./pictureHandoff.ts): one
    // that can't be made into the loader's tensor is refused now, and a model's
    // file cap (Product shot on Bria, HappyHorse 1.1) is judged on the PNG it
    // will be sent, before anything is held. A file that isn't there is left
    // to the node's turn.
    // A capped picture's chosen bytes are kept for the run (fix round 2), so its
    // node's turn sends them without encoding the picture again.
    const chosenAtStart: Array<{ index: number; key: string; sent: LoaderHandoff }> = []
    for (const [index, p] of prompts.entries()) {
      for (const h of loaderHandoffs(p, families)) {
        let bytes: Uint8Array
        try { bytes = await files.read(h.file) }
        catch { continue }
        const why = await handoffRefusal(bytes, h.kind)
        if (why) throw refuse(why, 400, { nodeId: h.nodeId, classType: p[h.nodeId]?.class_type, file: h.file.filename })
        const caps = h.checked ? handoffCapsOf(h.classType, p[h.at]?.inputs ?? {}, families) : null
        if (caps) {
          // Over the cap, the JPEG of the same picture (R3.H fix): refused only if even that is over.
          const sent = await loaderHandoffBytes(bytes, h.kind, undefined, caps)
          const problem = handedOffPictureProblem(h.classType, p[h.at]?.inputs ?? {}, families, sent)
          if (problem) throw refuse(problem, 400, { nodeId: h.at, classType: h.classType })
          if (sent.made) chosenAtStart.push({ index, key: handoffKey(sha256Hex(bytes), h.kind, caps), sent })
        }
      }
    }
    // Upscale and Enhance detail (R3.5), hosted: the size of each one's picture,
    // by the hosted gate's own walk (repairSizes.ts), before anything is held.
    // One the price can't cover is refused now; the others' hold is priced on
    // it, and their turn refuses a picture that has grown since.
    if (deps.hosted()) {
      for (const [index, p] of prompts.entries()) {
        const sized = await startPictureSizes(p, f => files.read(f))
        if (sized.problem) throw refuse(sized.problem.message, 400, { nodeId: sized.problem.nodeId, classType: sized.problem.classType })
        for (const [nodeId, pixels] of Object.entries(sized.pixels)) {
          // A predicted size (not read from a file) is held with a margin (fix round 1).
          measured[index]![nodeId] = sized.predicted.includes(nodeId)
            ? { seconds: {}, sha: {}, pixels: predictedHoldPixels(pixels), predicted: true }
            : { seconds: {}, sha: {}, pixels }
        }
      }
    }
    return { prompts, nodeErrors, measured, keptUpTo, chosenAtStart }
  }

  /** A fresh run's take records from its start (prepareStart). */
  function newTakes(prep: Awaited<ReturnType<typeof prepareStart>>): TakeRecord[] {
    const { prompts, measured, keptUpTo } = prep
    return prompts.map((prompt, index) => ({
      index,
      prompt: JSON.parse(JSON.stringify(prompt)) as ApiPrompt,
      nodes: Object.fromEntries(Object.entries(prompt).map(([id, n]) => [id, emptyNodeRecord(n.class_type)])),
      openGates: [],
      droppedGates: [],
      ...(Object.keys(measured[index]!).length ? { measured: measured[index] } : {}),
      ...(Object.keys(keptUpTo[index]!).length ? { keptUpTo: keptUpTo[index] } : {}),
    }))
  }

  async function startRun(i: StartRunInput): Promise<LegStarted> {
    const prep = await prepareStart(i)
    const { prompts, chosenAtStart, nodeErrors } = prep
    await deps.metering.moderate(prompts, prompts.flatMap(p => staticWiredTexts(p)))

    const now = deps.now()
    const run: RunRecord = {
      id: `run_${deps.newId()}`,
      userId: i.userId,
      canvasId: i.canvasId,
      projectUuid: i.projectUuid,
      projectName: i.projectName,
      workflow: storableWorkflow(i.workflow),
      createdAt: now,
      updatedAt: now,
      status: 'running',
      takes: newTakes(prep),
      legs: [],
      charges: [],
      baseCharged: false,
      stopRequested: false,
    }
    const leg = await openLeg(run, 'run', null, run.takes.map(t => t.index))
    for (const c of chosenAtStart) {
      const file = await kept.put(run.id, c.sent.bytes, c.sent.format === 'png' ? 'png' : 'bin')
      const take = run.takes[c.index]!
      take.handoffs = { ...take.handoffs, [c.key]: { file, format: c.sent.format, alpha: c.sent.alpha } }
    }
    await persist(run)
    launch(run, leg)
    return { runId: run.id, legId: leg.id, promptIds: leg.takes.map(t => stageKeyOf(leg.id, t)), ...(nodeErrors ? { nodeErrors } : {}) }
  }

  /**
   * The price of a run before it starts (R8.0, POST /api/runs/quote): the
   * start's own checks and measurements (prepareStart) and the first leg's
   * hold calculation (legPrices, kept room included), with nothing held,
   * stored, kept or sent. Moderation is left to the run (it calls a
   * service). Refuses exactly as the start would; the figure is what the run
   * then holds, take by take, summed.
   */
  async function quoteRun(i: StartRunInput): Promise<RunQuote> {
    const prep = await prepareStart(i)
    // A quote a newer one replaced (the browser aborted it): nothing more is worked out (fix round 1, M3).
    if (i.signal?.aborted) throw refuse(MEDIA_WORDS.stopped, 400)
    const takes = newTakes(prep)
    const all = takes.map(t => t.index)
    const room = keptRoomNeeded(takes, all)
    // A new run keeps nothing yet.
    if (room) keptRoomCheck(room, 0)
    const prices = legPrices(takes, all, false, deps.families?.() ?? NO_FAMILIES)
    return {
      credits: prices.reduce((n, p) => n + p.estimate, 0),
      usd: Math.round(prices.reduce((n, p) => n + p.usd, 0) * 1e8) / 1e8,
      upTo: prices.some(p => p.upTo),
    }
  }

  function nudge(requestId: string): boolean {
    const w = wakers.get(requestId)
    if (!w) return false
    w()
    return true
  }

  async function settled(runId: string): Promise<void> {
    for (;;) {
      const p = live.get(runId)?.legPromise
      if (!p) return
      await p
      if (live.get(runId)?.legPromise === p) return
    }
  }

  async function gateAction(i: GateActionInput): Promise<LegStarted> {
    return withRunLock(i.runId, async () => {
      const entry = await loadEntry(i.runId)
      if (!entry || entry.run.userId !== i.userId) throw refuse('Run not found', 404)
      const run = entry.run
      if (run.legs.some(l => l.status === 'running')) throw refuse('This run is still going', 409)
      if (run.takes[0]?.prompt[i.gateId]?.class_type !== GATE_CLASS) throw refuse('That is not a Gate in this run', 400)
      if (!['continue', 'redo', 'restart'].includes(i.action)) throw refuse('Unknown Gate action', 400)

      // Work on a copy: if the hold is refused, the run is exactly as it was.
      const draft = JSON.parse(JSON.stringify(run)) as RunRecord
      const { legAction, legTakes } = applyGateAction(draft, i.gateId, i.action, i.takes)
      await deps.metering.spendGuard(i.userId)
      const legPrompts = legTakes.map(t => draft.takes[t]!.prompt)
      await deps.metering.moderate(legPrompts, legPrompts.flatMap(p => staticWiredTexts(p)))
      const leg = await openLeg(draft, legAction, i.gateId, legTakes)
      entry.run = draft
      await persist(draft)
      launch(draft, leg)
      return { runId: draft.id, legId: leg.id, promptIds: leg.takes.map(t => stageKeyOf(leg.id, t)) }
    })
  }

  async function stop(userId: string | null, runIds?: string[]): Promise<{ stopped: string[] }> {
    const targets = [...live.values()].filter(e =>
      e.run.userId === userId
      && e.run.legs.some(l => l.status === 'running')
      && (!runIds || runIds.includes(e.run.id)))
    for (const e of targets) {
      e.run.stopRequested = true
      e.ctl.abort()
      const cancels: Promise<unknown>[] = []
      for (const t of e.run.takes) {
        for (const n of Object.values(t.nodes)) {
          // One try each here, so Stop is quick; one not confirmed is asked about again in the background.
          // A pipeline's call in flight too (R3.1).
          if (n.status === 'running') for (const req of sentRequests(n)) cancels.push(confirmCancel(e.run, req, { tries: 1 }))
          // A first job whose cancel was never confirmed after a switch is cancelled too (a pipeline call's too, R3.1).
          const firsts = n.status === 'running' ? [n.switchedFrom, ...(n.calls ?? []).filter(c => c.status === 'sent').map(c => c.switchedFrom)] : []
          for (const first of firsts) {
            if (!first?.cancelUrl || !first.requestId) continue
            const id = first.requestId
            cancels.push(clientFor(first.provider).cancel(first.cancelUrl).catch(() => {}).then(() => startCancelWatch(e.run.id, id)))
          }
        }
      }
      await Promise.all(cancels)
    }
    await Promise.all(targets.map(e => e.legPromise))
    return { stopped: targets.map(e => e.run.id) }
  }

  /** Server start: pick up every run that was mid-leg. Paused runs need nothing. */
  async function reattach(): Promise<number> {
    // Cancels still waiting for a confirmation are asked about again.
    try {
      for (const run of await deps.store.listUnconfirmedCancels()) {
        for (const c of run.unconfirmedCancels ?? []) if (c.gaveUpAt == null) startCancelWatch(run.id, c.requestId)
      }
    }
    catch (e) { deps.reportError(e, { site: 'runner.cancel.reattach' }) }
    let n = 0
    const active = await deps.store.listActive()
    // Held bytes of runs no longer in progress are let go (heldBytes.ts).
    await held.keepOnly(new Set(active.map(r => r.id))).catch(e => deps.reportError(e, { site: 'runner.held.sweep' }))
    await kept.keepOnly(new Set(active.map(r => r.id))).catch(e => deps.reportError(e, { site: 'runner.kept.sweep' }))
    for (const run of active) {
      if (live.has(run.id)) continue
      const leg = run.legs.find(l => l.status === 'running')
      if (!leg) continue
      entryFor(run)
      launch(run, leg)
      n++
    }
    return n
  }

  function gatesOf(run: RunRecord): PausedGate[] {
    const legId = run.legs.at(-1)?.id ?? `${run.id}.0`
    return [...pausedChoices(run)].map(([nodeId, choices]) => ({
      runId: run.id, promptId: legId, nodeId, choices, picked: choices.length === 1 ? [choices[0]!.take] : [],
    }))
  }

  async function pausedGates(userId: string | null, canvasId: string | null): Promise<PausedGate[]> {
    if (!canvasId) return []
    const stored = await deps.store.listForUser(userId, { canvasId, statuses: ['paused'] })
    return stored.flatMap(r => gatesOf(live.get(r.id)?.run ?? r))
  }

  /** What a newly connected tab needs to catch up: runs in progress and paused Gates. */
  function snapshot(userId: string | null): RunnerMessage[] {
    const out: RunnerMessage[] = []
    for (const { run } of live.values()) {
      if (run.userId !== userId) continue
      const from = out.length
      const leg = run.legs.find(l => l.status === 'running')
      if (leg) {
        for (const t of leg.takes) {
          const stageKey = stageKeyOf(leg.id, t)
          if (run.charges.find(c => c.stageKey === stageKey)?.finished) continue
          out.push(ev.start(stageKey))
          for (const [id, n] of Object.entries(run.takes[t]!.nodes)) {
            if (n.status !== 'running') continue
            out.push(ev.executing(stageKey, id))
            // A tab that connects after a switch still shows the node's note.
            if (n.switchedFrom && n.request) {
              out.push(ev.providerSwitch(stageKey, id, n.switchedFrom.provider, providerOf(n.request), n.switchedFrom.requestId ? 'slow-start' : 'send-failed'))
            }
            if (n.request?.queuePosition) out.push(ev.queuePosition(stageKey, id, n.request.queuePosition))
          }
        }
      }
      else if (run.status === 'paused') {
        for (const g of gatesOf(run)) out.push(ev.gatePaused(g.promptId, run.id, g.nodeId, g.choices, g.picked))
      }
      for (let j = from; j < out.length; j++) out[j] = forCanvas(run, out[j]!)
    }
    return out
  }

  /**
   * The text a generation record shows for one provider node: its prompt
   * widget; else the instruction the runner built and sent (Develop, Relight,
   * a toggle-built Blend); else its other text fields (target, instructions…).
   */
  function recordText(one: ApiPrompt, payload: Record<string, unknown> | null): string {
    const sent = payload?.prompt
    const built = typeof sent === 'string' && sent.trim() ? sent : ''
    return extractGraphPromptText(one) || built || extraPromptText(one)
  }

  async function record(userId: string | null, promptId: string): Promise<RunnerRecordView | null> {
    const runId = runIdOf(promptId)
    if (!runId) return null
    const run = live.get(runId)?.run ?? await deps.store.get(runId)
    if (!run || run.userId !== userId) return null
    const charge = run.charges.find(c => c.stageKey === promptId) ?? null
    const take = run.takes[charge?.take ?? 0]!
    const legIndex = charge?.leg ?? 0
    const ran = Object.entries(take.nodes).filter(([, n]) => n.leg === legIndex)
    const texts = ran
      .filter(([, n]) => PROVIDER_TYPES.has(n.classType))
      .map(([id, n]) => recordText({ [id]: take.prompt[id]! }, n.payload))
      .filter(Boolean)
    return {
      runId,
      promptId,
      workflow: run.workflow,
      createdAt: run.legs[legIndex]?.startedAt ?? run.createdAt,
      endedAt: run.legs[legIndex]?.endedAt ?? null,
      credits: deps.hosted() ? (charge?.actual ?? null) : null,
      prompt: texts[0] ?? null,
      nodeTypes: [...new Set(ran.filter(([, n]) => n.status === 'done' || n.status === 'paused').map(([, n]) => n.classType))],
      projectUuid: run.projectUuid,
      projectName: run.projectName,
    }
  }

  return { startRun, quoteRun, gateAction, stop, reattach, nudge, pausedGates, snapshot, record, settled, cancelChecksSettled, events: deps.events }
}

export type Engine = ReturnType<typeof createEngine>

/**
 * The longest sound a node that sends its WHOLE sound may send where it runs,
 * and its words past it (R7.7 Whisper transcribe, R7.8 Vocal separator), or
 * null for any other class.
 */
function wholeSoundCap(classType: string, place: 'hosted' | 'local'): { seconds: number; ceiling: number; words: string } | null {
  // R11.5: `seconds` is what one call takes; past it the sound runs in pieces, up to `ceiling`.
  if (classType === WHISPER_CLASS) return { seconds: whisperMaxSeconds(place), ceiling: whisperCeilingSeconds(place), words: WHISPER_WORDS.tooLong }
  if (classType === VOCALS_CLASS) return { seconds: vocalsMaxSeconds(place), ceiling: vocalsCeilingSeconds(place), words: VOCALS_WORDS.tooLong }
  return null
}

/**
 * R11.5: the bytes a whole-sound node keeps for the run at most, for a sound
 * of at most `seconds` (counted against the kept room before the hold):
 * Vocal separator's two stems; past one call, also the converted sound its
 * pieces are cut from (16-bit, Demucs' 44.1 kHz stereo; Whisper's 16 kHz mono),
 * a temporary file for the node's turn, counted too so a long sound's disk use
 * is judged before anything is held.
 */
function wholeSoundKeptBytes(classType: string, seconds: number, single: number): number {
  const converted = seconds > single ? Math.ceil(seconds + 1) * (classType === VOCALS_CLASS ? VOCALS_RATE * 2 * 2 : WHISPER_RATE * 2) + 4096 : 0
  return (classType === VOCALS_CLASS ? 2 * vocalsStemMaxBytes(seconds) : 0) + converted
}
