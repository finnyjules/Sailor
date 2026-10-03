/**
 * R3.11 fix rounds 1–2 (rule 10, G3): the user's own words a generator sends
 * from inside `model_options` (#shared/runner/modelOptionTexts: the negative
 * prompt) are moderated on both paths — the runner's start of a take and the
 * hosted ComfyUI /prompt meter both read them through extractGraphPromptTexts
 * — for Generate a video, Film a shot and Generate an image.
 *
 * The guard: every option field any builder of a class sends as free text is
 * on that class's list, and every listed field is sent. It is measured, not
 * assumed: each field name any generator source names is given a marker value
 * and every model is planned.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeKit } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { FILM_SHOT_MODEL_IDS, RUNNER_IMAGE_MODEL_IDS, RUNNER_NODE_RULES } from '#shared/runner/eligibility'
import { MODEL_OPTION_TEXT_CLASSES, MODEL_OPTION_TEXT_KEYS, modelOptionTexts } from '#shared/runner/modelOptionTexts'
import { planNode } from '~~/server/runner/executors'
import { extractGraphPromptTexts } from '~~/server/utils/graphPromptText'

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
/** Option fields that carry reference links, not words (server/runner/shotRefs.ts). */
const REFERENCE_KEYS = new Set(['image_url', 'end_image_url', 'image_urls', 'video_urls', 'audio_urls', 'elements'])
const MARK = (k: string) => `ZQ${k}QZ`

/** Every string literal that looks like a field name in the generator sources. */
function candidateKeys(): string[] {
  const dir = resolve(__dirname, '../../server/runner/generators')
  const keys = new Set<string>()
  for (const f of readdirSync(dir)) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/'([a-z][a-z0-9_]*)'/g)) keys.add(m[1]!)
  }
  return [...keys]
}

const VIDEO_MODELS = [...new Set([...FILM_SHOT_MODEL_IDS, ...Object.keys(RUNNER_NODE_RULES.GenerateVideoNode!.models!)])].filter(m => m !== 'fabric-1.0')
const IMAGE_MODELS = [...new Set([...RUNNER_IMAGE_MODEL_IDS, ...Object.keys(RUNNER_NODE_RULES.GenerateImageNode!.models!)])]

/** The plan's JSON (every call, its backup too), or null when the builder refuses the options. */
async function planText(classType: string, model: string, adv: Record<string, unknown>, image: boolean): Promise<string | null> {
  const inputs: Record<string, unknown> = { model, prompt: 'p', aspect_ratio: '16:9', seed: 1, model_options: JSON.stringify(adv) }
  if (classType !== 'GenerateImageNode') inputs.duration = '5'
  if (classType === 'FilmShotNode') inputs.preset = 'orbit'
  if (image) inputs.image = ['i', 0]
  try {
    const plan = await planNode({
      prompt: { i: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, n: { class_type: classType, inputs } },
      nodeId: 'n', gateOpen: false,
      filesFrom: () => [{ filename: 'a.png', subfolder: '', type: 'input' }],
      toUrl: async f => `https://x.test/${f.filename}`,
    })
    return JSON.stringify(plan)
  }
  catch { return null }
}

/** The option fields whose marker reaches the plan, for this class's runs. */
async function sentKeys(runs: readonly { classType: string; model: string; extra: Record<string, unknown>; image: boolean }[]): Promise<{ keys: string[]; planned: number }> {
  const sent = new Set<string>()
  let planned = 0
  for (const key of candidateKeys()) {
    if (REFERENCE_KEYS.has(key) || key === '__shot_directed') continue
    for (const r of runs) {
      // As a word, a list of words and an object holding words: a builder forwarding any of them sends it.
      for (const value of [MARK(key), [MARK(key)], { v: MARK(key) }]) {
        const text = await planText(r.classType, r.model, { ...r.extra, [key]: value }, r.image)
        if (text === null) continue
        planned++
        if (text.includes(MARK(key))) sent.add(key)
      }
    }
  }
  return { keys: [...sent].sort(), planned }
}

