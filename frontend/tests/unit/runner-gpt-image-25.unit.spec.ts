/**
 * Task F2 (model line-up): GPT Image 2.5, runner-only, family
 * `gpt-image-2.5` (server/runner/generators/gptImage25.ts): "Generate an
 * image" (Flare or Sunburst) and the "GPT Image 2.5" option of "Edit an
 * image" (Flare's edit), fal first and Replicate the backup.
 *
 * The family contract:
 *  - every payload over the settings grid fits its endpoint's saved schema,
 *    and so does its backup; the two carry the same settings; the price reads
 *    the quality the request carries (settings parity);
 *  - hand-written expected payloads: plain (the schema's own example prompt),
 *    every option set, a picture linked (the edit);
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery and the Edit menu hide the model while the family is off;
 *  - the price is verified and non-zero, covers the backup at cost, and
 *    badge = charge;
 *  - the engine, end to end: the family's own endpoint, and the hold.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, isRunnerEligible } from '#shared/runner/eligibility'
import { blockedModelUses } from '#shared/runner/blockedModels'
import { blockedRunRefusal } from '#shared/runner/needsEngine'
import { __resetModelMenusForTests, applyModelOverlay, galleryEntries, menuDefault, menuHiddenValues, modelMenu } from '#shared/runner/modelMenus'
import { creditsForUsd, usdChargedAtCost } from '#shared/pricing/markup'
import { nodeCredits, providerUsd } from '#shared/pricing/nodePrice'
import { IMAGE_BACKUP_RATES, IMAGE_RATES, imagePriceMaxUsd, imageRateLabel } from '#shared/pricing/imageRates'
import { effectiveImageSettings } from '#shared/pricing/imageSettings'
import { EDIT_RATES, editMaxUsd } from '#shared/pricing/editRates'
import { editCalls } from '#shared/pricing/editSettings'
import { IMAGE_MODELS, IMAGE_MODELS_BY_ID, IMAGE_MODEL_PREFERENCE } from '~~/app/data/image-models'
import { EDIT_MODEL_MENUS } from '~~/app/data/edit-model-options'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes } from '~/lib/costEstimate'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import {
  GPT_IMAGE_25_EDIT_APP, GPT_IMAGE_25_FAL_ENDPOINTS, GPT_IMAGE_25_NEEDS_PROMPT, GPT_IMAGE_25_REPLICATE_SLUGS, GPT_IMAGE_25_SIZES,
  GPT_IMAGE_25_TRANSPARENT_JPEG, gptImage25OnReplicate,
} from '~~/server/runner/generators/gptImage25'
import { PROMPT_MIN_LENGTH, requestProblems } from '~~/server/runner/requestRules'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const GPT: RunnerFamily = 'gpt-image-2.5'
const ON: ReadonlySet<RunnerFamily> = new Set([GPT])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT_GPT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== GPT))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>
type Fixture = ReturnType<typeof loadProviderSchema>

/** A saved schema's input object (its $ref followed). */
function inputSchema(f: Fixture): Record<string, any> {
  let input = f.input as Record<string, any>
  while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
  return input
}
/** A property's enum (Replicate wraps enums as allOf [$ref]). */
function enumOf(f: Fixture, prop: string): string[] {
  let p = inputSchema(f).properties[prop] as Record<string, any>
  if (p.allOf) p = f.components.schemas[String(p.allOf[0].$ref).split('/').pop()!] as Record<string, any>
  return p.enum as string[]
}
const falSchema = (endpoint: string) => {
  const f = loadProviderSchema('fal', endpoint)
  expect(f.endpoint).toBe(endpoint)
  return f
}
const repSchema = (slug: string) => {
  const f = loadProviderSchema('replicate', slug)
  expect(f.endpoint).toBe(slug)
  return f
}

/** A "Generate an image" node on GPT Image 2.5. */
function gen(o: { prompt?: string, ar?: unknown, opts?: Record<string, unknown> } = {}) {
  const inputs: Record<string, unknown> = {
    model: 'gpt-image-2.5', prompt: o.prompt ?? 'a poster that says HELLO', seed: 0, model_options: JSON.stringify(o.opts ?? {}),
  }
  if (o.ar !== undefined) inputs.aspect_ratio = o.ar
  return { class_type: 'GenerateImageNode', inputs }
}
/** An "Edit an image" node on GPT Image 2.5, its picture linked from node 9. */
function edit(o: { prompt?: string, format?: unknown } = {}) {
  const inputs: Record<string, unknown> = {
    model: 'GPT Image 2.5', input_image: LINK, prompt: o.prompt ?? 'make the sky pink',
    aspect_ratio: 'match_input_image', resolution: '4K', seed: 7, safety_tolerance: 2, prompt_upsampling: false,
  }
  if (o.format !== undefined) inputs.output_format = o.format
  return { class_type: 'EditImageNode', inputs }
}

