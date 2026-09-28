/**
 * Task F11 (model line-up): Nano Banana 2 in "Blend scene", runner-only,
 * family `nano-banana-2-blend`. The nano actions' own call:
 * google/nano-banana-2 on Replicate at 1K, fal's Nano Banana 2 edit the
 * backup (twins.ts nanoBananaOnFal); the instruction is `blendInstruction`
 * from the node's toggles, or the node's own prompt, as for the other models.
 * The first "Nano Banana" is hidden (hidden, never removed: saved nodes keep
 * its call and price). While the family is on, a new Blend scene starts on
 * Nano Banana 2.
 *
 * The family contract:
 *  - every payload over the settings grid fits both saved schemas; the price
 *    reads what is sent (settings parity);
 *  - hand-written expected payloads: plain (the node's defaults, a picture
 *    linked) and every option set; the same call a nano action makes;
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the Blend menu hides it while the family is off, and makes it the
 *    default while on;
 *  - the price is verified and non-zero, and badge = charge = run estimate;
 *  - the engine, end to end: the family's own endpoint, the hold.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, isRunnerEligible } from '#shared/runner/eligibility'
import { NOT_TAKEN_AS_SET_UP_REASON, blockedModelUses } from '#shared/runner/blockedModels'
import { blockedRunRefusal } from '#shared/runner/needsEngine'
import { __resetModelMenusForTests, applyModelOverlay, menuDefault, menuHiddenValues, modelMenu } from '#shared/runner/modelMenus'
import { creditsForUsd, usdChargedAtCost } from '#shared/pricing/markup'
import { nodeCredits, providerUsd } from '#shared/pricing/nodePrice'
import { EDIT_RATES, editMaxUsd } from '#shared/pricing/editRates'
import { editCalls } from '#shared/pricing/editSettings'
import { EDIT_MODEL_MENUS } from '~~/app/data/edit-model-options'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes } from '~/lib/costEstimate'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { NANO_BANANA_2_EDIT_APP, blendInstruction } from '~~/server/runner/generators/edit'
import { NANO_BANANA_2_SLUG } from '~~/server/runner/generators/actions'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const FAMILY: RunnerFamily = 'nano-banana-2-blend'
const OPTION = 'Nano Banana 2'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>

const REP = loadProviderSchema('replicate', NANO_BANANA_2_SLUG)
const FAL = loadProviderSchema('fal', NANO_BANANA_2_EDIT_APP)

/** The instruction with every toggle on (the node's defaults). */
const ALL_TOGGLES = blendInstruction({ unifyLighting: true, contactShadows: true, matchCameraLook: true, preserveIdentity: true })

/** A "Blend scene" node on Nano Banana 2, its picture linked from node 9, every widget as the canvas sends it. */
function blend(o: Partial<Record<'unify_lighting' | 'contact_shadows' | 'match_camera_look' | 'preserve_identity', unknown>> & { prompt?: unknown, format?: unknown, seed?: unknown, model?: unknown } = {}) {
  const inputs: Record<string, unknown> = {
    model: o.model ?? OPTION, image: LINK,
    unify_lighting: true, contact_shadows: true, match_camera_look: true, preserve_identity: true,
    keep_feather: 2, prompt: '', seed: 0, output_format: 'png',
  }
  for (const k of ['unify_lighting', 'contact_shadows', 'match_camera_look', 'preserve_identity'] as const) {
    if (o[k] !== undefined) inputs[k] = o[k]
  }
  if (o.prompt !== undefined) inputs.prompt = o.prompt
  if (o.format !== undefined) inputs.output_format = o.format
  if (o.seed !== undefined) inputs.seed = o.seed
  return { class_type: 'BlendSceneNode', inputs }
}

