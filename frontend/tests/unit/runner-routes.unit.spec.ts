import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, eventHandler, toNodeListener, toWebHandler } from 'h3'
import { __setEngineForTests } from '~~/server/runner/index'
import start from '~~/server/api/runs/index.post'
import gate from '~~/server/api/runs/gate.post'
import stop from '~~/server/api/runs/stop.post'
import paused from '~~/server/api/runs/paused.get'
import record from '~~/server/api/runs/record.get'
import events from '~~/server/api/runs/events.get'
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
  it('the event stream sends a named "ready" message at once, so the browser’s EventSource opens without waiting for a ping', async () => {
    // Only the 25 s ping interval is faked (so it never fires, and never leaks);
    // the race timer below stays real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const e = { ...engine, events: { subscribe: vi.fn(() => () => {}) }, snapshot: vi.fn(() => []) }
      __setEngineForTests(e as any)
      const res = await get(handler(events))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/event-stream')
      const reader = res.body!.getReader()
      const first = await Promise.race([
        reader.read().then(r => new TextDecoder().decode(r.value)),
        new Promise<string>(resolve => setTimeout(() => resolve('(nothing within 500 ms)'), 500)),
      ])
      // A named event: the page's onmessage handler (unnamed "message" events only) ignores it.
      expect(first).toBe('event: ready\ndata: {}\n\n')
      expect(e.events.subscribe).toHaveBeenCalledWith('user_1', expect.any(Function))
    }
    finally { vi.useRealTimers() }
  })
  it('over a real Node socket the event stream’s headers and "ready" arrive at once', async () => {
    // toWebHandler has no socket, so h3 hands it the stream with headers already
    // set; a real Node response only sends headers with the first write. This
    // checks that path on an ephemeral local port.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const e = { ...engine, events: { subscribe: vi.fn(() => () => {}) }, snapshot: vi.fn(() => []) }
    __setEngineForTests(e as any)
    const app = createApp()
    app.use(events)
    const server = createServer(toNodeListener(app))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const ctl = new AbortController()
    try {
      const { port } = server.address() as AddressInfo
      const t0 = Date.now()
      const res = await Promise.race([
        fetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal }),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 1000)),
      ])
      expect(res, 'no response headers within 1 s').not.toBeNull()
      expect(res!.headers.get('content-type')).toBe('text/event-stream')
      const { value } = await res!.body!.getReader().read()
      expect(new TextDecoder().decode(value)).toBe('event: ready\ndata: {}\n\n')
      expect(Date.now() - t0).toBeLessThan(1000)
    }
    finally {
      ctl.abort()
      server.closeAllConnections()
      await new Promise(r => server.close(r))
      vi.useRealTimers()
    }
  })
  it('the fal webhook ignores unsigned calls', async () => {
    const res = await post(handler(falHook, null), { request_id: 'r1' })
    expect(res.status).toBe(401)
    expect(engine.nudge).not.toHaveBeenCalled()
  })
})
