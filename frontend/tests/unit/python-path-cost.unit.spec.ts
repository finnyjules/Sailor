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

/** The service's cost of a rendered Replicate video request, from the rate card. */
function videoCost(id: string, r: Record<string, unknown>): number {
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
  return videoUsd(id, { seconds, resolution, audio: audio === true, inputVideoSeconds: 0 })!
}

const BFL = (label: unknown) => billedMegapixels(Math.min(Number.parseFloat(String(label)) * 1024 * 1024, 2048 * 2048))

/** The service's cost of a rendered Replicate image request, from the rate card. */
function imageCost(id: string, r: Record<string, unknown>): number {
  const counts = ['num_outputs', 'number_of_images', 'max_images'].map(k => r[k]).filter((v): v is number => typeof v === 'number')
  const images = counts.length ? Math.max(...counts) : 1
  let megapixels: number | null = null
  let tier: string | null = null
  if (id === 'flux-2-dev') megapixels = FLUX_2_DEV_PYTHON_PATH_MEGAPIXELS
  else if (id.startsWith('flux-2-klein')) megapixels = BFL(r.output_megapixels)
  else if (id.startsWith('flux-2-')) megapixels = BFL(r.resolution)
  if (id.startsWith('gpt-image')) tier = String(r.quality)
  return imageUsd(id, { images, tier, megapixels, webSearch: false })!
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
      expect(providerUsd('GenerateVideoNode', inputs)!, `${c.model} ${JSON.stringify(c.args)} renders ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(cost - 1e-9)
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
      expect(providerUsd('GenerateImageNode', c.widgets)!, `${JSON.stringify(c.widgets)} renders ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(cost - 1e-9)
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
    // A Flux 2 Dev "0.5 MP" picture is still priced at the 2 MP default size.
    expect(providerUsd('GenerateImageNode', { model: 'flux-2-dev', model_options: '{"resolution":"0.5 MP"}' })).toBeCloseTo(0.012 * 2, 9)
  })
})
