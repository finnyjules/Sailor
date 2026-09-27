/**
 * F6 follow-up: Veo 3.1, Veo 3.1 Fast and Veo 3.1 Lite share one builder
 * (server/runner/generators/video.ts veo31) that sends a first frame at most.
 * A last frame, or reference pictures, videos or sounds, left in the node's
 * options used to be dropped without a word. They are now refused in plain
 * words (VEO_31_ONE_PICTURE), before the hold (requestProblems, both paths,
 * Generate a video and Film a shot) and at planning (the builder), as Gemini
 * Omni Flash's are.
 *
 * Task 2 (characters stage 3): Veo 3.1 and Veo 3.1 Fast, on the runner, now
 * take up to 3 reference pictures instead, via fal's reference-to-video
 * endpoint (veo31RefsProblem / VEO_31_REFS_WORDS). Veo 3.1 Lite has no
 * reference-to-video wired here, and the ComfyUI /prompt gate (Python never
 * sends references) keeps the old full refusal for all three ids.
 */
import { describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_VIDEO_MODEL_IDS } from '#shared/runner/eligibility'
import { planNode } from '~~/server/runner/executors'
import { RUNNER_VIDEO_MODELS, VEO_31_ONE_PICTURE, VEO_31_REFS_WORDS, falVideoFn, veo31HasExtras, veo31RefsProblem } from '~~/server/runner/generators/video'
import { veo31Lite } from '~~/server/runner/generators/veo31Lite'
import { VEO_31_MODEL_IDS, requestProblems } from '~~/server/runner/requestRules'
import type { OutputFile } from '~~/server/runner/types'

const LINK = ['9', 0]
const RUNNER_ELIGIBLE = new Set(RUNNER_VIDEO_MODEL_IDS as readonly string[])

function vid(ct: 'GenerateVideoNode' | 'FilmShotNode', model: string, o: { opts?: Record<string, unknown>, image?: boolean } = {}) {
  const inputs: Record<string, unknown> = {
    model, prompt: 'a fox in the snow', aspect_ratio: '16:9', duration: '8', seed: 0, model_options: JSON.stringify(o.opts ?? {}),
  }
  if (o.image) inputs.image = LINK
  return { class_type: ct, inputs }
}

function plan(node: { class_type: string, inputs: Record<string, unknown> }) {
  return planNode({
    prompt: { 9: { class_type: 'Image', inputs: { image: 'first.png' } }, n: node },
    nodeId: 'n',
    filesFrom: () => [{ filename: 'first.png', subfolder: '', type: 'input' }],
    toUrl: async (f: OutputFile) => `IMG:${f.filename}`,
    gateOpen: false,
  })
}

const EXTRAS: [string, Record<string, unknown>][] = [
  ['a last frame', { end_image_url: 'https://x/last.png' }],
  ['reference pictures', { image_urls: ['https://x/a.png'] }],
  ['reference videos', { video_urls: ['https://x/a.mp4'] }],
  ['reference sounds', { audio_urls: ['https://x/a.mp3'] }],
  ['a last frame and references', { end_image_url: 'https://x/last.png', image_urls: ['https://x/a.png'] }],
  ['more than 3 reference pictures', { image_urls: ['https://x/a.png', 'https://x/b.png', 'https://x/c.png', 'https://x/d.png'] }],
]

