import { describe, it, expect } from 'vitest'
import {
  MODEL_PRICED_BADGE_CLASSES,
  modelPricedUsd,
  nodeCreditEstimate,
} from '~/lib/nodeCreditEstimate'
import { creditsForUsd } from '~/lib/pricing'
import { IMAGE_MODELS } from '~/data/image-models'
import { LEGACY_VIDEO_MODEL_IDS } from '~/data/video-prices'
import { VIDEO_RATES, videoUsd } from '#shared/pricing/videoRates'
import { effectiveVideoSettings } from '#shared/pricing/videoSettings'
import { ENHANCE_ENGINE_SLUGS, UPSCALE_ENGINE_SLUGS } from '#shared/pricing/editSettings'
import { PAID_NODE_CLASSES } from '#shared/pricing/paidSettings'
import { MODEL_PRICED_NODE_CLASSES, REMOTE_VIDEO_NODE_CLASSES, SETTING_PRICED_NODE_CLASSES, UnpricedGraphError, priceGraph } from '../../server/utils/priceBook'

// The hosted node badge must price a model-picker node from the model the user
// actually picked, not from the static price_badge string baked into the Python
// schema — those diverge by up to 8x across a picker's model range. These
// assertions mirror server/utils/priceBook.ts's graphNodeModelCredits: same
// catalogs, same legacy remaps, same markup policy, plus the 1cr base_render
// the graph pricer adds for the render itself.
const BASE_RENDER = 1

/** A video model's price for a node that sets only its model: the builder's default clip. */
const defaultClipUsd = (id: string) => videoUsd(id, effectiveVideoSettings(id, undefined, undefined, {})!)!

describe('MODEL_PRICED_BADGE_CLASSES', () => {
  it('covers the five picker classes the server prices by model', () => {
    expect([...MODEL_PRICED_NODE_CLASSES].sort()).toEqual([
      'EnhanceDetailNode',
      'FilmShotNode',
      'GenerateImageNode',
      'GenerateVideoNode',
      'UpscaleImageNode',
    ])
  })

  it('is the same set the server price book prices from widgets: by model, (Task P4) the edit tools by their settings, (Task P5) the older video and lip-sync nodes per second, and (Task F23) Enhance a video while its switch moves it to fal, and (step 3, R3) the paid classes priced by their calls', () => {
    // + step 3, R3: the paid classes priced by their calls (R3.3 the LLM text nodes, R3.4 describe, read and find).
    // + step 3, R7.1: Background remove, priced while its family moves it onto Replicate.
    expect([...MODEL_PRICED_BADGE_CLASSES].sort()).toEqual([...MODEL_PRICED_NODE_CLASSES, ...SETTING_PRICED_NODE_CLASSES, ...REMOTE_VIDEO_NODE_CLASSES, 'EnhanceVideoNode', 'PersonSwapVideo', ...PAID_NODE_CLASSES, 'BackgroundRemove', 'UpscaleImage', 'ObjectRemove', 'MaskByText', 'MaskExtractor', 'SubjectMask', 'FrameInterpolateAI'].sort())
  })
})

// The gate this whole helper exists for: what the badge PROMISES must equal
// what the server CHARGES for the same node at the same model. Compare against
// priceGraph itself (a one-node graph with a SaveImage sink, so base_render is
// in both figures) rather than re-deriving the number a second way.
describe('badge ↔ server price parity', () => {
  const cases: [string, string][] = [
    ['GenerateImageNode', 'flux-2-pro'],
    ['GenerateImageNode', 'seedream-4.5'],
    ['GenerateVideoNode', 'veo-3.1'],
    ['GenerateVideoNode', 'ltx-video'],
    ['GenerateVideoNode', 'Seedance 2.0'],
    ['FilmShotNode', 'kling-v3'],
    ['UpscaleImageNode', 'Clarity'],
    ['UpscaleImageNode', 'Recraft Crisp'],
    ['EnhanceDetailNode', 'Diffusion Refine'],
  ]

  for (const [nodeType, model] of cases) {
    it(`${nodeType} @ ${model} quotes exactly what priceGraph charges`, () => {
      const server = priceGraph({
        '1': { class_type: nodeType, inputs: { model } },
        '2': { class_type: 'SaveImage', inputs: {} },
      })
      expect(nodeCreditEstimate(nodeType, { model })).toBe(server.credits)
    })
  }
})

describe('modelPricedUsd — image models', () => {
  it('reads pricePerImage off the image catalog by model id', () => {
    const priced = IMAGE_MODELS.find(m => typeof m.pricePerImage === 'number')!
    expect(modelPricedUsd('GenerateImageNode', { model: priced.id })).toBe(priced.pricePerImage)
  })

  it('returns null for an unknown model id', () => {
    expect(modelPricedUsd('GenerateImageNode', { model: 'not-a-real-model' })).toBeNull()
  })

  it('returns null for a catalog model with no listed price', () => {
    const unpriced = IMAGE_MODELS.find(m => m.pricePerImage == null)
    if (unpriced) expect(modelPricedUsd('GenerateImageNode', { model: unpriced.id })).toBeNull()
  })
})

