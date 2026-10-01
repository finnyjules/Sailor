/**
 * A mini app's run on the Sailor runner (step 3, R8.0): its price before the
 * run, the run itself, the wait for its files, and Stop. Every app in
 * components/apps sends its workflow through this helper only (R8 rule 1).
 *
 * - `quote(prompt)`: asks POST /api/runs/quote (the start's own checks and
 *   hold calculation, nothing held) for the price, debounced, latest wins.
 *   `price` holds the answer, `priceText` shows it in the node badge's
 *   format (dollars here, credits in hosted, "up to" when held on a bound),
 *   `refused` holds a refusal's plain words (the run button stays off), and
 *   `declined` is set when the runner won't take the workflow (ruling (d)).
 * - `run(prompt, nodeIds)`: prices exactly this prompt (a fresh quote for
 *   it, or a new one; a refusal or failed check starts nothing), asks the
 *   canvas's cost-confirm gate on that figure (AppRunCancelled on "no"),
 *   opens the event stream, starts the run with no canvas, and waits for each
 *   listed node's output (awaitRunnerOutputs). A runner that says no sets
 *   `declined` and throws AppRunDeclined. A wait that gives up stops the run.
 * - `stop()`: stops this run only (/api/runs/stop); the wait then rejects with
 *   AppRunStopped. A Stop that didn't go through sets `stopError`.
 * - Closing the app mid-run stops its run and drops its listener.
 */
import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'
import type { ApiPrompt } from '#shared/runner/graph'
import { ensureRunnerEvents } from '~/composables/useRunnerEvents'
import { isRunnerDeclined, startRunnerRun, stopRunnerRunsOrThrow, type LegStarted } from '~/lib/runner/client'
import { AppRunTimedOut, awaitRunnerOutputs, type AwaitOutputsOptions, type RunnerNodeOutput } from '~/lib/runner/awaitRunnerResult'
import { requestCostConfirm } from '~/lib/costConfirmRequest'
import type { CostEstimate } from '~/lib/costEstimate'

/** The quote route's answer (server/api/runs/quote.post.ts). */
export type AppQuote = { usd: number, credits: number, upTo: boolean } | { declined: true } | { refused: string, reason?: string }
export interface AppPrice { usd: number, credits: number, upTo: boolean }

/** The runner won't take this workflow (off, or a family off): the app falls back or says it is switched off. */
export class AppRunDeclined extends Error {
  constructor() { super('This app is switched off right now.'); this.name = 'AppRunDeclined' }
}

/** The price couldn't be had for the prompt about to run (refused, or the check failed): nothing was started. Its words are the person's. */
export class AppRunRefused extends Error {
  /** The refusal's stable reason code (e.g. RUNNER_SOUND_TOO_LONG), when the start gave one. */
  readonly reason: string | null
  constructor(words: string, reason?: string | null) { super(words); this.name = 'AppRunRefused'; this.reason = reason ?? null }
}

/** The stable reason code a Sailor route's refusal carries (its body's `data.reason`), else null. */
export function reasonOf(e: unknown): string | null {
  const r = (e as { data?: { data?: { reason?: unknown } } } | null)?.data?.data?.reason
  return typeof r === 'string' && r ? r : null
}

/** The person said no at the cost-confirm gate: nothing was started. */
export class AppRunCancelled extends Error {
  constructor() { super('Cancelled.'); this.name = 'AppRunCancelled' }
}

export interface AppRunDeps {
  /** The canvas's cost-confirm gate (layouts/default.vue): true to go ahead; below its threshold, true at once. */
  confirm(estimate: CostEstimate): Promise<boolean>
  postQuote(body: { takes: ApiPrompt[] }, signal?: AbortSignal): Promise<AppQuote>
  start(body: Parameters<typeof startRunnerRun>[0]): Promise<LegStarted>
  /** Rejects when the Stop request didn't go through. */
  stop(runIds: string[]): Promise<void>
  ensureEvents(): Promise<void>
}

