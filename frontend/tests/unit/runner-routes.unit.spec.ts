import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { __setEngineForTests } from '~~/server/runner/index'
import start from '~~/server/api/runs/index.post'
import gate from '~~/server/api/runs/gate.post'
import stop from '~~/server/api/runs/stop.post'
import paused from '~~/server/api/runs/paused.get'
import record from '~~/server/api/runs/record.get'
import falHook from '~~/server/api/webhooks/fal.post'

const engine = {
  startRun: vi.fn(async () => ({ runId: 'run_a', legId: 'run_a.0', promptIds: ['run_a.0.t0'] })),
  gateAction: vi.fn(async () => ({ runId: 'run_a', legId: 'run_a.1', promptIds: ['run_a.1.t0'] })),
  stop: vi.fn(async () => ({ stopped: ['run_a'] })),
  pausedGates: vi.fn(async () => []),
  record: vi.fn(async () => null),
  nudge: vi.fn(() => true),
}

function handler(route: any, userId: string | null = 'user_1') {
  const app = createApp()
  app.use(eventHandler((e) => { if (userId) e.context.userId = userId }))
  app.use(route)
  return toWebHandler(app)
}
const post = (h: any, body: unknown) => h(new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const get = (h: any, qs = '') => h(new Request(`http://x/${qs}`))

beforeEach(() => { process.env.NUXT_RUNNER_ENABLED = 'true'; __setEngineForTests(engine as any); vi.clearAllMocks() })
afterEach(() => { delete process.env.NUXT_RUNNER_ENABLED; __setEngineForTests(null) })

describe('runner routes', () => {
  it('are hidden while the switch is off', async () => {
    delete process.env.NUXT_RUNNER_ENABLED
    expect((await post(handler(start), {})).status).toBe(404)
    expect((await post(handler(falHook), {})).status).toBe(404)
  })
  it('start a run as the signed-in user', async () => {
    const res = await post(handler(start), { takes: [{}], workflow: { a: 1 }, canvasId: 'c1', projectUuid: 'p1', projectName: 'Fox' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ runId: 'run_a', legId: 'run_a.0', promptIds: ['run_a.0.t0'] })
    expect(engine.startRun).toHaveBeenCalledWith({ userId: 'user_1', takes: [{}], workflow: { a: 1 }, canvasId: 'c1', projectUuid: 'p1', projectName: 'Fox' })
  })
  it('pass Gate buttons through with the ticked pictures', async () => {
    await post(handler(gate), { runId: 'run_a', nodeId: '2', action: 'continue', takes: [1, 3] })
    expect(engine.gateAction).toHaveBeenCalledWith({ userId: 'user_1', runId: 'run_a', gateId: '2', action: 'continue', takes: [1, 3] })
    const bad = await post(handler(gate), { runId: 'run_a', nodeId: '2', action: 'explode' })
    expect(bad.status).toBe(400)
  })
  it('stop, paused and record', async () => {
    expect(await (await post(handler(stop), {})).json()).toEqual({ stopped: ['run_a'] })
    expect(engine.stop).toHaveBeenCalledWith('user_1', undefined)
    expect(await (await get(handler(paused), '?canvasId=c1')).json()).toEqual({ gates: [] })
    expect(engine.pausedGates).toHaveBeenCalledWith('user_1', 'c1')
    expect((await get(handler(record), '?promptId=run_a.0.t0')).status).toBe(404)
  })
  it('the fal webhook refuses a call missing any of its four headers before fetching fal\'s keys', async () => {
    const fetchMock = vi.fn(async () => new Response('{"keys":[]}'))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const signed = { 'x-fal-webhook-request-id': 'r1', 'x-fal-webhook-signature': 'ab'.repeat(64) }
      for (const extra of [{}, { 'x-fal-webhook-user-id': 'u' }, { 'x-fal-webhook-timestamp': '1700000000' }]) {
        const res = await handler(falHook, null)(new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json', ...signed, ...extra }, body: '{}' }))
        expect(res.status).toBe(401)
      }
      expect(fetchMock).not.toHaveBeenCalled()
      expect(engine.nudge).not.toHaveBeenCalled()
    }
    finally { vi.unstubAllGlobals() }
  })
  it('the fal webhook ignores unsigned calls', async () => {
    const res = await post(handler(falHook, null), { request_id: 'r1' })
    expect(res.status).toBe(401)
    expect(engine.nudge).not.toHaveBeenCalled()
  })
})
