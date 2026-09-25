/**
 * S1b fix round 1, IMPORTANT 1: the ComfyUI (Python) path is still live, and
 * Python still sends some settings under names the providers' schemas don't
 * have (PixVerse `resolution`, Wan 2.7 `num_frames`, Flux 2 Dev's resolution
 * label…). The provider ignores those and renders its schema defaults. The
 * price follows the runner's request, so it must never fall below what the
 * Python request costs.
 *
 * Every Python fixture request (runner-families.json, from the Python oracle)
 * is read the way the provider reads it: a field its saved schema doesn't
 * define is ignored, a field not sent is the schema's default, and a request
 * the schema refuses outright costs nothing (the provider rejects it). The
 * price Sailor charges for the same node must be at or above that cost.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { providerUsd } from '#shared/pricing/nodePrice'
import { videoUsd } from '#shared/pricing/videoRates'
import { imageUsd } from '#shared/pricing/imageRates'
import { FLUX_2_DEV_PYTHON_PATH_MEGAPIXELS, billedMegapixels } from '#shared/pricing/imageSettings'
import { RUNNER_IMAGE_MODELS } from '~~/server/runner/generators/image'
import { RUNNER_VIDEO_MODELS, falVideoFn } from '~~/server/runner/generators/video'
import { checkPayload, loadProviderSchema, type ProviderSchemaFixture } from './helpers/providerSchema'

const FAMILIES = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/runner-families.json', import.meta.url)), 'utf8'))

type Schema = Record<string, any>
function inputSchema(f: ProviderSchemaFixture): Schema {
  let s = f.input as Schema
  while (s.$ref) s = f.components.schemas[String(s.$ref).split('/').pop()!] as Schema
  return s
}

/** What the provider renders from `payload`: unknown fields ignored, missing ones at their schema default; null if refused. */
function asRendered(provider: 'fal' | 'replicate', endpoint: string, payload: Record<string, unknown>): Record<string, unknown> | null {
  const f = loadProviderSchema(provider, endpoint)
  const props = (inputSchema(f).properties ?? {}) as Record<string, Schema>
  const known = Object.fromEntries(Object.entries(payload).filter(([k]) => k in props))
  if (checkPayload(f, known).length) return null
  const out: Record<string, unknown> = {}
  for (const [k, p] of Object.entries(props)) if (p.default !== undefined && p.default !== null) out[k] = p.default
  return { ...out, ...known }
}

const KLING_MODE: Record<string, string> = { standard: '720p', pro: '1080p', '4k': '4k' }
const SORA_RES: Record<string, string> = { standard: '720p', high: '1024p' }

/** The service's cost of a rendered Replicate video request, from the rate card (null: the card has no price). */
function videoCost(id: string, r: Record<string, unknown>): number | null {
  const seconds = Number(r.duration ?? r.seconds ?? 5)
  let resolution: string | null
  switch (id) {
    case 'pixverse-v6': resolution = String(r.quality); break
    case 'kling-v3': resolution = KLING_MODE[String(r.mode)]!; break
    case 'sora-2-pro': resolution = SORA_RES[String(r.resolution)]!; break
    case 'sora-2': case 'runway-gen-4.5': case 'kling-v2.5-turbo-pro': case 'ltx-video': resolution = null; break
    case 'luma-ray-2-720p': resolution = '720p'; break
    default: resolution = String(r.resolution).toLowerCase()
  }
  const audio = r.generate_audio_switch ?? r.generate_audio ?? id.startsWith('sora')
  return videoUsd(id, { seconds, resolution, audio: audio === true, inputVideoSeconds: 0 })
}

const BFL = (label: unknown) => billedMegapixels(Math.min(Number.parseFloat(String(label)) * 1024 * 1024, 2048 * 2048))

/**
 * The size Replicate's Flux 2 Dev makes when it is sent no width × height (the
 * ComfyUI path). Its own saved schema doesn't state it. Taken from the saved
 * schemas of its Flux 2 siblings, whose `resolution` default ("1 MP", one
 * label MP being 1024 × 1024) is the family's default size — an independent
 * reading, which the price's floor (FLUX_2_DEV_PYTHON_PATH_MEGAPIXELS) must cover.
 */
function flux2DevDefaultMegapixels(): number {
  const labels = ['flux-2-pro', 'flux-2-max', 'flux-2-flex'].map((m) => {
    const f = loadProviderSchema('replicate', `black-forest-labs/${m}`)
    const res = inputSchema(f).properties.resolution as Schema
    return String(res.default)
  })
  expect(new Set(labels)).toEqual(new Set(['1 MP']))
  return BFL(labels[0])
}

