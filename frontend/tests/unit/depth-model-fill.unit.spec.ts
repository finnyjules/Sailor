/**
 * Step 3, R10.5: the depth model is the only model Sailor still keeps on disk,
 * and the depth route fills its folder itself, locally. A fresh, empty
 * NUXT_DEPTH_MODEL_DIR is filled from the pinned revision, each file checked
 * against its sha256 before the loader may read it; hosted never downloads.
 * No network: every fetch here is fake.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hosted = vi.hoisted(() => ({ on: false }))
vi.mock('../../server/utils/deployMode', () => ({ isHosted: () => hosted.on }))

const transformers = vi.hoisted(() => ({ env: {} as Record<string, unknown>, pipeline: vi.fn() }))
vi.mock('@huggingface/transformers', () => transformers)

import {
  DEPTH_MODEL,
  DEPTH_MODEL_FILES,
  DEPTH_MODEL_REVISION,
  DEPTH_FILL_OVERALL_MS,
  DEPTH_FILL_STALL_MS,
  type DepthModelFill,
  depthModelFileUrl,
  depthModelReady,
  depthPipeline,
  fillDepthModel,
  setDepthModelFillForTests,
} from '../../server/utils/depthModel'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const BYTES: Record<string, Uint8Array> = {
  'config.json': new TextEncoder().encode('{"model_type":"depth_anything"}'),
  'preprocessor_config.json': new TextEncoder().encode('{"do_resize":true}'),
  'onnx/model.onnx': new Uint8Array(200_000).map((_, i) => (i * 31) & 255),
}
const FILES = Object.entries(BYTES).map(([path, b]) => ({ path, bytes: b.byteLength, sha256: sha(b) }))

/** The fill's dependencies: these files, a fake fetch, the real limits unless given. */
const fill = (o: Partial<DepthModelFill> & { fetch: DepthModelFill['fetch'] }): DepthModelFill =>
  ({ files: FILES, stallMs: DEPTH_FILL_STALL_MS, overallMs: DEPTH_FILL_OVERALL_MS, ...o })

function fakeFetch(serve: (path: string) => Uint8Array | null = p => BYTES[p] ?? null) {
  return vi.fn(async (url: string, _init?: { signal: AbortSignal }) => {
    const path = url.split(`/resolve/${DEPTH_MODEL_REVISION}/`)[1] ?? ''
    const b = serve(path)
    if (!b) return new Response('missing', { status: 404 })
    // Served in small chunks, as a real download arrives.
    let at = 0
    return new Response(new ReadableStream<Uint8Array>({
      pull(c) {
        if (at >= b.byteLength) return c.close()
        c.enqueue(b.slice(at, at + 16_384))
        at += 16_384
      },
    }))
  })
}

