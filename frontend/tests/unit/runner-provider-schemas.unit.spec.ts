/**
 * Every request the runner's builders make, checked against the provider's
 * own saved schema (Task S1: fixtures/provider-schemas/, written by
 * scripts/snapshot_provider_schemas.mjs). The inputs are the ones the
 * existing builder tests use: the Python-parity fixtures' settings
 * (runner-builders.json, runner-families.json) run through the same
 * builders and planNode those tests use. Since Task S1b the builders follow
 * these schemas, not Python, wherever the two disagree.
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

// ── Known gaps: requests the runner makes that the provider's own schema refuses ──
//
// Each entry is `<provider> <endpoint> | <field> | <kind>`. A gap listed here
// is tolerated (and must still happen: the last test fails once it is fixed,
// so the entry is removed); anything not listed fails its test.
//
// Task S1b fixed every builder to its schema (the runner no longer follows
// Python where Python breaks the schema). What is left can't be fixed in a
// builder:

/** Hit by ordinary settings: the defaults, a seed, an empty prompt, a menu value. */
const GAPS_ON_ORDINARY_SETTINGS: readonly string[] = [
  // Nano Banana's prompt has minLength 3. The prompt is the person's own
  // text (empty, or one or two characters, in the fixtures); the runner won't
  // invent words to pad it. fal refuses the request and nothing is charged.
  'fal fal-ai/nano-banana-2 | prompt | minLength',
  'fal fal-ai/nano-banana-2/edit | prompt | minLength',
  'fal fal-ai/nano-banana-pro | prompt | minLength',
  'fal fal-ai/nano-banana-pro/edit | prompt | minLength',
]

/**
 * Hit only by the parity fixtures' out-of-range model options ("True", "",
 * "0.25", 99, -2…). Since S1b every builder clamps them to a valid option, so
 * none is left.
 */
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
