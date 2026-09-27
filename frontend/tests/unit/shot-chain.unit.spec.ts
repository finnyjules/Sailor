/**
 * Ruling M (characters stage 3 final fix): the whole chain a Shot Director
 * "Generate" runs, for each model × mode, end to end:
 *
 *   sheet → prepareShotDispatch (cast as /view IdentityRefSets)
 *         → the Film a shot API prompt node the canvas writes (FilmShotNode,
 *           its widgets + the model_options JSON)
 *         → requestProblems on the runner gate and on the ComfyUI gate
 *         → planNodeRequest's payload (when the runner gate passes).
 *
 * Every picture on the sheet that the model is sent (the first frame, the
 * last frame, the cast pictures the profile picks) must reach the payload,
 * or a step must refuse the shot in words. Never the sheet grid.
 */
import { describe, expect, it } from 'vitest'
import { prepareShotDispatch } from '~/lib/shotdirector/prepare'
import { castMemberPictures, castPicturesLeftOut } from '~/lib/shotdirector/cast'
import { getProfile } from '~/lib/shotdirector/profiles'
import { createDefaultShotSheet, type ShotSheet } from '~/lib/shotdirector/types'
import type { IdentityRefSet } from '#shared/characters/types'
import type { ApiPrompt } from '#shared/runner/graph'
import { planNode } from '~~/server/runner/executors'
import { SHOT_FRAMES_RUNNER_ONLY_WORDS, KLING_ELEMENTS_COMFY_WORDS, requestProblems } from '~~/server/runner/requestRules'
import { VEO_31_ONE_PICTURE } from '~~/server/runner/generators/video'
import type { OutputFile } from '~~/server/runner/types'

const V = (n: string) => `/view?filename=${n}&type=input`
/** planNodeRequest's toUrl, stubbed: a /view file name → https://fal/<name>. */
const toUrl = async (f: OutputFile) => `https://fal/${f.filename}`
const fal = (viewLink: string) => `https://fal/${new URLSearchParams(viewLink.split('?')[1]).get('filename')}`

const GRID = 'vera-sheet-grid.png'
const CAST: Record<string, IdentityRefSet> = {
  vera: {
    name: 'Vera',
    front: V('vera-front.png'),
    portrait: V('vera-portrait.png'),
    bodyFront: V('vera-body-front.png'),
    bodyBack: V('vera-body-back.png'),
  },
}

type Mode = 'reference with cast' | 'first frame with cast' | 'first + last frame'
const MODES: Mode[] = ['reference with cast', 'first frame with cast', 'first + last frame']
const MODELS = ['seedance-2.0', 'kling-v3', 'veo-3.1'] as const

function sheetFor(model: string, mode: Mode): ShotSheet {
  const s = createDefaultShotSheet()
  s.model = model
  s.subject = 'Vera'
  s.action = 'walks through the rain'
  s.environment = 'a neon street'
  s.format.aspectRatio = '16:9'
  s.format.durationS = model === 'seedance-2.0' ? 5 : model === 'kling-v3' ? 5 : 8
  if (mode === 'reference with cast') {
    s.mode = 'reference'
    s.cast = [{ slug: 'vera', name: 'Vera', via: 'picker', stateId: null }]
  }
  else if (mode === 'first frame with cast') {
    s.mode = 'firstLastFrame'
    s.firstFrame = V('first.png')
    s.cast = [{ slug: 'vera', name: 'Vera', via: 'picker', stateId: null }]
  }
  else {
    s.mode = 'firstLastFrame'
    s.firstFrame = V('first.png')
    s.lastFrame = V('last.png')
  }
  return s
}

/** The Film a shot node the canvas writes: its own widgets (preset stays) patched with Shot Director's. */
function filmShotPrompt(patch: Record<string, unknown>): ApiPrompt {
  return { n: { class_type: 'FilmShotNode', inputs: { preset: 'slow_push_in', ...patch } } }
}

/** Every picture on the sheet the model is sent (as /view links). */
function sheetPictures(sheet: ShotSheet): string[] {
  const profile = getProfile(sheet.model!)
  const out: string[] = []
  if (sheet.firstFrame) out.push(sheet.firstFrame)
  if (sheet.lastFrame) out.push(sheet.lastFrame)
  if (!castPicturesLeftOut(sheet, profile)) {
    for (const m of sheet.cast) out.push(...castMemberPictures(CAST[m.slug], profile))
  }
  return out
}

interface Want {
  /** prepareShotDispatch refuses the sheet in these words (a regexp on the error). */
  prepareRefuses?: RegExp
  runner?: string[]
  comfy?: string[]
  endpoint?: string
}

