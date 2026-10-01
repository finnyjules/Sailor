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
 * - `run(prompt, nodeIds)`: asks the canvas's cost-confirm gate on the quoted
 *   price (AppRunCancelled when the person says no), opens the event stream, starts the run with no
 *   canvas, and waits for each listed node's output (awaitRunnerOutputs). A
 *   runner that says no sets `declined` and throws AppRunDeclined.
 * - `stop()`: stops this run only (stopRunnerRuns); the wait then rejects with
 *   AppRunStopped.
 */
import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'
import type { ApiPrompt } from '#shared/runner/graph'
import { ensureRunnerEvents } from '~/composables/useRunnerEvents'
import { isRunnerDeclined, startRunnerRun, stopRunnerRuns, type LegStarted } from '~/lib/runner/client'
import { awaitRunnerOutputs, type AwaitOutputsOptions, type RunnerNodeOutput } from '~/lib/runner/awaitRunnerResult'
import { requestCostConfirm } from '~/lib/costConfirmRequest'
import type { CostEstimate } from '~/lib/costEstimate'

/** The quote route's answer (server/api/runs/quote.post.ts). */
export type AppQuote = { usd: number, credits: number, upTo: boolean } | { declined: true } | { refused: string }
export interface AppPrice { usd: number, credits: number, upTo: boolean }

/** The runner won't take this workflow (off, or a family off): the app falls back or says it is switched off. */
export class AppRunDeclined extends Error {
  constructor() { super('This app is switched off right now.'); this.name = 'AppRunDeclined' }
}

/** The person said no at the cost-confirm gate: nothing was started. */
export class AppRunCancelled extends Error {
  constructor() { super('Cancelled.'); this.name = 'AppRunCancelled' }
}

export interface AppRunDeps {
  /** The canvas's cost-confirm gate (layouts/default.vue): true to go ahead; below its threshold, true at once. */
  confirm(estimate: CostEstimate): Promise<boolean>
  postQuote(body: { takes: ApiPrompt[] }): Promise<AppQuote>
  start(body: Parameters<typeof startRunnerRun>[0]): Promise<LegStarted>
  stop(runIds: string[]): Promise<void>
  ensureEvents(): Promise<void>
}

const realDeps: AppRunDeps = {
  confirm: requestCostConfirm,
  postQuote: body => $fetch<AppQuote>('/api/runs/quote', { method: 'POST', body }),
  start: startRunnerRun,
  stop: stopRunnerRuns,
  ensureEvents: ensureRunnerEvents,
}

/** Plain words for a quote that couldn't be had (the route itself failed). */
export const QUOTE_FAILED = 'The price couldn’t be worked out. Try again.'
/** Plain words for too many quotes at once (the route's rate limit). */
export const QUOTE_BUSY = 'Too many price checks at once. Wait a moment.'

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

export function useAppRun(opts: { hosted?: boolean, debounceMs?: number, deps?: Partial<AppRunDeps> } = {}) {
  const deps: AppRunDeps = { ...realDeps, ...opts.deps }
  const hosted = opts.hosted ?? isHostedPage()
  const debounceMs = opts.debounceMs ?? 400

  const price = ref<AppPrice | null>(null)
  const refused = ref<string | null>(null)
  const declined = ref(false)
  const quoting = ref(false)
  const running = ref(false)
  const runId = ref<string | null>(null)
  const priceText = computed(() => appPriceText(price.value, hosted))

  let seq = 0
  /** Stop pressed before the start answered: the run is stopped as soon as its id is known. */
  let stopWanted = false
  let timer: ReturnType<typeof setTimeout> | null = null

  async function ask(prompt: ApiPrompt, mine: number): Promise<void> {
    let answer: AppQuote
    try { answer = await deps.postQuote({ takes: [prompt] }) }
    catch (e) {
      if (mine !== seq) return
      quoting.value = false
      if (isRunnerDeclined(e)) { declined.value = true; price.value = null; refused.value = null; return }
      const status = (e as { statusCode?: number, status?: number } | null)
      price.value = null
      refused.value = (status?.statusCode ?? status?.status) === 429 ? QUOTE_BUSY : QUOTE_FAILED
      return
    }
    if (mine !== seq) return
    quoting.value = false
    if ('declined' in answer) { declined.value = true; price.value = null; refused.value = null }
    else if ('refused' in answer) { declined.value = false; price.value = null; refused.value = answer.refused }
    else { declined.value = false; refused.value = null; price.value = { usd: answer.usd, credits: answer.credits, upTo: answer.upTo } }
  }

  /**
   * The price of `prompt`, asked after a short pause (each change restarts
   * it; only the latest answer lands). Null clears it. Resolves once that
   * answer has landed (or a later call replaced it).
   */
  function quote(prompt: ApiPrompt | null): Promise<void> {
    const mine = ++seq
    if (timer) { clearTimeout(timer); timer = null }
    if (!prompt) {
      quoting.value = false
      price.value = null
      refused.value = null
      return Promise.resolve()
    }
    quoting.value = true
    return new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timer = null
        ask(prompt, mine).finally(resolve)
      }, debounceMs)
    })
  }

  /** Runs `prompt` and waits for each of `nodeIds`' outputs, by node id. */
  async function run(prompt: ApiPrompt, nodeIds: readonly string[], o: AwaitOutputsOptions = {}): Promise<{ promptId: string, outputs: Record<string, RunnerNodeOutput> }> {
    running.value = true
    runId.value = null
    stopWanted = false
    try {
      // The canvas's gate, on the quoted figure (the hold): above its threshold the person confirms first.
      const p = price.value
      if (p && p.credits > 0) {
        const ok = await deps.confirm({
          usd: p.usd, approximate: p.upTo, hostedCredits: hosted ? p.credits : null,
          breakdown: [{ id: 'app', label: 'This run', usd: p.usd, ...(p.upTo ? { upTo: true as const } : {}) }],
        })
        if (!ok) throw new AppRunCancelled()
      }
      await deps.ensureEvents()
      // The wait is attached before the start answers: the leg's first events can land before it does.
      const leg = deps.start({ takes: [prompt], workflow: null, canvasId: null, projectUuid: null, projectName: null })
        .then((l) => {
          runId.value = l.runId
          if (stopWanted) void deps.stop([l.runId])
          return l
        })
      const idPromise = leg.then(l => l.promptIds[0] ?? Promise.reject(new Error('This didn’t start. Try again.')))
      const waiting = awaitRunnerOutputs(idPromise, nodeIds, o)
      try {
        const outputs = await waiting
        return { promptId: await idPromise, outputs }
      }
      catch (e) {
        if (isRunnerDeclined(e)) { declined.value = true; throw new AppRunDeclined() }
        throw e
      }
    }
    finally {
      running.value = false
    }
  }

  /** Stops this app's run (only it). */
  async function stop(): Promise<void> {
    if (runId.value) await deps.stop([runId.value])
    else if (running.value) stopWanted = true
  }

  if (getCurrentScope()) onScopeDispose(() => { if (timer) clearTimeout(timer) })

  return { price, priceText, refused, declined, quoting, running, runId, quote, run, stop }
}