describe('Veo 3.1 reference pictures', () => {
  const args = (adv: Record<string, unknown>, image: string | null = null) =>
    ({ prompt: 'Reva walks', aspectRatio: '9:16', duration: 5, seed: 7, image, adv })

  for (const id of ['veo-3.1', 'veo-3.1-fast']) {
    it(`${id}: image_urls go to reference-to-video, 8 s, no seed or negative prompt`, () => {
      const d = RUNNER_VIDEO_MODELS[id]!
      const payload = d.build(args({ image_urls: ['a', 'b', 'c'], negative_prompt: 'x', resolution: '1080p' }))
      expect(payload).toEqual({ prompt: 'Reva walks', image_urls: ['a', 'b', 'c'], aspect_ratio: '9:16', duration: '8s', resolution: '1080p', generate_audio: true, auto_fix: true })
      expect(falVideoFn(payload, d.fnByMode)).toBe('reference-to-video')
    })
  }
  it('refuses more than 3 pictures, a first frame beside pictures, a last frame, clips or sounds', () => {
    expect(veo31RefsProblem({ image_urls: ['a', 'b', 'c', 'd'] }, false)).toBe(VEO_31_REFS_WORDS)
    expect(veo31RefsProblem({ image_urls: ['a'] }, true)).toBe(VEO_31_REFS_WORDS)
    expect(veo31RefsProblem({ end_image_url: 'z' }, false)).toBe(VEO_31_REFS_WORDS)
    expect(veo31RefsProblem({ video_urls: ['v'] }, false)).toBe(VEO_31_REFS_WORDS)
    expect(veo31RefsProblem({ audio_urls: ['s'] }, false)).toBe(VEO_31_REFS_WORDS)
    expect(veo31RefsProblem({ image_urls: ['a', 'b', 'c'] }, false)).toBeNull()
    expect(veo31RefsProblem({}, true)).toBeNull()
  })
  it('the builder throws the same words', () => {
    expect(() => RUNNER_VIDEO_MODELS['veo-3.1']!.build(args({ image_urls: ['a'] }, 'first.png'))).toThrow(VEO_31_REFS_WORDS)
  })
})

