/**
 * R3.12: text effect, sketch to image and face references (family
 * `image-extras`) — Text effect (Ideogram V3 Turbo to generate the word, Flux
 * Kontext Pro to restyle a wired picture of it), Sketch to image (Nano Banana)
 * and Generate face references (Ideogram Character) — against what their real
 * Python sends and returns (fixtures/runner-paid-image-extras.json,
 * scripts/runner_paid_fixtures.py --group image-extras), priced per call on
 * both paths from Replicate's billing tables.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createFakeReplicate, makeKit } from './__runner__/kit'
import { normalizeSent, readerFor, runPaidCase, wireText, type PaidCase } from './__runner__/paidParity'
import { checkPayload, loadProviderSchema, type ProviderSchemaFixture } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { IMAGE_OUTPUT_CLASSES, PAID_PICTURE_FAMILY, RUNNER_NODE_RULES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import {
  FACE_SEED_TOO_LARGE, FACE_SLUG, IDEOGRAM_SEED_MAX, IMAGE_EXTRAS_CLASSES, SKETCH_SLUG, TEXT_EFFECT_ASPECT_RATIOS, TEXT_EFFECT_DEFAULT_ID,
  TEXT_EFFECT_IDS, TEXT_EFFECT_NEEDS_TEXT, TEXT_EFFECT_SEED_TOO_LARGE, TEXT_GENERATE_SLUG, TEXT_RESTYLE_SLUG, type ImageExtrasClass,
} from '#shared/runner/imageExtras'
import { PAID_RATES, otherCardFor } from '#shared/pricing/paidRates'
import { EDIT_RATES } from '#shared/pricing/editRates'
import { PAID_NODE_CLASSES, paidNoCall } from '#shared/pricing/paidSettings'
import { PRE_R3_FLAT, readsEstimateCard } from '#shared/pricing/estimateFloor'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { BASE_RENDER_CREDITS, GRAPH_NODE_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { PAID_TEXT_INPUTS, extraPromptTexts, stageEstimate } from '~~/server/runner/metering'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { firstOutputUrl } from '~~/server/runner/generators/repair'
import { TEXT_EFFECTS, aspectOk, buildEditPrompt, buildPrompt, editAspect } from '~~/server/runner/generators/textEffects'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { requestProblems } from '~~/server/runner/requestRules'
import { PROVIDER_SEED_MAX, rerolledSeed, seedRerollMax } from '#shared/runner/seedLimits'
import { MODEL_COSTS, costForModel } from '~~/server/utils/priceBook'
import { resolveCredits } from '~~/server/utils/requestMeter'

interface PyEffect { id: string; label: string; prompt_template: string; edit_template: string; model_slug: string; medium: string; default_freedom: number }
interface Catalogue {
  effects: PyEffect[]
  default_effect: string
  match_input: string
  node_ratios: string[]
  prompts: { effect: string; text: string; prompt: string }[]
  edit_prompts: { effect: string; freedom: number | null; prompt: string }[]
  aspect_ok: Record<string, string>
  edit_aspect: Record<string, string>
}
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-image-extras.json'), 'utf8')) as { catalogue: Catalogue; cases: PaidCase[] }
const CASES = FIXTURE.cases
const CAT = FIXTURE.catalogue
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'image-extras'])
const OUT = 'https://r.test/extras/out.png'

const caseNamed = (name: string): PaidCase => {
  const c = CASES.find(x => x.name === name)
  if (!c) throw new Error(`no fixture case ${name}`)
  return c
}

/** The runner's refusals, before the hold: Python's own words for a blank text; a seed Replicate's Ideogram refuses. */
function expectedRefusal(c: PaidCase): string | null {
  if (c.class_type === 'TextEffectNode' && !(c.pictures ?? []).length) {
    if (c.error) return TEXT_EFFECT_NEEDS_TEXT
    if ((c.widgets.seed as number) > IDEOGRAM_SEED_MAX) return TEXT_EFFECT_SEED_TOO_LARGE
  }
  if (c.class_type === 'ConsistentFaceNode' && (c.widgets.seed as number) > IDEOGRAM_SEED_MAX) return FACE_SEED_TOO_LARGE
  return null
}

/** A LoadImage feeding each picture input, and a card showing the result (these classes are not output nodes). */
function withPictures(c: PaidCase, id = 'n'): ApiPrompt {
  const p: ApiPrompt = { [id]: { class_type: c.class_type, inputs: { ...c.widgets } }, ...readerFor(c.class_type, id) }
  for (const name of c.pictures ?? []) {
    p[`p_${name}`] = { class_type: 'LoadImage', inputs: { image: `${name}.png`, upload: 'image' } }
    p[id]!.inputs[name] = [`p_${name}`, 0]
  }
  return p
}

async function planOf(c: PaidCase): Promise<Extract<NodePlan, { kind: 'provider' }>> {
  return await planNode({
    prompt: withPictures(c), nodeId: 'n', gateOpen: false,
    filesFrom: link => (String(link[0]).startsWith('p_') ? [{ filename: `${String(link[0]).slice(2)}.png`, subfolder: '', type: 'input' }] : []),
    toUrl: async f => `https://fal.storage/${f.filename}`,
  }) as Extract<NodePlan, { kind: 'provider' }>
}

