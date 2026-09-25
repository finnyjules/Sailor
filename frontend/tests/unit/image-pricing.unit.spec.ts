/**
 * Task P3 (model line-up): images are priced by what the request carries —
 * the size, the quality and the picture count — at the first service's rate
 * (shared/pricing/imageRates.ts × imageSettings.ts). The badge, the run
 * estimate and the charge all read the one calculation.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IMAGE_MODELS, IMAGE_MODELS_BY_ID } from '~~/app/data/image-models'
import { RUNNER_IMAGE_MODELS, RUNNER_REPLICATE_IMAGE_MODELS } from '~~/server/runner/generators/image'
import { asText, optInt, optStr, parseJsonObject } from '~~/server/runner/generators/opts'
import { RUNNER_IMAGE_MODEL_IDS, RUNNER_REPLICATE_IMAGE_MODEL_IDS } from '#shared/runner/eligibility'
import { UnpricedGraphError, priceGraph } from '~~/server/utils/priceBook'
import { creditsForUsd } from '#shared/pricing/markup'
import { nodeCredits, providerUsd } from '#shared/pricing/nodePrice'
import {
  IMAGE_RATES, imageDefaultUsd, imageMaxPictureUsd, imageMaxUsd, imagePriceMaxUsd, imageRate, imageRateLabel, imageUsd,
} from '#shared/pricing/imageRates'
import { effectiveImageSettings, hasImageSettings, maxImageCount } from '#shared/pricing/imageSettings'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes, widgetValueMap } from '~/lib/costEstimate'

const SINK = { class_type: 'SaveImage', inputs: {} }
const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const PY = readFileSync(`${REPO}comfy_api_nodes/image_models.py`, 'utf8')

/** What priceGraph charges for one image node plus an output node (includes 1 credit base render). */
function charge(inputs: Record<string, unknown>): number {
  return priceGraph({ 1: { class_type: 'GenerateImageNode', inputs }, 2: SINK }).credits
}

/** The catalogue models with no published price: refused, never charged at 0. */
const UNPRICED = ['reve-create', 'seedream-5-pro']

/** The ids whose Python primary is fal (`primary="fal"` in image_models.py). */
function pythonFalPrimaries(): string[] {
  const out: string[] = []
  const re = /ImageModel\("([^"]+)"[\s\S]*?(?=ImageModel\(|\n\]\n)/g
  for (const m of PY.matchAll(re)) if (/primary="fal"/.test(m[0])) out.push(m[1]!)
  return out
}

describe('the image rate card', () => {
  it('covers every catalogue model (hidden ones too) except the unpriced ones, and nothing else', () => {
    expect(Object.keys(IMAGE_RATES).sort())
      .toEqual(IMAGE_MODELS.map(m => m.id).filter(id => !UNPRICED.includes(id)).sort())
    for (const id of Object.keys(IMAGE_RATES)) expect(hasImageSettings(id), id).toBe(true)
    for (const id of UNPRICED) expect(IMAGE_MODELS_BY_ID[id], id).toBeDefined()
  })

  it('every rate names its service, source page, date, unit and confidence, and is above zero', () => {
    for (const [id, r] of Object.entries(IMAGE_RATES)) {
      expect(r.source, id).toMatch(/^https:\/\/(fal\.ai|replicate\.com)\//)
      expect(r.read, id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(['per_image', 'per_megapixel', 'by_resolution', 'by_quality'], id).toContain(r.unit)
      expect(r.confidence, id).toBe('verified')
      expect(r.source.includes('fal.ai') ? 'fal' : 'replicate', id).toBe(r.service)
      const figures = r.unit === 'per_image' ? [r.usd]
        : r.unit === 'per_megapixel' ? [r.perMegapixel]
          : Object.values(r.byTier)
      for (const f of figures) expect(f, id).toBeGreaterThan(0)
    }
  })

  it('the first service is the one the builder sends to (fal list, Python fal primaries, Replicate for the rest)', () => {
    const falPrimary = pythonFalPrimaries()
    expect(falPrimary).toEqual(expect.arrayContaining([...RUNNER_IMAGE_MODEL_IDS, 'krea-2-large', 'krea-2-medium']))
    // Runner-only models have no Python entry: their builder's service (GPT Image 2.5: fal, gptImage25.ts;
    // Qwen Image 3: Replicate, qwenImage3.ts).
    expect(IMAGE_MODELS.filter(m => m.runnerOnly).map(m => m.id)).toEqual(['gpt-image-2.5', 'qwen-image-3'])
    const runnerOnlyFal = ['gpt-image-2.5']
    for (const [id, r] of Object.entries(IMAGE_RATES)) {
      expect(r.service, id).toBe(falPrimary.includes(id) || runnerOnlyFal.includes(id) ? 'fal' : 'replicate')
    }
    for (const id of RUNNER_IMAGE_MODEL_IDS) expect(IMAGE_RATES[id]!.service, id).toBe('fal')
    for (const id of RUNNER_REPLICATE_IMAGE_MODEL_IDS) expect(IMAGE_RATES[id]!.service, id).toBe('replicate')
  })

  it('every priced model prices above zero at its defaults; the unpriced ones refuse', () => {
    for (const m of IMAGE_MODELS) {
      if (UNPRICED.includes(m.id)) {
        expect(() => charge({ model: m.id }), m.id).toThrow(UnpricedGraphError)
        expect(providerUsd('GenerateImageNode', { model: m.id }), m.id).toBeNull()
      }
      else {
        expect(providerUsd('GenerateImageNode', { model: m.id })!, m.id).toBeGreaterThan(0)
      }
    }
  })

  it('pricePerImage is the rate card\'s default-setting price (the gallery figure is pinned to the card)', () => {
    for (const m of IMAGE_MODELS) {
      const card = imageDefaultUsd(m.id, m.defaultAspectRatio)
      if (card == null) expect(m.pricePerImage, m.id).toBeNull()
      else expect(m.pricePerImage!, m.id).toBeCloseTo(card, 8)
    }
  })

  it('reads own keys only: a prototype name is refused, never priced at 0', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(imageRate(name), name).toBeUndefined()
      expect(hasImageSettings(name), name).toBe(false)
      expect(() => charge({ model: name }), name).toThrow(UnpricedGraphError)
    }
  })
})

