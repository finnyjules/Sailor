/**
 * R3.11 fix round 1 (rule 10, G3): the user's own words a video node sends
 * from inside `model_options` (#shared/runner/videoOptionTexts: the negative
 * prompt) are moderated on both paths — the runner's start of a take and the
 * hosted ComfyUI /prompt meter both read them through extractGraphPromptTexts.
 *
 * The guard: every option field any video builder sends as free text is on
 * the list, and every field on the list is sent. It is measured, not assumed:
 * each field name any generator source names is given a marker value and
 * every video model is planned (Generate a video and both Film a shot paths).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { makeKit } from './__runner__/kit'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { FILM_SHOT_MODEL_IDS, RUNNER_NODE_RULES } from '#shared/runner/eligibility'
import { VIDEO_OPTION_TEXT_KEYS, videoOptionTexts } from '#shared/runner/videoOptionTexts'
import { planNode } from '~~/server/runner/executors'
import { extractGraphPromptTexts } from '~~/server/utils/graphPromptText'
import { meterGraphSubmit } from '~~/server/utils/meterGraphRun'

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

async function sentStrings(classType: string, model: string, adv: Record<string, unknown>, image: boolean): Promise<string | null> {
  const inputs: Record<string, unknown> = { model, prompt: 'p', aspect_ratio: '16:9', duration: '5', seed: 1, model_options: JSON.stringify(adv) }
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

describe('the list of option texts is the builders\' own', () => {
  it('every option field a video builder sends as free text is listed, and every listed one is sent', async () => {
    const keys = candidateKeys()
    expect(keys.length).toBeGreaterThan(100)
    const sent = new Map<string, Set<string>>()
    let planned = 0
    for (const model of VIDEO_MODELS) {
      for (const image of [false, true]) {
        for (const [ct, extra] of [['GenerateVideoNode', {}], ['FilmShotNode', {}], ['FilmShotNode', { __shot_directed: true }]] as const) {
          for (const key of keys) {
            if (REFERENCE_KEYS.has(key) || key === '__shot_directed') continue
            // As a word, a list of words and an object holding words: a builder forwarding any of them sends it.
            for (const value of [MARK(key), [MARK(key)], { v: MARK(key) }]) {
              const text = await sentStrings(ct, model, { ...extra, [key]: value }, image)
              if (text === null) continue
              planned++
              if (text.includes(MARK(key))) {
                if (!sent.has(key)) sent.set(key, new Set())
                sent.get(key)!.add(model)
              }
            }
          }
        }
      }
    }
    expect(planned).toBeGreaterThan(10_000)
    expect([...sent.keys()].sort()).toEqual([...VIDEO_OPTION_TEXT_KEYS].sort())
  }, 600_000)

  it('Python\'s video builders read no other free-text option (video_models.py `_opt_str`)', () => {
    const python = readFileSync(resolve(__dirname, '../../../comfy_api_nodes/video_models.py'), 'utf8')
    const read = new Set([...python.matchAll(/_opt_str\(adv, "([a-z_]+)"/g)].map(m => m[1]!))
    // Links (handled as references), and choices Python passes on as picked in the gallery (a
    // resolution, a style, a prompt-expansion mode): not the user's own words.
    const notWords = new Set(['image_url', 'end_image_url', 'resolution', 'style', 'prompt_expansion_mode'])
    expect([...read].filter(k => !notWords.has(k)).sort()).toEqual([...VIDEO_OPTION_TEXT_KEYS].sort())
  })
})

describe('videoOptionTexts', () => {
  it('reads the typed options of the two video classes as the builders do', () => {
    const t = (ct: string, raw: unknown) => videoOptionTexts(ct, { model_options: raw })
    expect(t('GenerateVideoNode', '{"negative_prompt": "blurry"}')).toEqual(['blurry'])
    expect(t('FilmShotNode', '{"negative_prompt": "blurry", "__shot_directed": true}')).toEqual(['blurry'])
    expect(t('FilmShotNode', '{"negative_prompt": 5}')).toEqual(['5'])
    expect(t('FilmShotNode', '{"negative_prompt": "   "}')).toEqual([])
    expect(t('FilmShotNode', '{"negative_prompt": null}')).toEqual([])
    expect(t('FilmShotNode', 'not json')).toEqual([])
    expect(t('FilmShotNode', '["negative_prompt"]')).toEqual([])
    expect(t('FilmShotNode', ['7', 0])).toEqual([])
    expect(t('GenerateImageNode', '{"negative_prompt": "blurry"}')).toEqual([])
  })

  it('extractGraphPromptTexts (the runner\'s start and the hosted meter) reads them, each on its own', () => {
    const p: ApiPrompt = {
      g: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'a fox', model_options: '{"negative_prompt": "NEGWORDS"}' } },
      f: { class_type: 'FilmShotNode', inputs: { preset: 'orbit', model: 'veo-3.1', prompt: 'a heron', model_options: '{"negative_prompt": "OTHERWORDS"}' } },
    }
    expect(extractGraphPromptTexts(p)).toEqual(['a fox', 'NEGWORDS', 'a heron', 'OTHERWORDS'])
  })
})

describe('moderated before the hold (hosted)', () => {
  const blocked = () => vi.fn(async (t: string) => (t.includes('NEGWORDS') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
  const video = (id: string) => ({ v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: [id, 0] } } })
  const node = (ct: string, extra: Record<string, unknown> = {}) => ({
    class_type: ct,
    inputs: { model: 'veo-3.1', prompt: 'the fox runs', aspect_ratio: '16:9', duration: '5', seed: 3, preset: 'orbit', model_options: JSON.stringify({ negative_prompt: 'NEGWORDS', ...extra }) },
  })
  const ON = new Set<RunnerFamily>(['cards', 'film-shot', 'replicate-video'])

  it.each([
    ['Generate a video', node('GenerateVideoNode')],
    ['a preset Film a shot', node('FilmShotNode')],
    ['a shot-directed Film a shot', node('FilmShotNode', { __shot_directed: true })],
  ] as const)('the runner: %s with negative_prompt "NEGWORDS" is refused, nothing held or sent', async (_n, n) => {
    const moderate = blocked()
    const k = makeKit({ hosted: true, available: 50_000, moderate, deps: { families: () => ON } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [{ n, ...video('n') }], ...START })).rejects.toThrow()
    expect(moderate.mock.calls.map(c => c[0])).toContain('NEGWORDS')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('the runner: a harmless negative prompt is moderated, then sent', async () => {
    const moderate = vi.fn(async () => ({ ok: true as const }))
    const k = makeKit({ hosted: true, available: 50_000, moderate, deps: { families: () => ON } })
    const n = node('FilmShotNode')
    n.inputs.model_options = JSON.stringify({ negative_prompt: 'blurry' })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ n, ...video('n') }], ...START })
    await k.engine.settled(runId)
    expect(moderate.mock.calls.map(c => (c as unknown[])[0])).toContain('blurry')
    expect(k.fal.submitted()[0]!.payload.negative_prompt).toBe('blurry')
  })

  it.each([
    ['Generate a video', node('GenerateVideoNode')],
    ['Film a shot', node('FilmShotNode')],
  ] as const)('the hosted ComfyUI /prompt meter: %s is refused before pricing or any hold', async (_n, n) => {
    const d = {
      priceGraph: vi.fn(() => ({ credits: 5, version: 'test', breakdown: [] })),
      spendGuard: vi.fn(async () => {}),
      validateFileRefs: vi.fn(async () => {}),
      moderatePrompt: blocked(),
      hold: vi.fn(async () => ({ ok: true as const, holdId: 7 })),
      getAvailable: vi.fn(async () => 3),
      forward: vi.fn(async () => ({ status: 200, body: { prompt_id: 'p1', number: 1, node_errors: {} } })),
      registerRun: vi.fn(async () => {}),
      startSettle: vi.fn(),
      releaseHold: vi.fn(async () => {}),
    }
    let refused = false
    try {
      const r = await meterGraphSubmit('u1', { prompt: { n, ...video('n') } }, d as never)
      refused = r.status >= 400
    }
    catch { refused = true }
    expect(refused).toBe(true)
    expect(d.moderatePrompt.mock.calls.map(c => c[0])).toContain('NEGWORDS')
    expect(d.priceGraph).not.toHaveBeenCalled()
    expect(d.hold).not.toHaveBeenCalled()
    expect(d.forward).not.toHaveBeenCalled()
  })
})
