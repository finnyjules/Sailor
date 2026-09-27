/**
 * Live previews through the runner (step 3, R2.11): the browser's request.
 * livePreviewRequest walks up from the node through what the preview works
 * out itself and pins the first node on each path that it doesn't, by the
 * files that node last showed; null runs the node as before.
 */
import { describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { parseFamilies } from '#shared/runner/families'
import { filesShownBy, livePreviewRequest, previewEnvelope, previewPromptId, sendLivePreview, type PreviewFile } from '~/lib/runner/livePreview'
import { isRunnerPromptId } from '#shared/runner/messages'

const ON = parseFamilies('cards,effects-tone,effects-blur,live-previews')
const card = (image = 'fox.png') => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const blur = (from: [string, number], radius = 2) => ({ class_type: 'Blur', inputs: { image: from, type: 'gaussian', radius, angle: 0, length: 0, strength: 1 } })
const curves = (from: [string, number], midtones = 1.2) => ({ class_type: 'AdjustCurves', inputs: { image: from, blacks: 0, midtones, whites: 1 } })
const generate = () => ({ class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } })
const shown: Record<string, PreviewFile[]> = {
  1: [{ filename: 'fox.png', subfolder: '', type: 'input' }],
  7: [{ filename: 'generate_image_00001_.png', subfolder: '', type: 'output' }],
}
const lastFiles = (id: string) => shown[id] ?? null

describe('livePreviewRequest', () => {
  it('a slider change on Image card → Blur → Adjust curves pins the Image card and sends both effects', () => {
    const prompt: ApiPrompt = { 1: card(), 2: blur(['1', 0]), 3: curves(['2', 0]) }
    const req = livePreviewRequest(prompt, '3', ON, lastFiles)
    expect(req).toEqual({
      nodeId: '3',
      prompt: { 1: prompt[1], 2: prompt[2], 3: prompt[3] },
      pinned: { 1: [{ filename: 'fox.png', subfolder: '', type: 'input' }] },
    })
  })

  it('Generate an image → Blur pins the provider by its last output file; before it has one, the old path', () => {
    const prompt: ApiPrompt = { 7: generate(), 2: blur(['7', 0]) }
    expect(livePreviewRequest(prompt, '2', ON, lastFiles)).toEqual({
      nodeId: '2', prompt, pinned: { 7: [{ filename: 'generate_image_00001_.png', subfolder: '', type: 'output' }] },
    })
    expect(livePreviewRequest(prompt, '2', ON, () => null)).toBeNull()
    expect(livePreviewRequest(prompt, '2', ON, () => [])).toBeNull()
  })

  it('a chain with an effect whose family is off is left to the old path', () => {
    const prompt: ApiPrompt = { 1: card(), 2: blur(['1', 0]), 3: curves(['2', 0]) }
    // Blur's family (effects-blur) off: Adjust curves can't be previewed through it.
    expect(livePreviewRequest(prompt, '3', parseFamilies('cards,effects-tone,live-previews'), lastFiles)).toBeNull()
    // The target's own family off.
    expect(livePreviewRequest(prompt, '3', parseFamilies('cards,effects-blur,live-previews'), lastFiles)).toBeNull()
  })

  it('with live-previews off, or cards off, nothing is asked', () => {
    const prompt: ApiPrompt = { 1: card(), 2: blur(['1', 0]) }
    expect(livePreviewRequest(prompt, '2', parseFamilies('cards,effects-blur'), lastFiles)).toBeNull()
    // live-previews needs cards (FAMILY_REQUIRES): without it the family isn't on.
    expect(livePreviewRequest(prompt, '2', parseFamilies('effects-blur,live-previews'), lastFiles)).toBeNull()
  })

  it('a Shader effect, a closed Gate or Painter as the target leaves the preview to the old path', () => {
    const shader: ApiPrompt = { 1: card(), 5: { class_type: 'ShaderEffect', inputs: { image: ['1', 0] } }, 2: blur(['5', 0]) }
    expect(livePreviewRequest(shader, '2', parseFamilies('cards,effects-blur,shader-bake,live-previews'), () => shown[1]!)).toBeNull()
    const gate: ApiPrompt = { 1: card(), 4: { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: false } }, 2: blur(['4', 0]) }
    expect(livePreviewRequest(gate, '2', ON, lastFiles)).toBeNull()
    const open: ApiPrompt = { ...gate, 4: { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: true } } }
    expect(livePreviewRequest(open, '2', ON, lastFiles)?.pinned).toEqual({ 1: shown[1] })
  })

  it('an Image card fed by a wire is worked out, not pinned', () => {
    const prompt: ApiPrompt = { 7: generate(), 8: { class_type: 'Image', inputs: { image: '', export: true, images: ['7', 0], batch_index: -1 } }, 2: blur(['8', 0]) }
    const req = livePreviewRequest(prompt, '2', ON, lastFiles)
    expect(Object.keys(req!.prompt).sort()).toEqual(['2', '7', '8'])
    expect(req!.pinned).toEqual({ 7: shown[7] })
  })

  it('a pin read on a mask slot is left to the old path', () => {
    const fam = parseFamilies('cards,effects-mask,live-previews')
    // The mask worked out here from the pinned picture (Image to mask): previewed.
    const worked: ApiPrompt = {
      9: { class_type: 'LoadImage', inputs: { image: 'fox.png' } },
      6: { class_type: 'ImageToMask', inputs: { image: ['9', 0], channel: 'red' } },
      3: { class_type: 'ApplyMask', inputs: { image: ['9', 0], mask: ['6', 0], invert: false } },
    }
    expect(livePreviewRequest(worked, '3', fam, () => shown[1]!)).toEqual({ nodeId: '3', prompt: worked, pinned: { 9: shown[1] } })
    // The LoadImage's own MASK: the old path.
    const prompt: ApiPrompt = { ...worked, 3: { class_type: 'ApplyMask', inputs: { image: ['9', 0], mask: ['9', 1], invert: false } } }
    delete prompt[6]
    expect(livePreviewRequest(prompt, '3', fam, () => shown[1]!)).toBeNull()
  })

  it('reads a node’s shown files from its /view addresses', () => {
    expect(filesShownBy(['/view?filename=a.png&type=temp&subfolder=sailor_runner'])).toEqual([{ filename: 'a.png', subfolder: 'sailor_runner', type: 'temp' }])
    expect(filesShownBy(['/api/view?filename=a.png&type=input'])).toEqual([{ filename: 'a.png', subfolder: '', type: 'input' }])
    expect(filesShownBy(['blob:http://x/1'])).toBeNull()
    expect(filesShownBy(['https://elsewhere.test/view?filename=a.png'])).toBeNull()
    expect(filesShownBy(['/view?filename=a.png&type=kept'])).toBeNull()
    expect(filesShownBy([])).toBeNull()
  })
})

