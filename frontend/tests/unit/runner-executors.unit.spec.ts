import { describe, expect, it, vi } from 'vitest'
import { planNode, type PlanContext } from '~~/server/runner/executors'
import { STYLE_REFS_INSTRUCTION } from '~~/server/runner/generators/image'
import type { ApiPrompt } from '#shared/runner/graph'

const png = (n: string) => ({ filename: n, subfolder: '', type: 'output' as const })
function ctx(prompt: ApiPrompt, nodeId: string, over: Partial<PlanContext> = {}): PlanContext {
  return {
    prompt, nodeId, gateOpen: false,
    filesFrom: ([from]) => ({ '1': [png('a.png'), png('b.png')] } as Record<string, any>)[from] ?? [],
    toUrl: async f => `https://fal.test/${f.subfolder ? `${f.subfolder}/` : ''}${f.filename}`,
    ...over,
  }
}

describe('planNode', () => {
  it('image: builds the request and saves as generate_image', async () => {
    const p: ApiPrompt = { '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '16:9', seed: 4, model_options: '{"num_inference_steps":2}', style_block: 'soft' } } }
    const plan = await planNode(ctx(p, '1'))
    expect(plan).toMatchObject({ kind: 'provider', endpoint: 'fal-ai/flux/schnell', media: 'image', prefix: 'generate_image' })
    if (plan.kind !== 'provider') throw new Error()
    expect(plan.payload).toEqual({ prompt: 'soft a fox', image_size: 'landscape_16_9', num_inference_steps: 2, num_images: 1, output_format: 'png', seed: 4 })
    expect(plan.uiFor([png('x.png')])).toEqual({ images: [png('x.png')], animated: [false] })
  })
  it('image with moodboard pictures goes to the edit endpoint', async () => {
    const refs = JSON.stringify({ folder: 'moodboard_2', files: ['m1.png', 'm2.png'] })
    const p: ApiPrompt = { '1': { class_type: 'GenerateImageNode', inputs: { model: 'nano-banana-2', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}', style_refs: refs } } }
    const plan = await planNode(ctx(p, '1'))
    if (plan.kind !== 'provider') throw new Error()
    expect(plan.endpoint).toBe('fal-ai/nano-banana-2/edit')
    expect(plan.payload.image_urls).toEqual(['https://fal.test/moodboard_2/m1.png', 'https://fal.test/moodboard_2/m2.png'])
    expect(plan.payload.prompt).toBe(`a fox ${STYLE_REFS_INSTRUCTION}`)
  })
  it('a moodboard picture that cannot be read is skipped, like Python', async () => {
    const refs = JSON.stringify({ folder: 'moodboard_2', files: ['gone.png'] })
    const p: ApiPrompt = { '1': { class_type: 'GenerateImageNode', inputs: { model: 'nano-banana-2', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}', style_refs: refs } } }
    const plan = await planNode(ctx(p, '1', { toUrl: vi.fn(async () => { throw new Error('ENOENT') }) }))
    if (plan.kind !== 'provider') throw new Error()
    expect(plan.endpoint).toBe('fal-ai/nano-banana-2')
    expect(plan.payload.prompt).toBe('a fox')
  })
  it('video from the picture behind a Gate uses image-to-video', async () => {
    const p: ApiPrompt = { '3': { class_type: 'GenerateVideoNode', inputs: { model: 'hailuo-h3', prompt: 'moves', image: ['1', 0], aspect_ratio: '16:9', duration: '6', seed: 0, model_options: '{}' } } }
    const plan = await planNode(ctx(p, '3'))
    expect(plan).toMatchObject({ kind: 'provider', endpoint: 'minimax/h3/image-to-video', media: 'video', prefix: 'generate_video' })
    if (plan.kind !== 'provider') throw new Error()
    expect(plan.payload).toMatchObject({ image_url: 'https://fal.test/a.png', duration: 6 })
    expect(plan.uiFor([])).toBeNull()
  })
  it('text-to-video on Veo submits to the app itself', async () => {
    const p: ApiPrompt = { '3': { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1-fast', prompt: 'waves', aspect_ratio: '9:16', duration: '8', seed: 0, model_options: '{}' } } }
    const plan = await planNode(ctx(p, '3'))
    expect(plan).toMatchObject({ endpoint: 'fal-ai/veo3.1/fast' })
  })
  it('a closed Gate pauses with what it received; an open one passes it on', async () => {
    const p: ApiPrompt = { '2': { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: false } } }
    expect(await planNode(ctx(p, '2'))).toEqual({ kind: 'pause', files: [png('a.png'), png('b.png')] })
    expect(await planNode(ctx(p, '2', { gateOpen: true }))).toEqual({ kind: 'pass', files: [png('a.png'), png('b.png')], ui: null })
    const bypassed: ApiPrompt = { '2': { class_type: 'ComfyGateNode', inputs: { data_in: ['1', 0], bypass: true } } }
    expect((await planNode(ctx(bypassed, '2'))).kind).toBe('pass')
  })
  it('Image card: shows what it is given, one of a batch, or a loaded file', async () => {
    const wired: ApiPrompt = { '5': { class_type: 'Image', inputs: { images: ['1', 0], batch_index: -1 } } }
    expect(await planNode(ctx(wired, '5'))).toEqual({ kind: 'pass', files: [png('a.png'), png('b.png')], ui: { images: [png('a.png'), png('b.png')] } })
    const one: ApiPrompt = { '5': { class_type: 'Image', inputs: { images: ['1', 0], batch_index: 7 } } }
    expect(await planNode(ctx(one, '5'))).toEqual({ kind: 'pass', files: [png('b.png')], ui: { images: [png('b.png')] } })
    const loaded: ApiPrompt = { '5': { class_type: 'Image', inputs: { image: 'mine.png' } } }
    const f = { filename: 'mine.png', subfolder: '', type: 'input' }
    expect(await planNode(ctx(loaded, '5'))).toEqual({ kind: 'pass', files: [f], ui: { images: [f] } })
    const empty: ApiPrompt = { '5': { class_type: 'Image', inputs: { image: '' } } }
    expect(await planNode(ctx(empty, '5'))).toEqual({ kind: 'pass', files: [], ui: { images: [] } })
  })
  it('Video card marks its preview as moving', async () => {
    const p: ApiPrompt = { '4': { class_type: 'Video', inputs: { source: ['1', 0] } } }
    expect(await planNode(ctx(p, '4'))).toEqual({ kind: 'pass', files: [png('a.png'), png('b.png')], ui: { images: [png('a.png'), png('b.png')], animated: [true] } })
  })
})
