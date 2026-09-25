/**
 * Task F12 (model line-up): Product shot on Bria Product Shot, family
 * `bria-product-shot` (server/runner/generators/briaProductShot.ts): fal, no
 * backup, $0.04 a picture.
 *
 * The family moves the whole node (eligibility.ts RunnerNodeRule.upgrade):
 * while it is on, every Product shot node runs Bria, in the runner only
 * (Ruling 10: saved nodes move, user approved retiring the SDXL-era tools),
 * and the settings Bria can't honour (product size, keep the product exact,
 * seed) are hidden from the node and not sent. Off, the node runs on ComfyUI
 * as before: its SDXL call and price, and the hosted refusal, unchanged.
 *
 * The family contract:
 *  - every payload over the settings grid fits the saved schema; the price
 *    reads what is sent (the endpoint; one picture);
 *  - hand-written expected payloads: plain (the node's defaults), every
 *    option set, and odd values, checked against the schema's own examples;
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the node on the ComfyUI path while the family
 *    is on, and never while it is off; the hosted SDXL refusal stays only
 *    while it is off;
 *  - the price is verified and non-zero, and badge = charge = run estimate;
 *  - the engine, end to end: the family's own endpoint, the hold and charge.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, classUpgradeOn, isRunnerEligible, runnerTakesNode, upgradeHidesWidget } from '#shared/runner/eligibility'
import { NOT_TAKEN_AS_SET_UP_REASON, blockedModelUses, blockedModelsResponse } from '#shared/runner/blockedModels'
import { blockedPromptBody, blockedRunRefusal } from '#shared/runner/needsEngine'
import { creditsForUsd } from '#shared/pricing/markup'
import { nodeCredits, providerUsd } from '#shared/pricing/nodePrice'
import { EDIT_RATES, editMaxUsd } from '#shared/pricing/editRates'
import { editCalls, sizePricedInput } from '#shared/pricing/editSettings'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes } from '~/lib/costEstimate'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { BRIA_PRODUCT_SHOT_APP, BRIA_SHOT_SIZES, briaProductShot } from '~~/server/runner/generators/briaProductShot'
import { PRODUCT_SHOT_DEFAULT_PROMPT, PRODUCT_SHOT_SLUG } from '~~/server/runner/generators/refEdits'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import {
  PRODUCT_SHOT_MAX_BYTES, PRODUCT_SHOT_TOO_LARGE, PRODUCT_SHOT_WRONG_FORMAT,
  checkedInputFile, inputFileProblem, linkedFileProblem, pictureFormat, requestProblems,
} from '~~/server/runner/requestRules'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
import sharp from 'sharp'
import { PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { PRODUCT_SHOT_UPGRADING, blockedPromptRefusal, retiredEngineRefusal } from '~~/server/utils/blockedModels'
import { meterGraphSubmit } from '~~/server/utils/meterGraphRun'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit, ofType } from './__runner__/kit'

const FAMILY: RunnerFamily = 'bria-product-shot'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]
const HIDDEN = ['product_size', 'keep_product_exact', 'seed']
const USD = 0.04

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>
type Fixture = ReturnType<typeof loadProviderSchema>

const SCHEMA = loadProviderSchema('fal', BRIA_PRODUCT_SHOT_APP)

/** A saved schema's input object (its $ref followed). */
function inputSchema(f: Fixture): Record<string, any> {
  let input = f.input as Record<string, any>
  while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
  return input
}
const PROPS = inputSchema(SCHEMA).properties as Record<string, Record<string, any>>

/** A Product shot node as the canvas sends it (every widget at the node's default unless given), its picture linked from node 9. */
function shot(o: Record<string, unknown> = {}) {
  return {
    class_type: 'ProductShotNode',
    inputs: { image: LINK, scene_prompt: PRODUCT_SHOT_DEFAULT_PROMPT, aspect: 'Square', product_size: 'Original', keep_product_exact: true, seed: 0, ...o },
  }
}

