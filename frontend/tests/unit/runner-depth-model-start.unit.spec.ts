/**
 * Step 3, R10.5 fix round 1: locally, Lens · Depth of field's depth model is
 * fetched at the run's start, before anything is held or any paid node runs.
 * A fetch that fails refuses the run in the fill's own plain words: a paid
 * picture upstream is never made and charged, then lost to a Lens failure.
 * No network: the fetch is fake.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeKit, until } from './__runner__/kit'
import { DEPTH_FILL_OVERALL_MS, DEPTH_MODEL_FILES, fillDepthModel } from '~~/server/utils/depthModel'
import { ALL_RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { LENS_BLUR_CLASS } from '#shared/runner/lensBlur'
import type { ApiPrompt } from '#shared/runner/graph'

const families: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>([...ALL_RUNNER_FAMILIES, 'lens-blur'])
const LENS = { focus_point: '{"x":0.5,"y":0.5}', focus_offset: 0, aperture: 0.4, lens_preset: 'Custom', bokeh_shape: 'circular', highlight_bokeh: 0.3, chromatic_aberration: 0, vignette: 0, focal_length: 0 }
const SAVE = { filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: true }
/** A paid picture (Generate an image, saved) beside Lens · Depth of field with no depth wired: Lens needs the model. */
const graph = (depth?: unknown): ApiPrompt => ({
  g: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
  gs: { class_type: 'SaveImage', inputs: { images: ['g', 0], ...SAVE } },
  l: { class_type: 'LoadImage', inputs: { image: 'pic.png', upload: 'image' } },
  n: { class_type: LENS_BLUR_CLASS, inputs: { image: ['l', 0], ...LENS, ...(depth ? { depth } : {}) } },
  s: { class_type: 'SaveImage', inputs: { images: ['n', 0], ...SAVE } },
})

const dirs: string[] = []
const env = { ...process.env }
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'depth-start-'))
  dirs.push(dir)
  process.env.NUXT_DEPTH_MODEL_DIR = dir // a fresh, empty model folder
})
afterAll(() => {
  process.env = env
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const offline = vi.fn(async () => { throw new TypeError('fetch failed') })
const fillOffline = (signal?: AbortSignal) =>
  fillDepthModel({ fetch: offline, files: DEPTH_MODEL_FILES, stallMs: 1000, overallMs: DEPTH_FILL_OVERALL_MS }, signal)

const start = async (k: ReturnType<typeof makeKit>, takes: ApiPrompt[]) => {
  writeFileSync(join(k.root, 'input', 'pic.png'), await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 8, b: 7 } } }).png().toBuffer())
  return k.engine.startRun({ userId: k.userId, takes, workflow: null, canvasId: null, projectUuid: null, projectName: null })
}

describe('the depth model at the run\'s start (R10.5 fix round 1)', () => {
  it('a paid picture into Lens, an empty model folder and no connection: refused plainly, nothing held, no paid call', async () => {
    const k = makeKit({ deps: { families: () => families, depthModel: fillOffline } })
    await expect(start(k, [graph()])).rejects.toMatchObject({
      statusCode: 400,
      message: 'Sailor couldn’t download the depth model (config.json, no answer). Check the connection and try again.',
    })
    expect(offline).toHaveBeenCalled()
    await new Promise(r => setTimeout(r, 50)) // nothing started in the background either
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.graphRuns.create).not.toHaveBeenCalled()
    expect(k.fal.submitted()).toEqual([])
    expect(k.replicate.submitted()).toEqual([])
  })

  it('control: with the model ready, the same graph starts and its paid node is sent', async () => {
    const ready = vi.fn(async () => {})
    const k = makeKit({ deps: { families: () => families, depthModel: ready } })
    await start(k, [graph()])
    expect(ready).toHaveBeenCalledTimes(1)
    await until(() => k.fal.submitted().length > 0)
  })

  it('hosted control: the hold this refusal comes before is a real one', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => families } })
    await start(k, [graph(['l', 0])])
    await until(() => k.ledger.hold.mock.calls.length > 0)
  })

  it('Lens with its depth wired needs no model: nothing is fetched', async () => {
    const asked = vi.fn(async () => {})
    const k = makeKit({ deps: { families: () => families, depthModel: asked } })
    const g = graph(['l', 0])
    await start(k, [g])
    expect(asked).not.toHaveBeenCalled()
  })

  it('hosted never fetches at the start (the image ships the files)', async () => {
    const asked = vi.fn(async () => {})
    const k = makeKit({ hosted: true, deps: { families: () => families, depthModel: asked } })
    await start(k, [graph()]).catch(() => {})
    expect(asked).not.toHaveBeenCalled()
  })
})
