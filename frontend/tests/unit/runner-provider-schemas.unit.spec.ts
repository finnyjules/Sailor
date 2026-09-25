/**
 * Every request the runner's builders make today, checked against the
 * provider's own saved schema (Task S1: fixtures/provider-schemas/, written by
 * scripts/snapshot_provider_schemas.mjs). The payloads are the ones the
 * existing builder tests produce: the Python-parity fixtures
 * (runner-builders.json, runner-families.json) run through the same
 * builders and planNode those tests use.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { planNode } from '~~/server/runner/executors'
import { RUNNER_IMAGE_MODELS, RUNNER_REPLICATE_IMAGE_MODELS, imageAppFor } from '~~/server/runner/generators/image'
import { RUNNER_REPLICATE_VIDEO_MODELS, RUNNER_VIDEO_MODELS, falVideoFn } from '~~/server/runner/generators/video'
import { FLUX_2_EDIT_APP, FLUX_KONTEXT_APP, NANO_BANANA_2_EDIT_APP, NANO_BANANA_PRO_EDIT_APP } from '~~/server/runner/generators/edit'
import { NANO_BANANA_2_SLUG, NANO_BANANA_SLUG } from '~~/server/runner/generators/actions'
import { IMAGE_EDIT_MODELS, PRODUCT_SHOT_SLUG, imageEditCall } from '~~/server/runner/generators/refEdits'
import { RESTYLE_NANO_BANANA_SLUGS, STYLE_TRANSFER_SLUG } from '~~/server/runner/generators/restyle'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'

const readJson = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'))
const BUILDERS = readJson('./fixtures/runner-builders.json')
const FAMILIES = readJson('./fixtures/runner-families.json')

type Provider = 'fal' | 'replicate'

/** The saved schema for `endpoint`, whose id must be the endpoint itself (fal's x-fal-metadata.endpointId, checked when saved). */
function schemaFor(provider: Provider, endpoint: string) {
  const f = loadProviderSchema(provider, endpoint)
  expect(f.endpoint).toBe(endpoint)
  return f
}

// ── Known gaps: requests the runner makes today that the provider's own schema refuses ──
//
// Each entry is `<provider> <endpoint> | <field> | <kind>`. A gap listed here
// is tolerated (and must still happen: the last test fails once it is fixed,
// so the entry is removed); anything not listed fails its test. These are
// findings for the builders' owners, not accepted behaviour. See the S1 report.

