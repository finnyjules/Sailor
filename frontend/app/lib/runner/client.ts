/**
 * Browser side of the Sailor runner: when to use it, and the calls to
 * /api/runs. Every call degrades quietly — a runner hiccup must never take
 * the canvas down.
 */
import type { ApiPrompt } from '#shared/runner/graph'
import type { GateChoice } from '#shared/runner/messages'
import { isRunnerPromptId } from '#shared/runner/messages'
import { isRunnerEligible } from '#shared/runner/eligibility'

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

export function shouldUseRunner(enabled: boolean, prompts: Array<ApiPrompt | null | undefined>): boolean {
  return enabled && prompts.length > 0 && prompts.every(p => !!p && isRunnerEligible(p))
}

export function runIdOfPrompt(promptId: unknown): string | null {
  if (!isRunnerPromptId(promptId)) return null
  return (promptId as string).split('.')[0]!
}

export function startRunnerRun(body: { takes: ApiPrompt[]; workflow: unknown; canvasId: string | null; projectUuid: string | null; projectName: string | null }): Promise<LegStarted> {
  return $fetch<LegStarted>('/api/runs', { method: 'POST', body })
}

export function runnerGateAction(body: { runId: string; nodeId: string; action: 'continue' | 'redo' | 'restart'; takes?: number[] }): Promise<LegStarted> {
  return $fetch<LegStarted>('/api/runs/gate', { method: 'POST', body })
}

export async function stopRunnerRuns(): Promise<void> {
  try { await $fetch('/api/runs/stop', { method: 'POST', body: {} }) }
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
