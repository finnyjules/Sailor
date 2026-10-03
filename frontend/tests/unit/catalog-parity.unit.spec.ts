import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { IMAGE_MODELS, IMAGE_MODELS_BY_ID } from '~/data/image-models'
import { VIDEO_MODELS_BY_ID } from '~/data/video-models'

describe('new model catalog entries', () => {
  it('exposes the Krea 2 image models', () => {
    expect(IMAGE_MODELS_BY_ID['krea-2-large']?.brand).toBe('Krea')
    expect(IMAGE_MODELS_BY_ID['krea-2-medium']?.brand).toBe('Krea')
    expect(IMAGE_MODELS_BY_ID['krea-2-large']?.replicateSlug).toBe('krea/krea-2-large')
  })

  it('exposes flux-2-dev alongside the existing FLUX.2 family', () => {
    for (const id of ['flux-2-pro', 'flux-2-max', 'flux-2-flex', 'flux-2-dev']) {
      expect(IMAGE_MODELS_BY_ID[id], id).toBeTruthy()
    }
  })

  it('exposes FLUX 3 as a t2v+i2v video model', () => {
    const m = VIDEO_MODELS_BY_ID['flux-3']
    expect(m?.brand).toBe('BFL')
    expect(m?.modes).toEqual(['t2v', 'i2v'])
    expect(m?.durations).toContain(20)
  })
})

// ---------------------------------------------------------------------------
// TS ↔ Python catalog parity — the Python side (comfy_api_nodes/image_models.py)
// listed each model's tags; execution-side gates (B3's refs ride-along) keyed
// off them. Python left the repo in step 4, C7: its tag lists were frozen then
// into fixtures/python-image-models.json.
// ---------------------------------------------------------------------------

/** { id: tags[] } from the Python catalog's MODELS list, as it stood at C7. */
function pythonTagsById(): Record<string, string[]> {
  const { models } = JSON.parse(readFileSync(resolve(__dirname, 'fixtures', 'python-image-models.json'), 'utf-8')) as { models: { id: string, tags: string[] }[] }
  return Object.fromEntries(models.map(m => [m.id, m.tags]))
}

describe('image catalog TS ↔ Python parity', () => {
  const pyTags = pythonTagsById()

  // A runner-only model (GPT Image 2.5, model line-up F2) has no Python builder, so no Python entry;
  // except the Recraft SVG models (R11.4 fix round 1): Python lists them but can't decode their SVG.
  const withPython = IMAGE_MODELS.filter(m => !m.runnerOnly || m.family === 'recraft-svg')

  it('both catalogs list the same model ids (the runner-only ones are not in Python)', () => {
    expect(IMAGE_MODELS.filter(m => m.runnerOnly).map(m => m.id)).toEqual(['flux-3-image', 'nano-banana-2-lite', 'ideogram-4.5', 'ideogram-4', 'recraft-v4.1', 'recraft-v4-pro-svg', 'recraft-v4-svg', 'recraft-v3-svg', 'gpt-image-2.5', 'qwen-image-3', 'grok-imagine-2', 'muse-image', 'reve-2.1'])
    expect(pyTags['gpt-image-2.5']).toBeUndefined()
    expect(pyTags['ideogram-4']).toBeUndefined()
    expect(pyTags['qwen-image-3']).toBeUndefined()
    expect(pyTags['grok-imagine-2']).toBeUndefined()
    expect(pyTags['muse-image']).toBeUndefined()
    expect(pyTags['nano-banana-2-lite']).toBeUndefined()
    expect(pyTags['reve-2.1']).toBeUndefined()
    expect(pyTags['recraft-v4.1']).toBeUndefined()
    expect(pyTags['ideogram-4.5']).toBeUndefined()
    expect(pyTags['flux-3-image']).toBeUndefined()
    const tsIds = withPython.map(m => m.id).sort()
    const pyIds = Object.keys(pyTags).sort()
    expect(pyIds).toEqual(tsIds)
  })

  it('mirrors every model tag list into the Python catalog, same order', () => {
    for (const m of withPython) {
      expect(pyTags[m.id], `${m.id}: Python tags`).toEqual([...m.tags])
    }
  })

  it('nano-banana-pro is ref-capable on both sides', () => {
    expect(IMAGE_MODELS_BY_ID['nano-banana-pro']?.tags).toContain('multi-image')
    expect(pyTags['nano-banana-pro']).toContain('multi-image')
  })
})
