/**
 * POST /upload/image and /upload/mask served natively (server/native/uploads.ts),
 * a port of server.py's image_upload / upload_mask — driven through a real h3
 * app and the native dispatcher, against a temp engine root.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { __setInputUploadsEngineRootForTests } from '../../server/utils/inputUploads'
import { nativeEngineRoute, nativeEnginePath } from '../../server/native/router'
import { maskOriginal, pngText, pySplitext } from '../../server/native/uploads'

const FIXTURES = path.join(__dirname, 'fixtures', 'native-upload-mask')
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name))

const app = createApp()
app.use(eventHandler(async (e) => {
  const r = await nativeEngineRoute(e)
  if (r !== undefined) return r
}))
app.use(eventHandler(() => ({ fallthrough: true })))
const handler = toWebHandler(app)

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-uploads-'))
  for (const d of ['input', 'output', 'temp']) fs.mkdirSync(path.join(root, d))
  __setInputUploadsEngineRootForTests(root)
})
afterEach(() => {
  __setInputUploadsEngineRootForTests(undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

type Fields = Record<string, string>
async function upload(file: { name: string, bytes: Buffer | string } | null, fields: Fields = {}, p = '/upload/image') {
  const fd = new FormData()
  if (file) fd.append('image', new File([typeof file.bytes === 'string' ? Buffer.from(file.bytes) : file.bytes], file.name, { type: 'image/png' }))
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  const res = await handler(new Request(`http://x${p}`, { method: 'POST', body: fd }))
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) }
  catch {}
  return { status: res.status, body }
}
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8')
const exists = (...p: string[]) => fs.existsSync(path.join(root, ...p))

describe('routing', () => {
  it('owns /upload/image and /upload/mask under every engine spelling, nothing else under /upload', () => {
    for (const p of ['/upload/image', '/api/upload/image', '/comfyui/upload/mask', '/comfyui/api/upload/mask', '/upload/image?comfyWorker=1']) {
      expect(nativeEnginePath(p), p).not.toBeNull()
    }
    for (const p of ['/upload', '/upload/imageX', '/upload/video']) expect(nativeEnginePath(p), p).toBeNull()
  })

  it('answers aiohttp\'s 405 for another verb and 404 below the route', async () => {
    const get = await handler(new Request('http://x/upload/image'))
    expect(get.status).toBe(405)
    expect(await get.text()).toBe('405: Method Not Allowed')
    const deep = await handler(new Request('http://x/upload/image/x', { method: 'POST', body: new FormData() }))
    expect(deep.status).toBe(404)
  })

  it('serves the /api spelling the same', async () => {
    const fd = new FormData()
    fd.append('image', new File(['PIX'], 'api.png'))
    const res = await handler(new Request('http://x/api/upload/image', { method: 'POST', body: fd }))
    expect(await res.json()).toEqual({ name: 'api.png', subfolder: '', type: 'input' })
  })
})

describe('/upload/image', () => {
  it('writes into input/ and answers { name, subfolder, type }', async () => {
    const r = await upload({ name: 'a.png', bytes: 'PIX' })
    expect(r).toEqual({ status: 200, body: { name: 'a.png', subfolder: '', type: 'input' } })
    expect(JSON.stringify(r.body)).toBe('{"name":"a.png","subfolder":"","type":"input"}')
    expect(read('input', 'a.png')).toBe('PIX')
  })

  it('numbers a clashing name " (1)", " (2)" … without overwrite', async () => {
    await upload({ name: 'a.png', bytes: 'ONE' })
    expect((await upload({ name: 'a.png', bytes: 'TWO' })).body.name).toBe('a (1).png')
    expect((await upload({ name: 'a.png', bytes: 'THREE' })).body.name).toBe('a (2).png')
    expect(read('input', 'a.png')).toBe('ONE')
    expect(read('input', 'a (1).png')).toBe('TWO')
    expect(read('input', 'a (2).png')).toBe('THREE')
  })

  it('answers the existing name when the same bytes are already there (no new file)', async () => {
    await upload({ name: 'a.png', bytes: 'ONE' })
    await upload({ name: 'a.png', bytes: 'TWO' })
    expect((await upload({ name: 'a.png', bytes: 'TWO' })).body.name).toBe('a (1).png')
    expect((await upload({ name: 'a.png', bytes: 'ONE' })).body.name).toBe('a.png')
    expect(fs.readdirSync(path.join(root, 'input')).sort()).toEqual(['a (1).png', 'a.png'])
  })

  it('numbers the way os.path.splitext splits', async () => {
    for (const name of ['archive.tar.gz', '.hidden', 'noext', 'a.']) {
      await upload({ name, bytes: 'ONE' })
      const second = (await upload({ name, bytes: 'TWO' })).body.name
      const [stem, ext] = pySplitext(name)
      expect(second).toBe(`${stem} (1)${ext}`)
    }
    expect(exists('input', 'archive.tar (1).gz')).toBe(true)
    expect(exists('input', '.hidden (1)')).toBe(true)
    expect(exists('input', 'a (1).')).toBe(true)
    expect(pySplitext('..png')).toEqual(['..png', ''])
    expect(pySplitext('x/.a.b')).toEqual(['x/.a', '.b'])
  })

  it('overwrites only for exactly "true" or "1" (the first overwrite field)', async () => {
    await upload({ name: 'a.png', bytes: 'OLD' })
    expect((await upload({ name: 'a.png', bytes: 'NEW' }, { overwrite: 'true' })).body.name).toBe('a.png')
    expect(read('input', 'a.png')).toBe('NEW')
    expect((await upload({ name: 'a.png', bytes: 'NEWER' }, { overwrite: '1' })).body.name).toBe('a.png')
    expect(read('input', 'a.png')).toBe('NEWER')
    for (const v of ['TRUE', 'yes', '0', 'false']) {
      expect((await upload({ name: 'a.png', bytes: `X${v}` }, { overwrite: v })).body.name, v).not.toBe('a.png')
    }
    expect(read('input', 'a.png')).toBe('NEWER')
  })

  it('writes into temp/ or output/ and nested subfolders, creating them', async () => {
    expect((await upload({ name: 't.png', bytes: 'T' }, { type: 'temp', subfolder: 'clips/2026' })).body)
      .toEqual({ name: 't.png', subfolder: 'clips/2026', type: 'temp' })
    expect(read('temp', 'clips', '2026', 't.png')).toBe('T')
    expect((await upload({ name: 'o.png', bytes: 'O' }, { type: 'output' })).body.type).toBe('output')
    expect(read('output', 'o.png')).toBe('O')
    expect((await upload({ name: 'dot.png', bytes: 'D' }, { subfolder: '.' })).body)
      .toEqual({ name: 'dot.png', subfolder: '.', type: 'input' })
    expect(read('input', 'dot.png')).toBe('D')
  })

  it('refuses paths that leave the folder with a 400 and writes nothing', async () => {
    const cases: [string, Fields][] = [
      ['../evil.png', {}],
      ['/abs.png', {}],
      ['a/../../evil.png', {}],
      ['x.png', { subfolder: '../output' }],
      ['x.png', { subfolder: '/tmp' }],
      ['x.png', { subfolder: '..' }],
      ['../input/x.png', { subfolder: '../x' }],
    ]
    for (const [name, fields] of cases) {
      expect((await upload({ name, bytes: 'E' }, fields)).status, `${name} ${JSON.stringify(fields)}`).toBe(400)
    }
    expect(fs.readdirSync(root).sort()).toEqual(['input', 'output', 'temp'])
    expect(fs.readdirSync(path.join(root, 'input'))).toEqual([])
    expect(fs.readdirSync(path.join(root, 'output'))).toEqual([])
  })

  it('400s a missing image, an unnamed image, and an unknown type', async () => {
    expect((await upload(null, { type: 'input' })).status).toBe(400)
    expect((await upload({ name: '', bytes: 'X' })).status).toBe(400)
    expect((await upload({ name: 'a.png', bytes: 'X' }, { type: 'bogus' })).status).toBe(400)
    expect((await upload({ name: 'a.png', bytes: 'X' }, { type: '' })).status).toBe(400)
    expect(fs.readdirSync(path.join(root, 'input'))).toEqual([])
  })

  it('answers 503 when there is no engine root', async () => {
    __setInputUploadsEngineRootForTests(null)
    expect((await upload({ name: 'a.png', bytes: 'X' })).status).toBe(503)
  })

  it('keeps the bytes exactly, binary included', async () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    await upload({ name: 'bin.dat', bytes })
    expect(fs.readFileSync(path.join(root, 'input', 'bin.dat')).equals(bytes)).toBe(true)
  })
})

// ----------------------------------------------------------------- the mask

async function pixels(png: Buffer) {
  const { data, info } = await sharp(png, { ignoreIcc: true }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data: [...data], width: info.width, height: info.height, channels: info.channels }
}

/** The expected-*.png files were written by server.py's own upload_mask (fixtures/native-files-python-oracle.py). */
const MASK_CASES: [string, string][] = [
  ['rgb-text', 'rgba'],
  ['rgba-icc', 'rgb'],
  ['palette', 'la'],
  ['grey', 'rgba'],
]

