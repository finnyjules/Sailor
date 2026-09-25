/**
 * The Sailor runner. A run is a written-down to-do list: every node's state
 * is saved before and after each outside call, so a restarted server reads
 * the list back and carries on (reattach). A leg runs every node it can
 * reach, in parallel where the graph allows, until each take has finished,
 * failed or paused at a Gate. Money is held per take before a leg starts and
 * charged exactly when it ends. See docs/superpowers/specs/2026-09-22-sailor-runner-and-gate-design.md.
 */
import { LOCAL_RENDER_TYPES, PROVIDER_TYPES, isRunnerEligible } from '#shared/runner/eligibility'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { NO_VALID_OUTPUTS_MESSAGE, pruneInvalidOutputs, type ComfyNodeError } from '#shared/runner/validate'
import { blockedModelUses, blockedModelsResponse } from '#shared/runner/blockedModels'
import {
  GATE_CLASS, dependenciesOf, downstreamNodes, legNodes, upstreamStage,
  type ApiPrompt, type TakeGateState,
} from '#shared/runner/graph'
import { RUNNER_NOT_ELIGIBLE, type GateChoice, type RunnerMessage } from '#shared/runner/messages'
import { MeterRefusalError } from '../utils/requestMeter'
import { BASE_RENDER_CREDITS, UnpricedGraphError } from '../utils/priceBook'
import { extractGraphPromptText } from '../utils/graphPromptText'
import { FalError, isProviderNetworkError, percentFromLogs, type FalStatus, type ProviderClient } from './falQueue'
import { ReplicateError } from './replicateQueue'
import { cancelAndConfirm, type CancelCheck } from './cancelCheck'
import { planNode, type ProviderBackup } from './executors'
import type { BackupSettings } from './config'
import { linkedFileCheck, measuredInputProblem, requestProblems } from './requestRules'
import { isReusable, requestFingerprint } from './fingerprint'
import { assertFilesOwned, collectInputFiles, parseInputFileRef, type OwnershipCheck } from './inputs'
import { extraPromptText, hasOutputNode, measuredInputPixels, nodeCredits, stageEstimate, unpricedProviderNode, type Metering } from './metering'
import { ev, type RunEvents, type SwitchReason } from './events'
import { mediaNodeKind, nodeMediaChangedWords, nodeMediaCheck, nodeMediaFiles } from './nodeMedia'
import { switchedSinceHold } from './switches'
import { measuredMediaChanged } from './mediaInputs'
import type { InputSeconds } from '#shared/pricing/clipSettings'
import type { Handoff } from './handoff'
import { extFor, type ResultStore } from './results'
import { runIdOf, userKeyOf, type RunStore } from './store'
import {
  emptyNodeRecord, stageKeyOf,
  type LegAction, type LegRecord, type NodeRecord, type OutputFile, type PendingRequest, type RunRecord, type RunStatus,
  type RunnerProvider, type StageCharge, type TakeRecord, type MeasuredMedia, type UnconfirmedCancel,
} from './types'

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
const isQueuedWork = (classType: string) => PROVIDER_TYPES.has(classType) || LOCAL_RENDER_TYPES.has(classType)

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
  download(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }>
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
  timeouts: { imageMs: number; videoMs: number }
  pollDelayMs(attempt: number): number
  reportError(e: unknown, ctx: Record<string, unknown>): void
}

export interface StartRunInput {
  userId: string | null
  takes: unknown
  workflow: unknown
  canvasId: string | null
  projectUuid: string | null
  projectName: string | null
}

export interface LegStarted {
  runId: string
  legId: string
  promptIds: string[]
  /** ComfyUI's node_errors for outputs dropped because they fail validation (present only then). */
  nodeErrors?: Record<string, ComfyNodeError>
}
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