/** Hit by ordinary settings: the defaults, a seed, an empty prompt, a menu value. */
const GAPS_ON_ORDINARY_SETTINGS: readonly string[] = [
  'fal blackforestlabs/flux-3/image-to-video | seed | unknown key',
  'fal fal-ai/flux-pro/v1.1 | output_format | enum',
  'fal fal-ai/flux/schnell | output_format | enum',
  'fal fal-ai/nano-banana-2 | prompt | minLength',
  'fal fal-ai/nano-banana-2/edit | prompt | minLength',
  'fal fal-ai/nano-banana-pro/edit | prompt | minLength',
  'fal google/nano-banana-pro | prompt | minLength',
  'replicate black-forest-labs/flux-2-dev | guidance | unknown key',
  'replicate black-forest-labs/flux-2-dev | prompt_upsampling | unknown key',
  'replicate black-forest-labs/flux-2-dev | resolution | unknown key',
  'replicate black-forest-labs/flux-2-dev | safety_tolerance | unknown key',
  'replicate black-forest-labs/flux-2-dev | steps | unknown key',
  'replicate bytedance/seedance-2.0-fast | camera_fixed | unknown key',
  'replicate bytedance/seedance-2.0-fast | resolution | enum',
  'replicate bytedance/seedream-4.5 | seed | unknown key',
  'replicate bytedance/seedream-5-lite | seed | unknown key',
  'replicate bytedance/seedream-5-pro | seed | unknown key',
  'replicate google/imagen-3 | seed | unknown key',
  'replicate google/imagen-3-fast | seed | unknown key',
  'replicate google/imagen-4 | seed | unknown key',
  'replicate google/imagen-4-fast | seed | unknown key',
  'replicate google/imagen-4-ultra | seed | unknown key',
  'replicate ideogram-ai/ideogram-v2 | seed | range',
  'replicate ideogram-ai/ideogram-v2a-turbo | seed | range',
  'replicate kwaivgi/kling-v3-video | cfg_scale | unknown key',
  'replicate kwaivgi/kling-v3-video | seed | unknown key',
  'replicate lightricks/ltx-video | guidance_scale | unknown key',
  'replicate lightricks/ltx-video | num_inference_steps | unknown key',
  'replicate luma/ray-2-720p | seed | unknown key',
  'replicate minimax/hailuo-2.3 | aspect_ratio | unknown key',
  'replicate minimax/hailuo-2.3 | seed | unknown key',
  'replicate minimax/image-01 | seed | unknown key',
  'replicate openai/gpt-image-1.5 | seed | unknown key',
  'replicate openai/gpt-image-2 | seed | unknown key',
  'replicate openai/sora-2 | aspect_ratio | enum',
  'replicate openai/sora-2 | duration | unknown key',
  'replicate openai/sora-2 | seed | unknown key',
  'replicate openai/sora-2-pro | aspect_ratio | enum',
  'replicate openai/sora-2-pro | duration | unknown key',
  'replicate openai/sora-2-pro | seed | unknown key',
  'replicate pixverse/pixverse-v6 | generate_audio | unknown key',
  'replicate pixverse/pixverse-v6 | resolution | unknown key',
  'replicate pixverse/pixverse-v6 | style | unknown key',
  'replicate prunaai/flux-fast | speed_mode | enum',
  'replicate recraft-ai/recraft-v3 | seed | unknown key',
  'replicate recraft-ai/recraft-v4 | seed | unknown key',
  'replicate recraft-ai/recraft-v4-pro | seed | unknown key',
  'replicate runwayml/gen-4.5 | motion | unknown key',
  'replicate wan-video/wan-2.5-i2v-fast | aspect_ratio | unknown key',
  'replicate wan-video/wan-2.5-i2v-fast | resolution | enum',
  'replicate wan-video/wan-2.7-t2v | num_frames | unknown key',
  'replicate xai/grok-imagine-image | seed | unknown key',
]

/**
 * Hit only by the parity fixtures' out-of-range model options ("True", "",
 * "0.25", 99, -2…), which the builders pass through unchecked, as Python does.
 */