describe('mask alpha — the pixels PIL wrote', () => {
  for (const [orig, mask] of MASK_CASES) {
    it(`original-${orig} + mask-${mask}`, async () => {
      const out = await maskOriginal(fixture(`original-${orig}.png`), fixture(`mask-${mask}.png`))
      const expected = fixture(`expected-${orig}+${mask}.png`)
      expect(await pixels(out)).toEqual(await pixels(expected))
      expect([...pngText(out)]).toEqual([...pngText(expected)])
      expect((await sharp(out).metadata()).icc?.equals((await sharp(expected).metadata()).icc!) ?? false)
        .toBe((await sharp(expected).metadata()).icc !== undefined)
    })
  }

  it('keeps the colour under fully transparent pixels', async () => {
    const out = await pixels(await maskOriginal(fixture('original-rgb-text.png'), fixture('mask-rgba.png')))
    const orig = await pixels(fixture('original-rgb-text.png'))
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data.slice(i, i + 3)).toEqual(orig.data.slice(i, i + 3))
    }
    expect(out.data.some((v, i) => i % 4 === 3 && v === 0)).toBe(true)
  })

  it('refuses a mask of another size (PIL raised)', async () => {
    await expect(maskOriginal(fixture('original-rgb-text.png'), fixture('mask-wrong-size.png'))).rejects.toThrow()
  })
})

