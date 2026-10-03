/**
 * Step 3, R10.5: the depth model is the only model Sailor still keeps on disk,
 * and the depth route fills its folder itself, locally. A fresh, empty
 * NUXT_DEPTH_MODEL_DIR is filled from the pinned revision, each file checked
 * against its sha256 before the loader may read it; hosted never downloads.
 * No network: every fetch here is fake.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function fakeFetch(serve: (path: string) => Uint8Array | null = p => BYTES[p] ?? null) {
  return vi.fn(async (url: string) => {
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
    await fillDepthModel({ fetch, files: FILES })
    fetch.mockClear()
    await fillDepthModel({ fetch, files: FILES })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('only the missing or short file is fetched', async () => {
    const pre = join(dir, DEPTH_MODEL)
    mkdirSync(join(pre, 'onnx'), { recursive: true })
    writeFileSync(join(pre, 'config.json'), BYTES['config.json']!)
    writeFileSync(join(pre, 'preprocessor_config.json'), BYTES['preprocessor_config.json']!)
    writeFileSync(join(pre, 'onnx/model.onnx'), BYTES['onnx/model.onnx']!.slice(0, 10)) // a cut download
    const fetch = fakeFetch()
    await fillDepthModel({ fetch, files: FILES })
    expect(fetch.mock.calls.map(c => c[0])).toEqual([depthModelFileUrl('onnx/model.onnx')])
    expect(sha(readFileSync(join(pre, 'onnx/model.onnx')))).toBe(FILES[2]!.sha256)
  })

  it('a file that does not match its checksum is never left where the loader reads', async () => {
    const bad = new Uint8Array(BYTES['onnx/model.onnx']!)
    bad[5] ^= 1
    const fetch = fakeFetch(p => (p === 'onnx/model.onnx' ? bad : BYTES[p]!))
    await expect(fillDepthModel({ fetch, files: FILES })).rejects.toThrow(/checksum/)
    expect(existsSync(join(dir, DEPTH_MODEL, 'onnx/model.onnx'))).toBe(false)
    expect(listed(dir).filter(p => p.endsWith('.part'))).toEqual([])
  })

  it('a file larger than it should be is cut off and dropped', async () => {
    const big = new Uint8Array(BYTES['config.json']!.byteLength + 1)
    const fetch = fakeFetch(p => (p === 'config.json' ? big : BYTES[p]!))
    await expect(fillDepthModel({ fetch, files: FILES })).rejects.toThrow(/damaged \(config.json too large\)/)
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
    await Promise.all([fillDepthModel({ fetch, files: FILES }), fillDepthModel({ fetch, files: FILES })])
    expect(fetch).toHaveBeenCalledTimes(FILES.length)
  })

  it('the real file list makes `lens-blur` ready once filled (sizes checked)', async () => {
    // The runner's readiness reads DEPTH_MODEL_FILES; a fake download of
    // bytes at those sizes but other hashes is refused, so nothing lands.
    expect(depthModelReady()).toBe(false)
    const fetch = fakeFetch(() => new Uint8Array(38))
    await expect(fillDepthModel({ fetch, files: DEPTH_MODEL_FILES })).rejects.toThrow(/checksum/)
    expect(depthModelReady()).toBe(false)
  })

  it('hosted never downloads: the image ships the files', async () => {
    hosted.on = true
    const fetch = fakeFetch()
    await expect(fillDepthModel({ fetch, files: FILES })).rejects.toThrow('The depth model isn\'t installed on this server.')
    setDepthModelFillForTests({ fetch, files: FILES })
    await depthPipeline()
    expect(fetch).not.toHaveBeenCalled()
    expect(transformers.env).toMatchObject({ allowRemoteModels: false })
  })
})
