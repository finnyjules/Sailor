/**
 * LC1 (2026-10-01): what the owed paid live checks found
 * (.superpowers/sdd/2026-09-26-engine-free-step3/owed-live-results.md):
 * the four money-rule breaks (#1–#4), the bugs B1–B9 and the cards the
 * measurements confirmed or lowered. One test (or more) per item.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { createFakeFal, makeKit } from './__runner__/kit'
import { readerFor } from './__runner__/paidParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { MEDIA_TOOL_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { PAID_RATES, paidCallUsd } from '#shared/pricing/paidRates'
import { EDIT_RATES } from '#shared/pricing/editRates'
import { paidCalls } from '#shared/pricing/paidSettings'
import { editCalls } from '#shared/pricing/editSettings'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { CLAUDE_MIN_MAX_TOKENS, LLM_BUILDERS, llmInput, reasonSystem } from '#shared/runner/llm'
import { FAL_FACE_SWAP_APP } from '#shared/runner/faceSwap'
import { answerUsage } from '~~/server/runner/generators/llm'
import { RESTORE_MAX_SAFETY, restorePhotoInput } from '~~/server/runner/generators/repair'
import { multiLoraHfRef, multiLoraSlots } from '~~/server/runner/generators/lora'
import { seedreamAnsweredUsd } from '~~/server/runner/generators/layers'
import { falFaceSwap } from '~~/server/runner/generators/falFaceSwap'
import { planNode } from '~~/server/runner/executors'
import { requestProblems } from '~~/server/runner/requestRules'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { falImageUrls, falOutputUrls } from '~~/server/runner/falQueue'
import { DEEPSEEK_R1_DOWN } from '#shared/runner/llm'
import { MULTI_LORA_PROVIDER_DOWN } from '#shared/runner/lora'
import { faceSwapPromptOf } from '~/lib/runner/faceSwapApp'

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

describe('money-rule breaks #1–#4: the cards now above the measured bills', () => {
  it('#1 RVC: at least 36 s of sound ($0.0252), still $0.0007/s up to the 60 s cap; an estimate', () => {
    const rvc = 'zsxkib/realistic-voice-cloning'
    expect(PAID_RATES[rvc]).toMatchObject({ unit: 'per_input_second', perSecond: 0.0007, minSeconds: 36, confidence: 'estimate' })
    // The live check: 10 s of sound billed 49.6 s of T4 = $0.0112; its fair charge (× markup) is 3 credits.
    expect(paidCallUsd({ endpoint: rvc, inputSeconds: 10 })).toBe(0.0252)
    expect(creditsForUsd(paidCallUsd({ endpoint: rvc, inputSeconds: 10 })!)).toBeGreaterThanOrEqual(creditsForUsd(0.01116))
    expect(paidCallUsd({ endpoint: rvc, inputSeconds: 60 })).toBe(0.042)
  })

  it('#2 Hunyuan3D 2: $0.13, verified (114.7 s of L40S = $0.1118 measured)', () => {
    expect(PAID_RATES['tencent/hunyuan3d-2']).toMatchObject({ unit: 'gpu_ceiling', usd: 0.13, confidence: 'verified' })
    expect(paidCallUsd({ endpoint: 'tencent/hunyuan3d-2' })).toBeGreaterThan(0.1118)
  })

  it('#3 YOLO-World and #4 Moondream 2: $0.0025 each, verified (1.24 s and 1.26 s of L40S measured)', () => {
    expect(PAID_RATES['zsxkib/yolo-world']).toMatchObject({ unit: 'gpu_ceiling', usd: 0.0025, confidence: 'verified' })
    expect(EDIT_RATES['lucataco/moondream2']).toMatchObject({ unit: 'per_image', usd: 0.0025, confidence: 'verified' })
    expect(paidCallUsd({ endpoint: 'zsxkib/yolo-world' })).toBeGreaterThan(0.00121)
    expect(paidCallUsd({ endpoint: 'lucataco/moondream2' })).toBeGreaterThan(0.00123)
  })
})

describe('estimates corrected', () => {
  it('MusicGen: the page-run card kept, an estimate (fix round 1: it must cover a run that loads its version)', () => {
    expect(PAID_RATES['meta/musicgen']).toMatchObject({ unit: 'gpu_per_output_second', perSecond: 0.012, minUsd: 0.042, confidence: 'estimate' })
    // The page's billed run: 8 s of stereo-large, its version loaded in predict, 66.37 s of A100-80 = $0.0929.
    expect(paidCallUsd({ endpoint: 'meta/musicgen', outputSeconds: 8 })).toBeGreaterThanOrEqual(0.0929)
  })

  it('Hunyuan3D-2mv: $0.10 flat, $0.13 from 50 steps, verified; no steps, no price', () => {
    const mv = 'tencent/hunyuan3d-2mv'
    expect(PAID_RATES[mv]).toMatchObject({ confidence: 'verified' })
    for (const [steps, usd] of [[20, 0.1], [49, 0.1], [50, 0.13], [100, 0.13]] as const) expect(paidCallUsd({ endpoint: mv, steps }), String(steps)).toBe(usd)
    expect(paidCallUsd({ endpoint: mv })).toBeNull()
  })

  it('the cards the measurements kept are verified (Clarity and the Refiner too, LC4); Seedream and multi-LoRA stay estimates', () => {
    for (const slug of ['firtoz/trellis', 'bytedance/dolphin', 'thomasmol/whisper-diarization', 'ideogram-ai/layerize']) expect(PAID_RATES[slug]?.confidence, slug).toBe('verified')
    expect(EDIT_RATES['black-forest-labs/flux-dev-lora']).toMatchObject({ usd: 0.04, confidence: 'verified' })
    // LC4 (USER go 2026-10-02): no floors; a GPU-time ceiling (a start cost plus a slope per megapixel a step),
    // verified by two live runs each (fix round 1).
    expect(EDIT_RATES['philz1337x/clarity-upscaler']).toMatchObject({ unit: 'per_megapixel_step', startUsd: 0.005, perMegapixelStep: 0.00051, confidence: 'verified' })
    expect(EDIT_RATES['fermatresearch/magic-image-refiner']).toMatchObject({ unit: 'per_megapixel_step', startUsd: 0.0047, perMegapixelStep: 0.000051, perSquareMegapixelStep: 0.000038, confidence: 'verified' })
    expect(PAID_RATES['bytedance/seedream/v5/pro/layerize']?.confidence).toBe('estimate')
    expect(PAID_RATES['lucataco/flux-dev-multi-lora']?.confidence).toBe('estimate')
  })
})

describe('B1: token usage under either metric name', () => {
  it('Gemini and GPT-5 report token_input_count / token_output_count only; with both, the larger of each (fix round 1)', () => {
    expect(answerUsage({ metrics: { token_input_count: 891, token_output_count: 508 } })).toEqual({ inputTokens: 891, outputTokens: 508 })
    // Both names: the larger per count, never below the billed `token_*` form.
    expect(answerUsage({ metrics: { input_token_count: 11, output_token_count: 68, token_input_count: 99, token_output_count: 99 } })).toEqual({ inputTokens: 99, outputTokens: 99 })
    expect(answerUsage({ metrics: { input_token_count: 120, output_token_count: 68, token_input_count: 99, token_output_count: 70 } })).toEqual({ inputTokens: 120, outputTokens: 70 })
    // A garbage value on one name: the other.
    expect(answerUsage({ metrics: { input_token_count: -1, output_token_count: 'x', token_input_count: 9, token_output_count: 8 } })).toEqual({ inputTokens: 9, outputTokens: 8 })
    expect(answerUsage({ metrics: { input_token_count: 5, token_output_count: 7 } })).toEqual({ inputTokens: 5, outputTokens: 7 })
    expect(answerUsage({ metrics: { token_input_count: 5 } })).toBeNull()
  })

  it('Describe a video is charged its tokens, not its 25-credit hold', () => {
    const inputs = { model: 'Gemini 2.5 Flash', video_url: '/view?filename=clip.mp4&type=input', prompt: 'Describe this video in detail.' }
    const hold = priceNode('DescribeVideoNode', inputs, { inputSeconds: { video: 3 } }) as { credits: number }
    const used = answerUsage({ metrics: { token_input_count: 891, token_output_count: 508 } })!
    const charge = priceNode('DescribeVideoNode', inputs, { answerUsage: used }) as { credits: number }
    expect(hold.credits).toBeGreaterThan(20)
    expect(charge.credits).toBe(1)
  })
})

describe('B2: Claude gets max_tokens of at least 1024; the hold prices the same figure', () => {
  it('Summarize on Haiku sends 1024 and is held at 1024 out', () => {
    const inputs = { text: 'The harbour festival returns this July.', length: 'Short', model: 'Claude 4.5 Haiku' }
    const built = LLM_BUILDERS.SummarizeTextNode(inputs) as { input: Record<string, unknown> }
    expect(built.input.max_tokens).toBe(CLAUDE_MIN_MAX_TOKENS)
    const p = paidCalls('SummarizeTextNode', inputs, {})
    if ('refused' in p) throw new Error(p.refused)
    expect(p.steps[0]!.call.outputTokens).toBe(1024)
    expect(paidCallUsd(p.steps[0]!.call)).toBeGreaterThan(1024 * 5e-6)
  })

  it('Chat on Sonnet at 64 sends 1024 and holds 1024; at 2000 sends 2000; GPT-5 at 64 stays 64', () => {
    const chat = (model: string, max: number) => ({ model, prompt: 'Name three primary colours.', system_prompt: '', temperature: 1, max_tokens: max })
    expect((LLM_BUILDERS.ChatLLMNode(chat('Claude 4.5 Sonnet', 64)) as { input: Record<string, unknown> }).input.max_tokens).toBe(1024)
    expect((LLM_BUILDERS.ChatLLMNode(chat('Claude 4.5 Sonnet', 2000)) as { input: Record<string, unknown> }).input.max_tokens).toBe(2000)
    expect((LLM_BUILDERS.ChatLLMNode(chat('GPT-5', 64)) as { input: Record<string, unknown> }).input.max_completion_tokens).toBe(64)
    const held = paidCalls('ChatLLMNode', chat('Claude 4.5 Sonnet', 64), {})
    if ('refused' in held) throw new Error(held.refused)
    expect(held.steps[0]!.call.outputTokens).toBe(1024)
    const gpt = paidCalls('ChatLLMNode', chat('GPT-5', 64), {})
    if ('refused' in gpt) throw new Error(gpt.refused)
    expect(gpt.steps[0]!.call.outputTokens).toBe(64)
  })

  it('a wired Chat model prices each endpoint at the limit it would send', () => {
    const p = paidCalls('ChatLLMNode', { model: ['m', 0], prompt: 'Hi', system_prompt: '', temperature: 1, max_tokens: 64 }, {})
    if ('refused' in p) throw new Error(p.refused)
    // Claude 4.5 Sonnet at 1024 out ($15/M) is dearer than GPT-5 at 64 or Gemini at 64.
    expect(p.steps[0]!.call).toMatchObject({ endpoint: 'anthropic/claude-4.5-sonnet', outputTokens: 1024 })
  })
})

describe('B3: DeepSeek R1 gets its own shape', () => {
  it('the system text folded into the prompt, max_tokens the true bound, no OpenAI keys', () => {
    const inputs = { question: 'A train leaves at 14:10 and arrives at 16:55. How long is the journey?', include_reasoning: true, model: 'DeepSeek R1' }
    const built = LLM_BUILDERS.ReasonStepByStepNode(inputs) as { slug: string, input: Record<string, unknown> }
    expect(built.slug).toBe('deepseek-ai/deepseek-r1')
    expect(built.input).toEqual({ prompt: `${reasonSystem(true)}\n\n${inputs.question}`, temperature: 0.4, max_tokens: 2048 })
    expect(Object.keys(built.input)).toEqual(['prompt', 'temperature', 'max_tokens'])
    // No system text: the question alone.
    expect(llmInput('DeepSeek R1', 'q', { system: '', temperature: 0.4, maxTokens: 10 }).input).toEqual({ prompt: 'q', temperature: 0.4, max_tokens: 10 })
  })

  it('the hold counts the whole folded prompt and the max_tokens sent', () => {
    const inputs = { question: '17 * 23?', include_reasoning: false, model: 'DeepSeek R1' }
    const p = paidCalls('ReasonStepByStepNode', inputs, {})
    if ('refused' in p) throw new Error(p.refused)
    const sent = (LLM_BUILDERS.ReasonStepByStepNode(inputs) as { input: { prompt: string, max_tokens: number } }).input
    expect(p.steps[0]!.call.inputTokens).toBeGreaterThanOrEqual(new TextEncoder().encode(sent.prompt).length)
    expect(p.steps[0]!.call.outputTokens).toBe(sent.max_tokens)
  })
})

describe('B4: Restore sends safety_tolerance at most 2', () => {
  it('the node and its twin', () => {
    expect(RESTORE_MAX_SAFETY).toBe(2)
    expect(restorePhotoInput('RestorePhotoNode', { safety_tolerance: 6 }, 'u').safety_tolerance).toBe(2)
    expect(restorePhotoInput('RestorePhotoNode', { safety_tolerance: 1 }, 'u').safety_tolerance).toBe(1)
    expect(restorePhotoInput('RestorePhotoRemoteNode', { safety_tolerance: '5' }, 'u').safety_tolerance).toBe(2)
    expect(restorePhotoInput('RestorePhotoRemoteNode', { safety_tolerance: '1' }, 'u').safety_tolerance).toBe(1)
  })
})

describe('B5: multi-LoRA sends Hugging Face references bare', () => {
  it('strips huggingface.co/ and https://huggingface.co/, keeps weights files and other links whole', () => {
    expect(multiLoraHfRef('huggingface.co/XLabs-AI/flux-RealismLora')).toBe('XLabs-AI/flux-RealismLora')
    expect(multiLoraHfRef('https://huggingface.co/alvdansen/frosting_lane_flux')).toBe('alvdansen/frosting_lane_flux')
    expect(multiLoraHfRef('huggingface.co/alice/hf-lora/other')).toBe('alice/hf-lora/other')
    expect(multiLoraHfRef('https://huggingface.co/a/b/resolve/main/x.safetensors')).toBe('https://huggingface.co/a/b/resolve/main/x.safetensors')
    expect(multiLoraHfRef('https://replicate.delivery/x/trained_model.tar')).toBe('https://replicate.delivery/x/trained_model.tar')
    expect(multiLoraHfRef('XLabs-AI/flux-RealismLora')).toBe('XLabs-AI/flux-RealismLora')
  })

  it('the slots as sent: a looked-up bare slug and a pasted https link, both bare', async () => {
    const inputs = { lora_a_url: 'https://huggingface.co/alvdansen/frosting_lane_flux', scale_a: 0.9, lora_b_url: 'XLabs-AI/flux-RealismLora', scale_b: 0.8 }
    const lookups = new Map([['XLabs-AI/flux-RealismLora', Promise.resolve(true)]])
    const { loras } = await multiLoraSlots(inputs, async () => null, { hosted: false }, lookups)
    expect(loras).toEqual(['alvdansen/frosting_lane_flux', 'XLabs-AI/flux-RealismLora'])
  })
})

describe('B6: Seedream with no size in its answer is charged at the size asked', () => {
  const answer = JSON.stringify({ images: [{ url: 'https://f/0.png', width: null, height: null }], layers: Array.from({ length: 5 }, (_, i) => ({ image: { url: `https://f/${i}.png`, width: null, height: null }, z_index: i })) })
  it('auto_1K: 5 × $0.03375; asked nothing known: the dearer rate', () => {
    expect(seedreamAnsweredUsd(JSON.parse(answer), answer, 1024 * 1024)).toBe(0.16875)
    expect(seedreamAnsweredUsd(JSON.parse(answer), answer)).toBe(0.3375)
  })
})

describe('B7: a local quote sizes Upscale\'s picture from its header', () => {
  it('Real-ESRGAN on a 512² picture quotes its card minimum, not the 18.9 MP cap', async () => {
    const k = makeKit({ deps: { families: () => new Set<RunnerFamily>(['cards', 'image-repair']) } })
    writeFileSync(join(k.root, 'input', 'a.png'), await sharp({ create: { width: 512, height: 512, channels: 3, background: '#808080' } }).png().toBuffer())
    const up = {
      model: 'Real-ESRGAN', image: ['l', 0], scale_factor: 2, face_enhance: false, creativity: 0.35, resemblance: 0.6, num_inference_steps: 18, seed: 0,
      prompt: 'masterpiece, best quality, highres', negative_prompt: '(worst quality, low quality, normal quality:2)', crystal_creativity: 0, crystal_output_format: 'png',
      topaz_enhance_model: 'Standard V2', topaz_face_creativity: 0, topaz_face_strength: 0.8, topaz_output_format: 'png', topaz_subject_detection: 'None', topaz_upscale_factor: '2x',
    }
    const p: ApiPrompt = { l: { class_type: 'LoadImage', inputs: { image: 'a.png', upload: 'image' } }, n: { class_type: 'UpscaleImageNode', inputs: up }, ...readerFor('UpscaleImageNode', 'n') }
    const q = await k.engine.quoteRun({ userId: k.userId, takes: [p], ...START })
    const atSize = priceNode('UpscaleImageNode', up, { inputPixels: 512 * 512 }) as { usd: number }
    const atCap = priceNode('UpscaleImageNode', up) as { usd: number }
    expect(atCap.usd).toBeGreaterThan(atSize.usd)
    expect(q.usd).toBeCloseTo(atSize.usd, 8)
  })
})

describe('B8: Face swap on fal-ai/face-swap', () => {
  it('sends the two pictures, fitting the saved schema; priced at $0.001 a picture', () => {
    const call = falFaceSwap({ face: 'https://x/f.png', target: 'https://x/t.png' })
    expect(call).toEqual({ provider: 'fal', endpoint: 'fal-ai/face-swap', payload: { base_image_url: 'https://x/t.png', swap_image_url: 'https://x/f.png' } })
    expect(checkPayload(loadProviderSchema('fal', FAL_FACE_SWAP_APP), call.payload)).toEqual([])
    expect(EDIT_RATES[FAL_FACE_SWAP_APP]).toMatchObject({ unit: 'per_image', usd: 0.001, service: 'fal', confidence: 'verified' })
    const c = editCalls('FaceSwap', {})
    if ('refused' in c) throw new Error(c.refused)
    expect(c.calls[0]!.endpoint).toBe(FAL_FACE_SWAP_APP)
    expect(priceNode('FaceSwap', { gender: 'Female' })).toEqual({ usd: 0.001, credits: 1 })
  })

  it('the node plans the fal app; a gender not picked is no longer refused', async () => {
    const prompt: ApiPrompt = {
      11: { class_type: 'Image', inputs: { image: 'face.png' } },
      12: { class_type: 'Image', inputs: { image: 'target.png' } },
      1: { class_type: 'FaceSwap', inputs: { source_face: ['11', 0], target_frames: ['12', 0], gender: 'Not chosen', keep_hair_from: 'The picture' } },
    }
    expect(requestProblems(prompt, { runner: true })).toEqual([])
    const plan = await planNode({
      prompt, nodeId: '1', gateOpen: false, families: new Set<RunnerFamily>(['face-swap']),
      filesFrom: link => [{ filename: link[0] === '12' ? 'target.png' : 'face.png', subfolder: '', type: 'input' }],
      toUrl: async f => `https://fal.storage/${f.filename}`,
    })
    expect(plan).toMatchObject({ kind: 'provider', provider: 'fal', endpoint: FAL_FACE_SWAP_APP, payload: { base_image_url: 'https://fal.storage/target.png', swap_image_url: 'https://fal.storage/face.png' } })
  })
})

describe('B9: Save video takes a paid video maker\'s video', () => {
  const fam = (...f: string[]) => new Set<RunnerFamily>(['cards', 'media-video', ...f] as RunnerFamily[])
  const film: ApiPrompt = {
    v: { class_type: 'FilmShotNode', inputs: { preset: 'push-in', prompt: 'a woman speaking', model: 'pixverse-v6', aspect_ratio: '16:9', duration: '5', seed: 7, model_options: '{"resolution": "360p", "generate_audio": false}', shot_size: 'auto (preset)', camera_angle: 'auto (preset)', camera_movement: 'auto (preset)', lens_look: 'auto (preset)', composition: 'auto (preset)' } },
    s: { class_type: 'SaveVideo', inputs: { video: ['v', 0], filename_prefix: 'x', format: 'auto', codec: 'auto' } },
  }
  it('the SaveVideo row takes Generate a video, Film a shot, Lip-sync and Sync lips', () => {
    for (const cls of ['GenerateVideoNode', 'FilmShotNode', 'LipSyncNode', 'LipsyncNode', 'LipsyncRemoteNode']) {
      const p: ApiPrompt = { v: { class_type: cls, inputs: {} }, s: film.s! }
      expect(runnerTakesNode(p, 's', fam()), cls).toBe(true)
    }
    const other: ApiPrompt = { v: { class_type: 'GenerateImageNode', inputs: {} }, s: film.s! }
    expect(runnerTakesNode(other, 's', fam())).toBe(false)
  })
  it('Film a shot into Save video goes to the runner, as into a Video card', () => {
    const all = new Set<RunnerFamily>([...RUNNER_FAMILIES, ...MEDIA_TOOL_FAMILIES])
    const card: ApiPrompt = { v: film.v!, c: { class_type: 'Video', inputs: { source: ['v', 0], export: false, filename_prefix: 'x' } } }
    expect(isRunnerEligible(card, all)).toBe(true)
    expect(isRunnerEligible(film, all)).toBe(true)
  })
})

// ── Fix round 1 ──────────────────────────────────────────────────────────

/** A fal answer as the saved schema's own example gives it: one `image`, not `images` (FaceSwapOutput, ImageUpscaleOutput). */
const exampleImage = (app: string) => {
  const f = loadProviderSchema('fal', app)
  const ref = (f.output as { $ref: string }).$ref.split('/').pop()!
  const out = f.components.schemas[ref] as { properties: { image: { examples?: unknown[], $ref?: string } } }
  return out.properties.image.examples?.[0] ?? { url: `https://fal.media/files/${app.replaceAll('/', '_')}.png`, content_type: 'image/png', width: 64, height: 64 }
}

