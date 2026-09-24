/**
 * The media routes through the native dispatcher (server/native/router.ts),
 * driven through a real h3 app against a temp engine root: aiohttp's route
 * table (paths, verbs, 404/405), the thumbnail's bytes and headers, and the
 * hand-off to the local engine for video/audio — 503 when it is not there.
 * `fetch` is stubbed in every test, so nothing here can reach a real engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The cached engine-health check (server/native/engineHealth.ts) is stubbed:
// its 3 s process-wide cache would otherwise carry one test's engine state
// into the next, and a real probe would reach whatever is on :8188. 'up'
// (the default) defers to each test's own fetch stub, as before the check.
const engineHealthState = vi.hoisted(() => ({ value: 'up' as 'up' | 'down' }))
vi.mock('../../server/native/engineHealth', async orig => ({
  ...(await orig() as object),
  engineHealth: async () => engineHealthState.value,
}))
beforeEach(() => { engineHealthState.value = 'up' })
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { __setInputUploadsEngineRootForTests, resolveEngineRoot } from '../../server/utils/inputUploads'
import { nativeEngineRoute, nativeEnginePath } from '../../server/native/router'
import { pyDumps } from '../../server/native/pyJson'

let root: string
const engineFetch = vi.fn()

const app = createApp()
app.use(eventHandler(async (e) => {
  const r = await nativeEngineRoute(e)
  if (r !== undefined) return r
}))
app.use(eventHandler(() => ({ fallthrough: true })))
const handler = toWebHandler(app)

async function call(method: string, p: string, raw?: string) {
  const init: RequestInit = { method }
  if (raw !== undefined) {
    init.body = raw
    init.headers = { 'content-type': 'application/json' }
  }
  const res = await handler(new Request(`http://x${p}`, init))
  const buf = Buffer.from(await res.arrayBuffer())
  let body: any = buf.toString('utf8')
  try { body = JSON.parse(body) }
  catch {}
  return { status: res.status, body, buf, headers: res.headers }
}

const engineDown = () => engineFetch.mockRejectedValue(new TypeError('fetch failed'))
function engineAnswers(body: unknown, type = 'application/json; charset=utf-8', status = 200) {
  engineFetch.mockResolvedValue(new Response(typeof body === 'string' || Buffer.isBuffer(body) ? body as any : JSON.stringify(body), { status, headers: { 'content-type': type } }))
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-media-router-')))
  for (const d of ['input', 'output', 'user']) fs.mkdirSync(path.join(root, d))
  __setInputUploadsEngineRootForTests(root)
  vi.stubGlobal('fetch', engineFetch)
  engineFetch.mockReset()
  engineDown()
})
afterEach(() => {
  vi.unstubAllGlobals()
  __setInputUploadsEngineRootForTests(undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

it('the tests run against the temp engine root, never the real one', () => {
  expect(resolveEngineRoot()).toBe(root)
})

describe('which media paths are native', () => {
  it('owns every media route under every engine spelling', () => {
    for (const p of ['/sailor/output_listing', '/sailor/input_listing', '/sailor/input_file', '/sailor/output_file', '/sailor/assets', '/sailor/assets/abc', '/sailor/asset_import', '/sailor/input_thumbnail', '/sailor/asset_thumbnails', '/sailor/asset_waveform']) {
      for (const spelling of [p, `/api${p}`, `/comfyui${p}`, `/comfyui/api${p}`]) expect(nativeEnginePath(`${spelling}?x=1`), spelling).toBe(p)
    }
  })

  it('leaves other /sailor routes to the proxy', () => {
    for (const p of ['/sailor/spacetype_encode', '/sailor/render_timeline', '/sailor/assetsx', '/sailor/input_listings']) expect(nativeEnginePath(p), p).toBeNull()
  })
})

describe('the aiohttp route table', () => {
  it('a wrong verb is aiohttp\'s plain-text 405, an unknown subpath its 404', async () => {
    for (const [m, p] of [['POST', '/sailor/assets'], ['GET', '/sailor/input_file'], ['GET', '/sailor/asset_import'], ['GET', '/sailor/assets/abc'], ['DELETE', '/sailor/output_listing']]) {
      const r = await call(m!, p!)
      expect([r.status, r.body], `${m} ${p}`).toEqual([405, '405: Method Not Allowed'])
    }
    for (const p of ['/sailor/input_listing/x', '/sailor/assets/a/b', '/sailor/assets/', '/sailor/assets/%7Bx%7D']) {
      const r = await call('DELETE', p)
      expect([r.status, r.body], p).toEqual([404, '404: Not Found'])
    }
  })

  it('lists input and output, HEAD included', async () => {
    fs.writeFileSync(path.join(root, 'input', 'a.png'), 'x')
    fs.mkdirSync(path.join(root, 'output', 'sub'))
    fs.writeFileSync(path.join(root, 'output', 'sub', 'b.mp4'), 'xy')
    const i = await call('GET', '/api/sailor/input_listing')
    expect(i.body.items).toEqual([expect.objectContaining({ filename: 'a.png', path: path.join(root, 'input', 'a.png'), type: 'input', size: 1 })])
    const o = await call('GET', '/comfyui/sailor/output_listing')
    expect(o.body.items).toEqual([expect.objectContaining({ filename: 'b.mp4', subfolder: 'sub', type: 'output', size: 2 })])
    expect((await call('HEAD', '/sailor/output_listing')).status).toBe(200)
  })

  it('deletes read filename and subfolder from the query', async () => {
    fs.mkdirSync(path.join(root, 'output', 'my sub'))
    fs.writeFileSync(path.join(root, 'output', 'my sub', 'a b.png'), 'x')
    expect((await call('DELETE', '/sailor/output_file?filename=a+b.png&subfolder=my%20sub')).body).toEqual({ ok: true })
    expect(fs.existsSync(path.join(root, 'output', 'my sub', 'a b.png'))).toBe(false)
    expect(await call('DELETE', '/sailor/input_file?filename=../output/x.png')).toMatchObject({ status: 400, body: { error: 'invalid filename' } })
    expect((await call('DELETE', '/sailor/input_file?filename=ghost.png')).body).toEqual({ ok: true, missing: true })
  })

  it('the asset library: import, list, delete by (decoded) id', async () => {
    await sharp({ create: { width: 20, height: 10, channels: 3, background: '#000' } }).png().toFile(path.join(root, 'input', 'still.png'))
    const imp = await call('POST', '/sailor/asset_import', JSON.stringify({ path: 'still.png' }))
    expect(imp.status).toBe(200)
    expect(imp.body.asset).toMatchObject({ kind: 'image', width: 20, height: 10 })
    expect((await call('GET', '/sailor/assets')).body).toEqual({ assets: [imp.body.asset] })
    expect((await call('DELETE', `/sailor/assets/${encodeURIComponent(imp.body.asset.id)}`)).body).toEqual({ ok: true })
    expect((await call('GET', '/sailor/assets')).body).toEqual({ assets: [] })
    expect(engineFetch).not.toHaveBeenCalled()
  })

  it('asset_import: bad json is 400, a non-object body is aiohttp\'s 500', async () => {
    expect(await call('POST', '/sailor/asset_import', '{nope')).toMatchObject({ status: 400 })
    expect((await call('POST', '/sailor/asset_import', '{nope')).body.error).toMatch(/^bad json: /)
    const r = await call('POST', '/sailor/asset_import', '[1]')
    expect([r.status, r.body]).toEqual([500, '500 Internal Server Error\n\nServer got itself in trouble'])
  })
})

describe('thumbnails', () => {
  it('input_thumbnail answers PNG bytes with the Python\'s headers', async () => {
    await sharp({ create: { width: 96, height: 48, channels: 3, background: '#f00' } }).png().toFile(path.join(root, 'input', 'a.png'))
    const r = await call('GET', '/sailor/input_thumbnail?filename=a.png')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('cache-control')).toBe('max-age=86400')
    const meta = await sharp(r.buf).metadata()
    expect([meta.width, meta.height]).toEqual([96, 48])
    expect(fs.readdirSync(path.join(root, 'user', 'timeline_thumbs'))).toHaveLength(1)
  })

  it('an unknown input file is an empty 404', async () => {
    const r = await call('GET', '/sailor/input_thumbnail?filename=missing.png')
    expect([r.status, r.body]).toEqual([404, ''])
  })
})

describe('video and audio need the local engine', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(root, 'input', 'clip.mp4'), 'not really a video')
    fs.writeFileSync(path.join(root, 'user', 'timeline_assets.json'), pyDumps([
      { id: 'vid', path: path.join(root, 'input', 'clip.mp4'), kind: 'video' },
    ], 2))
  })

  it('with the engine down: 503 "This needs the local engine" for thumbnails and waveforms', async () => {
    for (const p of ['/sailor/input_thumbnail?filename=clip.mp4', '/sailor/asset_thumbnails?asset_id=vid', '/sailor/asset_waveform?asset_id=vid']) {
      const r = await call('GET', p)
      expect([r.status, r.body], p).toEqual([503, { error: 'This needs the local engine' }])
    }
  })

  it('with the engine down, an import still records the asset (no duration, no size)', async () => {
    fs.writeFileSync(path.join(root, 'input', 'new.webm'), 'x')
    const r = await call('POST', '/sailor/asset_import', JSON.stringify({ path: 'new.webm' }))
    expect(r.status).toBe(200)
    expect(r.body.asset).toMatchObject({ kind: 'video', duration_sec: null, width: null, height: null })
  })

  it('with the engine up, the request goes to it unchanged — same worker, path and query — and its answer comes back', async () => {
    engineAnswers({ thumbnails: ['data:engine'], asset_id: 'vid', count: 4 })
    const r = await call('GET', '/comfyui/api/sailor/asset_thumbnails?asset_id=vid&count=4&comfyWorker=2')
    expect(r.body).toEqual({ thumbnails: ['data:engine'], asset_id: 'vid', count: 4 })
    expect(engineFetch).toHaveBeenCalledTimes(1)
    const [url, init] = engineFetch.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:8191/sailor/asset_thumbnails?asset_id=vid&count=4')
    expect(init).toMatchObject({ method: 'GET', headers: { origin: 'http://127.0.0.1:8191' } })
  })

  it('an engine thumbnail keeps its bytes and headers', async () => {
    engineFetch.mockResolvedValue(new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' } }))
    const r = await call('GET', '/sailor/input_thumbnail?filename=clip.mp4')
    expect([...r.buf]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(r.headers.get('cache-control')).toBe('max-age=86400')
  })

  it('the main engine already known down (cached health): no forward, the plain 503', async () => {
    engineHealthState.value = 'down'
    engineFetch.mockResolvedValue(new Response(Buffer.from([0x89]), { status: 200, headers: { 'content-type': 'image/png' } }))
    const r = await call('GET', '/sailor/input_thumbnail?filename=clip.mp4')
    expect(r.status).toBe(503)
    expect(r.body).toEqual({ error: 'This needs the local engine' })
    expect(engineFetch).not.toHaveBeenCalled()
  })

  it('an import forwards the same body to the engine', async () => {
    engineAnswers({ asset: { id: 'e1' }, created: true })
    const body = JSON.stringify({ path: 'clip.mp4' })
    const r = await call('POST', '/sailor/asset_import', body)
    expect(r.body).toEqual({ asset: { id: 'e1' }, created: true })
    const [url, init] = engineFetch.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:8188/sailor/asset_import')
    expect(init.method).toBe('POST')
    expect(Buffer.from(init.body).toString()).toBe(body)
  })

  // A2 follow-up fix, item 1: the engine forward had no timeout at all —
  // a stuck ComfyUI process would hang the request open indefinitely.
  it('thumbnails/waveforms carry a 30s abort timeout; asset_import carries 120s', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    engineAnswers({ thumbnails: [] })
    await call('GET', '/sailor/asset_thumbnails?asset_id=vid')
    await call('GET', '/sailor/asset_waveform?asset_id=vid')
    await call('GET', '/sailor/input_thumbnail?filename=clip.mp4')
    expect(spy.mock.calls.filter(c => c[0] === 30_000).length).toBeGreaterThanOrEqual(3)

    spy.mockClear()
    fs.writeFileSync(path.join(root, 'input', 'new2.webm'), 'x')
    engineAnswers({ asset: { id: 'e2' }, created: true })
    await call('POST', '/sailor/asset_import', JSON.stringify({ path: 'new2.webm' }))
    expect(spy).toHaveBeenCalledWith(120_000)
    spy.mockRestore()
  })

  it('an abort/timeout from the engine is treated exactly like the engine being down (503 / null-field)', async () => {
    engineFetch.mockRejectedValue(new DOMException('The operation was aborted', 'TimeoutError'))
    const r = await call('GET', '/sailor/asset_thumbnails?asset_id=vid')
    expect([r.status, r.body]).toEqual([503, { error: 'This needs the local engine' }])

    fs.writeFileSync(path.join(root, 'input', 'new3.webm'), 'x')
    const imp = await call('POST', '/sailor/asset_import', JSON.stringify({ path: 'new3.webm' }))
    expect(imp.status).toBe(200)
    expect(imp.body.asset).toMatchObject({ kind: 'video', duration_sec: null })
  })
})
