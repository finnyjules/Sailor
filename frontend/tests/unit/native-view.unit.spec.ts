/**
 * GET /view served from disk (server/native/view.ts + server/routes/view.get.ts),
 * a port of server.py's view_image and aiohttp's FileResponse — the real route
 * handler mounted in an h3 app, against a temp engine root.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp, createError, eventHandler, getQuery, setResponseHeaders, toWebHandler } from 'h3'
import { __setInputUploadsEngineRootForTests } from '../../server/utils/inputUploads'
import { resolveViewTarget, viewContentType, viewFileResponse } from '../../server/native/view'

// Nitro auto-imports the route uses.
const g = globalThis as any
g.defineEventHandler = eventHandler
g.getQuery = getQuery
g.createError = createError
g.setResponseHeaders = setResponseHeaders

vi.mock('../../server/utils/deployMode', () => ({ deployMode: () => 'local', isHosted: () => false }))
// The temp-folder copy goes to <cwd>/.cache/images — keep it out of the run.
const copyFile = vi.fn(async () => {})
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig() as any
  return { ...actual, copyFile: (...a: any[]) => copyFile(...(a as [])), mkdir: async () => {} }
})

let handler: (r: Request) => Promise<Response>
beforeAll(async () => {
  const route = (await import('../../server/routes/view.get')).default
  const app = createApp()
  app.use('/view', route)
  handler = toWebHandler(app)
})

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-view-'))
  for (const d of ['input', 'output', 'temp']) fs.mkdirSync(path.join(root, d))
  __setInputUploadsEngineRootForTests(root)
  copyFile.mockClear()
})
afterEach(() => {
  __setInputUploadsEngineRootForTests(undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

function put(rel: string, bytes: string | Buffer) {
  const f = path.join(root, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, bytes)
  return f
}
/** The response with its body already read, so no file stays open past the test. */
async function view(qs: string, headers: Record<string, string> = {}) {
  const res = await handler(new Request(`http://x/view?${qs}`, { headers }))
  const body = await res.text()
  return { status: res.status, headers: res.headers, text: async () => body }
}

describe('resolveViewTarget — the Python\'s resolution', () => {
  it('serves each type from its own folder, output by default', () => {
    put('output/a.png', 'O')
    put('input/a.png', 'I')
    put('temp/a.png', 'T')
    expect(resolveViewTarget({ filename: 'a.png' })).toMatchObject({ kind: 'file', file: path.join(root, 'output', 'a.png') })
    for (const t of ['input', 'output', 'temp']) {
      expect(resolveViewTarget({ filename: 'a.png', type: t })).toMatchObject({ kind: 'file', file: path.join(root, t, 'a.png') })
    }
  })

  it('lets an [output]/[input]/[temp] annotation outrank type', () => {
    put('input/a.png', 'I')
    expect(resolveViewTarget({ filename: 'a.png [input]', type: 'temp' })).toMatchObject({ kind: 'file', file: path.join(root, 'input', 'a.png') })
  })

  it('joins the subfolder and keeps only the basename of the filename', () => {
    put('output/sub/deep/a.png', 'S')
    expect(resolveViewTarget({ filename: 'a.png', subfolder: 'sub/deep' })).toMatchObject({ kind: 'file', file: path.join(root, 'output', 'sub', 'deep', 'a.png') })
    expect(resolveViewTarget({ filename: 'other/dir/a.png', subfolder: 'sub/deep' })).toMatchObject({ kind: 'file' })
  })

  it('answers 400 / 403 / 404 where the Python did', () => {
    put('input/secret.png', 'S')
    expect(resolveViewTarget({})).toEqual({ kind: 'status', status: 404 })
    expect(resolveViewTarget({ filename: 'blake3:abc' })).toEqual({ kind: 'status', status: 404 })
    expect(resolveViewTarget({ filename: '' })).toEqual({ kind: 'status', status: 400 })
    expect(resolveViewTarget({ filename: ' [output]' })).toEqual({ kind: 'status', status: 400 })
    expect(resolveViewTarget({ filename: '/etc/passwd' })).toEqual({ kind: 'status', status: 400 })
    expect(resolveViewTarget({ filename: '../input/secret.png' })).toEqual({ kind: 'status', status: 400 })
    expect(resolveViewTarget({ filename: 'a..b.png' })).toEqual({ kind: 'status', status: 400 })
    expect(resolveViewTarget({ filename: 'a.png', type: 'bogus' })).toEqual({ kind: 'status', status: 400 })
    expect(resolveViewTarget({ filename: 'a.png', type: '' })).toEqual({ kind: 'status', status: 400 })
    expect(resolveViewTarget({ filename: 'secret.png', subfolder: '../input' })).toEqual({ kind: 'status', status: 403 })
    expect(resolveViewTarget({ filename: 'secret.png', subfolder: '/tmp' })).toEqual({ kind: 'status', status: 403 })
    expect(resolveViewTarget({ filename: 'missing.png' })).toEqual({ kind: 'status', status: 404 })
    expect(resolveViewTarget({ filename: 'dir/' })).toEqual({ kind: 'status', status: 404 })
    fs.mkdirSync(path.join(root, 'output', 'adir'))
    expect(resolveViewTarget({ filename: 'adir' })).toEqual({ kind: 'status', status: 404 })
  })

  it('takes the first value of a repeated key, as aiohttp\'s query does', () => {
    put('output/a.png', 'A')
    expect(resolveViewTarget({ filename: ['a.png', 'b.png'] })).toMatchObject({ kind: 'file', filename: 'a.png' })
  })

  it('guesses content types as Python\'s mimetypes did, forcing html/js/css to download', () => {
    expect(viewContentType('a.PNG')).toBe('image/png')
    expect(viewContentType('a.mp4')).toBe('video/mp4')
    expect(viewContentType('a.wav')).toBe('audio/x-wav')
    expect(viewContentType('a.glb')).toBe('application/octet-stream')
    expect(viewContentType('.png')).toBe('application/octet-stream')
    expect(viewContentType('x.html')).toBe('application/octet-stream')
    expect(viewContentType('x.js')).toBe('application/octet-stream')
  })
})

