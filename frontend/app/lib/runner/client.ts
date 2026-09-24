/**
 * Browser side of the Sailor runner: when to use it, and the calls to
 * /api/runs. Every call degrades quietly — a runner hiccup must never take
 * the canvas down.
 */
import type { ApiPrompt } from '#shared/runner/graph'
import type { GateChoice } from '#shared/runner/messages'
import { RUNNER_NOT_ELIGIBLE, isRunnerPromptId } from '#shared/runner/messages'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'

export interface PausedGateView { runId: string; promptId: string; nodeId: string; choices: GateChoice[]; picked: number[] }
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
export interface LegStarted { runId: string; legId: string; promptIds: string[] }

/** `families`: the browser's copy of the switched-on families (the server's list is the authority). */
export function shouldUseRunner(enabled: boolean, prompts: Array<ApiPrompt | null | undefined>, families: ReadonlySet<RunnerFamily> = NO_FAMILIES): boolean {
  return enabled && prompts.length > 0 && prompts.every(p => !!p && isRunnerEligible(p, families))
}

export function runIdOfPrompt(promptId: unknown): string | null {
  if (!isRunnerPromptId(promptId)) return null
  return (promptId as string).split('.')[0]!
}

/** An HTTP 404 from /api/runs: the runner is switched off on the server (the run then goes to ComfyUI). */
export function isRunnerNotFound(e: unknown): boolean {
  const x = e as { statusCode?: unknown; status?: unknown; response?: { status?: unknown } } | null
  return !!x && (x.statusCode === 404 || x.status === 404 || x.response?.status === 404)
}

/**
 * The server's refusal of a workflow it does not take (its families are off,
 * e.g. the browser's NUXT_PUBLIC_RUNNER_FAMILIES lists more than the server's
 * NUXT_RUNNER_FAMILIES): a 400 whose body carries `data.reason: 'not-eligible'`.
 */
export function isRunnerNotEligible(e: unknown): boolean {
  const x = e as { data?: { data?: { reason?: unknown } } } | null
  return x?.data?.data?.reason === RUNNER_NOT_ELIGIBLE
}

/** The runner said no to the whole run before starting it — off, or not taking this workflow: the run goes to ComfyUI as before. */
export function isRunnerDeclined(e: unknown): boolean {
  return isRunnerNotFound(e) || isRunnerNotEligible(e)
}

export function startRunnerRun(body: { takes: ApiPrompt[]; workflow: unknown; canvasId: string | null; projectUuid: string | null; projectName: string | null }): Promise<LegStarted> {
  return $fetch<LegStarted>('/api/runs', { method: 'POST', body })
}

export function runnerGateAction(body: { runId: string; nodeId: string; action: 'continue' | 'redo' | 'restart'; takes?: number[] }): Promise<LegStarted> {
  return $fetch<LegStarted>('/api/runs/gate', { method: 'POST', body })
}

/** Stops the listed runner runs (only those: other tabs' runs keep going). */
export async function stopRunnerRuns(runIds: string[]): Promise<void> {
  if (!runIds.length) return
  try { await $fetch('/api/runs/stop', { method: 'POST', body: { runIds } }) }
  catch (e) { console.warn('[runner] stop failed', e) }
}

export async function fetchPausedGates(canvasId: string): Promise<PausedGateView[]> {
  try { return (await $fetch<{ gates: PausedGateView[] }>('/api/runs/paused', { query: { canvasId } })).gates ?? [] }
  catch { return [] }
}

export async function fetchRunnerRecord(promptId: string): Promise<RunnerRecordView | null> {
  try { return await $fetch<RunnerRecordView>('/api/runs/record', { query: { promptId } }) }
  catch { return null }
}