/** planNode for one node, the linked picture handed off as `IMG:<name>`. */
function plan(node: { class_type: string, inputs: Record<string, unknown> }) {
  return planNode({
    prompt: { 9: { class_type: 'Image', inputs: { image: 'scene.png' } }, n: node },
    nodeId: 'n',
    filesFrom: () => [{ filename: 'scene.png', subfolder: '', type: 'input' }],
    toUrl: async (f: OutputFile) => `IMG:${f.filename}`,
    gateOpen: false,
  })
}
async function providerPlan(node: { class_type: string, inputs: Record<string, unknown> }): Promise<ProviderPlan> {
  const p = await plan(node)
  if (p.kind !== 'provider') throw new Error('no provider call')
  return p
}

// ── The saved schemas ──────────────────────────────────────────────────────

describe('the saved schemas', () => {
  it('the two endpoints the nano actions already call: Replicate first, fal the backup', () => {
    expect(REP.endpoint).toBe('google/nano-banana-2')
    expect(NANO_BANANA_2_SLUG).toBe(REP.endpoint)
    expect(FAL.endpoint).toBe('fal-ai/nano-banana-2/edit')
    expect(NANO_BANANA_2_EDIT_APP).toBe(FAL.endpoint)
    expect(RUNNER_ROUTES[`BlendSceneNode:${OPTION}`]).toEqual({ first: 'replicate', backup: 'fal' })
    expect(RUNNER_ROUTES['RemoveObjectNode']).toEqual({ first: 'replicate', backup: 'fal' })
  })
})

// ── The request ────────────────────────────────────────────────────────────