const PNG = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#406080' } }).png().toBuffer()

describe('C1: a fal answer with one `image` is read (Face swap, Topaz Fix faces)', () => {
  it('falImageUrls takes `images`, else the one `image`', () => {
    const one = exampleImage(FAL_FACE_SWAP_APP) as { url: string }
    expect(one.url).toBe('https://storage.googleapis.com/falserverless/model_tests/face_swap/result.jpeg')
    expect(falImageUrls({ image: one })).toEqual([one.url])
    expect(falOutputUrls({ image: one }, 'image')).toEqual([one.url])
    expect(falImageUrls({ images: [{ url: 'a' }], image: { url: 'b' } })).toEqual(['a'])
    for (const r of [{}, null, { image: {} }, { image: { url: '' } }, { image: 'x' }]) expect(falImageUrls(r), JSON.stringify(r)).toEqual([])
  })

  const cases: [string, RunnerFamily, string, ApiPrompt[string]][] = [
    ['Face swap', 'face-swap', FAL_FACE_SWAP_APP, { class_type: 'FaceSwap', inputs: { source_face: ['11', 0], target_frames: ['12', 0], gender: 'Not chosen', keep_hair_from: 'The picture' } }],
    ['Fix faces', 'fix-faces', 'fal-ai/topaz/upscale/image', { class_type: 'FixFacesNode', inputs: { image: ['12', 0], strength: 0.8, creativity: 0, upscale: 2 } }],
  ]
  for (const [label, family, app, node] of cases) {
    it(`${label}, hosted: fal's real answer shape is downloaded, saved and charged`, async () => {
      const answer = { image: exampleImage(app) }
      const url = (answer.image as { url: string }).url
      const fal = createFakeFal({ answer: () => answer })
      const downloads: string[] = []
      const k = makeKit({ hosted: true, fal, deps: { families: () => new Set<RunnerFamily>([family]), download: async (u: string) => { downloads.push(u); return { bytes: new Uint8Array(PNG), contentType: 'image/png' } } } })
      writeFileSync(join(k.root, 'input', 'face.png'), PNG)
      writeFileSync(join(k.root, 'input', 'target.png'), PNG)
      const take: ApiPrompt = {
        11: { class_type: 'Image', inputs: { image: 'face.png' } },
        12: { class_type: 'Image', inputs: { image: 'target.png' } },
        1: node,
        2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
      }
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [take], ...START })
      await k.engine.settled(runId)
      const rec = (await k.store.get(runId))!.takes[0]!.nodes['1']!
      expect(rec.status, rec.error ?? '').toBe('done')
      expect(fal.submitted().map(r => r.endpoint)).toEqual([app])
      expect(downloads).toContain(url)
      expect(rec.outputs.length).toBe(1)
      expect(rec.credits).toBeGreaterThan(0)
      expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['settled'])
    })
  }
})

