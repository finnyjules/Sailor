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
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { RUNNER_FAMILIES } from '#shared/runner/families'
import { planNode } from '~~/server/runner/executors'
import { H3_MAX_TURBO_NEEDS_PROMPT } from '~~/server/runner/generators/h3MaxTurbo'
import { WAN_3_NEEDS_PROMPT } from '~~/server/runner/generators/wan3'
import { GPT_IMAGE_25_NEEDS_PROMPT } from '~~/server/runner/generators/gptImage25'
import {
  FIRST_FRAME_AND_REFERENCES, GEMINI_OMNI_FLASH_NEEDS_PROMPT, H3_SHORT_PROMPT, NANO_BANANA_SHORT_PROMPT, SEEDANCE_TOO_MUCH_SOUND, SEEDANCE_TOO_MUCH_VIDEO,
  SEEDANCE_UNMEASURED_REFERENCE, requestProblems,
} from '~~/server/runner/requestRules'
import { blockedPromptRefusal } from '~~/server/utils/blockedModels'
import { seedanceReferenceSeconds } from '~~/server/utils/graphInputSeconds'
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

  it('the runner refuses the run before any hold', async () => {
    const k = makeKit({ hosted: true })
    await expect(k.engine.startRun({ userId: k.userId, takes: [img({ prompt: 'p' })], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toMatchObject({ statusCode: 400, message: NANO_BANANA_SHORT_PROMPT })
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })
})

// Final fix F7 (final review finding 7): every runner-only model's empty-prompt
// refusal is two sentences in its own name — what is missing, then what to write.
describe('empty-prompt wording: the model\'s own name, and a helping second sentence', () => {
  it('Hailuo H3 Max Turbo, Wan 3.0 and GPT Image 2.5', () => {
    expect(H3_MAX_TURBO_NEEDS_PROMPT).toBe('Hailuo H3 Max Turbo needs a prompt. Describe the clip, or how the picture should move.')
    expect(WAN_3_NEEDS_PROMPT).toBe('Wan 3.0 needs a prompt. Describe the clip, or link a picture to start from it.')
    expect(GPT_IMAGE_25_NEEDS_PROMPT).toBe('GPT Image 2.5 needs a prompt. Describe the picture you want, or the change to make.')
    for (const m of [H3_MAX_TURBO_NEEDS_PROMPT, WAN_3_NEEDS_PROMPT, GPT_IMAGE_25_NEEDS_PROMPT]) expect(m.split('. ')).toHaveLength(2)
    // H3 Max Turbo no longer borrows Hailuo H3's words.
    expect(H3_MAX_TURBO_NEEDS_PROMPT).not.toBe(H3_SHORT_PROMPT)
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
    // With a first frame the references would be dropped: refused instead (F1 fix round 1).
    expect(messages(vid({ model: 'seedance-2.0', model_options: refs(key, max + 1), image: ['9', 0] }))).toEqual([FIRST_FRAME_AND_REFERENCES])
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

})


// ── S1b fix round 2 ─────────────────────────────────────────────────────

/** A mono 8-bit 8 kHz WAV of `seconds` of silence: a real file mediabunny measures. */
function wav(seconds: number): Uint8Array {
  const rate = 8000
  const n = rate * seconds
  const b = Buffer.alloc(44 + n, 0x80)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34)
  b.write('data', 36); b.writeUInt32LE(n, 40)
  return new Uint8Array(b)
}

describe('Seedance 2.0 references on the runner: measured at the start of the run (fix round 2)', () => {
  const view = (name: string) => `/view?filename=${name}&type=input`
  const seedance = (opts: Record<string, unknown>) => vid({ model: 'seedance-2.0', model_options: JSON.stringify(opts) })
  const start = (k: ReturnType<typeof makeKit>, p: ApiPrompt) =>
    k.engine.startRun({ userId: k.userId, takes: [p], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('a 16 s reference sound is refused before any hold or call; 15 s runs and is sent whole', async () => {
    const k = makeKit({ hosted: true })
    writeFileSync(join(k.root, 'input', 'ref16.wav'), wav(16))
    writeFileSync(join(k.root, 'input', 'ref15.wav'), wav(15))
    await expect(start(k, seedance({ image_urls: ['https://x/a.png'], audio_urls: [view('ref16.wav')] })))
      .rejects.toMatchObject({ statusCode: 400, message: SEEDANCE_TOO_MUCH_SOUND })
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()

    const { runId } = await start(k, seedance({ image_urls: ['https://x/a.png'], audio_urls: [view('ref15.wav')] }))
    await k.engine.settled(runId)
    expect(k.fal.submitted().map(r => r.payload.audio_urls)).toEqual([[view('ref15.wav')]])
  })

  it('two references adding up to 16 s are refused too', async () => {
    const k = makeKit({ hosted: true })
    writeFileSync(join(k.root, 'input', 'a8.wav'), wav(8))
    await expect(start(k, seedance({ image_urls: ['https://x/a.png'], audio_urls: [view('a8.wav'), view('a8.wav')] })))
      .rejects.toMatchObject({ statusCode: 400, message: SEEDANCE_TOO_MUCH_SOUND })
  })

  it('hosted refuses a reference it can\'t measure (an external link, a missing file); local sends it', async () => {
    const hosted = makeKit({ hosted: true })
    for (const ref of ['https://elsewhere/x.wav', view('missing.wav')]) {
      await expect(start(hosted, seedance({ image_urls: ['https://x/a.png'], audio_urls: [ref] })))
        .rejects.toMatchObject({ statusCode: 400, message: SEEDANCE_UNMEASURED_REFERENCE })
    }
    expect(hosted.ledger.hold).not.toHaveBeenCalled()
    const local = makeKit()
    const { runId } = await start(local, seedance({ image_urls: ['https://x/a.png'], audio_urls: ['https://elsewhere/x.wav'] }))
    await local.engine.settled(runId)
    expect(local.fal.submitted()).toHaveLength(1)
  })

  it('the hosted /prompt gate is strict too: an unmeasurable reference is refused', async () => {
    const read = vi.fn(async () => null)
    const p = seedance({ video_urls: ['https://elsewhere/x.mp4'] })
    expect((await seedanceReferenceSeconds(p, read, { strict: true })).map(x => x.message)).toEqual([SEEDANCE_UNMEASURED_REFERENCE])
    expect(await seedanceReferenceSeconds(p, read)).toEqual([])
  })
})

describe('a node refused at plan time, after the hold, is not charged (fix round 2, item 5)', () => {
  it('moodboard pictures that can\'t be read leave a 2-character prompt: the node fails, the hold is released, nothing is sent', async () => {
    const k = makeKit({ hosted: true })
    // The start-of-run check sees the moodboard (so the style instruction), and lets it through…
    const p = img({ prompt: 'ab', style_refs: JSON.stringify({ folder: 'moodboard_3', files: ['gone.png'] }) })
    expect(requestProblems(p)).toEqual([])
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    // …but the picture is gone, so the plan's prompt is 2 characters and is refused.
    const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
    expect(rec).toMatchObject({ status: 'error', error: NANO_BANANA_SHORT_PROMPT })
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    const holds = [...k.ledger.holds.values()]
    expect(holds).toHaveLength(1)
    expect(holds[0]!.state === 'released' || (holds[0]!.state === 'settled' && holds[0]!.actual === 0)).toBe(true)
    expect(k.ledger.settle).not.toHaveBeenCalledWith(expect.anything(), expect.any(Number), expect.anything())
  })

  it('a wired prompt never reaches the runner plan: the workflow is left to ComfyUI, so nothing is held by the runner', () => {
    const p: ApiPrompt = { ...img({ prompt: '', prompt_in: ['3', 0] }), 3: { class_type: 'IdeaNode', inputs: { text: 'x' } } }
    expect(isRunnerEligible(p, new Set(RUNNER_FAMILIES))).toBe(false)
  })
})

describe('Film a shot on Seedance 2.0: a first frame beside references is refused at the /prompt gate (parked minor M5)', () => {
  // Film a shot runs only on the ComfyUI path; its Python builder would send the
  // first frame and drop the references without a word.
  const shot = (inputs: Record<string, unknown>): ApiPrompt => ({
    1: { class_type: 'FilmShotNode', inputs: { preset: 'slow_push_in', model: 'seedance-2.0', prompt: 'a wave', aspect_ratio: '16:9', duration: '5', seed: 0, model_options: '{}', ...inputs } },
    2: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'v', source: ['1', 0] } },
  })

  it('a linked first frame, or `image_url`, beside reference pictures, videos or sounds: refused in plain words', () => {
    for (const key of ['image_urls', 'video_urls', 'audio_urls']) {
      for (const p of [
        shot({ image: ['9', 0], model_options: refs(key, 1) }),
        shot({ model_options: JSON.stringify({ image_url: 'https://x/f.png', [key]: ['https://x/r'] }) }),
      ]) {
        expect(requestProblems(p), key).toEqual([{ nodeId: '1', classType: 'FilmShotNode', input: 'model_options', message: FIRST_FRAME_AND_REFERENCES }])
        expect(blockedPromptRefusal(p)!.error.message, key).toBe(FIRST_FRAME_AND_REFERENCES)
        expect((blockedPromptRefusal(p)!.node_errors as any)[1].class_type).toBe('FilmShotNode')
      }
    }
  })

  it('still runs: a first frame alone (with a last frame), references alone, empty lists beside a frame, and other models', () => {
    for (const p of [
      shot({ image: ['9', 0] }),
      shot({ model_options: JSON.stringify({ image_url: 'https://x/f.png', end_image_url: 'https://x/l.png' }) }),
      shot({ model_options: refs('image_urls', 3) }),
      shot({ image: ['9', 0], model_options: JSON.stringify({ image_urls: [], video_urls: [] }) }),
      // Wired options can't be read before the run.
      shot({ image: ['9', 0], model_options: ['5', 0] }),
      // Not Seedance: not judged by this rule.
      shot({ model: 'kling-v2.5-turbo-pro', image: ['9', 0], model_options: refs('image_urls', 1) }),
    ]) {
      expect(requestProblems(p)).toEqual([])
      expect(blockedPromptRefusal(p)).toBeNull()
    }
  })

  it('over-limit references are refused with Generate a video\'s words', () => {
    expect(messages(shot({ model_options: refs('image_urls', 10) }))).toEqual(['Seedance 2.0 takes at most 9 reference pictures.'])
  })
})

describe('Gemini Omni Flash text-to-video: an empty prompt is refused up front (controller ruling after F4)', () => {
  const gem = (inputs: Record<string, unknown>) => vid({ model: 'gemini-omni-flash', duration: '4', ...inputs })

  it('is refused before the run\'s hold and at the plan, in plain words; one character passes', async () => {
    expect(GEMINI_OMNI_FLASH_NEEDS_PROMPT).toBe('Gemini Omni Flash needs a prompt. Describe the clip, or link a picture to start from it.')
    expect(requestProblems(gem({ prompt: '' }))).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'prompt', message: GEMINI_OMNI_FLASH_NEEDS_PROMPT }])
    // The /prompt gate refuses the node before this rule: the model is runner-only, so it never reaches ComfyUI.
    expect(blockedPromptRefusal(gem({ prompt: '' }))).not.toBeNull()
    await expect(plan(gem({ prompt: '' }))).rejects.toThrow(GEMINI_OMNI_FLASH_NEEDS_PROMPT)
    expect(messages(gem({ prompt: 'a' }))).toEqual([])
    await expect(plan(gem({ prompt: 'a' }))).resolves.toMatchObject({ kind: 'provider', endpoint: 'google/gemini-omni-flash' })

    const k = makeKit({ hosted: true, deps: { families: () => new Set(RUNNER_FAMILIES) } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [gem({ prompt: '' })], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toMatchObject({ statusCode: 400, message: GEMINI_OMNI_FLASH_NEEDS_PROMPT })
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('image-to-video (a linked picture, or `image_url`) may have an empty prompt; a wired prompt or wired options are left to the run', async () => {
    const withPicture = gem({ prompt: '', image: ['9', 0] })
    expect(messages(withPicture)).toEqual([])
    await expect(plan(withPicture)).resolves.toMatchObject({ kind: 'provider', endpoint: 'google/gemini-omni-flash/image-to-video' })
    const fromOptions = gem({ prompt: '', model_options: JSON.stringify({ image_url: 'https://x/f.png' }) })
    expect(messages(fromOptions)).toEqual([])
    await expect(plan(fromOptions)).resolves.toMatchObject({ kind: 'provider', endpoint: 'google/gemini-omni-flash/image-to-video' })
    expect(messages(gem({ prompt: ['5', 0] }))).toEqual([])
    expect(messages(gem({ prompt: '', model_options: ['5', 0] }))).toEqual([])
  })
})
