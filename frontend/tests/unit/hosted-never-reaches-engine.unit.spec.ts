/**
 * Step 3, R10.9 — hosted never reaches the engine.
 *
 * Hosted is switched on the way production switches it on (a Clerk secret
 * key in the environment), so every module reads the real deployMode(). The
 * real proxy middleware runs inside a real h3 app; `fetch` and the raw proxy
 * are spies. Every engine path — /prompt, /ws, the engine's /history and
 * /view mirrors, /interrupt, /queue, /object_info writes, stats, extensions,
 * settings, userdata, gate resume — answers a plain 404, and nothing opens a
 * request to ComfyUI. The paths that are still answered (the node list, the
 * font subset, media thumbnails and imports, the engine health check) are
 * answered by Sailor itself, again with no request to the engine.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, createError, eventHandler, toWebHandler } from 'h3'

// Sailor's own media tools are off here, so a video read is the case that used
// to fall back to the engine.
vi.mock('../../server/media/tools', async (orig) => {
  const real = await orig() as object
  return { ...real, mediaTools: async () => null }
})

const g = globalThis as any
g.defineEventHandler = eventHandler
g.createError = createError
const proxyRequest = vi.fn(async (_e: unknown, url: string) => ({ proxiedTo: url }))
g.proxyRequest = proxyRequest

const fetchSpy = vi.fn(async (..._a: unknown[]) => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))

const savedKey = process.env.NUXT_CLERK_SECRET_KEY
beforeAll(() => { process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_r10_9_hosted' })
afterAll(() => {
  if (savedKey === undefined) delete process.env.NUXT_CLERK_SECRET_KEY
  else process.env.NUXT_CLERK_SECRET_KEY = savedKey
})

const { __setInputUploadsEngineRootForTests, __setInputUploadsDbForTests } = await import('../../server/utils/inputUploads')
const middleware = (await import('../../server/middleware/comfyui-proxy')).default as any
const { hostedEngineDecision, normalizeEnginePath, HOSTED_RAW_ALLOW } = await import('../../server/utils/enginePath')
const { createEngineHealth, engineHealth, probeEngine } = await import('../../server/native/engineHealth')
const media = await import('../../server/native/media')
const { objectInfoBody, runObjectInfo } = await import('../../server/native/objectInfo')

const app = createApp()
app.use(eventHandler((e) => { e.context.userId = 'u1' }))
app.use(eventHandler(middleware))
app.use(eventHandler(() => ({ fallthrough: true })))
const handler = toWebHandler(app)

async function call(method: string, p: string, body?: string, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers }
  if (body !== undefined) init.body = body
  const res = await handler(new Request(`http://x${p}`, init))
  const text = await res.text()
  let parsed: any = text
  try { parsed = JSON.parse(text) }
  catch {}
  return { status: res.status, body: parsed }
}

let root: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-never-engine-')))
  for (const d of ['input', 'output', 'user', 'models']) fs.mkdirSync(path.join(root, d))
  __setInputUploadsEngineRootForTests(root)
  __setInputUploadsDbForTests({ async query() { return { rows: [] } } } as any)
  vi.stubGlobal('fetch', fetchSpy)
  fetchSpy.mockClear()
  proxyRequest.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  __setInputUploadsEngineRootForTests(undefined)
  __setInputUploadsDbForTests(null as any)
  fs.rmSync(root, { recursive: true, force: true })
})

/** Every request any test made, as URLs. */
const requested = () => fetchSpy.mock.calls.map(c => String(c[0]))

// ------------------------------------------------------------------ the proxy

