/**
 * Step 3, R10.9 — hosted never reaches the engine. Step 4, C5 — nor does
 * local: there is no engine any more, and the two behave the same.
 *
 * Each mode is switched on the way production switches it (a Clerk secret key
 * in the environment, or none), so every module reads the real deployMode().
 * The real proxy middleware runs inside a real h3 app; `fetch` and the raw
 * proxy are spies. Every engine path — /prompt, /ws, the engine's /history
 * and /view mirrors, /interrupt, /queue, /object_info writes, stats,
 * extensions, settings, userdata, gate resume — answers a plain 404, and
 * nothing opens a request anywhere. The paths that are still answered (the
 * node list, the font subset, media thumbnails and imports) are answered by
 * Sailor itself, again with no request.
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
afterAll(() => {
  if (savedKey === undefined) delete process.env.NUXT_CLERK_SECRET_KEY
  else process.env.NUXT_CLERK_SECRET_KEY = savedKey
})
/** Switch the mode as production does: a Clerk secret key, or none. */
function useMode(mode: 'hosted' | 'local'): void {
  beforeAll(() => {
    if (mode === 'hosted') process.env.NUXT_CLERK_SECRET_KEY = 'sk_test_r10_9_hosted'
    else delete process.env.NUXT_CLERK_SECRET_KEY
  })
}

const { __setInputUploadsEngineRootForTests, __setInputUploadsDbForTests } = await import('../../server/utils/inputUploads')
const middleware = (await import('../../server/middleware/comfyui-proxy')).default as any
const { hostedEngineDecision, normalizeEnginePath, HOSTED_RAW_ALLOW } = await import('../../server/utils/enginePath')
const media = await import('../../server/native/media')
const { runObjectInfo } = await import('../../server/native/objectInfo')

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

