/**
 * Task F8 (model line-up): Ideogram 4, runner-only, family `ideogram-4`
 * (server/runner/generators/ideogram4.ts): "Generate an image", fal's
 * ideogram/v4 first, Replicate's ideogram-ai/ideogram-v4-{turbo,balanced,
 * quality} the backup for a 2K picture only. Folded in: Ideogram V3 and the
 * old Grok Imagine are hidden, and the ruled prompt rows trim whitespace.
 *
 * The family contract:
 *  - every payload over the settings grid fits its endpoint's saved schema,
 *    and so does its backup; the two ask for the same picture; the price
 *    reads the speed, the megapixels and the backup the request carries;
 *  - hand-written expected payloads: plain (the schema's own example
 *    prompt), every option set (with the backup). The model takes no
 *    picture, and moodboard pictures are not sent;
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery hides the model while the family is off;
 *  - the price is verified and non-zero, covers the backup at cost where
 *    there is one, and badge = charge;
 *  - the engine, end to end: the family's own endpoint, and the hold.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, isRunnerEligible } from '#shared/runner/eligibility'
import { blockedModelUses } from '#shared/runner/blockedModels'
import { blockedRunRefusal } from '#shared/runner/needsEngine'
import { __resetModelMenusForTests, applyModelOverlay, galleryEntries, menuDefault, modelMenu } from '#shared/runner/modelMenus'
import { creditsForUsd, usdChargedAtCost } from '#shared/pricing/markup'
import { nodeCredits, providerUsd } from '#shared/pricing/nodePrice'
import { IMAGE_BACKUP_RATES, IMAGE_RATES, imagePriceMaxUsd, imagePriceUsd, imageRateLabel, imageUsd } from '#shared/pricing/imageRates'
import {
  IDEOGRAM_4_DEFAULT_RESOLUTION, IDEOGRAM_4_DEFAULT_SPEED, IDEOGRAM_4_MAX_MEGAPIXELS, IDEOGRAM_4_RATIOS, IDEOGRAM_4_SIZES, IDEOGRAM_4_SPEEDS,
  effectiveImageSettings,
} from '#shared/pricing/imageSettings'
import { IMAGE_MODELS, IMAGE_MODELS_BY_ID, IMAGE_MODEL_PREFERENCE } from '~~/app/data/image-models'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes } from '~/lib/costEstimate'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import {
  IDEOGRAM_4_FAL_APP, IDEOGRAM_4_NEEDS_PROMPT, IDEOGRAM_4_REPLICATE_SLUGS, ideogram4Generate, ideogram4OnReplicate,
} from '~~/server/runner/generators/ideogram4'
import { GROK_IMAGINE_2_SLUG } from '~~/server/runner/generators/grokImagine2'
import { QWEN_IMAGE_3_SLUG } from '~~/server/runner/generators/qwenImage3'
import { NANO_BANANA_2_LITE_NEEDS_PROMPT, NANO_BANANA_2_LITE_SLUG } from '~~/server/runner/generators/nanoBanana2Lite'
import {
  GEMINI_OMNI_FLASH_NEEDS_PROMPT, GROK_IMAGINE_2_NEEDS_PROMPT, PROMPT_MIN_LENGTH, PROMPT_MIN_LENGTH_RULINGS, QWEN_IMAGE_3_NEEDS_PROMPT,
  requestProblem, requestProblems,
} from '~~/server/runner/requestRules'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const ID = 'ideogram-4'
const FAMILY: RunnerFamily = 'ideogram-4'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]
const V3 = ['ideogram-v3-quality', 'ideogram-v3-balanced', 'ideogram-v3-turbo']

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>
type Fixture = ReturnType<typeof loadProviderSchema>

/** A saved schema's input object (its $ref followed). */
function inputSchema(f: Fixture): Record<string, any> {
  let input = f.input as Record<string, any>
  while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
  return input
}
/** A property's enum: a plain enum, Replicate's allOf [$ref], or fal's anyOf [$ref, enum]. */
function enumOf(f: Fixture, prop: string): string[] {
  let p = inputSchema(f).properties[prop] as Record<string, any>
  if (p.allOf) p = f.components.schemas[String(p.allOf[0].$ref).split('/').pop()!] as Record<string, any>
  if (p.anyOf) p = p.anyOf.find((x: any) => x.enum)
  return p.enum as string[]
}
const falSchema = () => {
  const f = loadProviderSchema('fal', IDEOGRAM_4_FAL_APP)
  expect(f.endpoint).toBe(IDEOGRAM_4_FAL_APP)
  return f
}
const repSchema = (slug: string) => {
  const f = loadProviderSchema('replicate', slug)
  expect(f.endpoint).toBe(slug)
  return f
}
/** Pixels / 1,000,000 rounded up (the controller's MP ruling). */
const billed = (pixels: number) => Math.ceil(pixels / 1_000_000)

