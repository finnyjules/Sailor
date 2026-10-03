/**
 * Parity with the Python itself: ComfyUI's REAL /upload/image, /upload/mask
 * and /view handlers from server.py and the native ones get the same request
 * bytes over two identical temp data roots; the answers and the files left
 * behind must match.
 *
 * Python left the repo in step 4, C7: the Python's answers, and the files it
 * wrote, were frozen then into fixtures/native-files-python-answers.json and
 * are replayed by helpers/frozenOracle.ts. Nothing here runs Python.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { __setInputUploadsEngineRootForTests } from '../../server/utils/inputUploads'
import { nativeEngineRoute } from '../../server/native/router'
import { resolveViewTarget, viewFileResponse } from '../../server/native/view'
import { pngText } from '../../server/native/uploads'
import { frozenOracle } from './helpers/frozenOracle'

const FIXTURES = path.join(__dirname, 'fixtures', 'native-upload-mask')
const FROZEN = path.join(__dirname, 'fixtures', 'native-files-python-answers.json')

interface Call { method: string, path: string, headers?: Record<string, string>, body?: Buffer }
interface Answer { status: number, headers: Record<string, string>, body: Buffer }

const oracle = frozenOracle(FROZEN)
function python(root: string, calls: Call[]): Answer[] {
  const spec = calls.map(c => ({ ...c, body: c.body?.toString('base64') }))
  return (oracle(root, spec) as any[]).map(a => ({ status: a.status, headers: a.headers, body: Buffer.from(a.body, 'base64') }))
}

const app = createApp()
app.use(eventHandler(async (e) => {
  const r = await nativeEngineRoute(e)
  if (r !== undefined) return r
}))
const handler = toWebHandler(app)

async function native(root: string, calls: Call[]): Promise<Answer[]> {
  __setInputUploadsEngineRootForTests(root)
  const out: Answer[] = []
  for (const c of calls) {
    const res = await handler(new Request(`http://x${c.path}`, { method: c.method, headers: c.headers, body: c.body }))
    out.push({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) })
  }
  return out
}

const BOUNDARY = '----SailorParityBoundary'
type Part = { name: string, value: string | Buffer, filename?: string }
function multipart(parts: Part[]): Call['body'] {
  const chunks: Buffer[] = []
  for (const p of parts) {
    const fn = p.filename !== undefined ? `; filename="${p.filename}"` : ''
    const ct = p.filename !== undefined ? '\r\nContent-Type: image/png' : ''
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${p.name}"${fn}${ct}\r\n\r\n`, 'utf8'))
    chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value, 'utf8'))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return Buffer.concat(chunks)
}
function post(p: string, file: { name: string, bytes: string | Buffer } | null, fields: Record<string, string> = {}): Call {
  const parts: Part[] = file ? [{ name: 'image', filename: file.name, value: file.bytes }] : []
  for (const [k, v] of Object.entries(fields)) parts.push({ name: k, value: v })
  return { method: 'POST', path: p, headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }, body: multipart(parts) }
}

/** Every file under `dir`, relative path → bytes. */
function tree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else out.set(path.relative(dir, full), fs.readFileSync(full))
    }
  }
  walk(dir)
  return out
}

let pyRoot: string
let nativeRoot: string
function seed(fn: (root: string) => void) { fn(pyRoot); fn(nativeRoot) }
beforeEach(() => {
  const mk = (tag: string) => {
    const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `native-files-parity-${tag}-`)))
    for (const d of ['input', 'output', 'temp']) fs.mkdirSync(path.join(r, d))
    return r
  }
  pyRoot = mk('py')
  nativeRoot = mk('native')
})
afterEach(() => {
  __setInputUploadsEngineRootForTests(undefined)
  fs.rmSync(pyRoot, { recursive: true, force: true })
  fs.rmSync(nativeRoot, { recursive: true, force: true })
})

