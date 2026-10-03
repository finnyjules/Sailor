/**
 * Step 3, R10.8: GET /history and GET /history/{promptId} are Sailor's own.
 *
 * They answer from the runner's run records (one entry per finished stage,
 * in ComfyUI's shape) and, locally, the disk cache; the engine is asked only
 * while its cached health says 'up' (its local-only runs), bounded by the
 * health timeout. With nothing on the engine's port every route still answers.
 * Hosted reads the caller's own runs only — never the engine or the shared cache.
 *
 * fs is mocked for the cache: the real .cache/history.json on disk is a live
 * dev cache and must never be touched by a test run. The run store is a fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, createRouter, eventHandler, toWebHandler } from 'h3'
import type { NodeRecord, RunRecord } from '~~/server/runner/types'
import type { RunStore } from '~~/server/runner/store'

const fsState = { existing: null as string | null, reads: 0 }
vi.mock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), existsSync: vi.fn(() => fsState.existing !== null) }))
vi.mock('node:fs/promises', async (orig) => ({
  ...(await orig<typeof import('node:fs/promises')>()),
  readFile: vi.fn(async () => { fsState.reads++; return fsState.existing ?? '{}' }),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
}))

const engineHealthMock = vi.fn(async () => 'down' as 'up' | 'down')
vi.mock('~~/server/native/engineHealth', () => ({
  engineHealth: () => engineHealthMock(),
  ENGINE_HEALTH_TIMEOUT_MS: 1500,
  ENGINE_MAIN_PORT: 8188,
}))

const RUN_A = 'run_aaaaaaaa-0000-4000-8000-000000000001'
const RUN_B = 'run_bbbbbbbb-0000-4000-8000-000000000002'

function node(classType: string, o: Partial<NodeRecord> = {}): NodeRecord {
  return {
    status: 'done', classType, leg: 0, endpoint: null, payload: null, fingerprint: null, request: null,
    outputs: [], reused: false, credits: 0, startedAt: 1, endedAt: 2, error: null, ...o,
  }
}

function run(id: string, userId: string | null, nodes: Record<string, NodeRecord>, o: Partial<RunRecord> = {}): RunRecord {
  return {
    id, userId, canvasId: null, projectUuid: 'proj-1', projectName: null, workflow: null,
    createdAt: 1000, updatedAt: 2000, status: 'done',
    takes: [{ index: 1, prompt: {}, nodes, openGates: [], droppedGates: [] } as never],
    legs: [{ index: 0, id: `${id}.0`, action: 'run', gateId: null, takes: [1], status: 'done', startedAt: 1000, endedAt: 1500 }],
    charges: [{ stageKey: `${id}.0.t1`, leg: 0, take: 1, estimate: 0, includesBase: false, holdId: null, state: 'free', actual: null, finished: true }],
    baseCharged: false, stopRequested: false, ...o,
  }
}

function fakeStore(runs: RunRecord[]): RunStore {
  return {
    save: async () => {}, listActive: async () => [], listUnconfirmedCancels: async () => [],
    get: async id => runs.find(r => r.id === id) ?? null,
    listForUser: async userId => runs.filter(r => r.userId === userId),
    getResult: async () => null, putResult: async () => {},
  }
}

const LOCAL_RUN = run(RUN_A, null, {
  '3': node('FluxGenerate', { outputs: [{ filename: 'flux_00001_.png', subfolder: '', type: 'output' }] }),
  '4': node('SaveVideo', { outputs: [{ filename: 'clip_00001_.mp4', subfolder: '', type: 'output' }, { filename: 'k.bin', subfolder: RUN_A, type: 'kept' }] }),
  '5': node('PreviewImage', { reused: true, outputs: [{ filename: 'old.png', subfolder: '', type: 'output' }] }),
})
const OTHER_RUN = run(RUN_B, 'user_2', { '1': node('FluxGenerate', { outputs: [{ filename: 'theirs.png', subfolder: 'u_2', type: 'output' }] }) })
const MINE_HOSTED = run(RUN_A, 'user_1', { '1': node('FluxGenerate', { outputs: [{ filename: 'mine.png', subfolder: 'u_1', type: 'output' }] }) })

async function setStore(runs: RunRecord[]) {
  const { __setRunStoreForTests } = await import('~~/server/runner/store')
  __setRunStoreForTests(fakeStore(runs))
}

async function list(userId: string | null = null) {
  const route = (await import('~~/server/routes/history/index.get')).default
  const app = createApp()
  if (userId) app.use(eventHandler((e) => { e.context.userId = userId }))
  app.use(route)
  return toWebHandler(app)(new Request('http://x/history'))
}

async function one(promptId: string, userId: string | null = null) {
  const route = (await import('~~/server/routes/history/[promptId].get')).default
  const app = createApp()
  if (userId) app.use(eventHandler((e) => { e.context.userId = userId }))
  app.use(createRouter().get('/history/:promptId', route))
  return toWebHandler(app)(new Request(`http://x/history/${promptId}`))
}

/** Nothing listens on the engine's port: every request to it is refused. */
const refused = () => vi.fn(async () => { throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:8188') })

beforeEach(async () => {
  vi.resetModules()
  fsState.existing = null
  fsState.reads = 0
  engineHealthMock.mockReset()
  engineHealthMock.mockResolvedValue('down')
  vi.stubGlobal('fetch', refused())
  await setStore([LOCAL_RUN, OTHER_RUN])
})
afterEach(async () => {
  delete process.env.NUXT_CLERK_SECRET_KEY
  vi.unstubAllGlobals()
  const { __setRunStoreForTests } = await import('~~/server/runner/store')
  __setRunStoreForTests(null)
})

describe('the runner’s records as history entries', () => {
  it('one entry per finished stage, in ComfyUI’s shape: new output files only, the project named', async () => {
    const { runHistoryEntries } = await import('~~/server/native/history')
    const entries = runHistoryEntries(LOCAL_RUN)
    const key = `${RUN_A}.0.t1`
    expect(Object.keys(entries)).toEqual([key])
    const e = entries[key]!
    expect(e.outputs).toEqual({
      3: { images: [{ filename: 'flux_00001_.png', subfolder: '', type: 'output' }] },
      4: { gifs: [{ filename: 'clip_00001_.mp4', subfolder: '', type: 'output' }] },
    })
    expect(e.status).toEqual({
      status_str: 'success', completed: true,
      messages: [['execution_start', { prompt_id: key, timestamp: 1000 }], ['execution_success', { prompt_id: key, timestamp: 1500 }]],
    })
    expect(e.prompt[1]).toBe(key)
    expect(e.prompt[2]['3']).toEqual({ class_type: 'FluxGenerate', inputs: {} })
    expect((e.prompt[3] as any).extra_pnginfo.workflow.extra.projectUuid).toBe('proj-1')
  })

  it('reads as the app reads /history (generations.ts)', async () => {
    const { runHistoryEntries } = await import('~~/server/native/history')
    const { historyEntryToRecord } = await import('~~/app/lib/generations')
    const key = `${RUN_A}.0.t1`
    const parsed = historyEntryToRecord(key, runHistoryEntries(LOCAL_RUN)[key])
    expect(parsed?.projectUuid).toBe('proj-1')
    expect(parsed?.record.outputs.map(o => [o.kind, o.filename])).toEqual([['image', 'flux_00001_.png'], ['video', 'clip_00001_.mp4']])
    expect(parsed?.record.ts).toBe(1000)
  })

  it('a stage that failed or was stopped is listed, not completed; an unfinished one is not listed', async () => {
    const { runHistoryEntries } = await import('~~/server/native/history')
    const failed = run(RUN_A, null, { '1': node('FluxGenerate', { status: 'error', error: 'x' }) })
    expect(runHistoryEntries(failed)[`${RUN_A}.0.t1`]!.status).toMatchObject({ status_str: 'error', completed: false })
    const stopped = run(RUN_A, null, { '1': node('FluxGenerate', { status: 'stopped' }) })
    expect(runHistoryEntries(stopped)[`${RUN_A}.0.t1`]!.status.messages[1]![0]).toBe('execution_interrupted')
    const going = run(RUN_A, null, { '1': node('FluxGenerate', { status: 'running' }) }, { status: 'running' })
    going.charges[0]!.finished = false
    expect(runHistoryEntries(going)).toEqual({})
  })
})

describe('GET /history — nothing on the engine’s port', () => {
  it('local, engine down: the cache and the runner’s records, without a request', async () => {
    fsState.existing = JSON.stringify({ old: { outputs: {} } })
    const res = await list()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['old', `${RUN_A}.0.t1`])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('local, engine reported up but refusing: still answers, from the cache and the runner', async () => {
    engineHealthMock.mockResolvedValue('up')
    fsState.existing = JSON.stringify({ old: { outputs: {} } })
    const res = await list()
    expect(res.status).toBe(200)
    expect(Object.keys(await res.json()).sort()).toEqual(['old', `${RUN_A}.0.t1`])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('local, engine up: its local-only runs are merged in, asked with a timeout', async () => {
    engineHealthMock.mockResolvedValue('up')
    fsState.existing = JSON.stringify({ a: 1 })
    ;(fetch as any).mockImplementation(async () => new Response(JSON.stringify({ b: 2 }), { status: 200 }))
    const res = await list()
    const body = await res.json()
    expect(body).toMatchObject({ a: 1, b: 2 })
    expect(body[`${RUN_A}.0.t1`]).toBeTruthy()
    expect((fetch as any).mock.calls[0][0]).toBe('http://127.0.0.1:8188/history')
    expect((fetch as any).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('local, the run store unreadable: the cache still answers', async () => {
    const { __setRunStoreForTests } = await import('~~/server/runner/store')
    __setRunStoreForTests({ ...fakeStore([]), listForUser: async () => { throw new Error('disk gone') } })
    fsState.existing = JSON.stringify({ old: { outputs: {} } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await list()
    expect(await res.json()).toEqual({ old: { outputs: {} } })
  })

  it('hosted: the caller’s own runs only — never the engine (even up) or the shared cache', async () => {
    process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_x'
    engineHealthMock.mockResolvedValue('up')
    fsState.existing = JSON.stringify({ old: { outputs: {} } })
    await setStore([MINE_HOSTED, OTHER_RUN])
    const res = await list('user_1')
    expect(Object.keys(await res.json())).toEqual([`${RUN_A}.0.t1`])
    expect(fetch).not.toHaveBeenCalled()
    expect(engineHealthMock).not.toHaveBeenCalled()
    expect(fsState.reads).toBe(0)
  })

  it('hosted: signed out is a 401', async () => {
    process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_x'
    const res = await list(null)
    expect(res.status).toBe(401)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('GET /history/{promptId} — nothing on the engine’s port', () => {
  it('a runner stage comes from its run record, without a request', async () => {
    const key = `${RUN_A}.0.t1`
    const res = await one(key)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body)).toEqual([key])
    expect(body[key].outputs['3'].images[0].filename).toBe('flux_00001_.png')
    expect(fetch).not.toHaveBeenCalled()
    expect(engineHealthMock).not.toHaveBeenCalled()
  })

  it('a runner stage that isn’t there is a 404, and never asks the engine', async () => {
    engineHealthMock.mockResolvedValue('up')
    expect((await one(`${RUN_A}.7.t1`)).status).toBe(404)
    expect((await one(`${RUN_B}.0.t1`)).status).toBe(404) // someone else's run (local runs are userId null)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('local, engine down: a local-only run from the cache, else a 404 — without a request', async () => {
    fsState.existing = JSON.stringify({ p1: { outputs: {} } })
    const res = await one('p1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ p1: { outputs: {} } })
    expect((await one('p2')).status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('local, engine reported up but refusing: the cache answers', async () => {
    engineHealthMock.mockResolvedValue('up')
    fsState.existing = JSON.stringify({ p1: { outputs: {} } })
    const res = await one('p1')
    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('local, engine up: a local-only run is asked of the engine with a timeout', async () => {
    engineHealthMock.mockResolvedValue('up')
    ;(fetch as any).mockImplementation(async () => new Response(JSON.stringify({ p1: { live: true } }), { status: 200 }))
    const res = await one('p1')
    expect(await res.json()).toEqual({ p1: { live: true } })
    expect((fetch as any).mock.calls[0][0]).toBe('http://127.0.0.1:8188/history/p1')
    expect((fetch as any).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('hosted: the caller’s own runner stage; anyone else’s, or an engine id, is a 404 — no engine, no cache', async () => {
    process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_x'
    engineHealthMock.mockResolvedValue('up')
    fsState.existing = JSON.stringify({ p1: { outputs: {} } })
    await setStore([MINE_HOSTED, OTHER_RUN])
    expect((await one(`${RUN_A}.0.t1`, 'user_1')).status).toBe(200)
    expect((await one(`${RUN_B}.0.t1`, 'user_1')).status).toBe(404)
    expect((await one('p1', 'user_1')).status).toBe(404)
    expect((await one(`${RUN_A}.0.t1`, null)).status).toBe(401)
    expect(fetch).not.toHaveBeenCalled()
    expect(engineHealthMock).not.toHaveBeenCalled()
    expect(fsState.reads).toBe(0)
  })
})
