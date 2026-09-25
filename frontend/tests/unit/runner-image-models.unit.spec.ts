import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  RUNNER_IMAGE_MODELS, imageAppFor, composeImagePrompt, STYLE_REFS_INSTRUCTION,
} from '~~/server/runner/generators/image'
import { RUNNER_IMAGE_MODEL_IDS } from '#shared/runner/eligibility'
import { IMAGE_MODELS_BY_ID } from '~~/app/data/image-models'
import { expectPythonParity } from './helpers/pythonParity'

const fixtures = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/runner-builders.json', import.meta.url)), 'utf8'))

// The fixture is Python's payload. Since Task S1b the runner deliberately
// differs where Python breaks fal's published schema (Flux 1.1 Pro and
// Schnell send "jpeg", not "jpg"); helpers/pythonParity.ts compares every
// other field.
describe('image request builders match Python (where Python keeps to fal\'s schema)', () => {
  for (const c of fixtures.image as any[]) {
    it(`${c.model} ${JSON.stringify(c.args)}`, () => {
      const desc = RUNNER_IMAGE_MODELS[c.model]!
      const got = desc.build({ prompt: c.args.prompt, aspectRatio: c.args.ar, seed: c.args.seed, adv: c.args.adv, refs: null })
      expectPythonParity('fal', desc.app, got, c.payload)
    })
  }
})

describe('image model list', () => {
  it('describes exactly the runner models, each with a price', () => {
    expect(Object.keys(RUNNER_IMAGE_MODELS).sort()).toEqual([...RUNNER_IMAGE_MODEL_IDS].sort())
    for (const id of RUNNER_IMAGE_MODEL_IDS) {
      expect(typeof IMAGE_MODELS_BY_ID[id]?.pricePerImage, id).toBe('number')
    }
  })
})

describe('moodboard pictures on fal', () => {
  const refs = ['https://fal.test/a.png', 'https://fal.test/b.png']
  it('nano-banana-2 goes to its edit endpoint with image_urls and no web search', () => {
    const d = RUNNER_IMAGE_MODELS['nano-banana-2']!
    expect(imageAppFor(d, refs)).toBe('fal-ai/nano-banana-2/edit')
    const p = d.build({ prompt: 'p', aspectRatio: '1:1', seed: 3, adv: { google_search: true }, refs })
    expect(p.image_urls).toEqual(refs)
    expect(p).not.toHaveProperty('enable_web_search')
    expect(p.seed).toBe(3)
  })
  it('nano-banana-pro, seedream-4 and seedream-5-lite have edit endpoints', () => {
    expect(imageAppFor(RUNNER_IMAGE_MODELS['nano-banana-pro']!, refs)).toBe('fal-ai/nano-banana-pro/edit')
    expect(imageAppFor(RUNNER_IMAGE_MODELS['seedream-4']!, refs)).toBe('fal-ai/bytedance/seedream/v4/edit')
    expect(imageAppFor(RUNNER_IMAGE_MODELS['seedream-5-lite']!, refs)).toBe('fal-ai/bytedance/seedream/v5/lite/edit')
    const s5 = RUNNER_IMAGE_MODELS['seedream-5-lite']!.build({ prompt: 'p', aspectRatio: '1:1', seed: 3, adv: {}, refs })
    expect(s5.image_urls).toEqual(refs)
    expect(s5).not.toHaveProperty('seed')
  })
  it('models without a reference endpoint ignore pictures', () => {
    const d = RUNNER_IMAGE_MODELS['flux-schnell']!
    expect(d.refsApp).toBeNull()
    expect(imageAppFor(d, refs)).toBe('fal-ai/flux/schnell')
    expect(d.build({ prompt: 'p', aspectRatio: '1:1', seed: 0, adv: {}, refs })).not.toHaveProperty('image_urls')
  })
})

describe('composeImagePrompt (GenerateImageNode.execute)', () => {
  it('orders taste wire · style block · idea · prompt', () => {
    expect(composeImagePrompt({ prompt: 'a cat', promptIn: 'idea', styleBlock: ' soft light ', styleIn: 'taste', hasRefs: false }))
      .toBe('taste soft light idea a cat')
  })
  it('lets the idea stand alone when the prompt is empty', () => {
    expect(composeImagePrompt({ prompt: '  ', promptIn: 'idea', hasRefs: false })).toBe('idea')
  })
  it('appends the style-only instruction when pictures ride along', () => {
    expect(composeImagePrompt({ prompt: 'a cat', hasRefs: true })).toBe(`a cat ${STYLE_REFS_INSTRUCTION}`)
  })
})