/** planNode for one node, the linked picture handed off as `IMG:<name>`. */
function plan(node: { class_type: string, inputs: Record<string, unknown> }, families?: ReadonlySet<RunnerFamily>) {
  return planNode({
    prompt: { 9: { class_type: 'Image', inputs: { image: 'bottle.png' } }, n: node },
    nodeId: 'n',
    filesFrom: () => [{ filename: 'bottle.png', subfolder: '', type: 'input' }],
    toUrl: async (f: OutputFile) => `IMG:${f.filename}`,
    gateOpen: false,
    ...(families ? { families } : {}),
  })
}
async function providerPlan(node: { class_type: string, inputs: Record<string, unknown> }, families?: ReadonlySet<RunnerFamily>): Promise<ProviderPlan> {
  const p = await plan(node, families)
  if (p.kind !== 'provider') throw new Error('no provider call')
  return p
}

// ── The saved schema ───────────────────────────────────────────────────────

describe('the saved schema', () => {
  it('fal\'s endpoint id is the one the snapshot checked (x-fal-metadata.endpointId), $0.04 a picture', () => {
    expect(BRIA_PRODUCT_SHOT_APP).toBe('fal-ai/bria/product-shot')
    expect(SCHEMA.endpoint).toBe(BRIA_PRODUCT_SHOT_APP)
    expect(SCHEMA.pricingText).toContain('$0.04 per generations')
  })

  it('what the builder leans on: only the picture required; the placements; one to four results; about 1 MP shots', () => {
    expect(inputSchema(SCHEMA).required).toEqual(['image_url'])
    expect(PROPS.placement_type).toMatchObject({ default: 'manual_placement' })
    expect(PROPS.placement_type!.enum).toContain('manual_placement')
    expect(PROPS.manual_placement_selection).toMatchObject({ default: 'bottom_center' })
    expect(PROPS.num_results).toMatchObject({ type: 'integer', minimum: 1, maximum: 4, default: 1 })
    expect(PROPS.shot_size).toMatchObject({ default: [1000, 1000] })
    expect(PROPS.shot_size!.description).toContain('around 1,000,000')
    // A scene picture or a description, not both: the node sends the description.
    expect(PROPS.ref_image_url!.description).toContain('Either ref_image_url or scene_description has to be provided but not both')
  })

  it('what Bria can\'t honour: no seed, no product size or exactness switch (only pixel padding around the cut-out)', () => {
    expect(Object.keys(PROPS).filter(k => /seed|exact|fill|scale|size/i.test(k)).sort()).toEqual(['shot_size'])
    expect(PROPS.padding_values!.description).toContain('placement_type=manual_padding')
  })

  it('no backup: Replicate has no Bria Product Shot (read 2026-09-24)', () => {
    expect(RUNNER_ROUTES['ProductShotNode+bria-product-shot']).toMatchObject({ first: 'fal', backup: null })
    expect(RUNNER_ROUTES['ProductShotNode+bria-product-shot']!.why).toBeTruthy()
    // The SDXL row is unchanged.
    expect(RUNNER_ROUTES.ProductShotNode).toMatchObject({ first: 'replicate', backup: null })
  })
})

// ── Settings grid ──────────────────────────────────────────────────────────