/** Larger than this, the workflow is not stored (Open workflow then falls back, with its toast). */
export const MAX_STORED_WORKFLOW_CHARS = 2_000_000
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
          for (const t of r.takes) for (const n of Object.values(t.nodes)) if (n.switchedFrom?.requestId === requestId) delete n.switchedFrom.cancelUrl
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
  async function submitRequest(run: RunRecord, rec: NodeRecord, provider: RunnerProvider, signal: AbortSignal): Promise<PendingRequest> {
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
    run: RunRecord, rec: NodeRecord, backup: ProviderBackup, from: NonNullable<NodeRecord['switchedFrom']>,
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

  // ── Opening a leg: price, hold, write down ─────────────────────────────
  async function openLeg(run: RunRecord, action: LegAction, gateId: string | null, takeIdx: number[]): Promise<LegRecord> {
    const index = run.legs.length
    const legId = `${run.id}.${index}`
    const charges: StageCharge[] = []
    // The switches this leg's hold is priced with, written down on the leg:
    // a node whose model depends on one that changes before its turn is refused then (switches.ts).
    const families = deps.families?.() ?? NO_FAMILIES
    try {
      for (const t of takeIdx) {
        const take = run.takes[t]!
        const nodes = legNodes(take.prompt, gateStateOf(take))
        // Every take's hold covers the render credit (a hold is an upper bound);
        // which take actually pays it is only known once one makes something.
        const includesBase = !run.baseCharged && hasOutputNode(take.prompt)
        let estimate: number
        // Media nodes (sync-3, Topaz) hold the price of what the start of the run measured (TakeRecord.measured); none, the ceiling.
        try { estimate = stageEstimate(take.prompt, nodes, includesBase, families, take.measured) }
        catch (e) {
          if (e instanceof UnpricedGraphError) throw refuse('A model in this workflow has no price yet', 500)
          throw e
        }
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
    }

    // Charge exactly what was made (reused results are free); the flat
    // render credit rides on the first stage that makes something — a
    // finished Frame render counts, as the Python path charges it. The
    // check and the set below must stay together, with no await between.
    // Everything this take ran in this leg counts, including nodes that
    // finished before a restart (legNodes above no longer lists those).
    const legIds = stageNodeIds(take, charge, leg.index)
    let actual = legIds
      .filter(id => take.nodes[id]!.status === 'done' && !take.nodes[id]!.reused)
      .reduce((s, id) => s + take.nodes[id]!.credits, 0)
    const rendered = legIds.some(id => take.nodes[id]!.status === 'done' && LOCAL_RENDER_TYPES.has(take.nodes[id]!.classType))
    if (charge.includesBase && (actual > 0 || rendered) && !run.baseCharged) {
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
    // Which service made each result, so a switched job's cost can be checked later.
    const servedBy: Record<string, RunnerProvider> = {}
    for (const id of legIds) {
      const rec = take.nodes[id]!
      // A node that handed its picture on (no call, so no endpoint) made nothing new.
      if (rec.status === 'done' && !rec.reused && rec.endpoint !== null && PROVIDER_TYPES.has(rec.classType)) {
        outputs.push(...rec.outputs.filter(f => f.type === 'output'))
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
    try {
      if (signal.aborted) throw new RunStopped()
      const resuming = rec.status === 'running' && !!rec.request
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
        if (!p) { p = deps.results.read(f); reads.set(key, p) }
        return p
      }
      // Resuming a request already sent before a restart (F22 fix round 2):
      // nothing is measured, checked or handed off again, and the credits
      // written down at submit stand. The job is running (and billing) at the
      // service; a file changed since can't refuse it now.
      // The size of the picture a size-priced node is sent, measured before
      // anything is handed off: a picture above the input cap (any
      // size-priced node: FLUX.2 edit, Rotate camera on 2511;
      // requestRules.ts) fails the node here, before the hand-off or the
      // call; its hold is released.
      const inputPixels = resuming ? undefined : await measuredInputPixels(take.prompt[id]!, ([from]) => take.nodes[from]?.outputs ?? [], readOnce, families)
      const tooLarge = measuredInputProblem(take.prompt[id]!.class_type, inputPixels, families, take.prompt[id]!.inputs ?? {})
      if (tooLarge) throw new Error(tooLarge)
      // A file its model refuses (Product shot on Bria: over 12 MB, or not
      // JPEG, PNG or WebP; HappyHorse 1.1: over 20 MB; requestRules.ts),
      // before the hand-off; one too large by its size on disk is refused
      // before it is read. Reads nothing for any other node. The size read
      // goes to planNode, which drops a backup that can't take it.
      const fileCheck = resuming ? { problem: null } as Awaited<ReturnType<typeof linkedFileCheck>> : await linkedFileCheck(take.prompt[id]!, ([from]) => take.nodes[from]?.outputs ?? [], readOnce, families, f => deps.results.size?.(f) ?? Promise.resolve(null))
      if (fileCheck.problem) throw new Error(fileCheck.problem)
      // A media node (./nodeMedia.ts: sync-3 lip-sync, F22; Topaz video
      // upscale, F23): its files read and measured again now, before the
      // hand-off. A file that no longer fits fails the node here (its hold is
      // released); what is measured is what it is planned and charged on.
      let inputSeconds: InputSeconds | undefined
      const media = resuming ? null : await nodeMediaCheck(take.prompt, id, {
        read: readOnce, size: f => deps.results.size?.(f) ?? Promise.resolve(null), strict: deps.hosted(), filesFrom: ([from]) => take.nodes[from]?.outputs ?? [],
      })
      if (media) {
        if (media.problem !== null) throw new Error(media.problem)
        // The tight hold (F22 fix round 1): the files must be the ones the start
        // of the run measured and held for, and cost no more.
        const recorded = take.measured && Object.prototype.hasOwnProperty.call(take.measured, id) ? take.measured[id] : undefined
        if (recorded && (measuredMediaChanged(recorded, media.measured)
          || nodeCredits(take.prompt[id]!, undefined, families, media.measured.seconds) > nodeCredits(take.prompt[id]!, undefined, families, recorded.seconds))) {
          throw new Error(nodeMediaChangedWords(take.prompt[id]))
        }
        inputSeconds = media.measured.seconds
      }
      // What planning reads of the media (Topaz sets its factor from the video's
      // size): this turn's measurement, or on resume the one recorded at the
      // start of the run, so the resumed plan (kept only for its backup) can be
      // rebuilt and the node keeps its request and credits (F23 fix round 1).
      const planMeasured = inputSeconds
        ?? (resuming && take.measured && Object.prototype.hasOwnProperty.call(take.measured, id) ? take.measured[id]!.seconds : undefined)

      const planWith = (toUrl: (f: OutputFile) => Promise<string>) => planNode({
        prompt: take.prompt,
        nodeId: id,
        filesFrom: ([from]) => take.nodes[from]?.outputs ?? [],
        toUrl,
        gateOpen: take.openGates.includes(id),
        readFile: readOnce,
        hosted: deps.hosted(),
        families,
        ...(fileCheck.bytes !== undefined ? { inputBytes: fileCheck.bytes } : {}),
        ...(planMeasured ? { measured: planMeasured } : {}),
      })
      const handOff = async (f: OutputFile) => deps.handoff.toUrlBytes(f, await readOnce(f))
      // Resuming: the request written down is kept (and its price); the plan is
      // rebuilt only for its backup. If it can't be rebuilt now (a file gone),
      // the node carries on waiting for its job, with no backup.
      let resumedWithoutBackup = false
      let plan: Awaited<ReturnType<typeof planNode>>
      if (!resuming) plan = await planWith(handOff)
      else {
        try { plan = await planWith(handOff) }
        catch {
          resumedWithoutBackup = true
          try { plan = await planWith(async () => '') }
          catch (e) {
            // The plan can't be rebuilt at all now (its rules changed since
            // the request was sent, or what it was planned from is gone): the
            // job sent before the restart is cancelled before the node fails,
            // so no provider job is left running and billing (F23 re-review
            // minor 1; final fix F12). The node's hold is released.
            if (rec.request) await confirmCancel(run, rec.request)
            throw e
          }
        }
      }
      // The files' bytes are not kept for the provider wait (up to 30 minutes).
      reads.clear()
      // Rendered here (the Frame): no provider, no charge, not an asset.
      if (plan.kind === 'local') {
        const bytes = await plan.render(signal)
        if (signal.aborted) throw new RunStopped()
        const file = await deps.results.saveLivePreview(bytes, { nodeId: id, userId: run.userId })
        rec.outputs = [file]
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
      const backupSettings = deps.backup?.() ?? { enabled: false, stallMs: 0 }
      const backup = backupSettings.enabled && plan.backup && !resumedWithoutBackup ? plan.backup : null
      // Priced on the measured picture where the price depends on its size
      // (FLUX.2 edit; Rotate camera on 2511), and on the measured media where
      // it depends on them (sync-3 lip-sync; Topaz video upscale), measured
      // before planning.
      if (!resuming) rec.credits = nodeCredits(take.prompt[id]!, inputPixels, families, inputSeconds)
      const fp = resuming
        ? rec.fingerprint
        : isReusable(plan.payload)
          ? requestFingerprint(fingerprintEndpoint(plan.provider, plan.endpoint), plan.payload, u => deps.handoff.hashOf(u))
          : null
      rec.fingerprint = fp

      if (fp && !rec.request) {
        const prior = await deps.store.getResult(userKey, fp)
        if (prior?.length && (await Promise.all(prior.map(f => deps.results.exists(f)))).every(Boolean)) {
          for (const f of prior) await deps.metering.addOutput(run.userId, stageKey, f)
          rec.outputs = prior
          rec.reused = true
          rec.status = 'done'
          rec.endedAt = deps.now()
          await persist(run)
          const ui = plan.uiFor(prior)
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
        result = await waitForResult(run, rec, stageKey, id, plan.media, signal, backup, backupSettings.stallMs)
      }
      finally {
        limiter.release(userKey)
      }

      const urls = clientFor(providerOf(rec.request!)).outputUrls(result, plan.media)
      if (!urls.length) throw new Error(plan.media === 'image' ? 'The provider returned no image' : 'The provider returned no video')
      const files: OutputFile[] = []
      for (const url of urls) {
        const { bytes, contentType } = await deps.download(url)
        const file = await deps.results.save(bytes, {
          userId: run.userId, prefix: plan.prefix, ext: extFor(contentType, url, plan.media === 'image' ? 'png' : 'mp4'),
        })
        await deps.metering.addOutput(run.userId, stageKey, file)
        files.push(file)
      }
      rec.outputs = files
      rec.status = 'done'
      rec.servedBy = providerOf(rec.request!)
      rec.endedAt = deps.now()
      if (fp) await deps.store.putResult(userKey, fp, files).catch(e => deps.reportError(e, { site: 'runner.putResult' }))
      // Made on the backup: also filed under the backup's own request, so the same settings reuse it either way.
      if (rec.switchedFrom && rec.payload && isReusable(rec.payload)) {
        const backupFp = requestFingerprint(fingerprintEndpoint(rec.servedBy, rec.endpoint!), rec.payload, u => deps.handoff.hashOf(u))
        if (backupFp !== fp) await deps.store.putResult(userKey, backupFp, files).catch(e => deps.reportError(e, { site: 'runner.putResult' }))
      }
      // The result is made, kept and billed: a failed save here must not turn
      // the node into an error. The stage's closing save writes it down again.
      await persist(run).catch(e => deps.reportError(e, { site: 'runner.node.save', stageKey, node: id }))
      const ui = plan.uiFor(files)
      if (ui) publish(run, ev.executed(stageKey, id, ui))
    }
    catch (e) {
      if (e instanceof RunStopped || signal.aborted) {
        rec.status = 'stopped'
        rec.error = null
        // Stop may have landed while this request was being sent, before
        // Stop could see its id: cancel it here so nothing is left running.
        if (rec.request) await confirmCancel(run, rec.request, { tries: 1 })
      }
      else { rec.status = 'error'; rec.error = plainError(e) }
      rec.endedAt = deps.now()
      await persist(run).catch(() => {})
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

  async function waitForResult(
    run: RunRecord, rec: NodeRecord, stageKey: string, nodeId: string, media: 'image' | 'video', signal: AbortSignal,
    backup: ProviderBackup | null = null, stallMs = 0,
  ): Promise<unknown> {
    let req = rec.request!
    let provider = providerOf(req)
    let client = clientFor(provider)
    // Set once the first service has been asked to give the job up and kept it: no second try.
    let keepFirst = false
    const limitMs = media === 'video' ? deps.timeouts.videoMs : deps.timeouts.imageMs
    let deadline = req.submittedAt + limitMs
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
      // The limit runs from the current request's send: after a switch to the
      // backup it starts again, so a node's total wait can reach the stall
      // time plus the limit. The message speaks of the service, so it stays true.
      if (asked && deps.now() > deadline) {
        const check = await confirmCancel(run, req)
        // It finished just as it was cancelled: the result is made and billed, so it is kept.
        if (check.confirmed && check.ended === 'finished' && check.status) {
          if (provider === 'replicate' && check.status.raw != null) return check.status.raw
          try { return await client.result(req.responseUrl) }
          catch { /* not fetchable: fail as a time-out */ }
        }
        const late = media === 'video'
          ? 'The service took more than 30 minutes to make this video'
          : 'The service took more than 5 minutes to make this image'
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
      if (attempt > 0 && deps.now() > deadline + GRACE_MS) {
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
              deadline = req.submittedAt + limitMs
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
            deadline = req.submittedAt + limitMs
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
            if (isQueuedWork(rec.classType) && (rec.status === 'waiting' || rec.status === 'running')) n++
          }
        }
      }
    }
    return n
  }

  async function startRun(i: StartRunInput): Promise<LegStarted> {
    const takes = i.takes
    if (!Array.isArray(takes) || !takes.length) throw refuse('There is nothing to run', 400)
    if (takes.length > deps.maxTakes) throw refuse(`At most ${deps.maxTakes} versions can run at once`, 400)
    // The server's families decide; a browser that disagrees is refused, with
    // a marker it reads as "run this on ComfyUI instead" (isRunnerDeclined).
    const families = deps.families?.() ?? NO_FAMILIES
    // ComfyUI's validate_prompt first: outputs that fail validation are
    // dropped with what only they need (shared/runner/validate.ts); the rest
    // is what runs, is checked, priced and held. Nothing of a dropped node runs.
    const prompts: ApiPrompt[] = []
    let nodeErrors: Record<string, ComfyNodeError> | undefined
    for (const p of takes) {
      if (!p || typeof p !== 'object') throw refuse('This workflow can’t run on the Sailor runner', 400, { reason: RUNNER_NOT_ELIGIBLE })
      const pruned = pruneInvalidOutputs(p as ApiPrompt, families)
      // ComfyUI: "Prompt outputs failed validation". No marker: ComfyUI would refuse it too.
      if (pruned.failed) throw refuse(NO_VALID_OUTPUTS_MESSAGE, 400, { node_errors: pruned.nodeErrors })
      if (!isRunnerEligible(pruned.prompt, families, { hosted: deps.hosted(), afterPruning: pruned.dropped.length > 0 })) {
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
      const problem = requestProblems(p, { runner: true })[0]
      if (problem) throw refuse(problem.message, 400, { nodeId: problem.nodeId, classType: problem.classType })
    }
    // Fail closed on price, before anything is held: a provider node that
    // prices at 0 (a class the price book misses by name) never runs free.
    if (deps.hosted()) {
      for (const p of prompts) {
        let unpriced: string | null
        try { unpriced = unpricedProviderNode(p, undefined, n => nodeCredits(n, undefined, families)) }
        catch (e) {
          if (e instanceof UnpricedGraphError) throw refuse('A model in this workflow has no price yet', 500)
          throw e
        }
        if (unpriced != null) throw refuse('This step has no price yet, so it can’t run', 500, { nodeId: unpriced, classType: p[unpriced]!.class_type })
      }
    }
    const noGates: TakeGateState = { done: new Set(), open: new Set(), dropped: new Set() }
    const wanted = prompts.reduce((n, p) => n + [...legNodes(p, noGates)].filter(id => isQueuedWork(p[id]!.class_type)).length, 0)
    if (queuedCalls(i.userId) + wanted > MAX_QUEUED_CALLS) throw refuse('You have too many runs waiting. Try again when one finishes.', 429)
    await deps.metering.spendGuard(i.userId)
    const files = new Map<string, OutputFile>()
    for (const p of prompts) for (const f of collectInputFiles(p)) files.set(`${f.type}:${f.subfolder}:${f.filename}`, f)
    await assertFilesOwned([...files.values()], i.userId, deps.hosted(), deps.ownership)
    // Seedance 2.0 references: at most 15 s of video and 15 s of sound in all,
    // measured from their input files; hosted refuses one it can't measure
    // (S1b fix round 2). Loaded here so this change stays in one place.
    const { runnerReferenceProblems } = await import('../utils/graphInputSeconds')
    const tooLong = await runnerReferenceProblems(prompts, {
      readFile: f => deps.results.read(f), strict: deps.hosted(),
      assertOwned: fs => assertFilesOwned(fs, i.userId, deps.hosted(), deps.ownership),
    })
    if (tooLong) throw refuse(tooLong.message, 400, { nodeId: tooLong.nodeId, classType: tooLong.classType })
    // Media nodes (./nodeMedia.ts: sync-3 lip-sync, F22; Topaz video upscale,
    // F23): their files must be the caller's own (hosted), and the model must
    // be able to take them: read and measured now, before anything is held.
    // The node's turn reads them again. What was measured is recorded on the
    // take (the tight hold, F22 fix round 1).
    const measured: Record<string, MeasuredMedia>[] = prompts.map(() => ({}))
    for (const [index, p] of prompts.entries()) {
      for (const [nodeId, n] of Object.entries(p)) {
        if (!mediaNodeKind(n)) continue
        await assertFilesOwned(nodeMediaFiles(p, nodeId), i.userId, deps.hosted(), deps.ownership)
        const media = await nodeMediaCheck(p, nodeId, {
          read: f => deps.results.read(f), size: f => deps.results.size?.(f) ?? Promise.resolve(null), strict: deps.hosted(),
        })
        if (!media) continue
        if (media.problem !== null) throw refuse(media.problem, 400, { nodeId, classType: n.class_type })
        measured[index]![nodeId] = media.measured
      }
    }
    // A Frame's baked layers and masks are files the browser uploaded just
    // before: one that is gone fails now, before anything runs or is charged.
    for (const f of loadImageFiles(prompts)) {
      if (!(await deps.results.exists(f))) throw refuse('A picture this Frame needs is missing. Run it again.', 400, { file: f.filename })
    }
    await deps.metering.moderate(prompts)

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
      takes: prompts.map((prompt, index) => ({
        index,
        prompt: JSON.parse(JSON.stringify(prompt)) as ApiPrompt,
        nodes: Object.fromEntries(Object.entries(prompt).map(([id, n]) => [id, emptyNodeRecord(n.class_type)])),
        openGates: [],
        droppedGates: [],
        ...(Object.keys(measured[index]!).length ? { measured: measured[index] } : {}),
      })),
      legs: [],
      charges: [],
      baseCharged: false,
      stopRequested: false,
    }
    const leg = await openLeg(run, 'run', null, run.takes.map(t => t.index))
    await persist(run)
    launch(run, leg)
    return { runId: run.id, legId: leg.id, promptIds: leg.takes.map(t => stageKeyOf(leg.id, t)), ...(nodeErrors ? { nodeErrors } : {}) }
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
      await deps.metering.moderate(legTakes.map(t => draft.takes[t]!.prompt))
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
          if (n.status === 'running' && n.request) cancels.push(confirmCancel(e.run, n.request, { tries: 1 }))
          // A first job whose cancel was never confirmed after a switch is cancelled too.
          const first = n.status === 'running' ? n.switchedFrom : undefined
          if (first?.cancelUrl && first.requestId) {
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
    for (const run of await deps.store.listActive()) {
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

  return { startRun, gateAction, stop, reattach, nudge, pausedGates, snapshot, record, settled, cancelChecksSettled, events: deps.events }
}

export type Engine = ReturnType<typeof createEngine>