/** A "Generate an image" node on Ideogram 4. */
function gen(o: { prompt?: string, ar?: unknown, seed?: unknown, opts?: Record<string, unknown> } = {}) {
  const inputs: Record<string, unknown> = {
    model: ID, prompt: o.prompt ?? 'a poster that says HELLO', seed: o.seed ?? 0, model_options: JSON.stringify(o.opts ?? {}),
  }
  if (o.ar !== undefined) inputs.aspect_ratio = o.ar
  return { class_type: 'GenerateImageNode', inputs }
}

function plan(node: { class_type: string, inputs: Record<string, unknown> }) {
  return planNode({
    prompt: { 9: { class_type: 'Image', inputs: { image: 'first.png' } }, n: node },
    nodeId: 'n',
    filesFrom: () => [{ filename: 'first.png', subfolder: '', type: 'input' }],
    toUrl: async (f: OutputFile) => `IMG:${f.filename}`,
    gateOpen: false,
  })
}
async function providerPlan(node: { class_type: string, inputs: Record<string, unknown> }): Promise<ProviderPlan> {
  const p = await plan(node)
  if (p.kind !== 'provider') throw new Error('no provider call')
  return p
}

/** The fal request fits its schema; a 2K one has the backup, which fits its own and asks for the same picture. */
function expectRequest(p: ProviderPlan, label: string) {
  expect(p.provider, label).toBe('fal')
  expect(p.endpoint, label).toBe(IDEOGRAM_4_FAL_APP)
  expect(checkPayload(falSchema(), p.payload), label).toEqual([])
  const size = p.payload.image_size as { width: number, height: number }
  const twoK = Object.values(IDEOGRAM_4_SIZES['2K']).some(([w, h]) => w === size.width && h === size.height)
  if (!twoK) {
    expect(p.backup, `${label}: a 1K picture has no backup`).toBeUndefined()
    return
  }
  const b = p.backup!
  expect(b, `${label} has a backup`).toBeTruthy()
  expect(b.provider, label).toBe('replicate')
  expect(b.endpoint, label).toBe(IDEOGRAM_4_REPLICATE_SLUGS[p.payload.rendering_speed as 'TURBO'])
  expect(checkPayload(repSchema(b.endpoint), b.payload), label).toEqual([])
  expect(b.payload, label).toEqual({ prompt: p.payload.prompt, resolution: `${size.width}x${size.height}` })
}

// ── The saved schemas ──────────────────────────────────────────────────────