describe('GET /view — the response', () => {
  it('serves each type\'s bytes with aiohttp\'s headers', async () => {
    for (const t of ['input', 'output', 'temp']) {
      put(`${t}/f.png`, `bytes-of-${t}`)
      const res = await view(`filename=f.png&type=${t}&subfolder=`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(`bytes-of-${t}`)
      expect(res.headers.get('content-type')).toBe('image/png')
      expect(res.headers.get('content-disposition')).toBe('filename="f.png"')
      expect(res.headers.get('accept-ranges')).toBe('bytes')
      expect(res.headers.get('content-length')).toBe(String(`bytes-of-${t}`.length))
      const st = fs.statSync(path.join(root, t, 'f.png'), { bigint: true })
      expect(res.headers.get('etag')).toBe(`"${st.mtimeNs.toString(16)}-${st.size.toString(16)}"`)
      expect(res.headers.get('last-modified')).toBe(new Date(Math.ceil(Number(st.mtimeNs) / 1e9) * 1000).toUTCString())
    }
  })

  it('serves the runner\'s live-preview subfolder file distinctly from ComfyUI\'s same-named temp/ file', async () => {
    // The runner's local-mode live preview (results.ts LOCAL_LIVE_PREVIEW_SUBFOLDER)
    // and ComfyUI's own save_live_preview can both produce
    // temp/live_preview_3_00001.png — one bare in temp/, the other in its own
    // subfolder — and /view must resolve each independently by subfolder.
    put('temp/live_preview_3_00001.png', 'comfy-bytes')
    put('temp/sailor_runner/live_preview_3_00001.png', 'runner-bytes')

    const comfy = await view('filename=live_preview_3_00001.png&type=temp&subfolder=')
    expect(comfy.status).toBe(200)
    expect(await comfy.text()).toBe('comfy-bytes')

    const runner = await view('filename=live_preview_3_00001.png&type=temp&subfolder=sailor_runner')
    expect(runner.status).toBe(200)
    expect(await runner.text()).toBe('runner-bytes')
  })

  it('serves byte ranges (206) and refuses bad ones (416)', async () => {
    put('output/v.mp4', '0123456789')
    let res = await view('filename=v.mp4', { range: 'bytes=2-5' })
    expect(res.status).toBe(206)
    expect(await res.text()).toBe('2345')
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10')
    res = await view('filename=v.mp4', { range: 'bytes=7-' })
    expect([res.status, await res.text()]).toEqual([206, '789'])
    res = await view('filename=v.mp4', { range: 'bytes=-3' })
    expect([res.status, await res.text()]).toEqual([206, '789'])
    res = await view('filename=v.mp4', { range: 'bytes=5-100' })
    expect([res.status, await res.text()]).toEqual([206, '56789'])
    for (const bad of ['bytes=10-', 'bytes=5-2', 'bytes=0-1,3-4', 'items=0-1', 'bytes=-']) {
      res = await view('filename=v.mp4', { range: bad })
      expect(res.status, bad).toBe(416)
      expect(res.headers.get('content-range')).toBe('bytes */10')
    }
  })

  it('answers 304 to a matching If-None-Match', async () => {
    put('output/a.png', 'A')
    const first = await view('filename=a.png')
    const etag = first.headers.get('etag')!
    const res = await view('filename=a.png', { 'if-none-match': etag })
    expect(res.status).toBe(304)
    expect((await view('filename=a.png', { 'if-none-match': '"other"' })).status).toBe(200)
  })

  it('carries the Python\'s 400 and 403, and 404s a missing file', async () => {
    expect((await view('filename=../x.png')).status).toBe(400)
    expect((await view('filename=x.png&type=bogus')).status).toBe(400)
    expect((await view('filename=x.png&subfolder=../input')).status).toBe(403)
    expect((await view('filename=missing.png')).status).toBe(404)
  })

  it('serves non-latin names through the route, Content-Disposition as aiohttp\'s UTF-8 bytes', async () => {
    for (const name of ['写真.png', '😀 party.webp', 'café ü.mp4', 'スクリーン ショット 2026.png']) {
      put(`output/${name}`, `bytes of ${name}`)
      const res = await view(`filename=${encodeURIComponent(name)}`)
      expect(res.status, name).toBe(200)
      expect(await res.text()).toBe(`bytes of ${name}`)
      // Header strings carry the raw bytes as latin-1 code units.
      const wire = Buffer.from(res.headers.get('content-disposition')!, 'latin1')
      expect(wire.equals(Buffer.from(`filename="${name}"`, 'utf8')), name).toBe(true)
    }
    put('input/レイヤー/マスク.png', 'M')
    const sub = await view(`filename=${encodeURIComponent('マスク.png')}&type=input&subfolder=${encodeURIComponent('レイヤー')}`)
    expect([sub.status, await sub.text()]).toEqual([200, 'M'])
  })

  it('sends the sandbox CSP and nosniff on every answer', async () => {
    put('output/v.mp4', '0123456789')
    const answers = [
      await view('filename=v.mp4'),
      await view('filename=v.mp4', { range: 'bytes=2-5' }),
      await view('filename=v.mp4', { range: 'bytes=50-' }),
      await view('filename=missing.png'),
      await view('filename=../x.png'),
    ]
    const etag = answers[0]!.headers.get('etag')!
    answers.push(await view('filename=v.mp4', { 'if-none-match': etag }))
    expect(answers.map(a => a.status)).toEqual([200, 206, 416, 404, 400, 304])
    for (const a of answers) {
      expect(a.headers.get('content-security-policy'), String(a.status)).toBe('sandbox; default-src \'none\'')
      expect(a.headers.get('x-content-type-options'), String(a.status)).toBe('nosniff')
    }
  })

  it('answers 404 for a file that disappears between resolve and read', async () => {
    const f = put('output/gone.png', 'G')
    const target = resolveViewTarget({ filename: 'gone.png' })
    expect(target.kind).toBe('file')
    fs.rmSync(f)
    expect(viewFileResponse(target as any, {})).toBeNull()
  })

  it('keeps a copy of temp images only', async () => {
    put('temp/t.png', 'T')
    put('output/o.png', 'O')
    await view('filename=t.png&type=temp')
    await view('filename=o.png&type=output')
    expect(copyFile).toHaveBeenCalledTimes(1)
    expect((copyFile.mock.calls[0] as unknown as string[])[0]).toBe(path.join(root, 'temp', 't.png'))
  })
})