describe('settings grid: every request fits the schema, the price reads what is sent', () => {
  const SCENES: unknown[] = [PRODUCT_SHOT_DEFAULT_PROMPT, '', '   ', 'on a rock, next to the ocean, dark theme', '  a beach at dusk \n', 'x'.repeat(2000)]
  const ASPECTS: unknown[] = ['Square', 'Portrait', 'Landscape', 'Panorama', '', undefined]
  const SIZES: unknown[] = ['Original', '80', '50', '20', undefined]
  const EXACT: unknown[] = [true, false, undefined]
  const SEEDS: unknown[] = [0, 7, 0xFFFFFFFF, undefined]

  it('scene × aspect × product size × exactness × seed', async () => {
    let n = 0
    for (const scene of SCENES) {
      for (const aspect of ASPECTS) {
        for (const size of SIZES) {
          for (const exact of EXACT) {
            for (const seed of SEEDS) {
              const inputs: Record<string, unknown> = { image: LINK, scene_prompt: scene }
              if (aspect !== undefined) inputs.aspect = aspect
              if (size !== undefined) inputs.product_size = size
              if (exact !== undefined) inputs.keep_product_exact = exact
              if (seed !== undefined) inputs.seed = seed
              const node = { class_type: 'ProductShotNode', inputs }
              const p = await providerPlan(node, ON)
              expect(p.provider).toBe('fal')
              expect(p.endpoint).toBe(BRIA_PRODUCT_SHOT_APP)
              expect(p.backup).toBeUndefined()
              expect(p.prefix).toBe('product_shot')
              expect(checkPayload(SCHEMA, p.payload), JSON.stringify(inputs)).toEqual([])
              expect(Object.keys(p.payload).sort()).toEqual(['image_url', 'manual_placement_selection', 'num_results', 'placement_type', 'scene_description', 'shot_size'])
              // The hidden settings never reach the request.
              const want = briaProductShot({ image: 'IMG:bottle.png', scenePrompt: String(scene), aspect: aspect === undefined ? 'Square' : aspect })
              expect(p.payload).toEqual(want.payload)
              const shotSize = p.payload.shot_size as number[]
              expect(shotSize).toEqual(BRIA_SHOT_SIZES[typeof aspect === 'string' && aspect in BRIA_SHOT_SIZES ? aspect : 'Square'])
              expect(shotSize[0]! * shotSize[1]!).toBeLessThan(1.1e6)
              // The price's call is the planned endpoint, one picture, whatever the settings.
              const calls = editCalls('ProductShotNode', inputs, { families: ON })
              if ('refused' in calls) throw new Error(calls.refused)
              expect(calls.calls.map(x => [x.endpoint, x.tier, x.fallbacks])).toEqual([[p.endpoint, null, undefined]])
              expect(providerUsd('ProductShotNode', inputs, { families: ON })).toBe(USD)
              n++
            }
          }
        }
      }
    }
    expect(n).toBe(SCENES.length * ASPECTS.length * SIZES.length * EXACT.length * SEEDS.length)
  })
})

// ── Hand-written payloads ──────────────────────────────────────────────────