const json = (a: Answer) => { try { return JSON.parse(a.body.toString('utf8')) } catch { return a.body.toString('utf8') } }

describe('parity with server.py', () => {
  it('/upload/image: same answers, same files, same numbering', async () => {
    const calls: Call[] = [
      post('/upload/image', { name: 'a.png', bytes: 'ONE' }),
      post('/upload/image', { name: 'a.png', bytes: 'TWO' }),
      post('/upload/image', { name: 'a.png', bytes: 'ONE' }),
      post('/upload/image', { name: 'a.png', bytes: 'TWO' }),
      post('/upload/image', { name: 'a.png', bytes: 'THREE' }),
      post('/upload/image', { name: 'a.png', bytes: 'NEW' }, { overwrite: 'true' }),
      post('/upload/image', { name: 'a (1).png', bytes: 'NEWER' }, { overwrite: '1' }),
      post('/upload/image', { name: 'a.png', bytes: 'NOPE' }, { overwrite: 'TRUE' }),
      post('/upload/image', { name: 'archive.tar.gz', bytes: 'A' }),
      post('/upload/image', { name: 'archive.tar.gz', bytes: 'B' }),
      post('/upload/image', { name: '.hidden', bytes: 'A' }),
      post('/upload/image', { name: '.hidden', bytes: 'B' }),
      post('/upload/image', { name: 'ü ñ.png', bytes: 'U' }),
      post('/upload/image', { name: 'ü ñ.png', bytes: 'V' }),
      post('/upload/image', { name: 't.png', bytes: 'T' }, { type: 'temp', subfolder: 'clips/2026' }),
      post('/upload/image', { name: 't.png', bytes: 'T2' }, { type: 'temp', subfolder: 'clips/2026' }),
      post('/upload/image', { name: 'o.png', bytes: 'O' }, { type: 'output' }),
      post('/upload/image', { name: 'dot.png', bytes: 'D' }, { subfolder: '.' }),
      post('/upload/image', { name: 'x.png', bytes: 'X' }, { subfolder: 'a/b/../c' }),
      post('/upload/image', { name: '../evil.png', bytes: 'E' }),
      post('/upload/image', { name: 'x.png', bytes: 'E' }, { subfolder: '../output' }),
      post('/upload/image', { name: 'x.png', bytes: 'E' }, { subfolder: '/tmp' }),
      post('/upload/image', null, { type: 'input' }),
    ]
    const py = python(pyRoot, calls)
    const nat = await native(nativeRoot, calls)
    for (const [i, c] of calls.entries()) {
      expect(nat[i]!.status, `call ${i} status`).toBe(py[i]!.status)
      if (py[i]!.status === 200) expect(json(nat[i]!), `call ${i} body ${c.path}`).toEqual(json(py[i]!))
    }
    expect([...tree(nativeRoot)]).toEqual([...tree(pyRoot)])
    expect(json(py[3]!).name, 'sanity: the oracle really numbered').toBe('a (1).png')
  })

  it('known divergence: a filename with a leading "/" is refused, where aiohttp\'s parser silently dropped the slash', async () => {
    const calls = [post('/upload/image', { name: '/abs.png', bytes: 'E' })]
    const [py] = python(pyRoot, calls)
    const [nat] = await native(nativeRoot, calls)
    expect([py!.status, json(py!).name]).toEqual([200, 'abs.png'])
    expect(nat!.status).toBe(400)
    expect(fs.readdirSync(path.join(nativeRoot, 'input'))).toEqual([])
  })

  it('known divergence: an empty filename is a 400, where the Python crashed with a 500', async () => {
    const calls = [post('/upload/image', { name: '', bytes: 'E' })]
    expect(python(pyRoot, calls)[0]!.status).toBe(500)
    expect((await native(nativeRoot, calls))[0]!.status).toBe(400)
  })

  it('/upload/mask: same answers, same pixels, same text chunks and ICC', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => quiet.mockRestore())
    seed((r) => {
      for (const f of fs.readdirSync(FIXTURES).filter(n => n.startsWith('original-'))) {
        fs.copyFileSync(path.join(FIXTURES, f), path.join(r, 'output', f))
      }
      fs.mkdirSync(path.join(r, 'temp', 'sub'))
      fs.copyFileSync(path.join(FIXTURES, 'original-grey.png'), path.join(r, 'temp', 'sub', 'g.png'))
      fs.writeFileSync(path.join(r, 'input', 'taken.png'), 'taken')
    })
    const mask = (m: string) => fs.readFileSync(path.join(FIXTURES, `mask-${m}.png`))
    const ref = (o: Record<string, unknown>) => ({ original_ref: JSON.stringify(o) })
    const calls: Call[] = [
      post('/upload/mask', { name: 'm1.png', bytes: mask('rgba') }, ref({ filename: 'original-rgb-text.png', type: 'output', subfolder: '' })),
      post('/upload/mask', { name: 'm2.png', bytes: mask('rgb') }, ref({ filename: 'original-rgba-icc.png' })),
      post('/upload/mask', { name: 'm3.png', bytes: mask('la') }, ref({ filename: 'original-palette.png [output]', type: 'input' })),
      post('/upload/mask', { name: 'm4.png', bytes: mask('rgba') }, { ...ref({ filename: 'g.png', type: 'temp', subfolder: 'sub' }), type: 'temp', subfolder: 'masks' }),
      post('/upload/mask', { name: 'taken.png', bytes: mask('rgba') }, ref({ filename: 'original-grey.png' })),
      post('/upload/mask', { name: 'm5.png', bytes: mask('rgba') }, ref({ filename: 'missing.png' })),
      post('/upload/mask', { name: 'm6.png', bytes: mask('rgba') }, ref({ filename: '../output/original-grey.png' })),
      post('/upload/mask', { name: 'm7.png', bytes: mask('rgba') }, ref({ filename: 'original-grey.png', subfolder: '../input' })),
      post('/upload/mask', { name: 'm8.png', bytes: mask('rgba') }, ref({ filename: 'original-grey.png', type: 'bogus' })),
      post('/upload/mask', { name: 'm9.png', bytes: mask('wrong-size') }, ref({ filename: 'original-grey.png' })),
      post('/upload/mask', { name: 'm10.png', bytes: mask('rgba') }, {}),
    ]
    const py = python(pyRoot, calls)
    const nat = await native(nativeRoot, calls)
    for (const [i] of calls.entries()) {
      expect(nat[i]!.status, `call ${i} status`).toBe(py[i]!.status)
      if (py[i]!.status === 200) expect(json(nat[i]!), `call ${i} body`).toEqual(json(py[i]!))
    }
    // What server.py wrote through the mask path (PNG bytes differ by encoder; pixels, text and ICC must not).
    const MASKED = ['input/m1.png', 'input/m2.png', 'input/m3.png', 'input/taken (1).png', 'temp/masks/m4.png']
    const pyTree = tree(pyRoot)
    const natTree = tree(nativeRoot)
    expect([...natTree.keys()]).toEqual([...pyTree.keys()])
    const pixels = async (b: Buffer) => [...(await sharp(b, { ignoreIcc: true }).toColourspace('srgb').ensureAlpha().raw().toBuffer())]
    let compared = 0
    for (const [rel, pyBytes] of pyTree) {
      const natBytes = natTree.get(rel)!
      if (MASKED.includes(rel)) {
        expect(await pixels(natBytes), rel).toEqual(await pixels(pyBytes))
        expect([...pngText(natBytes)], rel).toEqual([...pngText(pyBytes)])
        const icc = async (b: Buffer) => (await sharp(b).metadata()).icc?.toString('base64') ?? null
        expect(await icc(natBytes), rel).toBe(await icc(pyBytes))
        compared++
      }
      else {
        expect(natBytes.equals(pyBytes), rel).toBe(true)
      }
    }
    expect(compared, 'masked files compared').toBe(MASKED.length)
  })

  it('/view: same status, type, disposition, ranges and bytes for each type', async () => {
    seed((r) => {
      fs.writeFileSync(path.join(r, 'output', 'a.png'), 'OUT')
      fs.writeFileSync(path.join(r, 'input', 'a.png'), 'IN')
      fs.writeFileSync(path.join(r, 'temp', 'a.png'), 'TMP')
      fs.mkdirSync(path.join(r, 'output', 'sub'))
      fs.writeFileSync(path.join(r, 'output', 'sub', 'v.mp4'), '0123456789')
      fs.writeFileSync(path.join(r, 'output', 'page.html'), '<b>x</b>')
      fs.writeFileSync(path.join(r, 'output', 'ü ñ.WAV'), 'W')
      fs.mkdirSync(path.join(r, 'output', 'adir'))
      fs.writeFileSync(path.join(r, 'output', '写真 😀.png'), 'CJK')
    })
    // (`blake3:` is left out: the lifted handler has no user manager. The live
    // engine answers it 404 without --enable-assets, as native-view checks.)
    const queries: [string, Record<string, string>?][] = [
      ['filename=a.png'],
      ['filename=a.png&type=input'],
      ['filename=a.png&type=temp&subfolder='],
      ['filename=a.png%20[input]&type=temp'],
      ['filename=x/y/a.png'],
      ['filename=v.mp4&subfolder=sub'],
      ['filename=v.mp4&subfolder=sub', { range: 'bytes=2-5' }],
      ['filename=v.mp4&subfolder=sub', { range: 'bytes=-3' }],
      ['filename=v.mp4&subfolder=sub', { range: 'bytes=7-' }],
      ['filename=v.mp4&subfolder=sub', { range: 'bytes=10-' }],
      ['filename=v.mp4&subfolder=sub', { range: 'bytes=0-1,3-4' }],
      ['filename=page.html'],
      [`filename=${encodeURIComponent('ü ñ.WAV')}`],
      ['filename=adir'],
      ['filename=missing.png'],
      ['filename=../input/a.png'],
      ['filename=%2Fetc%2Fpasswd'],
      [`filename=${encodeURIComponent('写真 😀.png')}`],
      ['filename=a.png&type=bogus'],
      ['filename=a.png&type='],
      ['filename=a.png&subfolder=../input'],
      ['filename=a.png&subfolder=%2Ftmp'],
      ['filename='],
      ['type=output'],
    ]
    const py = python(pyRoot, queries.map(([q, h]) => ({ method: 'GET', path: `/view?${q}`, headers: h })))
    __setInputUploadsEngineRootForTests(nativeRoot)
    for (const [i, [q, h]] of queries.entries()) {
      const query = Object.fromEntries(new URLSearchParams(q))
      const target = resolveViewTarget(query)
      const p = py[i]!
      if (target.kind === 'status') {
        expect(target.status, q).toBe(p.status)
        continue
      }
      const res = viewFileResponse(target, h ?? {})!
      expect(res.status, q).toBe(p.status)
      for (const k of ['content-type', 'content-disposition', 'content-range', 'accept-ranges', 'content-length']) {
        // Header strings carry the wire bytes as latin-1 code units; the
        // oracle's client decoded aiohttp's UTF-8 bytes.
        const mine = res.headers[k] === undefined ? undefined : Buffer.from(res.headers[k]!, 'latin1').toString('utf8')
        expect(mine, `${q} ${k}`).toBe(p.headers[k])
      }
      const bytes = res.range ? fs.readFileSync(target.file).subarray(res.range.start, res.range.end + 1) : Buffer.alloc(0)
      expect(bytes.equals(p.body), `${q} body`).toBe(true)
    }
  })
})