/** Python's `IMG:<input>` is the handed-off picture. */
const asPython = (c: PaidCase, payload: Record<string, unknown>) => normalizeSent([{ provider: 'replicate', endpoint: '', payload }], c.pictures ?? [])[0]!.payload

/** A PNG of w × h (one colour). */
async function png(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer()
}

async function writePictures(root: string, c: PaidCase): Promise<void> {
  for (const name of c.pictures ?? []) writeFileSync(join(root, 'input', `${name}.png`), await png(8, 6))
}

// ── The published inputs (each model page's schema, read 2026-09-27), until the controller saves them ──

const publishedInput = (properties: Record<string, unknown>, required: string[]): ProviderSchemaFixture => ({
  endpoint: '', fetchedAt: '2026-09-27', input: { type: 'object', required, properties }, output: {}, components: { schemas: {} },
})
const uri = { type: 'string', format: 'uri' }
const IDEOGRAM_RATIOS = ['1:3', '3:1', '1:2', '2:1', '9:16', '16:9', '10:16', '16:10', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '1:1']
const PUBLISHED: Record<string, ProviderSchemaFixture> = {
  [TEXT_GENERATE_SLUG]: publishedInput({
    mask: { ...uri, nullable: true }, seed: { type: 'integer', maximum: 2147483647, nullable: true }, image: { ...uri, nullable: true },
    prompt: { type: 'string' }, aspect_ratio: { enum: IDEOGRAM_RATIOS, type: 'string', default: '1:1' },
    style_type: { enum: ['None', 'Auto', 'General', 'Realistic', 'Design'], type: 'string', default: 'None' },
    magic_prompt_option: { enum: ['Auto', 'On', 'Off'], type: 'string', default: 'Auto' },
  }, ['prompt']),
  [TEXT_RESTYLE_SLUG]: publishedInput({
    seed: { type: 'integer', nullable: true }, prompt: { type: 'string' }, input_image: { ...uri, nullable: true },
    aspect_ratio: { enum: ['match_input_image', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '21:9', '9:21', '2:1', '1:2'], type: 'string', default: 'match_input_image' },
    output_format: { enum: ['jpg', 'png'], type: 'string', default: 'png' },
    safety_tolerance: { type: 'integer', default: 2, maximum: 6, minimum: 0 }, prompt_upsampling: { type: 'boolean', default: false },
  }, ['prompt']),
  [FACE_SLUG]: publishedInput({
    mask: { ...uri, nullable: true }, seed: { type: 'integer', maximum: 2147483647, nullable: true }, image: { ...uri, nullable: true },
    prompt: { type: 'string' }, style_type: { enum: ['Auto', 'Fiction', 'Realistic'], type: 'string', default: 'Auto' },
    aspect_ratio: { enum: IDEOGRAM_RATIOS, type: 'string', default: '1:1' },
    rendering_speed: { enum: ['Default', 'Turbo', 'Quality'], type: 'string', default: 'Default' },
    magic_prompt_option: { enum: ['Auto', 'On', 'Off'], type: 'string', default: 'Auto' },
    character_reference_image: uri,
  }, ['prompt', 'character_reference_image']),
}
/** The saved schema where the controller has snapshotted it (Nano Banana's is), else the published inputs above. */
function schemaOf(slug: string): ProviderSchemaFixture {
  const file = join(__dirname, 'fixtures', 'provider-schemas', 'replicate', `${slug.replace('/', '__')}.json`)
  return existsSync(file) ? loadProviderSchema('replicate', slug) : PUBLISHED[slug]!
}

describe('the fixture', () => {
  it('covers every effect on both paths at every freedom, every ratio, the seeds, and Sketch and Face', () => {
    const names = new Set(CASES.map(c => c.name))
    expect(new Set(CASES.map(c => c.class_type))).toEqual(new Set(IMAGE_EXTRAS_CLASSES))
    for (const id of TEXT_EFFECT_IDS) {
      for (const path of ['generate', 'restyle']) {
        for (const f of ['0.0', '0.12', '0.45', '0.78', '1.0']) expect(names.has(`text effect · ${path} · ${id} · freedom ${f}`), `${id} ${path} ${f}`).toBe(true)
        expect(names.has(`text effect · ${path} · ${id} · freedom missing`), `${id} ${path}`).toBe(true)
      }
    }
    for (const ar of TEXT_EFFECT_ASPECT_RATIOS) for (const path of ['generate', 'restyle']) expect(names.has(`text effect · ${path} · ratio ${ar}`), ar).toBe(true)
    for (const s of [0, 42, 2 ** 31 - 1, 2 ** 31]) {
      for (const path of ['generate', 'restyle']) expect(names.has(`text effect · ${path} · seed ${s}`), `${s}`).toBe(true)
      expect(names.has(`face · seed ${s}`), `${s}`).toBe(true)
    }
    for (const t of ['blank', 'non-ASCII']) for (const n of ['sketch', 'face']) expect(names.has(`${n} · prompt ${t}`), `${n} ${t}`).toBe(true)
    for (const ar of ['1:1', '16:9', '9:16', '4:3', '3:4', '16:10', '10:16']) expect(names.has(`face · ratio ${ar}`), ar).toBe(true)
    // Every endpoint is reached, and each class makes at most one call.
    expect(new Set(CASES.flatMap(c => c.calls.map(x => x.endpoint)))).toEqual(new Set([TEXT_GENERATE_SLUG, TEXT_RESTYLE_SLUG, SKETCH_SLUG, FACE_SLUG]))
    expect(CASES.every(c => c.calls.length <= 1)).toBe(true)
    expect(CASES.length).toBeGreaterThanOrEqual(260)
  })
})

