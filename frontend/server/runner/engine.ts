/**
 * The Sailor runner. A run is a written-down to-do list: every node's state
 * is saved before and after each outside call, so a restarted server reads
 * the list back and carries on (reattach). A leg runs every node it can
 * reach, in parallel where the graph allows, until each take has finished,
 * failed or paused at a Gate. Money is held per take before a leg starts and
 * charged exactly when it ends. See docs/superpowers/specs/2026-09-22-sailor-runner-and-gate-design.md.
 */
import { PROVIDER_TYPES, isRunnerEligible } from '#shared/runner/eligibility'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import {
  GATE_CLASS, dependenciesOf, downstreamNodes, legNodes, upstreamStage,
  type ApiPrompt, type TakeGateState,
} from '#shared/runner/graph'
import { RUNNER_NOT_ELIGIBLE, type GateChoice, type RunnerMessage } from '#shared/runner/messages'
import { MeterRefusalError } from '../utils/requestMeter'
import { BASE_RENDER_CREDITS, UnpricedGraphError } from '../utils/priceBook'
import { extractGraphPromptText } from '../utils/graphPromptText'
import { isProviderNetworkError, percentFromLogs, type FalStatus, type ProviderClient } from './falQueue'
import { planNode } from './executors'
import { isReusable, requestFingerprint } from './fingerprint'
import { assertFilesOwned, collectInputFiles, type OwnershipCheck } from './inputs'
import { extraPromptText, hasOutputNode, nodeCredits, stageEstimate, unpricedProviderNode, type Metering } from './metering'
import { ev, type RunEvents } from './events'
import type { Handoff } from './handoff'
import { extFor, type ResultStore } from './results'
import { runIdOf, userKeyOf, type RunStore } from './store'
import {
  emptyNodeRecord, stageKeyOf,
  type LegAction, type LegRecord, type NodeRecord, type OutputFile, type PendingRequest, type RunRecord, type RunStatus,
  type RunnerProvider, type StageCharge, type TakeRecord,
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

export interface LegStarted { runId: string; legId: string; promptIds: string[] }
export type GateActionName = 'continue' | 'redo' | 'restart'
export interface GateActionInput { userId: string | null; runId: string; gateId: string; action: GateActionName; takes?: number[] }
export interface PausedGate { runId: string; promptId: string; nodeId: string; choices: GateChoice[]; picked: number[] }
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
  async function cancelRequest(req: PendingRequest): Promise<unknown> {
    return clientFor(providerOf(req)).cancel(req.cancelUrl)
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
    try {
      for (const t of takeIdx) {
        const take = run.takes[t]!
        const nodes = legNodes(take.prompt, gateStateOf(take))
        // Every take's hold covers the render credit (a hold is an upper bound);
        // which take actually pays it is only known once one makes something.
        const includesBase = !run.baseCharged && hasOutputNode(take.prompt)
        let estimate: number
        try { estimate = stageEstimate(take.prompt, nodes, includesBase) }
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
    const leg: LegRecord = { index, id: legId, action, gateId, takes: takeIdx, status: 'running', startedAt: deps.now(), endedAt: null }
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
    // render credit rides on the first stage that makes something. The
    // check and the set below must stay together, with no await between.
    // Everything this take ran in this leg counts, including nodes that
    // finished before a restart (legNodes above no longer lists those).
    const legIds = stageNodeIds(take, charge, leg.index)
    let actual = legIds
      .filter(id => take.nodes[id]!.status === 'done' && !take.nodes[id]!.reused)
      .reduce((s, id) => s + take.nodes[id]!.credits, 0)
    if (charge.includesBase && actual > 0 && !run.baseCharged) {
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
    for (const id of legIds) {
      const rec = take.nodes[id]!
      // A node that handed its picture on (no call, so no endpoint) made nothing new.
      if (rec.status === 'done' && !rec.reused && rec.endpoint !== null && PROVIDER_TYPES.has(rec.classType)) outputs.push(...rec.outputs.filter(f => f.type === 'output'))
    }
    if (outputs.length) {
      const nodeTypes = [...new Set(legIds.filter(id => take.nodes[id]!.status === 'done').map(id => take.nodes[id]!.classType))]
      await deps.records.write({ run, take, leg, charge, outputs, nodeTypes, ts: deps.now() })
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

      const plan = await planNode({
        prompt: take.prompt,
        nodeId: id,
        filesFrom: ([from]) => take.nodes[from]?.outputs ?? [],
        toUrl: f => deps.handoff.toUrl(f),
        gateOpen: take.openGates.includes(id),
        readFile: f => deps.results.read(f),
      })
      // Rendered here (the Frame): no provider, no charge, not an asset.
      if (plan.kind === 'local') {
        const bytes = await plan.render()
        if (signal.aborted) throw new RunStopped()
        const file = await deps.results.saveLivePreview(bytes, { nodeId: id })
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

      rec.endpoint = plan.endpoint
      rec.payload = plan.payload
      rec.credits = nodeCredits(take.prompt[id]!)
      const fp = isReusable(plan.payload)
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
          const sub = await clientFor(plan.provider).submit(plan.endpoint, plan.payload, { webhookUrl: webhookFor(plan.provider) })
          rec.request = {
            provider: plan.provider,
            requestId: sub.requestId, statusUrl: sub.statusUrl, responseUrl: sub.responseUrl,
            cancelUrl: sub.cancelUrl, submittedAt: deps.now(), queuePosition: sub.queuePosition,
          }
          await persist(run)
        }
        result = await waitForResult(run, rec, stageKey, id, plan.media, signal)
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
      rec.endedAt = deps.now()
      if (fp) await deps.store.putResult(userKey, fp, files).catch(e => deps.reportError(e, { site: 'runner.putResult' }))
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
        if (rec.request) await cancelRequest(rec.request).catch(() => {})
      }
      else { rec.status = 'error'; rec.error = plainError(e) }
      rec.endedAt = deps.now()
      await persist(run).catch(() => {})
    }
  }

  async function waitForResult(run: RunRecord, rec: NodeRecord, stageKey: string, nodeId: string, media: 'image' | 'video', signal: AbortSignal): Promise<unknown> {
    let req = rec.request!
    const provider = providerOf(req)
    const client = clientFor(provider)
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
      if (asked && deps.now() > deadline) {
        await client.cancel(req.cancelUrl).catch(() => {})
        throw new Error(media === 'video'
          ? 'The video took longer than 30 minutes, so it was cancelled'
          : 'The image took longer than 5 minutes, so it was cancelled')
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
        await client.cancel(req.cancelUrl).catch(() => {})
        throw new Error('The provider did not answer, so the request was cancelled')
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
            if (PROVIDER_TYPES.has(rec.classType) && (rec.status === 'waiting' || rec.status === 'running')) n++
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
    for (const p of takes) {
      if (!p || typeof p !== 'object' || !isRunnerEligible(p as ApiPrompt, families)) {
        throw refuse('This workflow can’t run on the Sailor runner', 400, { reason: RUNNER_NOT_ELIGIBLE })
      }
    }
    const prompts = takes as ApiPrompt[]
    // Fail closed on price, before anything is held: a provider node that
    // prices at 0 (a class the price book misses by name) never runs free.
    if (deps.hosted()) {
      for (const p of prompts) {
        let unpriced: string | null
        try { unpriced = unpricedProviderNode(p) }
        catch (e) {
          if (e instanceof UnpricedGraphError) throw refuse('A model in this workflow has no price yet', 500)
          throw e
        }
        if (unpriced != null) throw refuse('This step has no price yet, so it can’t run', 500, { nodeId: unpriced, classType: p[unpriced]!.class_type })
      }
    }
    const noGates: TakeGateState = { done: new Set(), open: new Set(), dropped: new Set() }
    const wanted = prompts.reduce((n, p) => n + [...legNodes(p, noGates)].filter(id => PROVIDER_TYPES.has(p[id]!.class_type)).length, 0)
    if (queuedCalls(i.userId) + wanted > MAX_QUEUED_CALLS) throw refuse('You have too many runs waiting. Try again when one finishes.', 429)
    await deps.metering.spendGuard(i.userId)
    const files = new Map<string, OutputFile>()
    for (const p of prompts) for (const f of collectInputFiles(p)) files.set(`${f.type}:${f.subfolder}:${f.filename}`, f)
    await assertFilesOwned([...files.values()], i.userId, deps.hosted(), deps.ownership)
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
      })),
      legs: [],
      charges: [],
      baseCharged: false,
      stopRequested: false,
    }
    const leg = await openLeg(run, 'run', null, run.takes.map(t => t.index))
    await persist(run)
    launch(run, leg)
    return { runId: run.id, legId: leg.id, promptIds: leg.takes.map(t => stageKeyOf(leg.id, t)) }
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
          if (n.status === 'running' && n.request) cancels.push(cancelRequest(n.request).catch(() => {}))
        }
      }
      await Promise.all(cancels)
    }
    await Promise.all(targets.map(e => e.legPromise))
    return { stopped: targets.map(e => e.run.id) }
  }

  /** Server start: pick up every run that was mid-leg. Paused runs need nothing. */
  async function reattach(): Promise<number> {
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

  return { startRun, gateAction, stop, reattach, nudge, pausedGates, snapshot, record, settled, events: deps.events }
}

export type Engine = ReturnType<typeof createEngine>