const GAPS_FROM_UNCHECKED_OPTIONS: readonly string[] = [
  'replicate black-forest-labs/flux-1.1-pro-ultra | output_format | enum',
  'replicate black-forest-labs/flux-1.1-pro-ultra | safety_tolerance | range',
  'replicate black-forest-labs/flux-2-dev | output_format | enum',
  'replicate black-forest-labs/flux-2-flex | guidance | range',
  'replicate black-forest-labs/flux-2-flex | output_format | enum',
  'replicate black-forest-labs/flux-2-flex | resolution | enum',
  'replicate black-forest-labs/flux-2-flex | safety_tolerance | range',
  'replicate black-forest-labs/flux-2-flex | steps | range',
  'replicate black-forest-labs/flux-2-klein-4b | output_format | enum',
  'replicate black-forest-labs/flux-2-klein-4b | output_megapixels | enum',
  'replicate black-forest-labs/flux-2-max | output_format | enum',
  'replicate black-forest-labs/flux-2-max | resolution | enum',
  'replicate black-forest-labs/flux-2-max | safety_tolerance | range',
  'replicate black-forest-labs/flux-2-pro | output_format | enum',
  'replicate black-forest-labs/flux-2-pro | resolution | enum',
  'replicate black-forest-labs/flux-2-pro | safety_tolerance | range',
  'replicate black-forest-labs/flux-dev | guidance | range',
  'replicate black-forest-labs/flux-dev | megapixels | enum',
  'replicate black-forest-labs/flux-dev | num_inference_steps | range',
  'replicate black-forest-labs/flux-dev | output_format | enum',
  'replicate black-forest-labs/flux-pro | guidance | range',
  'replicate black-forest-labs/flux-pro | output_format | enum',
  'replicate black-forest-labs/flux-pro | safety_tolerance | range',
  'replicate bria/fibo | guidance_scale | range',
  'replicate bria/image-3.2 | guidance_scale | range',
  'replicate bytedance/seedream-3 | guidance_scale | range',
  'replicate bytedance/seedream-4.5 | size | enum',
  'replicate bytedance/seedream-5-lite | aspect_ratio | enum',
  'replicate bytedance/seedream-5-pro | aspect_ratio | enum',
  'replicate google/imagen-3 | output_format | enum',
  'replicate google/imagen-3 | safety_filter_level | enum',
  'replicate google/imagen-3-fast | output_format | enum',
  'replicate google/imagen-3-fast | safety_filter_level | enum',
  'replicate google/imagen-4 | output_format | enum',
  'replicate google/imagen-4 | safety_filter_level | enum',
  'replicate google/imagen-4-fast | output_format | enum',
  'replicate google/imagen-4-fast | safety_filter_level | enum',
  'replicate google/imagen-4-ultra | output_format | enum',
  'replicate google/imagen-4-ultra | safety_filter_level | enum',
  'replicate ideogram-ai/ideogram-v2 | magic_prompt_option | enum',
  'replicate ideogram-ai/ideogram-v2 | style_type | enum',
  'replicate ideogram-ai/ideogram-v2a-turbo | magic_prompt_option | enum',
  'replicate ideogram-ai/ideogram-v2a-turbo | style_type | enum',
  'replicate minimax/hailuo-2.3 | resolution | enum',
  'replicate openai/gpt-image-1.5 | background | enum',
  'replicate openai/gpt-image-1.5 | input_fidelity | enum',
  'replicate openai/gpt-image-1.5 | output_format | enum',
  'replicate openai/gpt-image-1.5 | quality | enum',
  'replicate openai/gpt-image-2 | background | enum',
  'replicate openai/gpt-image-2 | output_format | enum',
  'replicate openai/gpt-image-2 | quality | enum',
  'replicate prunaai/flux-fast | output_format | enum',
  'replicate prunaai/wan-2.2-image | megapixels | enum',
  'replicate prunaai/wan-2.2-image | output_format | enum',
  'replicate qwen/qwen-image | guidance | range',
  'replicate qwen/qwen-image | num_inference_steps | range',
  'replicate qwen/qwen-image | output_format | enum',
  'replicate recraft-ai/recraft-v3 | style | enum',
  'replicate stability-ai/stable-diffusion-3.5-large | cfg | range',
  'replicate stability-ai/stable-diffusion-3.5-large | output_format | enum',
  'replicate stability-ai/stable-diffusion-3.5-large-turbo | cfg | range',
  'replicate stability-ai/stable-diffusion-3.5-large-turbo | output_format | enum',
  'replicate stability-ai/stable-diffusion-3.5-medium | cfg | range',
  'replicate stability-ai/stable-diffusion-3.5-medium | output_format | enum',
  'replicate tencent/hunyuan-image-3 | output_format | enum',
  'replicate wan-video/wan-2.7-t2v | resolution | enum',
]

const KNOWN_GAPS = new Set([...GAPS_ON_ORDINARY_SETTINGS, ...GAPS_FROM_UNCHECKED_OPTIONS])
const seenGaps = new Set<string>()

/** `<provider> <endpoint> | <field> | <kind>` for one checkPayload message. */
function gapOf(provider: Provider, endpoint: string, message: string): string {
  const field = message.slice(0, message.indexOf(':')).replace(/\[\d+\]/g, '[]')
  const kind = message.endsWith('not in the schema')
    ? 'unknown key'
    : message.includes(' is not one of ')
      ? 'enum'
      : /below the minimum|above the maximum/.test(message)
        ? 'range'
        : message.includes('shorter than') ? 'minLength' : message
  return `${provider} ${endpoint} | ${field} | ${kind}`
}