describe('the catalogue: text_effects.py, ported line for line', () => {
  it('the 16 effects, in order, every field', () => {
    expect(TEXT_EFFECTS.map(e => ({
      id: e.id, label: e.label, prompt_template: e.promptTemplate, edit_template: e.editTemplate, model_slug: e.modelSlug, medium: e.medium, default_freedom: e.defaultFreedom,
    }))).toEqual(CAT.effects)
    expect([...TEXT_EFFECT_IDS]).toEqual(CAT.effects.map(e => e.id))
    expect(TEXT_EFFECT_DEFAULT_ID).toBe(CAT.default_effect)
    expect([...TEXT_EFFECT_ASPECT_RATIOS]).toEqual(CAT.node_ratios)
    expect(TEXT_EFFECT_ASPECT_RATIOS[0]).toBe(CAT.match_input)
  })

  it('the gallery catalogue (app/data/text-effects.ts) has the same ids as the port', async () => {
    const { TEXT_EFFECTS: GALLERY, DEFAULT_TEXT_EFFECT_ID } = await import('~/data/text-effects')
    expect(GALLERY.map(e => e.id)).toEqual([...TEXT_EFFECT_IDS])
    expect(DEFAULT_TEXT_EFFECT_ID).toBe(TEXT_EFFECT_DEFAULT_ID)
  })

  it('build_prompt: every effect (and an unknown one) × every text, byte for byte', () => {
    expect(CAT.prompts.length).toBeGreaterThan(100)
    for (const p of CAT.prompts) expect(buildPrompt(p.effect, p.text), `${p.effect} ${JSON.stringify(p.text)}`).toBe(p.prompt)
  })

  it('build_edit_prompt: every effect × every freedom band edge, None and out of range, byte for byte', () => {
    expect(CAT.edit_prompts.length).toBeGreaterThan(250)
    for (const p of CAT.edit_prompts) expect(buildEditPrompt(p.effect, p.freedom), `${p.effect} ${String(p.freedom)}`).toBe(p.prompt)
  })

  it('aspect_ok and edit_aspect', () => {
    for (const [ar, want] of Object.entries(CAT.aspect_ok)) expect(aspectOk(ar), ar).toBe(want)
    for (const [ar, want] of Object.entries(CAT.edit_aspect)) expect(editAspect(ar), ar).toBe(want)
  })
})

describe('every fixture case: what Python sends and returns', () => {
  const refused: string[] = []
  const offSchema: string[] = []

  it.each(CASES.map(c => [c.name, c] as const))('%s — the request and the picture', async (_n, c) => {
    const want = expectedRefusal(c)
    if (want) {
      refused.push(c.name)
      expect(requestProblems(withPictures(c), { runner: true }).map(p => p.message)).toEqual([want])
      // The ComfyUI path is Python's own: nothing refused there.
      expect(requestProblems(withPictures(c))).toEqual([])
      if (want === TEXT_EFFECT_NEEDS_TEXT) {
        // Python raises before its call, in these words; the builder refuses the same (a wired text, at the node's turn).
        expect(c.error?.message).toBe(TEXT_EFFECT_NEEDS_TEXT)
        expect(c.calls).toEqual([])
        await expect(planOf(c)).rejects.toThrow(TEXT_EFFECT_NEEDS_TEXT)
        return
      }
    }
    else {
      expect(c.error).toBeUndefined()
      expect(requestProblems(withPictures(c), { runner: true })).toEqual([])
    }
    expect(paidNoCall(c.class_type, c.widgets)).toBe(false)
    // The request, byte for byte (the seed refusals too: the builder sends what Python sends).
    const plan = await planOf(c)
    expect(plan.kind).toBe('provider')
    expect(plan.media).toBe('image')
    expect(plan.take).toBe('first')
    expect(plan.backup).toBeUndefined()
    const py = c.calls[0]!
    expect({ provider: plan.provider, endpoint: plan.endpoint, payload: asPython(c, plan.payload) }).toEqual({ provider: py.provider, endpoint: py.endpoint, payload: py.payload })
    expect(wireText(asPython(c, plan.payload))).toBe(py.payload_json)
    const errs = checkPayload(schemaOf(plan.endpoint), plan.payload)
    if (errs.length) offSchema.push(`${c.name}: ${errs.join('; ')}`)
    // The picture: Python's `_first_output_url`, and its ui (Text effect shows it under text_effect; the others show none).
    expect(firstOutputUrl(c.answers[0])).toEqual([(c.output as { image: string }[])[0]!.image])
    const files = [{ filename: 'x.png', subfolder: '', type: 'output' as const }]
    if (c.class_type === 'TextEffectNode') {
      expect((c.ui as { images: { prefix: string }[] }).images[0]!.prefix).toBe('text_effect')
      expect(plan.prefix).toBe('text_effect')
      expect(plan.uiFor(files)).toEqual({ images: files, animated: [false] })
    }
    else {
      expect(c.ui).toBeNull()
      expect(plan.uiFor(files)).toBeNull()
    }
  })

  it('the refusals: a blank text to generate (Python raises), and a seed above 2147483647 on Ideogram (Replicate refuses)', () => {
    expect(refused.sort()).toEqual([
      'face · seed 2147483648', 'face · seed 4294967295',
      'text effect · generate · seed 2147483648', 'text effect · generate · seed 4294967295',
      'text effect · generate · text blank', 'text effect · generate · text spaces',
    ])
    // Restyle's Kontext Pro takes any seed: sent as Python sends it.
    expect(caseNamed('text effect · restyle · seed 4294967295').calls[0]!.payload.seed).toBe(4294967295)
  })

  it('every payload fits its published schema but the seeds the runner refuses', () => {
    expect(offSchema.sort()).toEqual([
      'face · seed 2147483648: seed: 2147483648 is above the maximum 2147483647',
      'face · seed 4294967295: seed: 4294967295 is above the maximum 2147483647',
      'text effect · generate · seed 2147483648: seed: 2147483648 is above the maximum 2147483647',
      'text effect · generate · seed 4294967295: seed: 4294967295 is above the maximum 2147483647',
    ])
  })
})