describe('B7 fix round 1: locally the start sizes pictures for the quote only', () => {
  it('a picture that changed after the start is not refused locally; charged no more than held', async () => {
    const k = makeKit({ deps: { families: () => new Set<RunnerFamily>(['cards', 'image-repair']) } })
    const small = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#808080' } }).png().toBuffer()
    writeFileSync(join(k.root, 'input', 'a.png'), small)
    const up = {
      model: 'Crystal', image: ['l', 0], scale_factor: 2, face_enhance: false, creativity: 0.35, resemblance: 0.6, num_inference_steps: 18, seed: 0,
      prompt: 'x', negative_prompt: '', crystal_creativity: 0, crystal_output_format: 'png',
      topaz_enhance_model: 'Standard V2', topaz_face_creativity: 0, topaz_face_strength: 0.8, topaz_output_format: 'png', topaz_subject_detection: 'None', topaz_upscale_factor: '2x',
    }
    const p: ApiPrompt = { l: { class_type: 'LoadImage', inputs: { image: 'a.png', upload: 'image' } }, n: { class_type: 'UpscaleImageNode', inputs: up }, ...readerFor('UpscaleImageNode', 'n') }
    // Hold the replicate call open, swap the file for a far larger one, then let it run.
    const big = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: '#808080' } }).png().toBuffer()
    // Every read of a.png after the start answers the big picture (the start has sized the small one).
    const realRead = k.deps.results.read.bind(k.deps.results)
    let started = false
    let bigReads = 0
    k.deps.results.read = async (f: Parameters<typeof realRead>[0]) => {
      if (f.filename === 'a.png' && started) { bigReads++; return new Uint8Array(big) }
      return realRead(f)
    }
    const run0 = k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    const { runId } = await run0.then((r) => { started = true; return r })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.measured).toEqual({ n: { seconds: {}, sha: {}, pixels: 256 } })
    const rec = run.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(bigReads).toBeGreaterThan(0)
    expect(rec.credits).toBe((priceNode('UpscaleImageNode', up, { inputPixels: 256 }) as { credits: number }).credits)
  })
})

