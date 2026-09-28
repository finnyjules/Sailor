/**
 * Correlate a graph run to its outcome by polling GET /history/{prompt_id}.
 * We poll (not websocket) because ComfyUI sends execution_success only to the
 * submitting client_id, not broadcast (execution.py:793 → add_message
 * broadcast=False → execution.py:680). All I/O is injected so this is a pure,
 * fast unit. A success calls onSuccess; an error calls onError WITH the
 * history entry (Task G2: the caller may charge the paid nodes that finished,
 * see partialCharge); a timeout calls onError with no entry (never charged).
 */
import { deliveredToOutput } from './renderCredit'
export interface HistoryEntry {
  status?: { status_str?: 'success' | 'error'; completed?: boolean; messages?: unknown }
  outputs?: unknown
}

export interface SettleOpts {
  promptId: string
  pollHistory: (promptId: string) => Promise<HistoryEntry | null>
  onSuccess: (promptId: string) => void
  /** `entry` is the failed run's history entry; absent on a timeout. */
  onError: (promptId: string, entry?: HistoryEntry) => void
  sleep?: (ms: number) => Promise<void>
  intervalMs?: number
  maxPolls?: number
}

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function settleOnCompletion(opts: SettleOpts): Promise<'success' | 'error' | 'timeout'> {
  const { promptId, pollHistory, onSuccess, onError } = opts
  const sleep = opts.sleep ?? realSleep
  const intervalMs = opts.intervalMs ?? 1000
  const maxPolls = opts.maxPolls ?? 120

  for (let n = 0; n < maxPolls; n++) {
    let entry: HistoryEntry | null = null
    try {
      entry = await pollHistory(promptId)
    } catch { /* transient poll failure — keep polling; maxPolls timeout is the backstop */ }
    // Engine fact (live-verified): success entries are {status_str:'success',
    // completed:true}, but FAILED runs are {status_str:'error', completed:false}
    // — completed never turns true on error, so gate on status_str.
    const st = entry?.status
    if (st?.status_str === 'success' && st.completed) { onSuccess(promptId); return 'success' }
    if (st?.status_str === 'error') { onError(promptId, entry!); return 'error' }
    await sleep(intervalMs)
  }
  onError(promptId) // never charge a run we could not confirm
  return 'timeout'
}

/**
 * Task G2: what a graph run's hold was the sum of, recorded at submit — the
 * per-node credits from priceGraph (the one calculation behind the badge,
 * the estimate and the charge), the render credit, and which nodes are local
 * renders (the Frame), whose finishing earns the render credit as it does in
 * the runner.
 */
export interface RunChargePlan {
  nodes: Record<string, number>
  base: number
  renderNodes: string[]
  /** Each output node → itself and every node it reads (renderCredit.ts outputReadsOf): what a failed run delivered. */
  outputReads: Record<string, string[]>
}

export type PartialCharge =
  | { credits: number; nodeIds: string[]; base: number; failedNode: string | null; interrupted: boolean }
  | { unknown: string }

const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

/**
 * Task G2: the credits a FAILED run owes — the paid nodes ComfyUI finished.
 *
 * ComfyUI records the run's messages in the history entry
 * (main.py task_done → status.messages, a list of [event, data] pairs). On a
 * failure the last one is `execution_error` (or `execution_interrupted` on a
 * cancel), whose data carries `executed`: the node ids that ran to the end
 * (execution.py handle_execution_error). A node served from ComfyUI's cache
 * returns before it is added to `executed` (execution.py execute: the
 * `cached is not None` branch), so it never counts; `execution_cached.nodes`
 * is subtracted too, belt and braces. The failing node is not in `executed`
 * (it never reached `executed.add`), nor is a node skipped after it, nor an
 * async node still waiting on its provider.
 *
 * The render credit follows the runner (engine.ts runTakeLeg), by the one
 * rule in renderCredit.ts: it rides only on something made and shown — an
 * output node that ran reads a paid node or a Frame render that ran — and only
 * when the graph had an output node (plan.base > 0). A paid node that ran with
 * no output reading it that ran, or a failed node, earns no render credit.
 *
 * Anything that stops us telling which nodes ran returns `{ unknown }`: the
 * caller charges nothing, as before G2. The sum is never more than `hold`.
 */
export function partialCharge(entry: HistoryEntry | null | undefined, plan: RunChargePlan, hold: number): PartialCharge {
  const messages = entry?.status?.messages
  if (!Array.isArray(messages)) return { unknown: 'the history entry has no messages' }

  let failure: { executed: string[]; nodeId: string | null; interrupted: boolean } | null = null
  let cached: string[] = []
  for (const m of messages) {
    if (!Array.isArray(m) || typeof m[0] !== 'string') return { unknown: 'a history message is not an [event, data] pair' }
    const [event, data] = m as [string, any]
    if (event === 'execution_cached') {
      if (!isIdList(data?.nodes)) return { unknown: 'execution_cached has no node list' }
      cached = data.nodes
    }
    else if (event === 'execution_error' || event === 'execution_interrupted') {
      if (!isIdList(data?.executed)) return { unknown: `${event} has no executed list` }
      failure = {
        executed: data.executed,
        nodeId: typeof data?.node_id === 'string' ? data.node_id : null,
        interrupted: event === 'execution_interrupted',
      }
    }
  }
  if (!failure) return { unknown: 'the history entry records no execution_error' }

  const skip = new Set(cached)
  if (failure.nodeId !== null) skip.add(failure.nodeId)
  const ran = new Set(failure.executed.filter(id => !skip.has(id)))

  const nodeIds = Object.keys(plan.nodes).filter(id => plan.nodes[id]! > 0 && ran.has(id)).sort()
  const paid = nodeIds.reduce((s, id) => s + plan.nodes[id]!, 0)
  const made = new Set([...nodeIds, ...plan.renderNodes.filter(id => ran.has(id))])
  const base = plan.base > 0 && deliveredToOutput(plan.outputReads, ran, made) ? plan.base : 0
  const credits = Math.max(0, Math.min(paid + base, hold))
  return { credits, nodeIds, base, failedNode: failure.nodeId, interrupted: failure.interrupted }
}