describe('every fixture case through the engine (cards and image-extras on)', () => {
  // A Text effect with no `freedom` fails ComfyUI's validation (a required widget): the builder
  // sends Python's `execute` default (above), but neither path runs such a node.
  const missing = (c: PaidCase) => c.class_type === 'TextEffectNode' && !('freedom' in c.widgets)
  const calling = CASES.filter(c => c.calls.length && !expectedRefusal(c) && !missing(c))

  it('a Text effect with no freedom is left to the engine (ComfyUI refuses it before running anything)', () => {
    const cases = CASES.filter(missing)
    expect(cases.length).toBe(32)
    for (const c of cases) expect(runnerTakesNode(withPictures(c), 'n', ON), c.name).toBe(false)
  })

  it.each(calling.map(c => [c.name, c] as const))('%s — sent, saved and charged', async (_n, c) => {
    const run = await runPaidCase(c, { families: ON })
    expect(run.status, run.error ?? '').toBe('done')
    expect(normalizeSent(run.sent, c.pictures ?? [])).toEqual([{ provider: 'replicate', endpoint: c.calls[0]!.endpoint, payload: c.calls[0]!.payload }])
    expect(wireText(normalizeSent(run.sent, c.pictures ?? [])[0]!.payload)).toBe(c.calls[0]!.payload_json)
    expect(run.values).toBeUndefined()
    expect(run.files.length).toBe(1)
    expect(run.files[0]!.filename).toMatch(c.class_type === 'TextEffectNode' ? /^text_effect/ : c.class_type === 'SketchToImageNode' ? /^sketch_to_image/ : /^face_reference/)
    const inputs = withPictures(c).n!.inputs
    const price = priceNode(c.class_type, inputs)
    if ('refused' in price) throw new Error(price.refused)
    expect(run.credits).toBe(price.credits)
  })
})

