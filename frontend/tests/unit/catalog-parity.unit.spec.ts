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
// can't be imported from vitest, so read its source text and extract the
// `ImageModel(...)` entries with a regex, then compare per-model tag lists.
// Execution-side gates (B3's refs ride-along) key off the Python tags, so a
// drift here means the UI promises a capability the backend won't honor.
// ---------------------------------------------------------------------------

const PY_CATALOG_PATH = resolve(__dirname, '../../../comfy_api_nodes/image_models.py')

/** Extract { id: tags[] } from the Python catalog's MODELS list. */
function pythonTagsById(): Record<string, string[]> {
  const src = readFileSync(PY_CATALOG_PATH, 'utf-8')
  const listStart = src.indexOf('MODELS: list[ImageModel] = [')
  expect(listStart, 'MODELS list not found in image_models.py').toBeGreaterThan(-1)
  const body = src.slice(listStart)
  // Split on constructor calls; each chunk runs to the next call (or EOF) and
  // therefore contains the whole entry, including its `tags=(...)` kwarg.
  const chunks = body.split('ImageModel(').slice(1)
  const out: Record<string, string[]> = {}
  for (const chunk of chunks) {
    const id = chunk.match(/^\s*"([^"]+)"/)?.[1]
    if (!id) continue
    const tagsTuple = chunk.match(/tags=\(([^)]*)\)/)?.[1] ?? ''
    out[id] = [...tagsTuple.matchAll(/"([^"]+)"/g)].map(m => m[1]!)
  }
  return out
}

describe('image catalog TS ↔ Python parity', () => {
  const pyTags = pythonTagsById()

  // A runner-only model (GPT Image 2.5, model line-up F2) has no Python builder, so no Python entry.
  const withPython = IMAGE_MODELS.filter(m => !m.runnerOnly)

  it('both catalogs list the same model ids (the runner-only ones are not in Python)', () => {
    expect(IMAGE_MODELS.filter(m => m.runnerOnly).map(m => m.id)).toEqual(['ideogram-4', 'gpt-image-2.5', 'qwen-image-3', 'grok-imagine-2', 'muse-image'])
    expect(pyTags['gpt-image-2.5']).toBeUndefined()
    expect(pyTags['ideogram-4']).toBeUndefined()
    expect(pyTags['qwen-image-3']).toBeUndefined()
    expect(pyTags['grok-imagine-2']).toBeUndefined()
    expect(pyTags['muse-image']).toBeUndefined()
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
