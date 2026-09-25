/**
 * S1b fix round 1, controller rulings (a) and (d): a request no provider
 * takes is refused in plain words before it is sent, on both paths.
 *  - Nano Banana (text-to-image and edit): a prompt under 3 characters, as
 *    actually sent (after any style text). Hailuo H3: an empty prompt.
 *  - Seedance 2.0 references: at most 9 pictures, 3 videos, 3 sounds, and
 *    15 s of reference video, 15 s of reference sound, in all. Never dropped.
 * The runner refuses at the start of the run and again when it plans the
 * node; the ComfyUI path's /prompt gate (local proxy and hosted meter)
 * refuses the same nodes.
 */
import { describe, expect, it, vi } from 'vitest'
import { planNode } from '~~/server/runner/executors'
import {
  H3_SHORT_PROMPT, NANO_BANANA_SHORT_PROMPT, SEEDANCE_TOO_MUCH_SOUND, SEEDANCE_TOO_MUCH_VIDEO, requestProblems,
} from '~~/server/runner/requestRules'
import { blockedPromptRefusal } from '~~/server/utils/blockedModels'
import { seedanceReferenceSeconds } from '~~/server/utils/graphInputSeconds'
import { meterGraphSubmit } from '~~/server/utils/meterGraphRun'
import type { ApiPrompt } from '#shared/runner/graph'
import { makeKit } from './__runner__/kit'

const card = (from: string) => ({ class_type: 'Image', inputs: { image: '', export: false, images: [from, 0], batch_index: -1 } })
const img = (inputs: Record<string, unknown>): ApiPrompt => ({
  1: { class_type: 'GenerateImageNode', inputs: { model: 'nano-banana-2', prompt: 'a red fox', aspect_ratio: '1:1', seed: 0, model_options: '{}', ...inputs } },
  2: card('1'),
})
const vid = (inputs: Record<string, unknown>): ApiPrompt => ({
  1: { class_type: 'GenerateVideoNode', inputs: { model: 'hailuo-h3', prompt: 'a wave', aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{}', ...inputs } },
  2: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['1', 0] } },
})
const refs = (key: string, n: number) => JSON.stringify({ [key]: Array.from({ length: n }, (_, i) => `https://x/${key}${i}`) })
const plan = (prompt: ApiPrompt) => planNode({
  prompt, nodeId: '1', gateOpen: false,
  filesFrom: () => [{ filename: 'a.png', subfolder: '', type: 'input' }],
  toUrl: async () => 'https://fal.storage/a.png',
})
const messages = (p: ApiPrompt) => requestProblems(p).map(x => x.message)

