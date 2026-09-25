/**
 * Task F10 (model line-up): Rotate camera on Qwen Image Edit 2511 with the
 * multiple-angles LoRA, family `qwen-2511-angles`
 * (server/runner/generators/qwen2511Angles.ts): fal, no backup, priced per
 * megapixel of the picture made (the input's size).
 *
 * The family moves the whole node (eligibility.ts RunnerNodeRule.upgrade):
 * while it is on, every Rotate camera node runs the new model, in the runner
 * only (Ruling 10: saved nodes move, user approved); off, the 2509 call and
 * its price are exactly as before.
 *
 * The family contract:
 *  - every payload over the gimbal grid fits the saved schema; the price
 *    reads what is sent (the endpoint and the picture's size);
 *  - hand-written expected payloads: plain (the gimbal's default), every
 *    angle set (roll as a phrase, a pitch below the schema's floor), and odd
 *    values, checked against the schema's own examples;
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the node on the ComfyUI path while the family
 *    is on, and never while it is off;
 *  - the price is verified and non-zero, and badge = charge = run estimate;
 *  - the engine, end to end: the family's own endpoint, the hold and charge.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, classUpgradeOn, isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { NOT_TAKEN_AS_SET_UP_REASON, blockedModelUses, blockedModelsResponse } from '#shared/runner/blockedModels'
import { blockedPromptBody, blockedRunRefusal } from '#shared/runner/needsEngine'
import { creditsForUsd } from '#shared/pricing/markup'
import { nodeCredits, providerUsd } from '#shared/pricing/nodePrice'
import { EDIT_RATES, editMaxUsd, editUsd } from '#shared/pricing/editRates'
import { LARGEST_INPUT_PIXELS, QWEN_2511_ANGLES_APP, editCalls, sizePricedInput } from '#shared/pricing/editSettings'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes, upstreamInputPixels, vueNodesToEstimateInput } from '~/lib/costEstimate'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { QWEN_2511_MAX_VERTICAL, QWEN_2511_MIN_VERTICAL, horizontalAngle, qwen2511Angles, verticalAngle } from '~~/server/runner/generators/qwen2511Angles'
import { QWEN_IMAGE_EDIT_PLUS_SLUG, parseCamera, rollPhrase } from '~~/server/runner/generators/refEdits'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { measuredInputPixels } from '~~/server/runner/metering'
import { ROTATE_CAMERA_TOO_LARGE, measuredInputProblem, requestProblems } from '~~/server/runner/requestRules'
import { PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit, ofType } from './__runner__/kit'

const FAMILY: RunnerFamily = 'qwen-2511-angles'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const REF_EDITS: ReadonlySet<RunnerFamily> = new Set(['ref-edits'])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]
const MP = 1_000_000

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>
type Fixture = ReturnType<typeof loadProviderSchema>

const SCHEMA = loadProviderSchema('fal', QWEN_2511_ANGLES_APP)

/** A saved schema's input object (its $ref followed). */
function inputSchema(f: Fixture): Record<string, any> {
  let input = f.input as Record<string, any>
  while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
  return input
}
const PROPS = inputSchema(SCHEMA).properties as Record<string, Record<string, any>>

/** A Rotate camera node as the canvas sends it, its picture linked from node 9. */
function rotate(o: { camera?: unknown, seed?: unknown } = {}) {
  return { class_type: 'RotateCameraNode', inputs: { image: LINK, camera: o.camera ?? '{"yaw":0,"pitch":0,"roll":0}', seed: o.seed ?? 0 } }
}
const cam = (yaw: unknown, pitch: unknown, roll: unknown) => JSON.stringify({ yaw, pitch, roll })