for (const mode of ['hosted', 'local'] as const) describe(`${mode} proxy: every engine path is a plain 404`, () => {
  useMode(mode)
  it('in every spelling and verb, and nothing is requested from ComfyUI', async () => {
    for (const [m, p] of ENGINE_PATHS) {
      const r = await call(m, p, m === 'POST' ? JSON.stringify({ prompt: { 1: { class_type: 'SaveImage', inputs: {} } } }) : undefined, { 'content-type': 'application/json' })
      // Locally Sailor's own /object_info route answers another verb as aiohttp did: 405.
      expect(mode === 'local' && /object_info/.test(p) ? [404, 405] : [404], `${m} ${p}`).toContain(r.status)
      expect(JSON.stringify(r.body), `${m} ${p}`).not.toMatch(/ComfyUI|engine/i)
    }
    expect(requested(), 'no request at all').toEqual([])
    expect(proxyRequest, 'nothing raw-proxied').not.toHaveBeenCalled()
  })

  it.runIf(mode === 'hosted')('the decision itself: notFound for each engine-only route, and the raw allow-list is empty', () => {
    expect(HOSTED_RAW_ALLOW).toEqual([])
    for (const [m, p] of ENGINE_PATHS) {
      expect(hostedEngineDecision(normalizeEnginePath(p), m).kind, `${m} ${p}`).toBe('notFound')
    }
  })

  // R10.10 (review L1): odd spellings and the remaining verbs. A spelling the
  // engine would read as one of its routes is refused like the plain one; a
  // spelling aiohttp would not route (it is case-sensitive, and an encoded
  // slash is one literal segment) may instead fall through to Nitro. Either
  // way nothing is proxied and no request leaves for ComfyUI.
  const ODD_PATHS: Array<[string, string]> = [
    ['POST', '//prompt'], ['POST', '/comfyui//prompt'], ['POST', '/PROMPT'], ['POST', '/%2Fprompt'],
    ['HEAD', '/prompt'], ['OPTIONS', '/prompt'], ['HEAD', '/api/prompt'], ['OPTIONS', '/comfyui/api/prompt'],
    ['HEAD', '/queue'], ['OPTIONS', '/interrupt'], ['HEAD', '/system_stats'], ['OPTIONS', '/api/ws'],
  ]

  it('odd spellings and HEAD / OPTIONS never reach ComfyUI', async () => {
    for (const [m, p] of ODD_PATHS) {
      const body = m === 'POST' ? JSON.stringify({ prompt: { 1: { class_type: 'SaveImage', inputs: {} } } }) : undefined
      const r = await call(m, p, body, { 'content-type': 'application/json' })
      const fellThrough = JSON.stringify(r.body) === JSON.stringify({ fallthrough: true })
      expect(r.status === 404 || fellThrough, `${m} ${p}: ${r.status} ${JSON.stringify(r.body)}`).toBe(true)
      if (!fellThrough && m !== 'HEAD') expect(JSON.stringify(r.body), `${m} ${p}`).not.toMatch(/ComfyUI|engine/i)
    }
    expect(requested(), 'no request at all').toEqual([])
    expect(proxyRequest, 'nothing raw-proxied').not.toHaveBeenCalled()
  })

  it('the plain engine routes under HEAD and OPTIONS are a 404 from the proxy itself', async () => {
    for (const m of ['HEAD', 'OPTIONS']) {
      for (const p of ['/prompt', '/api/prompt', '/comfyui/prompt', '/queue', '/interrupt']) {
        const r = await call(m, p)
        expect(r.status, `${m} ${p}`).toBe(404)
      }
    }
    expect(requested()).toEqual([])
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('the node list is served from the stored catalog, scrubbed — never from the engine', async () => {
    for (const p of ['/object_info', '/api/object_info', '/comfyui/object_info/LoadImage']) {
      const r = await call('GET', p)
      expect(r.status, p).toBe(200)
      expect(r.body.LoadImage, p).toBeTruthy()
      // Hosted scrubs the shared input listing; locally it is the input folder's own (empty here).
      expect(r.body.LoadImage.input.required.image[0], `${p}: no shared input listing`).toEqual([])
    }
    expect(requested()).toEqual([])
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('a path that is not an engine path is left to Nitro, never proxied', async () => {
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

for (const mode of ['hosted', 'local'] as const) describe(`${mode} font subset: checked and answered natively`, () => {
  useMode(mode)
  it.skipIf(!fs.existsSync(TTF))('the font is cut to the text and basic Latin, with no request to the engine', async () => {
    const b64 = fs.readFileSync(TTF).toString('base64')
    const r = await call('POST', '/sailor/font_subset', JSON.stringify({ font: b64, text: 'a' }), { 'content-type': 'application/json' })
    expect(r.status).toBe(200)
    expect(r.body.before).toBe(fs.statSync(TTF).size)
    expect(r.body.after).toBeLessThan(r.body.before)
    expect(requested()).toEqual([])
    expect(proxyRequest).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------------------- media

for (const mode of ['hosted', 'local'] as const) describe(`${mode} media: no engine fallback`, () => {
  useMode(mode)
  const ev = (p: string, method = 'GET') => ({ path: p, method, context: { userId: 'u1' } }) as any
  const ctx = () => ({ userDir: path.join(root, 'user'), inputDir: path.join(root, 'input'), outputDir: path.join(root, 'output') })

  it('there is no engine forward any more', () => {
    expect('forwardToEngine' in media).toBe(false)
  })

  it('a video thumbnail the media tools can\'t make is refused in plain words', async () => {
    fs.writeFileSync(path.join(root, 'input', 'clip.mp4'), 'not really a video')
    const p = '/sailor/input_thumbnail?filename=clip.mp4'
    const r = await media.runMediaRoute(ctx(), { name: 'inputThumbnail' }, ev(p), '/sailor/input_thumbnail')
    expect(r).toEqual(media.MEDIA_UNAVAILABLE)
    expect(JSON.stringify(r.body)).not.toMatch(/ComfyUI|engine/i)
    expect(requested()).toEqual([])
  })

  it('a video import is recorded without its length', async () => {
    fs.writeFileSync(path.join(root, 'input', 'clip.mp4'), 'not really a video')
    const raw = Buffer.from(JSON.stringify({ path: 'clip.mp4' }))
    const r = await media.runMediaRoute(ctx(), { name: 'assetImport' }, ev('/sailor/asset_import', 'POST'), '/sailor/asset_import', { value: { path: 'clip.mp4' }, raw })
    expect(r.status).toBe(200)
    expect((r.body as any).asset.path).toBe(path.join(root, 'input', 'clip.mp4'))
    expect(requested()).toEqual([])
  })
})

// --------------------------------------------------------------- object_info

for (const mode of ['hosted', 'local'] as const) describe(`${mode} object_info: the stored catalog only`, () => {
  useMode(mode)
  it('runObjectInfo never asks anything', async () => {
    const r = await runObjectInfo('/object_info/KSampler', '/object_info/KSampler', 'KSampler')
    expect(r.status).toBe(200)
    expect(requested()).toEqual([])
  })
})

// --------------------------------------------------------- no engine at all

describe('no engine health, no engine socket (step 4, C5)', () => {
  it('the engine health module and route are gone', () => {
    const server = path.resolve(__dirname, '..', '..', 'server')
    expect(fs.existsSync(path.join(server, 'native', 'engineHealth.ts'))).toBe(false)
    expect(fs.existsSync(path.join(server, 'api', 'engine', 'health.get.ts'))).toBe(false)
  })

  it('nuxt.config.ts holds no /ws upgrade proxy', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'nuxt.config.ts'), 'utf8')
    expect(src).not.toMatch(/on\('upgrade'|startsWith\('\/ws'\)|8188|comfyOrigin/)
  })
})