describe('hand-written payloads', () => {
  it('plain: the node\'s defaults (the default scene, Square), the schema\'s defaults where it has one', async () => {
    const p = await providerPlan(shot(), ON)
    expect(p.payload).toEqual({
      image_url: 'IMG:bottle.png',
      scene_description: 'on a clean marble countertop, soft natural window light, minimal studio setting, professional product photography, shallow depth of field',
      placement_type: 'manual_placement', manual_placement_selection: 'bottom_center', shot_size: [1024, 1024], num_results: 1,
    })
    for (const k of ['placement_type', 'manual_placement_selection', 'num_results'] as const) expect(p.payload[k]).toBe(PROPS[k]!.default)
  })

  it('every option set: the schema\'s own example scene, Landscape, a size, exactness off and a seed (none of the last three sent)', async () => {
    const p = await providerPlan(shot({ scene_prompt: PROPS.scene_description!.examples[0], aspect: 'Landscape', product_size: '40', keep_product_exact: false, seed: 99 }), ON)
    expect(p.payload).toEqual({
      image_url: 'IMG:bottle.png', scene_description: 'on a rock, next to the ocean, dark theme',
      placement_type: 'manual_placement', manual_placement_selection: 'bottom_center', shot_size: [1216, 832], num_results: 1,
    })
    expect(PROPS.image_url!.examples[0]).toMatch(/^https:\/\//) // one picture URL, as sent
  })

  it('odd values: a blank scene is the default scene, an unknown aspect is Square, Portrait is tall', async () => {
    expect((await providerPlan(shot({ scene_prompt: ' \n\t ', aspect: 'Panorama' }), ON)).payload).toMatchObject({ scene_description: PRODUCT_SHOT_DEFAULT_PROMPT, shot_size: [1024, 1024] })
    expect((await providerPlan(shot({ scene_prompt: '  a beach  ', aspect: 'Portrait' }), ON)).payload).toMatchObject({ scene_description: 'a beach', shot_size: [832, 1216] })
    await expect(plan(shot({ scene_prompt: 5 }), ON)).rejects.toThrow('The scene description must be text')
    await expect(plan({ class_type: 'ProductShotNode', inputs: { scene_prompt: 'a beach' } }, ON)).rejects.toThrow('There is no product picture')
  })

  it('no request rule refuses it (an empty scene is the default scene)', () => {
    expect(requestProblems({ 1: shot({ scene_prompt: '' }) })).toEqual([])
  })
})

// ── Family off: the SDXL call, unchanged ─────────────────────────────────

describe('with the family off, the SDXL call and price are unchanged', () => {
  const OLD = { image: 'IMG:bottle.png', prompt: 'a beach', img_size: '832, 1216', product_fill: '60', apply_img: false, seed: 11 }
  for (const [name, families] of [['no families', undefined], ['every other family', ALL_BUT]] as const) {
    it(`${name}: catacolabs/sdxl-ad-inpaint on Replicate, every setting sent, $0.16 (estimate)`, async () => {
      const node = shot({ scene_prompt: 'a beach', aspect: 'Portrait', product_size: '60', keep_product_exact: false, seed: 11 })
      const p = await providerPlan(node, families)
      expect([p.provider, p.endpoint, p.payload, p.backup]).toEqual(['replicate', PRODUCT_SHOT_SLUG, OLD, undefined])
      expect(providerUsd('ProductShotNode', node.inputs, families ? { families } : {})).toBe(0.16)
      expect(sizePricedInput('ProductShotNode', node.inputs, families)).toBeNull()
    })
  }
})

// ── Eligibility ────────────────────────────────────────────────────────────

describe('eligibility follows the family switch', () => {
  const take: ApiPrompt = { 9: { class_type: 'Image', inputs: { image: 'bottle.png' } }, 1: shot() }

  it('the row: no family of its own (the SDXL call stays retired, H2), the upgrade with the model\'s own name and the hidden settings', () => {
    expect(RUNNER_NODE_RULES.ProductShotNode).toEqual({
      upgrade: { family: FAMILY, label: 'Bria Product Shot', hiddenWidgets: HIDDEN },
      mustLink: ['image'],
      mustNotLink: ['scene_prompt', 'aspect'],
    })
    expect(classUpgradeOn('ProductShotNode', ON)).toMatchObject({ family: FAMILY, label: 'Bria Product Shot' })
    expect(classUpgradeOn('ProductShotNode', ALL_BUT)).toBeNull()
  })

  it('off: never taken, with every other family on (saved nodes run on ComfyUI)', () => {
    expect(isRunnerEligible(take, NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(take, ALL_BUT)).toBe(false)
  })

  it('on: taken alone or with everything; only with its picture linked and the scene and aspect not wired', () => {
    expect(isRunnerEligible(take, ON)).toBe(true)
    expect(isRunnerEligible(take, ALL)).toBe(true)
    // The hidden settings aren't read, so wiring them doesn't matter.
    expect(runnerTakesNode({ ...take, 1: shot({ image: ['9', 0], product_size: ['9', 0], seed: ['9', 0] }) }, '1', ON)).toBe(true)
    expect(runnerTakesNode({ 1: { class_type: 'ProductShotNode', inputs: { scene_prompt: 'x' } } }, '1', ON)).toBe(false)
    expect(runnerTakesNode({ ...take, 1: shot({ image: ['9', 0], scene_prompt: ['9', 0] }) }, '1', ON)).toBe(false)
    expect(runnerTakesNode({ ...take, 1: shot({ image: ['9', 0], aspect: ['9', 0] }) }, '1', ON)).toBe(false)
  })
})

// ── The hidden settings ────────────────────────────────────────────────────

describe('the settings Bria can\'t honour are hidden while the family is on', () => {
  it('upgradeHidesWidget: product size, exactness and seed, only while on, only on Product shot', () => {
    for (const w of HIDDEN) {
      expect(upgradeHidesWidget('ProductShotNode', w, ON), w).toBe(true)
      expect(upgradeHidesWidget('ProductShotNode', w, ALL), w).toBe(true)
      expect(upgradeHidesWidget('ProductShotNode', w, ALL_BUT), w).toBe(false)
      expect(upgradeHidesWidget('ProductShotNode', w, NO_FAMILIES), w).toBe(false)
    }
    for (const w of ['image', 'scene_prompt', 'aspect']) expect(upgradeHidesWidget('ProductShotNode', w, ALL), w).toBe(false)
    // Rotate camera (F10) hides nothing; a class with no upgrade neither.
    expect(upgradeHidesWidget('RotateCameraNode', 'seed', ALL)).toBe(false)
    expect(upgradeHidesWidget('EditImageNode', 'seed', ALL)).toBe(false)
  })
  // The mounted node body, seed lock and inspector: product-shot-hidden-settings.unit.spec.ts.
})

// ── blockedModelUses: runner-only while on (Ruling 10) ─────────────────────

describe('blockedModelUses: runner-only while the family is on', () => {
  const p: ApiPrompt = { 1: shot() }
  const use = [{ nodeId: '1', classType: 'ProductShotNode', value: 'Bria Product Shot', reason: 'runner-only', upgrade: true }]

  it('off: never refused by this check (ComfyUI runs the SDXL call)', () => {
    expect(blockedModelUses(p)).toEqual([])
    expect(blockedModelUses(p, { families: ALL_BUT })).toEqual([])
    expect(blockedPromptBody(p, { families: ALL_BUT })).toBeNull()
  })

  it('on: the runner takes it; the ComfyUI path refuses it', () => {
    expect(blockedModelUses(p, { families: ON, runnerTakes: true })).toEqual([])
    expect(blockedModelUses(p, { families: ON })).toEqual(use)
  })

  it('the refusal names the node and the model; the reason is the node that needs the engine', () => {
    const withEngine: ApiPrompt = { 9: { class_type: 'Image', inputs: { image: 'bottle.png' } }, 1: shot({ image: ['9', 0] }), 2: { class_type: 'KSampler', inputs: {} } }
    const titles: Record<string, string> = { 1: 'Bottle on a rock', 2: 'Old sampler', 9: 'Photo' }
    const r = blockedRunRefusal([{ prompt: withEngine, titleOf: id => titles[id] ?? 'Unnamed node' }], { runnerOn: true, families: ON })
    expect(r).toEqual({ title: '“Bottle on a rock” uses Bria Product Shot, which only runs in Sailor', description: 'Only the engine can run “Old sampler”.' })
    const alone = blockedRunRefusal([{ prompt: p, titleOf: () => 'Bottle on a rock' }], { runnerOn: true, families: ON })
    expect(alone!.description).toBe(NOT_TAKEN_AS_SET_UP_REASON)
    expect(blockedRunRefusal([{ prompt: p, titleOf: () => 'Bottle on a rock' }], { runnerOn: false, families: ON })).toBeNull()
  })

  it('the server\'s 400 body: ComfyUI\'s shape, the node named by its class\'s plain name, no model widget pointed at', () => {
    const body = blockedPromptBody(p, { families: ON })!
    expect(body.error.message).toContain('“Product shot” uses Bria Product Shot, which only runs in Sailor.')
    expect(body.node_errors['1']).toMatchObject({ class_type: 'ProductShotNode', errors: [{ type: 'value_not_in_list', extra_info: {} }] })
    expect(blockedModelsResponse(p, use as any, { families: ON }).node_errors['1']).toBeTruthy()
  })
})

// ── Hosted: the SDXL refusal only while the family is off ──────────────────

describe('hosted ComfyUI path: the SDXL refusal stays while off; on, the node is runner-only', () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })
  const graph: ApiPrompt = { 1: { class_type: 'LoadImage', inputs: { image: 'p.png' } }, 2: { class_type: 'ProductShotNode', inputs: { image: ['1', 0], scene_prompt: 'a beach' } }, 3: { class_type: 'SaveImage', inputs: { images: ['2', 0] } } }
  const meterDeps = () => ({
    priceGraph: vi.fn(() => ({ credits: 5, version: 'test', breakdown: [] })),
    spendGuard: vi.fn(async () => {}),
    validateFileRefs: vi.fn(async () => {}),
    moderatePrompt: vi.fn(async () => ({ ok: true as const })),
    hold: vi.fn(async () => ({ ok: true as const, holdId: 7 })),
    getAvailable: vi.fn(async () => 3),
    forward: vi.fn(async () => ({ status: 200, body: { prompt_id: 'p1', number: 1, node_errors: {} } })),
    registerRun: vi.fn(async () => {}),
    startSettle: vi.fn(),
    releaseHold: vi.fn(async () => {}),
  })
  const switches = (families: ReadonlySet<RunnerFamily>) => {
    process.env.NUXT_RUNNER_ENABLED = 'true'
    process.env.NUXT_RUNNER_FAMILIES = [...families].join(',')
  }

  it('off (every other family on): "being upgraded", before any price, hold or forward — unchanged', async () => {
    switches(ALL_BUT)
    expect(retiredEngineRefusal(graph)!.error.message).toBe(PRODUCT_SHOT_UPGRADING)
    const d = meterDeps()
    const r = await meterGraphSubmit('u1', { prompt: graph }, d as any)
    expect([r.status, r.body.error.message]).toEqual([400, PRODUCT_SHOT_UPGRADING])
    expect(d.priceGraph).not.toHaveBeenCalled()
    expect(d.hold).not.toHaveBeenCalled()
  })

  it('on: no "being upgraded" refusal (Bria is priced); the ComfyUI path refuses it as runner-only instead', async () => {
    switches(ON)
    expect(retiredEngineRefusal(graph)).toBeNull()
    expect(blockedPromptRefusal(graph)!.error.message).toContain('“Product shot” uses Bria Product Shot, which only runs in Sailor.')
    const d = meterDeps()
    const r = await meterGraphSubmit('u1', { prompt: graph }, d as any)
    expect(r.status).toBe(400)
    expect(r.body.error.message).toContain('uses Bria Product Shot, which only runs in Sailor')
    expect(d.priceGraph).not.toHaveBeenCalled()
    expect(d.hold).not.toHaveBeenCalled()
    expect(d.forward).not.toHaveBeenCalled()
  })
})