describe('Nano Banana: a prompt under 3 characters, as sent', () => {
  it('is refused on text-to-image (2 and Pro), edit and references, and passes at 3', () => {
    for (const model of ['nano-banana-2', 'nano-banana-pro']) {
      for (const prompt of ['', 'p', 'ab']) expect(messages(img({ model, prompt })), `${model} "${prompt}"`).toEqual([NANO_BANANA_SHORT_PROMPT])
      expect(messages(img({ model, prompt: 'abc' }))).toEqual([])
    }
    const edit = { 1: { class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', prompt: 'x', input_image: ['9', 0] } } }
    expect(messages(edit)).toEqual([NANO_BANANA_SHORT_PROMPT])
    const refsNode = { 1: { class_type: 'GenerateFromReferencesNode', inputs: { model: 'nano-banana-2', prompt: 'p', image_1: ['9', 0] } } }
    expect(messages(refsNode)).toEqual([NANO_BANANA_SHORT_PROMPT])
    // Other models are not judged by this rule.
    expect(messages(img({ model: 'seedream-4', prompt: '' }))).toEqual([])
    expect(messages({ 1: { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', prompt: '' } } })).toEqual([])
  })

  it('counts the style text the node adds; a wired prompt part is left to the run', () => {
    expect(messages(img({ prompt: 'ab', style_block: 'soft light' }))).toEqual([])
    expect(messages(img({ prompt: '', style_in: 'ink' }))).toEqual([])
    expect(messages(img({ prompt: '', prompt_in: ['5', 0] }))).toEqual([])
    // Characters, not UTF-16 units: two emoji are two characters.
    expect(messages(img({ prompt: '🦊🦊' }))).toEqual([NANO_BANANA_SHORT_PROMPT])
  })

  it('the runner plan refuses it before any call; the /prompt gate answers 400 in ComfyUI\'s shape', async () => {
    await expect(plan(img({ prompt: 'ab' }))).rejects.toThrow(NANO_BANANA_SHORT_PROMPT)
    await expect(plan(img({ prompt: 'ab', style_block: 'soft light' }))).resolves.toMatchObject({ kind: 'provider' })
    const body = blockedPromptRefusal(img({ prompt: 'ab' }))!
    expect(body.error.message).toBe(NANO_BANANA_SHORT_PROMPT)
    expect((body.node_errors as any)[1].class_type).toBe('GenerateImageNode')
    expect(blockedPromptRefusal(img({ prompt: 'abc' }))).toBeNull()
  })

  it('the runner refuses the run before any hold; the hosted meter before pricing or hold', async () => {
    const k = makeKit({ hosted: true })
    await expect(k.engine.startRun({ userId: k.userId, takes: [img({ prompt: 'p' })], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toMatchObject({ statusCode: 400, message: NANO_BANANA_SHORT_PROMPT })
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()

    const d = meterDeps()
    const r = await meterGraphSubmit('u1', { prompt: img({ prompt: 'p' }) }, d as any)
    expect(r.status).toBe(400)
    expect((r.body as any).error.message).toBe(NANO_BANANA_SHORT_PROMPT)
    expect(d.priceGraph).not.toHaveBeenCalled()
    expect(d.hold).not.toHaveBeenCalled()
    expect(d.forward).not.toHaveBeenCalled()
  })
})

describe('Hailuo H3: an empty prompt', () => {
  it('is refused on H3 and H3 Max, by the plan and the gate; one character passes', async () => {
    for (const model of ['hailuo-h3', 'hailuo-h3-max']) {
      expect(messages(vid({ model, prompt: '' })), model).toEqual([H3_SHORT_PROMPT])
      expect(messages(vid({ model, prompt: 'a' })), model).toEqual([])
      await expect(plan(vid({ model, prompt: '' }))).rejects.toThrow(H3_SHORT_PROMPT)
      expect(blockedPromptRefusal(vid({ model, prompt: '' }))!.error.message).toBe(H3_SHORT_PROMPT)
    }
    // With a first frame (image-to-video) too.
    await expect(plan(vid({ prompt: '', image: ['9', 0] }))).rejects.toThrow(H3_SHORT_PROMPT)
  })
})

describe('Seedance 2.0 references: counts', () => {
  const cases: [string, number, string][] = [
    ['image_urls', 9, 'Seedance 2.0 takes at most 9 reference pictures.'],
    ['video_urls', 3, 'Seedance 2.0 takes at most 3 reference videos.'],
    ['audio_urls', 3, 'Seedance 2.0 takes at most 3 reference sounds.'],
  ]
  it.each(cases)('%s: %i pass, one more is refused (plan and gate), never dropped', async (key, max, message) => {
    const ok = vid({ model: 'seedance-2.0', model_options: refs(key, max) })
    expect(messages(ok)).toEqual([])
    const p = await plan(ok)
    if (p.kind !== 'provider') throw new Error('expected a provider plan')
    expect((p.payload[key] as unknown[]).length).toBe(max)
    const over = vid({ model: 'seedance-2.0', model_options: refs(key, max + 1) })
    expect(messages(over)).toEqual([message])
    await expect(plan(over)).rejects.toThrow(message)
    expect(blockedPromptRefusal(over)!.error.message).toBe(message)
    // With a first frame the references aren't sent, so nothing is refused.
    expect(messages(vid({ model: 'seedance-2.0', model_options: refs(key, max + 1), image: ['9', 0] }))).toEqual([])
  })
})

describe('Seedance 2.0 references: at most 15 s of video and 15 s of sound in all (the gate reads them)', () => {
  const view = (name: string) => `/view?filename=${name}&type=input`
  const seed = (opts: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    vid({ model: 'seedance-2.0', model_options: JSON.stringify(opts), ...extra })
  const lengths: Record<string, number> = { 'a.mp4': 8, 'b.mp4': 8, 'c.mp4': 7, 's1.wav': 10, 's2.wav': 6 }
  const read = vi.fn(async (f: { value: string }) => lengths[f.value] ?? null)

  it('refuses 16 s of video or of sound; 15 s passes; an unreadable reference isn\'t counted', async () => {
    expect((await seedanceReferenceSeconds(seed({ video_urls: [view('a.mp4'), view('b.mp4')] }), read)).map(p => p.message)).toEqual([SEEDANCE_TOO_MUCH_VIDEO])
    expect((await seedanceReferenceSeconds(seed({ video_urls: [view('a.mp4'), view('c.mp4')] }), read))).toEqual([])
    expect((await seedanceReferenceSeconds(seed({ audio_urls: [view('s1.wav'), view('s2.wav')] }), read)).map(p => p.message)).toEqual([SEEDANCE_TOO_MUCH_SOUND])
    expect((await seedanceReferenceSeconds(seed({ video_urls: [view('a.mp4'), 'https://elsewhere/x.mp4'] }), read))).toEqual([])
    // Not sent with a first frame: not read.
    read.mockClear()
    expect((await seedanceReferenceSeconds(seed({ video_urls: [view('a.mp4'), view('b.mp4')] }, { image: ['9', 0] }), read))).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('the hosted meter refuses it before pricing or any hold', async () => {
    const d = { ...meterDeps(), referenceSecondsProblems: (p: any) => seedanceReferenceSeconds(p, read) }
    const r = await meterGraphSubmit('u1', { prompt: seed({ video_urls: [view('a.mp4'), view('b.mp4')] }) }, d as any)
    expect(r.status).toBe(400)
    expect((r.body as any).error.message).toBe(SEEDANCE_TOO_MUCH_VIDEO)
    expect(d.priceGraph).not.toHaveBeenCalled()
    expect(d.hold).not.toHaveBeenCalled()
  })
})

function meterDeps() {
  return {
    priceGraph: vi.fn(() => ({ credits: 5, version: 'test', breakdown: [] })),
    spendGuard: vi.fn(async () => {}),
    validateFileRefs: vi.fn(async () => {}),
    moderatePrompt: vi.fn(async () => ({ ok: true as const })),
    hold: vi.fn(async () => ({ ok: true as const, holdId: 7 })),
    getAvailable: vi.fn(async () => 3),
    forward: vi.fn(async () => ({ status: 200, body: { prompt_id: 'p1', number: 1, node_errors: {} } })),
    registerRun: vi.fn(async () => {}),
    startSettle: vi.fn(),
    releaseHold: vi.fn(async () => {}),
  }
}