describe('sendLivePreview', () => {
  const body = { nodeId: '2', prompt: {}, pinned: {}, canvasId: 'c1' }
  it('a newer request for the same node cancels the older, which shows nothing', async () => {
    let first!: AbortSignal
    const post = (_b: unknown, signal: AbortSignal) => {
      if (!first) {
        first = signal
        return new Promise<{ ui: Record<string, unknown> }>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
      }
      return Promise.resolve({ ui: { images: [] } })
    }
    const a = sendLivePreview(body, post)
    const b = sendLivePreview(body, post)
    expect(await a).toEqual({ kind: 'dropped' })
    expect(await b).toEqual({ kind: 'shown', ui: { images: [] } })
    expect(first.aborted).toBe(true)
  })
  it('reads the route’s answers', async () => {
    const fail = (statusCode: number, data?: unknown, message = 'no') => async () => { throw Object.assign(new Error(message), { statusCode, data: { message, data } }) }
    expect(await sendLivePreview(body, fail(409, { reason: 'superseded' }))).toEqual({ kind: 'dropped' })
    expect(await sendLivePreview(body, fail(409))).toEqual({ kind: 'fallback' })
    expect(await sendLivePreview(body, fail(404))).toEqual({ kind: 'fallback' })
    expect(await sendLivePreview(body, fail(429))).toEqual({ kind: 'dropped' })
    expect(await sendLivePreview(body, fail(413, { nodeId: '1', classType: 'Blur' }, 'Too large'))).toEqual({ kind: 'failed', nodeId: '1', classType: 'Blur', message: 'Too large' })
    expect(await sendLivePreview(body, fail(403))).toEqual({ kind: 'failed', nodeId: '2', classType: null, message: 'no' })
  })
})

describe('the answer on the pipe', () => {
  it('is the runner’s own executed (or execution_error) event, for the canvas it was asked from', () => {
    const id = previewPromptId()
    expect(isRunnerPromptId(id)).toBe(true)
    const ui = { images: [{ filename: 'live_preview_3.png', subfolder: 'sailor_runner', type: 'temp' }], animated: [false] }
    expect(previewEnvelope(id, 'c1', { kind: 'shown', ui }, '3')).toEqual({
      type: 'sailor-bridge', v: 2, direct: true, event: 'executed', node_id: '3', output: ui, prompt_id: id, canvas_id: 'c1',
    })
    expect(previewEnvelope(id, 'c1', { kind: 'failed', nodeId: '2', classType: 'Blur', message: 'Too large' }, '3')).toMatchObject({
      type: 'sailor-bridge', event: 'execution_error', node_id: '2', node_type: 'Blur', exception_message: 'Too large', prompt_id: id, canvas_id: 'c1',
    })
  })
})