const WANT: Record<(typeof MODELS)[number], Record<Mode, Want>> = {
  'seedance-2.0': {
    'reference with cast': { runner: [], comfy: [], endpoint: 'bytedance/seedance-2.0/reference-to-video' },
    'first frame with cast': { runner: [], comfy: [], endpoint: 'bytedance/seedance-2.0/image-to-video' },
    'first + last frame': { runner: [], comfy: [], endpoint: 'bytedance/seedance-2.0/image-to-video' },
  },
  'kling-v3': {
    // Kling must start from a picture: a reference-mode sheet with no first frame is refused.
    'reference with cast': { prepareRefuses: /Kling 3 needs a first frame/ },
    'first frame with cast': { runner: [], comfy: [SHOT_FRAMES_RUNNER_ONLY_WORDS, KLING_ELEMENTS_COMFY_WORDS], endpoint: 'fal-ai/kling-video/v3/pro/image-to-video' },
    'first + last frame': { runner: [], comfy: [SHOT_FRAMES_RUNNER_ONLY_WORDS], endpoint: 'fal-ai/kling-video/v3/pro/image-to-video' },
  },
  'veo-3.1': {
    'reference with cast': { runner: [], comfy: [VEO_31_ONE_PICTURE], endpoint: 'fal-ai/veo3.1/reference-to-video' },
    'first frame with cast': { runner: [], comfy: [SHOT_FRAMES_RUNNER_ONLY_WORDS], endpoint: 'fal-ai/veo3.1/image-to-video' },
    // Veo never takes a last frame: refused at the sheet, in words.
    'first + last frame': { prepareRefuses: /Veo 3\.1 can't use a last frame/ },
  },
}

describe('Shot Director → Film a shot → gates → payload, per model and mode', () => {
  for (const model of MODELS) {
    for (const mode of MODES) {
      it(`${model}, ${mode}`, async () => {
        const want = WANT[model][mode]
        const sheet = sheetFor(model, mode)
        const out = prepareShotDispatch(sheet, CAST, {})
        if (want.prepareRefuses) {
          expect(out.ok).toBe(false)
          if (!out.ok) expect(out.error).toMatch(want.prepareRefuses)
          return
        }
        if (!out.ok) throw new Error(`prepareShotDispatch refused: ${out.error}`)
        const prompt = filmShotPrompt(out.patch as unknown as Record<string, unknown>)

        expect(requestProblems(prompt, { runner: true }).map(p => p.message)).toEqual(want.runner)
        expect(requestProblems(prompt).map(p => p.message)).toEqual(want.comfy)

        const plan = await planNode({ prompt, nodeId: 'n', filesFrom: () => [], toUrl, gateOpen: false })
        if (plan.kind !== 'provider') throw new Error('not a provider plan')
        expect(plan.endpoint).toBe(want.endpoint)
        const sent = JSON.stringify(plan.payload)
        const pictures = sheetPictures(out.sheet)
        expect(pictures.length).toBeGreaterThan(0)
        for (const pic of pictures) expect(sent, pic).toContain(fal(pic))
        expect(sent).not.toContain('/view')
        expect(sent).not.toContain(GRID)
        expect(plan.payload).not.toHaveProperty('__shot_directed')
        // A backup, when there is one, carries the same pictures (never a silent fall-over).
        if (plan.backup) {
          const backup = JSON.stringify(plan.backup.payload)
          for (const pic of pictures) expect(backup, `backup ${pic}`).toContain(fal(pic))
        }
      })
    }
  }

  it('Seedance and Veo with a cast and a first frame send the first frame as image_url and no image_urls', async () => {
    for (const model of ['seedance-2.0', 'veo-3.1', 'veo-3.1-fast']) {
      const out = prepareShotDispatch(sheetFor(model, 'first frame with cast'), CAST, {})
      if (!out.ok) throw new Error(out.error)
      const opts = JSON.parse(out.patch.model_options)
      expect(opts.image_url, model).toBe(V('first.png'))
      expect(opts, model).not.toHaveProperty('image_urls')
      const plan = await planNode({ prompt: filmShotPrompt(out.patch as unknown as Record<string, unknown>), nodeId: 'n', filesFrom: () => [], toUrl, gateOpen: false })
      if (plan.kind !== 'provider') throw new Error('not a provider plan')
      expect(plan.payload.image_url, model).toBe('https://fal/first.png')
      expect(plan.payload, model).not.toHaveProperty('image_urls')
    }
  })
})
