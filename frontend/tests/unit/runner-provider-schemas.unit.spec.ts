/**
 * Every request the runner's builders make, checked against the provider's
 * own saved schema (Task S1: fixtures/provider-schemas/, written by
 * scripts/snapshot_provider_schemas.mjs). The inputs are the ones the
 * existing builder tests use: the Python-parity fixtures' settings
 * (runner-builders.json, runner-families.json) run through the same
 * builders and planNode those tests use. Since Task S1b the builders follow
 * these schemas, not Python, wherever the two disagree. Since Task S3 a plan
 * may carry a backup on the other service (server/runner/generators/twins.ts):
 * it fits its own schema too, and where the runner's first service moved
 * (Relight, Restyle on Nano Banana 2) the backup is Python's call.
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
import {
  FLUX_2_DEV_FAL_APP, FLUX_2_MAX_FAL_APP, FLUX_2_PRO_FAL_APP, FLUX_2_PRO_REPLICATE, FLUX_3_REPLICATE_SLUG, KLING_V3_FAL_APP,
  NANO_BANANA_PRO_REPLICATE, PIXVERSE_V6_FAL_APP, RECRAFT_V4_FAL_APP, RECRAFT_V4_PRO_FAL_APP,
} from '~~/server/runner/generators/twins'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { NANO_BANANA_SHORT_PROMPT, PROMPT_MIN_LENGTH, PROMPT_MIN_LENGTH_RULINGS, SEEDANCE_REFERENCE_LIMITS, requestProblem } from '~~/server/runner/requestRules'
import { WAN_3_ENDPOINTS } from '~~/server/runner/generators/wan3'
import { H3_MAX_TURBO_ENDPOINTS } from '~~/server/runner/generators/h3MaxTurbo'
import { GEMINI_OMNI_FLASH_ENDPOINTS } from '~~/server/runner/generators/geminiOmniFlash'
import { VEO_31_LITE_ENDPOINTS } from '~~/server/runner/generators/veo31Lite'
import { HAPPYHORSE_11_ENDPOINTS, HAPPYHORSE_11_REPLICATE_SLUG } from '~~/server/runner/generators/happyHorse11'
import { GROK_IMAGINE_VIDEO_15_ENDPOINTS, GROK_IMAGINE_VIDEO_15_REPLICATE_SLUG } from '~~/server/runner/generators/grokImagineVideo15'
import { LTX_25_FAST_REPLICATE_SLUG } from '~~/server/runner/generators/ltx25Fast'
import { GPT_IMAGE_25_FAL_ENDPOINTS, GPT_IMAGE_25_REPLICATE_SLUGS } from '~~/server/runner/generators/gptImage25'
import { QWEN_IMAGE_3_SLUG } from '~~/server/runner/generators/qwenImage3'
import { GROK_IMAGINE_2_SLUG } from '~~/server/runner/generators/grokImagine2'
import { IDEOGRAM_4_FAL_APP, IDEOGRAM_4_REPLICATE_SLUGS } from '~~/server/runner/generators/ideogram4'
import { MUSE_IMAGE_FAL_APP } from '~~/server/runner/generators/museImage'
import { NANO_BANANA_2_LITE_SLUG } from '~~/server/runner/generators/nanoBanana2Lite'
import { REVE_21_FAL_APP } from '~~/server/runner/generators/reve21'
import { RECRAFT_V41_FAL_APP, RECRAFT_V41_REPLICATE_SLUG } from '~~/server/runner/generators/recraftV41'
import { KREA_2_FAL_APPS, KREA_2_REPLICATE_SLUGS } from '~~/server/runner/generators/krea2'
import { QWEN_2511_ANGLES_APP } from '~~/server/runner/generators/qwen2511Angles'
import { BRIA_PRODUCT_SHOT_APP } from '~~/server/runner/generators/briaProductShot'

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

// ── Known gaps: requests the runner makes that the provider's own schema refuses ──
//
// Each entry is `<provider> <endpoint> | <field> | <kind>`. A gap listed here
// is tolerated (and must still happen: the last test fails once it is fixed,
// so the entry is removed); anything not listed fails its test.
//
// Task S1b fixed every builder to its schema (the runner no longer follows
// Python where Python breaks the schema). What is left can't be fixed in a
// builder:

/**
 * Hit by ordinary settings. Empty since S1b fix round 1: the last four (a
 * Nano Banana prompt under 3 characters) are now refused in plain words
 * before they are sent (server/runner/requestRules.ts; "refusals" below).
 */