function expectFits(provider: Provider, endpoint: string, payload: unknown) {
  const unexpected: string[] = []
  for (const message of checkPayload(schemaFor(provider, endpoint), payload)) {
    const gap = gapOf(provider, endpoint, message)
    if (KNOWN_GAPS.has(gap)) seenGaps.add(gap)
    else unexpected.push(message)
  }
  expect(unexpected, `${provider} ${endpoint} ${JSON.stringify(payload)}`).toEqual([])
}

// ── Builder-level fixtures (runner-builders.json, runner-families.json replicateVideo) ──

describe('fal Generate image builders fit the saved fal schemas', () => {
  const REFS = ['https://fal.test/a.png', 'https://fal.test/b.png']
  for (const c of BUILDERS.image as any[]) {
    it(`${c.model} ${JSON.stringify(c.args)}`, () => {
      const d = RUNNER_IMAGE_MODELS[c.model]!
      const args = { prompt: c.args.prompt, aspectRatio: c.args.ar, seed: c.args.seed, adv: c.args.adv }
      expectFits('fal', imageAppFor(d, null), d.build({ ...args, refs: null }))
      // With moodboard pictures, the model's reference endpoint (runner-image-models' moodboard tests).
      if (d.refsApp) expectFits('fal', imageAppFor(d, REFS), d.build({ ...args, refs: REFS }))
    })
  }
})

describe('fal Generate video builders fit the saved fal schemas', () => {
  for (const c of BUILDERS.video as any[]) {
    it(`${c.model} ${JSON.stringify(c.args)}`, () => {
      const d = RUNNER_VIDEO_MODELS[c.model]!
      const payload = d.build({ prompt: c.args.prompt, aspectRatio: c.args.ar, duration: c.args.dur, seed: c.args.seed, image: c.args.image, adv: c.args.adv })
      const fn = falVideoFn(payload, d.fnByMode)
      expectFits('fal', fn ? `${d.app}/${fn}` : d.app, payload)
    })
  }
})

describe('Replicate Generate video builders fit the saved Replicate schemas', () => {
  const cases = (FAMILIES.replicateVideo as any[]).filter(c => !c.error)
  for (const [i, c] of cases.entries()) {
    it(`${i} ${c.model} ${JSON.stringify(c.args)}`, () => {
      const d = RUNNER_REPLICATE_VIDEO_MODELS[c.model]!
      // A text-to-video-only model never gets the linked frame (planNode doesn't hand it off).
      const image = d.modes.includes('i2v') ? c.args.image : null
      const payload = d.build({ prompt: c.args.prompt, aspectRatio: c.args.ar, duration: c.args.dur, seed: c.args.seed, image, adv: c.args.adv })
      expectFits('replicate', d.slug, payload)
    })
  }
})

// ── Node-level fixtures (runner-families.json), through planNode ──

interface NodeCase {
  class_type: string
  links: string[]
  widgets: Record<string, unknown>
  call?: { provider: Provider; endpoint: string; payload: Record<string, unknown> }
  error?: string
  passes?: string
}

const enoent = (name: string) => Object.assign(new Error(`ENOENT: no such file, open '${name}'`), { code: 'ENOENT' })

/** The node as the canvas sends it; pictures handed off as the parity specs hand them off. */
function planCase(c: NodeCase) {
  const inputs: Record<string, unknown> = { ...c.widgets }
  for (const name of c.links) inputs[name] = [`src_${name}`, 0]
  return planNode({
    prompt: { n: { class_type: c.class_type, inputs } },
    nodeId: 'n',
    filesFrom: ([from]) => [{ filename: `${from.slice(4)}.png`, subfolder: '', type: 'output' }],
    toUrl: async (f: OutputFile) => {
      if (f.subfolder.startsWith('moodboard_')) {
        if (f.filename.startsWith('gone_')) throw enoent(f.filename)
        return `BOARD:${f.filename}`
      }
      return `IMG:${f.filename.replace(/\.png$/, '')}`
    },
    gateOpen: false,
  })
}

const FAMILY_KEYS = ['replicateImage', 'falEdit', 'nanoActions', 'refEdits', 'restyle'] as const

