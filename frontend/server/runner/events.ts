/**
 * In-process publish/subscribe of run events, per user. Messages use
 * ComfyUI's WebSocket shapes so the canvas code that reads them keeps
 * working; the browser receives them over GET /api/runs/events.
 * One server process is assumed (see the plan's Global Constraints).
 */
import type { GateChoice, RunnerMessage } from '#shared/runner/messages'

export interface RunEvents {
  publish(userKey: string, m: RunnerMessage): void
  subscribe(userKey: string, fn: (m: RunnerMessage) => void): () => void
}

export function createRunEvents(): RunEvents {
  const subs = new Map<string, Set<(m: RunnerMessage) => void>>()
  return {
    publish(userKey, m) {
      for (const fn of [...(subs.get(userKey) ?? [])]) {
        try { fn(m) } catch (e) { console.error('[runner] event listener failed', e) }
      }
    },
    subscribe(userKey, fn) {
      let set = subs.get(userKey)
      if (!set) { set = new Set(); subs.set(userKey, set) }
      set.add(fn)
      return () => {
        set!.delete(fn)
        if (!set!.size) subs.delete(userKey)
      }
    },
  }
}

export const ev = {
  start: (promptId: string): RunnerMessage => ({ type: 'execution_start', data: { prompt_id: promptId } }),
  executing: (promptId: string, nodeId: string): RunnerMessage =>
    ({ type: 'executing', data: { prompt_id: promptId, node: nodeId, display_node: nodeId } }),
  progress: (promptId: string, nodeId: string, percent: number): RunnerMessage =>
    ({ type: 'progress', data: { prompt_id: promptId, node: nodeId, value: percent, max: 100 } }),
  queuePosition: (promptId: string, nodeId: string, position: number): RunnerMessage =>
    ({ type: 'queue_position', data: { prompt_id: promptId, node: nodeId, position } }),
  executed: (promptId: string, nodeId: string, output: Record<string, unknown>): RunnerMessage =>
    ({ type: 'executed', data: { prompt_id: promptId, node: nodeId, display_node: nodeId, output } }),
  success: (promptId: string, x: { runId: string; credits: number | null; stopped?: boolean }): RunnerMessage =>
    ({ type: 'execution_success', data: { prompt_id: promptId, run_id: x.runId, credits: x.credits, recorded: true, stopped: !!x.stopped } }),
  error: (promptId: string, nodeId: string | null, nodeType: string | null, message: string, x: { runId: string; credits: number | null }): RunnerMessage => ({
    type: 'execution_error',
    data: {
      prompt_id: promptId, node_id: nodeId, node_type: nodeType, exception_message: message,
      exception_type: 'RunnerError', traceback: [], run_id: x.runId, credits: x.credits, recorded: true,
    },
  }),
  gatePaused: (legId: string, runId: string, nodeId: string, choices: GateChoice[], picked: number[]): RunnerMessage =>
    ({ type: 'gate_paused', data: { prompt_id: legId, run_id: runId, node_id: nodeId, choices, picked } }),
}