/** planNode for one node, the linked picture handed off as `IMG:<name>`. */
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

/** Both requests of a plan fit their own saved schema, and the backup carries the first one's settings. */
function expectPair(p: ProviderPlan, label: string) {
  expect(p.provider, label).toBe('fal')
  expect(checkPayload(falSchema(p.endpoint), p.payload), label).toEqual([])
  expect(p.backup, `${label} has a backup`).toBeTruthy()
  const b = p.backup!
  expect(b.provider, label).toBe('replicate')
  expect(checkPayload(repSchema(b.endpoint), b.payload), label).toEqual([])
  // The same version.
  expect(b.endpoint.replace('openai/gpt-image-2.5-', ''), label).toBe(p.endpoint.split('/')[2])
  // The same settings.
  for (const k of ['prompt', 'quality', 'background', 'output_format', 'output_compression'] as const) {
    expect(b.payload[k], `${label} ${k}`).toEqual(p.payload[k])
  }
  expect(b.payload.number_of_images, label).toBe(1)
  expect(p.payload.num_images, label).toBe(1)
  const size = p.payload.image_size as { width: number, height: number } | 'auto'
  expect(b.payload.aspect_ratio, label).toBe(size === 'auto' ? 'auto' : `${size.width}x${size.height}`)
  expect(b.payload.input_images, label).toEqual(p.payload.image_urls)
}

// ── The saved schemas ──────────────────────────────────────────────────────