describe('the request', () => {
  it('plain (the node\'s defaults, the picture linked): exactly the nano actions\' call, with every toggle\'s clause', async () => {
    const p = await providerPlan(blend())
    expect(p.provider).toBe('replicate')
    expect(p.endpoint).toBe('google/nano-banana-2')
    expect(p.prefix).toBe('blend_scene')
    expect(p.payload).toEqual({ prompt: ALL_TOGGLES, image_input: ['IMG:scene.png'], resolution: '1K', output_format: 'png' })
    expect(ALL_TOGGLES).toBe(
      'Blend all elements into a single cohesive, photorealistic image. '
      + 'Unify the lighting direction, color temperature and ambient tone across the whole scene. '
      + 'Add soft, realistic contact shadows where objects meet surfaces. '
      + 'Match film grain and depth of field. '
      + 'Keep each element\'s shape, position, proportions and identity unchanged. Do not move, rotate, rescale or reflow any element.',
    )
    expect(p.backup).toEqual({
      provider: 'fal', endpoint: 'fal-ai/nano-banana-2/edit',
      payload: { prompt: ALL_TOGGLES, image_urls: ['IMG:scene.png'], output_format: 'png', resolution: '1K', num_images: 1 },
    })
    expect(checkPayload(REP, p.payload)).toEqual([])
    expect(checkPayload(FAL, p.backup!.payload)).toEqual([])
  })

  it('the same call a nano action makes (Remove object): the same endpoint, resolution, format and backup', async () => {
    const action = await providerPlan({ class_type: 'RemoveObjectNode', inputs: { image: LINK, target: 'the cup' } })
    const mine = await providerPlan(blend())
    expect([mine.provider, mine.endpoint, mine.backup!.provider, mine.backup!.endpoint])
      .toEqual([action.provider, action.endpoint, action.backup!.provider, action.backup!.endpoint])
    expect(Object.keys(mine.payload).sort()).toEqual(Object.keys(action.payload).sort())
    expect([mine.payload.resolution, mine.payload.output_format]).toEqual([action.payload.resolution, action.payload.output_format])
  })

  it('every option set: the toggles off, a custom prompt (it wins), jpg, a seed (Replicate\'s Nano Banana 2 has none)', async () => {
    const p = await providerPlan(blend({
      unify_lighting: false, contact_shadows: false, match_camera_look: false, preserve_identity: false,
      prompt: '  Make it one warm evening photo.  ', format: 'jpg', seed: 7,
    }))
    expect(p.payload).toEqual({ prompt: 'Make it one warm evening photo.', image_input: ['IMG:scene.png'], resolution: '1K', output_format: 'jpg' })
    expect(p.backup!.payload).toEqual({ prompt: 'Make it one warm evening photo.', image_urls: ['IMG:scene.png'], output_format: 'jpeg', resolution: '1K', num_images: 1 })
    expect(checkPayload(REP, p.payload)).toEqual([])
    expect(checkPayload(FAL, p.backup!.payload)).toEqual([])
  })

  it('the toggles each add their clause; all off is the base sentence', async () => {
    const p = await providerPlan(blend({ unify_lighting: false, contact_shadows: false, match_camera_look: false, preserve_identity: false }))
    expect(p.payload.prompt).toBe('Blend all elements into a single cohesive, photorealistic image.')
    // A prompt of only spaces is no prompt: the toggles speak.
    expect((await providerPlan(blend({ prompt: ' \n ' }))).payload.prompt).toBe(ALL_TOGGLES)
  })

  it('no picture: the node fails in plain words before anything is sent', async () => {
    const n = blend()
    delete n.inputs.image
    await expect(plan(n)).rejects.toThrow('There is no picture to blend')
  })

  // The settings grid: 16 toggle sets × 5 prompts × 5 formats × 3 seeds = 1,200 cases.
  const BOOLS = [true, false]
  const PROMPTS: unknown[] = ['', '   ', 'a warm evening', 'ab', undefined]
  const FORMATS: unknown[] = ['png', 'jpg', 'jpeg', '', undefined]
  const SEEDS: unknown[] = [0, 7, 4294967295]
  it('every payload over the settings grid fits both schemas, and the price reads what is sent', async () => {
    let n = 0
    for (const ul of BOOLS) for (const cs of BOOLS) for (const cl of BOOLS) for (const pi of BOOLS) {
      for (const prompt of PROMPTS) for (const format of FORMATS) for (const seed of SEEDS) {
        const node = blend({ unify_lighting: ul, contact_shadows: cs, match_camera_look: cl, preserve_identity: pi, format, seed })
        if (prompt === undefined) delete node.inputs.prompt
        else node.inputs.prompt = prompt
        if (format === undefined) delete node.inputs.output_format
        const label = JSON.stringify(node.inputs)
        const p = await providerPlan(node)
        const custom = typeof prompt === 'string' ? prompt.trim() : ''
        const want = custom || blendInstruction({ unifyLighting: ul, contactShadows: cs, matchCameraLook: cl, preserveIdentity: pi })
        const jpg = format === 'jpg' || format === 'jpeg'
        expect(p.endpoint, label).toBe('google/nano-banana-2')
        expect(p.payload, label).toEqual({ prompt: want, image_input: ['IMG:scene.png'], resolution: '1K', output_format: jpg ? 'jpg' : 'png' })
        expect(checkPayload(REP, p.payload), label).toEqual([])
        // fal refuses a prompt under 3 characters: then there is no backup (planNode drops it).
        if (want.length >= 3) {
          expect(p.backup?.endpoint, label).toBe('fal-ai/nano-banana-2/edit')
          expect(checkPayload(FAL, p.backup!.payload), label).toEqual([])
        }
        else expect(p.backup, label).toBeUndefined()
        // Settings parity: the priced call is the call sent, at the resolution sent.
        const c = editCalls('BlendSceneNode', node.inputs)
        if ('refused' in c) throw new Error(c.refused)
        expect(c.calls, label).toHaveLength(1)
        expect(c.calls[0]!.endpoint, label).toBe(p.endpoint)
        expect(c.calls[0]!.tier, label).toBe(p.payload.resolution)
        expect(c.calls[0]!.fallbacks!.map(f => [f.endpoint, f.tier]), label).toEqual([['fal-ai/nano-banana-2/edit', '1K']])
        n++
      }
    }
    expect(n).toBe(16 * PROMPTS.length * FORMATS.length * SEEDS.length)
  })
})

// ── Eligibility ────────────────────────────────────────────────────────────