describe('/upload/mask', () => {
  function ref(o: Record<string, unknown>) { return { original_ref: JSON.stringify(o) } }

  it('writes the original with the mask alpha under the uploaded name', async () => {
    fs.copyFileSync(path.join(FIXTURES, 'original-rgb-text.png'), path.join(root, 'output', 'shot.png'))
    const r = await upload({ name: 'shot-mask.png', bytes: fixture('mask-rgba.png') }, ref({ filename: 'shot.png', type: 'output', subfolder: '' }), '/upload/mask')
    expect(r).toEqual({ status: 200, body: { name: 'shot-mask.png', subfolder: '', type: 'input' } })
    const written = fs.readFileSync(path.join(root, 'input', 'shot-mask.png'))
    expect(await pixels(written)).toEqual(await pixels(fixture('expected-rgb-text+rgba.png')))
  })

  it('finds the original through an annotation and a subfolder', async () => {
    fs.mkdirSync(path.join(root, 'temp', 'sub'))
    fs.copyFileSync(path.join(FIXTURES, 'original-grey.png'), path.join(root, 'temp', 'sub', 'g.png'))
    await upload({ name: 'm.png', bytes: fixture('mask-rgba.png') }, { ...ref({ filename: 'g.png [temp]', subfolder: 'sub' }), subfolder: 'masks', type: 'temp' }, '/upload/mask')
    expect(await pixels(fs.readFileSync(path.join(root, 'temp', 'masks', 'm.png')))).toEqual(await pixels(fixture('expected-grey+rgba.png')))
  })

  it('writes nothing but still answers 200 when the original is missing or its ref is refused (as the Python did)', async () => {
    fs.copyFileSync(path.join(FIXTURES, 'original-grey.png'), path.join(root, 'input', 'secret.png'))
    const refs = [
      { filename: 'missing.png' },
      { filename: '../input/secret.png' },
      { filename: '/etc/passwd' },
      { filename: 'secret.png', type: 'bogus' },
      { filename: 'secret.png', type: 'input', subfolder: '../../' },
      { filename: '' },
    ]
    for (const [i, o] of refs.entries()) {
      const r = await upload({ name: `m${i}.png`, bytes: fixture('mask-rgba.png') }, ref(o), '/upload/mask')
      expect(r, JSON.stringify(o)).toEqual({ status: 200, body: { name: `m${i}.png`, subfolder: '', type: 'input' } })
    }
    expect(fs.readdirSync(path.join(root, 'input'))).toEqual(['secret.png'])
  })

  it('500s a missing or malformed original_ref, as aiohttp did', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => quiet.mockRestore())
    expect((await upload({ name: 'm.png', bytes: fixture('mask-rgba.png') }, {}, '/upload/mask')).status).toBe(500)
    expect((await upload({ name: 'm.png', bytes: fixture('mask-rgba.png') }, { original_ref: '{nope' }, '/upload/mask')).status).toBe(500)
  })

  it('two masks uploaded at once under one name get two names, both written', async () => {
    fs.copyFileSync(path.join(FIXTURES, 'original-grey.png'), path.join(root, 'output', 'g.png'))
    const [a, b] = await Promise.all([
      upload({ name: 'm.png', bytes: fixture('mask-rgba.png') }, ref({ filename: 'g.png' }), '/upload/mask'),
      upload({ name: 'm.png', bytes: fixture('mask-la.png') }, ref({ filename: 'g.png' }), '/upload/mask'),
    ])
    expect([a.body.name, b.body.name].sort()).toEqual(['m (1).png', 'm.png'])
    expect(fs.readdirSync(path.join(root, 'input')).sort()).toEqual(['m (1).png', 'm.png'])
  })

  it('numbers a clashing mask name like an image upload', async () => {
    fs.copyFileSync(path.join(FIXTURES, 'original-grey.png'), path.join(root, 'output', 'g.png'))
    fs.writeFileSync(path.join(root, 'input', 'm.png'), 'taken')
    const r = await upload({ name: 'm.png', bytes: fixture('mask-rgba.png') }, ref({ filename: 'g.png' }), '/upload/mask')
    expect(r.body.name).toBe('m (1).png')
    expect(read('input', 'm.png')).toBe('taken')
    expect(exists('input', 'm (1).png')).toBe(true)
  })
})