describe('provider faults, refused plainly before the hold (fix round 1)', () => {
  it('DeepSeek R1: refused, and hidden from Think step by step\'s menu', async () => {
    const inputs = { question: '17 * 23?', include_reasoning: false, model: 'DeepSeek R1' }
    expect(requestProblems({ n: { class_type: 'ReasonStepByStepNode', inputs } }, { runner: true })).toEqual([{ nodeId: 'n', classType: 'ReasonStepByStepNode', input: 'model', message: DEEPSEEK_R1_DOWN }])
    expect(requestProblems({ n: { class_type: 'ReasonStepByStepNode', inputs: { ...inputs, model: 'GPT-5' } } }, { runner: true })).toEqual([])
    const { modelMenu } = await import('#shared/runner/modelMenus')
    const menu = modelMenu('ReasonStepByStepNode')!
    expect(menu.entries.find(e => e.value === 'DeepSeek R1')).toMatchObject({ hidden: true })
    expect(menu.preference[0]).toBe('GPT-5')
    const k = makeKit({ hosted: true, deps: { families: () => new Set<RunnerFamily>(['cards', 'llm-text']) } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [{ n: { class_type: 'ReasonStepByStepNode', inputs } }], ...START })).rejects.toThrow(DEEPSEEK_R1_DOWN)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })

  it('Flux Dev + LoRAs: refused (the model crashes at its provider after loading the LoRAs)', () => {
    const inputs = { prompt: 'x', lora_a: '[None]', lora_a_url: 'alice/one', scale_a: 1 }
    expect(requestProblems({ n: { class_type: 'FluxMultiLoRARemoteNode', inputs } }, { runner: true }).map(p => p.message)).toEqual([MULTI_LORA_PROVIDER_DOWN])
  })
})