const dirs: string[] = []
const env = { ...process.env }
let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'depth-fill-'))
  dirs.push(dir)
  process.env.NUXT_DEPTH_MODEL_DIR = dir
  hosted.on = false
  transformers.env = {}
  transformers.pipeline.mockReset().mockResolvedValue('pipe')
})
afterEach(() => setDepthModelFillForTests())
afterAll(() => {
  process.env = env
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const listed = (d: string): string[] => readdirSync(d, { recursive: true }).map(String).sort()

describe('the depth model fills its own folder, locally (R10.5)', () => {
  it('fetches each file from the pinned revision, never `main`', () => {
    expect(depthModelFileUrl('onnx/model.onnx'))
      .toBe(`https://huggingface.co/${DEPTH_MODEL}/resolve/${DEPTH_MODEL_REVISION}/onnx/model.onnx`)
    expect(DEPTH_MODEL_FILES.map(f => f.path)).toEqual(['config.json', 'preprocessor_config.json', 'onnx/model.onnx'])
  })

  it('a fresh, empty folder: the depth route\'s pipeline fills it, then loads from disk only', async () => {
    const fetch = fakeFetch()
    setDepthModelFillForTests({ fetch, files: FILES })
    expect(listed(dir)).toEqual([])

    expect(await depthPipeline()).toBe('pipe')

    expect(fetch.mock.calls.map(c => c[0])).toEqual(FILES.map(f => depthModelFileUrl(f.path)))
    for (const f of FILES) expect(sha(readFileSync(join(dir, DEPTH_MODEL, f.path)))).toBe(f.sha256)
    expect(listed(dir).filter(p => p.endsWith('.part'))).toEqual([])
    expect(transformers.pipeline).toHaveBeenCalledWith('depth-estimation', DEPTH_MODEL)
    expect(transformers.env).toMatchObject({ localModelPath: dir, allowLocalModels: true, allowRemoteModels: false })
  })

  it('files already there at their sizes are not fetched again', async () => {
    const fetch = fakeFetch()
    await fillDepthModel(fill({ fetch }))
    fetch.mockClear()
    await fillDepthModel(fill({ fetch }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('only the missing or short file is fetched', async () => {
    const pre = join(dir, DEPTH_MODEL)
    mkdirSync(join(pre, 'onnx'), { recursive: true })
    writeFileSync(join(pre, 'config.json'), BYTES['config.json']!)
    writeFileSync(join(pre, 'preprocessor_config.json'), BYTES['preprocessor_config.json']!)
    writeFileSync(join(pre, 'onnx/model.onnx'), BYTES['onnx/model.onnx']!.slice(0, 10)) // a cut download
    const fetch = fakeFetch()
    await fillDepthModel(fill({ fetch }))
    expect(fetch.mock.calls.map(c => c[0])).toEqual([depthModelFileUrl('onnx/model.onnx')])
    expect(sha(readFileSync(join(pre, 'onnx/model.onnx')))).toBe(FILES[2]!.sha256)
  })

  it('a file that does not match its checksum is never left where the loader reads', async () => {
    const bad = new Uint8Array(BYTES['onnx/model.onnx']!)
    bad[5] ^= 1
    const fetch = fakeFetch(p => (p === 'onnx/model.onnx' ? bad : BYTES[p]!))
    await expect(fillDepthModel(fill({ fetch }))).rejects.toThrow(/checksum/)
    expect(existsSync(join(dir, DEPTH_MODEL, 'onnx/model.onnx'))).toBe(false)
    expect(listed(dir).filter(p => p.endsWith('.part'))).toEqual([])
  })

  it('a file larger than it should be is cut off and dropped', async () => {
    const big = new Uint8Array(BYTES['config.json']!.byteLength + 1)
    const fetch = fakeFetch(p => (p === 'config.json' ? big : BYTES[p]!))
    await expect(fillDepthModel(fill({ fetch }))).rejects.toThrow(/damaged \(config.json too large\)/)
    expect(existsSync(join(dir, DEPTH_MODEL, 'config.json'))).toBe(false)
  })

  it('a failed download fails the pipeline plainly, and the next call retries', async () => {
    setDepthModelFillForTests({ fetch: fakeFetch(() => null), files: FILES })
    await expect(depthPipeline()).rejects.toThrow(/couldn’t download the depth model \(config.json, 404\)/)
    expect(transformers.pipeline).not.toHaveBeenCalled()
    setDepthModelFillForTests({ fetch: fakeFetch(), files: FILES })
    expect(await depthPipeline()).toBe('pipe')
  })

  it('two callers at once share one download', async () => {
    const fetch = fakeFetch()
    await Promise.all([fillDepthModel(fill({ fetch })), fillDepthModel(fill({ fetch }))])
    expect(fetch).toHaveBeenCalledTimes(FILES.length)
  })

  it('the real file list makes `lens-blur` ready once filled (sizes checked)', async () => {
    // The runner's readiness reads DEPTH_MODEL_FILES; a fake download of
    // bytes at those sizes but other hashes is refused, so nothing lands.
    expect(depthModelReady()).toBe(false)
    const fetch = fakeFetch(() => new Uint8Array(38))
    await expect(fillDepthModel(fill({ fetch, files: DEPTH_MODEL_FILES }))).rejects.toThrow(/checksum/)
    expect(depthModelReady()).toBe(false)
  })

  it('hosted never downloads: the image ships the files', async () => {
    hosted.on = true
    const fetch = fakeFetch()
    await expect(fillDepthModel(fill({ fetch }))).rejects.toThrow('The depth model isn\'t installed on this server.')
    setDepthModelFillForTests({ fetch, files: FILES })
    await depthPipeline()
    expect(fetch).not.toHaveBeenCalled()
    expect(transformers.env).toMatchObject({ allowRemoteModels: false })
  })
})

// ── Fix round 1: stalls, a time cap, Stop, and stale parts ───────────────────

/** A body that sends `first` bytes of `path`, then waits on `gate` (never, unless released). */
function hangingFetch(first = 1000) {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => { release = r })
  const fetch = vi.fn(async (url: string, _init?: { signal: AbortSignal }) => {
    const path = url.split(`/resolve/${DEPTH_MODEL_REVISION}/`)[1] ?? ''
    const b = BYTES[path]!
    let at = 0
    return new Response(new ReadableStream<Uint8Array>({
      async pull(c) {
        if (at >= b.byteLength) return c.close()
        if (at >= Math.min(first, b.byteLength) && path === 'onnx/model.onnx') await gate
        const n = Math.min(b.byteLength, at + 1000)
        c.enqueue(b.slice(at, n))
        at = n
      },
    }))
  })
  return { fetch, release }
}

const parts = () => listed(dir).filter(p => p.endsWith('.part'))
async function settle(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 5))
  }
}

describe('the fill gives up, stops and cleans up (R10.5 fix round 1)', () => {
  it('nothing arriving for the stall time gives up plainly and leaves no part', async () => {
    const { fetch } = hangingFetch()
    await expect(fillDepthModel(fill({ fetch, stallMs: 40 })))
      .rejects.toThrow('Sailor couldn’t download the depth model (onnx/model.onnx, nothing arrived for 0 s). Check the connection and try again.')
    expect(parts()).toEqual([])
    expect(existsSync(join(dir, DEPTH_MODEL, 'onnx/model.onnx'))).toBe(false)
  })

  it('a download that keeps going past the overall cap gives up plainly', async () => {
    const slow = vi.fn(async (url: string) => {
      const path = url.split(`/resolve/${DEPTH_MODEL_REVISION}/`)[1] ?? ''
      const b = BYTES[path]!
      let at = 0
      return new Response(new ReadableStream<Uint8Array>({
        async pull(c) {
          await new Promise(r => setTimeout(r, 5))
          if (at >= b.byteLength) return c.close()
          c.enqueue(b.slice(at, at + 100))
          at += 100
        },
      }))
    })
    await expect(fillDepthModel(fill({ fetch: slow, overallMs: 60 }))).rejects.toThrow(/took too long\)\. Check the connection/)
    expect(parts()).toEqual([])
  })

  it('the fetch is handed a signal, and Stop cancels the download and deletes its part', async () => {
    const { fetch } = hangingFetch()
    const stop = new AbortController()
    const p = fillDepthModel(fill({ fetch }), stop.signal)
    await settle(() => parts().length === 1)
    stop.abort()
    await expect(p).rejects.toThrow('Stopped')
    const init = fetch.mock.calls.at(-1)![1]!
    expect(init.signal).toBeInstanceOf(AbortSignal)
    await settle(() => init.signal.aborted && parts().length === 0)
    expect(existsSync(join(dir, DEPTH_MODEL, 'onnx/model.onnx'))).toBe(false)
  })

  it('one run\'s Stop never breaks another run waiting on the same download', async () => {
    const { fetch, release } = hangingFetch()
    const a = new AbortController()
    const first = fillDepthModel(fill({ fetch }), a.signal)
    const second = fillDepthModel(fill({ fetch }), new AbortController().signal)
    await settle(() => parts().length === 1)
    a.abort()
    await expect(first).rejects.toThrow('Stopped')
    release()
    await second
    expect(fetch).toHaveBeenCalledTimes(FILES.length) // one download, shared
    for (const f of FILES) expect(sha(readFileSync(join(dir, DEPTH_MODEL, f.path)))).toBe(f.sha256)
    expect(parts()).toEqual([])
  })

  it('after every waiter stopped, the next call starts a fresh download', async () => {
    const hang = hangingFetch()
    const a = new AbortController()
    const first = fillDepthModel(fill({ fetch: hang.fetch }), a.signal)
    await settle(() => parts().length === 1)
    a.abort()
    await expect(first).rejects.toThrow('Stopped')
    await fillDepthModel(fill({ fetch: fakeFetch() }))
    for (const f of FILES) expect(sha(readFileSync(join(dir, DEPTH_MODEL, f.path)))).toBe(f.sha256)
  })

  it('a part older than an hour (a process killed mid-download) is swept; a fresh one is left', async () => {
    const root = join(dir, DEPTH_MODEL, 'onnx')
    mkdirSync(root, { recursive: true })
    const old = join(root, 'model.onnx.dead.part')
    const fresh = join(root, 'model.onnx.live.part')
    writeFileSync(old, 'x')
    writeFileSync(fresh, 'x')
    const twoHoursAgo = (Date.now() - 2 * 60 * 60_000) / 1000
    utimesSync(old, twoHoursAgo, twoHoursAgo)
    await fillDepthModel(fill({ fetch: fakeFetch() }))
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('a network error is plain words too', async () => {
    const broken = vi.fn(async () => { throw new TypeError('fetch failed') })
    await expect(fillDepthModel(fill({ fetch: broken }))).rejects.toThrow('Sailor couldn’t download the depth model (config.json, no answer). Check the connection and try again.')
  })
})