describe('prices (ruling (a))', () => {
  const inputsOf = (name: string) => withPictures(caseNamed(name)).n!.inputs
  const generate = inputsOf('text effect · generate · liquid-chrome · freedom 0.0')
  const restyle = inputsOf('text effect · restyle · liquid-chrome · freedom 0.0')
  const sketch = inputsOf('sketch · a castle')
  const face = inputsOf('face · seed 0')

  it('a card per new endpoint, read from its page\'s billing table; Nano Banana keeps its edit card', () => {
    const card = (slug: string, usd: number) => ({
      unit: 'per_call', usd, service: 'replicate', source: `https://replicate.com/${slug}`, read: '2026-09-27', confidence: 'verified',
    })
    expect(PAID_RATES[TEXT_GENERATE_SLUG]).toEqual(card(TEXT_GENERATE_SLUG, 0.03))
    expect(PAID_RATES[TEXT_RESTYLE_SLUG]).toEqual(card(TEXT_RESTYLE_SLUG, 0.04))
    expect(PAID_RATES[FACE_SLUG]).toEqual(card(FACE_SLUG, 0.15))
    for (const slug of [TEXT_GENERATE_SLUG, TEXT_RESTYLE_SLUG, FACE_SLUG]) expect(otherCardFor(slug), slug).toBeNull()
    expect(EDIT_RATES[SKETCH_SLUG]).toMatchObject({ unit: 'per_image', usd: 0.039, confidence: 'verified' })
    expect(PAID_RATES[SKETCH_SLUG]).toBeUndefined()
  })

  it('the three classes are priced by their calls with no flat row; the price book moved on', () => {
    for (const c of IMAGE_EXTRAS_CLASSES) {
      expect(PAID_NODE_CLASSES).toContain(c)
      expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, c), c).toBe(false)
      // Its flat price before R3 is on record (the R3.9 floor's table), but every card is verified: no floor applies.
      expect(PRE_R3_FLAT[c]!.family, c).toBe('image-extras')
    }
    expect([PRE_R3_FLAT.TextEffectNode!.credits, PRE_R3_FLAT.SketchToImageNode!.credits, PRE_R3_FLAT.ConsistentFaceNode!.credits]).toEqual([8, 8, 16])
    for (const i of [generate, restyle]) expect(readsEstimateCard('TextEffectNode', i)).toBe(false)
    expect(readsEstimateCard('SketchToImageNode', sketch)).toBe(false)
    expect(readsEstimateCard('ConsistentFaceNode', face)).toBe(false)
    expect(PRICE_BOOK_VERSION).toBe('r3-turntable')
  })

  it('per call, on both paths: Text effect 6 generating (was 8), 8 restyling; Sketch 8; Face references 23 (was 16)', async () => {
    const { nodeCreditEstimate } = await import('~/lib/nodeCreditEstimate')
    const want: [string, Record<string, unknown>, number, number][] = [
      ['TextEffectNode', generate, 0.03, 6], ['TextEffectNode', restyle, 0.04, 8],
      ['SketchToImageNode', sketch, 0.039, 8], ['ConsistentFaceNode', face, 0.15, 23],
    ]
    for (const [ct, inputs, usd, credits] of want) {
      expect(creditsForUsd(usd)).toBe(credits)
      expect(priceNode(ct, inputs), ct).toEqual({ usd, credits })
      // The ComfyUI path (the hosted meter) and the badge; with the family on, the same.
      expect(priceGraph({ 1: { class_type: ct, inputs } }).nodes!['1'], ct).toBe(credits)
      expect(priceGraph({ 1: { class_type: ct, inputs } }, { families: ON }).nodes!['1'], ct).toBe(credits)
      expect(nodeCreditEstimate(ct, inputs), ct).toBe(credits + BASE_RENDER_CREDITS)
    }
    // Whatever the settings: a bare node (Text effect with no picture wired generates).
    expect(priceNode('TextEffectNode', {})).toEqual({ usd: 0.03, credits: 6 })
    expect(priceNode('SketchToImageNode', {})).toEqual({ usd: 0.039, credits: 8 })
    expect(priceNode('ConsistentFaceNode', {})).toEqual({ usd: 0.15, credits: 23 })
  })

  it('nothing is free: Python calls whenever it doesn\'t raise (a blank text to generate is refused, not passed)', () => {
    for (const c of IMAGE_EXTRAS_CLASSES) expect(paidNoCall(c, {}), c).toBe(false)
    expect(paidNoCall('TextEffectNode', { text: '' })).toBe(false)
  })

  it('hosted: held at the node\'s price and charged the same', async () => {
    for (const name of ['text effect · generate · ratio 16:9', 'text effect · restyle · ratio 16:9', 'sketch · a castle', 'face · ratio 16:9']) {
      const c = caseNamed(name)
      const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: [OUT] }) })
      const k = makeKit({ hosted: true, replicate, deps: { families: () => ON, download: async () => ({ bytes: new Uint8Array(await png(8, 6)), contentType: 'image/png' }) } })
      await writePictures(k.root, c)
      const p = withPictures(c)
      const price = (priceNode(c.class_type, p.n!.inputs) as { credits: number }).credits
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
      await k.engine.settled(runId)
      const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
      expect(rec.status, rec.error ?? '').toBe('done')
      expect(rec.credits).toBe(price)
      // + the render credit: the Image card that shows the result is an output (R3.8 fix round 1), as on the Python path.
      expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual]), name).toEqual([[price + BASE_RENDER_CREDITS, price + BASE_RENDER_CREDITS]])
      expect(stageEstimate(p, Object.keys(p), false, ON)).toBe(price)
    }
  })
})

describe('refusals before the hold (hosted), in plain words', () => {
  async function refusedAtStart(c: PaidCase, want: string) {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    await writePictures(k.root, c)
    await expect(k.engine.startRun({ userId: k.userId, takes: [withPictures(c)], ...START })).rejects.toThrow(want)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  }

  it('a blank text to generate: Python\'s own words', async () => {
    await refusedAtStart(caseNamed('text effect · generate · text blank'), TEXT_EFFECT_NEEDS_TEXT)
    await refusedAtStart(caseNamed('text effect · generate · text spaces'), TEXT_EFFECT_NEEDS_TEXT)
    // Unicode blanks around a word are stripped as Python strips them: not blank.
    expect(requestProblems(withPictures(caseNamed('text effect · generate · text unicode blanks')), { runner: true })).toEqual([])
    expect(requestProblems({ n: { class_type: 'TextEffectNode', inputs: { text: '　  ', effect: 'risograph', aspect_ratio: '1:1', seed: 0, freedom: 0 } } }, { runner: true }).map(p => p.message)).toEqual([TEXT_EFFECT_NEEDS_TEXT])
  })

  it('a seed above 2147483647 on Ideogram: Text effect generating, and Generate face references', async () => {
    await refusedAtStart(caseNamed('text effect · generate · seed 2147483648'), TEXT_EFFECT_SEED_TOO_LARGE)
    await refusedAtStart(caseNamed('face · seed 4294967295'), FACE_SEED_TOO_LARGE)
    // At the limit, it is sent.
    expect(requestProblems(withPictures(caseNamed('text effect · generate · seed 2147483647')), { runner: true })).toEqual([])
    expect(requestProblems(withPictures(caseNamed('face · seed 2147483647')), { runner: true })).toEqual([])
  })

  it('the refusals are plain words', () => {
    for (const w of [TEXT_EFFECT_NEEDS_TEXT, TEXT_EFFECT_SEED_TOO_LARGE, FACE_SEED_TOO_LARGE]) expect(w).not.toMatch(/Node|_|\bid\b/)
  })
})

