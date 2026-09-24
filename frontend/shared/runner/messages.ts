/** Shapes the runner sends to the browser. The browser maps them with mapWsEvent (app/lib/graph/wsEventMap.ts). */
export interface GateChoiceFile { filename: string; subfolder: string; type: string }
export interface GateChoice { take: number; files: GateChoiceFile[] }
export interface RunnerMessage { type: string; data: Record<string, unknown> }

/** Runner runs are registered in the browser's run registry under this worker, so they never make a ComfyUI worker look busy. */
export const RUNNER_WORKER = -1

/**
 * `data.reason` on the server's refusal of a workflow it does not take (its
 * families are off, or a node is not one the runner runs). The browser treats
 * it like the runner being off (a 404): the run goes to ComfyUI instead.
 */
export const RUNNER_NOT_ELIGIBLE = 'not-eligible'

export function isRunnerPromptId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('run_')
}