// ── The price ──────────────────────────────────────────────────────────────

describe('the price', () => {
  it('the card: fal\'s $0.04 a picture, verified, non-zero; the book carries it (lineup-f12, now lineup-f18)', () => {
    expect(EDIT_RATES[BRIA_PRODUCT_SHOT_APP]).toEqual({
      unit: 'per_image', usd: USD, service: 'fal', confidence: 'verified', read: '2026-09-24',
      source: 'https://fal.ai/models/fal-ai/bria/product-shot/llms.txt',
    })
    expect(PRICE_BOOK_VERSION).toBe('lineup-f18')
  })

  it('not size-priced: the shot is about 1 MP whatever the picture sent', () => {
    expect(sizePricedInput('ProductShotNode', shot().inputs, ON)).toBeNull()
    expect(providerUsd('ProductShotNode', shot().inputs, { families: ON, inputPixels: 40e6 })).toBe(USD)
  })

  for (const [name, o] of [['the defaults', {}], ['every option set', { aspect: 'Landscape', product_size: '40', keep_product_exact: false, seed: 9 }]] as const) {
    it(`${name}: $0.04; badge = charge = run estimate`, () => {
      const node = shot(o)
      const opts = { families: ON }
      const c = editCalls('ProductShotNode', node.inputs, opts)
      if ('refused' in c) throw new Error(c.refused)
      expect(editMaxUsd(c.calls[0]!)).toBe(USD)
      const credits = creditsForUsd(USD)
      expect(credits).toBeGreaterThan(0)
      expect(nodeCredits('ProductShotNode', node.inputs, opts)).toBe(credits)
      const total = priceGraph({ 1: node, 2: SINK }, { families: ON }).credits
      expect(total).toBe(credits + 1) // + base render
      expect(nodeCreditEstimate('ProductShotNode', node.inputs, opts)).toBe(total)
      const inputs = node.inputs as Record<string, unknown>
      const names = Object.keys(inputs).filter(n => n !== 'image')
      const est = estimateUsdForNodes([{
        id: '1', type: 'ProductShotNode', widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => inputs[n]),
        linkedInputs: ['image'], inputPixels: null,
      }], { hosted: true, families: ON })!
      expect(est.hostedCredits).toBe(total)
    })
  }

  it('off, the badge, charge and estimate stay the SDXL price', () => {
    const credits = creditsForUsd(0.16)
    expect(priceGraph({ 1: shot(), 2: SINK }, { families: ALL_BUT }).credits).toBe(credits + 1)
    expect(priceGraph({ 1: shot(), 2: SINK }).credits).toBe(credits + 1)
    expect(nodeCreditEstimate('ProductShotNode', shot().inputs)).toBe(credits + 1)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

// A real 64 × 64 PNG (the builder's file check reads its first bytes).
const PNG = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).png().toBuffer()
const JPEG = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).jpeg().toBuffer()
const WEBP = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).webp().toBuffer()
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')
/** `size` bytes that start as a PNG (the signature, then zeros). */
const pngOfSize = (size: number) => { const b = Buffer.alloc(size); PNG.copy(b, 0, 0, 8); return b }