// ── Settings parity ─────────────────────────────────────────────────────────
// fal's ImageSize enum, in pixels (fal's model pages, read 2026-09-24).
const FAL_SIZE: Record<string, [number, number]> = {
  square_hd: [1024, 1024],
  landscape_4_3: [1024, 768],
  portrait_4_3: [768, 1024],
  landscape_16_9: [1024, 576],
  portrait_16_9: [576, 1024],
}
// Replicate's schema enums for the BFL megapixel labels (saved model pages).
const FLUX_2_RES = ['0.5 MP', '1 MP', '2 MP', '4 MP']
const KLEIN_MP = ['0.25', '0.5', '1', '2', '4']
/** Controller ruling: a picture bills its pixels / 1,000,000 rounded up to a whole megapixel. */
const billed = (pixels: number) => Math.ceil(pixels / 1_000_000)
/** A BFL label as billed: label × 1024² pixels, capped at 2048², then rounded up. The builders send listed labels only (Task S1b). */
function bflMp(label: unknown, allowed: string[]): number {
  const cap = 2048 * 2048
  const s = String(label)
  expect(allowed).toContain(s)
  return billed(Math.min(Number.parseFloat(s) * 1024 * 1024, cap))
}

/**
 * Picture counts the Python Replicate fallover of a fal-first model can ask
 * for, where they exceed the fal builder's (the ComfyUI path uses it when fal
 * is not set up). Parsed from comfy_api_nodes/image_models.py.
 */