describe('wired pictures and text', () => {
  it('a Text card wired into Text effect\'s word arrives as typed; wired, it is priced as a call', async () => {
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: [OUT] }) })
    const k = makeKit({ replicate, deps: { families: () => ON, download: async () => ({ bytes: new Uint8Array(await png(8, 6)), contentType: 'image/png' }) } })
    const c = caseNamed('text effect · generate · risograph · freedom 0.0')
    const p: ApiPrompt = { ...withPictures(c), t: { class_type: 'Text', inputs: { text: '  WIRED  ' } } }
    p.n!.inputs.text = ['t', 0]
    expect(isRunnerEligible(p, ON)).toBe(true)
    expect(stageEstimate(p, ['n'], false, ON)).toBe(6)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect(replicate.submitted()[0]!.payload.prompt).toBe(buildPrompt('risograph', 'WIRED'))
  })

  it('a Text card whose text is blank is refused at the start, before the hold, in Python\'s words (its value is known then)', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const c = caseNamed('text effect · generate · risograph · freedom 0.0')
    const p: ApiPrompt = { ...withPictures(c), t: { class_type: 'Text', inputs: { text: '   ' } } }
    p.n!.inputs.text = ['t', 0]
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(TEXT_EFFECT_NEEDS_TEXT)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })

  it('Sketch to image → Text effect: the sketch\'s picture is restyled, handed off as its own file', async () => {
    const replicate = createFakeReplicate({ bodyText: ({ model }) => JSON.stringify({ id: 'p', status: 'succeeded', output: [`https://r.test/${model.replace('/', '_')}.png`] }) })
    const k = makeKit({ replicate, deps: { families: () => ON, download: async () => ({ bytes: new Uint8Array(await png(16, 12)), contentType: 'image/png' }) } })
    writeFileSync(join(k.root, 'input', 'image.png'), await png(8, 6))
    const p: ApiPrompt = {
      p_image: { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } },
      s: { class_type: 'SketchToImageNode', inputs: { model: 'Nano Banana', prompt: 'a castle', image: ['p_image', 0] } },
      n: { class_type: 'TextEffectNode', inputs: { ...caseNamed('text effect · restyle · ink-in-water · freedom 0.45').widgets, image: ['s', 0] } },
      ...readerFor('TextEffectNode', 'n'),
    }
    expect(isRunnerEligible(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    expect(nodes.n!.status, nodes.n!.error ?? '').toBe('done')
    const made = nodes.s!.outputs[0]!
    expect(made.filename).toMatch(/^sketch_to_image/)
    expect(replicate.submitted().map(r => r.endpoint)).toEqual([SKETCH_SLUG, TEXT_RESTYLE_SLUG])
    expect(replicate.submitted()[1]!.payload).toEqual({ ...caseNamed('text effect · restyle · ink-in-water · freedom 0.45').calls[0]!.payload, input_image: `https://fal.storage/${made.filename}` })
    expect(nodes.n!.outputs[0]!.filename).toMatch(/^text_effect/)
  })
})

describe('moderation', () => {
  it('lists Text effect\'s word and the prompts of Sketch and Face references', () => {
    expect(PAID_TEXT_INPUTS.TextEffectNode).toEqual(['text'])
    expect(PAID_TEXT_INPUTS.SketchToImageNode).toEqual(['prompt'])
    expect(PAID_TEXT_INPUTS.ConsistentFaceNode).toEqual(['prompt'])
    expect(extraPromptTexts({ n: { class_type: 'TextEffectNode', inputs: { text: 'SALE' } } })).toEqual(['SALE'])
  })

  for (const name of ['text effect · generate · text non-ASCII', 'sketch · prompt non-ASCII', 'face · prompt non-ASCII']) {
    it(`${name.split(' · ')[0]}: a hosted flagged text is refused at the start, before the hold`, async () => {
      const c = caseNamed(name)
      const key = c.class_type === 'TextEffectNode' ? 'text' : 'prompt'
      const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
      const k = makeKit({ hosted: true, moderate, deps: { families: () => ON } })
      await writePictures(k.root, c)
      const p = withPictures({ ...c, widgets: { ...c.widgets, [key]: 'a forbidden thing' } })
      await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow()
      expect(moderate.mock.calls.map(x => x[0])).toContain('a forbidden thing')
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
    })
  }
})