describe('eligibility follows the family switch', () => {
  const card = { class_type: 'Image', inputs: { image: 'scene.png' } }
  const take: ApiPrompt = { 9: card, 1: blend() }

  it('the row names the family; the other models keep theirs', () => {
    expect(RUNNER_NODE_RULES.BlendSceneNode!.models).toEqual({
      'Flux Kontext Pro': 'fal-edit', 'Flux 2 Pro': 'fal-edit', 'Nano Banana': 'nano-actions', 'Nano Banana 2': FAMILY,
    })
    // keep_subject is taken from a Frame's protect_mask only (Task F11b, runner-blend-keep.unit.spec.ts).
    expect(RUNNER_NODE_RULES.BlendSceneNode!.mustNotLink).toEqual(['prompt', 'keep_feather'])
    expect(RUNNER_NODE_RULES.BlendSceneNode!.linkSources).toEqual({ keep_subject: [['Compositor', 1]] })
  })

  it('off (no families, or every other family): not taken', () => {
    expect(isRunnerEligible(take)).toBe(false)
    expect(isRunnerEligible(take, NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(take, ALL_BUT)).toBe(false)
  })

  it('on: taken; only with its picture linked; never with the prompt wired, or keep_subject from anything but a Frame', () => {
    expect(isRunnerEligible(take, ON)).toBe(true)
    expect(isRunnerEligible(take, ALL)).toBe(true)
    const noPicture = blend()
    delete noPicture.inputs.image
    expect(isRunnerEligible({ 1: noPicture }, ON)).toBe(false)
    expect(isRunnerEligible({ 9: card, 1: { class_type: 'BlendSceneNode', inputs: { ...blend().inputs, keep_subject: LINK } } }, ON)).toBe(false)
    expect(isRunnerEligible({ 9: card, 1: { class_type: 'BlendSceneNode', inputs: { ...blend().inputs, prompt: LINK } } }, ON)).toBe(false)
  })

  it('the first Nano Banana is still taken with nano-actions, and only with it', () => {
    const old: ApiPrompt = { 9: card, 1: blend({ model: 'Nano Banana' }) }
    expect(isRunnerEligible(old, new Set<RunnerFamily>(['nano-actions']))).toBe(true)
    expect(isRunnerEligible(old, ON)).toBe(false)
  })
})

describe('blockedModelUses', () => {
  const p: ApiPrompt = { 1: blend() }
  const use = [{ nodeId: '1', classType: 'BlendSceneNode', value: OPTION, reason: 'runner-only' }]

  it('refuses the model while the family is off, on either path', () => {
    expect(blockedModelUses(p)).toEqual(use)
    expect(blockedModelUses(p, { families: ALL_BUT, runnerTakes: true })).toEqual(use)
  })

  it('lets it through only on a runner run with the family on; the ComfyUI path refuses it', () => {
    expect(blockedModelUses(p, { families: ON, runnerTakes: true })).toEqual([])
    expect(blockedModelUses(p, { families: ON })).toEqual(use)
  })

  it('the hidden Nano Banana is never refused, on either path', () => {
    const old: ApiPrompt = { 1: blend({ model: 'Nano Banana' }) }
    expect(blockedModelUses(old)).toEqual([])
    expect(blockedModelUses(old, { families: ALL, runnerTakes: true })).toEqual([])
  })

  it('a workflow that needs the engine is refused before it goes there, naming the model', () => {
    const withEngine: ApiPrompt = { 1: blend(), 2: { class_type: 'KSampler', inputs: {} } }
    const titles: Record<string, string> = { 1: 'Shelf blend', 2: 'Old sampler' }
    const r = blockedRunRefusal([{ prompt: withEngine, titleOf: id => titles[id] ?? 'Unnamed node' }], { runnerOn: true, families: ON })
    expect(r).not.toBeNull()
    expect(r!.title).toBe('“Shelf blend” uses Nano Banana 2, which only runs in Sailor')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: { 1: blend() }, titleOf: () => 'Shelf blend' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })

  it('switched on but set up in a way the runner doesn\'t take (a Frame\'s kept region wired in): it says so, never "its switch is off"', () => {
    const kept: ApiPrompt = {
      9: { class_type: 'Image', inputs: { image: 'scene.png' } },
      8: { class_type: 'Image', inputs: { image: 'mask.png' } },
      1: { class_type: 'BlendSceneNode', inputs: { ...blend().inputs, keep_subject: ['8', 1] } },
    }
    const r = blockedRunRefusal([{ prompt: kept, titleOf: () => 'Shelf blend' }], { runnerOn: true, families: ON })
    expect(r).toEqual({ title: '“Shelf blend” uses Nano Banana 2, which only runs in Sailor', description: NOT_TAKEN_AS_SET_UP_REASON })
  })
})

// ── The Blend menu ─────────────────────────────────────────────────────────

describe('the Blend scene menu', () => {
  afterEach(() => __resetModelMenusForTests())
  const baseline = () => JSON.parse(zlib.gunzipSync(readFileSync(join(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
  const cfg = (body: any) => body.BlendSceneNode.input.required.model[1]

  it('the options: Python\'s three in its order, Nano Banana 2 last, runner-only in its family; the first Nano Banana and Kontext hidden', () => {
    expect(EDIT_MODEL_MENUS['BlendSceneNode.model']!.options).toEqual([
      { value: 'Flux Kontext Pro', label: 'Flux Kontext Pro', hidden: true },
      { value: 'Flux 2 Pro', label: 'Flux 2 Pro' },
      { value: 'Nano Banana', label: 'Nano Banana', hidden: true },
      { value: OPTION, label: 'Nano Banana 2', runnerOnly: true, family: FAMILY },
    ])
    expect(cfg(baseline()).options).toEqual(['Flux Kontext Pro', 'Flux 2 Pro', 'Nano Banana'])
  })

  it('left out while the family is off, shown while on; every value stays a valid option', () => {
    const menu = modelMenu('BlendSceneNode')!
    expect(menuHiddenValues(menu, NO_FAMILIES)).toEqual(['Flux Kontext Pro', 'Nano Banana', OPTION])
    expect(menuHiddenValues(menu, ALL_BUT)).toEqual(['Flux Kontext Pro', 'Nano Banana', OPTION])
    expect(menuHiddenValues(menu, ON)).toEqual(['Flux Kontext Pro', 'Nano Banana'])
    for (const fams of [NO_FAMILIES, ON]) {
      expect(cfg(applyModelOverlay(baseline(), fams)).options).toEqual(['Flux Kontext Pro', 'Flux 2 Pro', 'Nano Banana', OPTION])
    }
  })

  it('a new node starts on Nano Banana 2 while the family is on, Flux 2 Pro while off; Python\'s own default is untouched', () => {
    expect(EDIT_MODEL_MENUS['BlendSceneNode.model']!.preference).toEqual([OPTION, 'Flux 2 Pro'])
    expect(menuDefault(modelMenu('BlendSceneNode')!, ON)).toBe(OPTION)
    expect(menuDefault(modelMenu('BlendSceneNode')!, ALL)).toBe(OPTION)
    expect(menuDefault(modelMenu('BlendSceneNode')!, NO_FAMILIES)).toBe('Flux 2 Pro')
    expect(menuDefault(modelMenu('BlendSceneNode')!, ALL_BUT)).toBe('Flux 2 Pro')
    expect(cfg(baseline()).default).toBe('Flux Kontext Pro')
    expect(cfg(applyModelOverlay(baseline(), ON)).default).toBe(OPTION)
    expect(cfg(applyModelOverlay(baseline(), NO_FAMILIES)).default).toBe('Flux 2 Pro')
  })

  it('a saved node keeps its model: the overlay changes only the default a new node gets', () => {
    // Saved values are node data; the menu still lists every one of them, hidden or not.
    for (const v of ['Flux Kontext Pro', 'Flux 2 Pro', 'Nano Banana', OPTION]) {
      expect(cfg(applyModelOverlay(baseline(), ON)).options).toContain(v)
    }
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  const charge = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'BlendSceneNode', inputs }, 2: SINK }).credits
  // Replicate's $0.067 with the markup, or fal's $0.08 backup at cost: whichever is higher (the nano actions' price).
  const USD = editMaxUsd({ endpoint: 'google/nano-banana-2', tier: '1K', inputPixels: null, outputPixels: null, fallbacks: [{ endpoint: 'fal-ai/nano-banana-2/edit', tier: '1K', inputPixels: null, outputPixels: null }] })!

  it('the cards: verified, non-zero, the nano actions\' own', () => {
    expect(EDIT_RATES['google/nano-banana-2']).toMatchObject({ unit: 'by_resolution', confidence: 'verified', service: 'replicate' })
    expect(EDIT_RATES['google/nano-banana-2']!.unit === 'by_resolution' && EDIT_RATES['google/nano-banana-2']!.byTier['1K']).toBe(0.067)
    expect(EDIT_RATES['fal-ai/nano-banana-2/edit']).toMatchObject({ unit: 'by_resolution', confidence: 'verified', service: 'fal' })
    expect(USD).toBe(Math.max(0.067, usdChargedAtCost(0.08)))
    expect(USD).toBeGreaterThan(0)
    expect(PRICE_BOOK_VERSION).toBe('r3-gen-3d')
  })

  const examples: { name: string, inputs: Record<string, unknown> }[] = [
    { name: 'the defaults (the live check)', inputs: blend().inputs },
    { name: 'every option set', inputs: blend({ unify_lighting: false, prompt: 'one warm photo', format: 'jpg', seed: 7 }).inputs },
  ]
  for (const ex of examples) {
    it(`${ex.name}: badge = charge = run estimate = a nano action's price`, () => {
      expect(providerUsd('BlendSceneNode', ex.inputs)).toBe(USD)
      const credits = creditsForUsd(USD)
      expect(credits).toBe(14)
      expect(nodeCredits('BlendSceneNode', ex.inputs)).toBe(credits)
      expect(nodeCredits('BlendSceneNode', ex.inputs)).toBe(nodeCredits('RemoveObjectNode', { image: LINK, target: 'the cup' }))
      const total = charge(ex.inputs)
      expect(total).toBe(credits + 1) // + base render
      expect(nodeCreditEstimate('BlendSceneNode', ex.inputs)).toBe(total)
      const names = Object.keys(ex.inputs)
      const est = estimateUsdForNodes([{ id: '1', type: 'BlendSceneNode', widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => ex.inputs[n]) }], { hosted: true })!
      expect(est.hostedCredits).toBe(total)
    })
  }

  it('the first Nano Banana keeps its call and price; a linked model is priced at the dearest the node offers', () => {
    expect(providerUsd('BlendSceneNode', blend({ model: 'Nano Banana' }).inputs)).toBe(0.039)
    const linked = providerUsd('BlendSceneNode', blend({ model: LINK }).inputs)!
    expect(linked).toBeGreaterThanOrEqual(USD)
    expect(linked).toBe(providerUsd('BlendSceneNode', blend({ model: 'Flux 2 Pro' }).inputs))
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take: ApiPrompt = {
    11: { class_type: 'Image', inputs: { image: 'scene.png' } },
    1: { class_type: 'BlendSceneNode', inputs: { ...blend().inputs, image: ['11', 0] } },
    2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  }
  const kit = (families: ReadonlySet<RunnerFamily>) => {
    const k = makeKit({ hosted: true, deps: { families: () => families } })
    writeFileSync(join(k.root, 'input', 'scene.png'), new Uint8Array([1]))
    return k
  }
  const start = (k: ReturnType<typeof makeKit>) => k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: Replicate\'s Nano Banana 2, held at the nano actions\' price, a real output', async () => {
    const k = kit(ON)
    const { runId } = await start(k)
    await k.engine.settled(runId)
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    const submitted = k.replicate.submitted()
    expect(submitted.map(r => r.endpoint)).toEqual(['google/nano-banana-2'])
    expect(submitted[0]!.payload).toEqual({ prompt: ALL_TOGGLES, image_input: ['https://fal.storage/scene.png'], resolution: '1K', output_format: 'png' })
    expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([14 + 1])
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