describe('modelPricedUsd — video models', () => {
  it('prices GenerateVideoNode and FilmShotNode off the same rate card', () => {
    expect(modelPricedUsd('GenerateVideoNode', { model: 'veo-3.1' })).toBe(defaultClipUsd('veo-3.1'))
    expect(modelPricedUsd('FilmShotNode', { model: 'ltx-video' })).toBe(defaultClipUsd('ltx-video'))
  })

  it('honours the legacy model-label remap the node applies at execute time', () => {
    expect(modelPricedUsd('GenerateVideoNode', { model: 'Seedance 2.0' })).toBe(defaultClipUsd('seedance-2.0'))
    expect(modelPricedUsd('GenerateVideoNode', { model: 'Veo 3' })).toBe(defaultClipUsd('veo-3.1'))
    expect(modelPricedUsd('GenerateVideoNode', { model: 'Kling 2.1' }))
      .toBe(defaultClipUsd('kling-v2.5-turbo-pro'))
  })

  it('returns null for an unknown video model id', () => {
    expect(modelPricedUsd('GenerateVideoNode', { model: 'veo-99' })).toBeNull()
  })
})

describe('modelPricedUsd — engine pickers', () => {
  it('prices each engine at the input cap (12288 × 1536 since P5 fix round 1) × the default scale', () => {
    // Clarity at 2× makes 75.5 M px, 76 MP × $0.0125. Real-ESRGAN: $0.002 a picture. Topaz in place, 18.9 MP: one $0.08 unit.
    expect(modelPricedUsd('UpscaleImageNode', { model: 'Clarity' })).toBe(0.95)
    expect(modelPricedUsd('UpscaleImageNode', { model: 'Real-ESRGAN' })).toBe(0.002)
    expect(modelPricedUsd('EnhanceDetailNode', { model: 'Faithful' })).toBe(0.08)
  })

  it('returns null for an unknown engine name', () => {
    expect(modelPricedUsd('UpscaleImageNode', { model: 'Sharpener 9000' })).toBeNull()
  })
})

describe('modelPricedUsd — non-picker classes and empty values', () => {
  it('returns null for a class that is not model-priced', () => {
    expect(modelPricedUsd('FluxProRemoteNode', { model: 'anything' })).toBeNull()
  })

  it('returns null when no model is selected', () => {
    expect(modelPricedUsd('GenerateImageNode', { model: '' })).toBeNull()
    expect(modelPricedUsd('GenerateImageNode', { model: undefined })).toBeNull()
    expect(modelPricedUsd('GenerateImageNode', { model: null })).toBeNull()
  })
})

describe('nodeCreditEstimate', () => {
  it('is the model USD through the markup policy plus base_render', () => {
    const usd = defaultClipUsd('veo-3.1')
    expect(nodeCreditEstimate('GenerateVideoNode', { model: 'veo-3.1' })).toBe(creditsForUsd(usd) + BASE_RENDER)
  })

  it('separates a cheap engine from an expensive one on the same node', () => {
    const cheap = nodeCreditEstimate('UpscaleImageNode', { model: 'Real-ESRGAN' })!
    const dear = nodeCreditEstimate('UpscaleImageNode', { model: 'Clarity' })!
    expect(cheap).toBe(creditsForUsd(0.002) + BASE_RENDER)
    expect(dear).toBe(creditsForUsd(0.95) + BASE_RENDER)
    expect(dear).toBeGreaterThan(cheap)
  })

  it('never returns less than the base render for a priced model', () => {
    for (const id of Object.keys(VIDEO_RATES)) {
      expect(nodeCreditEstimate('GenerateVideoNode', { model: id })!).toBeGreaterThan(BASE_RENDER)
    }
  })

  it('returns null (badge falls back to the static estimate) on anything unknown', () => {
    expect(nodeCreditEstimate('GenerateImageNode', { model: 'nope' })).toBeNull()
    expect(nodeCreditEstimate('UpscaleImageNode', { model: undefined })).toBeNull()
    expect(nodeCreditEstimate('SomeOtherNode', { model: 'flux-dev' })).toBeNull()
  })
})

// Task P1 (model line-up): the badge and the charge are ONE calculation, so
// they must agree for every model-priced class at every model id any catalogue
// knows — not just a hand-picked sample. Where the server refuses, the badge
// has no figure (it falls back to the static label).
describe('badge = charge, exhaustively', () => {
  const ids = [...new Set([
    ...IMAGE_MODELS.map(m => m.id),
    ...Object.keys(VIDEO_RATES),
    ...Object.keys(LEGACY_VIDEO_MODEL_IDS),
    ...Object.keys(UPSCALE_ENGINE_SLUGS),
    ...Object.keys(ENHANCE_ENGINE_SLUGS),
  ])]

  it('the id list is the full catalogue (control)', () => {
    expect(ids.length).toBeGreaterThan(60)
  })

  for (const nodeType of MODEL_PRICED_NODE_CLASSES) {
    it(`${nodeType}: the badge quotes what priceGraph charges, for every model`, () => {
      let priced = 0
      const drift: string[] = []
      for (const model of ids) {
        const inputs = { model, prompt: 'a test', seed: 7 }
        let charge: number | null = null
        try {
          charge = priceGraph({
            '1': { class_type: nodeType, inputs },
            '2': { class_type: 'SaveImage', inputs: {} },
          }).credits
        }
        catch (e) { if (!(e instanceof UnpricedGraphError)) throw e }
        const badge = nodeCreditEstimate(nodeType, inputs)
        if (charge != null) priced++
        if (badge !== charge) drift.push(`${model}: badge ${badge}, charge ${charge}`)
      }
      expect(drift).toEqual([])
      expect(priced, 'every class prices at least one model').toBeGreaterThan(0)
    })
  }
})