describe('with image-extras off (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but image-extras', RUNNER_FAMILIES.filter(f => f !== 'image-extras')],
  ]
  const isExtra = (ct: string) => (IMAGE_EXTRAS_CLASSES as readonly string[]).includes(ct)
  /** The same prompt as before R3.12: the classes had no rule row and were no picture (renamed to one that has neither). */
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, isExtra(n.class_type) ? { ...n, class_type: `${n.class_type}Before` } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (!isExtra(p[id]!.class_type)) {
          expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
        }
      }
    }
  }
  const sample = (c: ImageExtrasClass, restyle = false) =>
    CASES.find(x => x.class_type === c && x.calls.length && !expectedRefusal(x) && (c !== 'TextEffectNode' || !!(x.pictures ?? []).length === restyle))!

  it('each class is left to the engine, and named by the needs-the-engine list', () => {
    for (const c of IMAGE_EXTRAS_CLASSES) {
      const p = withPictures(sample(c))
      expect(runnerTakesNode(p, 'n', new Set(['cards'])), c).toBe(false)
      expect(runnerTakesNode(p, 'n', ON), c).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n'])
      expect(RUNNER_OUTPUT_CLASSES.has(c), c).toBe(false)
      // A picture only while the family is on (PAID_PICTURE_FAMILY), never through IMAGE_OUTPUT_CLASSES.
      expect(IMAGE_OUTPUT_CLASSES.has(c)).toBe(false)
      expect(PAID_PICTURE_FAMILY[c]).toBe('image-extras')
      expect(RUNNER_NODE_RULES[c]!.family).toBe('image-extras')
      expect(RUNNER_ROUTES[c]!.first).toBe('replicate')
      expect(RUNNER_ROUTES[c]!.backup).toBeNull()
    }
    // Text effect restyling is taken too.
    expect(runnerTakesNode(withPictures(sample('TextEffectNode', true)), 'n', ON)).toBe(true)
  })

  it('a wire from one of them is a picture only while the family is on', () => {
    const p: ApiPrompt = {
      ...withPictures(sample('SketchToImageNode')),
      u: { class_type: 'TextEffectNode', inputs: { ...sample('TextEffectNode', true).widgets, image: ['n', 0] } },
    }
    expect(runnerTakesNode(p, 'u', ON)).toBe(true)
    expect(runnerTakesNode(p, 'u', new Set<RunnerFamily>(RUNNER_FAMILIES.filter(f => f !== 'image-extras')))).toBe(false)
  })

  it('a wired widget (the effect, the seed) leaves the node to the engine', () => {
    const p = withPictures(sample('TextEffectNode'))
    expect(runnerTakesNode({ ...p, t: { class_type: 'Text', inputs: { text: 'risograph' } }, n: { ...p.n!, inputs: { ...p.n!.inputs, effect: ['t', 0] } } }, 'n', ON)).toBe(false)
    const f = withPictures(sample('ConsistentFaceNode'))
    expect(runnerTakesNode({ ...f, n: { ...f.n!, inputs: { ...f.n!.inputs, seed: 9_999_999_999 } } }, 'n', ON)).toBe(false)
  })

  it('over synthetic chains: into a Frame, into another of them, a Text card into the prompt', () => {
    for (const c of IMAGE_EXTRAS_CLASSES) {
      for (const restyle of c === 'TextEffectNode' ? [false, true] : [false]) {
        const p = withPictures(sample(c, restyle))
        sameAsBefore(p, `${c} alone`)
        sameAsBefore({ ...p, f: { class_type: 'Compositor', inputs: { layer1: ['n', 0], width: 0, height: 0 } } }, `${c} → Frame`)
        sameAsBefore({ ...p, r: { class_type: 'ConsistentFaceNode', inputs: { ...sample('ConsistentFaceNode').widgets, reference_image: ['n', 0] } } }, `${c} → Face references`)
        sameAsBefore({ ...p, i: { class_type: 'Image', inputs: { image: '', images: ['n', 0] } } }, `${c} → Image card`)
        const text = PAID_TEXT_INPUTS[c]![0]!
        sameAsBefore({ ...p, t: { class_type: 'Text', inputs: { text: 'hi' } }, n: { ...p.n!, inputs: { ...p.n!.inputs, [text]: ['t', 0] } } }, `Text → ${c}`)
      }
    }
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (with Sketch to image spliced in beside each)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        graphs++
        sameAsBefore(p, uuid)
        sameAsBefore({
          ...p,
          d_img: { class_type: 'LoadImage', inputs: { image: 'x.png', upload: 'image' } },
          d_sk: { class_type: 'SketchToImageNode', inputs: { model: 'Nano Banana', prompt: 'a castle', image: ['d_img', 0] } },
          ...readerFor('SketchToImageNode', 'd_sk'),
        }, `${uuid} + Sketch to image`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`image-extras families-off invariant: ${graphs} saved graphs`)
  }, 600_000)
})

// ── Fix round 1 ──────────────────────────────────────────────────────────────