/** The service's cost of a rendered Replicate image request, from the rate card (null: the card has no price). */
function imageCost(id: string, r: Record<string, unknown>): number | null {
  const counts = ['num_outputs', 'number_of_images', 'max_images'].map(k => r[k]).filter((v): v is number => typeof v === 'number')
  const images = counts.length ? Math.max(...counts) : 1
  let megapixels: number | null = null
  let tier: string | null = null
  if (id === 'flux-2-dev') megapixels = flux2DevDefaultMegapixels()
  else if (id.startsWith('flux-2-klein')) megapixels = BFL(r.output_megapixels)
  else if (id.startsWith('flux-2-')) megapixels = BFL(r.resolution)
  if (id.startsWith('gpt-image')) tier = String(r.quality)
  return imageUsd(id, { images, tier, megapixels, webSearch: false })
}

describe('the price never falls below what the Python path\'s request costs', () => {
  it('Replicate video: every Python fixture request', () => {
    let priced = 0
    for (const c of (FAMILIES.replicateVideo as any[]).filter(c => !c.error)) {
      const r = asRendered('replicate', c.slug, c.payload)
      if (!r) continue // the provider refuses Python's request: it costs nothing
      const inputs: Record<string, unknown> = {
        model: c.model, prompt: c.args.prompt, aspect_ratio: c.args.ar, duration: String(c.args.dur),
        seed: c.args.seed, model_options: JSON.stringify(c.args.adv),
      }
      if (c.args.image) inputs.image = ['src', 0]
      const cost = videoCost(c.model, r)
      expect(cost, c.model).not.toBeNull()
      expect(providerUsd('GenerateVideoNode', inputs)!, `${c.model} ${JSON.stringify(c.args)} renders ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(cost! - 1e-9)
      priced++
    }
    expect(priced).toBeGreaterThan(300)
  })

  it('Replicate image: every Python fixture request', () => {
    let priced = 0
    for (const c of FAMILIES.replicateImage as any[]) {
      const r = asRendered('replicate', c.call.endpoint, c.call.payload)
      if (!r) continue
      const cost = imageCost(String(c.widgets.model), r)
      expect(cost, String(c.widgets.model)).not.toBeNull()
      expect(providerUsd('GenerateImageNode', c.widgets)!, `${JSON.stringify(c.widgets)} renders ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(cost! - 1e-9)
      priced++
    }
    expect(priced).toBeGreaterThan(1000)
  })

  it('the three models whose Python request renders defaults are covered: PixVerse at 540p silent, Wan 2.7 at 5 s, Flux 2 Dev at its default size', () => {
    const cases = (FAMILIES.replicateVideo as any[]).filter(c => !c.error)
    const pix = cases.find(c => c.model === 'pixverse-v6' && asRendered('replicate', c.slug, c.payload))
    expect(asRendered('replicate', pix.slug, pix.payload)).toMatchObject({ quality: '540p', generate_audio_switch: false })
    // A PixVerse node set to 360p is still priced at the 540p Python renders.
    expect(providerUsd('GenerateVideoNode', { model: 'pixverse-v6', duration: '5', model_options: '{"resolution":"360p","generate_audio":false}' })).toBeCloseTo(0.07 * 5, 9)
    const wan = cases.find(c => c.model === 'wan-2.7-t2v' && asRendered('replicate', c.slug, c.payload))
    expect(asRendered('replicate', wan.slug, wan.payload)).toMatchObject({ duration: 5 })
    // A Wan 2.7 node set to 2 s is still priced at the 5 s Python renders.
    expect(providerUsd('GenerateVideoNode', { model: 'wan-2.7-t2v', duration: '2' })).toBeCloseTo(0.10 * 5, 9)
    // A Flux 2 Dev "0.5 MP" picture is still priced at the default size, read from its siblings' schemas.
    expect(flux2DevDefaultMegapixels()).toBe(2)
    expect(FLUX_2_DEV_PYTHON_PATH_MEGAPIXELS).toBeGreaterThanOrEqual(flux2DevDefaultMegapixels())
    expect(providerUsd('GenerateImageNode', { model: 'flux-2-dev', model_options: '{"resolution":"0.5 MP"}' })).toBeCloseTo(0.012 * flux2DevDefaultMegapixels(), 9)
  })
})

// ── Every field a Python request sends that the provider's schema lacks ──
//
// The provider ignores such a field and renders its default. Each one is
// listed here with what it means for the price: either the service doesn't
// price on it, or the price covers the default it falls back to (the tests
// above). A NEW such field fails until it is listed — and it may only be
// listed once its price effect is known.

const PYTHON_FIELDS_THE_SCHEMA_LACKS: Readonly<Record<string, string>> = {
  'fal blackforestlabs/flux-3/image-to-video | seed': 'not priced',
  'replicate black-forest-labs/flux-2-dev | guidance': 'not priced',
  'replicate black-forest-labs/flux-2-dev | prompt_upsampling': 'not priced',
  'replicate black-forest-labs/flux-2-dev | resolution': 'priced: the default size, floored (FLUX_2_DEV_PYTHON_PATH_MEGAPIXELS)',
  'replicate black-forest-labs/flux-2-dev | safety_tolerance': 'not priced',
  'replicate black-forest-labs/flux-2-dev | steps': 'not priced (billed per output megapixel)',
  'replicate bytedance/seedance-2.0-fast | camera_fixed': 'not priced',
  'replicate bytedance/seedream-4.5 | seed': 'not priced',
  'replicate bytedance/seedream-5-lite | seed': 'not priced',
  'replicate bytedance/seedream-5-pro | seed': 'not priced',
  'replicate google/imagen-3 | seed': 'not priced',
  'replicate google/imagen-3-fast | seed': 'not priced',
  'replicate google/imagen-4 | seed': 'not priced',
  'replicate google/imagen-4-fast | seed': 'not priced',
  'replicate google/imagen-4-ultra | seed': 'not priced',
  'replicate kwaivgi/kling-v3-video | cfg_scale': 'not priced',
  'replicate kwaivgi/kling-v3-video | seed': 'not priced',
  'replicate lightricks/ltx-video | guidance_scale': 'not priced',
  'replicate lightricks/ltx-video | num_inference_steps': 'priced: the flat 50-step ceiling covers the 30-step default',
  'replicate luma/ray-2-720p | seed': 'not priced',
  'replicate minimax/hailuo-2.3 | aspect_ratio': 'not priced',
  'replicate minimax/hailuo-2.3 | seed': 'not priced',
  'replicate minimax/image-01 | seed': 'not priced',
  'replicate openai/gpt-image-1.5 | seed': 'not priced',
  'replicate openai/gpt-image-2 | seed': 'not priced',
  'replicate openai/sora-2 | duration': 'priced: the default 4 s is the shortest length priced',
  'replicate openai/sora-2 | seed': 'not priced',
  'replicate openai/sora-2-pro | duration': 'priced: the default 4 s is the shortest length priced',
  'replicate openai/sora-2-pro | seed': 'not priced',
  'replicate pixverse/pixverse-v6 | generate_audio': 'priced: the default (silent) is never dearer than the sound sent',
  'replicate pixverse/pixverse-v6 | resolution': 'priced: floored at the default 540p',
  'replicate pixverse/pixverse-v6 | style': 'not priced',
  'replicate recraft-ai/recraft-v3 | seed': 'not priced',
  'replicate recraft-ai/recraft-v4 | seed': 'not priced',
  'replicate recraft-ai/recraft-v4-pro | seed': 'not priced',
  'replicate runwayml/gen-4.5 | motion': 'not priced',
  'replicate wan-video/wan-2.5-i2v-fast | aspect_ratio': 'not priced',
  'replicate wan-video/wan-2.7-t2v | num_frames': 'priced: floored at the default 5 s',
  'replicate xai/grok-imagine-image | seed': 'not priced',
}

describe('fields Python sends that the schema lacks, across every family', () => {
  it('are exactly the listed ones, each with its price effect known', () => {
    const BUILDERS = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/runner-builders.json', import.meta.url)), 'utf8'))
    const found = new Set<string>()
    let requests = 0
    const scan = (provider: 'fal' | 'replicate', endpoint: string, payload: Record<string, unknown>) => {
      requests++
      for (const m of checkPayload(loadProviderSchema(provider, endpoint), payload)) {
        if (m.endsWith('not in the schema')) found.add(`${provider} ${endpoint} | ${m.slice(0, m.indexOf(':'))}`)
      }
    }
    for (const key of ['falEdit', 'refEdits', 'restyle', 'nanoActions', 'replicateImage'] as const) {
      for (const c of FAMILIES[key] as any[]) if (c.call?.endpoint) scan(c.call.provider, c.call.endpoint, c.call.payload)
    }
    for (const c of FAMILIES.replicateVideo as any[]) if (c.payload) scan('replicate', c.slug, c.payload)
    for (const c of BUILDERS.image as any[]) scan('fal', RUNNER_IMAGE_MODELS[c.model]!.app, c.payload)
    for (const c of BUILDERS.video as any[]) {
      const d = RUNNER_VIDEO_MODELS[c.model]!
      const fn = falVideoFn(c.payload, d.fnByMode)
      scan('fal', fn ? `${d.app}/${fn}` : d.app, c.payload)
    }
    expect(requests).toBeGreaterThan(3500)
    expect([...found].sort()).toEqual(Object.keys(PYTHON_FIELDS_THE_SCHEMA_LACKS).sort())
    for (const [k, v] of Object.entries(PYTHON_FIELDS_THE_SCHEMA_LACKS)) expect(v, k).toMatch(/^(not priced|priced: )/)
  })
})