describe('the lists of option texts are the builders\' own', () => {
  it('Generate a video and Film a shot (both paths): every free-text option field sent is listed, and every listed one is sent', async () => {
    const runs = (classType: string, extra: Record<string, unknown> = {}) => VIDEO_MODELS.flatMap(model => [false, true].map(image => ({ classType, model, extra, image })))
    const video = await sentKeys(runs('GenerateVideoNode'))
    expect(video.planned).toBeGreaterThan(10_000)
    expect(video.keys).toEqual([...MODEL_OPTION_TEXT_KEYS.GenerateVideoNode].sort())
    const shots = await sentKeys([...runs('FilmShotNode'), ...runs('FilmShotNode', { __shot_directed: true })])
    expect(shots.keys).toEqual([...MODEL_OPTION_TEXT_KEYS.FilmShotNode].sort())
  }, 600_000)

  it('Generate an image: every free-text option field sent is listed, and every listed one is sent', async () => {
    const runs = IMAGE_MODELS.map(model => ({ classType: 'GenerateImageNode', model, extra: {}, image: false }))
    const image = await sentKeys(runs)
    expect(image.planned).toBeGreaterThan(5_000)
    expect(image.keys).toEqual([...MODEL_OPTION_TEXT_KEYS.GenerateImageNode].sort())
  }, 600_000)

  it('the classes are exactly those three', () => {
    expect([...MODEL_OPTION_TEXT_CLASSES].sort()).toEqual(['FilmShotNode', 'GenerateImageNode', 'GenerateVideoNode'])
  })

  it('Python\'s builders (video_models.py, image_models.py `_opt_str`) read no other free-text option', () => {
    const read = (file: string) => new Set([...readFileSync(resolve(__dirname, `../../../comfy_api_nodes/${file}`), 'utf8').matchAll(/_opt_str\(adv, "([a-z_]+)"/g)].map(m => m[1]!))
    // Links (handled as references), and choices Python passes on as picked in the gallery: not the user's own words.
    const videoChoices = new Set(['image_url', 'end_image_url', 'resolution', 'style', 'prompt_expansion_mode'])
    expect([...read('video_models.py')].filter(k => !videoChoices.has(k)).sort()).toEqual([...MODEL_OPTION_TEXT_KEYS.GenerateVideoNode].sort())
    const imageChoices = new Set([
      'background', 'creativity', 'input_fidelity', 'magic_prompt', 'megapixels', 'output_format', 'output_megapixels', 'quality',
      'resolution', 'safety_filter_level', 'sequential_image_generation', 'size', 'speed_mode', 'style', 'style_type', 'version',
    ])
    expect([...read('image_models.py')].filter(k => !imageChoices.has(k)).sort()).toEqual([...MODEL_OPTION_TEXT_KEYS.GenerateImageNode].sort())
  })
})

describe('modelOptionTexts', () => {
  it('reads the typed options of the three classes as the builders do', () => {
    const t = (ct: string, raw: unknown) => modelOptionTexts(ct, { model_options: raw })
    expect(t('GenerateVideoNode', '{"negative_prompt": "blurry"}')).toEqual(['blurry'])
    expect(t('GenerateImageNode', '{"negative_prompt": "blurry"}')).toEqual(['blurry'])
    expect(t('FilmShotNode', '{"negative_prompt": "blurry", "__shot_directed": true}')).toEqual(['blurry'])
    expect(t('FilmShotNode', '{"negative_prompt": 5}')).toEqual(['5'])
    expect(t('FilmShotNode', '{"negative_prompt": "   "}')).toEqual([])
    expect(t('FilmShotNode', '{"negative_prompt": null}')).toEqual([])
    expect(t('FilmShotNode', 'not json')).toEqual([])
    expect(t('FilmShotNode', '["negative_prompt"]')).toEqual([])
    expect(t('FilmShotNode', ['7', 0])).toEqual([])
    expect(t('EditImageNode', '{"negative_prompt": "blurry"}')).toEqual([])
  })

  it('extractGraphPromptTexts (the runner\'s start and the hosted meter) reads them, each on its own', () => {
    const p: ApiPrompt = {
      g: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'a fox', model_options: '{"negative_prompt": "NEGWORDS"}' } },
      f: { class_type: 'FilmShotNode', inputs: { preset: 'orbit', model: 'veo-3.1', prompt: 'a heron', model_options: '{"negative_prompt": "OTHERWORDS"}' } },
      i: { class_type: 'GenerateImageNode', inputs: { model: 'qwen-image-3', prompt: 'a cat', model_options: '{"negative_prompt": "IMAGEWORDS"}' } },
    }
    expect(extractGraphPromptTexts(p)).toEqual(['a fox', 'NEGWORDS', 'a heron', 'OTHERWORDS', 'a cat', 'IMAGEWORDS'])
  })
})

