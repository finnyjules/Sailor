import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RUNNER_VIDEO_MODELS, falVideoFn, durOr } from '~~/server/runner/generators/video'
import { RUNNER_VIDEO_MODEL_IDS } from '#shared/runner/eligibility'
import { videoRate } from '#shared/pricing/videoRates'
import { expectPythonParity } from './helpers/pythonParity'

const fixtures = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/runner-builders.json', import.meta.url)), 'utf8'))

// The fixture is Python's payload. Since Task S1b the runner deliberately
// differs where Python breaks fal's published schema (no seed on FLUX 3, a
// resolution outside the model's list sent as its default);
// helpers/pythonParity.ts compares every other field.
describe('video request builders match Python (where Python keeps to fal\'s schema)', () => {
  for (const c of fixtures.video as any[]) {
    it(`${c.model} ${JSON.stringify(c.args)}`, () => {
      const d = RUNNER_VIDEO_MODELS[c.model]!
      const got = d.build({ prompt: c.args.prompt, aspectRatio: c.args.ar, duration: c.args.dur, seed: c.args.seed, image: c.args.image, adv: c.args.adv })
      const fn = falVideoFn(got, d.fnByMode)
      expectPythonParity('fal', fn ? `${d.app}/${fn}` : d.app, got, c.payload)
    })
  }
})

describe('video model list', () => {
  it('describes exactly the runner models, each with a price', () => {
    expect(Object.keys(RUNNER_VIDEO_MODELS).sort()).toEqual([...RUNNER_VIDEO_MODEL_IDS].sort())
    for (const id of RUNNER_VIDEO_MODEL_IDS) expect(videoRate(id)?.confidence, id).toBe('verified')
  })
})

describe('falVideoFn (nodes_replicate._fal_fn_for_input)', () => {
  const seedance = RUNNER_VIDEO_MODELS['seedance-2.0']!.fnByMode
  it('a first frame picks image-to-video', () => {
    expect(falVideoFn({ image_url: 'u' }, seedance)).toBe('image-to-video')
  })
  it('reference arrays pick reference-to-video', () => {
    expect(falVideoFn({ image_urls: ['u'] }, seedance)).toBe('reference-to-video')
  })
  it('otherwise text-to-video; Veo submits to the app itself', () => {
    expect(falVideoFn({}, seedance)).toBe('text-to-video')
    expect(falVideoFn({}, RUNNER_VIDEO_MODELS['veo-3.1']!.fnByMode)).toBe('')
  })
  it('refuses a mode the model has no endpoint for', () => {
    expect(() => falVideoFn({ image_urls: ['u'] }, RUNNER_VIDEO_MODELS['hailuo-h3-max']!.fnByMode)).toThrow()
  })
})

describe('durOr', () => {
  it('keeps a supported value, else the closest, first on a tie', () => {
    expect(durOr([4, 6, 8], 6, 8)).toBe(6)
    expect(durOr([4, 6, 8], 7, 8)).toBe(6)
    expect(durOr([5, 10], 100, 5)).toBe(10)
    expect(durOr([], 3, 5)).toBe(5)
  })
})