describe('Face swap settings (fix round 1)', () => {
  it('the mini app needs both pictures only; any saved gender and hair choice still run (not sent)', () => {
    const f = { filename: 'f.png' }
    const t = { filename: 't.png' }
    expect(faceSwapPromptOf({ face: f, target: t, gender: 'Not chosen', keepHairFrom: 'The picture' })).not.toBeNull()
    expect(faceSwapPromptOf({ face: f, target: t, gender: '', keepHairFrom: '' })!['3']!.inputs).toMatchObject({ gender: 'Not chosen', keep_hair_from: 'The picture' })
    expect(faceSwapPromptOf({ face: f, target: null, gender: 'Female', keepHairFrom: 'The picture' })).toBeNull()
    for (const gender of ['Not chosen', 'Male', 'Female', 'Non-binary']) {
      for (const hair of ['The picture', 'The face photo']) {
        const p: ApiPrompt = {
          1: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
          2: { class_type: 'LoadImage', inputs: { image: 'b.png' } },
          3: { class_type: 'FaceSwap', inputs: { source_face: ['1', 0], target_frames: ['2', 0], gender, keep_hair_from: hair } },
        }
        expect(runnerTakesNode(p, '3', new Set<RunnerFamily>(['cards', 'face-swap'])), `${gender} ${hair}`).toBe(true)
        expect(requestProblems(p, { runner: true }), `${gender} ${hair}`).toEqual([])
      }
    }
  })
})