for (const key of FAMILY_KEYS) {
  describe(`${key}: every call fits its provider's saved schema`, () => {
    const cases = (FAMILIES[key] as NodeCase[]).filter(c => c.call?.endpoint)
    for (const [i, c] of cases.entries()) {
      it(`${i} ${c.class_type} ${JSON.stringify(c.widgets).slice(0, 160)}`, async () => {
        const plan = await planCase(c)
        if (plan.kind !== 'provider') throw new Error(`expected a provider call, got ${plan.kind}`)
        // The parity specs prove this is the Python call; here it meets the provider's own format.
        expect(`${plan.provider} ${plan.endpoint}`).toBe(`${c.call!.provider} ${c.call!.endpoint}`)
        expectFits(plan.provider as Provider, plan.endpoint, plan.payload)
      })
    }
  })
}

// ── Coverage: a saved schema for every endpoint the runner can call, and none extra ──

function runnerEndpoints(): string[] {
  const out = new Set<string>()
  for (const d of Object.values(RUNNER_IMAGE_MODELS)) {
    out.add(`fal ${d.app}`)
    if (d.refsApp) out.add(`fal ${d.refsApp}`)
  }
  for (const d of Object.values(RUNNER_VIDEO_MODELS)) {
    for (const fn of Object.values(d.fnByMode)) if (fn !== undefined) out.add(`fal ${fn ? `${d.app}/${fn}` : d.app}`)
  }
  for (const d of Object.values(RUNNER_REPLICATE_IMAGE_MODELS)) out.add(`replicate ${d.slug}`)
  for (const d of Object.values(RUNNER_REPLICATE_VIDEO_MODELS)) out.add(`replicate ${d.slug}`)
  for (const app of [FLUX_2_EDIT_APP, FLUX_KONTEXT_APP, NANO_BANANA_2_EDIT_APP, NANO_BANANA_PRO_EDIT_APP]) out.add(`fal ${app}`)
  for (const slug of [NANO_BANANA_2_SLUG, NANO_BANANA_SLUG, PRODUCT_SHOT_SLUG, STYLE_TRANSFER_SLUG]) out.add(`replicate ${slug}`)
  for (const slug of [...Object.values(IMAGE_EDIT_MODELS).map(d => d.slug), ...Object.values(RESTYLE_NANO_BANANA_SLUGS)]) {
    const call = imageEditCall(slug, { prompt: 'p', image_input: ['u'] })
    out.add(`${call.provider} ${call.endpoint}`)
  }
  return [...out].sort()
}

function savedEndpoints(): string[] {
  const out: string[] = []
  for (const provider of ['fal', 'replicate'] as const) {
    const dir = fileURLToPath(new URL(`./fixtures/provider-schemas/${provider}/`, import.meta.url))
    for (const file of readdirSync(dir)) {
      const f = JSON.parse(readFileSync(`${dir}${file}`, 'utf8'))
      expect(file).toBe(`${f.endpoint.replaceAll('/', '__')}.json`)
      out.push(`${provider} ${f.endpoint}`)
    }
  }
  return out.sort()
}

describe('saved provider schemas', () => {
  it('cover exactly the endpoints the runner calls', () => {
    expect(savedEndpoints()).toEqual(runnerEndpoints())
  })

  it('each records where and when it was read; fal ones keep the pricing text, Replicate ones the version', () => {
    for (const e of savedEndpoints()) {
      const [provider, endpoint] = e.split(' ') as [Provider, string]
      const f = schemaFor(provider, endpoint)
      expect(f.fetchedAt, e).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(f.sources?.schema, e).toMatch(/^https:\/\//)
      if (provider === 'fal') expect(f.pricingText, e).toBeTruthy()
      else expect(f.versionId, e).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

// Runs last (tests in a file run in order): every known gap must still be real.
describe('known gaps', () => {
  it('are each still made by some builder (remove an entry once its builder is fixed)', () => {
    expect([...KNOWN_GAPS].filter(g => !seenGaps.has(g))).toEqual([])
  })

  it('never list the same gap twice', () => {
    expect(KNOWN_GAPS.size).toBe(GAPS_ON_ORDINARY_SETTINGS.length + GAPS_FROM_UNCHECKED_OPTIONS.length)
  })
})