describe('the canvas seed reroll stays within the provider\'s seed (fix round 1, ruling 1)', () => {
  const widgetMax = async (ct: string) => {
    const { gunzipSync } = await import('node:zlib')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    return (catalog[ct].input.required.seed[1] as { max: number }).max
  }

  it('the table: Text effect and Generate face references at Ideogram\'s 2147483647', () => {
    expect(PROVIDER_SEED_MAX).toEqual({ TextEffectNode: { seed: 2147483647 }, ConsistentFaceNode: { seed: 2147483647 } })
  })

  it('min(widget max, provider max): the two classes\' widgets offer 0xFFFFFFFF, the reroll draws below 2^31 − 1', async () => {
    for (const ct of ['TextEffectNode', 'ConsistentFaceNode']) {
      const max = await widgetMax(ct)
      expect(max, ct).toBe(0xFFFFFFFF)
      expect(seedRerollMax(ct, 'seed', max), ct).toBe(IDEOGRAM_SEED_MAX)
      // The top of the draw: the largest value random() can give.
      expect(rerolledSeed(ct, 'seed', max, () => 1 - 2 ** -53), ct).toBe(IDEOGRAM_SEED_MAX - 1)
      expect(rerolledSeed(ct, 'seed', max, () => 0), ct).toBe(0)
      let top = 0
      for (let i = 0; i < 20_000; i++) top = Math.max(top, rerolledSeed(ct, 'seed', max))
      expect(top, ct).toBeLessThan(IDEOGRAM_SEED_MAX)
      expect(top, ct).toBeGreaterThan(IDEOGRAM_SEED_MAX * 0.99)
      // Every draw is a seed the runner takes (no refusal).
      expect(imageExtrasRequestProblemFor(ct, top)).toBeNull()
    }
  })

  it('a smaller widget max still wins; other classes and other widgets draw to their widget max, as before', () => {
    expect(seedRerollMax('TextEffectNode', 'seed', 1000)).toBe(1000)
    expect(seedRerollMax('TextEffectNode', 'noise_seed', 0xFFFFFFFF)).toBe(0xFFFFFFFF)
    expect(seedRerollMax('KSampler', 'seed', 0xFFFFFFFFFFFFFFFF)).toBe(2 ** 53 - 1)
    expect(seedRerollMax('GenerateImageNode', 'seed', 0xFFFFFFFF)).toBe(0xFFFFFFFF)
    expect(seedRerollMax('OutpaintImageNode', 'seed', undefined)).toBe(2 ** 53 - 1)
    expect(rerolledSeed('GenerateImageNode', 'seed', 0xFFFFFFFF, () => 0.5)).toBe(Math.floor(0.5 * 0xFFFFFFFF))
  })

  it('the canvas rerolls through it, by the node\'s class', () => {
    const src = readFileSync(resolve(__dirname, '../../app/components/vue-canvas/VueNodeCanvas.vue'), 'utf8')
    const body = src.slice(src.indexOf('function randomizeSeedsOnLiveState'), src.indexOf('function randomizeSeedsOnLiveState') + 2500)
    expect(body).toContain("values[i] = rerolledSeed(String(node.data?.nodeType ?? ''), String(def.name || ''), def.max)")
    expect(body).not.toContain('Math.random()')
    expect(src).toContain("import { rerolledSeed } from '#shared/runner/seedLimits'")
  })
})

function imageExtrasRequestProblemFor(ct: string, seed: number) {
  const c = ct === 'TextEffectNode' ? caseNamed('text effect · generate · seed 42') : caseNamed('face · seed 42')
  const p = requestProblems(withPictures({ ...c, widgets: { ...c.widgets, seed } }), { runner: true })
  return p.length ? p : null
}

describe('a seed written with underscores is read as Python\'s int() reads it (fix round 1, ruling 3)', () => {
  it('"2_147_483_648" is refused; "2_147_483_647" is taken', () => {
    const gen = caseNamed('text effect · generate · seed 42')
    const face = caseNamed('face · seed 42')
    const at = (c: PaidCase, seed: unknown) => requestProblems(withPictures({ ...c, widgets: { ...c.widgets, seed } }), { runner: true }).map(p => p.message)
    expect(at(gen, '2_147_483_648')).toEqual([TEXT_EFFECT_SEED_TOO_LARGE])
    expect(at(face, '2_147_483_648')).toEqual([FACE_SEED_TOO_LARGE])
    expect(at(gen, ' 4_294_967_295 ')).toEqual([TEXT_EFFECT_SEED_TOO_LARGE])
    expect(at(gen, '2_147_483_647')).toEqual([])
    expect(at(face, '2_147_483_647')).toEqual([])
  })
})

describe('the direct character-shot route\'s price (fix round 1, ruling 2)', () => {
  it('MODEL_COSTS charges Ideogram Character\'s default-speed card: $0.15, 23 credits', () => {
    expect(MODEL_COSTS[FACE_SLUG]).toMatchObject({ usd: 0.15, credits: 23, confidence: 'verified' })
    expect(costForModel(FACE_SLUG)!.credits).toBe(creditsForUsd((PAID_RATES[FACE_SLUG] as { usd: number }).usd))
    expect(resolveCredits(FACE_SLUG)).toBe(23)
    expect(PRICE_BOOK_VERSION).toBe('r3-turntable')
  })

  it('the trainer shows the same dollars a shot', () => {
    const src = readFileSync(resolve(__dirname, '../../app/components/LoraTrainerSurface.vue'), 'utf8')
    expect(src).toMatch(/const IDEOGRAM_PER_IMAGE = 0\.15\b/)
    expect(src).not.toContain('expectedShots * 0.08')
  })
})
