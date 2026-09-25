/**
 * Task F9 (model line-up): Seedream 5 Pro in "Edit an image", runner-only,
 * family `seedream-5-pro-edit` (server/runner/generators/seedream5ProEdit.ts):
 * bytedance/seedream-5-pro on Replicate, no backup, priced by the size sent.
 *
 * The family contract:
 *  - every payload over the settings grid fits the saved schema; the price
 *    reads the size the request carries (settings parity);
 *  - hand-written expected payloads: plain (the node's defaults), every
 *    option set, and a 4K node (Seedream's largest, 2K);
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the Edit menu hides the model while the family is off;
 *  - the price is verified and non-zero, and badge = charge;
 *  - the engine, end to end: the family's own endpoint, and the hold.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, isRunnerEligible } from '#shared/runner/eligibility'
import { blockedModelUses } from '#shared/runner/blockedModels'
import { blockedRunRefusal } from '#shared/runner/needsEngine'
import { __resetModelMenusForTests, applyModelOverlay, menuDefault, menuHiddenValues, modelMenu } from '#shared/runner/modelMenus'
import { creditsForUsd } from '#shared/pricing/markup'
import { nodeCredits, providerUsd } from '#shared/pricing/nodePrice'
import { EDIT_RATES, editMaxUsd } from '#shared/pricing/editRates'
import { SEEDREAM_5_PRO_EDIT_SIZES, editCalls, seedream5ProEditSize } from '#shared/pricing/editSettings'
import { EDIT_MODEL_MENUS } from '~~/app/data/edit-model-options'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes } from '~/lib/costEstimate'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { IMAGE_EDIT_MODELS } from '~~/server/runner/generators/refEdits'
import {
  SEEDREAM_5_PRO_EDIT_OPTION, SEEDREAM_5_PRO_FORMATS, SEEDREAM_5_PRO_SLUG, seedream5ProEdit,
} from '~~/server/runner/generators/seedream5ProEdit'
import { PROMPT_MIN_LENGTH, requestProblems } from '~~/server/runner/requestRules'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const FAMILY: RunnerFamily = 'seedream-5-pro-edit'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>
type Fixture = ReturnType<typeof loadProviderSchema>

const SCHEMA = loadProviderSchema('replicate', SEEDREAM_5_PRO_SLUG)

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

/** Edit an image's own aspect ratios (_FLUX_KONTEXT_ASPECT_RATIOS, nodes_replicate.py). */
const NODE_RATIOS = ['match_input_image', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']

/** An "Edit an image" node on Seedream 5 Pro, its picture linked from node 9, every widget as the canvas sends it. */
function edit(o: { prompt?: string, resolution?: unknown, ar?: unknown, format?: unknown, seed?: number } = {}) {
  const inputs: Record<string, unknown> = {
    model: SEEDREAM_5_PRO_EDIT_OPTION, input_image: LINK, prompt: o.prompt ?? 'make the sky pink',
    aspect_ratio: 'match_input_image', resolution: '1K', seed: o.seed ?? 0, safety_tolerance: 2, prompt_upsampling: false, output_format: 'png',
  }
  for (const [k, v] of [['resolution', o.resolution], ['aspect_ratio', o.ar], ['output_format', o.format]] as const) {
    if (v !== undefined) inputs[k] = v
  }
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

// ── The saved schema ───────────────────────────────────────────────────────

describe('the saved schema', () => {
  it('one endpoint, Replicate\'s bytedance/seedream-5-pro, the one References already sends', () => {
    expect(SCHEMA.endpoint).toBe('bytedance/seedream-5-pro')
    expect(SEEDREAM_5_PRO_SLUG).toBe(SCHEMA.endpoint)
    expect(IMAGE_EDIT_MODELS['seedream-5-pro']!.slug).toBe(SEEDREAM_5_PRO_SLUG)
  })

  it('an edit takes 1K or 2K; every Edit an image ratio is in its list; png or jpeg; no seed; the prompt optional', () => {
    const props = inputSchema(SCHEMA).properties
    expect(props.size.description).toContain('Standard mode supports 1K and 2K')
    for (const s of SEEDREAM_5_PRO_EDIT_SIZES) expect(enumOf(SCHEMA, 'size')).toContain(s)
    for (const r of NODE_RATIOS) expect(enumOf(SCHEMA, 'aspect_ratio'), r).toContain(r)
    expect(enumOf(SCHEMA, 'output_format')).toEqual([...SEEDREAM_5_PRO_FORMATS])
    expect(props.seed).toBeUndefined()
    expect(inputSchema(SCHEMA).required ?? []).not.toContain('prompt')
    expect(props.prompt.default).toBe('')
  })

  it('no prompt rule: the schema sets no minimum and requires no prompt, so an empty one is sent as it is', async () => {
    expect(PROMPT_MIN_LENGTH[`replicate ${SEEDREAM_5_PRO_SLUG}`]).toBeUndefined()
    const node = edit({ prompt: '' })
    expect(requestProblems({ 1: node })).toEqual([])
    expect((await providerPlan(node)).payload.prompt).toBe('')
  })
})

// ── Settings grid ──────────────────────────────────────────────────────────

describe('settings grid: every request fits the schema, the price reads what is sent', () => {
  it('resolution × ratio × format × seed, odd values included', async () => {
    const resolutions: unknown[] = ['1K', '2K', '4K', '3K', '0.5K', '', 'foo', 7, null, true, undefined]
    const ratios: unknown[] = [...NODE_RATIOS, '21:9', '5:4', '', 7, undefined]
    const formats: unknown[] = ['png', 'jpg', 'jpeg', 'webp', '', 3, undefined]
    let n = 0
    for (const resolution of resolutions) {
      for (const ar of ratios) {
        for (const format of formats) {
          for (const seed of [0, 7, 0xFFFFFFFF]) {
            const node = edit({ resolution, ar, format, seed })
            if (resolution === undefined) delete node.inputs.resolution
            if (ar === undefined) delete node.inputs.aspect_ratio
            if (format === undefined) delete node.inputs.output_format
            const label = JSON.stringify({ resolution, ar, format, seed })
            const p = await providerPlan(node)
            expect(p.provider, label).toBe('replicate')
            expect(p.endpoint, label).toBe(SEEDREAM_5_PRO_SLUG)
            expect(p.backup, label).toBeUndefined()
            expect(checkPayload(SCHEMA, p.payload), label).toEqual([])
            // Exactly these keys; aspect_ratio only for a ratio the schema lists.
            const keys = ['prompt', 'image_input', 'size', 'output_format']
            if (typeof ar === 'string' && enumOf(SCHEMA, 'aspect_ratio').includes(ar)) keys.push('aspect_ratio')
            expect(Object.keys(p.payload).sort(), label).toEqual(keys.sort())
            expect(p.payload.image_input, label).toEqual(['IMG:first.png'])
            expect(p.payload.size, label).toBe(resolution === '2K' || resolution === '4K' || resolution === '3K' || resolution === '0.5K' || resolution === 'foo' ? '2K' : '1K')
            expect(p.payload.size, label).toBe(seedream5ProEditSize(node.inputs.resolution))
            expect(p.payload.output_format, label).toBe(format === 'jpg' || format === 'jpeg' ? 'jpeg' : 'png')
            // The price reads the size sent, from the same card, with nothing behind it.
            const c = editCalls('EditImageNode', node.inputs)
            if ('refused' in c) throw new Error(c.refused)
            expect(c.calls.map(x => [x.endpoint, x.tier, x.fallbacks]), label).toEqual([[p.endpoint, p.payload.size, undefined]])
            n++
          }
        }
      }
    }
    expect(n).toBe(11 * 13 * 7 * 3)
  })

  it('the builder is References\' own, with the one picture and the format', () => {
    const own = IMAGE_EDIT_MODELS['seedream-5-pro']!.build('p', ['u'], 0, { size: '2K', aspect_ratio: '4:3' })
    const mine = seedream5ProEdit({ image: 'u', prompt: 'p', resolution: '2K', aspectRatio: '4:3', outputFormat: 'jpg' })
    expect(mine).toEqual({ provider: 'replicate', endpoint: SEEDREAM_5_PRO_SLUG, payload: { ...own, output_format: 'jpeg' } })
  })
})

// ── Hand-written expected payloads ─────────────────────────────────────────

describe('hand-written payloads', () => {
  it('plain: the node\'s defaults (1K, the picture\'s own ratio, png)', async () => {
    const p = await providerPlan(edit())
    expect(p).toMatchObject({ provider: 'replicate', endpoint: 'bytedance/seedream-5-pro', prefix: 'edit_image' })
    expect(p.payload).toEqual({ prompt: 'make the sky pink', image_input: ['IMG:first.png'], size: '1K', aspect_ratio: 'match_input_image', output_format: 'png' })
    // The schema's own defaults for the ratio and the format.
    const props = inputSchema(SCHEMA).properties
    expect(p.payload.aspect_ratio).toBe(props.aspect_ratio.default)
    expect(p.payload.output_format).toBe(props.output_format.default)
    expect(p.backup).toBeUndefined()
  })

  it('every option set: 2K, 16:9, jpg, a seed; the seed and the Kontext-only settings are not sent', async () => {
    const node = edit({ prompt: 'put a hat on the dog', resolution: '2K', ar: '16:9', format: 'jpg', seed: 1234 })
    node.inputs.safety_tolerance = 6
    node.inputs.prompt_upsampling = true
    const p = await providerPlan(node)
    expect(p.payload).toEqual({ prompt: 'put a hat on the dog', image_input: ['IMG:first.png'], size: '2K', aspect_ratio: '16:9', output_format: 'jpeg' })
  })

  it('a 4K node: Seedream\'s largest, 2K, and priced as 2K', async () => {
    const node = edit({ resolution: '4K', ar: '3:4' })
    const p = await providerPlan(node)
    expect(p.payload).toEqual({ prompt: 'make the sky pink', image_input: ['IMG:first.png'], size: '2K', aspect_ratio: '3:4', output_format: 'png' })
    expect(providerUsd('EditImageNode', node.inputs)).toBe(0.09)
  })

  it('the routes table: Replicate first, no backup', () => {
    expect(RUNNER_ROUTES['EditImageNode:Seedream 5 Pro']).toEqual({ first: 'replicate', backup: null, why: 'fal publishes only tentative pricing' })
  })
})

// ── Eligibility ────────────────────────────────────────────────────────────

describe('eligibility follows the family switch', () => {
  const editP: ApiPrompt = { 9: { class_type: 'Image', inputs: { image: 'first.png' } }, 1: edit() }

  it('the row names the family', () => {
    expect(RUNNER_NODE_RULES.EditImageNode!.models!['Seedream 5 Pro']).toBe(FAMILY)
  })

  it('off (no families, or every other family): not taken', () => {
    expect(isRunnerEligible(editP)).toBe(false)
    expect(isRunnerEligible(editP, NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(editP, ALL_BUT)).toBe(false)
  })

  it('on: taken; only with its picture linked; never with the prompt wired', () => {
    expect(isRunnerEligible(editP, ON)).toBe(true)
    expect(isRunnerEligible(editP, ALL)).toBe(true)
    const noPicture = edit()
    delete noPicture.inputs.input_image
    expect(isRunnerEligible({ 1: noPicture }, ON)).toBe(false)
    const wired = edit()
    wired.inputs.prompt = LINK
    expect(isRunnerEligible({ 9: { class_type: 'Image', inputs: { image: 'a.png' } }, 1: wired }, ON)).toBe(false)
  })
})

describe('blockedModelUses', () => {
  const p: ApiPrompt = { 1: edit() }
  const use = [{ nodeId: '1', classType: 'EditImageNode', value: 'Seedream 5 Pro', reason: 'runner-only' }]

  it('refuses the model while the family is off, on either path', () => {
    expect(blockedModelUses(p)).toEqual(use)
    expect(blockedModelUses(p, { families: ALL_BUT, runnerTakes: true })).toEqual(use)
  })

  it('lets it through only on a runner run with the family on; the ComfyUI path refuses it', () => {
    expect(blockedModelUses(p, { families: ON, runnerTakes: true })).toEqual([])
    expect(blockedModelUses(p, { families: ON })).toEqual(use)
  })

  it('a workflow that needs the engine is refused before it goes there, naming the model', () => {
    const withEngine: ApiPrompt = { 1: edit(), 2: { class_type: 'KSampler', inputs: {} } }
    const titles: Record<string, string> = { 1: 'Sky fix', 2: 'Old sampler' }
    const r = blockedRunRefusal([{ prompt: withEngine, titleOf: id => titles[id] ?? 'Unnamed node' }], { runnerOn: true, families: ON })
    expect(r).not.toBeNull()
    expect(`${r!.title} ${r!.description}`).toContain('Seedream 5 Pro')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: { 1: edit() }, titleOf: () => 'Sky fix' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── The Edit menu ──────────────────────────────────────────────────────────

describe('the Edit an image menu', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in its family, with its brand name as the label', () => {
    const option = EDIT_MODEL_MENUS['EditImageNode.model']!.options.find(o => o.value === 'Seedream 5 Pro')
    expect(option).toEqual({ value: 'Seedream 5 Pro', label: 'Seedream 5 Pro', runnerOnly: true, family: FAMILY })
  })

  it('left out while the family is off, shown while on, and always a valid option', () => {
    const menu = modelMenu('EditImageNode')!
    expect(menuHiddenValues(menu, NO_FAMILIES)).toContain('Seedream 5 Pro')
    expect(menuHiddenValues(menu, ALL_BUT)).toContain('Seedream 5 Pro')
    expect(menuHiddenValues(menu, ON)).not.toContain('Seedream 5 Pro')
    const body = { EditImageNode: { input: { required: { model: ['COMBO', { options: ['Nano Banana 2', 'Flux Kontext Pro', 'Flux 2 Pro'], default: 'Nano Banana 2' }] } } } }
    const out = applyModelOverlay(body, NO_FAMILIES) as any
    expect(out.EditImageNode.input.required.model[1].options).toContain('Seedream 5 Pro')
    expect(out.EditImageNode.input.required.model[1].hidden_options).toContain('Seedream 5 Pro')
  })

  it('a new node\'s default does not move to it', () => {
    expect(EDIT_MODEL_MENUS['EditImageNode.model']!.preference).not.toContain('Seedream 5 Pro')
    expect(menuDefault(modelMenu('EditImageNode')!, ALL)).toBe('Nano Banana 2')
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  const charge = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'EditImageNode', inputs }, 2: SINK }).credits

  it('the card: Replicate\'s by target resolution, verified, non-zero', () => {
    expect(EDIT_RATES['bytedance/seedream-5-pro']).toMatchObject({
      unit: 'by_resolution', byTier: { '1K': 0.045, '2K': 0.09 },
      service: 'replicate', confidence: 'verified', read: '2026-09-24', source: 'https://replicate.com/bytedance/seedream-5-pro',
    })
  })

  const examples: { name: string, inputs: Record<string, unknown>, usd: number }[] = [
    { name: '1K (the default, the live check)', inputs: edit().inputs, usd: 0.045 },
    { name: '2K', inputs: edit({ resolution: '2K', ar: '16:9', format: 'jpg' }).inputs, usd: 0.09 },
    { name: '4K, sent as 2K', inputs: edit({ resolution: '4K' }).inputs, usd: 0.09 },
    { name: 'a linked resolution, at the dearer size', inputs: { ...edit().inputs, resolution: LINK }, usd: 0.09 },
  ]
  for (const ex of examples) {
    it(`${ex.name}: $${ex.usd}; badge = charge = run estimate`, () => {
      expect(providerUsd('EditImageNode', ex.inputs)).toBe(ex.usd)
      const c = editCalls('EditImageNode', ex.inputs)
      if ('refused' in c) throw new Error(c.refused)
      expect(editMaxUsd(c.calls[0]!)).toBe(ex.usd)
      const credits = creditsForUsd(ex.usd)
      expect(credits).toBeGreaterThan(0)
      expect(nodeCredits('EditImageNode', ex.inputs)).toBe(credits)
      const total = charge(ex.inputs)
      expect(total).toBe(credits + 1) // + base render
      expect(nodeCreditEstimate('EditImageNode', ex.inputs)).toBe(total)
      const names = Object.keys(ex.inputs)
      const est = estimateUsdForNodes([{ id: '1', type: 'EditImageNode', widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => ex.inputs[n]) }], { hosted: true })!
      expect(est.hostedCredits).toBe(total)
    })
  }

  it('a linked or missing model is still priced at the dearest model the node offers (Seedream is not it)', () => {
    const linked = { input_image: LINK, prompt: 'x', model: LINK, resolution: '2K' }
    expect(providerUsd('EditImageNode', linked)!).toBeGreaterThan(0.09)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take: ApiPrompt = {
    11: { class_type: 'Image', inputs: { image: 'photo.png' } },
    1: { class_type: 'EditImageNode', inputs: { ...edit().inputs, input_image: ['11', 0] } },
    2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  }
  const kit = (families: ReadonlySet<RunnerFamily>) => {
    const k = makeKit({ hosted: true, deps: { families: () => families } })
    writeFileSync(join(k.root, 'input', 'photo.png'), new Uint8Array([1]))
    return k
  }
  const start = (k: ReturnType<typeof makeKit>) => k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: the family\'s own Replicate endpoint, held at the node\'s price, a real output', async () => {
    const k = kit(ON)
    const { runId } = await start(k)
    await k.engine.settled(runId)
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    const submitted = k.replicate.submitted()
    expect(submitted.map(r => r.endpoint)).toEqual([SEEDREAM_5_PRO_SLUG])
    expect(submitted[0]!.payload).toEqual({
      prompt: 'make the sky pink', image_input: ['https://fal.storage/photo.png'], size: '1K', aspect_ratio: 'match_input_image', output_format: 'png',
    })
    expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([creditsForUsd(0.045) + 1])
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('with the family off: refused, nothing held or sent', async () => {
    const k = kit(ALL_BUT)
    await expect(start(k)).rejects.toThrow()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.replicate.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })
})