const ENGINE_PATHS: Array<[string, string]> = [
  // running a graph, in every spelling and verb
  ['POST', '/prompt'], ['POST', '/api/prompt'], ['POST', '/comfyui/prompt'], ['POST', '/comfyui/api/prompt'], ['GET', '/prompt'], ['DELETE', '/prompt'],
  // the socket over HTTP
  ['GET', '/comfyui/ws'], ['GET', '/api/ws?clientId=x'], ['GET', '/comfyui/api/ws'],
  // the engine's history and file mirrors (the canonical /history and /view are Sailor's own routes)
  ['GET', '/api/history'], ['GET', '/comfyui/history/abc'], ['POST', '/api/history'], ['GET', '/api/view?filename=a.png'],
  // Stop and the queue
  ['POST', '/interrupt'], ['POST', '/api/interrupt'], ['GET', '/queue'], ['POST', '/queue'], ['DELETE', '/comfyui/api/queue'],
  // the node list is read-only
  ['POST', '/object_info'], ['DELETE', '/comfyui/object_info/LoadImage'],
  // stats, extensions, internals, gate resume, settings, userdata, anything unaudited
  ['GET', '/system_stats'], ['GET', '/api/system_stats'], ['GET', '/extensions/core/foo.js'], ['GET', '/comfyui/extensions'],
  ['GET', '/comfyui/internal/logs'], ['POST', '/gate/resume'], ['POST', '/api/gate/resume'],
  ['GET', '/comfyui/settings'], ['POST', '/api/settings/Comfy.Locale'], ['GET', '/api/userdata/a.json'], ['GET', '/comfyui/api/v2/userdata'],
  ['GET', '/comfyui/models/checkpoints'], ['POST', '/comfyui/free'],
  // dot segments folding onto an engine route
  ['GET', '/extensions/../queue'], ['POST', '/extensions/%2e%2e/prompt'],
]