describe('moderated before the hold (hosted)', () => {
  const blocked = () => vi.fn(async (t: string) => (t.includes('NEGWORDS') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
  const video = (id: string) => ({ v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: [id, 0] } } })
  const picture = (id: string) => ({ c: { class_type: 'Image', inputs: { image: '', export: false, images: [id, 0], batch_index: -1 } } })
  const node = (ct: string, extra: Record<string, unknown> = {}) => ({
    class_type: ct,
    inputs: { model: 'veo-3.1', prompt: 'the fox runs', aspect_ratio: '16:9', duration: '5', seed: 3, preset: 'orbit', model_options: JSON.stringify({ negative_prompt: 'NEGWORDS', ...extra }) },
  })
  /** Generate an image on a model whose builder sends a negative prompt (Qwen Image 3). */
  const imageNode = () => ({ class_type: 'GenerateImageNode', inputs: { model: 'qwen-image-3', prompt: 'a cat', aspect_ratio: '1:1', seed: 3, model_options: JSON.stringify({ negative_prompt: 'NEGWORDS' }) } })
  const ON = new Set<RunnerFamily>(['cards', 'film-shot', 'replicate-video', 'qwen-image-3'])

  it.each([
    ['Generate a video', { n: node('GenerateVideoNode'), ...video('n') }],
    ['a preset Film a shot', { n: node('FilmShotNode'), ...video('n') }],
    ['a shot-directed Film a shot', { n: node('FilmShotNode', { __shot_directed: true }), ...video('n') }],
    ['Generate an image', { n: imageNode(), ...picture('n') }],
  ] as const)('the runner: %s with negative_prompt "NEGWORDS" is refused, nothing held or sent', async (_n, p) => {
    const moderate = blocked()
    const k = makeKit({ hosted: true, available: 50_000, moderate, deps: { families: () => ON } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [p as ApiPrompt], ...START })).rejects.toThrow()
    expect(moderate.mock.calls.map(c => c[0])).toContain('NEGWORDS')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })

  it('the runner: a harmless negative prompt is moderated, then sent (video and image)', async () => {
    const moderate = vi.fn(async () => ({ ok: true as const }))
    const k = makeKit({ hosted: true, available: 50_000, moderate, deps: { families: () => ON } })
    const n = node('FilmShotNode')
    n.inputs.model_options = JSON.stringify({ negative_prompt: 'blurry' })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ n, ...video('n') }], ...START })
    await k.engine.settled(runId)
    expect(moderate.mock.calls.map(c => (c as unknown[])[0])).toContain('blurry')
    expect(k.fal.submitted()[0]!.payload.negative_prompt).toBe('blurry')
    const i = imageNode()
    i.inputs.model_options = JSON.stringify({ negative_prompt: 'smudged' })
    const k2 = makeKit({ hosted: true, available: 50_000, moderate, deps: { families: () => ON } })
    const r2 = await k2.engine.startRun({ userId: k2.userId, takes: [{ n: i, ...picture('n') }], ...START })
    await k2.engine.settled(r2.runId)
    expect(moderate.mock.calls.map(c => (c as unknown[])[0])).toContain('smudged')
    expect(k2.replicate.submitted()[0]!.payload.negative_prompt).toBe('smudged')
  })

})
