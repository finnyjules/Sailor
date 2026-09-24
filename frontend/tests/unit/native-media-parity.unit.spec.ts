/**
 * Parity with the Python itself: the REAL handlers from
 * comfy_extras/nodes_timeline.py (lifted out with `ast` by
 * fixtures/native-media-python-oracle.py and run with aiohttp's own `web`)
 * and the native ones answer the same requests over the same temp engine
 * root, and each side reads what the other wrote.
 *
 * Needs the repo's `.venv` (Python + aiohttp + Pillow); skipped without it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import * as M from '../../server/native/media'

const REPO = path.resolve(__dirname, '..', '..', '..')
const PYTHON = path.join(REPO, '.venv', 'bin', 'python')
const ORACLE = path.join(__dirname, 'fixtures', 'native-media-python-oracle.py')
const hasPython = fs.existsSync(PYTHON)

interface PyCall { handler: string, path: string, match_info?: Record<string, string>, body?: string }
interface PyResult { status: number, content_type: string, body: any, cache_control: string | null }

function python(root: string, calls: PyCall[]): PyResult[] {
  const r = spawnSync(PYTHON, [ORACLE], { input: JSON.stringify({ root, calls }), encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`oracle failed: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

let root: string
let input: string
let output: string
let user: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-media-parity-')))
  input = path.join(root, 'input')
  output = path.join(root, 'output')
  user = path.join(root, 'user')
  for (const d of [input, output, user]) fs.mkdirSync(d)
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

function touch(file: string, mtimeSec: number, bytes = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
  fs.utimesSync(file, mtimeSec, mtimeSec)
}
async function png(file: string, w: number, h: number) {
  await sharp({ create: { width: w, height: h, channels: 4, background: '#c83c0a80' } }).png().toFile(file)
}

describe.skipIf(!hasPython)('parity with the Python handlers', () => {
  it('output and input listings: same items, same order, same fields, same mtimes', () => {
    // Equal mtimes on purpose: ties must keep the same (directory) order.
    const names = ['b.png', 'A.MP4', 'z.wav', 'c.gif', 'ü-ñ.webp', 'x.txt', '.hid.png', 'm.JPEG', 'q.m4a']
    names.forEach((n, i) => touch(path.join(output, n), 1_790_000_000 + (i % 3) + 0.123456789))
    names.forEach((n, i) => touch(path.join(input, n), 1_790_000_000 + (i % 2)))
    touch(path.join(output, 'sub', 'deep', 'd.mov'), 1_790_000_001.5)
    touch(path.join(output, '.cache', 'e.png'), 1_790_000_002)
    touch(path.join(input, 'sub', 'nested.png'), 1_790_000_009)
    fs.mkdirSync(path.join(input, 'dir.png'))
    fs.symlinkSync(path.join(input, 'b.png'), path.join(input, 'link.png'))
    fs.symlinkSync(path.join(input, 'gone.png'), path.join(input, 'broken.png'))

    const [pyOut, pyIn] = python(root, [
      { handler: '_output_listing_route', path: '/sailor/output_listing' },
      { handler: '_input_listing_route', path: '/sailor/input_listing' },
    ])
    const nOut = M.outputListing(output)
    const nIn = M.inputListing(input)
    expect(nOut.status).toBe(pyOut!.status)
    expect(nOut.body).toEqual(pyOut!.body)
    expect(nIn.status).toBe(pyIn!.status)
    expect(nIn.body).toEqual(pyIn!.body)
    expect((nOut.body as any).items.length).toBeGreaterThan(5)
  })

  it('a missing input folder: the same 500 body', () => {
    fs.rmSync(input, { recursive: true })
    const [py] = python(root, [{ handler: '_input_listing_route', path: '/sailor/input_listing' }])
    expect(M.inputListing(input)).toEqual({ status: py!.status, body: py!.body })
  })

  it('delete guards: every name is refused, missing or deleted exactly as the Python does', () => {
    fs.symlinkSync(input, path.join(output, 'escape'))
    fs.mkdirSync(path.join(output, 'sub'))
    const cases: [string, string][] = [
      ['', ''], ['', '/etc/passwd'], ['/etc', 'passwd'], ['', '../input/x.png'], ['..', 'x.png'],
      ['sub/../..', 'x.png'], ['escape', 'x.png'], ['', 'escape/x.png'], ['sub', 'ghost.png'], ['', '.'],
      ['', 'sub'], ['', 'sub/../ghost.png'], ['sub', '../ghost.png'], ['.', 'ghost.png'], ['', 'a%2Fb.png'],
    ]
    const q = (s: string, f: string) => `/sailor/output_file?${new URLSearchParams({ filename: f, subfolder: s })}`
    const py = python(root, cases.map(([s, f]) => ({ handler: '_output_file_delete_route', path: q(s, f) })))
    cases.forEach(([s, f], i) => {
      expect(M.deleteFile(output, s, f), `${s} | ${f}`).toEqual({ status: py[i]!.status, body: py[i]!.body })
    })
  })

  it('deletes remove the same files', () => {
    touch(path.join(input, 'a.png'), 1)
    touch(path.join(input, 'nested', 'b.png'), 1)
    touch(path.join(output, 'sub', 'c.png'), 1)
    const py = python(root, [
      { handler: '_input_file_delete_route', path: '/sailor/input_file?filename=a.png' },
      { handler: '_input_file_delete_route', path: '/sailor/input_file?filename=nested/b.png' },
      { handler: '_output_file_delete_route', path: '/sailor/output_file?filename=c.png&subfolder=sub' },
    ])
    expect(py.map(r => r.body)).toEqual([{ ok: true }, { ok: true }, { ok: true }])
    touch(path.join(input, 'a.png'), 1)
    touch(path.join(input, 'nested', 'b.png'), 1)
    touch(path.join(output, 'sub', 'c.png'), 1)
    expect([
      M.deleteFile(input, '', 'a.png'),
      M.deleteFile(input, '', 'nested/b.png'),
      M.deleteFile(output, 'sub', 'c.png'),
    ].map(r => r.body)).toEqual(py.map(r => r.body))
    expect([path.join(input, 'a.png'), path.join(input, 'nested', 'b.png'), path.join(output, 'sub', 'c.png')].some(f => fs.existsSync(f))).toBe(false)
  })

  it('the asset library: Python imports, native reads and adds, Python reads and deletes, byte-identical file', async () => {
    await png(path.join(input, 'one.png'), 120, 45)
    await png(path.join(input, 'two ü.png'), 33, 77)
    const [pyImport] = python(root, [{ handler: '_asset_import_route', path: '/sailor/asset_import', body: JSON.stringify({ path: 'one.png' }) }])
    expect(pyImport!.body.created).toBe(true)
    const file = path.join(user, 'timeline_assets.json')
    const pyBytes = fs.readFileSync(file, 'utf8')

    // Native reads the Python's file: the list, and a duplicate import, are the Python's record.
    expect(M.assetsListRoute(user).body).toEqual({ assets: [pyImport!.body.asset] })
    expect((await M.assetImportRoute(user, input, { path: 'one.png' }, async () => null)).body)
      .toEqual({ asset: pyImport!.body.asset, created: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(pyBytes)

    // Native adds one; the Python reads both back, and the file is what the Python would write.
    const mine = (await M.assetImportRoute(user, input, { path: 'two ü.png' }, async () => null)).body as any
    const [pyList, pyDup] = python(root, [
      { handler: '_assets_list_route', path: '/sailor/assets' },
      { handler: '_asset_import_route', path: '/sailor/asset_import', body: JSON.stringify({ path: 'two ü.png' }) },
    ])
    expect(pyList!.body).toEqual({ assets: [pyImport!.body.asset, mine.asset] })
    expect(pyDup!.body).toEqual({ asset: mine.asset, created: false })
    expect(mine.asset).toMatchObject({ width: 33, height: 77, kind: 'image' })

    // The Python deletes the native record: the file it leaves is the one native writes for the same delete.
    const before = fs.readFileSync(file, 'utf8')
    python(root, [{ handler: '_asset_delete_route', path: `/sailor/assets/${mine.asset.id}`, match_info: { asset_id: mine.asset.id } }])
    const pyAfter = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, before)
    M.assetDeleteRoute(user, mine.asset.id)
    expect(fs.readFileSync(file, 'utf8')).toBe(pyAfter)
  })

  it('asset_import errors: the same status and body', async () => {
    const bodies = [JSON.stringify({}), JSON.stringify({ path: '' }), JSON.stringify({ path: 'nope.png' }), JSON.stringify({ path: null })]
    const py = python(root, bodies.map(body => ({ handler: '_asset_import_route', path: '/sailor/asset_import', body })))
    for (const [i, body] of bodies.entries()) {
      const r = await M.assetImportRoute(user, input, JSON.parse(body), async () => null)
      expect(r, body).toEqual({ status: py[i]!.status, body: py[i]!.body })
    }
  })

  it('input thumbnails: the Python\'s cache file name, and the same thumbnail size', async () => {
    await png(path.join(input, 'wide pic.png'), 301, 100)
    fs.utimesSync(path.join(input, 'wide pic.png'), 1_790_000_000.75, 1_790_000_000.75)
    const [py] = python(root, [{ handler: '_input_thumbnail_route', path: `/sailor/input_thumbnail?filename=${encodeURIComponent('wide pic.png')}` }])
    expect(py!.status).toBe(200)
    expect(py!.cache_control).toBe('max-age=86400')
    const cached = fs.readdirSync(path.join(user, 'timeline_thumbs'))
    expect(cached).toEqual([M.inputThumbName('wide pic.png', 1_790_000_000.75)])

    const pyMeta = await sharp(Buffer.from(py!.body, 'base64')).metadata()
    const nativeBuf = await M.imageThumbnailPng(path.join(input, 'wide pic.png'))
    const nMeta = await sharp(nativeBuf!).metadata()
    expect([nMeta.width, nMeta.height, nMeta.channels]).toEqual([pyMeta.width, pyMeta.height, pyMeta.channels])

    // Native serves the Python's cached bytes as-is.
    const served = await M.inputThumbnailRoute(user, input, 'wide pic.png', async () => null)
    expect((served.body as Buffer).toString('base64')).toBe(py!.body)
  })

  it('asset thumbnails: native serves the Python\'s cache file, and writes the same file name and format', async () => {
    await png(path.join(input, 'still.png'), 64, 48)
    python(root, [{ handler: '_asset_import_route', path: '/sailor/asset_import', body: JSON.stringify({ path: 'still.png' }) }])
    const id = M.loadAssets(user)[0].id
    const [py] = python(root, [{ handler: '_asset_thumbs_route', path: `/sailor/asset_thumbnails?asset_id=${id}&count=3` }])
    const pyFile = path.join(user, 'timeline_thumbs', `${id}.3.json`)
    const pyBytes = fs.readFileSync(pyFile, 'utf8')
    expect((await M.assetThumbnailsRoute(user, new URLSearchParams(`asset_id=${id}&count=3`), async () => null)).body).toEqual(py!.body)

    fs.rmSync(pyFile)
    const mine = (await M.assetThumbnailsRoute(user, new URLSearchParams(`asset_id=${id}&count=3`), async () => null)).body as any
    const nativeBytes = fs.readFileSync(pyFile, 'utf8')
    // Same layout: only the PNG bytes inside the data URL differ (different encoders).
    const shape = (s: string) => s.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/, 'data:…')
    expect(shape(nativeBytes)).toBe(shape(pyBytes))
    expect(mine.thumbnails).toHaveLength(py!.body.thumbnails.length)
  })
})