describe('Veo 3.1 (all three): a last frame or references are refused, never dropped', () => {
  it('the three models share the rule', () => {
    expect([...VEO_31_MODEL_IDS]).toEqual(['veo-3.1', 'veo-3.1-fast', 'veo-3.1-lite'])
    // Veo 3.1 and Fast are the one builder; Lite reuses it (veo31Lite.ts).
    expect(RUNNER_VIDEO_MODELS['veo-3.1']!.build).toBe(RUNNER_VIDEO_MODELS['veo-3.1-fast']!.build)
  })

  for (const model of VEO_31_MODEL_IDS) {
    const runnerEligible = RUNNER_ELIGIBLE.has(model)
    for (const [name, opts] of EXTRAS) {
      for (const image of [false, true]) {
        it(`${model}, ${name}${image ? ', with a first frame' : ''}: refused at the ComfyUI /prompt gate; at planning too, unless the runner now takes it`, async () => {
          const node = vid('GenerateVideoNode', model, { opts, image })
          // The /prompt gate (opts.runner unset) simulates ComfyUI, which never sends references:
          // always the old one-picture words, for all three ids.
          expect(requestProblems({ n: node })).toEqual([{ nodeId: 'n', classType: 'GenerateVideoNode', input: 'model_options', message: VEO_31_ONE_PICTURE }])
          // Planning runs the builder. Veo 3.1 and Fast now take up to 3 references without a
          // first frame (Task 2); every other combination, and Lite always, still refuses.
          const runnerAllows = runnerEligible && name === 'reference pictures' && !image
          if (runnerAllows) {
            const p = await plan(node)
            expect(p.kind).toBe('provider')
          }
          else {
            await expect(plan(node)).rejects.toThrow(runnerEligible ? VEO_31_REFS_WORDS : VEO_31_ONE_PICTURE)
          }
        })
      }
    }
  }

  it('the runner engine gate (requestProblems with runner: true) takes references on Veo 3.1 and Fast, not on Lite', () => {
    for (const model of ['veo-3.1', 'veo-3.1-fast']) {
      const ok = vid('GenerateVideoNode', model, { opts: { image_urls: ['https://x/a.png', 'https://x/b.png', 'https://x/c.png'] } })
      expect(requestProblems({ n: ok }, { runner: true }), model).toEqual([])
      const tooMany = vid('GenerateVideoNode', model, { opts: { image_urls: ['https://x/a.png', 'https://x/b.png', 'https://x/c.png', 'https://x/d.png'] } })
      expect(requestProblems({ n: tooMany }, { runner: true }), model).toEqual([{ nodeId: 'n', classType: 'GenerateVideoNode', input: 'model_options', message: VEO_31_REFS_WORDS }])
      const withFirst = vid('GenerateVideoNode', model, { opts: { image_urls: ['https://x/a.png'] }, image: true })
      expect(requestProblems({ n: withFirst }, { runner: true }), model).toEqual([{ nodeId: 'n', classType: 'GenerateVideoNode', input: 'model_options', message: VEO_31_REFS_WORDS }])
    }
    const lite = vid('GenerateVideoNode', 'veo-3.1-lite', { opts: { image_urls: ['https://x/a.png'] } })
    expect(requestProblems({ n: lite }, { runner: true })).toEqual([{ nodeId: 'n', classType: 'GenerateVideoNode', input: 'model_options', message: VEO_31_ONE_PICTURE }])
  })

  it('Film a shot on Veo 3.1 or Fast (the ComfyUI path) is refused at the gate with the same words; a legacy name too', () => {
    for (const model of ['veo-3.1', 'veo-3.1-fast', 'Veo 3']) {
      for (const [name, opts] of EXTRAS) {
        const node = vid('FilmShotNode', model, { opts })
        expect(requestProblems({ n: node }), `${model} ${name}`).toEqual([{ nodeId: 'n', classType: 'FilmShotNode', input: 'model_options', message: VEO_31_ONE_PICTURE }])
      }
    }
  })

  it('the builder itself refuses, so no caller can drop them', () => {
    const args = { prompt: 'p', aspectRatio: '16:9', duration: 8, seed: 0, image: null }
    expect(() => RUNNER_VIDEO_MODELS['veo-3.1']!.build({ ...args, adv: { end_image_url: 'u' } })).toThrow(VEO_31_REFS_WORDS)
    expect(() => veo31Lite({ ...args, adv: { image_urls: ['u'] } })).toThrow(VEO_31_ONE_PICTURE)
  })

  it('what still runs: text only, a first frame, empty lists and blank values, wired options', async () => {
    const fine: Record<string, unknown>[] = [{}, { image_urls: [], video_urls: [], audio_urls: [] }, { end_image_url: '' }, { end_image_url: null }, { resolution: '1080p' }]
    for (const model of VEO_31_MODEL_IDS) {
      for (const opts of fine) {
        for (const image of [false, true]) {
          const node = vid('GenerateVideoNode', model, { opts, image })
          const label = `${model} ${JSON.stringify(opts)} ${image}`
          expect(veo31HasExtras(opts), label).toBe(false)
          expect(requestProblems({ n: node }), label).toEqual([])
          const p = await plan(node)
          expect(p.kind, label).toBe('provider')
        }
      }
      const wired = vid('GenerateVideoNode', model, { opts: { end_image_url: 'u' } })
      wired.inputs.model_options = ['7', 0]
      expect(requestProblems({ n: wired }), model).toEqual([])
    }
    // Another model with a last frame is not judged by this rule.
    const other: ApiPrompt = { n: vid('GenerateVideoNode', 'kling-v3', { opts: { end_image_url: 'u' } }) }
    expect(requestProblems(other).map(p => p.message)).not.toContain(VEO_31_ONE_PICTURE)
  })

  it('the words name the model and say what to do, with no ids', () => {
    expect(VEO_31_ONE_PICTURE).toMatch(/^Veo 3\.1 /)
    expect(VEO_31_ONE_PICTURE).not.toMatch(/_|url/i)
    expect(VEO_31_REFS_WORDS).toMatch(/^Veo 3\.1 /)
    expect(VEO_31_REFS_WORDS).not.toMatch(/_|url/i)
  })
})