function pyReplicateBody(id: string): string {
  const head = new RegExp(`ImageModel\\("${id}",[^\\n]*?,\\s+(_b_\\w+),?\\s*\\n`).exec(PY)
  expect(head, id).not.toBeNull()
  const i = PY.indexOf(`def ${head![1]}(`)
  expect(i, head![1]).toBeGreaterThan(0)
  const rest = PY.slice(i + 4)
  return rest.slice(0, rest.search(/\ndef |\n# [-=]{3,}/))
}
function pyCountCap(body: string, field: string): number | null {
  const m = new RegExp(`min\\((\\d+), _opt_int\\(adv, "${field}"`).exec(body)
  return m ? Number(m[1]) : null
}
const SEEDREAM_LITE_PY_MAX = pyCountCap(pyReplicateBody('seedream-5-lite'), 'max_images')!
/** The count the Seedream 5 Lite fallover sends (_b_seedream_5_lite), which the price covers. */
function seedreamLiteFalloverCount(adv: Record<string, unknown>): number {
  return optStr(adv, 'sequential_image_generation', 'disabled') === 'auto'
    ? Math.max(1, Math.min(SEEDREAM_LITE_PY_MAX, optInt(adv, 'max_images', 1)))
    : 1
}

/** The billed settings a built payload carries, read from the payload alone. */
function sentSettings(id: string, payload: Record<string, unknown>) {
  const rate = IMAGE_RATES[id]!
  const counts = ['num_images', 'num_outputs', 'max_images', 'number_of_images']
    .map(k => payload[k]).filter((v): v is number => typeof v === 'number')
  const images = counts.length ? Math.max(...counts) : 1
  const tier = rate.unit === 'by_resolution' ? String(payload.resolution)
    : rate.unit === 'by_quality' ? String(payload.quality)
      : null
  let megapixels: number | null = null
  if (rate.unit === 'per_megapixel') {
    if (typeof payload.image_size === 'string') {
      const [w, h] = FAL_SIZE[payload.image_size]!
      megapixels = billed(w * h)
    }
    else if ('output_megapixels' in payload) megapixels = bflMp(payload.output_megapixels, KLEIN_MP)
    // Flux 2 Dev: its own width × height (aspect_ratio "custom"), each a multiple of 32 up to 1440.
    else if (typeof payload.width === 'number' && typeof payload.height === 'number') {
      expect(payload.aspect_ratio).toBe('custom')
      for (const side of [payload.width, payload.height]) {
        expect(side % 32).toBe(0)
        expect(side).toBeGreaterThanOrEqual(256)
        expect(side).toBeLessThanOrEqual(1440)
      }
      // Never below the ComfyUI path's default size, 2 MP (Python sends no width × height; S1b fix round 1).
      megapixels = Math.max(billed(payload.width * payload.height), 2)
    }
    else megapixels = bflMp(payload.resolution, FLUX_2_RES)
  }
  return { images, tier, megapixels, webSearch: payload.enable_web_search === true }
}

describe('settings parity: the price reads what the builder sends', () => {
  const builders: [string, (a: any) => Record<string, unknown>, boolean][] = [
    ...Object.values(RUNNER_IMAGE_MODELS).map(d => [d.id, d.build, !!d.refsApp] as [string, (a: any) => Record<string, unknown>, boolean]),
    ...Object.values(RUNNER_REPLICATE_IMAGE_MODELS).map(d => [d.id, d.build, false] as [string, (a: any) => Record<string, unknown>, boolean]),
  ]

  it('covers every runner builder (control)', () => {
    expect(builders.map(b => b[0]).sort()).toEqual([...RUNNER_IMAGE_MODEL_IDS, ...RUNNER_REPLICATE_IMAGE_MODEL_IDS].sort())
  })

  const RATIOS: unknown[] = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '5:4', '4:5', '16:10', '10:16', '21:9', '9:21', '2:1', '1:2', '3:1', '2.35:1', '', undefined]
  // Every value a priced field can carry, good and bad, as text and otherwise.
  const OPTION_SETS: Record<string, unknown>[] = [
    {},
    ...['0.5K', '1K', '2K', '4K', '8K', '1k', '', null, 2].map(resolution => ({ resolution })),
    ...['0.5 MP', '1 MP', '2 MP', '4 MP', '3 MP', '1'].map(resolution => ({ resolution })),
    ...['0.25', '0.5', '1', '2', '4', '8', 1].map(output_megapixels => ({ output_megapixels })),
    ...['low', 'medium', 'high', 'auto', 'High', 'ultra', ''].map(quality => ({ quality })),
    ...[1, 2, 4, 9, 0, -1, '3', 'three', true].map(num_outputs => ({ num_outputs })),
    ...[1, 3, 6, 9, '4', 0].map(max_images => ({ max_images, sequential_image_generation: 'auto' })),
    { max_images: 5, sequential_image_generation: 'disabled' },
    { max_images: 5 },
    ...[true, false, 'true', 'false', 1, 0, 'yes'].map(google_search => ({ google_search })),
    { resolution: '4K', google_search: true },
    { resolution: '4 MP', num_outputs: 4 },
    { quality: 'high', size: '4K', megapixels: '0.25' },
    { size: '4K' },
    { megapixels: 1 },
  ]

  for (const [id, build, takesRefs] of builders) {
    it(`${id}: every ratio × every priced setting`, () => {
      let cases = 0
      const drift: string[] = []
      for (const ar of RATIOS) {
        for (const adv of OPTION_SETS) {
          const modelOptions = JSON.stringify(adv)
          // As the runner's executor calls it.
          const args = { prompt: 'p', aspectRatio: asText(ar) || '1:1', seed: 0, adv: parseJsonObject(modelOptions), refs: null }
          const want = sentSettings(id, build(args))
          const got = effectiveImageSettings(id, ar, modelOptions)
          // Seedream 5 Lite is priced at its Python Replicate fallover's count (up to 15), never below fal's.
          if (id === 'seedream-5-lite') {
            expect(got!.images).toBeGreaterThanOrEqual(want.images)
            want.images = seedreamLiteFalloverCount(args.adv)
          }
          cases++
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            drift.push(`${JSON.stringify({ ar, adv })}: sent ${JSON.stringify(want)}, priced ${JSON.stringify(got)}`)
          }
          if (takesRefs) {
            // With moodboard pictures the edit endpoint gets the same size and
            // count; it gets no web search, which the price still counts (never under).
            const withRefs = sentSettings(id, build({ ...args, refs: ['https://x/a.png', 'https://x/b.png', 'https://x/c.png'] }))
            if (id === 'seedream-5-lite') withRefs.images = want.images
            const { webSearch, ...rest } = withRefs
            const { webSearch: pricedSearch, ...gotRest } = got!
            if (JSON.stringify(gotRest) !== JSON.stringify(rest) || (webSearch && !pricedSearch)) {
              drift.push(`refs ${JSON.stringify({ ar, adv })}: sent ${JSON.stringify(withRefs)}, priced ${JSON.stringify(got)}`)
            }
          }
        }
      }
      expect(drift.slice(0, 5)).toEqual([])
      expect(cases).toBeGreaterThan(500)
    })
  }

  it('no builder asks for more pictures than the price\'s maximum', () => {
    for (const [id, build] of builders) {
      for (const adv of OPTION_SETS) {
        const n = sentSettings(id, build({ prompt: 'p', aspectRatio: '1:1', seed: 0, adv, refs: null })).images
        expect(n, `${id} ${JSON.stringify(adv)}`).toBeLessThanOrEqual(maxImageCount(id))
      }
    }
  })

  // Every fal-first model has a Replicate builder in Python that the ComfyUI
  // path falls over to. Its limits must be inside what the price covers.
  it('the price covers each fal-first model\'s Python Replicate fallover too (counts, tiers)', () => {
    const falFirst = pythonFalPrimaries()
    expect(falFirst.length).toBeGreaterThanOrEqual(12)
    for (const id of falFirst) {
      if (!imageRate(id)) continue // unpriced (seedream-5-pro): refused on both paths
      const body = pyReplicateBody(id)
      for (const field of ['max_images', 'num_outputs', 'num_images']) {
        const cap = pyCountCap(body, field)
        if (cap == null) continue
        expect(maxImageCount(id), `${id} ${field}`).toBeGreaterThanOrEqual(cap)
        // …and a request at that cap is priced for all of it.
        const adv = { [field]: cap, sequential_image_generation: 'auto' }
        expect(effectiveImageSettings(id, '1:1', adv)!.images, `${id} ${field}`).toBe(cap)
      }
    }
    expect(SEEDREAM_LITE_PY_MAX).toBe(15)
    expect(maxImageCount('seedream-5-lite')).toBe(15)
    expect(providerUsd('GenerateImageNode', { model: 'seedream-5-lite', model_options: '{"sequential_image_generation":"auto","max_images":15}' }))
      .toBeCloseTo(0.035 * 15, 9)
    // Tiered models: every tier Replicate bills (saved model pages, 24 Sep) is covered by the fal card.
    const REPLICATE_TIERS: Record<string, Record<string, number>> = {
      'nano-banana-2': { '1K': 0.067, '2K': 0.101, '4K': 0.151 },
      'nano-banana-pro': { '1K': 0.15, '2K': 0.15, '4K': 0.30 },
    }
    for (const [id, tiers] of Object.entries(REPLICATE_TIERS)) {
      expect(pyReplicateBody(id), id).toContain('"resolution": _opt_str(adv, "resolution"')
      for (const [tier, usd] of Object.entries(tiers)) {
        expect(providerUsd('GenerateImageNode', { model: id, model_options: JSON.stringify({ resolution: tier }) })!, `${id} ${tier}`)
          .toBeGreaterThanOrEqual(usd)
      }
    }
    // Flat per-picture fallovers on Replicate cost no more than fal's card.
    expect(providerUsd('GenerateImageNode', { model: 'flux-1.1-pro', aspect_ratio: '16:9' })).toBeGreaterThanOrEqual(0.04)
  })

  // The models the runner does not build: their Python builders send nothing
  // the service prices by (no size, quality, count or style pictures).
  it('the ComfyUI-only models send one picture and no priced setting (Python builders)', () => {
    const body = (name: string) => {
      const i = PY.indexOf(`def ${name}(`)
      expect(i, name).toBeGreaterThan(0)
      const rest = PY.slice(i + 4)
      return rest.slice(0, rest.search(/\ndef |\n# -{3,}/))
    }
    const builderOf: Record<string, string> = {
      'recraft-v4-pro-svg': '_b_recraft_v4',
      'recraft-v4-svg': '_b_recraft_v4',
      'recraft-v3-svg': '_b_recraft_v3_svg',
      'krea-2-large': '_fal_krea2',
      'krea-2-medium': '_fal_krea2',
    }
    for (const [id, fn] of Object.entries(builderOf)) {
      expect(PY, id).toMatch(new RegExp(`ImageModel\\("${id}"[^\\n]*${fn === '_fal_krea2' ? '_b_krea2' : fn}`))
      const b = body(fn)
      expect(b, fn).toContain('"prompt": prompt')
      for (const field of ['num_outputs', 'num_images', 'resolution', 'quality', '"size"', 'megapixels', 'image_style_references', 'refs']) {
        expect(b.replace('refs: list[str] | None = None', ''), `${fn} sends ${field}`).not.toContain(field)
      }
      for (const ar of ['1:1', '16:9', undefined]) {
        expect(effectiveImageSettings(id, ar, '{"resolution":"4K","quality":"high","num_outputs":4}'))
          .toEqual({ images: 1, tier: null, megapixels: null, webSearch: false })
      }
    }
  })

  it('model_options may arrive as JSON text or as the parsed object', () => {
    expect(effectiveImageSettings('nano-banana-2', '1:1', { resolution: '4K', google_search: true }))
      .toEqual(effectiveImageSettings('nano-banana-2', '1:1', '{"resolution":"4K","google_search":true}'))
  })
})

// ── Worked examples ─────────────────────────────────────────────────────────
describe('worked examples', () => {
  const examples: { name: string, inputs: Record<string, unknown>, usd: number, credits: number }[] = [
    // Replicate: $0.015 per run + $0.015 per output megapixel, megapixels
    // rounded up (controller ruling). "1 MP" at 1:1 is 1024 × 1024 =
    // 1,048,576 pixels → 2 MP: 0.015 + 0.015 × 2.
    { name: 'Flux 2 Pro at 1 MP', inputs: { model: 'flux-2-pro', aspect_ratio: '1:1', model_options: '{"resolution":"1 MP"}' }, usd: 0.045, credits: 9 },
    // "4 MP" is capped at 2048 × 2048 = 4,194,304 pixels → 5 MP: 0.015 + 0.015 × 5.
    { name: 'Flux 2 Pro at 4 MP', inputs: { model: 'flux-2-pro', aspect_ratio: '1:1', model_options: '{"resolution":"4 MP"}' }, usd: 0.09, credits: 18 },
    // 21:9 isn't a Flux 2 ratio, so it is sent as 1:1: "1 MP" is still 2 MP.
    { name: 'Flux 2 Pro at 21:9, "1 MP"', inputs: { model: 'flux-2-pro', aspect_ratio: '21:9', model_options: '{"resolution":"1 MP"}' }, usd: 0.045, credits: 9 },
    // fal $0.04 per megapixel, rounded up, 1 MP floor: 1:1 is square_hd,
    // 1024 × 1024 → 2 MP; 16:9 is 1024 × 576 = 589,824 pixels → 1 MP.
    { name: 'Flux 1.1 Pro at 1:1 (2 MP)', inputs: { model: 'flux-1.1-pro', aspect_ratio: '1:1' }, usd: 0.08, credits: 16 },
    { name: 'Flux 1.1 Pro at 16:9 (1 MP)', inputs: { model: 'flux-1.1-pro', aspect_ratio: '16:9' }, usd: 0.04, credits: 8 },
    // Replicate, by quality.
    { name: 'GPT Image 2, low', inputs: { model: 'gpt-image-2', model_options: '{"quality":"low"}' }, usd: 0.012, credits: 3 },
    { name: 'GPT Image 2, medium', inputs: { model: 'gpt-image-2', model_options: '{"quality":"medium"}' }, usd: 0.047, credits: 10 },
    { name: 'GPT Image 2, high', inputs: { model: 'gpt-image-2', model_options: '{"quality":"high"}' }, usd: 0.128, credits: 20 },
    // "auto" is billed as the top tier it may pick.
    { name: 'GPT Image 2, auto', inputs: { model: 'gpt-image-2', model_options: '{"quality":"auto"}' }, usd: 0.128, credits: 20 },
    // fal, by resolution: $0.15, 4K at double.
    { name: 'Nano Banana Pro at 1K', inputs: { model: 'nano-banana-pro', model_options: '{"resolution":"1K"}' }, usd: 0.15, credits: 23 },
    { name: 'Nano Banana Pro at 2K', inputs: { model: 'nano-banana-pro', model_options: '{"resolution":"2K"}' }, usd: 0.15, credits: 23 },
    { name: 'Nano Banana Pro at 4K', inputs: { model: 'nano-banana-pro', model_options: '{"resolution":"4K"}' }, usd: 0.30, credits: 45 },
  ]

  for (const ex of examples) {
    it(`${ex.name}: $${ex.usd}, ${ex.credits} credits; badge = charge = run estimate`, () => {
      expect(providerUsd('GenerateImageNode', ex.inputs)).toBeCloseTo(ex.usd, 9)
      expect(nodeCredits('GenerateImageNode', ex.inputs)).toBe(creditsForUsd(ex.usd))
      expect(nodeCredits('GenerateImageNode', ex.inputs)).toBe(ex.credits)
      const c = charge(ex.inputs)
      expect(c).toBe(ex.credits + 1) // + base render
      expect(nodeCreditEstimate('GenerateImageNode', ex.inputs)).toBe(c)
      const names = Object.keys(ex.inputs)
      const est = estimateUsdForNodes([{
        id: '1', type: 'GenerateImageNode', widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => ex.inputs[n]),
      }], { hosted: true })!
      expect(est.hostedCredits).toBe(c)
    })
  }

  it('the defaults: GPT Image 2 is "auto", Nano Banana Pro is 2K, Flux 2 Pro is 1 MP', () => {
    expect(providerUsd('GenerateImageNode', { model: 'gpt-image-2' })).toBeCloseTo(0.128, 9)
    expect(providerUsd('GenerateImageNode', { model: 'nano-banana-pro' })).toBeCloseTo(0.15, 9)
    expect(providerUsd('GenerateImageNode', { model: 'flux-2-pro' })).toBeCloseTo(0.045, 9)
  })

  it('megapixels round up: 1:1 = 2 MP, 16:9 = 1 MP, 21:9 "1 MP" = 2 MP', () => {
    expect(effectiveImageSettings('flux-1.1-pro', '1:1', '{}')!.megapixels).toBe(2)
    expect(effectiveImageSettings('flux-schnell', '16:9', '{}')!.megapixels).toBe(1)
    expect(effectiveImageSettings('flux-2-pro', '21:9', '{"resolution":"1 MP"}')!.megapixels).toBe(2)
    // Klein takes 21:9 itself; the label still bills 2 MP.
    expect(effectiveImageSettings('flux-2-klein-4b', '21:9', '{"output_megapixels":"1"}')!.megapixels).toBe(2)
    expect(effectiveImageSettings('flux-2-klein-4b', '1:1', '{"output_megapixels":"0.25"}')!.megapixels).toBe(1)
    // Flux 2 Dev: never below the ComfyUI path's default size, 2 MP.
    expect(effectiveImageSettings('flux-2-dev', '1:1', '{"resolution":"0.5 MP"}')!.megapixels).toBe(2)
    expect(effectiveImageSettings('flux-2-dev', '1:1', '{"resolution":"2 MP"}')!.megapixels).toBe(3)
    expect(effectiveImageSettings('flux-2-max', '1:1', '{"resolution":"4 MP"}')!.megapixels).toBe(5)
    expect(providerUsd('GenerateImageNode', { model: 'flux-schnell', aspect_ratio: '1:1' })).toBeCloseTo(0.006, 9)
  })

  it('size, quality, count and web search each move the price', () => {
    expect(providerUsd('GenerateImageNode', { model: 'nano-banana-2' })).toBeCloseTo(0.08, 9)
    expect(providerUsd('GenerateImageNode', { model: 'nano-banana-2', model_options: '{"resolution":"0.5K"}' })).toBeCloseTo(0.06, 9)
    expect(providerUsd('GenerateImageNode', { model: 'nano-banana-2', model_options: '{"resolution":"2K"}' })).toBeCloseTo(0.12, 9)
    expect(providerUsd('GenerateImageNode', { model: 'nano-banana-2', model_options: '{"resolution":"4K","google_search":true}' })).toBeCloseTo(0.175, 9)
    expect(providerUsd('GenerateImageNode', { model: 'flux-dev', model_options: '{"num_outputs":4}' })).toBeCloseTo(0.10, 9)
    expect(providerUsd('GenerateImageNode', { model: 'seedream-5-lite', model_options: '{"sequential_image_generation":"auto","max_images":6}' })).toBeCloseTo(0.21, 9)
    // "2 MP" is 2,097,152 pixels → 3 MP.
    expect(providerUsd('GenerateImageNode', { model: 'flux-2-max', model_options: '{"resolution":"2 MP"}' })).toBeCloseTo(0.04 + 0.03 * 3, 9)
    // fal per megapixel: 16:9 is 1024 × 576 → 1 MP; 1:1 is 1024 × 1024 → 2 MP.
    expect(providerUsd('GenerateImageNode', { model: 'flux-1.1-pro', aspect_ratio: '16:9' })).toBeCloseTo(0.04, 9)
    expect(providerUsd('GenerateImageNode', { model: 'flux-1.1-pro', aspect_ratio: '1:1' })).toBeCloseTo(0.08, 9)
  })

  it('a quality or size outside the model\'s schema is sent, and priced, as the default (Task S1b)', () => {
    // GPT Image: "auto", billed as the top tier it may pick.
    expect(providerUsd('GenerateImageNode', { model: 'gpt-image-2', model_options: '{"quality":"High"}' })).toBeCloseTo(0.128, 9)
    expect(providerUsd('GenerateImageNode', { model: 'gpt-image-1.5', model_options: '{"quality":"ultra"}' })).toBeCloseTo(0.136, 9)
    // Flux 2 Pro: "1 MP" (2 billed MP), $0.015 + 2 × $0.015.
    expect(providerUsd('GenerateImageNode', { model: 'flux-2-pro', model_options: '{"resolution":"3 MP"}' })).toBeCloseTo(0.045, 9)
  })

  it('Flux 2 Dev is priced on the width × height it sends, at most 1440 × 1440', () => {
    // 1:1 "1 MP" is 1024 × 1024 (2 MP); 16:9 is 1376 × 768 (2 MP); "4 MP" is capped at 1440 × 1440 (3 MP).
    expect(effectiveImageSettings('flux-2-dev', '16:9', '{"resolution":"1 MP"}')!.megapixels).toBe(2)
    expect(effectiveImageSettings('flux-2-dev', '1:1', '{"resolution":"4 MP"}')!.megapixels).toBe(3)
    expect(providerUsd('GenerateImageNode', { model: 'flux-2-dev', model_options: '{"resolution":"4 MP"}' })).toBeCloseTo(0.012 * 3, 9)
    // Linked options: the largest picture it can send.
    expect(providerUsd('GenerateImageNode', { model: 'flux-2-dev', model_options: ['9', 0] })).toBeCloseTo(0.012 * 3, 9)
  })

  it('Krea 2 is priced (fal text-to-image) and stays off the runner lists until its family lands', () => {
    expect(providerUsd('GenerateImageNode', { model: 'krea-2-large' })).toBeCloseTo(0.06, 9)
    expect(providerUsd('GenerateImageNode', { model: 'krea-2-medium' })).toBeCloseTo(0.03, 9)
    expect(charge({ model: 'krea-2-large' })).toBe(12 + 1)
    for (const id of ['krea-2-large', 'krea-2-medium']) {
      expect((RUNNER_IMAGE_MODEL_IDS as readonly string[]).includes(id), id).toBe(false)
      expect((RUNNER_REPLICATE_IMAGE_MODEL_IDS as readonly string[]).includes(id), id).toBe(false)
    }
  })
})

// The line-up page's "where we lose money" table (24 Sep 2026), image rows.
// "It costs" is the service's price; our charge must now be at or above it.
describe('the line-up page\'s loss table: no image row is below cost', () => {
  const rows: { what: string, inputs: Record<string, unknown>, costs: number }[] = [
    { what: 'Nano Banana Pro image, 4K', inputs: { model: 'nano-banana-pro', model_options: '{"resolution":"4K"}' }, costs: 0.30 },
    { what: 'GPT Image 2, "auto" (our default)', inputs: { model: 'gpt-image-2' }, costs: 0.128 },
    { what: 'Flux 2 Pro, our default, 1 MP', inputs: { model: 'flux-2-pro' }, costs: 0.03 },
    { what: 'Nano Banana 2 image, 1K on fal', inputs: { model: 'nano-banana-2', model_options: '{"resolution":"1K"}' }, costs: 0.08 },
    // The same rows at their dearest settings.
    { what: 'Nano Banana Pro, 2K', inputs: { model: 'nano-banana-pro', model_options: '{"resolution":"2K"}' }, costs: 0.15 },
    { what: 'Nano Banana 2, 4K with web search', inputs: { model: 'nano-banana-2', model_options: '{"resolution":"4K","google_search":true}' }, costs: 0.175 },
    { what: 'Flux 2 Pro, 4 MP', inputs: { model: 'flux-2-pro', model_options: '{"resolution":"4 MP"}' }, costs: 0.015 + 0.015 * 4 },
  ]
  for (const r of rows) {
    it(`${r.what}: charged at or above $${r.costs.toFixed(3)}`, () => {
      expect(providerUsd('GenerateImageNode', r.inputs)!).toBeGreaterThanOrEqual(r.costs - 1e-9)
      expect(nodeCredits('GenerateImageNode', r.inputs)! / 100).toBeGreaterThanOrEqual(r.costs)
    })
  }
})

// ── Badge = charge ──────────────────────────────────────────────────────────
describe('badge = charge = run estimate for every priced image model', () => {
  const SETTINGS: Record<string, unknown>[] = [
    {},
    { aspect_ratio: '16:9' },
    { aspect_ratio: '9:16', model_options: '{"resolution":"4K"}' },
    { model_options: '{"resolution":"4 MP","quality":"low","num_outputs":3}' },
    { model_options: '{"output_megapixels":"0.25","google_search":true}' },
    { model_options: '{"sequential_image_generation":"auto","max_images":4}' },
    // Linked: the API prompt carries a [nodeId, slot] reference.
    { aspect_ratio: ['9', 0] },
    { model_options: ['9', 0] },
  ]
  it('every model × setting', () => {
    const off: string[] = []
    let n = 0
    for (const id of Object.keys(IMAGE_RATES)) {
      for (const s of SETTINGS) {
        const inputs = { model: id, prompt: 'a picture', seed: 3, ...s }
        const c = charge(inputs)
        const badge = nodeCreditEstimate('GenerateImageNode', inputs)
        // The badge's own map, with linked widgets marked as the canvas marks them.
        const linked = Object.keys(s).filter(k => Array.isArray(s[k]))
        const unlinked = Object.keys(inputs).filter(k => !linked.includes(k))
        const fromWidgets = nodeCreditEstimate('GenerateImageNode', widgetValueMap(
          unlinked.map(name => ({ name })), unlinked.map(k => (inputs as Record<string, unknown>)[k]), linked))
        n++
        if (badge !== c || fromWidgets !== c) off.push(`${id} ${JSON.stringify(s)}: charge ${c}, badge ${badge}, widget badge ${fromWidgets}`)
      }
    }
    expect(off).toEqual([])
    expect(n).toBeGreaterThan(300)
  })

  it('linked model_options is priced at the card\'s most expensive request; a linked ratio at the largest picture', () => {
    expect(providerUsd('GenerateImageNode', { model: 'nano-banana-pro', model_options: ['9', 0] })).toBeCloseTo(0.30, 9)
    expect(providerUsd('GenerateImageNode', { model: 'flux-dev', model_options: ['9', 0] })).toBeCloseTo(0.025 * 4, 9)
    expect(providerUsd('GenerateImageNode', { model: 'flux-2-pro', model_options: ['9', 0] })).toBe(imageMaxUsd('flux-2-pro'))
    // The ratio changes only the fal per-megapixel models' size.
    expect(providerUsd('GenerateImageNode', { model: 'flux-1.1-pro', aspect_ratio: ['9', 0] })).toBeCloseTo(0.08, 9)
    expect(providerUsd('GenerateImageNode', { model: 'seedream-5-lite', aspect_ratio: ['9', 0] })).toBeCloseTo(0.035, 9)
    expect(providerUsd('GenerateImageNode', { model: 'flux-2-pro', aspect_ratio: ['9', 0], model_options: '{"resolution":"2 MP"}' }))
      .toBeCloseTo(0.015 + 0.015 * 3, 9)
    for (const id of Object.keys(IMAGE_RATES)) {
      expect(imageMaxUsd(id)!, id).toBeGreaterThanOrEqual(imageUsd(id, effectiveImageSettings(id, '1:1', {})!)!)
      // The price basis (a backup covered at cost, Task S3) too.
      expect(imagePriceMaxUsd(id)!, id).toBeGreaterThanOrEqual(providerUsd('GenerateImageNode', { model: id })!)
    }
  })

  it('no ratio prices a picture higher than the one a linked ratio is priced at', () => {
    const ratios = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '5:4', '4:5', '16:10', '10:16', '21:9', '9:21', '2:1', '1:2', '3:1', '']
    for (const id of Object.keys(IMAGE_RATES)) {
      const linked = providerUsd('GenerateImageNode', { model: id, aspect_ratio: ['9', 0] })!
      for (const ar of ratios) {
        expect(providerUsd('GenerateImageNode', { model: id, aspect_ratio: ar })!, `${id} ${ar}`).toBeLessThanOrEqual(linked)
      }
    }
  })
})