const GAPS_ON_ORDINARY_SETTINGS: readonly string[] = []

/** Hit only by the parity fixtures' out-of-range model options. Empty since S1b: every builder clamps them. */
const GAPS_FROM_UNCHECKED_OPTIONS: readonly string[] = []

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

/** `<provider> <endpoint> | <message>` for each request the runner refused instead of sending. */
const seenRefusals = new Set<string>()

function expectFits(provider: Provider, endpoint: string, payload: unknown) {
  // A request no provider takes is refused, not sent (planNode's check): its
  // only schema breaks are the ones the refusal names.
  const refused = requestProblem(provider, endpoint, payload as Record<string, unknown>)
  if (refused) {
    seenRefusals.add(`${provider} ${endpoint} | ${refused}`)
    for (const m of checkPayload(schemaFor(provider, endpoint), payload)) expect(m).toMatch(/^(prompt: shorter than|\w+_urls: more than)/)
    return
  }
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
        const planned = await planCase(c).catch((e: unknown) => e as Error)
        if (planned instanceof Error) {
          // Refused before sending: Python's own request is one the provider refuses for the same reason.
          expect(requestProblem(c.call!.provider, c.call!.endpoint, c.call!.payload)).toBe(planned.message)
          seenRefusals.add(`${c.call!.provider} ${c.call!.endpoint} | ${planned.message}`)
          return
        }
        const plan = planned
        if (plan.kind !== 'provider') throw new Error(`expected a provider call, got ${plan.kind}`)
        // The parity specs prove this is the Python call; here it meets the provider's own format.
        // Where the runner's first service moved (Task S3), Python's call is the backup.
        const python = `${c.call!.provider} ${c.call!.endpoint}`
        const same = `${plan.provider} ${plan.endpoint}` === python ? plan : plan.backup
        expect(same && `${same.provider} ${same.endpoint}`).toBe(python)
        expectFits(plan.provider as Provider, plan.endpoint, plan.payload)
        if (plan.backup) expectFits(plan.backup.provider as Provider, plan.backup.endpoint, plan.backup.payload)
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
  // Task F1: Wan 3.0's four fal endpoints (wan3.ts; its payload grid is runner-wan3.unit.spec.ts).
  for (const e of WAN_3_ENDPOINTS) out.add(`fal ${e}`)
  // Task F2: GPT Image 2.5, fal first and Replicate the backup (gptImage25.ts; its grid is runner-gpt-image-25.unit.spec.ts).
  for (const e of GPT_IMAGE_25_FAL_ENDPOINTS) out.add(`fal ${e}`)
  for (const slug of GPT_IMAGE_25_REPLICATE_SLUGS) out.add(`replicate ${slug}`)
  // Task F3: Hailuo H3 Max Turbo's two fal endpoints (h3MaxTurbo.ts; its payload grid is runner-h3-max-turbo.unit.spec.ts).
  for (const e of H3_MAX_TURBO_ENDPOINTS) out.add(`fal ${e}`)
  // Task F4: Gemini Omni Flash's two fal endpoints (geminiOmniFlash.ts; its payload grid is runner-gemini-omni-flash.unit.spec.ts).
  for (const e of GEMINI_OMNI_FLASH_ENDPOINTS) out.add(`fal ${e}`)
  // Task F5: Veo 3.1 Lite's two fal endpoints (veo31Lite.ts; its payload grid is runner-veo-31-lite.unit.spec.ts).
  for (const e of VEO_31_LITE_ENDPOINTS) out.add(`fal ${e}`)
  // Task F6: Qwen Image 3 on Replicate, no backup (qwenImage3.ts; its payload grid is runner-qwen-image-3.unit.spec.ts).
  out.add(`replicate ${QWEN_IMAGE_3_SLUG}`)
  // Task F7: Grok Imagine 2 on Replicate, no backup (grokImagine2.ts; its payload grid is runner-grok-imagine-2.unit.spec.ts).
  out.add(`replicate ${GROK_IMAGINE_2_SLUG}`)
  // Task F8: Ideogram 4, fal first and Replicate (one model per speed) the backup at 2K (ideogram4.ts; its grid is runner-ideogram-4.unit.spec.ts).
  out.add(`fal ${IDEOGRAM_4_FAL_APP}`)
  for (const slug of Object.values(IDEOGRAM_4_REPLICATE_SLUGS)) out.add(`replicate ${slug}`)
  // Task F10: Rotate camera on Qwen Image Edit 2511 multiple angles, fal, no backup (qwen2511Angles.ts; its grid is runner-qwen-2511-angles.unit.spec.ts).
  out.add(`fal ${QWEN_2511_ANGLES_APP}`)
  out.add(`fal ${BRIA_PRODUCT_SHOT_APP}`)
  // Task F13: Muse Image on fal, no backup (museImage.ts; its grid is runner-muse-image.unit.spec.ts).
  out.add(`fal ${MUSE_IMAGE_FAL_APP}`)
  // Task F14: Nano Banana 2 Lite on Replicate, no backup (nanoBanana2Lite.ts; its grid is runner-nano-banana-2-lite.unit.spec.ts).
  out.add(`replicate ${NANO_BANANA_2_LITE_SLUG}`)
  // Task F15: Reve 2.1 on fal, no backup (reve21.ts; its grid is runner-reve-2-1.unit.spec.ts).
  out.add(`fal ${REVE_21_FAL_APP}`)
  // Task F16: Recraft V4.1 on fal, Replicate the backup (recraftV41.ts; its grid is runner-recraft-v4-1.unit.spec.ts).
  out.add(`fal ${RECRAFT_V41_FAL_APP}`)
  out.add(`replicate ${RECRAFT_V41_REPLICATE_SLUG}`)
  // Task F17: Krea 2 Large and Medium on fal, Replicate the backup (krea2.ts; its grid is runner-krea-2.unit.spec.ts).
  for (const app of Object.values(KREA_2_FAL_APPS)) out.add(`fal ${app}`)
  for (const slug of Object.values(KREA_2_REPLICATE_SLUGS)) out.add(`replicate ${slug}`)
  // Task F18: HappyHorse 1.1 on fal, Replicate the backup (happyHorse11.ts; its grid is runner-happyhorse-1-1.unit.spec.ts).
  for (const e of HAPPYHORSE_11_ENDPOINTS) out.add(`fal ${e}`)
  out.add(`replicate ${HAPPYHORSE_11_REPLICATE_SLUG}`)
  // Task F19: Grok Imagine Video 1.5 on fal, Replicate the backup for image-to-video (grokImagineVideo15.ts;
  // its grid is runner-grok-imagine-video-1-5.unit.spec.ts).
  for (const e of GROK_IMAGINE_VIDEO_15_ENDPOINTS) out.add(`fal ${e}`)
  out.add(`replicate ${GROK_IMAGINE_VIDEO_15_REPLICATE_SLUG}`)
  // Task F20: LTX-2.5 Fast on Replicate, no backup (ltx25Fast.ts; its grid is runner-ltx-2-5-fast.unit.spec.ts).
  out.add(`replicate ${LTX_25_FAST_REPLICATE_SLUG}`)
  for (const d of Object.values(RUNNER_REPLICATE_IMAGE_MODELS)) out.add(`replicate ${d.slug}`)
  for (const d of Object.values(RUNNER_REPLICATE_VIDEO_MODELS)) out.add(`replicate ${d.slug}`)
  for (const app of [FLUX_2_EDIT_APP, FLUX_KONTEXT_APP, NANO_BANANA_2_EDIT_APP, NANO_BANANA_PRO_EDIT_APP]) out.add(`fal ${app}`)
  for (const slug of [NANO_BANANA_2_SLUG, NANO_BANANA_SLUG, PRODUCT_SHOT_SLUG, STYLE_TRANSFER_SLUG]) out.add(`replicate ${slug}`)
  for (const slug of [...Object.values(IMAGE_EDIT_MODELS).map(d => d.slug), ...Object.values(RESTYLE_NANO_BANANA_SLUGS)]) {
    const call = imageEditCall(slug, { prompt: 'p', image_input: ['u'] })
    out.add(`${call.provider} ${call.endpoint}`)
  }
  // Task S3: the first services that moved, and the backups (twins.ts).
  for (const app of [KLING_V3_FAL_APP, PIXVERSE_V6_FAL_APP]) for (const fn of ['text-to-video', 'image-to-video']) out.add(`fal ${app}/${fn}`)
  for (const app of [FLUX_2_DEV_FAL_APP, FLUX_2_PRO_FAL_APP, FLUX_2_MAX_FAL_APP, RECRAFT_V4_FAL_APP, RECRAFT_V4_PRO_FAL_APP]) out.add(`fal ${app}`)
  for (const slug of [FLUX_3_REPLICATE_SLUG, NANO_BANANA_PRO_REPLICATE, FLUX_2_PRO_REPLICATE]) out.add(`replicate ${slug}`)
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

// Runs last (tests in a file run in order).
describe('refusals', () => {
  it('a Nano Banana prompt under 3 characters is refused on every Nano Banana endpoint the fixtures reach', () => {
    expect([...seenRefusals].sort()).toEqual([
      `fal fal-ai/nano-banana-2 | ${NANO_BANANA_SHORT_PROMPT}`,
      `fal fal-ai/nano-banana-2/edit | ${NANO_BANANA_SHORT_PROMPT}`,
      `fal fal-ai/nano-banana-pro | ${NANO_BANANA_SHORT_PROMPT}`,
      `fal fal-ai/nano-banana-pro/edit | ${NANO_BANANA_SHORT_PROMPT}`,
    ])
  })

  it('the prompt length rules are exactly the saved schemas\' prompt minLength, plus the controller\'s rulings', () => {
    // Ruled rows: a saved schema without a minLength on that endpoint, the prompt required (controller rulings
    // after F4: Gemini Omni Flash; after F6: Qwen Image 3, and Grok Imagine 2 in F7; Ideogram 4 on fal in F8;
    // Nano Banana 2 Lite on Replicate in F14; Grok Imagine Video 1.5's two fal endpoints in F19; LTX-2.5 Fast on
    // Replicate in F20).
    expect(PROMPT_MIN_LENGTH_RULINGS).toEqual([
      'fal google/gemini-omni-flash', 'replicate alibaba/qwen-image-3', 'replicate xai/grok-imagine-image-2', 'fal ideogram/v4',
      'replicate google/nano-banana-2-lite', 'fal xai/grok-imagine-video/v1.5/text-to-video', 'fal xai/grok-imagine-video/v1.5/image-to-video',
      'replicate lightricks/ltx-2.5-fast',
    ])
    const fromSchemas: Record<string, number> = {}
    for (const key of PROMPT_MIN_LENGTH_RULINGS) {
      const [provider, endpoint] = key.split(' ') as [Provider, string]
      const f = schemaFor(provider, endpoint)
      let input = f.input as Record<string, any>
      while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
      expect(input.properties.prompt.minLength, key).toBeUndefined()
      expect(input.required, key).toContain('prompt')
      fromSchemas[key] = 1
    }
    for (const e of savedEndpoints()) {
      const [provider, endpoint] = e.split(' ') as [Provider, string]
      const f = schemaFor(provider, endpoint)
      let input = f.input as Record<string, any>
      while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
      const min = input.properties?.prompt?.minLength
      if (typeof min === 'number') fromSchemas[e] = min
    }
    expect(Object.fromEntries(Object.entries(PROMPT_MIN_LENGTH).map(([k, v]) => [k, v.min]))).toEqual(fromSchemas)
  })

  it('Seedance 2.0 reference limits are the saved schema\'s maxItems', () => {
    const f = schemaFor('fal', 'bytedance/seedance-2.0/reference-to-video')
    let input = f.input as Record<string, any>
    while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
    for (const l of SEEDANCE_REFERENCE_LIMITS) expect(input.properties[l.key].maxItems, l.key).toBe(l.max)
  })
})

describe('known gaps', () => {
  it('are each still made by some builder (remove an entry once its builder is fixed)', () => {
    expect([...KNOWN_GAPS].filter(g => !seenGaps.has(g))).toEqual([])
  })

  it('never list the same gap twice', () => {
    expect(KNOWN_GAPS.size).toBe(GAPS_ON_ORDINARY_SETTINGS.length + GAPS_FROM_UNCHECKED_OPTIONS.length)
  })
})
