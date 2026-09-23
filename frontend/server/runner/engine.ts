/**
 * The Sailor runner. A run is a written-down to-do list: every node's state
 * is saved before and after each outside call, so a restarted server reads
 * the list back and carries on (reattach). A leg runs every node it can
 * reach, in parallel where the graph allows, until each take has finished,
 * failed or paused at a Gate. Money is held per take before a leg starts and
 * charged exactly when it ends. See docs/superpowers/specs/2026-09-22-sailor-runner-and-gate-design.md.
 */
import { isRunnerEligible } from '#shared/runner/eligibility'
import {
  GATE_CLASS, dependenciesOf, downstreamNodes, legNodes, upstreamStage,
  type ApiPrompt, type TakeGateState,
} from '#shared/runner/graph'
import type { GateChoice, RunnerMessage } from '#shared/runner/messages'
import { MeterRefusalError } from '../utils/requestMeter'
import { BASE_RENDER_CREDITS, UnpricedGraphError } from '../utils/priceBook'
import { extractGraphPromptText } from '../utils/graphPromptText'
import { falImageUrls, falVideoUrl, percentFromLogs, type FalClient } from './falQueue'
import { planNode } from './executors'
import { isReusable, requestFingerprint } from './fingerprint'
import { assertFilesOwned, collectInputFiles, type OwnershipCheck } from './inputs'
import { hasOutputNode, nodeCredits, stageEstimate, type Metering } from './metering'
import { ev, type RunEvents } from './events'
import type { Handoff } from './handoff'
import { extFor, type ResultStore } from './results'
import { runIdOf, userKeyOf, type RunStore } from './store'
import {
  emptyNodeRecord, stageKeyOf,
  type LegAction, type LegRecord, type NodeRecord, type OutputFile, type RunRecord, type RunStatus,
  type StageCharge, type TakeRecord,
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
  fal: FalClient
  results: ResultStore
  handoff: Handoff
  metering: Metering
  events: RunEvents
  ownership: OwnershipCheck
  records: { write(s: StageRecordSummary): Promise<void> }
  download(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }>
  hosted(): boolean
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

const GENERATORS = new Set(['GenerateImageNode', 'GenerateVideoNode'])
const refuse = (message: string, status: number, data?: unknown) => new MeterRefusalError(message, status, data)

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

export function createEngine(deps: EngineDeps) {
  const live = new Map<string, LiveRun>()
  const locks = new Map<string, Promise<unknown>>()
  const wakers = new Map<string, () => void>()
  const limiter = createLimiter(deps.perUserLimit)
  const publish = (run: RunRecord, m: RunnerMessage) => deps.events.publish(userKeyOf(run.userId), m)

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
    let baseAssigned = false
    try {
      for (const t of takeIdx) {
        const take = run.takes[t]!
        const nodes = legNodes(take.prompt, gateStateOf(take))
        const includesBase = !run.baseCharged && !baseAssigned && hasOutputNode(take.prompt)
        if (includesBase) baseAssigned = true
        let estimate: number
        try { estimate = stageEstimate(take.prompt, nodes, includesBase) }
        catch (e) {
          if (e instanceof UnpricedGraphError) throw refuse('A model in this workflow has no price yet', 500)
          throw e
        }
        const stageKey = stageKeyOf(legId, t)
        const holdId = await deps.metering.hold(run.userId, stageKey, estimate)
        charges.push({ stageKey, leg: index, take: t, estimate, includesBase, holdId, state: holdId == null ? 'free' : 'held', actual: null, finished: false })
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
    if (e.ctl.signal.aborted) e.ctl = new AbortController()
    const signal = e.ctl.signal
    e.legPromise = runLeg(run, leg, signal).catch((err) => {
      deps.reportError(err, { site: 'runner.leg', runId: run.id, legId: leg.id })
    })
  }

  // ── Running a leg ──────────────────────────────────────────────────────
  async function runLeg(run: RunRecord, leg: LegRecord, signal: AbortSignal): Promise<void> {
    const outcomes = await Promise.all(leg.takes.map(t => runTakeLeg(run, run.takes[t]!, leg, signal)))
    leg.status = 'done'
    leg.endedAt = deps.now()
    const gates = pausedChoices(run)
    let status: RunStatus
    if (gates.size) status = 'paused'
    else if (run.stopRequested || outcomes.includes('stopped')) status = 'stopped'
    else if (outcomes.length && outcomes.every(o => o === 'error')) status = 'error'
    else status = 'done'
    run.status = status
    await persist(run)
    for (const [gateId, choices] of gates) {
      publish(run, ev.gatePaused(leg.id, run.id, gateId, choices, choices.length === 1 ? [choices[0]!.take] : []))
    }
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
    // render credit rides on the first stage that makes something.
    const legIds = [...nodes]
    let actual = legIds
      .filter(id => take.nodes[id]!.status === 'done' && !take.nodes[id]!.reused)
      .reduce((s, id) => s + take.nodes[id]!.credits, 0)
    if (charge.includesBase && actual > 0) {
      actual += BASE_RENDER_CREDITS
      run.baseCharged = true
    }
    try { await deps.metering.finish(run.userId, charge, actual) }
    catch (e) {
      charge.finished = true
      deps.reportError(e, { site: 'runner.finish', stageKey, actual })
    }
    await persist(run)

    const outcome = takeOutcome(take, leg.index)
    const credits = deps.hosted() ? (charge.actual ?? 0) : null
    const outputs: OutputFile[] = []
    for (const id of legIds) {
      const rec = take.nodes[id]!
      if (rec.status === 'done' && GENERATORS.has(rec.classType)) outputs.push(...rec.outputs.filter(f => f.type === 'output'))
    }
    if (outputs.length) {
      const nodeTypes = [...new Set(legIds.filter(id => take.nodes[id]!.status === 'done').map(id => take.nodes[id]!.classType))]
      await deps.records.write({ run, take, leg, charge, outputs, nodeTypes, ts: deps.now() })
        .catch(e => deps.reportError(e, { site: 'runner.record', stageKey }))
    }
    if (outcome === 'error') {
      const [id, rec] = Object.entries(take.nodes).find(([i, n]) => nodes.has(i) && n.status === 'error')!
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
      })
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
      const fp = isReusable(plan.payload) ? requestFingerprint(plan.endpoint, plan.payload, u => deps.handoff.hashOf(u)) : null
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
        if (!rec.request) {
          const sub = await deps.fal.submit(plan.endpoint, plan.payload, { webhookUrl: deps.webhookUrl() })
          rec.request = {
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

      const urls = plan.media === 'image' ? falImageUrls(result) : [falVideoUrl(result)].filter((u): u is string => !!u)
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
      await persist(run)
      const ui = plan.uiFor(files)
      if (ui) publish(run, ev.executed(stageKey, id, ui))
    }
    catch (e) {
      if (e instanceof RunStopped || signal.aborted) { rec.status = 'stopped'; rec.error = null }
      else { rec.status = 'error'; rec.error = plainError(e) }
      rec.endedAt = deps.now()
      await persist(run).catch(() => {})
    }
  }

  async function waitForResult(run: RunRecord, rec: NodeRecord, stageKey: string, nodeId: string, media: 'image' | 'video', signal: AbortSignal): Promise<unknown> {
    const req = rec.request!
    const deadline = req.submittedAt + (media === 'video' ? deps.timeouts.videoMs : deps.timeouts.imageMs)
    let attempt = 0
    let lastPos: number | null = req.queuePosition
    let lastPct = -1
    let started = false
    if (lastPos != null && lastPos > 0) publish(run, ev.queuePosition(stageKey, nodeId, lastPos))
    for (;;) {
      if (signal.aborted) throw new RunStopped()
      if (deps.now() > deadline) {
        await deps.fal.cancel(req.cancelUrl).catch(() => {})
        throw new Error(media === 'video'
          ? 'The video took longer than 30 minutes, so it was cancelled'
          : 'The image took longer than 5 minutes, so it was cancelled')
      }
      const s = await deps.fal.status(req.statusUrl, { logs: started })
      if (!s.transient) {
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
          if (s.error) throw new Error(s.error)
          return await deps.fal.result(req.responseUrl)
        }
        else {
          throw new Error(`The provider stopped this request (${s.status})`)
        }
      }
      await sleepOrWake(deps.pollDelayMs(attempt++), req.requestId, signal)
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────
  async function startRun(i: StartRunInput): Promise<LegStarted> {
    const takes = i.takes
    if (!Array.isArray(takes) || !takes.length) throw refuse('There is nothing to run', 400)
    if (takes.length > deps.maxTakes) throw refuse(`At most ${deps.maxTakes} versions can run at once`, 400)
    for (const p of takes) {
      if (!p || typeof p !== 'object' || !isRunnerEligible(p as ApiPrompt)) throw refuse('This workflow can’t run on the Sailor runner', 400)
    }
    const prompts = takes as ApiPrompt[]
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
      workflow: i.workflow ?? null,
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

  // Task 13 fills in gateAction, stop, reattach, pausedGates, snapshot and record.
  return { startRun, nudge, settled, events: deps.events }
}

export type Engine = ReturnType<typeof createEngine>
