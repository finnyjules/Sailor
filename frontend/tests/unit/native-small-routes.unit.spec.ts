/**
 * The small /sailor routes through the native dispatcher
 * (server/native/router.ts → smallRoutes.ts), driven through a real h3 app
 * against a temp engine root: aiohttp's route table (paths, verbs, 404/405,
 * the /api and /comfyui spellings), each route's shape and guards, the shader
 * asset's headers and conditional GET, a font subset that holds every
 * requested character, and models/download's hand-off — proxied when the
 * engine answers, 503 when it does not. `fetch` is stubbed in every test, so
 * nothing here can reach a real engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as fontkit from 'fontkit'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { __setInputUploadsEngineRootForTests, resolveEngineRoot } from '../../server/utils/inputUploads'
import { nativeEngineRoute, nativeEnginePath } from '../../server/native/router'
import { strictB64Decode } from '../../server/native/fontSubset'
import { SLATE_FRAME_RE } from '../../server/native/inputHousekeeping'

let root: string
const engineFetch = vi.fn()

const app = createApp()
app.use(eventHandler(async (e) => {
  const r = await nativeEngineRoute(e)
  if (r !== undefined) return r
}))
app.use(eventHandler(() => ({ fallthrough: true })))
const handler = toWebHandler(app)

async function call(method: string, p: string, body?: string | Buffer, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers }
  if (body !== undefined) init.body = body as any
  const res = await handler(new Request(`http://x${p}`, init))
  const buf = Buffer.from(await res.arrayBuffer())
  let parsed: any = buf.toString('utf8')
  try { parsed = JSON.parse(parsed) }
  catch {}
  return { status: res.status, body: parsed, buf, headers: res.headers }
}
const post = (p: string, value: unknown) => call('POST', p, JSON.stringify(value), { 'content-type': 'application/json' })

const REPO = path.resolve(__dirname, '..', '..', '..')
const TTF = path.join(REPO, 'Assets', 'Fonts', 'Free Fonts', 'Aspekta', 'Aspekta-400.ttf')
const OTF = path.join(REPO, 'Assets', 'Fonts', 'Free Fonts', 'Absans', 'Absans-Regular.otf')

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-small-routes-')))
  for (const d of ['input', 'output', 'user', 'models']) fs.mkdirSync(path.join(root, d))
  __setInputUploadsEngineRootForTests(root)
  vi.stubGlobal('fetch', engineFetch)
  engineFetch.mockReset()
  engineFetch.mockRejectedValue(new TypeError('fetch failed'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  __setInputUploadsEngineRootForTests(undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

it('these tests serve from a temp engine root, never the real folders', () => {
  expect(resolveEngineRoot()).toBe(root)
})

function catalog(manifest: unknown = { version: 2, effects: [{ id: 'wave', name: 'Wave', category: 'distortion', animated: true, passes: 1, textures: [{ file: 'noise.png', uniform: 'u_noise' }], params: [{ uniform: 'u_a', label: 'Amount', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, showWhen: { uniform: 'u_b', equals: 1 } }] }] }) {
  const dir = path.join(root, 'shader_effects')
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(dir, 'wave.frag'), 'void main() {}\r\n')
  fs.writeFileSync(path.join(dir, 'assets', 'noise.png'), Buffer.from('89504e47', 'hex'))
  fs.utimesSync(path.join(dir, 'assets', 'noise.png'), 1_790_000_000.25, 1_790_000_000.25)
  return dir
}

describe('the route table', () => {
  it('every route is native under every engine spelling', () => {
    for (const p of ['/sailor/shader_effects', '/api/sailor/space_defaults', '/comfyui/sailor/font_subset', '/comfyui/api/sailor/models/status',
      '/sailor/lora/save_captions', '/sailor/motion/cleanup_frames', '/sailor/space_thumbnail/ball', '/sailor/models/download?key=x']) {
      expect(nativeEnginePath(p), p).not.toBeNull()
    }
    expect(nativeEnginePath('/sailor/render_timeline')).toBeNull()
    expect(nativeEnginePath('/sailor/spacetype_encode')).toBeNull()
  })

  it('aiohttp\'s 404 and 405 inside the owned namespaces; HEAD is GET', async () => {
    catalog()
    for (const p of ['/sailor/lora/other', '/sailor/shader_effects/', '/sailor/shader_effects/other/x', '/sailor/space_default',
      '/sailor/space_thumbnail/', '/sailor/models', '/sailor/motion/x', '/sailor/space_thumbnail/a/b']) {
      const r = await call('GET', p)
      expect(r.status, p).toBe(404)
      expect(r.body, p).toBe('404: Not Found')
    }
    for (const [m, p] of [['GET', '/sailor/font_subset'], ['POST', '/sailor/shader_effects'], ['DELETE', '/sailor/space_thumbnail/ball'],
      ['POST', '/sailor/models/status'], ['GET', '/sailor/lora/clear_dataset'], ['GET', '/sailor/space_default/ball'], ['PUT', '/sailor/space_defaults']]) {
      const r = await call(m!, p!)
      expect(r.status, `${m} ${p}`).toBe(405)
      expect(r.body, `${m} ${p}`).toBe('405: Method Not Allowed')
    }
    expect((await call('HEAD', '/sailor/shader_effects')).status).toBe(200)
  })
})

describe('shader_effects', () => {
  it('serves the catalog with the frag inlined (universal newlines), params in dataclass order with camelCase names', async () => {
    catalog()
    const r = await call('GET', '/api/sailor/shader_effects')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      version: 2,
      effects: [{
        id: 'wave', name: 'Wave', category: 'distortion', animated: true, passes: 1, generative: false, followsShape: false, centerParam: null,
        textures: [{ file: 'noise.png', uniform: 'u_noise', v: '1790000000' }],
        params: [{ uniform: 'u_a', label: 'Amount', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01, options: null, maxStops: 8, showWhen: { uniform: 'u_b', equals: 1 } }],
        source: 'void main() {}\n',
      }],
    })
    expect(Object.keys(r.body.effects[0].params[0])).toEqual(['uniform', 'label', 'type', 'default', 'min', 'max', 'step', 'options', 'maxStops', 'showWhen'])
  })

  it('a broken manifest is a 500 with the reason', async () => {
    catalog({ version: 1, effects: [{ id: 'wave', name: 'W', category: 'c', animated: false, params: [{ uniform: 'u', label: 'l', type: 'float', default: 5, min: 0, max: 1 }] }] })
    const r = await call('GET', '/sailor/shader_effects')
    expect(r).toMatchObject({ status: 500, body: { error: 'shader_effects \'wave\': default for u outside [min, max]' } })
    fs.rmSync(path.join(root, 'shader_effects', 'manifest.json'))
    expect((await call('GET', '/sailor/shader_effects')).status).toBe(500)
  })

  it('an asset: FileResponse headers (no-cache, ETag, Last-Modified), then 304 on revalidation', async () => {
    const dir = catalog()
    const st = fs.statSync(path.join(dir, 'assets', 'noise.png'), { bigint: true })
    const etag = `"${st.mtimeNs.toString(16)}-${st.size.toString(16)}"`
    const r = await call('GET', '/sailor/shader_effects/assets/noise.png')
    expect(r.status).toBe(200)
    expect(r.buf).toEqual(Buffer.from('89504e47', 'hex'))
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('cache-control')).toBe('no-cache')
    expect(r.headers.get('etag')).toBe(etag)
    expect(r.headers.get('last-modified'), 'aiohttp rounds the mtime up').toBe(new Date(1_790_000_001_000).toUTCString())
    expect(r.headers.get('accept-ranges')).toBe('bytes')

    const again = await call('GET', '/sailor/shader_effects/assets/noise.png', undefined, { 'if-none-match': etag })
    expect(again.status).toBe(304)
    expect(again.buf.length).toBe(0)
    expect((await call('GET', '/sailor/shader_effects/assets/noise.png', undefined, { 'if-none-match': '"other"' })).status).toBe(200)
    expect((await call('GET', '/sailor/shader_effects/assets/noise.png', undefined, { 'if-modified-since': r.headers.get('last-modified')! })).status).toBe(304)
    expect((await call('GET', '/sailor/shader_effects/assets/noise.png', undefined, { 'if-modified-since': new Date(1_790_000_000_000).toUTCString() })).status, 'mtime .25 s past the date').toBe(200)
    expect((await call('GET', '/sailor/shader_effects/assets/noise.png', undefined, { 'if-modified-since': new Date(1_700_000_000_000).toUTCString() })).status).toBe(200)

    fs.writeFileSync(path.join(dir, 'assets', 'atlas.json'), '{}')
    fs.writeFileSync(path.join(dir, 'assets', 'bake.py'), '#')
    fs.writeFileSync(path.join(dir, 'assets', 'blob.xyz'), 'x')
    expect((await call('GET', '/sailor/shader_effects/assets/atlas.json')).headers.get('content-type')).toBe('application/json')
    expect((await call('GET', '/sailor/shader_effects/assets/bake.py')).headers.get('content-type')).toBe('text/x-python')
    expect((await call('GET', '/sailor/shader_effects/assets/blob.xyz')).headers.get('content-type')).toBe('application/octet-stream')
  })

  it('an asset name cannot leave the assets folder', async () => {
    catalog()
    fs.writeFileSync(path.join(root, 'secret.txt'), 'x')
    for (const name of ['..', '.', '%2E%2E', '..%2Fmanifest.json', '%2E%2E%2F%2E%2E%2Fsecret.txt', 'missing.png']) {
      const r = await call('GET', `/sailor/shader_effects/assets/${name}`)
      expect(r.status, name).toBe(404)
    }
    // Dot segments fold before routing: this is /sailor/shader_effects/manifest.json, not a route.
    expect((await call('GET', '/sailor/shader_effects/assets/../manifest.json')).status).toBe(404)
  })
})

describe('Space Type presets and thumbnails', () => {
  const bridge = () => path.join(root, 'custom_nodes', 'sailor_bridge')

  it('save a preset, list it; the file is written the way json.dump(indent=2) writes it', async () => {
    expect(await post('/sailor/space_default/burst', { text: 'é', n: [1, 2] })).toMatchObject({ status: 200, body: { ok: true } })
    expect(fs.readFileSync(path.join(bridge(), 'scene_defaults', 'burst.json'), 'utf8')).toBe('{\n  "text": "\\u00e9",\n  "n": [\n    1,\n    2\n  ]\n}')
    expect((await call('GET', '/sailor/space_defaults')).body).toEqual({ burst: { text: 'é', n: [1, 2] } })
  })

  it('refuses a bad id before reading the body, bad JSON, and a non-object', async () => {
    expect(await call('POST', '/sailor/space_default/Bad-Id', '{bad')).toMatchObject({ status: 400, body: { error: 'invalid effect id' } })
    const bad = await call('POST', '/sailor/space_default/ok', '{bad')
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/^bad json: /)
    expect(await post('/sailor/space_default/ok', [1])).toMatchObject({ status: 400, body: { error: 'scene must be an object' } })
    expect(fs.existsSync(path.join(bridge(), 'scene_defaults', 'ok.json'))).toBe(false)
  })

  it('thumbnails: raw PNG in, listed with the whole-second mtime, served as image/png', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    expect(await call('POST', '/sailor/space_thumbnail/ball', png, { 'content-type': 'image/png' })).toMatchObject({ status: 200, body: { ok: true } })
    const file = path.join(bridge(), 'scene_thumbnails', 'ball.png')
    fs.utimesSync(file, 1_790_000_123.9, 1_790_000_123.9)
    expect((await call('GET', '/sailor/space_thumbnails')).body).toEqual({ ball: '/sailor/space_thumbnail/ball?v=1790000123' })
    const r = await call('GET', '/sailor/space_thumbnail/ball?v=1790000123')
    expect(r.status).toBe(200)
    expect(r.buf).toEqual(png)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(await call('GET', '/sailor/space_thumbnail/nope')).toMatchObject({ status: 404, body: { error: 'not found' } })
    expect(await call('GET', '/sailor/space_thumbnail/a.b')).toMatchObject({ status: 400, body: { error: 'invalid effect id' } })
    expect(await call('POST', '/sailor/space_thumbnail/empty', Buffer.alloc(0))).toMatchObject({ status: 400, body: { error: 'empty body' } })
  })
})

describe('font_subset', () => {
  const hasFonts = fs.existsSync(TTF) && fs.existsSync(OTF)

  it.skipIf(!hasFonts)('answers { font, before, after } with a font holding every requested character, TTF and CFF/OTF alike', async () => {
    const text = 'Wave «ç» — 42é'
    for (const file of [TTF, OTF]) {
      const source = fs.readFileSync(file)
      const r = await post('/sailor/font_subset', { font: source.toString('base64'), text })
      expect(r.status).toBe(200)
      expect(Object.keys(r.body)).toEqual(['font', 'before', 'after'])
      expect(r.body.before).toBe(source.length)
      const out = Buffer.from(r.body.font, 'base64')
      expect(r.body.after).toBe(out.length)
      const font = fontkit.create(out) as any
      const original = fontkit.create(source) as any
      const wanted = new Set([...text].map(c => c.codePointAt(0)!))
      for (let cp = 0x20; cp < 0x7F; cp++) wanted.add(cp)
      for (const cp of wanted) {
        if (!original.hasGlyphForCodePoint(cp)) continue
        expect(font.hasGlyphForCodePoint(cp), `${path.basename(file)} U+${cp.toString(16)}`).toBe(true)
      }
    }
  })

  it.skipIf(!hasFonts)('engine down: the whole font; engine up: the engine\'s own subset, with the same body and worker', async () => {
    const b64 = fs.readFileSync(TTF).toString('base64')
    const down = await post('/sailor/font_subset?comfyWorker=1', { font: b64, text: 'a' })
    expect(down.body).toMatchObject({ font: b64, before: fs.statSync(TTF).size, after: fs.statSync(TTF).size })
    expect(engineFetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8190/sailor/font_subset')
    expect(JSON.parse(String(engineFetch.mock.calls[0]?.[1]?.body))).toEqual({ font: b64, text: 'a' })

    engineFetch.mockReset()
    engineFetch.mockResolvedValue(new Response(JSON.stringify({ font: 'c3Vi', before: 55484, after: 3 }), { headers: { 'content-type': 'application/json; charset=utf-8' } }))
    expect((await post('/sailor/font_subset', { font: b64, text: 'a' })).body).toEqual({ font: 'c3Vi', before: 55484, after: 3 })

    engineFetch.mockClear()
    expect((await post('/sailor/font_subset', { font: 'abc' })).status).toBe(400)
    expect(engineFetch, 'a request the Python would refuse is refused here, never forwarded').not.toHaveBeenCalled()
  })

  it('the Python\'s refusals', async () => {
    expect(await post('/sailor/font_subset', {})).toMatchObject({ status: 400, body: { error: 'missing \'font\'' } })
    expect(await post('/sailor/font_subset', { font: 'abc' })).toMatchObject({ status: 400, body: { error: 'undecodable font: Incorrect padding' } })
    expect(await post('/sailor/font_subset', { font: 'x'.repeat(40 * 1024 * 1024 + 4) })).toMatchObject({ status: 400, body: { error: 'font is too large' } })
    const notFont = await post('/sailor/font_subset', { font: Buffer.from('plain text, not a font').toString('base64') })
    expect(notFont.status).toBe(400)
    const list = await post('/sailor/font_subset', [1])
    expect(list.status).toBe(500)
    expect(list.body).toBe('500 Internal Server Error\n\nServer got itself in trouble')
    const bad = await call('POST', '/sailor/font_subset', '{nope')
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/^bad json: /)
  })

  it('strict base64, as b64decode(validate=True)', () => {
    expect(strictB64Decode('YWJj').toString()).toBe('abc')
    expect(strictB64Decode('YQ==').toString()).toBe('a')
    expect(strictB64Decode('').length).toBe(0)
    for (const [s, msg] of [['YW Jj', 'Only base64 data is allowed'], ['YWJj=', 'Excess padding not allowed'], ['====', 'Leading padding not allowed'],
      ['YQ=a', 'Discontinuous padding not allowed'], ['YWJjZA', 'Incorrect padding'], ['é', 'string argument should contain only ASCII characters']]) {
      expect(() => strictB64Decode(s!), s).toThrow(msg)
    }
  })
})

describe('LoRA dataset and bake-frame housekeeping', () => {
  const input = (...p: string[]) => path.join(root, 'input', ...p)

  it('save_captions / clear_dataset over HTTP', async () => {
    fs.mkdirSync(input('lora', 'cats'), { recursive: true })
    expect(await post('/sailor/lora/save_captions', { folder: 'lora/cats', captions: { 'a.png': 'a cat', 'b.jpg': 'b' } }))
      .toMatchObject({ status: 200, body: { written: 2 } })
    expect(fs.readFileSync(input('lora', 'cats', 'a.txt'), 'utf8')).toBe('a cat')
    expect(await post('/sailor/lora/save_captions', { folder: 'lora/dogs', captions: {} })).toMatchObject({ status: 404, body: { error: 'folder not found: lora/dogs' } })
    expect(await call('POST', '/sailor/lora/save_captions', '{bad')).toMatchObject({ status: 400, body: { error: 'invalid json' } })
    expect(await post('/sailor/lora/clear_dataset', { folder: 'lora/cats' })).toMatchObject({ status: 200, body: { ok: true } })
    expect(fs.existsSync(input('lora', 'cats'))).toBe(false)
    expect(fs.existsSync(input('lora'))).toBe(true)
  })

  it('a dataset folder cannot leave input/, and a clear cannot take input/ itself', async () => {
    fs.writeFileSync(path.join(root, 'output', 'keep.png'), 'x')
    fs.writeFileSync(input('keep.png'), 'x')
    for (const folder of ['../output', 'a/../../output', '.', '/', '//', 'x/..']) {
      expect(await post('/sailor/lora/clear_dataset', { folder }), folder).toMatchObject({ status: 400, body: { error: 'folder escapes input directory' } })
    }
    expect(await post('/sailor/lora/save_captions', { folder: '../output', captions: { 'k.png': 'x' } })).toMatchObject({ status: 400 })
    expect(fs.existsSync(path.join(root, 'output', 'keep.png'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'output', 'k.txt'))).toBe(false)
    expect(fs.existsSync(input('keep.png'))).toBe(true)
  })

  it('a symlink inside input/ cannot carry a dataset folder outside it', async () => {
    const sibling = path.join(root, 'sibling')
    fs.mkdirSync(path.join(sibling, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(sibling, 'sub', 'precious.png'), 'x')
    fs.symlinkSync(sibling, input('link'))
    for (const folder of ['link/sub', 'link', 'link/missing/deeper']) {
      expect(await post('/sailor/lora/clear_dataset', { folder }), folder).toMatchObject({ status: 400, body: { error: 'folder escapes input directory' } })
    }
    expect(await post('/sailor/lora/save_captions', { folder: 'link', captions: { 'a.png': 'leak' } }))
      .toMatchObject({ status: 400, body: { error: 'folder escapes input directory' } })
    expect(await post('/sailor/lora/save_captions', { folder: 'link/sub', captions: { 'b.png': 'leak' } })).toMatchObject({ status: 400 })
    expect(fs.readdirSync(path.join(sibling, 'sub'))).toEqual(['precious.png'])
    expect(fs.readdirSync(sibling).sort()).toEqual(['sub'])
    // A symlink that stays inside input/ still works.
    fs.mkdirSync(input('real', 'set'), { recursive: true })
    fs.symlinkSync(input('real'), input('alias'))
    expect(await post('/sailor/lora/save_captions', { folder: 'alias/set', captions: { 'c.png': 'ok' } })).toMatchObject({ status: 200, body: { written: 1 } })
  })

  it('cleanup_frames deletes only bare slate frames at the top of input/, never a kept one', async () => {
    for (const n of ['slate_1_0001.png', 'slate_1_0002.png', 'slate_1_0003.png', 'photo.png']) fs.writeFileSync(input(n), 'x')
    fs.mkdirSync(input('sub'))
    fs.writeFileSync(input('sub', 'slate_1_0004.png'), 'x')
    const r = await post('/sailor/motion/cleanup_frames', {
      delete: ['slate_1_0001.png', 'slate_1_0002.png', 'photo.png', 'sub/slate_1_0004.png', '../slate_1_0005.png', 'slate_1_0009.png'],
      keep: ['elsewhere/slate_1_0002.png'],
    })
    expect(r).toMatchObject({ status: 200, body: { deleted: 1, skipped: 5 } })
    expect(fs.readdirSync(input()).sort()).toEqual(['photo.png', 'slate_1_0002.png', 'slate_1_0003.png', 'sub'])
    expect(await post('/sailor/motion/cleanup_frames', { delete: 'x' })).toMatchObject({ status: 400, body: { error: 'bad payload' } })
    expect(SLATE_FRAME_RE.test('slate_12_0001.png')).toBe(true)
    expect(SLATE_FRAME_RE.test('slate_12_001.png')).toBe(false)
  })
})

describe('models', () => {
  it('status reads the disk: a file at its declared size is present', async () => {
    expect((await call('GET', '/sailor/models/status?key=upscale')).body)
      .toEqual({ ready: false, missing: [{ name: 'RealESRGAN_x2plus.pth', size: 67_061_725 }], total_size: 67_061_725, label: 'Upscale' })
    const file = path.join(root, 'models', 'upscale_models', 'RealESRGAN_x2plus.pth')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
    fs.truncateSync(file, 67_061_725)
    expect((await call('GET', '/sailor/models/status?key=upscale')).body).toEqual({ ready: true, missing: [], total_size: 67_061_725, label: 'Upscale' })
    expect((await call('GET', '/sailor/models/status?key=nope')).body).toEqual({ ready: false, missing: [], total_size: 0, error: 'unknown bundle \'nope\'' })
    expect((await call('GET', '/sailor/models/status')).body).toEqual({ ready: false, missing: [], total_size: 0, error: 'unknown bundle \'\'' })
    expect(engineFetch).not.toHaveBeenCalled()
  })

  it('download: 503 "needs the local engine" when the engine does not answer', async () => {
    const r = await call('GET', '/sailor/models/download?key=upscale')
    expect(r).toMatchObject({ status: 503, body: { error: 'This needs the local engine' } })
    expect(engineFetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8188/system_stats')
  })

  it('download: handed to the proxy untouched when the engine answers (same worker)', async () => {
    engineFetch.mockResolvedValue(new Response('{}', { status: 200 }))
    const r = await call('GET', '/sailor/models/download?key=upscale&comfyWorker=2')
    expect(r.body).toEqual({ fallthrough: true })
    expect(engineFetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8191/system_stats')
  })
})
