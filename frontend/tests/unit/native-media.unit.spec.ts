/**
 * The media library Sailor now serves itself (server/native/media.ts), ported
 * from comfy_extras/nodes_timeline.py: input/output listings, the two file
 * deletes and their path guard, the Timeline asset library in
 * user/timeline_assets.json, and image thumbnails cached in
 * user/timeline_thumbs/. Every test works in its own temp engine root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import * as M from '../../server/native/media'
import { pySafeResolve } from '../../server/native/paths'
import { pyDumps } from '../../server/native/pyJson'

let root: string
let input: string
let output: string
let user: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-media-')))
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

async function png(file: string, w: number, h: number, alpha = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: { r: 200, g: 40, b: 10, alpha: 0.5 } } }).png().toFile(file)
}

const noEngine = async () => null

// ------------------------------------------------------------------ listings

describe('GET /sailor/output_listing', () => {
  it('walks every subfolder, keeps only media extensions, skips dotfiles, newest first', () => {
    touch(path.join(output, 'old.png'), 1_000)
    touch(path.join(output, 'a', 'b', 'deep.MP4'), 3_000)
    touch(path.join(output, 'a', 'song.flac'), 2_000)
    touch(path.join(output, 'notes.txt'), 4_000)
    touch(path.join(output, '.hidden.png'), 5_000)
    touch(path.join(output, '.cache', 'inside-hidden-dir.png'), 1_500) // hidden FOLDERS are walked
    touch(path.join(output, 'noext'), 6_000)

    const r = M.outputListing(output)
    expect(r.status).toBe(200)
    expect((r.body as any).items).toEqual([
      { filename: 'deep.MP4', subfolder: 'a/b', type: 'output', size: 1, mtime: 3000 },
      { filename: 'song.flac', subfolder: 'a', type: 'output', size: 1, mtime: 2000 },
      { filename: 'inside-hidden-dir.png', subfolder: '.cache', type: 'output', size: 1, mtime: 1500 },
      { filename: 'old.png', subfolder: '', type: 'output', size: 1, mtime: 1000 },
    ])
  })

  it('carries exactly filename, subfolder, type, size and mtime', () => {
    touch(path.join(output, 'x.webp'), 1_700_000_000, 'hello')
    const [item] = (M.outputListing(output).body as any).items
    expect(Object.keys(item)).toEqual(['filename', 'subfolder', 'type', 'size', 'mtime'])
    expect(item.size).toBe(5)
  })

  it('a missing output folder is an empty listing, not an error (os.walk swallows it)', () => {
    expect(M.outputListing(path.join(root, 'nope'))).toEqual({ status: 200, body: { items: [] } })
  })

  it('lists a symlinked folder\'s name but does not walk into it', () => {
    touch(path.join(root, 'elsewhere', 'outside.png'), 1_000)
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(output, 'linked'))
    expect((M.outputListing(output).body as any).items).toEqual([])
  })

  it('keeps mtime to the sub-second, the way Python\'s st_mtime reports it', () => {
    touch(path.join(output, 'f.png'), 1_790_212_572.1434236)
    const [item] = (M.outputListing(output).body as any).items
    expect(item.mtime).toBeCloseTo(1_790_212_572.1434236, 5)
  })
})

describe('GET /sailor/input_listing', () => {
  it('lists only the top level, with the absolute path, newest first', () => {
    touch(path.join(input, 'a.png'), 1_000)
    touch(path.join(input, 'b.wav'), 2_000)
    touch(path.join(input, 'sub', 'nested.png'), 3_000) // not top level
    touch(path.join(input, '.dot.png'), 4_000)
    touch(path.join(input, 'doc.pdf'), 5_000)
    fs.mkdirSync(path.join(input, 'folder.png')) // a folder named like media

    expect((M.inputListing(input).body as any).items).toEqual([
      { filename: 'b.wav', path: path.join(input, 'b.wav'), type: 'input', size: 1, mtime: 2000 },
      { filename: 'a.png', path: path.join(input, 'a.png'), type: 'input', size: 1, mtime: 1000 },
    ])
  })

  it('a missing input folder is a 500 carrying Python\'s error text and an empty list', () => {
    const missing = path.join(root, 'gone')
    expect(M.inputListing(missing)).toEqual({
      status: 500,
      body: { error: `[Errno 2] No such file or directory: '${missing}'`, items: [] },
    })
  })
})

// -------------------------------------------------------------------- deletes

describe('the delete guard (_safe_resolve)', () => {
  it('refuses empty or absolute names and absolute subfolders', () => {
    expect(pySafeResolve(output, '', '')).toBeNull()
    expect(pySafeResolve(output, '', '/etc/passwd')).toBeNull()
    expect(pySafeResolve(output, '/etc', 'passwd')).toBeNull()
  })

  it('refuses anything that normalises outside the root', () => {
    expect(pySafeResolve(output, '', '../input/a.png')).toBeNull()
    expect(pySafeResolve(output, '..', 'a.png')).toBeNull()
    expect(pySafeResolve(output, 'sub/../..', 'a.png')).toBeNull()
  })

  it('refuses a symlink that leads out of the root', () => {
    fs.symlinkSync(input, path.join(output, 'escape'))
    expect(pySafeResolve(output, 'escape', 'a.png')).toBeNull()
  })

  it('allows names inside the root, returning the normalised path', () => {
    expect(pySafeResolve(output, 'sub', 'a.png')).toBe(path.join(output, 'sub', 'a.png'))
    expect(pySafeResolve(output, '', 'sub/../a.png')).toBe(path.join(output, 'a.png'))
    expect(pySafeResolve(input, '', 'nested/x.png')).toBe(path.join(input, 'nested', 'x.png'))
  })
})

describe('DELETE /sailor/input_file and /sailor/output_file', () => {
  it('removes the file and answers ok', () => {
    touch(path.join(output, 'sub', 'a.png'), 1)
    expect(M.deleteFile(output, 'sub', 'a.png')).toEqual({ status: 200, body: { ok: true } })
    expect(fs.existsSync(path.join(output, 'sub', 'a.png'))).toBe(false)
  })

  it('a missing file (or a folder) is ok + missing, and nothing is touched', () => {
    fs.mkdirSync(path.join(output, 'dir'))
    expect(M.deleteFile(output, '', 'ghost.png')).toEqual({ status: 200, body: { ok: true, missing: true } })
    expect(M.deleteFile(output, '', 'dir')).toEqual({ status: 200, body: { ok: true, missing: true } })
    expect(fs.existsSync(path.join(output, 'dir'))).toBe(true)
  })

  it('an escaping name is a 400 and the outside file survives', () => {
    touch(path.join(input, 'keep.png'), 1)
    expect(M.deleteFile(output, '', '../input/keep.png')).toEqual({ status: 400, body: { error: 'invalid filename' } })
    expect(fs.existsSync(path.join(input, 'keep.png'))).toBe(true)
  })
})

// -------------------------------------------------------------- asset library

const PY_ASSETS = path.join(__dirname, 'fixtures', 'native-media-python-assets.json')

describe('the asset library file (user/timeline_assets.json)', () => {
  it('reads a Python-written file unchanged and writes it back byte for byte', () => {
    const bytes = fs.readFileSync(PY_ASSETS, 'utf8')
    fs.writeFileSync(path.join(user, 'timeline_assets.json'), bytes)
    const assets = M.loadAssets(user)
    expect(assets[0].name).toBe('clip ü 🎬.mp4')
    expect(assets[0].duration_sec).toBe(31.948583333333332)
    expect(assets[1].duration_sec).toBe(1e-5)
    expect(assets[2].duration_sec).toBeNull()
    M.saveAssets(user, assets)
    expect(fs.readFileSync(path.join(user, 'timeline_assets.json'), 'utf8')).toBe(bytes)
  })

  it('a missing or broken file is an empty library', () => {
    expect(M.assetsListRoute(user)).toEqual({ status: 200, body: { assets: [] } })
    fs.writeFileSync(path.join(user, 'timeline_assets.json'), '{broken')
    expect(M.assetsListRoute(user)).toEqual({ status: 200, body: { assets: [] } })
  })

  it('delete drops the record and always rewrites the file', () => {
    fs.writeFileSync(path.join(user, 'timeline_assets.json'), fs.readFileSync(PY_ASSETS))
    expect(M.assetDeleteRoute(user, 'b3c1')).toEqual({ status: 200, body: { ok: true } })
    expect(M.loadAssets(user).map((a: any) => a.id)).toEqual(['420ce63a-dc87-49c2-af11-efe583971e8e', '7d5666d1-0f1f-4c3c-b997-a1160d7133b5'])
    fs.rmSync(path.join(user, 'timeline_assets.json'))
    M.assetDeleteRoute(user, 'nothing')
    expect(fs.readFileSync(path.join(user, 'timeline_assets.json'), 'utf8')).toBe('[]')
  })
})

describe('timeline_assets.json writes are atomic and re-read just before writing (item 3)', () => {
  it('saveAssets writes via a temp file + rename, leaving no stray temp file behind', () => {
    M.saveAssets(user, [{ id: 'a' }])
    const entries = fs.readdirSync(user)
    expect(entries).toEqual(['timeline_assets.json'])
  })

  it('an assetDelete write leaves no stray temp file either', () => {
    fs.writeFileSync(path.join(user, 'timeline_assets.json'), pyDumps([{ id: 'a' }], 2))
    M.assetDeleteRoute(user, 'a')
    expect(fs.readdirSync(user)).toEqual(['timeline_assets.json'])
  })

  it('asset_import re-reads the file right before writing, so a record another writer added in between survives', async () => {
    await png(path.join(input, 'still.png'), 4, 4)
    const before = [{ id: 'existing-1', path: '/elsewhere/other.png', kind: 'image' }]
    const concurrent = { id: 'concurrent-1', path: '/elsewhere/new-from-elsewhere.png', kind: 'image' }
    const after = [...before, concurrent]
    fs.writeFileSync(path.join(user, 'timeline_assets.json'), pyDumps(before, 2))

    const real = fs.readFileSync.bind(fs)
    let assetsFileReads = 0
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: any[]) => {
      if (typeof args[0] === 'string' && args[0].endsWith('timeline_assets.json')) {
        assetsFileReads++
        // Simulate another writer landing its own change in the window
        // between the "does this path already exist" read and the write:
        // the FIRST read still sees the old file, every read after sees the
        // concurrently-updated one.
        return pyDumps(assetsFileReads === 1 ? before : after, 2)
      }
      return real(...(args as [any]))
    })

    const r = await M.assetImportRoute(user, input, { path: 'still.png' }, noEngine)
    spy.mockRestore()

    expect(assetsFileReads).toBeGreaterThanOrEqual(2) // proves a re-read actually happened
    expect(r.status).toBe(200)
    const saved = JSON.parse(fs.readFileSync(path.join(user, 'timeline_assets.json'), 'utf8'))
    // The concurrently-added record must still be there — a write built off
    // the STALE first read would have clobbered it.
    expect(saved.map((a: any) => a.id)).toEqual(['existing-1', 'concurrent-1', (r.body as any).asset.id])
  })
})

describe('POST /sailor/asset_import', () => {
  it('an image is probed with sharp, recorded once, and a second import returns the same record', async () => {
    await png(path.join(input, 'still.png'), 64, 30)
    const first = await M.assetImportRoute(user, input, { path: 'still.png' }, noEngine)
    const asset = (first.body as any).asset
    expect(first.status).toBe(200)
    expect((first.body as any).created).toBe(true)
    expect(Object.keys(asset)).toEqual(['id', 'path', 'kind', 'name', 'duration_sec', 'width', 'height', 'thumbnail_path', 'waveform_path'])
    expect(asset).toMatchObject({ path: path.join(input, 'still.png'), kind: 'image', name: 'still.png', duration_sec: null, width: 64, height: 30, thumbnail_path: null, waveform_path: null })
    expect(asset.id).toMatch(/^[0-9a-f-]{36}$/)

    const again = await M.assetImportRoute(user, input, { path: 'still.png' }, noEngine)
    expect(again.body).toEqual({ asset, created: false })
    expect(fs.readFileSync(path.join(user, 'timeline_assets.json'), 'utf8')).toBe(pyDumps([asset], 2))
  })

  it('keeps the path as joined, without normalising it (os.path.join)', async () => {
    await png(path.join(input, 'still.png'), 4, 4)
    fs.mkdirSync(path.join(input, 'sub'))
    const r = await M.assetImportRoute(user, input, { path: 'sub/../still.png' }, noEngine)
    expect((r.body as any).asset.path).toBe(`${input}/sub/../still.png`)
  })

  it('a video goes to the engine when it is reachable, and the engine\'s answer is returned', async () => {
    touch(path.join(input, 'clip.mp4'), 1)
    const engine = vi.fn(async () => ({ status: 200, body: { asset: { id: 'from-engine' }, created: true } }))
    const r = await M.assetImportRoute(user, input, { path: 'clip.mp4' }, engine)
    expect(engine).toHaveBeenCalledTimes(1)
    expect(r.body).toEqual({ asset: { id: 'from-engine' }, created: true })
    expect(fs.existsSync(path.join(user, 'timeline_assets.json'))).toBe(false)
  })

  it('without the engine, video and audio are still recorded, with null duration and size', async () => {
    touch(path.join(input, 'clip.mov'), 1)
    touch(path.join(input, 'voice.m4a'), 1)
    touch(path.join(input, 'odd.xyz'), 1)
    const v = (await M.assetImportRoute(user, input, { path: 'clip.mov' }, noEngine)).body as any
    const a = (await M.assetImportRoute(user, input, { path: 'voice.m4a' }, noEngine)).body as any
    const o = (await M.assetImportRoute(user, input, { path: 'odd.xyz' }, noEngine)).body as any
    expect(v.asset).toMatchObject({ kind: 'video', duration_sec: null, width: null, height: null })
    expect(a.asset).toMatchObject({ kind: 'audio', duration_sec: null, width: null, height: null })
    expect(o.asset.kind).toBe('video') // unknown extensions are video, as in _probe_media
    expect(M.loadAssets(user)).toHaveLength(3)
  })

  it('an image never goes to the engine', async () => {
    await png(path.join(input, 'still.png'), 4, 4)
    const engine = vi.fn(async () => null)
    await M.assetImportRoute(user, input, { path: 'still.png' }, engine)
    expect(engine).not.toHaveBeenCalled()
  })

  it('missing path is 400, a path that does not exist is 404 naming it', async () => {
    expect(await M.assetImportRoute(user, input, {}, noEngine)).toEqual({ status: 400, body: { error: 'missing \'path\'' } })
    expect(await M.assetImportRoute(user, input, { path: '' }, noEngine)).toEqual({ status: 400, body: { error: 'missing \'path\'' } })
    expect(await M.assetImportRoute(user, input, { path: 'nope.png' }, noEngine))
      .toEqual({ status: 404, body: { error: `not found: ${input}/nope.png` } })
  })

  it('a body that is not an object, or a non-string path, fails like the Python (a 500)', async () => {
    await expect(M.assetImportRoute(user, input, [1], noEngine)).rejects.toThrow()
    await expect(M.assetImportRoute(user, input, { path: 5 }, noEngine)).rejects.toThrow()
  })
})

// ------------------------------------------------------------------ thumbnails

describe('thumbnail cache names (user/timeline_thumbs/)', () => {
  it('input thumbnails: input_<sha1("<filename>:<int mtime>")>.png', () => {
    const expected = createHash('sha1').update('a b.png:1790212572').digest('hex')
    expect(M.inputThumbName('a b.png', 1_790_212_572.9)).toBe(`input_${expected}.png`)
  })

  it('asset thumbnails and waveforms keep the Python names', () => {
    expect(M.assetThumbsName('abc', 5)).toBe('abc.5.json')
    expect(M.waveformName('abc', 256)).toBe('wave_abc.256.json')
  })
})

describe('image thumbnails', () => {
  it('are 48 px high PNGs, width rounded half to even from the aspect, alpha dropped', async () => {
    // 100×32 → 150 exactly; 50×96 → 25; 5×96 → 2.5 → 2 (half to even); 7×96 → 3.5 → 4.
    for (const [w, h, tw] of [[100, 32, 150], [50, 96, 25], [5, 96, 2], [7, 96, 4], [1, 1000, 1]] as const) {
      const f = path.join(input, `t${w}x${h}.png`)
      await png(f, w, h, true)
      const buf = await M.imageThumbnailPng(f)
      const meta = await sharp(buf!).metadata()
      expect([meta.width, meta.height, meta.channels, meta.format], `${w}×${h}`).toEqual([tw, 48, 3, 'png'])
    }
  })

  it('an unreadable image gives no thumbnail', async () => {
    touch(path.join(input, 'bad.png'), 1, 'not a png')
    expect(await M.imageThumbnailPng(path.join(input, 'bad.png'))).toBeNull()
  })
})

describe('GET /sailor/input_thumbnail', () => {
  it('renders an image once, caches it under the Python name, then serves the cache', async () => {
    await png(path.join(input, 'a.png'), 96, 48)
    fs.utimesSync(path.join(input, 'a.png'), 1_700_000_000, 1_700_000_000)
    const r = await M.inputThumbnailRoute(user, input, 'a.png', noEngine)
    expect(r.status).toBe(200)
    expect(r.headers).toEqual({ 'content-type': 'image/png', 'cache-control': 'max-age=86400' })
    const cache = path.join(user, 'timeline_thumbs', M.inputThumbName('a.png', 1_700_000_000))
    expect(fs.readFileSync(cache)).toEqual(r.body)

    fs.writeFileSync(cache, 'cached-bytes')
    expect(String((await M.inputThumbnailRoute(user, input, 'a.png', noEngine)).body)).toBe('cached-bytes')
  })

  it('404s an empty name, a missing file, a folder, and anything outside input/', async () => {
    fs.mkdirSync(path.join(input, 'dir'))
    touch(path.join(output, 'o.png'), 1)
    for (const name of ['', 'missing.png', 'dir', '../output/o.png', path.join(output, 'o.png')]) {
      expect((await M.inputThumbnailRoute(user, input, name, noEngine)).status, name).toBe(404)
    }
  })

  it('a video goes to the engine; without it the answer is 503 — unless the engine already cached it', async () => {
    touch(path.join(input, 'clip.mp4'), 1_700_000_000)
    expect(await M.inputThumbnailRoute(user, input, 'clip.mp4', noEngine)).toEqual(M.MEDIA_UNAVAILABLE)
    expect(M.MEDIA_UNAVAILABLE).toEqual({ status: 503, body: { error: 'Sailor can’t read this file right now. Try again in a moment.' } })

    const engine = vi.fn(async () => ({ status: 200, body: Buffer.from('engine-png'), headers: { 'content-type': 'image/png' } }))
    expect(String((await M.inputThumbnailRoute(user, input, 'clip.mp4', engine)).body)).toBe('engine-png')

    fs.writeFileSync(path.join(user, 'timeline_thumbs', M.inputThumbName('clip.mp4', 1_700_000_000)), 'python-cached')
    expect(String((await M.inputThumbnailRoute(user, input, 'clip.mp4', noEngine)).body)).toBe('python-cached')
  })
})

describe('GET /sailor/asset_thumbnails', () => {
  const q = (s: string) => new URLSearchParams(s)
  beforeEach(async () => {
    await png(path.join(input, 'still.png'), 96, 48)
    touch(path.join(input, 'clip.mp4'), 1)
    fs.writeFileSync(path.join(user, 'timeline_assets.json'), pyDumps([
      { id: 'img', path: path.join(input, 'still.png'), kind: 'image' },
      { id: 'vid', path: path.join(input, 'clip.mp4'), kind: 'video' },
    ], 2))
  })

  it('an image asset: one data-URL thumbnail, cached as <id>.<count>.json in Python\'s compact format', async () => {
    const r = await M.assetThumbnailsRoute(user, q('asset_id=img&count=3'), noEngine)
    const body = r.body as any
    expect(r.status).toBe(200)
    expect(Object.keys(body)).toEqual(['thumbnails', 'asset_id', 'count'])
    expect(body.thumbnails).toHaveLength(1)
    expect(body.thumbnails[0]).toMatch(/^data:image\/png;base64,/)
    expect(body).toMatchObject({ asset_id: 'img', count: 3 })
    expect(fs.readFileSync(path.join(user, 'timeline_thumbs', 'img.3.json'), 'utf8')).toBe(pyDumps(body))
  })

  it('count is clamped to 1..20 and a non-integer falls back to 5, as int() would', async () => {
    const count = async (s: string) => ((await M.assetThumbnailsRoute(user, q(`asset_id=img&count=${s}`), noEngine)).body as any).count
    expect(await count('0')).toBe(1)
    expect(await count('99')).toBe(20)
    expect(await count('abc')).toBe(5)
    expect(await count('2.5')).toBe(5)
    expect(await count(' 7 ')).toBe(7)
    expect(await count('1_0')).toBe(10)
  })

  it('a cached answer is served as-is (even for a video, with the engine down)', async () => {
    fs.mkdirSync(path.join(user, 'timeline_thumbs'), { recursive: true })
    fs.writeFileSync(path.join(user, 'timeline_thumbs', 'vid.5.json'), '{"thumbnails": ["data:x"], "asset_id": "vid", "count": 5}')
    expect((await M.assetThumbnailsRoute(user, q('asset_id=vid'), noEngine)).body).toEqual({ thumbnails: ['data:x'], asset_id: 'vid', count: 5 })
  })

  it('missing asset_id is 400, an unknown asset 404, a video without the engine 503', async () => {
    expect(await M.assetThumbnailsRoute(user, q(''), noEngine)).toEqual({ status: 400, body: { error: 'missing asset_id' } })
    expect(await M.assetThumbnailsRoute(user, q('asset_id=ghost'), noEngine)).toEqual({ status: 404, body: { error: 'asset not found' } })
    expect(await M.assetThumbnailsRoute(user, q('asset_id=vid'), noEngine)).toEqual(M.MEDIA_UNAVAILABLE)
  })

  it('an asset id that would climb out of the cache folder never reads or writes a file there', async () => {
    fs.writeFileSync(path.join(user, 'secret.5.json'), '{"leak": true}')
    const r = await M.assetThumbnailsRoute(user, q('asset_id=../secret'), noEngine)
    expect(r).toEqual({ status: 404, body: { error: 'asset not found' } })
  })

  // A2 follow-up fix, item 5: `field(asset, 'path')` replaces `String(asset.path)`
  // so a stored record with no 'path' key fails the same way the Python does
  // (`asset["path"]` raises KeyError, an uncaught 500) instead of silently
  // reading as the string "undefined".
  it('an asset record with no path key 500s like Python\'s KeyError, not a lookup for the literal string "undefined"', async () => {
    fs.writeFileSync(path.join(user, 'timeline_assets.json'), pyDumps([{ id: 'no-path', kind: 'image' }], 2))
    await expect(M.assetThumbnailsRoute(user, q('asset_id=no-path'), noEngine)).rejects.toThrow(/path/)
    // And it must not have gone looking for a file literally named "undefined".
    expect(fs.existsSync(path.join(input, 'undefined'))).toBe(false)
  })
})

describe('GET /sailor/asset_waveform', () => {
  const q = (s: string) => new URLSearchParams(s)
  beforeEach(() => {
    fs.writeFileSync(path.join(user, 'timeline_assets.json'), pyDumps([{ id: 'aud', path: '/x.wav', kind: 'audio' }], 2))
  })

  it('serves a cached wave_<id>.<buckets>.json; buckets clamp to 16..2048', async () => {
    fs.mkdirSync(path.join(user, 'timeline_thumbs'))
    fs.writeFileSync(path.join(user, 'timeline_thumbs', 'wave_aud.16.json'), '{"peaks": [0.5], "asset_id": "aud", "buckets": 16}')
    expect((await M.assetWaveformRoute(user, q('asset_id=aud&buckets=3'), noEngine)).body).toEqual({ peaks: [0.5], asset_id: 'aud', buckets: 16 })
  })

  it('400 without an id, 404 for an unknown asset, otherwise the engine or 503', async () => {
    expect(await M.assetWaveformRoute(user, q(''), noEngine)).toEqual({ status: 400, body: { error: 'missing asset_id' } })
    expect(await M.assetWaveformRoute(user, q('asset_id=ghost'), noEngine)).toEqual({ status: 404, body: { error: 'asset not found' } })
    expect(await M.assetWaveformRoute(user, q('asset_id=aud'), noEngine)).toEqual(M.MEDIA_UNAVAILABLE)
    const engine = async () => ({ status: 200, body: { peaks: [1], asset_id: 'aud', buckets: 256 } })
    expect((await M.assetWaveformRoute(user, q('asset_id=aud'), engine)).body).toEqual({ peaks: [1], asset_id: 'aud', buckets: 256 })
  })
})

// Step 4, C5: forwardToEngine is gone (no engine to ask); the routes' stand-in answers null.

describe('Python-isms', () => {
  it('pyExt follows os.path.splitext', () => {
    expect(M.pyExt('a.PNG')).toBe('.png')
    expect(M.pyExt('.png')).toBe('')
    expect(M.pyExt('..png')).toBe('')
    expect(M.pyExt('.a.png')).toBe('.png')
    expect(M.pyExt('noext')).toBe('')
    expect(M.pyExt('dir.d/file')).toBe('')
  })

  it('pyRound rounds half to even', () => {
    expect([0.5, 1.5, 2.5, 2.4999, 2.5001].map(M.pyRound)).toEqual([0, 2, 2, 2, 3])
  })
})