describe('hosted proxy: every engine path is a plain 404', () => {
  it('in every spelling and verb, and nothing is requested from ComfyUI', async () => {
    for (const [m, p] of ENGINE_PATHS) {
      const r = await call(m, p, m === 'POST' ? JSON.stringify({ prompt: { 1: { class_type: 'SaveImage', inputs: {} } } }) : undefined, { 'content-type': 'application/json' })
      expect(r.status, `${m} ${p}`).toBe(404)
      expect(JSON.stringify(r.body), `${m} ${p}`).not.toMatch(/ComfyUI|engine/i)
    }
    expect(requested(), 'no request at all').toEqual([])
    expect(proxyRequest, 'nothing raw-proxied').not.toHaveBeenCalled()
  })

  it('the decision itself: notFound for each engine-only route, and the raw allow-list is empty', () => {
    expect(HOSTED_RAW_ALLOW).toEqual([])
    for (const [m, p] of ENGINE_PATHS) {
      expect(hostedEngineDecision(normalizeEnginePath(p), m).kind, `${m} ${p}`).toBe('notFound')
    }
  })

  it('the node list is served from the stored catalog, scrubbed — never from the engine', async () => {
    for (const p of ['/object_info', '/api/object_info', '/comfyui/object_info/LoadImage']) {
      const r = await call('GET', p)
      expect(r.status, p).toBe(200)
      expect(r.body.LoadImage, p).toBeTruthy()
      expect(r.body.LoadImage.input.required.image[0], `${p}: no shared input listing`).toEqual([])
    }
    expect(requested()).toEqual([])
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('a hosted path that is not an engine path is left to Nitro, never proxied', async () => {
    for (const p of ['/api/wallet', '/history', '/view?filename=a.png', '/settings']) {
      const r = await call('GET', p)
      expect(r.body, p).toEqual({ fallthrough: true })
    }
    expect(proxyRequest).not.toHaveBeenCalled()
    expect(requested()).toEqual([])
  })
})

// ------------------------------------------------------------ the font subset

const TTF = path.resolve(__dirname, '..', '..', '..', 'Assets', 'Fonts', 'Free Fonts', 'Aspekta', 'Aspekta-400.ttf')

describe('hosted font subset: checked and answered natively', () => {
  it.skipIf(!fs.existsSync(TTF))('the font comes back whole, with no request to the engine', async () => {
    const b64 = fs.readFileSync(TTF).toString('base64')
    const r = await call('POST', '/sailor/font_subset', JSON.stringify({ font: b64, text: 'a' }), { 'content-type': 'application/json' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ font: b64, before: fs.statSync(TTF).size, after: fs.statSync(TTF).size })
    expect(requested()).toEqual([])
    expect(proxyRequest).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------------------- media

describe('hosted media: no engine fallback', () => {
  const ev = (p: string, method = 'GET') => ({ path: p, method, context: { userId: 'u1' } }) as any
  const ctx = () => ({ userDir: path.join(root, 'user'), inputDir: path.join(root, 'input'), outputDir: path.join(root, 'output') })

  it('forwardToEngine answers null without a request', async () => {
    expect(await media.forwardToEngine(ev('/sailor/input_thumbnail?filename=clip.mp4'), '/sailor/input_thumbnail')).toBeNull()
    expect(requested()).toEqual([])
  })

  it('a video thumbnail the media tools can\'t make is refused in plain words', async () => {
    fs.writeFileSync(path.join(root, 'input', 'clip.mp4'), 'not really a video')
    const p = '/sailor/input_thumbnail?filename=clip.mp4'
    const r = await media.runMediaRoute(ctx(), { name: 'inputThumbnail' }, ev(p), '/sailor/input_thumbnail')
    expect(r).toEqual(media.HOSTED_MEDIA_UNAVAILABLE)
    expect(JSON.stringify(r.body)).not.toMatch(/ComfyUI|engine/i)
    expect(requested()).toEqual([])
  })

  it('a video import is recorded without its length, as with the engine down', async () => {
    fs.writeFileSync(path.join(root, 'input', 'clip.mp4'), 'not really a video')
    const raw = Buffer.from(JSON.stringify({ path: 'clip.mp4' }))
    const r = await media.runMediaRoute(ctx(), { name: 'assetImport' }, ev('/sailor/asset_import', 'POST'), '/sailor/asset_import', { value: { path: 'clip.mp4' }, raw })
    expect(r.status).toBe(200)
    expect((r.body as any).asset.path).toBe(path.join(root, 'input', 'clip.mp4'))
    expect(requested()).toEqual([])
  })
})

// --------------------------------------------------------------- object_info

describe('hosted object_info: the stored catalog only', () => {
  it('objectInfoBody and runObjectInfo never ask the engine', async () => {
    const got = await objectInfoBody('/object_info', '/object_info', null)
    expect(got?.source).not.toBe('engine')
    const r = await runObjectInfo('/object_info/KSampler', '/object_info/KSampler', 'KSampler')
    expect(r.status).toBe(200)
    expect(requested()).toEqual([])
  })
})

// -------------------------------------------------------------- engine health

describe('hosted engine health: down, with no request', () => {
  it('createEngineHealth answers down without probing', async () => {
    const probe = vi.fn(async () => true)
    const health = createEngineHealth({ probe })
    expect(await health()).toBe('down')
    expect(await health()).toBe('down')
    expect(probe).not.toHaveBeenCalled()
  })

  it('the process-wide check and the probe make no request', async () => {
    expect(await engineHealth()).toBe('down')
    expect(await probeEngine(fetchSpy as unknown as typeof fetch)).toBe(false)
    expect(requested()).toEqual([])
  })

  it('locally the probe still runs (the decision-4 path keeps working)', async () => {
    const probe = vi.fn(async () => true)
    const health = createEngineHealth({ probe, hosted: () => false })
    expect(await health()).toBe('up')
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

// ------------------------------------------------------------- the socket

describe('hosted /ws upgrade: refused before any socket to the engine', () => {
  it('the dev upgrade handler answers 404 when a Clerk key is set, before proceed() opens the socket', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'nuxt.config.ts'), 'utf8')
    const refuse = src.indexOf("socket.write('HTTP/1.1 404 Not Found")
    const gate = src.lastIndexOf('process.env.NUXT_CLERK_SECRET_KEY', refuse)
    const proceedCall = src.indexOf('proceed()\n', refuse)
    expect(gate).toBeGreaterThan(0)
    expect(refuse).toBeGreaterThan(gate)
    expect(proceedCall).toBeGreaterThan(refuse)
    // No hosted branch authenticates and then proxies any more.
    expect(src).not.toMatch(/authenticateRequest|wsAuthClerkClient/)
  })
})