describe('the saved schemas', () => {
  it('fal: ideogram/v4, its per-megapixel prices by speed; the fields the builder sends', () => {
    const f = falSchema()
    expect(f.pricingText).toContain('**$0.0075** per megapixel in **TURBO** mode, **$0.015** per megapixel in **BALANCED** mode, or **$0.025** per megapixel in **QUALITY** mode')
    const props = inputSchema(f).properties
    expect(inputSchema(f).required).toEqual(['prompt'])
    expect(props.prompt.minLength).toBeUndefined()
    expect(enumOf(f, 'rendering_speed')).toEqual([...IDEOGRAM_4_SPEEDS])
    expect(props.rendering_speed.default).toBe(IDEOGRAM_4_DEFAULT_SPEED)
    // "'None' disables prompt expansion and skips its fee": the fee has no published figure.
    expect(enumOf(f, 'expansion_model')).toEqual(['None', 'Medium', 'Large'])
    expect(props.expansion_model.description).toContain('\'None\' disables prompt expansion and skips its fee')
    expect(enumOf(f, 'output_format')).toEqual(['jpeg', 'png'])
    expect(props.num_images).toMatchObject({ minimum: 1, maximum: 4 })
    expect(props.seed.anyOf.map((x: any) => x.type)).toEqual(['integer', 'null'])
    // Its size rule (x-fal): multiples of 16, 512 to 3840 a side.
    expect(props.image_size['x-fal']).toEqual({ multiple_of: 16, min_height: 512, max_height: 3840, max_width: 3840, min_width: 512 })
  })

  it('Replicate: one model per speed, the same input schema; its sizes; no seed, format or expansion switch', () => {
    const slugs = Object.values(IDEOGRAM_4_REPLICATE_SLUGS)
    expect(slugs).toEqual(['ideogram-ai/ideogram-v4-turbo', 'ideogram-ai/ideogram-v4-balanced', 'ideogram-ai/ideogram-v4-quality'])
    const first = repSchema(slugs[0]!)
    for (const slug of slugs) {
      const f = repSchema(slug)
      expect(f.input, slug).toEqual(first.input)
      expect(f.components.schemas.Input, slug).toEqual(first.components.schemas.Input)
      expect(Object.keys(inputSchema(f).properties).sort(), slug).toEqual(['enable_copyright_detection', 'json_prompt', 'prompt', 'resolution'])
      expect(inputSchema(f).properties.prompt.description, slug).toContain('Enables Ideogram 4.0 Magic Prompt automatically')
    }
  })

  it('every size fits fal\'s rule at its exact ratio; 2K ones are Replicate\'s; 1K ones are at most 1 MP', () => {
    const repSizes = enumOf(repSchema(IDEOGRAM_4_REPLICATE_SLUGS.BALANCED), 'resolution')
    for (const res of ['1K', '2K'] as const) {
      expect(Object.keys(IDEOGRAM_4_SIZES[res]), res).toEqual([...IDEOGRAM_4_RATIOS])
      for (const [ar, [w, h]] of Object.entries(IDEOGRAM_4_SIZES[res])) {
        const label = `${res} ${ar}`
        expect(w % 16 + h % 16, label).toBe(0)
        for (const side of [w, h]) {
          expect(side, label).toBeGreaterThanOrEqual(512)
          expect(side, label).toBeLessThanOrEqual(3840)
        }
        const [a, b] = ar.split(':').map(Number) as [number, number]
        expect(w * b, label).toBe(h * a)
        if (res === '2K') expect(repSizes, label).toContain(`${w}x${h}`)
        else expect(w * h, label).toBeLessThanOrEqual(1_000_000)
      }
    }
    expect(IDEOGRAM_4_MAX_MEGAPIXELS).toBe(5)
    // The catalogue offers exactly these ratios.
    expect(IMAGE_MODELS_BY_ID[ID]!.aspectRatios).toEqual([...IDEOGRAM_4_RATIOS])
  })

  it('the prompt rule is a ruling on fal (no minLength there; the prompt required), none on Replicate (the prompt optional)', () => {
    expect(PROMPT_MIN_LENGTH[`fal ${IDEOGRAM_4_FAL_APP}`]).toEqual({ min: 1, message: IDEOGRAM_4_NEEDS_PROMPT })
    expect(PROMPT_MIN_LENGTH_RULINGS).toContain(`fal ${IDEOGRAM_4_FAL_APP}`)
    for (const slug of Object.values(IDEOGRAM_4_REPLICATE_SLUGS)) {
      expect(PROMPT_MIN_LENGTH[`replicate ${slug}`], slug).toBeUndefined()
      expect(inputSchema(repSchema(slug)).required, slug).toBeUndefined()
    }
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

describe('settings grid: every request fits its schema, the backup makes the same picture, the price reads what is sent', () => {
  const RATIOS: unknown[] = [...IDEOGRAM_4_RATIOS, '21:9', '3:1', '2.35:1', '', undefined]
  const SPEEDS: unknown[] = [...IDEOGRAM_4_SPEEDS, 'turbo', 'Fast', '', 3, null, undefined]
  const SIZES: unknown[] = ['1K', '2K', '2k', '4K', '', 2, null, undefined]
  const SEEDS: unknown[] = [0, 7, 2 ** 31, 2 ** 32 - 1, -1]

  it('ratio × speed × size × seed', async () => {
    let n = 0
    let backups = 0
    for (const ar of RATIOS) for (const speed of SPEEDS) for (const resolution of SIZES) for (const seed of SEEDS) {
      const opts: Record<string, unknown> = {}
      if (speed !== undefined) opts.rendering_speed = speed
      if (resolution !== undefined) opts.resolution = resolution
      const node = gen({ ar, seed, opts })
      const label = JSON.stringify({ ar, opts, seed })
      const p = await providerPlan(node)
      expectRequest(p, label)
      const f = p.payload
      expect(Object.keys(f).sort(), label).toEqual(['expansion_model', 'image_size', 'num_images', 'output_format', 'prompt', 'rendering_speed', ...(typeof seed === 'number' && seed > 0 ? ['seed'] : [])].sort())
      expect(f.rendering_speed, label).toBe((IDEOGRAM_4_SPEEDS as readonly unknown[]).includes(speed) ? speed : 'BALANCED')
      const res = resolution === '2K' ? '2K' : '1K'
      const table = IDEOGRAM_4_SIZES[res]
      const wh = typeof ar === 'string' && ar in table ? table[ar]! : table['1:1']!
      expect(f.image_size, label).toEqual({ width: wh[0], height: wh[1] })
      expect(f.expansion_model, label).toBe('None')
      expect(f.output_format, label).toBe('png')
      expect(f.num_images, label).toBe(1)
      expect(!!p.backup, label).toBe(res === '2K')
      if (p.backup) backups++
      // Priced on what is sent: the speed, the picture's megapixels, and whether a backup goes with it.
      const s = effectiveImageSettings(ID, ar, node.inputs.model_options)!
      expect(s, label).toEqual({
        images: 1, tier: f.rendering_speed, megapixels: billed(wh[0] * wh[1]), webSearch: false, ...(p.backup ? {} : { noBackup: true }),
      })
      expect(requestProblems({ 1: node }), label).toEqual([])
      n++
    }
    expect(n).toBe(RATIOS.length * SPEEDS.length * SIZES.length * SEEDS.length)
    expect(backups).toBe(RATIOS.length * SPEEDS.length * SEEDS.length)
  })

  it('style text joins the prompt; moodboard pictures are not sent', async () => {
    const node = gen({ prompt: 'a poster' })
    node.inputs.style_block = 'ink wash'
    node.inputs.style_refs = JSON.stringify(['a.png'])
    const p = await providerPlan(node)
    expect(String(p.payload.prompt)).toContain('a poster')
    expect(String(p.payload.prompt)).toContain('ink wash')
    expect(Object.keys(p.payload).sort()).toEqual(['expansion_model', 'image_size', 'num_images', 'output_format', 'prompt', 'rendering_speed'])
  })

  it('the backup builder refuses what Replicate can\'t carry, and has none for a 1K picture', () => {
    const ok = ideogram4Generate({ prompt: 'p', aspectRatio: '1:1', seed: 0, adv: { resolution: '2K' } })
    expect(ideogram4OnReplicate(ok)).toEqual({ provider: 'replicate', endpoint: IDEOGRAM_4_REPLICATE_SLUGS.BALANCED, payload: { prompt: 'p', resolution: '2048x2048' } })
    expect(ideogram4OnReplicate(ideogram4Generate({ prompt: 'p', aspectRatio: '1:1', seed: 0, adv: {} }))).toBeNull()
    expect(() => ideogram4OnReplicate({ ...ok, endpoint: 'fal-ai/ideogram/v3' })).toThrow(/endpoint/)
    expect(() => ideogram4OnReplicate({ ...ok, payload: { ...ok.payload, prompt: 7 } })).toThrow(/prompt/)
    expect(() => ideogram4OnReplicate({ ...ok, payload: { ...ok.payload, rendering_speed: 'FAST' } })).toThrow(/rendering_speed/)
    expect(() => ideogram4OnReplicate({ ...ok, payload: { ...ok.payload, expansion_model: 'Large' } })).toThrow(/expansion_model/)
    expect(ideogram4OnReplicate({ ...ok, payload: { ...ok.payload, image_size: { width: 2000, height: 2000 } } })).toBeNull()
  })
})

// ── Hand-written expected payloads ─────────────────────────────────────────

describe('hand-written payloads', () => {
  it('plain: the schema\'s own example prompt, the defaults (Balanced, 1K), no backup', async () => {
    const props = inputSchema(falSchema()).properties
    const prompt = props.prompt.examples[0] as string
    expect(prompt).toBe('A red panda perched on a mossy branch in a misty forest at sunrise')
    const p = await providerPlan(gen({ prompt, ar: '1:1' }))
    expect(p.endpoint).toBe('ideogram/v4')
    expect(p.payload).toEqual({
      prompt, image_size: { width: 992, height: 992 }, rendering_speed: 'BALANCED', expansion_model: 'None', output_format: 'png', num_images: 1,
    })
    expect(p.payload.rendering_speed).toBe(props.rendering_speed.default)
    expect(p.payload.num_images).toBe(props.num_images.default)
    expect(p.backup).toBeUndefined()
    expect(IDEOGRAM_4_DEFAULT_RESOLUTION).toBe('1K')
  })

  it('every option set: Quality, 2K, 16:9, a seed; Replicate\'s Quality model the backup at the same size', async () => {
    const p = await providerPlan(gen({ prompt: 'a jazz festival poster', ar: '16:9', seed: 1234, opts: { rendering_speed: 'QUALITY', resolution: '2K' } }))
    expect(p.payload).toEqual({
      prompt: 'a jazz festival poster', image_size: { width: 2560, height: 1440 }, rendering_speed: 'QUALITY', expansion_model: 'None',
      output_format: 'png', num_images: 1, seed: 1234,
    })
    expect(p.backup).toEqual({
      provider: 'replicate', endpoint: 'ideogram-ai/ideogram-v4-quality', payload: { prompt: 'a jazz festival poster', resolution: '2560x1440' },
    })
    expectRequest(p, 'every option')
  })

  it('the routes table: fal first, Replicate the backup, and why it is 2K only', () => {
    expect(RUNNER_ROUTES[`image:${ID}`]).toMatchObject({ first: 'fal', backup: 'replicate' })
    expect(RUNNER_ROUTES[`image:${ID}`]!.why).toMatch(/2K only/)
  })
})

// ── An empty prompt, and the ruled rows trimmed ────────────────────────────

describe('an empty prompt is refused up front, in plain words', () => {
  const refusal = [{ nodeId: '1', classType: 'GenerateImageNode', input: 'prompt', message: IDEOGRAM_4_NEEDS_PROMPT }]

  it('the words name the model, ask for a prompt, and carry no ids', () => {
    expect(IDEOGRAM_4_NEEDS_PROMPT).toBe('Ideogram 4 needs a prompt. Describe the picture you want.')
    expect(IDEOGRAM_4_NEEDS_PROMPT).not.toMatch(/_|ideogram-4|ideogram\//)
  })

  it('before the hold: empty, missing, or only spaces', () => {
    expect(requestProblems({ 1: gen({ prompt: '' }) })).toEqual(refusal)
    expect(requestProblems({ 1: gen({ prompt: '   \n\t ' }) })).toEqual(refusal)
    const missing = gen()
    delete missing.inputs.prompt
    expect(requestProblems({ 1: missing })).toEqual(refusal)
  })

  it('at planning: the runner refuses it, spaces too', async () => {
    await expect(plan(gen({ prompt: '' }))).rejects.toThrow(IDEOGRAM_4_NEEDS_PROMPT)
    await expect(plan(gen({ prompt: '    ' }))).rejects.toThrow(IDEOGRAM_4_NEEDS_PROMPT)
  })

  it('style text alone is a prompt; a wired prompt part isn\'t judged before the run', () => {
    const styled = gen({ prompt: '' })
    styled.inputs.style_block = 'ink wash'
    expect(requestProblems({ 1: styled })).toEqual([])
    for (const wired of ['prompt', 'prompt_in', 'style_block', 'style_in']) {
      const node = gen({ prompt: '' })
      node.inputs[wired] = LINK
      expect(requestProblems({ 1: node }), wired).toEqual([])
    }
  })
})

describe('ruled prompt rows trim whitespace; schema rows count exactly what is sent (ruling after F7)', () => {
  const MESSAGES: Record<string, string> = {
    'fal google/gemini-omni-flash': GEMINI_OMNI_FLASH_NEEDS_PROMPT,
    [`replicate ${QWEN_IMAGE_3_SLUG}`]: QWEN_IMAGE_3_NEEDS_PROMPT,
    [`replicate ${GROK_IMAGINE_2_SLUG}`]: GROK_IMAGINE_2_NEEDS_PROMPT,
    [`fal ${IDEOGRAM_4_FAL_APP}`]: IDEOGRAM_4_NEEDS_PROMPT,
    // Task F14: Nano Banana 2 Lite on Replicate (a ruling).
    [`replicate ${NANO_BANANA_2_LITE_SLUG}`]: NANO_BANANA_2_LITE_NEEDS_PROMPT,
  }

  it('every ruled row refuses a prompt of only spaces and passes a padded real one', () => {
    expect([...PROMPT_MIN_LENGTH_RULINGS].sort()).toEqual(Object.keys(MESSAGES).sort())
    for (const key of PROMPT_MIN_LENGTH_RULINGS) {
      const [provider, endpoint] = key.split(' ') as [string, string]
      for (const blank of ['', ' ', '     ', '\n\t ', ' 　']) {
        expect(requestProblem(provider, endpoint, { prompt: blank }), `${key} ${JSON.stringify(blank)}`).toBe(MESSAGES[key])
      }
      expect(requestProblem(provider, endpoint, { prompt: '  a  ' }), key).toBeNull()
    }
  })

  it('every schema row counts spaces as characters, as the provider does', () => {
    const schemaRows = Object.entries(PROMPT_MIN_LENGTH).filter(([k]) => !PROMPT_MIN_LENGTH_RULINGS.includes(k))
    expect(schemaRows.length).toBeGreaterThan(5)
    for (const [key, rule] of schemaRows) {
      const [provider, endpoint] = key.split(' ') as [string, string]
      expect(requestProblem(provider, endpoint, { prompt: ' '.repeat(rule.min) }), key).toBeNull()
      expect(requestProblem(provider, endpoint, { prompt: ' '.repeat(rule.min - 1) }), key).toBe(rule.message)
    }
  })

  it('the nodes: Qwen Image 3, Grok Imagine 2 and Gemini Omni Flash refuse a prompt of spaces before the hold', () => {
    const node = (class_type: string, model: string) => ({ 1: { class_type, inputs: { model, prompt: '   ', model_options: '{}' } } })
    expect(requestProblems(node('GenerateImageNode', 'qwen-image-3')).map(p => p.message)).toEqual([QWEN_IMAGE_3_NEEDS_PROMPT])
    expect(requestProblems(node('GenerateImageNode', 'grok-imagine-2')).map(p => p.message)).toEqual([GROK_IMAGINE_2_NEEDS_PROMPT])
    expect(requestProblems(node('GenerateVideoNode', 'gemini-omni-flash')).map(p => p.message)).toEqual([GEMINI_OMNI_FLASH_NEEDS_PROMPT])
    // A schema row is unchanged: three spaces are three characters for Nano Banana 2 (minLength 3).
    expect(requestProblems(node('GenerateImageNode', 'nano-banana-2'))).toEqual([])
  })
})

// ── Eligibility ────────────────────────────────────────────────────────────

describe('eligibility follows the family switch', () => {
  const p: ApiPrompt = { 1: gen() }

  it('the row names the family', () => {
    expect(RUNNER_NODE_RULES.GenerateImageNode!.models![ID]).toBe(FAMILY)
  })

  it('off (no families, or every other family): not taken', () => {
    expect(isRunnerEligible(p)).toBe(false)
    expect(isRunnerEligible(p, NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(p, ALL_BUT)).toBe(false)
  })

  it('on: taken; never with the prompt, options, style or Idea wired', () => {
    expect(isRunnerEligible(p, ON)).toBe(true)
    expect(isRunnerEligible(p, ALL)).toBe(true)
    for (const wired of ['prompt', 'model_options', 'style_in', 'prompt_in', 'style_block']) {
      const n = gen()
      n.inputs[wired] = LINK
      expect(isRunnerEligible({ 9: { class_type: 'Image', inputs: { image: 'a.png' } }, 1: n }, ON), wired).toBe(false)
    }
  })
})

describe('blockedModelUses', () => {
  const use = { nodeId: '1', classType: 'GenerateImageNode', value: ID, reason: 'runner-only' }

  it('refuses the model while the family is off, on either path', () => {
    expect(blockedModelUses({ 1: gen() })).toEqual([use])
    expect(blockedModelUses({ 1: gen() }, { families: ALL_BUT, runnerTakes: true })).toEqual([use])
  })

  it('lets it through only on a runner run with the family on; the ComfyUI path refuses it', () => {
    expect(blockedModelUses({ 1: gen() }, { families: ON, runnerTakes: true })).toEqual([])
    expect(blockedModelUses({ 1: gen() }, { families: ON })).toEqual([use])
  })

  it('a workflow that needs the engine is refused before it goes there, naming the model', () => {
    const p: ApiPrompt = { 1: gen(), 2: { class_type: 'KSampler', inputs: {} } }
    const titles: Record<string, string> = { 1: 'Poster', 2: 'Old sampler' }
    const r = blockedRunRefusal([{ prompt: p, titleOf: id => titles[id] ?? 'Unnamed node' }], { runnerOn: true, families: ON })
    expect(r).not.toBeNull()
    expect(`${r!.title} ${r!.description}`).toContain('Ideogram 4')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: { 1: gen() }, titleOf: () => 'Poster' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family ideogram-4, with its brand name and plain labels', () => {
    const m = IMAGE_MODELS_BY_ID[ID]!
    expect(m).toMatchObject({ runnerOnly: true, family: FAMILY, label: 'Ideogram 4', brand: 'Ideogram', defaultAspectRatio: '1:1' })
    expect(m.hidden).toBeUndefined()
    expect(m.advanced.map(f => [f.name, f.type, f.default, f.options])).toEqual([
      ['rendering_speed', 'select', IDEOGRAM_4_DEFAULT_SPEED, [...IDEOGRAM_4_SPEEDS]],
      ['resolution', 'select', IDEOGRAM_4_DEFAULT_RESOLUTION, ['1K', '2K']],
    ])
    for (const f of m.advanced) {
      expect(f.label, f.name).toMatch(/^[A-Z][a-z ]+$/)
      expect(f.optionLabels?.length, f.name).toBe(f.options!.length)
    }
    for (const s of [m.label, m.pitch, m.description ?? '', ...m.advanced.flatMap(f => [f.label, f.description ?? '', ...(f.optionLabels ?? [])])]) {
      expect(s).not.toMatch(/_|ideogram-|ideogram\/|TURBO|BALANCED|QUALITY/)
    }
  })

  it('hidden from "Generate an image" while the family is off, shown while on; a saved node still shows it, tagged', () => {
    const shown = (f: ReadonlySet<RunnerFamily>) => galleryEntries(IMAGE_MODELS, { classType: 'GenerateImageNode', families: f, current: null }).map(e => e.model.id)
    expect(shown(NO_FAMILIES)).not.toContain(ID)
    expect(shown(ALL_BUT)).not.toContain(ID)
    expect(shown(ON)).toContain(ID)
    const saved = galleryEntries(IMAGE_MODELS, { classType: 'GenerateImageNode', families: NO_FAMILIES, current: ID })
    expect(saved.find(e => e.model.id === ID)).toMatchObject({ hiddenTag: true, tag: 'Hidden' })
  })

  it('a new node\'s default does not move to it', () => {
    expect(IMAGE_MODEL_PREFERENCE).not.toContain(ID)
    expect(menuDefault(modelMenu('GenerateImageNode')!, ALL)).toBe(IMAGE_MODEL_PREFERENCE[0])
  })
})

describe('hidden, not removed: Ideogram V3 (Ideogram 4 covers every speed) and the old Grok Imagine (Grok Imagine 2 replaces it)', () => {
  const OLD = [...V3, 'grok-imagine']

  it('each is flagged hidden and left out of the gallery with every family on; a saved node still shows it, tagged', () => {
    const shown = galleryEntries(IMAGE_MODELS, { classType: 'GenerateImageNode', families: ALL, current: null }).map(e => e.model.id)
    for (const id of OLD) {
      expect(IMAGE_MODELS_BY_ID[id]!.hidden, id).toBe(true)
      expect(shown, id).not.toContain(id)
      const saved = galleryEntries(IMAGE_MODELS, { classType: 'GenerateImageNode', families: ALL, current: id })
      expect(saved.find(e => e.model.id === id), id).toMatchObject({ hiddenTag: true })
    }
  })

  it('each still prices as before, still runs, and is still served as an option', () => {
    const was: Record<string, number> = { 'ideogram-v3-quality': 0.09, 'ideogram-v3-balanced': 0.06, 'ideogram-v3-turbo': 0.03, 'grok-imagine': 0.02 }
    for (const id of OLD) {
      expect(IMAGE_MODELS_BY_ID[id]!.pricePerImage, id).toBe(was[id])
      expect(providerUsd('GenerateImageNode', { model: id, prompt: 'x' }), id).toBe(was[id])
      expect(blockedModelUses({ 1: { class_type: 'GenerateImageNode', inputs: { model: id, prompt: 'x' } } }, { families: ALL, runnerTakes: true }), id).toEqual([])
    }
    // Ideogram V3 still runs on fal (no family switch); the old Grok Imagine under replicate-image.
    for (const id of V3) expect(isRunnerEligible({ 1: { class_type: 'GenerateImageNode', inputs: { model: id, prompt: 'x', model_options: '{}' } } }, NO_FAMILIES), id).toBe(true)
    expect(RUNNER_NODE_RULES.GenerateImageNode!.models!['grok-imagine']).toBe('replicate-image')
    const served = applyModelOverlay({ GenerateImageNode: { input: { required: { model: ['COMBO', { options: [...OLD, 'flux-dev'], default: 'flux-dev' }] } } } }, ALL) as any
    expect(served.GenerateImageNode.input.required.model[1].options).toEqual(expect.arrayContaining(OLD))
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  const charge = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'GenerateImageNode', inputs }, 2: SINK }).credits

  it('the cards: fal per megapixel by speed, first; Replicate per picture by speed, the backup; verified, dated, non-zero', () => {
    expect(IMAGE_RATES[ID]).toMatchObject({
      unit: 'per_megapixel', perMegapixel: 0.025, perMegapixelByTier: { TURBO: 0.0075, BALANCED: 0.015, QUALITY: 0.025 },
      minMegapixels: 1, maxMegapixels: 5, service: 'fal', confidence: 'verified', read: '2026-09-24', source: 'https://fal.ai/models/ideogram/v4/llms.txt',
    })
    expect(IMAGE_BACKUP_RATES[ID]).toMatchObject({
      unit: 'by_quality', byTier: { TURBO: 0.03, BALANCED: 0.06, QUALITY: 0.10 },
      service: 'replicate', confidence: 'verified', read: '2026-09-24', source: 'https://replicate.com/ideogram-ai/ideogram-v4-balanced',
    })
  })

  // [what, ratio, options, fal USD, backup USD or null, price basis]
  const EXAMPLES: [string, string, Record<string, unknown>, number, number | null, number][] = [
    // The live check: Turbo, 1K (992 × 992 = 1 MP), no backup.
    ['Turbo 1K 1:1 (the live check)', '1:1', { rendering_speed: 'TURBO' }, 0.0075, null, 0.0075],
    ['the defaults: Balanced 1K 1:1', '1:1', {}, 0.015, null, 0.015],
    ['Quality 1K 2:1 (1408 × 704, 1 MP)', '2:1', { rendering_speed: 'QUALITY', resolution: '1K' }, 0.025, null, 0.025],
    // 2048² is 4,194,304 pixels: 5 MP by the ruling (fal's own example bills it as 4). max($0.0375, $0.03 at cost).
    ['Turbo 2K 1:1', '1:1', { rendering_speed: 'TURBO', resolution: '2K' }, 0.0375, 0.03, 0.0375],
    // 2560 × 1440 = 3,686,400 pixels: 4 MP. max($0.06, Replicate $0.06 charged at cost → $0.03) = $0.06.
    ['Balanced 2K 16:9', '16:9', { resolution: '2K' }, 0.06, 0.06, 0.06],
    // 5 MP × $0.025 = $0.125; Replicate $0.10 at cost = $0.05.
    ['Quality 2K 1:1 (the dearest)', '1:1', { rendering_speed: 'QUALITY', resolution: '2K' }, 0.125, 0.10, 0.125],
  ]
  for (const [what, ar, opts, fal, backup, basis] of EXAMPLES) {
    it(`${what}: fal $${fal}, backup ${backup == null ? 'none' : `$${backup}`} → $${basis}; badge = charge = run estimate`, () => {
      const inputs = gen({ ar, opts }).inputs
      const s = effectiveImageSettings(ID, ar, inputs.model_options)!
      expect(imageUsd(ID, s)).toBeCloseTo(fal, 9)
      expect(!!s.noBackup).toBe(backup == null)
      if (backup != null) expect(basis).toBe(Math.max(fal, usdChargedAtCost(backup)))
      expect(imagePriceUsd(ID, s)).toBeCloseTo(basis, 9)
      expect(providerUsd('GenerateImageNode', inputs)).toBeCloseTo(basis, 9)
      const credits = creditsForUsd(basis)
      expect(nodeCredits('GenerateImageNode', inputs)).toBe(credits)
      // Never below either service's cost.
      expect(credits / 100).toBeGreaterThanOrEqual(Math.max(fal, backup ?? 0))
      const c = charge(inputs)
      expect(c).toBe(credits + 1)
      expect(nodeCreditEstimate('GenerateImageNode', inputs)).toBe(c)
      const names = Object.keys(inputs)
      const est = estimateUsdForNodes([{ id: '1', type: 'GenerateImageNode', widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => inputs[n]) }], { hosted: true })!
      expect(est.hostedCredits).toBe(c)
    })
  }

  it('a 1K picture is never charged for the backup it doesn\'t have; a 2K one always covers it', () => {
    for (const ar of IDEOGRAM_4_RATIOS) for (const speed of IDEOGRAM_4_SPEEDS) {
      const k1 = gen({ ar, opts: { rendering_speed: speed } }).inputs
      const k2 = gen({ ar, opts: { rendering_speed: speed, resolution: '2K' } }).inputs
      const per = (IMAGE_RATES[ID] as { perMegapixelByTier: Record<string, number> }).perMegapixelByTier[speed]!
      const rep = (IMAGE_BACKUP_RATES[ID] as { byTier: Record<string, number> }).byTier[speed]!
      expect(providerUsd('GenerateImageNode', k1), `${ar} ${speed} 1K`).toBeCloseTo(per, 9)
      const [w, h] = IDEOGRAM_4_SIZES['2K'][ar]!
      expect(providerUsd('GenerateImageNode', k2), `${ar} ${speed} 2K`).toBeCloseTo(Math.max(per * billed(w * h), usdChargedAtCost(rep)), 9)
      expect(nodeCredits('GenerateImageNode', k2)! / 100, `${ar} ${speed} 2K`).toBeGreaterThanOrEqual(rep)
    }
  })

  it('linked options price at the dearest request (Quality, 5 MP, the backup covered); a linked ratio as 1:1, the largest', () => {
    const linked = { ...gen().inputs, model_options: ['7', 0] }
    expect(providerUsd('GenerateImageNode', linked)).toBe(imagePriceMaxUsd(ID))
    expect(providerUsd('GenerateImageNode', linked)).toBeCloseTo(0.125, 9)
    expect(nodeCreditEstimate('GenerateImageNode', linked)).toBe(charge(linked))
    const linkedRatio = { ...gen({ opts: { resolution: '2K' } }).inputs, aspect_ratio: ['7', 0] }
    expect(providerUsd('GenerateImageNode', linkedRatio)).toBeCloseTo(5 * 0.015, 9)
    for (const ar of IDEOGRAM_4_RATIOS) {
      expect(providerUsd('GenerateImageNode', gen({ ar, opts: { resolution: '2K' } }).inputs)!, ar).toBeLessThanOrEqual(providerUsd('GenerateImageNode', linkedRatio)!)
    }
  })

  it('the gallery: the catalogue figure is fal\'s at the defaults, "up to" the dearest; the hosted label is the charge', () => {
    expect(IMAGE_MODELS_BY_ID[ID]!.pricePerImage).toBe(0.015)
    expect(imageRateLabel(ID, '1:1')).toBe('$0.015, up to $0.125')
    expect(imageRateLabel(ID, '1:1', { hosted: true })).toBe(`${creditsForUsd(0.015)} credits, up to ${creditsForUsd(0.125)}`)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take = (prompt = 'a poster that says HELLO', opts: Record<string, unknown> = { rendering_speed: 'TURBO' }): ApiPrompt => ({
    1: gen({ prompt, ar: '1:1', opts }), 2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  })
  const start = (k: ReturnType<typeof makeKit>, prompt?: string, opts?: Record<string, unknown>) =>
    k.engine.startRun({ userId: k.userId, takes: [take(prompt, opts)], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: fal\'s ideogram/v4, held at the node\'s price, a real output; Replicate untouched', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = [...k.fal.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual([IDEOGRAM_4_FAL_APP])
    expect(submitted[0]!.payload).toEqual({
      prompt: 'a poster that says HELLO', image_size: { width: 992, height: 992 }, rendering_speed: 'TURBO', expansion_model: 'None', output_format: 'png', num_images: 1,
    })
    expect(k.replicate.reqs.size).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([creditsForUsd(0.0075) + 1])
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('at 2K: held at the price that covers the backup', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k, undefined, { rendering_speed: 'QUALITY', resolution: '2K' })
    await k.engine.settled(runId)
    expect([...k.fal.reqs.values()].map(r => r.endpoint)).toEqual([IDEOGRAM_4_FAL_APP])
    expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([creditsForUsd(0.125) + 1])
  })

  it('with the family off: refused, nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL_BUT } })
    await expect(start(k)).rejects.toThrow()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.replicate.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })

  it('a prompt of spaces with the family on: refused, nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    await expect(start(k, '   ')).rejects.toThrow()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })
})