// ── The gallery label ───────────────────────────────────────────────────────
describe('the image gallery price label', () => {
  const label = (id: string, hosted = false) => imageRateLabel(id, IMAGE_MODELS_BY_ID[id]!.defaultAspectRatio, { hosted })
  it('shows the default setting\'s price, and "up to" the dearest when it varies', () => {
    expect(label('nano-banana-2')).toBe('$0.08, up to $0.175')
    expect(label('nano-banana-pro')).toBe('$0.15, up to $0.30')
    expect(label('flux-2-pro')).toBe('$0.045, up to $0.09')
    expect(label('gpt-image-2')).toBe('$0.128') // the default ("auto") is already the dearest
    expect(label('imagen-4')).toBe('$0.04')
    expect(label('krea-2-large')).toBe('$0.06')
    expect(label('flux-fast')).toBe('$0.005')
  })
  it('in hosted mode, in credits', () => {
    expect(label('nano-banana-2', true)).toBe('16 credits, up to 27')
    expect(label('nano-banana-pro', true)).toBe('23 credits, up to 45')
    expect(label('flux-fast', true)).toBe('1 credit')
  })
  it('every priced model has a label; the unpriced ones have none', () => {
    for (const m of IMAGE_MODELS) {
      expect(label(m.id) != null, m.id).toBe(!UNPRICED.includes(m.id))
      if (!UNPRICED.includes(m.id)) {
        expect(imageMaxPictureUsd(m.id)!, m.id).toBeGreaterThanOrEqual(imageDefaultUsd(m.id, m.defaultAspectRatio)!)
      }
    }
  })
  it('the gallery reads the rate card, not a price of its own', () => {
    const src = readFileSync(fileURLToPath(new URL('../../app/components/vue-canvas/ModelGalleryModal.vue', import.meta.url)), 'utf8')
    expect(src).toContain('imageRateLabel(')
    expect(src).not.toMatch(/priceLabel\([^)]*pricePerImage/)
  })
})

describe('imageUsd sanity', () => {
  it('prices the picture count and adds the web search once per request', () => {
    expect(imageUsd('nano-banana-2', { images: 2, tier: '1K', megapixels: null, webSearch: true })).toBeCloseTo(0.175, 9)
    expect(imageUsd('reve-create', { images: 1, tier: null, megapixels: null, webSearch: false })).toBeNull()
  })
})