/** planNode for one node, the linked picture handed off as `IMG:<name>`. */
function plan(node: { class_type: string, inputs: Record<string, unknown> }, families?: ReadonlySet<RunnerFamily>) {
  return planNode({
    prompt: { 9: { class_type: 'Image', inputs: { image: 'first.png' } }, n: node },
    nodeId: 'n',
    filesFrom: () => [{ filename: 'first.png', subfolder: '', type: 'input' }],
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

// ── The saved schemas ──────────────────────────────────────────────────────

describe('the saved schemas', () => {
  it('fal\'s endpoint id is the one the snapshot checked (x-fal-metadata.endpointId), priced per megapixel', () => {
    expect(QWEN_2511_ANGLES_APP).toBe('fal-ai/qwen-image-edit-2511-multiple-angles')
    expect(SCHEMA.endpoint).toBe(QWEN_2511_ANGLES_APP)
    expect(SCHEMA.pricingText).toContain('$0.035 per megapixels')
  })

  it('the angles: azimuth 0–360, elevation −30–90, zoom 0–10 (default 5); no roll, but extra text; only the picture required', () => {
    expect(PROPS.horizontal_angle).toMatchObject({ type: 'number', minimum: 0, maximum: 360, default: 0 })
    expect(PROPS.vertical_angle).toMatchObject({ type: 'number', minimum: QWEN_2511_MIN_VERTICAL, maximum: QWEN_2511_MAX_VERTICAL, default: 0 })
    expect(PROPS.zoom).toMatchObject({ minimum: 0, maximum: 10, default: 5 })
    expect(Object.keys(PROPS).filter(k => /roll|tilt|rotation/i.test(k))).toEqual([])
    expect(PROPS.additional_prompt!.description).toContain('append to the automatically generated prompt')
    expect(inputSchema(SCHEMA).required).toEqual(['image_urls'])
    // With no image_size, the picture is made at the input's size (what the price reads).
    expect(PROPS.image_size!.description).toContain('If not provided, the size of the input image will be used')
  })

  it('no backup: Replicate\'s Qwen Image Edit 2511 is the base model (a text instruction, no angles, no LoRA; read 2026-09-24)', () => {
    expect(RUNNER_ROUTES['RotateCameraNode+qwen-2511-angles']).toMatchObject({ first: 'fal', backup: null })
    expect(RUNNER_ROUTES['RotateCameraNode+qwen-2511-angles']!.why).toBeTruthy()
    // The 2509 row is unchanged.
    expect(RUNNER_ROUTES.RotateCameraNode).toMatchObject({ first: 'replicate', backup: null })
  })
})

// ── The gimbal → the endpoint's sliders ─────────────────────────────────────

describe('the gimbal\'s angles as the endpoint\'s', () => {
  it('yaw → azimuth: the same compass (90 the right side, 180 the back), 0 up to 360', () => {
    const cases: [number, number][] = [
      [0, 0], [45, 45], [90, 90], [180, 180], [-90, 270], [-45, 315], [-180, 180], [359.5, 359.5],
      [360, 0], [450, 90], [-360, 0], [-0, 0], [-1e-20, 0], [Number.NaN, 0], [Infinity, 0], [-Infinity, 0],
    ]
    for (const [yaw, want] of cases) expect(horizontalAngle(yaw), String(yaw)).toBe(want)
  })

  it('pitch → elevation, held to −30…90 (NaN reads as 90, as the phrase reads it)', () => {
    const cases: [number, number][] = [
      [0, 0], [30, 30], [60, 60], [90, 90], [120, 90], [-15, -15], [-30, -30], [-60, -30], [-90, -30],
      [Number.NaN, 90], [Infinity, 90], [-Infinity, -30],
    ]
    for (const [pitch, want] of cases) expect(verticalAngle(pitch), String(pitch)).toBe(want)
  })

  it('roll: the phrase Python writes, as the extra text (none when level)', () => {
    expect(qwen2511Angles({ image: 'u', camera: { yaw: 0, pitch: 0, roll: 0 }, seed: 0 }).payload).not.toHaveProperty('additional_prompt')
    expect(qwen2511Angles({ image: 'u', camera: { yaw: 0, pitch: 0, roll: 4 }, seed: 0 }).payload).not.toHaveProperty('additional_prompt')
    expect(qwen2511Angles({ image: 'u', camera: { yaw: 0, pitch: 0, roll: 30 }, seed: 0 }).payload.additional_prompt).toBe('with a Dutch tilt clockwise')
    expect(qwen2511Angles({ image: 'u', camera: { yaw: 0, pitch: 0, roll: -90 }, seed: 0 }).payload.additional_prompt).toBe('with a heavy Dutch tilt counter-clockwise')
  })
})

// ── Settings grid ──────────────────────────────────────────────────────────

describe('settings grid: every request fits the schema, the price reads what is sent', () => {
  const YAWS: unknown[] = [0, 15, 45, 90, 135, 180, -45, -135, 359, 360, 720, -720, 12.5, '30', 'NaN', null, true]
  const PITCHES: unknown[] = [0, 7, 20, 45, 70, 85, 90, 120, -10, -29.9, -30, -45, -80, -90, '-60', 'Infinity']
  const ROLLS: unknown[] = [0, 3, -3, 10, -15, 45, -45, 90, 180, -179, 'NaN']
  const SEEDS: unknown[] = [0, 1, 42, 0xFFFFFFFF]

  it('yaw × pitch × roll × seed, odd values included', async () => {
    let n = 0
    for (const yaw of YAWS) {
      for (const pitch of PITCHES) {
        for (const roll of ROLLS) {
          for (const seed of SEEDS) {
            const node = rotate({ camera: cam(yaw, pitch, roll).replace(/"(NaN|Infinity|-Infinity)"/g, '$1'), seed })
            const p = await providerPlan(node, ON)
            expect(p.provider).toBe('fal')
            expect(p.endpoint).toBe(QWEN_2511_ANGLES_APP)
            expect(p.backup).toBeUndefined()
            expect(checkPayload(SCHEMA, p.payload), JSON.stringify(node.inputs)).toEqual([])
            const c = parseCamera(node.inputs.camera)
            const keys = ['image_urls', 'horizontal_angle', 'vertical_angle', 'output_format', 'num_images']
            if (rollPhrase(c.roll)) keys.push('additional_prompt')
            if (typeof seed === 'number' && seed > 0) keys.push('seed')
            expect(Object.keys(p.payload).sort()).toEqual(keys.sort())
            expect(p.payload.horizontal_angle).toBe(horizontalAngle(c.yaw))
            expect(p.payload.vertical_angle).toBe(verticalAngle(c.pitch))
            // The price's call is the planned endpoint, at the picture's size.
            const calls = editCalls('RotateCameraNode', node.inputs, { families: ON, inputPixels: 2 * MP })
            if ('refused' in calls) throw new Error(calls.refused)
            expect(calls.calls.map(x => [x.endpoint, x.outputPixels, x.fallbacks])).toEqual([[p.endpoint, 2 * MP, undefined]])
            n++
          }
        }
      }
    }
    expect(n).toBe(YAWS.length * PITCHES.length * ROLLS.length * SEEDS.length)
  })
})

// ── Hand-written payloads ──────────────────────────────────────────────────

describe('hand-written payloads', () => {
  it('plain: the gimbal\'s default (front, eye level, level), the schema\'s own example with its defaults', async () => {
    const p = await providerPlan(rotate(), ON)
    expect(p.payload).toEqual({ image_urls: ['IMG:first.png'], horizontal_angle: 0, vertical_angle: 0, output_format: 'png', num_images: 1 })
    // Every value sent that the schema's full example sets is the example's (its defaults).
    for (const k of ['output_format', 'num_images'] as const) expect(p.payload[k]).toBe(PROPS[k]!.default)
    expect(PROPS.horizontal_angle!.default).toBe(0)
    expect(PROPS.vertical_angle!.default).toBe(0)
    expect(PROPS.image_urls!.examples[0]).toHaveLength(1) // one picture, as sent
  })

  it('every angle set: yaw −45, pitch −60 (held to −30), roll 15 as a phrase, a seed', async () => {
    const p = await providerPlan(rotate({ camera: cam(-45, -60, 15), seed: 3 }), ON)
    expect(p.payload).toEqual({
      image_urls: ['IMG:first.png'], horizontal_angle: 315, vertical_angle: -30,
      additional_prompt: 'with the camera tilted slightly clockwise', seed: 3, output_format: 'png', num_images: 1,
    })
  })

  it('odd values: a full turn and a half, straight down, a heavy tilt; an unreadable camera is the front', async () => {
    const p = await providerPlan(rotate({ camera: '{"yaw":450,"pitch":95,"roll":-100}', seed: 0 }), ON)
    expect(p.payload).toEqual({
      image_urls: ['IMG:first.png'], horizontal_angle: 90, vertical_angle: 90,
      additional_prompt: 'with a heavy Dutch tilt counter-clockwise', output_format: 'png', num_images: 1,
    })
    const junk = await providerPlan(rotate({ camera: 'not json' }), ON)
    expect(junk.payload).toMatchObject({ horizontal_angle: 0, vertical_angle: 0 })
    await expect(plan(rotate({ camera: '{"yaw":"left"}' }), ON)).rejects.toThrow('The camera setting can’t be read')
    await expect(plan({ class_type: 'RotateCameraNode', inputs: { camera: '{}' } }, ON)).rejects.toThrow('There is no picture to turn')
  })

  it('no request rule refuses it (the endpoint takes no prompt)', () => {
    expect(requestProblems({ 1: rotate() })).toEqual([])
  })

  it('a measured picture above the input cap is refused while the family is on (F10 fix round 1)', () => {
    expect(ROTATE_CAMERA_TOO_LARGE).toBe('Rotate camera takes pictures up to about 19 megapixels. Make this one smaller first.')
    expect(measuredInputProblem('RotateCameraNode', LARGEST_INPUT_PIXELS + 1, ON)).toBe(ROTATE_CAMERA_TOO_LARGE)
    expect(measuredInputProblem('RotateCameraNode', 48 * MP, ALL)).toBe(ROTATE_CAMERA_TOO_LARGE)
    // At the cap, below it, or not measured (charged at the cap): sent.
    for (const px of [LARGEST_INPUT_PIXELS, MP, 1, undefined]) expect(measuredInputProblem('RotateCameraNode', px, ON)).toBeNull()
    // The 2509 call bills a flat price: no limit there, nor on any other class.
    expect(measuredInputProblem('RotateCameraNode', 48 * MP, ALL_BUT)).toBeNull()
    expect(measuredInputProblem('EditImageNode', 48 * MP, ALL)).toBeNull()
  })
})

// ── Family off: today's 2509 call, unchanged ───────────────────────────────

describe('with the family off, the 2509 call and price are unchanged', () => {
  const OLD = {
    prompt: 'viewed from the front-left, at a low angle, with the camera tilted slightly clockwise',
    image: ['IMG:first.png'], output_format: 'png', output_quality: 95, seed: 3,
  }
  for (const [name, families] of [['no families', undefined], ['ref-edits', REF_EDITS], ['every other family', ALL_BUT]] as const) {
    it(`${name}: Qwen Image Edit Plus on Replicate, the phrase, $0.03`, async () => {
      const p = await providerPlan(rotate({ camera: cam(-45, -30, 15), seed: 3 }), families)
      expect([p.provider, p.endpoint, p.payload, p.backup]).toEqual(['replicate', QWEN_IMAGE_EDIT_PLUS_SLUG, OLD, undefined])
      const opts = families ? { families } : {}
      expect(providerUsd('RotateCameraNode', rotate().inputs, opts)).toBe(0.03)
      expect(providerUsd('RotateCameraNode', rotate().inputs, { ...opts, inputPixels: 12 * MP })).toBe(0.03)
      expect(sizePricedInput('RotateCameraNode', rotate().inputs, families)).toBeNull()
    })
  }
})

// ── Eligibility ────────────────────────────────────────────────────────────

describe('eligibility follows the family switch', () => {
  const take: ApiPrompt = { 9: { class_type: 'Image', inputs: { image: 'first.png' } }, 1: rotate() }

  it('the row keeps ref-edits and names the upgrade family, with the model\'s own name', () => {
    expect(RUNNER_NODE_RULES.RotateCameraNode).toMatchObject({
      family: 'ref-edits', upgrade: { family: FAMILY, label: 'Qwen Image Edit 2511' }, mustLink: ['image'], mustNotLink: ['camera'],
    })
    expect(classUpgradeOn('RotateCameraNode', ON)).toEqual({ family: FAMILY, label: 'Qwen Image Edit 2511' })
    expect(classUpgradeOn('RotateCameraNode', ALL_BUT)).toBeNull()
    expect(classUpgradeOn('EditImageNode', ALL)).toBeNull()
  })

  it('off: taken only with ref-edits, as before', () => {
    expect(isRunnerEligible(take, NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(take, REF_EDITS)).toBe(true)
  })

  it('on: taken with or without ref-edits; only with its picture linked and the camera not wired', () => {
    expect(isRunnerEligible(take, ON)).toBe(true)
    expect(isRunnerEligible(take, ALL)).toBe(true)
    expect(runnerTakesNode({ 1: { class_type: 'RotateCameraNode', inputs: { camera: '{}', seed: 0 } } }, '1', ON)).toBe(false)
    expect(runnerTakesNode({ ...take, 1: { class_type: 'RotateCameraNode', inputs: { image: ['9', 0], camera: ['9', 0], seed: 0 } } }, '1', ON)).toBe(false)
  })
})

// ── blockedModelUses: runner-only while on (Ruling 10) ─────────────────────

describe('blockedModelUses: runner-only while the family is on', () => {
  const p: ApiPrompt = { 1: rotate() }
  const use = [{ nodeId: '1', classType: 'RotateCameraNode', value: 'Qwen Image Edit 2511', reason: 'runner-only', upgrade: true }]

  it('off: never refused, on either path (ComfyUI runs today\'s 2509 call)', () => {
    expect(blockedModelUses(p)).toEqual([])
    expect(blockedModelUses(p, { families: ALL_BUT })).toEqual([])
    expect(blockedModelUses(p, { families: ALL_BUT, runnerTakes: true })).toEqual([])
    expect(blockedPromptBody(p, { families: ALL_BUT })).toBeNull()
  })

  it('on: the runner takes it; the ComfyUI path refuses it', () => {
    expect(blockedModelUses(p, { families: ON, runnerTakes: true })).toEqual([])
    expect(blockedModelUses(p, { families: ON })).toEqual(use)
  })

  it('the refusal names the node and the model; the reason is the node that needs the engine', () => {
    const withEngine: ApiPrompt = { 9: { class_type: 'Image', inputs: { image: 'first.png' } }, 1: { ...rotate(), inputs: { ...rotate().inputs, image: ['9', 0] } }, 2: { class_type: 'KSampler', inputs: {} } }
    const titles: Record<string, string> = { 1: 'Side view', 2: 'Old sampler', 9: 'Photo' }
    const r = blockedRunRefusal([{ prompt: withEngine, titleOf: id => titles[id] ?? 'Unnamed node' }], { runnerOn: true, families: ON })
    expect(r).toEqual({ title: '“Side view” uses Qwen Image Edit 2511, which only runs in Sailor', description: 'Only the engine can run “Old sampler”.' })
    // Its own setup is what stops it (no picture linked): said plainly, never "its switch is off".
    const alone = blockedRunRefusal([{ prompt: p, titleOf: () => 'Side view' }], { runnerOn: true, families: ON })
    expect(alone!.description).toBe(NOT_TAKEN_AS_SET_UP_REASON)
    // Runner off in the browser: no families, the ComfyUI run goes ahead.
    expect(blockedRunRefusal([{ prompt: p, titleOf: () => 'Side view' }], { runnerOn: false, families: ON })).toBeNull()
  })

  it('the server\'s 400 body: ComfyUI\'s shape, the node named by its class\'s plain name, no model widget pointed at', () => {
    const body = blockedPromptBody(p, { families: ON })!
    expect(body.error.message).toContain('“Rotate camera” uses Qwen Image Edit 2511, which only runs in Sailor.')
    expect(body.node_errors['1']).toMatchObject({ class_type: 'RotateCameraNode', errors: [{ type: 'value_not_in_list', extra_info: {} }] })
    expect(blockedModelsResponse(p, use as any, { families: ON }).node_errors['1']).toBeTruthy()
  })
})

// ── The price ──────────────────────────────────────────────────────────────

describe('the price', () => {
  const charge = (inputPixels?: number, families: ReadonlySet<RunnerFamily> = ON) =>
    priceGraph({ 1: rotate(), 2: SINK }, { families, ...(inputPixels ? { inputPixels: { 1: inputPixels } } : {}) }).credits

  it('the card: fal\'s $0.035 per megapixel of the picture made, verified, non-zero; the book carries it (lineup-f10, now lineup-f14)', () => {
    expect(EDIT_RATES[QWEN_2511_ANGLES_APP]).toMatchObject({
      unit: 'per_megapixel', perMegapixel: 0.035, service: 'fal', confidence: 'verified', read: '2026-09-24',
      source: 'https://fal.ai/models/fal-ai/qwen-image-edit-2511-multiple-angles/llms.txt',
    })
    expect(PRICE_BOOK_VERSION).toBe('lineup-f14')
    // At least one megapixel; rounded up (the ruling).
    const at = (px: number | null) => editUsd({ endpoint: QWEN_2511_ANGLES_APP, tier: null, inputPixels: px, outputPixels: px })
    expect(at(null)).toBe(0.035)
    expect(at(1)).toBe(0.035)
    expect(at(MP)).toBe(0.035)
    expect(at(MP + 1)).toBe(0.07)
  })

  it('the picture is what is size-priced, only while the family is on', () => {
    expect(sizePricedInput('RotateCameraNode', rotate().inputs, ON)).toBe('image')
    expect(sizePricedInput('RotateCameraNode', rotate().inputs)).toBeNull()
  })

  const examples: { name: string, px?: number, usd: number }[] = [
    { name: '1 MP (1000 × 1000, the live check)', px: 1000 * 1000, usd: 0.035 },
    { name: '1024² (1.05 MP, rounded up to 2)', px: 1024 * 1024, usd: 0.07 },
    { name: '1920 × 1080 (3 MP)', px: 1920 * 1080, usd: 0.105 },
    { name: 'unmeasured: the input cap (19 MP)', usd: 0.665 },
    { name: 'above the cap: the cap', px: 50 * MP, usd: 0.665 },
  ]
  for (const ex of examples) {
    it(`${ex.name}: $${ex.usd}; badge = charge = run estimate`, () => {
      const opts = { families: ON, inputPixels: ex.px }
      expect(providerUsd('RotateCameraNode', rotate().inputs, opts)).toBe(ex.usd)
      const c = editCalls('RotateCameraNode', rotate().inputs, opts)
      if ('refused' in c) throw new Error(c.refused)
      expect(editMaxUsd(c.calls[0]!)).toBe(ex.usd)
      const credits = creditsForUsd(ex.usd)
      expect(credits).toBeGreaterThan(0)
      expect(nodeCredits('RotateCameraNode', rotate().inputs, opts)).toBe(credits)
      const total = charge(ex.px)
      expect(total).toBe(credits + 1) // + base render
      expect(nodeCreditEstimate('RotateCameraNode', rotate().inputs, opts)).toBe(total)
      const inputs = rotate().inputs as Record<string, unknown>
      const names = Object.keys(inputs).filter(n => n !== 'image')
      const est = estimateUsdForNodes([{
        id: '1', type: 'RotateCameraNode', widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => inputs[n]),
        linkedInputs: ['image'], inputPixels: ex.px ?? null,
      }], { hosted: true, families: ON })!
      expect(est.hostedCredits).toBe(total)
    })
  }

  it('the unmeasured badge is never below a measured charge', () => {
    const badge = nodeCreditEstimate('RotateCameraNode', rotate().inputs, { families: ON })!
    for (const px of [1, MP, 4 * MP, 12 * MP, LARGEST_INPUT_PIXELS, 80 * MP]) expect(badge).toBeGreaterThanOrEqual(charge(px))
  })

  it('off, the badge, charge and estimate stay the 2509 price', () => {
    const credits = creditsForUsd(0.03)
    expect(charge(undefined, ALL_BUT)).toBe(credits + 1)
    expect(priceGraph({ 1: rotate(), 2: SINK }).credits).toBe(credits + 1)
    expect(nodeCreditEstimate('RotateCameraNode', rotate().inputs)).toBe(credits + 1)
  })

  it('the canvas sees an upstream generator\'s size only while the family is on', () => {
    const gen = { id: '1', data: { nodeType: 'GenerateImageNode', inputs: [], widgetDefs: [{ name: 'model' }, { name: 'aspect_ratio' }, { name: 'model_options' }], widgetsValues: ['nano-banana-2', '1:1', '{"resolution":"1K"}'] } }
    const node = { id: '2', data: { nodeType: 'RotateCameraNode', inputs: [{ name: 'image', link: 1 }], widgetDefs: [{ name: 'camera' }, { name: 'seed' }], widgetsValues: ['{}', 0] } }
    const edges = [{ source: '1', target: '2', targetHandle: 'input-0' }]
    expect(upstreamInputPixels(node, [gen, node], edges, ON)).toBe(1024 * 1024)
    expect(upstreamInputPixels(node, [gen, node], edges)).toBeNull()
    expect(vueNodesToEstimateInput([node, gen], edges, ON)[0]!.inputPixels).toBe(1024 * 1024)
    expect(nodeCreditEstimate('RotateCameraNode', { camera: '{}', seed: 0, image: LINK }, { families: ON, inputPixels: 1024 * 1024 })).toBe(creditsForUsd(0.07) + 1)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take: ApiPrompt = {
    11: { class_type: 'Image', inputs: { image: 'photo.png' } },
    1: { class_type: 'RotateCameraNode', inputs: { image: ['11', 0], camera: cam(90, 30, 0), seed: 0 } },
    2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  }
  /** A real 1000 × 1000 PNG (1 MP), so the runner measures what it sends. */
  const kit = async (families: ReadonlySet<RunnerFamily>) => {
    const k = makeKit({ hosted: true, deps: { families: () => families } })
    const png = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#808080' } }).png().toBuffer()
    writeFileSync(join(k.root, 'input', 'photo.png'), png)
    return k
  }
  const start = (k: ReturnType<typeof makeKit>) => k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('measures the picture it sends: 1 MP', async () => {
    const png = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#808080' } }).png().toBuffer()
    const f: OutputFile = { filename: 'photo.png', subfolder: '', type: 'input' }
    expect(await measuredInputPixels(take[1]!, () => [f], async () => new Uint8Array(png), ON)).toBe(MP)
    expect(await measuredInputPixels(take[1]!, () => [f], async () => new Uint8Array(png))).toBeUndefined()
  })

  for (const [name, families] of [['the family alone', ON], ['every family (ref-edits too)', ALL]] as const) {
    it(`${name}: the family's own fal endpoint, held at the cap, charged the measured 1 MP`, async () => {
      const k = await kit(families)
      const { runId } = await start(k)
      await k.engine.settled(runId)
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
      const submitted = k.fal.submitted()
      expect(submitted.map(r => r.endpoint)).toEqual([QWEN_2511_ANGLES_APP])
      expect(submitted[0]!.payload).toEqual({
        image_urls: ['https://fal.storage/photo.png'], horizontal_angle: 90, vertical_angle: 30, output_format: 'png', num_images: 1,
      })
      const holds = [...k.ledger.holds.values()]
      expect(holds.map(h => h.credits)).toEqual([creditsForUsd(0.665) + 1])
      expect(holds.map(h => [h.state, h.actual])).toEqual([['settled', creditsForUsd(0.035) + 1]])
      expect((await k.store.get(runId))!.status).toBe('done')
    })
  }

  it('ref-edits alone: today\'s 2509 call on Replicate, at its own price', async () => {
    const k = await kit(REF_EDITS)
    const { runId } = await start(k)
    await k.engine.settled(runId)
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.submitted().map(r => [r.endpoint, r.payload])).toEqual([[QWEN_IMAGE_EDIT_PLUS_SLUG, {
      prompt: 'viewed from the right side, at a high angle', image: ['https://fal.storage/photo.png'], output_format: 'png', output_quality: 95,
    }]])
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[creditsForUsd(0.03) + 1, creditsForUsd(0.03) + 1]])
  })

  // F10 fix round 1 (controller ruling): fal makes the picture at the input's
  // size and the price stops at the cap, so a larger input is refused.
  it('a picture above the input cap (5000 × 4000, 20 MP): the node fails in plain words, nothing sent, the hold released', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const big = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#808080' } }).png().toBuffer()
    writeFileSync(join(k.root, 'input', 'photo.png'), big)
    const { runId } = await start(k)
    await k.engine.settled(runId)
    expect(k.fal.reqs.size).toBe(0)
    expect(k.replicate.reqs.size).toBe(0)
    expect(k.upload).not.toHaveBeenCalled()
    expect(ofType(k.seen, 'execution_error').map(m => m.data.exception_message)).toEqual([ROTATE_CAMERA_TOO_LARGE])
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })

  it('neither family: refused, nothing held or sent', async () => {
    const k = await kit(new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY && f !== 'ref-edits')))
    await expect(start(k)).rejects.toThrow()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.replicate.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })
})
