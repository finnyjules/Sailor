/**
 * Stage 5 security review I2 + I4 — the hosted forward path.
 *
 * I2 (client-chosen prompt_id): ComfyUI honours `json_data.prompt_id` if the
 * submitter supplies one. An attacker who learns a victim's prompt_id can
 * submit their OWN graph carrying it; ComfyUI runs it under that id, the
 * attacker's settle watcher then calls resolveGraphRun(id, 'settled',
 * <attacker outputs>) — an UPDATE keyed on prompt_id alone — and overwrites
 * the victim's graph_runs row, revoking the victim's access to their own
 * outputs and granting it to the attacker's. The forwarded body must never
 * carry a client-chosen prompt_id.
 *
 * I4 (pool-worker runs unharvestable): graph_runs recorded no engine, so the
 * /view race-window harvest always polled :8188 and could never settle a run
 * dispatched to a pool worker. createGraphRun must record the target.
 *
 * Drives the real handleMeteredPrompt with a stubbed engine + ledger.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('h3', async (orig) => {
  const actual = await orig() as any
  return { ...actual, readBody: async (event: any) => event.body, setResponseStatus: () => {} }
})

const createGraphRun = vi.fn(async () => {})
const resolveGraphRun = vi.fn(async () => {})
vi.mock('../../server/utils/graphRuns', async (orig) => {
  const actual = await orig() as any
  return { ...actual, createGraphRun: (...a: any[]) => createGraphRun(...(a as [])), resolveGraphRun: (...a: any[]) => resolveGraphRun(...(a as [])) }
})

vi.mock('../../server/utils/settleWatcher', () => ({ settleOnCompletion: vi.fn(async () => 'success') }))

const ledger = {
  hold: vi.fn(async () => ({ ok: true as const, holdId: 7 })),
  getAvailable: vi.fn(async () => 1000),
  release: vi.fn(async () => {}),
  settle: vi.fn(async () => ({ settled: true })),
}
vi.mock('../../server/utils/ledgerLive', () => ({ getLiveLedger: () => ledger }))

const fetchMock = vi.fn(async (_url: string, _init?: any) => ({
  ok: true,
  status: 200,
  json: async () => ({ prompt_id: 'engine-assigned', number: 1, node_errors: {} }),
}))
;(globalThis as any).fetch = fetchMock

let handleMeteredPrompt: (event: any) => Promise<any>
let settleGraphSuccess: (target: string, promptId: string, holdId: number | null, credits: number) => Promise<void>
let shortUserHash: (userId: string) => string
let viewGateDecision: (q: { filename: string, type?: string, subfolder?: string }) => any
beforeAll(async () => {
  ;({ handleMeteredPrompt, settleGraphSuccess, shortUserHash } = await import('../../server/utils/meterGraphRun'))
  ;({ viewGateDecision } = await import('../../server/utils/engineGate'))
})

beforeEach(() => { fetchMock.mockClear(); createGraphRun.mockClear(); resolveGraphRun.mockClear() })

const GRAPH = { '1': { class_type: 'SaveImage', inputs: {} } }

function ev(body: any, path = '/prompt') {
  return { path, method: 'POST', body, context: { userId: 'u1' }, node: { req: {}, res: {} } }
}
function forwardedBody(): any {
  const call = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/prompt'))
  return JSON.parse((call?.[1] as any).body)
}

describe('I2 — a client-chosen prompt_id is never forwarded', () => {
  it('strips prompt_id from the forwarded body (and injects the per-user output prefix)', async () => {
    await handleMeteredPrompt(ev({ prompt: GRAPH, client_id: 'c1', prompt_id: 'victims-run-id' }))
    const sent = forwardedBody()
    expect('prompt_id' in sent, 'forwarded body must not carry prompt_id').toBe(false)
    expect(sent.client_id).toBe('c1')
    // Stage 6 Task 7: SaveImage now writes under the caller's own subfolder.
    expect(sent.prompt['1'].class_type).toBe('SaveImage')
    expect(sent.prompt['1'].inputs.filename_prefix).toBe(`u_${shortUserHash('u1')}/ComfyUI`)
    // The submitter's own GRAPH object is never mutated (clone semantics).
    expect((GRAPH['1'].inputs as any).filename_prefix).toBeUndefined()
  })

  it('ownership is recorded under the ENGINE-assigned id, not the submitted one', async () => {
    await handleMeteredPrompt(ev({ prompt: GRAPH, prompt_id: 'victims-run-id' }))
    expect(createGraphRun.mock.calls[0][0]).toMatchObject({ promptId: 'engine-assigned', userId: 'u1' })
  })

  it('leaves a body with no prompt_id alone', async () => {
    await handleMeteredPrompt(ev({ prompt: GRAPH, client_id: 'c1' }))
    expect(forwardedBody()).toMatchObject({ prompt: GRAPH, client_id: 'c1' })
  })
})

describe('M6 — the promptId is percent-encoded into the history path', () => {
  it('encodes in the settlement harvest', async () => {
    await settleGraphSuccess('http://127.0.0.1:8188', 'a b/../c', null, 0)
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8188/history/a%20b%2F..%2Fc')
  })
})

describe('Stage 6 Task 7 — outputs settle under the per-user subfolder and stay /view-gated', () => {
  it('records the subfoldered output key, and /view derives the SAME ownership key', async () => {
    const hash = shortUserHash('u1')
    const image = { filename: 'ComfyUI_00001_.png', subfolder: `u_${hash}`, type: 'output' }
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ p9: { outputs: { '9': { images: [image] } } } }),
    })
    await settleGraphSuccess('http://127.0.0.1:8188', 'p9', null, 0)

    const call = resolveGraphRun.mock.calls[0] as any[]
    expect(call[0]).toBe('p9')
    expect(call[1]).toBe('settled')
    const outputs = call[2] as string[]
    expect(outputs).toContain(`output:u_${hash}:ComfyUI_00001_.png`)

    // End-to-end: the /view gate, given the same subfoldered file, must derive
    // the identical key that settlement recorded — so a per-user-subfoldered
    // output remains ownership-gated on read.
    const gate = viewGateDecision({ filename: image.filename, subfolder: image.subfolder, type: 'output' })
    expect(gate).toEqual({ kind: 'check', key: `output:u_${hash}:ComfyUI_00001_.png` })
    expect(new Set(outputs).has(gate.key)).toBe(true)
  })
})

describe('Stage 6 Task 7c — write-side containment for the remaining writers, end to end through handleMeteredPrompt', () => {
  it('neutralizes a SaveImageDataSetToFolder ../../etc traversal in the forwarded body', async () => {
    const hash = shortUserHash('u1')
    const graph = { '1': { class_type: 'SaveImageDataSetToFolder', inputs: { folder_name: '../../etc', images: ['0', 0] } } }
    await handleMeteredPrompt(ev({ prompt: graph, client_id: 'c1' }))
    const sent = forwardedBody()
    expect(sent.prompt['1'].inputs.folder_name).toBe(`u_${hash}/etc`)
  })

  it('subfolders SaveLoRA under its prefix field in the forwarded body', async () => {
    const hash = shortUserHash('u1')
    const graph = { '1': { class_type: 'SaveLoRA', inputs: { lora: ['0', 0] } } }
    await handleMeteredPrompt(ev({ prompt: graph, client_id: 'c1' }))
    const sent = forwardedBody()
    expect(sent.prompt['1'].inputs.prefix).toBe(`u_${hash}/ComfyUI`)
  })

  it('a graph with no writer nodes forwards unaffected', async () => {
    const graph = { '1': { class_type: 'KSampler', inputs: { seed: 5 } } }
    await handleMeteredPrompt(ev({ prompt: graph, client_id: 'c1' }))
    const sent = forwardedBody()
    expect(sent.prompt).toEqual(graph)
  })
})

describe('I4 — the run records which engine ran it', () => {
  it('records the main engine for an unrouted submission', async () => {
    await handleMeteredPrompt(ev({ prompt: GRAPH }))
    expect(createGraphRun.mock.calls[0][0]).toMatchObject({ target: 'http://127.0.0.1:8188' })
  })
})
