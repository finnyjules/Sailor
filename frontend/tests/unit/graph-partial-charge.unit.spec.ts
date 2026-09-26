/**
 * Task G2: on the hosted ComfyUI path a run that fails partway is charged for
 * the paid nodes that finished (not cached, not the failing node, not
 * skipped), never more than the hold; the rest is released. Success is
 * unchanged; a timeout, or a history entry that doesn't say what ran, is
 * released uncharged. The history entries below have ComfyUI's real shape:
 * main.py task_done stores status {status_str, completed, messages}, and
 * messages are [event, data] pairs from execution.py add_message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { meterGraphSubmit, watchGraphRun, chargePlanOf, type WatchGraphRunIO } from '../../server/utils/meterGraphRun'
import { partialCharge, type HistoryEntry, type RunChargePlan } from '../../server/utils/settleWatcher'
import { priceGraph, BASE_RENDER_CREDITS, LORA_RENDER_CREDITS } from '../../server/utils/priceBook'
import { FRAME_RENDER_TYPES } from '#shared/runner/eligibility'

const PAID = 'FluxLoRARemoteNode' // a flat-priced paid class: LORA_RENDER_CREDITS a call

// Three paid branches, each saved on its own; a free loader feeds them.
const GRAPH = {
  '1': { class_type: 'LoadImage', inputs: { image: 'in.png' } },
  '10': { class_type: PAID, inputs: {} },
  '11': { class_type: 'SaveImage', inputs: { images: ['10', 0] } },
  '20': { class_type: PAID, inputs: {} },
  '21': { class_type: 'SaveImage', inputs: { images: ['20', 0] } },
  '30': { class_type: PAID, inputs: {} },
  '31': { class_type: 'SaveImage', inputs: { images: ['30', 0] } },
}
const HOLD = 3 * LORA_RENDER_CREDITS + BASE_RENDER_CREDITS

function plan(): RunChargePlan {
  const price = priceGraph(GRAPH)
  return chargePlanOf(GRAPH, price.nodes!, price.base!)
}

const ts = 1_700_000_000_000
function failed(executed: string[], nodeId: string, opts: { cached?: string[]; event?: 'execution_error' | 'execution_interrupted'; outputs?: unknown } = {}): HistoryEntry {
  const event = opts.event ?? 'execution_error'
  return {
    status: {
      status_str: 'error',
      completed: false,
      messages: [
        ['execution_start', { prompt_id: 'p1', timestamp: ts }],
        ['execution_cached', { nodes: opts.cached ?? [], prompt_id: 'p1', timestamp: ts }],
        [event, {
          prompt_id: 'p1', node_id: nodeId, node_type: PAID, executed,
          ...(event === 'execution_error' ? { exception_message: 'provider said no', exception_type: 'Exception', traceback: [], current_inputs: {}, current_outputs: [] } : {}),
          timestamp: ts,
        }],
      ],
    },
    outputs: opts.outputs ?? {},
  }
}

function io(entries: (HistoryEntry | null)[], over: Partial<WatchGraphRunIO> = {}) {
  let i = 0
  const ledger = {
    settle: vi.fn(async (_h: number, _a: number, _r: string) => ({ settled: true })),
    release: vi.fn(async (_h: number) => {}),
  }
  const x = {
    pollHistory: vi.fn(async () => entries[Math.min(i++, entries.length - 1)] ?? null),
    settleSuccess: vi.fn(async (_id: string) => {}),
    ledger,
    resolve: vi.fn(async (_id: string, _s: 'settled' | 'voided', _o?: string[]) => {}),
    sleep: () => Promise.resolve(),
    intervalMs: 0,
    maxPolls: 5,
    ...over,
  }
  return x
}

const RUN = () => ({ promptId: 'p1', holdId: 7, credits: HOLD, plan: plan() })

let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { errSpy.mockRestore() })

describe('the charge plan is the hold, node by node', () => {
  it('priceGraph gives each node its credits and the render credit, summing to the hold', () => {
    const price = priceGraph(GRAPH)
    expect(price.nodes).toEqual({ '10': LORA_RENDER_CREDITS, '20': LORA_RENDER_CREDITS, '30': LORA_RENDER_CREDITS })
    expect(price.base).toBe(BASE_RENDER_CREDITS)
    const sum = Object.values(price.nodes!).reduce((s, c) => s + c, 0) + price.base!
    expect(sum).toBe(price.credits)
    expect(price.credits).toBe(HOLD)
  })

  it('meterGraphSubmit hands the plan to the settle watcher', async () => {
    const startSettle = vi.fn()
    const res = await meterGraphSubmit('u1', { prompt: GRAPH }, {
      priceGraph,
      spendGuard: async () => {},
      validateFileRefs: async () => {},
      moderatePrompt: async () => ({ ok: true as const }),
      hold: async () => ({ ok: true as const, holdId: 7 }),
      getAvailable: async () => 100,
      forward: async () => ({ status: 200, body: { prompt_id: 'p1', number: 1, node_errors: {} } }),
      registerRun: async () => {},
      startSettle,
      releaseHold: async () => {},
    })
    expect(res.status).toBe(200)
    expect(startSettle).toHaveBeenCalledWith({ promptId: 'p1', holdId: 7, credits: HOLD, plan: plan() })
  })
})

describe('watchGraphRun settles by what ran', () => {
  it('success: the whole hold, through the success settle, as before', async () => {
    const x = io([null, { status: { status_str: 'success', completed: true, messages: [] } }])
    expect(await watchGraphRun(RUN(), x)).toBe('success')
    expect(x.settleSuccess).toHaveBeenCalledWith('p1')
    expect(x.ledger.settle).not.toHaveBeenCalled()
    expect(x.ledger.release).not.toHaveBeenCalled()
  })

  it('error after two paid nodes finished on other branches: charges those two and the render credit, releases the rest', async () => {
    const outputs = { '11': { images: [{ filename: 'a.png', subfolder: 'u_x', type: 'output' }] }, '21': { images: [{ filename: 'b.png', subfolder: 'u_x', type: 'output' }] } }
    const x = io([null, failed(['1', '10', '11', '20', '21'], '30', { outputs })])
    expect(await watchGraphRun(RUN(), x)).toBe('error')
    const owed = 2 * LORA_RENDER_CREDITS + BASE_RENDER_CREDITS
    expect(x.ledger.settle).toHaveBeenCalledTimes(1)
    const [holdId, actual, reason] = x.ledger.settle.mock.calls[0]!
    expect(holdId).toBe(7)
    expect(actual).toBe(owed)
    expect(actual).toBeLessThan(HOLD)
    expect(reason).toContain('graph:p1 partial')
    expect(reason).toContain(`${owed} of ${HOLD}`)
    expect(reason).toContain('10, 20')
    expect(reason).toContain('at node 30')
    expect(x.ledger.release).not.toHaveBeenCalled() // settle releases the rest of the hold itself
    expect(x.resolve).toHaveBeenCalledWith('p1', 'settled', ['output:u_x:a.png', 'output:u_x:b.png'])
  })

  it('error on the only paid node that ran: nothing charged, hold released', async () => {
    const x = io([failed(['1'], '10')])
    await watchGraphRun(RUN(), x)
    expect(x.ledger.settle).not.toHaveBeenCalled()
    expect(x.ledger.release).toHaveBeenCalledWith(7)
    expect(x.resolve).toHaveBeenCalledWith('p1', 'voided')
  })

  it('cached paid nodes are not charged (ComfyUI leaves them out of executed)', async () => {
    // Node 10 came from the cache; 20 ran; 30 failed.
    const x = io([failed(['1', '20', '21'], '30', { cached: ['10', '11'] })])
    await watchGraphRun(RUN(), x)
    expect(x.ledger.settle.mock.calls[0]![1]).toBe(LORA_RENDER_CREDITS + BASE_RENDER_CREDITS)
  })

  it('a cached node listed as executed too is still not charged', async () => {
    const x = io([failed(['1', '10', '20'], '30', { cached: ['10'] })])
    await watchGraphRun(RUN(), x)
    expect(x.ledger.settle.mock.calls[0]![1]).toBe(LORA_RENDER_CREDITS + BASE_RENDER_CREDITS)
  })

  it('every paid node cached, the failure elsewhere: nothing charged', async () => {
    const x = io([failed(['1'], '31', { cached: ['10', '20', '30'] })])
    await watchGraphRun(RUN(), x)
    expect(x.ledger.settle).not.toHaveBeenCalled()
    expect(x.ledger.release).toHaveBeenCalledWith(7)
  })

  it('timeout: released, never charged', async () => {
    const x = io([null])
    expect(await watchGraphRun(RUN(), x)).toBe('timeout')
    expect(x.ledger.settle).not.toHaveBeenCalled()
    expect(x.settleSuccess).not.toHaveBeenCalled()
    expect(x.ledger.release).toHaveBeenCalledWith(7)
    expect(x.resolve).toHaveBeenCalledWith('p1', 'voided')
  })

  it.each([
    ['no messages', { status: { status_str: 'error' as const, completed: false } }],
    ['messages not a list', { status: { status_str: 'error' as const, completed: false, messages: 'boom' } }],
    ['a message that is not a pair', { status: { status_str: 'error' as const, completed: false, messages: [{ event: 'execution_error' }] } }],
    ['no execution_error', { status: { status_str: 'error' as const, completed: false, messages: [['execution_start', { prompt_id: 'p1' }]] } }],
    ['execution_error without executed', { status: { status_str: 'error' as const, completed: false, messages: [['execution_error', { node_id: '30' }]] } }],
    ['executed not a list of ids', { status: { status_str: 'error' as const, completed: false, messages: [['execution_error', { node_id: '30', executed: [10, 20] }]] } }],
    ['execution_cached without a node list', { status: { status_str: 'error' as const, completed: false, messages: [['execution_cached', {}], ['execution_error', { node_id: '30', executed: ['10'] }]] } }],
  ])('malformed history (%s): nothing charged, released, logged', async (_why, entry) => {
    const x = io([entry as HistoryEntry])
    expect(await watchGraphRun(RUN(), x)).toBe('error')
    expect(x.ledger.settle).not.toHaveBeenCalled()
    expect(x.ledger.release).toHaveBeenCalledWith(7)
    expect(x.resolve).toHaveBeenCalledWith('p1', 'voided')
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('cannot tell which nodes ran'), expect.anything())
  })

  it('no plan recorded: released uncharged and logged', async () => {
    const x = io([failed(['10', '20'], '30')])
    await watchGraphRun({ promptId: 'p1', holdId: 7, credits: HOLD }, x)
    expect(x.ledger.settle).not.toHaveBeenCalled()
    expect(x.ledger.release).toHaveBeenCalledWith(7)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no charge plan'), expect.anything())
  })

  it('a stopped run (execution_interrupted) is charged for what finished, as the runner does', async () => {
    const x = io([failed(['1', '10', '11'], '20', { event: 'execution_interrupted' })])
    await watchGraphRun(RUN(), x)
    const [, actual, reason] = x.ledger.settle.mock.calls[0]!
    expect(actual).toBe(LORA_RENDER_CREDITS + BASE_RENDER_CREDITS)
    expect(reason).toContain('stopped')
  })

  it('a settle refused by the ledger falls back to releasing', async () => {
    const x = io([failed(['10'], '30')])
    x.ledger.settle.mockRejectedValueOnce(new Error('db down'))
    await watchGraphRun(RUN(), x)
    expect(x.ledger.release).toHaveBeenCalledWith(7)
    expect(x.resolve).toHaveBeenCalledWith('p1', 'voided')
  })
})

describe('partialCharge', () => {
  it('never charges more than the hold', () => {
    const owed = partialCharge(failed(['10', '20', '30'], '31'), plan(), 5)
    expect(owed).toMatchObject({ credits: 5 })
  })

  it('never charges the failing node, even if it were listed as executed', () => {
    const owed = partialCharge(failed(['10', '30'], '30'), plan(), HOLD)
    expect(owed).toMatchObject({ credits: LORA_RENDER_CREDITS + BASE_RENDER_CREDITS, nodeIds: ['10'] })
  })

  it('the render credit rides on a finished Frame render with no paid node, as in the runner', () => {
    const frame = 'Compositor'
    expect(FRAME_RENDER_TYPES.has(frame)).toBe(true)
    const g = { '5': { class_type: frame, inputs: {} }, '6': { class_type: 'SaveImage', inputs: {} }, '10': { class_type: PAID, inputs: {} } }
    const p = chargePlanOf(g, { '10': LORA_RENDER_CREDITS }, BASE_RENDER_CREDITS)
    expect(p.renderNodes).toEqual(['5'])
    expect(partialCharge(failed(['5'], '10'), p, LORA_RENDER_CREDITS + BASE_RENDER_CREDITS)).toMatchObject({ credits: BASE_RENDER_CREDITS, nodeIds: [] })
  })

  it('no render credit when the graph has no output node', () => {
    const p: RunChargePlan = { nodes: { '10': LORA_RENDER_CREDITS, '20': LORA_RENDER_CREDITS }, base: 0, renderNodes: [] }
    expect(partialCharge(failed(['10'], '20'), p, 2 * LORA_RENDER_CREDITS)).toMatchObject({ credits: LORA_RENDER_CREDITS, base: 0 })
  })
})
