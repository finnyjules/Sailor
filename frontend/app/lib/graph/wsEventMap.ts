// Maps ComfyUI WebSocket messages ({ type, data }) to the bridge-shaped event
// objects `default.vue`'s `handleBridgeEvent`-style switch already consumes
// (see custom_nodes/sailor_bridge/js/bridge.js, api.addEventListener
// blocks around lines 1316-1383). Task 8 will pipe useDirectExecution's
// events straight into that same handler, so field names here must match the
// bridge verbatim — NOT the Task 7 brief where the two disagree.
//
// Pure function: no I/O, no state. Unknown/ignored types return null so the
// caller can simply skip dispatch.

import type { GateChoice } from '#shared/runner/messages'
import { isRunnerPromptId } from '#shared/runner/messages'

/** Runner messages also carry the run's canvas (`canvas_id`); ComfyUI's never do. */
export type BridgeShapedEvent = BridgeShapedEventBody & { canvas_id?: string | null }

type BridgeShapedEventBody =
  | { event: 'execution_start'; prompt_id: string | null }
  | { event: 'progress'; percent: number; prompt_id: string | null; node_id: string | null }
  | { event: 'executing'; node_id: string; display_node: string | undefined; prompt_id: string | null }
  | {
      event: 'execution_complete'
      prompt_id: string | null
      // Runner only: the stage's exact charge; `recorded` = the server already
      // wrote the generation record, so the browser must not save its own.
      run_id?: string | null
      credits?: number | null
      recorded?: boolean
      stopped?: boolean
    }
  | { event: 'executed'; node_id: string; output: any; prompt_id: string | null }
  | {
      event: 'execution_error'
      node_id: string | null
      node_type: string | null
      exception_message: string | null
      exception_type: string | null
      traceback: string | undefined
      prompt_id: string | null
      run_id?: string | null
      credits?: number | null
      recorded?: boolean
    }
  | { event: 'gate_paused'; node_id: string | undefined; prompt_id: string | undefined; run_id?: string; choices?: GateChoice[]; picked?: number[] }
  | { event: 'queue_position'; prompt_id: string | null; node_id: string | null; position: number }
  /** Runner only: the node's job moved to its backup service; `message` is the node's status line. */
  | { event: 'provider_switch'; prompt_id: string | null; node_id: string | null; from: string; to: string; message: string }

function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** True if `data` carries a client identifier that names a *different* client. */
function isForeignClient(data: Record<string, any>, myClientId: string): boolean {
  const carried = data.clientId ?? data.client_id ?? data.sid
  return typeof carried === 'string' && carried !== myClientId
}

export function mapWsEvent(msg: { type: string; data: any } | null | undefined, myClientId: string): BridgeShapedEvent | null {
  const mapped = mapBody(msg, myClientId)
  if (!mapped) return null
  // A runner message names its run's canvas, so a window applies it only there.
  const data = msg!.data as Record<string, any>
  const fromRunner = data.recorded === true || Array.isArray(data.choices) || isRunnerPromptId(data.prompt_id)
  return fromRunner && 'canvas_id' in data ? { ...mapped, canvas_id: data.canvas_id ?? null } : mapped
}

function mapBody(msg: { type: string; data: any } | null | undefined, myClientId: string): BridgeShapedEventBody | null {
  if (!msg || typeof msg.type !== 'string') return null
  const data = msg.data
  if (!isPlainObject(data)) return null
  if (isForeignClient(data, myClientId)) return null

  switch (msg.type) {
    case 'execution_start':
      return { event: 'execution_start', prompt_id: data.prompt_id ?? null }

    case 'progress': {
      const { value, max, prompt_id, node } = data
      // Guard against max=0 / absent max: value/0 → Infinity, value/undefined →
      // NaN, both of which would poison the progress bar. Emit 0 in that case.
      const percent = max ? Math.round((value / max) * 100) : 0
      return { event: 'progress', percent, prompt_id: prompt_id ?? null, node_id: node ?? null }
    }

    case 'executing':
      if (data.node === null || data.node === undefined) {
        return { event: 'execution_complete', prompt_id: data.prompt_id ?? null }
      }
      return {
        event: 'executing',
        node_id: data.node,
        display_node: data.display_node,
        prompt_id: data.prompt_id ?? null,
      }

    case 'executed':
      return {
        event: 'executed',
        // VueNodeCanvas normalizes `node_id || node`, so emitting node_id here
        // (from ComfyUI's `node` field) lands on the right node either way.
        node_id: data.node,
        output: data.output,
        prompt_id: data.prompt_id ?? null,
      }

    case 'execution_error': {
      const base = {
        event: 'execution_error' as const,
        node_id: data.node_id ?? data.node ?? null,
        node_type: data.node_type ?? null,
        exception_message: data.exception_message ?? data.message ?? null,
        exception_type: data.exception_type ?? null,
        traceback: Array.isArray(data.traceback) ? data.traceback.join('') : data.traceback,
        prompt_id: data.prompt_id ?? null,
      }
      return data.recorded === true
        ? { ...base, run_id: data.run_id ?? null, credits: typeof data.credits === 'number' ? data.credits : null, recorded: true }
        : base
    }

    // Modern ComfyUI emits execution_success; older/alt builds may emit
    // execution_complete directly. Both map to the bridge's completion shape.
    case 'execution_success':
    case 'execution_complete': {
      const base = { event: 'execution_complete' as const, prompt_id: data.prompt_id ?? null }
      return data.recorded === true
        ? { ...base, run_id: data.run_id ?? null, credits: typeof data.credits === 'number' ? data.credits : null, recorded: true, stopped: data.stopped === true }
        : base
    }

    case 'gate_paused': {
      const base = { event: 'gate_paused' as const, node_id: data.node_id, prompt_id: data.prompt_id }
      return Array.isArray(data.choices)
        ? { ...base, run_id: data.run_id, choices: data.choices, picked: Array.isArray(data.picked) ? data.picked : [] }
        : base
    }

    case 'queue_position':
      return { event: 'queue_position', prompt_id: data.prompt_id ?? null, node_id: data.node ?? null, position: Number(data.position) || 0 }

    case 'provider-switch':
      return {
        event: 'provider_switch', prompt_id: data.prompt_id ?? null, node_id: data.node ?? null,
        from: String(data.from ?? ''), to: String(data.to ?? ''), message: String(data.message ?? ''),
      }

    // Queue-length/exec-info heartbeat — not consumed by the bridge's event
    // switch today. Ignored in v1 per brief.
    case 'status':
      return null

    default:
      return null
  }
}