// ── The picture Bria takes (F12 fix round 1) ───────────────────────────────

describe('the picture Bria takes: up to 12 MB, JPEG, PNG or WebP, refused before the hand-off', () => {
  it('the messages are plain', () => {
    expect(PRODUCT_SHOT_TOO_LARGE).toBe('Product shot takes pictures up to 12 MB. Make this one smaller first.')
    expect(PRODUCT_SHOT_WRONG_FORMAT).toBe('Product shot takes JPEG, PNG or WebP pictures.')
    // "Maximum file size 12MB", read as the smaller 12,000,000 bytes.
    expect(PROPS.image_url!.description).toContain('Accepted formats are jpeg, jpg, png, webp. Maximum file size 12MB.')
    expect(PRODUCT_SHOT_MAX_BYTES).toBe(12_000_000)
  })

  it('the format comes from the bytes, never the name', () => {
    expect(pictureFormat(PNG)).toBe('png')
    expect(pictureFormat(JPEG)).toBe('jpeg')
    expect(pictureFormat(WEBP)).toBe('webp')
    for (const b of [GIF, Buffer.from('png'), Buffer.alloc(0), Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), PNG.subarray(0, 7)]) expect(pictureFormat(b)).toBeNull()
  })

  it('on: at 12,000,000 bytes it goes; one more is too large; another format is refused', () => {
    expect(inputFileProblem('ProductShotNode', pngOfSize(PRODUCT_SHOT_MAX_BYTES), ON)).toBeNull()
    expect(inputFileProblem('ProductShotNode', pngOfSize(PRODUCT_SHOT_MAX_BYTES + 1), ALL)).toBe(PRODUCT_SHOT_TOO_LARGE)
    for (const ok of [PNG, JPEG, WEBP]) expect(inputFileProblem('ProductShotNode', ok, ON)).toBeNull()
    expect(inputFileProblem('ProductShotNode', GIF, ON)).toBe(PRODUCT_SHOT_WRONG_FORMAT)
  })

  it('off, or any other node: no check, and no file is read', async () => {
    expect(checkedInputFile('ProductShotNode', ALL_BUT)).toBeNull()
    expect(checkedInputFile('RotateCameraNode', ALL)).toBeNull()
    expect(checkedInputFile('EditImageNode', ALL)).toBeNull()
    expect(inputFileProblem('ProductShotNode', GIF, ALL_BUT)).toBeNull()
    const read = vi.fn(async () => new Uint8Array(GIF))
    const files = () => [{ filename: 'a.gif' }]
    expect(await linkedFileProblem(shot(), files, read, ALL_BUT)).toBeNull()
    expect(await linkedFileProblem({ class_type: 'RotateCameraNode', inputs: { image: LINK } }, files, read, ALL)).toBeNull()
    expect(await linkedFileProblem({ class_type: 'EditImageNode', inputs: { input_image: LINK, image: LINK } }, files, read, ALL)).toBeNull()
    expect(read).not.toHaveBeenCalled()
    // On: exactly the one file the builder sends (the first on the link) is read.
    expect(await linkedFileProblem(shot(), () => [{ filename: 'a.gif' }, { filename: 'b.png' }], read, ON)).toBe(PRODUCT_SHOT_WRONG_FORMAT)
    expect(read.mock.calls).toEqual([[{ filename: 'a.gif' }]])
    // No picture linked, no file on the link, or an unreadable one: left to the hand-off.
    expect(await linkedFileProblem(shot({ image: undefined }), files, read, ON)).toBeNull()
    expect(await linkedFileProblem(shot(), () => [], read, ON)).toBeNull()
    expect(await linkedFileProblem(shot(), files, async () => { throw new Error('gone') }, ON)).toBeNull()
  })
})