const realDeps: AppRunDeps = {
  confirm: requestCostConfirm,
  postQuote: (body, signal) => $fetch<AppQuote>('/api/runs/quote', { method: 'POST', body, signal }),
  start: startRunnerRun,
  stop: stopRunnerRunsOrThrow,
  ensureEvents: ensureRunnerEvents,
}

/** Plain words for a quote that couldn't be had (the route itself failed). */
export const QUOTE_FAILED = 'The price couldn’t be worked out. Try again.'
/** Plain words for too many quotes at once (the route's rate limit). */
export const QUOTE_BUSY = 'Too many price checks at once. Wait a moment.'
/** Plain words for a Stop request that failed. */
export const STOP_FAILED = 'Stop didn’t go through. Try again.'
/** Plain words for a wait that gave up and whose Stop failed: the run may still be going. */
export const TIMED_OUT_STOP_FAILED = 'This took too long, and Stop didn’t go through. Press Stop to try again.'
/** Plain words for a second Run while the first may still be going. */
export const STILL_GOING = 'The last run may still be going. Stop it first.'
/** A quote this recent, for exactly the prompt being run, is confirmed on without asking again. */
export const QUOTE_FRESH_MS = 30_000

/** A prompt's key: its JSON with every object's keys sorted, so the same workflow always matches. */
export function promptKey(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(promptKey).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${promptKey((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

/** The plain words an error from a Sailor route carries (its body's message), else its own. */
export function wordsOf(e: unknown, fallback: string): string {
  const x = e as { data?: { message?: unknown }, message?: unknown } | null
  if (typeof x?.data?.message === 'string' && x.data.message) return x.data.message
  return typeof x?.message === 'string' && x.message && !/^\[(GET|POST)\]/.test(x.message) ? x.message : fallback
}

const statusOf = (e: unknown): number | undefined => {
  const x = e as { statusCode?: number, status?: number, response?: { status?: number } } | null
  return x?.statusCode ?? x?.status ?? x?.response?.status
}

/**
 * A price in the node badge's format (ComfyNode priceLabel): credits in
 * hosted ("12 cr"), dollars here ("$0.05", "<$0.01"), "up to" when held on a
 * bound. The quote is the hold itself, so no "~". Null when the run is free.
 */
export function appPriceText(p: AppPrice | null, hosted: boolean): string | null {
  if (!p || !(p.credits > 0)) return null
  const lead = p.upTo ? 'up to ' : ''
  if (hosted) return `${lead}${p.credits} cr`
  // Locally the credits are the house's; the operator pays the provider dollars (at least a cent's worth shown).
  const usd = p.usd > 0 ? p.usd : p.credits / 100
  return `${lead}${usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`}`
}

function isHostedPage(): boolean {
  try { return useRuntimeConfig().public?.hostedMode === true }
  catch { return false }
}

type QuoteResult = AppQuote | { failed: string }

export function useAppRun(opts: { hosted?: boolean, debounceMs?: number, now?: () => number, deps?: Partial<AppRunDeps> } = {}) {
  const deps: AppRunDeps = { ...realDeps, ...opts.deps }
  const hosted = opts.hosted ?? isHostedPage()
  const debounceMs = opts.debounceMs ?? 400
  const now = opts.now ?? Date.now

  const price = ref<AppPrice | null>(null)
  const refused = ref<string | null>(null)
  /** The refusal's stable reason code, when it has one: apps key on this, never on the words. */
  const refusedReason = ref<string | null>(null)
  /** The price check itself failed (not a refusal): `refused` holds its words, and Run may be pressed to ask again. */
  const quoteFailed = ref(false)
  const declined = ref(false)
  const quoting = ref(false)
  /** True from Run until the run has surely ended: finished, failed, or stopped (a Stop that went through). */
  const running = ref(false)
  const runId = ref<string | null>(null)
  /** Plain words when a Stop request didn't go through (the run may still be going). */
  const stopError = ref<string | null>(null)
  const priceText = computed(() => appPriceText(price.value, hosted))

  let seq = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let quoteCtl: AbortController | null = null
  let lastQuote: { key: string, at: number, answer: AppQuote } | null = null
  /** Stop pressed (or the app closed) before the start answered: the run is stopped as soon as its id is known. */
  let stopWanted = false
  /** The wait of the run under way; aborted when the app closes. */
  let runCtl: AbortController | null = null
  /** run() is still waiting for its run (it clears `running` itself when it ends). */
  let waiting = false

  /** One quote, as the route answers it, or the plain words of why there is none. Aborts are thrown on. */
  async function fetchQuote(prompt: ApiPrompt, signal?: AbortSignal): Promise<QuoteResult> {
    try { return await deps.postQuote({ takes: [prompt] }, signal) }
    catch (e) {
      if (signal?.aborted) throw e
      if (isRunnerDeclined(e)) return { declined: true }
      const status = statusOf(e)
      if (status === 429) return { failed: QUOTE_BUSY }
      // A request the route refused with its own words (a 4xx): those words.
      if (status !== undefined && status >= 400 && status < 500) {
        const reason = reasonOf(e)
        return reason ? { refused: wordsOf(e, QUOTE_FAILED), reason } : { refused: wordsOf(e, QUOTE_FAILED) }
      }
      return { failed: QUOTE_FAILED }
    }
  }

  function show(answer: QuoteResult): void {
    quoting.value = false
    quoteFailed.value = 'failed' in answer
    refusedReason.value = 'refused' in answer ? answer.reason ?? null : null
    if ('declined' in answer) { declined.value = true; price.value = null; refused.value = null }
    else if ('refused' in answer) { declined.value = false; price.value = null; refused.value = answer.refused }
    else if ('failed' in answer) { price.value = null; refused.value = answer.failed }
    else { declined.value = false; refused.value = null; price.value = { usd: answer.usd, credits: answer.credits, upTo: answer.upTo } }
  }

  function remember(prompt: ApiPrompt, answer: QuoteResult): void {
    lastQuote = 'failed' in answer ? null : { key: promptKey(prompt), at: now(), answer }
  }

  /**
   * The price of `prompt`, asked after a short pause (each change restarts
   * it; a quote a later one replaces is aborted, on the server too). Null
   * clears it. Resolves once that answer has landed (or a later call replaced it).
   */
  function quote(prompt: ApiPrompt | null): Promise<void> {
    const mine = ++seq
    if (timer) { clearTimeout(timer); timer = null }
    quoteCtl?.abort()
    quoteCtl = null
    if (!prompt) {
      quoting.value = false
      price.value = null
      refused.value = null
      refusedReason.value = null
      quoteFailed.value = false
      return Promise.resolve()
    }
    quoting.value = true
    return new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timer = null
        const ctl = new AbortController()
        quoteCtl = ctl
        fetchQuote(prompt, ctl.signal).then((answer) => {
          if (mine !== seq) return
          quoteCtl = null
          remember(prompt, answer)
          show(answer)
        }, () => { /* aborted: a later quote replaced it */ }).finally(resolve)
      }, debounceMs)
    })
  }

  /** The quote for exactly `prompt`: a fresh one already in hand, else asked now. */
  async function quoteFor(prompt: ApiPrompt): Promise<QuoteResult> {
    const key = promptKey(prompt)
    if (lastQuote && lastQuote.key === key && now() - lastQuote.at < QUOTE_FRESH_MS) return lastQuote.answer
    const answer = await fetchQuote(prompt)
    remember(prompt, answer)
    // Shown unless a newer quote for another prompt was asked meanwhile.
    if (!timer && !quoteCtl) show(answer)
    return answer
  }

  /** Stops `id`; true when the request went through. Its failure is shown in plain words. */
  async function stopId(id: string): Promise<boolean> {
    try {
      await deps.stop([id])
      stopError.value = null
      return true
    }
    catch {
      stopError.value = STOP_FAILED
      return false
    }
  }

  /**
   * Runs `prompt` and waits for each of `nodeIds`' outputs, by node id.
   * First the price of exactly this prompt (a fresh quote for it, or a new
   * one): a refusal or a failed check starts nothing (AppRunRefused, its
   * words); then the cost-confirm gate on that figure, always asked (below
   * its threshold it says yes at once). A wait that gives up stops the run,
   * as Stop does; until that Stop has gone through, `running` stays true and
   * a second Run is refused.
   */
  async function run(prompt: ApiPrompt, nodeIds: readonly string[], o: AwaitOutputsOptions = {}): Promise<{ promptId: string, outputs: Record<string, RunnerNodeOutput> }> {
    if (running.value) throw new Error(STILL_GOING)
    running.value = true
    waiting = true
    runId.value = null
    stopError.value = null
    stopWanted = false
    let stillGoing = false
    try {
      const answer = await quoteFor(prompt)
      if ('declined' in answer) { declined.value = true; throw new AppRunDeclined() }
      if ('refused' in answer) throw new AppRunRefused(answer.refused, answer.reason)
      if ('failed' in answer) throw new AppRunRefused(answer.failed)
      const ok = await deps.confirm({
        usd: answer.usd, approximate: answer.upTo, hostedCredits: hosted ? answer.credits : null,
        breakdown: [{ id: 'app', label: 'This run', usd: answer.usd, ...(answer.upTo ? { upTo: true as const } : {}) }],
      })
      if (!ok) throw new AppRunCancelled()
      await deps.ensureEvents()
      const ctl = new AbortController()
      runCtl = ctl
      // The wait is attached before the start answers: the leg's first events can land before it does.
      const leg = deps.start({ takes: [prompt], workflow: null, canvasId: null, projectUuid: null, projectName: null })
        .then((l) => {
          runId.value = l.runId
          if (stopWanted) void stopId(l.runId)
          return l
        })
      const idPromise = leg.then(l => l.promptIds[0] ?? Promise.reject(new Error('This didn’t start. Try again.')))
      try {
        const outputs = await awaitRunnerOutputs(idPromise, nodeIds, { ...o, signal: ctl.signal })
        return { promptId: await idPromise, outputs }
      }
      catch (e) {
        if (isRunnerDeclined(e)) { declined.value = true; throw new AppRunDeclined() }
        if (e instanceof AppRunTimedOut) {
          // Gave up waiting: stop the run, as the Stop button does, so nothing keeps going unseen.
          const l = await leg.catch(() => null)
          if (l && !(await stopId(l.runId))) {
            stillGoing = true
            throw new AppRunTimedOut(TIMED_OUT_STOP_FAILED)
          }
          throw e
        }
        // The start's refusal (or a failed start): its own plain words.
        if (!runId.value && !(e instanceof Error && e.name === 'AppRunStopped')) throw new AppRunRefused(wordsOf(e, 'This didn’t start. Try again.'), reasonOf(e))
        throw e
      }
    }
    finally {
      waiting = false
      runCtl = null
      if (!stillGoing) running.value = false
    }
  }

  /** Stops this app's run (only it). A Stop that didn't go through says so (`stopError`). */
  async function stop(): Promise<void> {
    if (runId.value) {
      const ok = await stopId(runId.value)
      // A run whose wait already ended (gave up) is over once its Stop goes through.
      if (ok && !waiting) { running.value = false; runId.value = null }
    }
    else if (running.value) stopWanted = true
  }

  // An app closed mid-run stops its run and lets go of its listener; a pending quote is dropped.
  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (timer) clearTimeout(timer)
      quoteCtl?.abort()
      if (!running.value) return
      runCtl?.abort()
      if (runId.value) void stopId(runId.value)
      else stopWanted = true
    })
  }

  return { price, priceText, refused, refusedReason, quoteFailed, declined, quoting, running, runId, stopError, quote, run, stop }
}
