/**
 * Final review finding 1 (model line-up, final fix F1): every size-priced
 * node refuses a measured picture above the input cap, before anything is
 * sent or held. FLUX.2 [pro] edit (Edit an image and Blend scene), Upscale
 * and Enhance detail bill by the size of the picture they are sent, and the
 * price stops at LARGEST_INPUT_PIXELS (about 19 MP), so a 45 MP camera photo
 * would cost Sailor more than it is charged. Rotate camera on 2511 already
 * did this (F10 fix round 1); the check is now one rule for all of them:
 *  - the runner, after measuring and before the hand-off (the node fails and
 *    its hold is released);
 *  - the hosted /prompt gate (the ComfyUI path), before the hold.
 * The runner measures the file it sends (the first on the link), whatever
 * the batch's length.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { LARGEST_INPUT_PIXELS } from '#shared/pricing/editSettings'
import { measuredInputPixels } from '~~/server/runner/metering'
import {
  ENHANCE_DETAIL_TOO_LARGE, FLUX_2_EDIT_TOO_LARGE, ROTATE_CAMERA_TOO_LARGE, UPSCALE_TOO_LARGE, measuredInputProblem, measuredInputProblems,
} from '~~/server/runner/requestRules'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { makeKit, ofType } from './__runner__/kit'

const MP = 1_000_000
const OVER = LARGEST_INPUT_PIXELS + 1
const FAL_EDIT: ReadonlySet<RunnerFamily> = new Set(['fal-edit'])
const ANGLES: ReadonlySet<RunnerFamily> = new Set(['qwen-2511-angles'])
const SINK = { class_type: 'SaveImage', inputs: {} }

describe('the rule: every size-priced node, above the cap', () => {
  it('the words: plain, sentence case, the model\'s or the node\'s own name', () => {
    expect(FLUX_2_EDIT_TOO_LARGE).toBe('Flux 2 Pro takes pictures up to about 19 megapixels. Make this one smaller first.')
    expect(UPSCALE_TOO_LARGE).toBe('Upscale an image takes pictures up to about 19 megapixels. Make this one smaller first.')
    expect(ENHANCE_DETAIL_TOO_LARGE).toBe('Enhance detail takes pictures up to about 19 megapixels. Make this one smaller first.')
  })

  it('FLUX.2 edit in Edit an image and Blend scene (and a linked or missing model, which may be it); Upscale; Enhance detail; Rotate camera on 2511', () => {
    expect(measuredInputProblem('EditImageNode', OVER, NO_FAMILIES, { model: 'Flux 2 Pro' })).toBe(FLUX_2_EDIT_TOO_LARGE)
    expect(measuredInputProblem('EditImageNode', 48 * MP, FAL_EDIT, { model: ['3', 0] })).toBe(FLUX_2_EDIT_TOO_LARGE)
    expect(measuredInputProblem('EditImageNode', 48 * MP, FAL_EDIT, {})).toBe(FLUX_2_EDIT_TOO_LARGE)
    expect(measuredInputProblem('BlendSceneNode', 48 * MP, FAL_EDIT, { model: 'Flux 2 Pro' })).toBe(FLUX_2_EDIT_TOO_LARGE)
    expect(measuredInputProblem('UpscaleImageNode', OVER, NO_FAMILIES, { model: 'Crystal' })).toBe(UPSCALE_TOO_LARGE)
    expect(measuredInputProblem('EnhanceDetailNode', OVER, NO_FAMILIES, { model: 'Faithful' })).toBe(ENHANCE_DETAIL_TOO_LARGE)
    expect(measuredInputProblem('RotateCameraNode', OVER, ANGLES)).toBe(ROTATE_CAMERA_TOO_LARGE)
  })

  it('at the cap, below it or unmeasured: sent; a model or class not priced by size: never refused', () => {
    for (const px of [LARGEST_INPUT_PIXELS, MP, undefined]) {
      expect(measuredInputProblem('EditImageNode', px, FAL_EDIT, { model: 'Flux 2 Pro' })).toBeNull()
      expect(measuredInputProblem('UpscaleImageNode', px, NO_FAMILIES, { model: 'Crystal' })).toBeNull()
    }
    for (const model of ['Nano Banana 2', 'Flux Kontext Pro', 'GPT Image 2.5']) {
      expect(measuredInputProblem('EditImageNode', 48 * MP, FAL_EDIT, { model })).toBeNull()
      expect(measuredInputProblem('BlendSceneNode', 48 * MP, FAL_EDIT, { model })).toBeNull()
    }
    // Rotate camera's 2509 call (switch off) bills a flat price.
    expect(measuredInputProblem('RotateCameraNode', 48 * MP, NO_FAMILIES)).toBeNull()
    expect(measuredInputProblem('RemoveObjectNode', 48 * MP, FAL_EDIT, {})).toBeNull()
  })

  it('over a whole prompt (the hosted gate): each node over the cap, pointing at its picture input', () => {
    const prompt: ApiPrompt = {
      1: { class_type: 'LoadImage', inputs: { image: 'big.jpg' } },
      2: { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['1', 0] } },
      3: { class_type: 'UpscaleImageNode', inputs: { model: 'Crystal', image: ['1', 0] } },
      4: { class_type: 'BlendSceneNode', inputs: { model: 'Flux 2 Pro', image: ['1', 0] } },
      5: { class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['1', 0] } },
    }
    expect(measuredInputProblems(prompt, { 2: 48 * MP, 3: 2 * MP, 4: OVER, 5: 48 * MP })).toEqual([
      { nodeId: '2', classType: 'EditImageNode', input: 'input_image', message: FLUX_2_EDIT_TOO_LARGE },
      { nodeId: '4', classType: 'BlendSceneNode', input: 'image', message: FLUX_2_EDIT_TOO_LARGE },
    ])
    expect(measuredInputProblems(prompt, {})).toEqual([])
  })
})


describe('the runner engine', () => {
  const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#808080' } }).png({ compressionLevel: 9 }).toBuffer()
  const take = (node: { class_type: string, inputs: Record<string, unknown> }): ApiPrompt => ({
    11: { class_type: 'Image', inputs: { image: 'photo.png' } },
    1: node,
    2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  })
  const run = async (node: { class_type: string, inputs: Record<string, unknown> }, w: number, h: number) => {
    const k = makeKit({ hosted: true, deps: { families: () => FAL_EDIT } })
    writeFileSync(join(k.root, 'input', 'photo.png'), await png(w, h))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [take(node)], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    return k
  }

  for (const [name, node] of [
    ['Edit an image', { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['11', 0], prompt: 'warmer', output_format: 'png', seed: 0 } }],
    ['Blend scene', { class_type: 'BlendSceneNode', inputs: { model: 'Flux 2 Pro', image: ['11', 0], output_format: 'png', seed: 0 } }],
  ] as const) {
    it(`${name} on Flux 2 Pro with a 20 MP picture: fails in plain words, nothing uploaded or sent, the hold released`, async () => {
      const k = await run(node, 5000, 4000)
      expect(k.fal.reqs.size).toBe(0)
      expect(k.replicate.reqs.size).toBe(0)
      expect(k.upload.mock.calls.length).toBe(0)
      expect(ofType(k.seen, 'execution_error').map(m => m.data.exception_message)).toEqual([FLUX_2_EDIT_TOO_LARGE])
      expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
    })
  }

  it('Edit an image on Nano Banana 2 (priced by its settings, not the picture) with a 20 MP picture: sent', async () => {
    const k = await run({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['11', 0], prompt: 'warmer', resolution: '1K', output_format: 'png', seed: 0 } }, 5000, 4000)
    expect(ofType(k.seen, 'execution_error')).toEqual([])
    expect(k.fal.reqs.size + k.replicate.reqs.size).toBe(1)
  })

  it('Edit an image on Flux 2 Pro with a 1 MP picture: sent, charged on its size', async () => {
    const k = await run({ class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['11', 0], prompt: 'warmer', output_format: 'png', seed: 0 } }, 1000, 1000)
    expect(k.fal.reqs.size).toBe(1)
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['settled'])
  })

  it('measures the first file of a batch of nine: over the cap is refused, not priced at the cap', async () => {
    const big = new Uint8Array(await png(5000, 4000))
    const node = { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['1', 0] } }
    const f: OutputFile = { filename: 'a.png', subfolder: '', type: 'output' }
    const px = await measuredInputPixels(node, () => Array.from({ length: 9 }, () => f), async () => big, FAL_EDIT)
    expect(px).toBe(20 * MP)
    expect(measuredInputProblem(node.class_type, px, FAL_EDIT, node.inputs)).toBe(FLUX_2_EDIT_TOO_LARGE)
  })
})