describe('the runner engine', () => {
  const take: ApiPrompt = {
    11: { class_type: 'Image', inputs: { image: 'bottle.png' } },
    1: { class_type: 'ProductShotNode', inputs: { image: ['11', 0], scene_prompt: 'on a rock, next to the ocean', aspect: 'Square', product_size: '60', keep_product_exact: false, seed: 5 } },
    2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  }
  const kit = (families: ReadonlySet<RunnerFamily>) => {
    const k = makeKit({ hosted: true, deps: { families: () => families } })
    fs.writeFileSync(path.join(k.root, 'input', 'bottle.png'), PNG)
    return k
  }
  const start = (k: ReturnType<typeof makeKit>) => k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  for (const [name, families] of [['the family alone', ON], ['every family', ALL]] as const) {
    it(`${name}: the family's own fal endpoint, held and charged $0.04`, async () => {
      const k = kit(families)
      const { runId } = await start(k)
      await k.engine.settled(runId)
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
      const submitted = k.fal.submitted()
      expect(submitted.map(r => r.endpoint)).toEqual([BRIA_PRODUCT_SHOT_APP])
      expect(submitted[0]!.payload).toEqual({
        image_url: 'https://fal.storage/bottle.png', scene_description: 'on a rock, next to the ocean',
        placement_type: 'manual_placement', manual_placement_selection: 'bottom_center', shot_size: [1024, 1024], num_results: 1,
      })
      const credits = creditsForUsd(USD) + 1
      expect([...k.ledger.holds.values()].map(h => [h.credits, h.state, h.actual])).toEqual([[credits, 'settled', credits]])
      expect((await k.store.get(runId))!.status).toBe('done')
    })
  }

  for (const [name, bytes, message] of [
    ['a picture over 12 MB', () => pngOfSize(PRODUCT_SHOT_MAX_BYTES + 1), PRODUCT_SHOT_TOO_LARGE],
    ['a GIF named .png', () => GIF, PRODUCT_SHOT_WRONG_FORMAT],
  ] as const) {
    it(`${name}: the node fails in plain words before the hand-off; nothing sent, the hold released`, async () => {
      const k = kit(ON)
      fs.writeFileSync(path.join(k.root, 'input', 'bottle.png'), bytes())
      const { runId } = await start(k)
      await k.engine.settled(runId)
      expect(k.upload.mock.calls.length).toBe(0) // not toHaveBeenCalled: a failure would print the 12 MB buffer and run the worker out of memory
      expect(k.fal.reqs.size).toBe(0)
      expect(k.replicate.reqs.size).toBe(0)
      expect(ofType(k.seen, 'execution_error').map(m => m.data.exception_message)).toEqual([message])
      expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
    })
  }

  it('off (every other family on): refused, nothing held or sent', async () => {
    const k = kit(ALL_BUT)
    await expect(start(k)).rejects.toMatchObject({ statusCode: 400, data: { reason: RUNNER_NOT_ELIGIBLE } })
    expect(k.fal.reqs.size).toBe(0)
    expect(k.replicate.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })
})