describe('the saved schemas', () => {
  it('six endpoints: three on fal (both versions\' text-to-image, Flare\'s edit), both versions on Replicate', () => {
    expect([...GPT_IMAGE_25_FAL_ENDPOINTS]).toEqual([
      'openai/gpt-image-2.5/flare/text-to-image', 'openai/gpt-image-2.5/sunburst/text-to-image', 'openai/gpt-image-2.5/flare/edit',
    ])
    expect([...GPT_IMAGE_25_REPLICATE_SLUGS]).toEqual(['openai/gpt-image-2.5-flare', 'openai/gpt-image-2.5-sunburst'])
    expect(GPT_IMAGE_25_EDIT_APP).toBe('openai/gpt-image-2.5/flare/edit')
    for (const e of GPT_IMAGE_25_FAL_ENDPOINTS) {
      const f = falSchema(e)
      // fal bills tokens, and its page prices the canonical sizes.
      expect(f.pricingText, e).toContain('Image tokens (per 1M): **$8.00** input')
      expect(f.pricingText, e).toContain('**$30.00** output')
      expect(enumOf(f, 'quality'), e).toEqual(expect.arrayContaining(['low', 'medium', 'high']))
      expect(enumOf(f, 'output_format'), e).toEqual(['jpeg', 'png', 'webp'])
      expect(inputSchema(f).properties.prompt.minLength, e).toBe(1)
      // No seed on either service.
      expect(inputSchema(f).properties.seed, e).toBeUndefined()
    }
    for (const slug of GPT_IMAGE_25_REPLICATE_SLUGS) {
      const f = repSchema(slug)
      expect(enumOf(f, 'quality'), slug).toEqual(expect.arrayContaining(['low', 'medium', 'high']))
      expect(inputSchema(f).properties.input_images.type, slug).toBe('array')
      expect(inputSchema(f).properties.seed, slug).toBeUndefined()
    }
  })

  it('every size is one of Replicate\'s listed sizes and inside fal\'s rule', () => {
    const repSizes = enumOf(repSchema('openai/gpt-image-2.5-flare'), 'aspect_ratio')
    // fal's description: "multiples of 16, max edge 3840px, aspect ratio <= 3:1, total pixels between 655,360 and 8,294,400".
    expect(inputSchema(falSchema('openai/gpt-image-2.5/flare/text-to-image')).properties.image_size.description)
      .toContain('multiples of 16, max edge 3840px, aspect ratio <= 3:1, total pixels between 655,360 and 8,294,400')
    for (const [ar, [w, h]] of Object.entries(GPT_IMAGE_25_SIZES)) {
      expect(repSizes, ar).toContain(`${w}x${h}`)
      expect(w % 16 + h % 16, ar).toBe(0)
      expect(Math.max(w, h), ar).toBeLessThanOrEqual(3840)
      expect(Math.max(w / h, h / w), ar).toBeLessThanOrEqual(3)
      expect(w * h, ar).toBeGreaterThanOrEqual(655_360)
      expect(w * h, ar).toBeLessThanOrEqual(8_294_400)
      const [a, b] = ar.split(':').map(Number) as [number, number]
      expect(w / h, ar).toBeCloseTo(a / b, 1)
    }
    // The catalogue offers exactly these ratios.
    expect(IMAGE_MODELS_BY_ID['gpt-image-2.5']!.aspectRatios.sort()).toEqual(Object.keys(GPT_IMAGE_25_SIZES).sort())
  })

  it('the prompt rule is each fal schema\'s minLength', () => {
    for (const e of GPT_IMAGE_25_FAL_ENDPOINTS) expect(PROMPT_MIN_LENGTH[`fal ${e}`], e).toEqual({ min: 1, message: GPT_IMAGE_25_NEEDS_PROMPT })
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

describe('settings grid: every request fits its schema, the backup carries the same settings, the price reads what is sent', () => {
  const VARIANTS: unknown[] = ['flare', 'sunburst', 'Sunburst', '', 3, undefined]
  const QUALITIES: unknown[] = ['low', 'medium', 'high', 'auto', 'xhigh', 'max', 'High', '', 2, undefined]
  const BACKGROUNDS: unknown[] = ['auto', 'transparent', 'opaque', 'clear', undefined]
  const FORMATS: unknown[] = ['png', 'jpeg', 'jpg', 'webp', 'gif', undefined]
  const RATIOS: unknown[] = [...Object.keys(GPT_IMAGE_25_SIZES), '5:4', '21:9', '2.35:1', '', undefined]

  it('Generate an image: version × quality × background × format', async () => {
    let n = 0
    let refused = 0
    for (const variant of VARIANTS) for (const quality of QUALITIES) for (const background of BACKGROUNDS) for (const format of FORMATS) {
      const opts: Record<string, unknown> = {}
      if (variant !== undefined) opts.variant = variant
      if (quality !== undefined) opts.quality = quality
      if (background !== undefined) opts.background = background
      if (format !== undefined) opts.output_format = format
      const node = gen({ ar: '1:1', opts })
      const label = JSON.stringify(opts)
      if (background === 'transparent' && (format === 'jpeg' || format === 'jpg')) {
        // Refused in plain words, before and at planning; never sent.
        await expect(plan(node), label).rejects.toThrow(GPT_IMAGE_25_TRANSPARENT_JPEG)
        expect(requestProblems({ 1: node }).map(p => p.message), label).toEqual([GPT_IMAGE_25_TRANSPARENT_JPEG])
        refused++
        continue
      }
      const p = await providerPlan(node)
      expectPair(p, label)
      expect(p.endpoint, label).toBe(`openai/gpt-image-2.5/${variant === 'sunburst' ? 'sunburst' : 'flare'}/text-to-image`)
      expect(['low', 'medium', 'high'], label).toContain(p.payload.quality)
      expect(p.payload.output_compression, label).toBe(p.payload.output_format === 'png' ? undefined : 90)
      // Priced on what is sent: the tier is the quality in the request.
      expect(effectiveImageSettings('gpt-image-2.5', '1:1', node.inputs.model_options)!.tier, label).toBe(p.payload.quality)
      expect(requestProblems({ 1: node }), label).toEqual([])
      n++
    }
    expect(n).toBeGreaterThan(1000)
    expect(refused).toBe(VARIANTS.length * QUALITIES.length * 2)
  })

  it('Generate an image: every ratio, both versions', async () => {
    for (const ar of RATIOS) for (const variant of ['flare', 'sunburst']) {
      const p = await providerPlan(gen({ ar, opts: { variant } }))
      const label = `${String(ar)} ${variant}`
      expectPair(p, label)
      const want = typeof ar === 'string' && ar in GPT_IMAGE_25_SIZES ? GPT_IMAGE_25_SIZES[ar]! : GPT_IMAGE_25_SIZES['1:1']!
      expect(p.payload.image_size, label).toEqual({ width: want[0], height: want[1] })
      // The size doesn't move the price: fal's card is priced at its dearest reachable row.
      expect(providerUsd('GenerateImageNode', gen({ ar, opts: { variant } }).inputs), label)
        .toBe(providerUsd('GenerateImageNode', gen({ ar: '1:1' }).inputs))
    }
  })

  it('Edit an image: every format; the call and quality the price reads are the ones sent', async () => {
    for (const format of ['png', 'jpg', 'jpeg', 'webp', 'x', undefined]) {
      const node = edit({ format })
      const label = String(format)
      const p = await providerPlan(node)
      expectPair(p, label)
      expect(p.endpoint, label).toBe(GPT_IMAGE_25_EDIT_APP)
      expect(p.payload.image_urls, label).toEqual(['IMG:first.png'])
      expect(p.payload.image_size, label).toBe('auto')
      expect(p.payload.quality, label).toBe('medium')
      expect(p.payload.output_format, label).toBe(format === 'jpg' || format === 'jpeg' ? 'jpeg' : format === 'webp' ? 'webp' : 'png')
      const c = editCalls('EditImageNode', node.inputs)
      if ('refused' in c) throw new Error(c.refused)
      expect(c.calls.map(x => [x.endpoint, x.tier]), label).toEqual([[p.endpoint, p.payload.quality]])
      expect(c.calls[0]!.fallbacks!.map(x => [x.endpoint, x.tier]), label).toEqual([[p.backup!.endpoint, p.backup!.payload.quality]])
    }
  })

  it('an empty prompt is refused in plain words, before the hold and at planning', async () => {
    for (const node of [gen({ prompt: '' }), edit({ prompt: '' })]) {
      await expect(plan(node), node.class_type).rejects.toThrow(GPT_IMAGE_25_NEEDS_PROMPT)
      expect(requestProblems({ 1: node }), node.class_type).toEqual([{ nodeId: '1', classType: node.class_type, input: 'prompt', message: GPT_IMAGE_25_NEEDS_PROMPT }])
    }
    // Style text makes a prompt; a wired part can't be judged before the run.
    expect(requestProblems({ 1: { class_type: 'GenerateImageNode', inputs: { ...gen({ prompt: '' }).inputs, style_block: 'ink' } } })).toEqual([])
    expect(requestProblems({ 1: { class_type: 'GenerateImageNode', inputs: { ...gen({ prompt: '' }).inputs, prompt_in: LINK } } })).toEqual([])
  })

  it('the backup builder refuses what Replicate can\'t carry, rather than guess', () => {
    const ok = { prompt: 'p', image_size: { width: 1024, height: 1024 }, quality: 'high', background: 'auto', output_format: 'png', num_images: 1 }
    expect(() => gptImage25OnReplicate({ provider: 'fal', endpoint: 'fal-ai/other', payload: ok })).toThrow(/endpoint/)
    expect(() => gptImage25OnReplicate({ provider: 'fal', endpoint: 'openai/gpt-image-2.5/flare/text-to-image', payload: { ...ok, image_size: { width: 1000, height: 1000 } } })).toThrow(/image_size/)
    expect(() => gptImage25OnReplicate({ provider: 'fal', endpoint: 'openai/gpt-image-2.5/flare/text-to-image', payload: { ...ok, prompt: 7 } })).toThrow(/prompt/)
  })
})

// ── Hand-written expected payloads ─────────────────────────────────────────

describe('hand-written payloads', () => {
  it('plain: the schema\'s own example prompt, the defaults sent as the schema\'s defaults', async () => {
    const f = falSchema('openai/gpt-image-2.5/flare/text-to-image')
    const props = inputSchema(f).properties
    const prompt = props.prompt.examples[0] as string
    const p = await providerPlan(gen({ prompt, ar: '1:1' }))
    expect(p.endpoint).toBe('openai/gpt-image-2.5/flare/text-to-image')
    expect(p.payload).toEqual({
      prompt, image_size: { width: 1024, height: 1024 }, quality: 'high', background: 'auto', output_format: 'png', num_images: 1,
    })
    // The schema's defaults and examples.
    expect(p.payload.quality).toBe(props.quality.default)
    expect(p.payload.background).toBe(props.background.default)
    expect(p.payload.output_format).toBe(props.output_format.default)
    expect(p.payload.num_images).toBe(props.num_images.examples[0])
    expect(p.backup).toEqual({
      provider: 'replicate', endpoint: 'openai/gpt-image-2.5-flare',
      payload: { prompt, aspect_ratio: '1024x1024', quality: 'high', background: 'auto', output_format: 'png', number_of_images: 1 },
    })
  })

  it('every option set: Sunburst, low, transparent WebP, 16:9', async () => {
    const p = await providerPlan(gen({ prompt: 'a sticker of a fox', ar: '16:9', opts: { variant: 'sunburst', quality: 'low', background: 'transparent', output_format: 'webp' } }))
    expect(p.endpoint).toBe('openai/gpt-image-2.5/sunburst/text-to-image')
    expect(p.payload).toEqual({
      prompt: 'a sticker of a fox', image_size: { width: 2048, height: 1152 }, quality: 'low', background: 'transparent',
      output_format: 'webp', output_compression: 90, num_images: 1,
    })
    expect(p.backup).toEqual({
      provider: 'replicate', endpoint: 'openai/gpt-image-2.5-sunburst',
      payload: { prompt: 'a sticker of a fox', aspect_ratio: '2048x1152', quality: 'low', background: 'transparent', output_format: 'webp', output_compression: 90, number_of_images: 1 },
    })
    expectPair(p, 'every option')
  })

  it('a picture linked (Edit an image): the schema\'s own example prompt, the picture, medium, as a JPEG', async () => {
    const f = falSchema(GPT_IMAGE_25_EDIT_APP)
    const props = inputSchema(f).properties
    const prompt = props.prompt.examples[0] as string
    const p = await providerPlan(edit({ prompt, format: 'jpg' }))
    expect(p.endpoint).toBe('openai/gpt-image-2.5/flare/edit')
    expect(p.payload).toEqual({
      prompt, image_urls: ['IMG:first.png'], image_size: 'auto', quality: 'medium', output_format: 'jpeg', output_compression: 90, num_images: 1,
    })
    expect(p.payload.image_size).toBe(props.image_size.default)
    expect(p.backup).toEqual({
      provider: 'replicate', endpoint: 'openai/gpt-image-2.5-flare',
      payload: { prompt, aspect_ratio: 'auto', quality: 'medium', output_format: 'jpeg', output_compression: 90, number_of_images: 1, input_images: ['IMG:first.png'] },
    })
    expectPair(p, 'edit')
    // The node's seed and Kontext-only settings are sent to neither.
    for (const k of ['seed', 'aspect_ratio', 'resolution', 'safety_tolerance']) expect(p.payload[k], k).toBeUndefined()
  })

  it('the routes table: fal first, Replicate the backup, on both nodes', () => {
    expect(RUNNER_ROUTES['image:gpt-image-2.5']).toEqual({ first: 'fal', backup: 'replicate' })
    expect(RUNNER_ROUTES['EditImageNode:GPT Image 2.5']).toEqual({ first: 'fal', backup: 'replicate' })
  })
})

// ── Eligibility ────────────────────────────────────────────────────────────

describe('eligibility follows the family switch', () => {
  const genP: ApiPrompt = { 1: gen() }
  const editP: ApiPrompt = { 9: { class_type: 'Image', inputs: { image: 'first.png' } }, 1: edit() }

  it('the rows name the family', () => {
    expect(RUNNER_NODE_RULES.GenerateImageNode!.models!['gpt-image-2.5']).toBe(GPT)
    expect(RUNNER_NODE_RULES.EditImageNode!.models!['GPT Image 2.5']).toBe(GPT)
  })

  it('off (no families, or every other family): not taken', () => {
    for (const p of [genP, editP]) {
      expect(isRunnerEligible(p)).toBe(false)
      expect(isRunnerEligible(p, NO_FAMILIES)).toBe(false)
      expect(isRunnerEligible(p, ALL_BUT_GPT)).toBe(false)
    }
  })

  it('on: taken; the edit only with its picture linked; never with the prompt or options wired', () => {
    for (const p of [genP, editP]) {
      expect(isRunnerEligible(p, ON)).toBe(true)
      expect(isRunnerEligible(p, ALL)).toBe(true)
    }
    const noPicture = edit()
    delete noPicture.inputs.input_image
    expect(isRunnerEligible({ 1: noPicture }, ON)).toBe(false)
    for (const wired of ['prompt', 'model_options', 'style_in', 'prompt_in']) {
      const n = gen()
      n.inputs[wired] = LINK
      expect(isRunnerEligible({ 9: { class_type: 'Image', inputs: { image: 'a.png' } }, 1: n }, ON), wired).toBe(false)
    }
    const wiredEdit = edit()
    wiredEdit.inputs.prompt = LINK
    expect(isRunnerEligible({ 9: { class_type: 'Image', inputs: { image: 'a.png' } }, 1: wiredEdit }, ON)).toBe(false)
  })
})

describe('blockedModelUses', () => {
  const use = (classType: string, value: string) => ({ nodeId: '1', classType, value, reason: 'runner-only' })
  const cases: [ApiPrompt, string, string][] = [
    [{ 1: gen() }, 'GenerateImageNode', 'gpt-image-2.5'],
    [{ 1: edit() }, 'EditImageNode', 'GPT Image 2.5'],
  ]

  it('refuses the model while the family is off, on either path', () => {
    for (const [p, cls, value] of cases) {
      expect(blockedModelUses(p), cls).toEqual([use(cls, value)])
      expect(blockedModelUses(p, { families: ALL_BUT_GPT, runnerTakes: true }), cls).toEqual([use(cls, value)])
    }
  })

  it('lets it through only on a runner run with the family on; the ComfyUI path refuses it', () => {
    for (const [p, cls, value] of cases) {
      expect(blockedModelUses(p, { families: ON, runnerTakes: true }), cls).toEqual([])
      expect(blockedModelUses(p, { families: ON }), cls).toEqual([use(cls, value)])
    }
  })

  it('a workflow that needs the engine is refused before it goes there, naming the model', () => {
    const p: ApiPrompt = { 1: gen(), 2: { class_type: 'KSampler', inputs: {} } }
    const titles: Record<string, string> = { 1: 'Poster', 2: 'Old sampler' }
    const r = blockedRunRefusal([{ prompt: p, titleOf: id => titles[id] ?? 'Unnamed node' }], { runnerOn: true, families: ON })
    expect(r).not.toBeNull()
    expect(`${r!.title} ${r!.description}`).toContain('GPT Image 2.5')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: { 1: gen() }, titleOf: () => 'Poster' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery and the Edit menu', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family gpt-image-2.5, with its brand name and labelled choices', () => {
    const m = IMAGE_MODELS_BY_ID['gpt-image-2.5']!
    expect(m).toMatchObject({ runnerOnly: true, family: GPT, label: 'GPT Image 2.5', brand: 'OpenAI', defaultAspectRatio: '1:1' })
    expect(m.hidden).toBeUndefined()
    for (const f of m.advanced) {
      if (f.type === 'select') expect(f.optionLabels?.length, f.name).toBe(f.options!.length)
      expect(f.label, f.name).toMatch(/^[A-Z][a-z ]+$/)
    }
    expect(m.advanced.map(f => f.name)).toEqual(['variant', 'quality', 'background', 'output_format'])
    const option = EDIT_MODEL_MENUS['EditImageNode.model']!.options.find(o => o.value === 'GPT Image 2.5')
    expect(option).toEqual({ value: 'GPT Image 2.5', label: 'GPT Image 2.5', runnerOnly: true, family: GPT })
  })

  it('hidden from "Generate an image" while the family is off, shown while on; a saved node still shows it, tagged', () => {
    const shown = (f: ReadonlySet<RunnerFamily>) => galleryEntries(IMAGE_MODELS, { classType: 'GenerateImageNode', families: f, current: null }).map(e => e.model.id)
    expect(shown(NO_FAMILIES)).not.toContain('gpt-image-2.5')
    expect(shown(ALL_BUT_GPT)).not.toContain('gpt-image-2.5')
    expect(shown(ON)).toContain('gpt-image-2.5')
    const saved = galleryEntries(IMAGE_MODELS, { classType: 'GenerateImageNode', families: NO_FAMILIES, current: 'gpt-image-2.5' })
    expect(saved.find(e => e.model.id === 'gpt-image-2.5')).toMatchObject({ hiddenTag: true, tag: 'Hidden' })
  })

  it('left out of "Edit an image"\'s menu while the family is off, but always a valid option', () => {
    const menu = modelMenu('EditImageNode')!
    expect(menuHiddenValues(menu, NO_FAMILIES)).toContain('GPT Image 2.5')
    expect(menuHiddenValues(menu, ALL_BUT_GPT)).toContain('GPT Image 2.5')
    expect(menuHiddenValues(menu, ON)).not.toContain('GPT Image 2.5')
    const body = { EditImageNode: { input: { required: { model: ['COMBO', { options: ['Nano Banana 2', 'Flux Kontext Pro', 'Flux 2 Pro'], default: 'Nano Banana 2' }] } } } }
    const out = applyModelOverlay(body, NO_FAMILIES) as any
    expect(out.EditImageNode.input.required.model[1].options).toContain('GPT Image 2.5')
    expect(out.EditImageNode.input.required.model[1].hidden_options).toContain('GPT Image 2.5')
  })

  it('a new node\'s default does not move to it', () => {
    expect(IMAGE_MODEL_PREFERENCE).not.toContain('gpt-image-2.5')
    expect(menuDefault(modelMenu('GenerateImageNode')!, ALL)).toBe(IMAGE_MODEL_PREFERENCE[0])
    expect(menuDefault(modelMenu('EditImageNode')!, ALL)).toBe('Nano Banana 2')
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  const charge = (ct: string, inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: ct, inputs }, 2: SINK }).credits

  it('the cards: fal first (its page\'s per-size table) and Replicate the backup, verified, non-zero', () => {
    expect(IMAGE_RATES['gpt-image-2.5']).toMatchObject({
      unit: 'by_quality', service: 'fal', confidence: 'verified', read: '2026-09-24',
      source: 'https://fal.ai/models/openai/gpt-image-2.5/flare/text-to-image',
      byTier: { low: 0.00615, medium: 0.01434, high: 0.05529 },
    })
    expect(IMAGE_BACKUP_RATES['gpt-image-2.5']).toMatchObject({
      unit: 'by_quality', service: 'replicate', confidence: 'verified', read: '2026-09-24',
      source: 'https://replicate.com/openai/gpt-image-2.5-flare', byTier: { low: 0.012, medium: 0.047, high: 0.128 },
    })
    expect(EDIT_RATES['openai/gpt-image-2.5/flare/edit']).toMatchObject({
      unit: 'by_quality', service: 'fal', confidence: 'verified', read: '2026-09-24', byTier: { low: 0.01113, medium: 0.02595, high: 0.10008 },
    })
    expect(EDIT_RATES['openai/gpt-image-2.5-flare']).toMatchObject({
      unit: 'by_quality', service: 'replicate', confidence: 'verified', read: '2026-09-24', byTier: { low: 0.012, medium: 0.047, high: 0.128 },
    })
    // Each fal price is the table's figure the builder can reach: at least the 1024 × 1024 row
    // (medium $0.01317, high $0.05268: the brief's "about $0.013 / $0.053").
    expect(IMAGE_RATES['gpt-image-2.5']!.unit === 'by_quality' && IMAGE_RATES['gpt-image-2.5']!.byTier.medium).toBeGreaterThanOrEqual(0.01317)
    expect(IMAGE_RATES['gpt-image-2.5']!.unit === 'by_quality' && IMAGE_RATES['gpt-image-2.5']!.byTier.high).toBeGreaterThanOrEqual(0.05268)
  })

  const examples: { name: string, ct: string, inputs: Record<string, unknown>, usd: number }[] = [
    // max(fal $0.01434, Replicate $0.047 at cost = $0.0235)
    { name: 'Generate, medium (the live check)', ct: 'GenerateImageNode', inputs: gen({ ar: '1:1', opts: { quality: 'medium' } }).inputs, usd: 0.0235 },
    // max(fal $0.05529, Replicate $0.128 at cost = $0.064)
    { name: 'Generate at its defaults (high)', ct: 'GenerateImageNode', inputs: gen({ ar: '1:1' }).inputs, usd: 0.064 },
    // max(fal $0.00615, Replicate $0.012 at cost = $0.006)
    { name: 'Generate, low, Sunburst, 9:16', ct: 'GenerateImageNode', inputs: gen({ ar: '9:16', opts: { quality: 'low', variant: 'sunburst' } }).inputs, usd: 0.00615 },
    // max(fal $0.02595, Replicate $0.047 at cost = $0.0235)
    { name: 'Edit an image (medium, the live check)', ct: 'EditImageNode', inputs: edit().inputs, usd: 0.02595 },
  ]
  for (const ex of examples) {
    it(`${ex.name}: $${ex.usd}; never below either service's cost; badge = charge = run estimate`, () => {
      expect(providerUsd(ex.ct, ex.inputs)).toBeCloseTo(ex.usd, 9)
      const credits = creditsForUsd(ex.usd)
      expect(credits).toBeGreaterThan(0)
      expect(nodeCredits(ex.ct, ex.inputs)).toBe(credits)
      const c = charge(ex.ct, ex.inputs)
      expect(c).toBe(credits + 1) // + base render
      expect(nodeCreditEstimate(ex.ct, ex.inputs)).toBe(c)
      const names = Object.keys(ex.inputs)
      const est = estimateUsdForNodes([{ id: '1', type: ex.ct, widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => ex.inputs[n]) }], { hosted: true })!
      expect(est.hostedCredits).toBe(c)
    })
  }

  it('the rule is max(fal with the markup, Replicate at cost), and neither service costs more than the charge', () => {
    for (const quality of ['low', 'medium', 'high']) {
      const inputs = gen({ opts: { quality } }).inputs
      const fal = (IMAGE_RATES['gpt-image-2.5'] as { byTier: Record<string, number> }).byTier[quality]!
      const rep = (IMAGE_BACKUP_RATES['gpt-image-2.5'] as { byTier: Record<string, number> }).byTier[quality]!
      expect(providerUsd('GenerateImageNode', inputs), quality).toBe(Math.max(fal, usdChargedAtCost(rep)))
      expect(nodeCredits('GenerateImageNode', inputs)! / 100, quality).toBeGreaterThanOrEqual(Math.max(fal, rep))
    }
    const e = editCalls('EditImageNode', edit().inputs)
    if ('refused' in e) throw new Error(e.refused)
    expect(editMaxUsd(e.calls[0]!)).toBe(Math.max(0.02595, usdChargedAtCost(0.047)))
    expect(nodeCredits('EditImageNode', edit().inputs)! / 100).toBeGreaterThanOrEqual(0.047)
  })

  it('linked options price at the dearest quality; a linked ratio the same (the size doesn\'t move it)', () => {
    const linked = { ...gen().inputs, model_options: ['7', 0] }
    expect(providerUsd('GenerateImageNode', linked)).toBe(imagePriceMaxUsd('gpt-image-2.5'))
    expect(providerUsd('GenerateImageNode', linked)).toBeCloseTo(0.064, 9)
    expect(nodeCreditEstimate('GenerateImageNode', linked)).toBe(charge('GenerateImageNode', linked))
    const linkedRatio = { ...gen({ opts: { quality: 'medium' } }).inputs, aspect_ratio: ['7', 0] }
    expect(providerUsd('GenerateImageNode', linkedRatio)).toBeCloseTo(0.0235, 9)
    // A linked or missing model on Edit an image is still priced at the dearest model it offers.
    expect(providerUsd('EditImageNode', { input_image: LINK, prompt: 'x', model: LINK })!).toBeGreaterThan(0.02595)
  })

  it('the gallery: the catalogue figure is fal\'s at the defaults; the hosted label is the charge', () => {
    expect(IMAGE_MODELS_BY_ID['gpt-image-2.5']!.pricePerImage).toBe(0.05529)
    expect(imageRateLabel('gpt-image-2.5', '1:1')).toBe('$0.055')
    expect(imageRateLabel('gpt-image-2.5', '1:1', { hosted: true })).toBe(`${creditsForUsd(0.064)} credits`)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take: ApiPrompt = { 1: gen({ ar: '1:1', opts: { quality: 'medium' } }), 2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } } }
  const start = (k: ReturnType<typeof makeKit>) => k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: the family\'s own fal endpoint, held at the node\'s price, a real output', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = [...k.fal.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual(['openai/gpt-image-2.5/flare/text-to-image'])
    expect(submitted[0]!.payload).toMatchObject({ quality: 'medium', image_size: { width: 1024, height: 1024 } })
    expect(k.replicate.reqs.size).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([creditsForUsd(0.0235) + 1])
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('with the family off: refused, nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL_BUT_GPT } })
    await expect(start(k)).rejects.toThrow()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.replicate.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })
})
