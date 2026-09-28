/**
 * R3.9: 3D models (family `gen-3d`) — Generate a 3D model and its hidden twin
 * Hunyuan3D 2 (Replicate `tencent/hunyuan3d-2`), and Multi-View → 3D on its
 * engine (TRELLIS, Rodin, Hunyuan3D-2mv) — against what their real Python
 * sends and returns (fixtures/runner-paid-gen-3d.json,
 * scripts/runner_paid_fixtures.py --group gen-3d), priced on both paths from
 * Replicate's pages. The GLB is saved as the user's own asset and handed on by
 * its Sailor address (spec ruling 1, ruling (k)): the 3D model card, 3D
 * Studio and a Text card read it.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createFakeReplicate, makeKit } from './__runner__/kit'
import { normalizeSent, runPaidCase, wireText, type PaidCase } from './__runner__/paidParity'
import { checkPayload, type ProviderSchemaFixture } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { PROVIDER_TYPES, SWITCHED_CLASSES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import {
  GENERATE_3D_RUNNER_ONLY, GEN_3D_CLASSES, HUNYUAN3D_MV_SLUG, HUNYUAN3D_OCTREE_REFUSED, HUNYUAN3D_SLUG, HUNYUAN3D_TOO_MANY_STEPS, MULTI_VIEW_ENGINES, RODIN_QUALITIES, RODIN_SLUG,
  TRELLIS_SLUG, type Gen3dClass,
} from '#shared/runner/gen3d'
import { PAID_RATES, otherCardFor, paidCallUsd } from '#shared/pricing/paidRates'
import { PAID_NODE_CLASSES, paidNoCall } from '#shared/pricing/paidSettings'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { BASE_RENDER_CREDITS, GRAPH_NODE_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { PAID_TEXT_INPUTS, extraPromptTexts, stageEstimate } from '~~/server/runner/metering'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { hunyuan3dGlbUrl, hunyuan3dInput, multiViewInput, trellisGlbUrl } from '~~/server/runner/generators/gen3d'
import { blockedPromptRefusal } from '~~/server/utils/blockedModels'
import { meterGraphSubmit } from '~~/server/utils/meterGraphRun'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { requestProblems } from '~~/server/runner/requestRules'
import { ANSWER_MAX_BYTES, ANSWER_NOT_GLB, answerTooLarge } from '~~/server/runner/answerDownload'
import { viewGateDecision } from '~~/server/utils/engineGate'
import type { OutputFile } from '~~/server/runner/types'

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-gen-3d.json'), 'utf8')) as { cases: PaidCase[] }
const CASES = FIXTURE.cases
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'gen-3d'])
const GLB_URL = 'https://r.test/3d/model.glb'
const MIB = 1024 * 1024

/** The FLOAT setting Python writes as `5.0` where the runner's JSON writes `5`: the same JSON number (R3.3 ruling 1). */
function pythonWire(payloadJson: string): string {
  return payloadJson.replace(/"(guidance_scale)": (-?\d+)\.0([,}])/g, '"$1": $2$3')
}

/** The settings Hunyuan3D 2's schema refuses (the runner refuses them before the hold; Python sends them). */
const refusedByRunner = (c: PaidCase) => requestProblems({ n: node(c) }, { runner: true }).length > 0
/** Hunyuan3D 2's published answer, `{ output: { mesh } }`: Python raises; the runner reads it (R3.9 fix round 1). */
const isMeshAnswer = (c: PaidCase) => {
  const out = (c.answers[0] as { output?: unknown }).output
  return !!out && typeof out === 'object' && !Array.isArray(out) && 'mesh' in out
}
const caseNamed = (name: string) => {
  const c = CASES.find(x => x.name === name)
  if (!c) throw new Error(`no case ${name}`)
  return c
}
const node = (c: PaidCase, inputs: Record<string, unknown> = {}) => ({ class_type: c.class_type, inputs: { ...c.widgets, ...inputs } })
const sample = (ct: Gen3dClass) => CASES.find(c => c.class_type === ct && c.name.endsWith('defaults'))!

/** A GLB's bytes: the header `glTF`, version 2, the length. */
function glb(extra = 0): Uint8Array {
  const b = Buffer.alloc(20 + extra)
  b.write('glTF', 0); b.writeUInt32LE(2, 4); b.writeUInt32LE(b.length, 8)
  return new Uint8Array(b)
}
const png = async (w = 8, h = 6) => new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toBuffer())

/** The case's node with a LoadImage per picture it names. */
function withPictures(c: PaidCase, extra: ApiPrompt = {}): ApiPrompt {
  const p: ApiPrompt = { n: node(c), ...extra }
  for (const name of c.pictures ?? []) {
    p[`p_${name}`] = { class_type: 'LoadImage', inputs: { image: `${name}.png`, upload: 'image' } }
    p.n!.inputs[name] = [`p_${name}`, 0]
  }
  return p
}

async function writePictures(root: string, c: PaidCase) {
  for (const name of c.pictures ?? []) writeFileSync(join(root, 'input', `${name}.png`), Buffer.from(c.picture_files![name]!, 'base64'))
}

async function planOf(c: PaidCase): Promise<Extract<NodePlan, { kind: 'provider' }>> {
  const p = withPictures(c)
  return await planNode({
    prompt: p, nodeId: 'n', gateOpen: false,
    filesFrom: link => [{ filename: `${String(link[0]).slice(2)}.png`, subfolder: '', type: 'input' }],
    toUrl: async f => `https://fal.storage/${f.filename}`,
  }) as Extract<NodePlan, { kind: 'provider' }>
}

// ── The published inputs (each model page's schema, read 2026-09-27), until the controller saves them ──

const publishedInput = (properties: Record<string, unknown>, required: string[]): ProviderSchemaFixture => ({
  endpoint: '', fetchedAt: '2026-09-27', input: { type: 'object', required, properties }, output: {}, components: { schemas: {} },
})
const SCHEMAS: Record<string, ProviderSchemaFixture> = {
  [HUNYUAN3D_SLUG]: publishedInput({
    seed: { type: 'integer', default: 1234 }, image: { type: 'string', format: 'uri' },
    steps: { type: 'integer', default: 50, minimum: 20, maximum: 50 }, guidance_scale: { type: 'number', default: 5.5, minimum: 1, maximum: 20 },
    octree_resolution: { type: 'integer', default: 256, enum: [256, 384, 512] }, remove_background: { type: 'boolean', default: true },
  }, []),
  [HUNYUAN3D_MV_SLUG]: publishedInput({
    seed: { type: 'integer', default: 1234 }, steps: { type: 'integer', default: 30, minimum: 1, maximum: 100 },
    file_type: { type: 'string', default: 'glb', enum: ['glb', 'obj', 'ply', 'stl'] }, back_image: { type: 'string', format: 'uri' },
    left_image: { type: 'string', format: 'uri' }, num_chunks: { type: 'integer', default: 200000, minimum: 1000, maximum: 5000000 },
    front_image: { type: 'string', format: 'uri' }, right_image: { type: 'string', format: 'uri' }, guidance_scale: { type: 'number', default: 5 },
    randomize_seed: { type: 'boolean', default: true }, target_face_num: { type: 'integer', default: 10000, minimum: 100, maximum: 1000000 },
    octree_resolution: { type: 'integer', default: 256, minimum: 16, maximum: 512 }, remove_background: { type: 'boolean', default: true },
  }, ['front_image']),
  [RODIN_SLUG]: publishedInput({
    seed: { type: 'integer' }, tier: { type: 'string', default: 'Gen-2' }, addons: { type: 'array', items: { type: 'string' } },
    images: { type: 'array', default: [], items: { type: 'string', format: 'uri' } }, prompt: { type: 'string' }, tapose: { type: 'boolean', default: false },
    quality: { type: 'string', default: 'medium', enum: ['high', 'medium', 'low', 'extra-low'] },
    material: { type: 'string', default: 'PBR', enum: ['PBR', 'Shaded', 'All'] }, mesh_mode: { type: 'string', default: 'Quad', enum: ['Quad', 'Raw'] },
    bbox_condition: { type: 'array', items: { type: 'integer' } }, preview_render: { type: 'boolean', default: false },
    quality_override: { type: 'integer' }, use_original_alpha: { type: 'boolean', default: false },
    geometry_file_format: { type: 'string', default: 'glb', enum: ['glb', 'usdz', 'fbx', 'obj', 'stl'] },
  }, ['prompt']),
  [TRELLIS_SLUG]: publishedInput({
    seed: { type: 'integer', default: 0 }, images: { type: 'array', items: { type: 'string', format: 'uri' } },
    texture_size: { type: 'integer', default: 1024, minimum: 512, maximum: 2048 }, mesh_simplify: { type: 'number', default: 0.95, minimum: 0.9, maximum: 0.98 },
    generate_color: { type: 'boolean', default: true }, generate_model: { type: 'boolean', default: false }, randomize_seed: { type: 'boolean', default: true },
    generate_normal: { type: 'boolean', default: false }, save_gaussian_ply: { type: 'boolean', default: false },
    ss_sampling_steps: { type: 'integer', default: 12, minimum: 1, maximum: 50 }, slat_sampling_steps: { type: 'integer', default: 12, minimum: 1, maximum: 50 },
    return_no_background: { type: 'boolean', default: false }, ss_guidance_strength: { type: 'number', default: 7.5, minimum: 0, maximum: 10 },
    slat_guidance_strength: { type: 'number', default: 3, minimum: 0, maximum: 10 },
  }, ['images']),
}

describe('the fixture', () => {
  it('covers each engine with one, two and four views, the seeds, Rodin\'s prompts, polygon counts and qualities, and TRELLIS\'s answers', () => {
    const names = new Set(CASES.map(c => c.name))
    expect(new Set(CASES.map(c => c.class_type))).toEqual(new Set(GEN_3D_CLASSES))
    for (const e of ['TRELLIS', 'Rodin', 'Hunyuan3D-2mv']) {
      for (const v of ['front', 'front and back', 'four views']) expect(names.has(`multi-view · ${e} · ${v} · defaults`), `${e} ${v}`).toBe(true)
      for (const s of [0, 1, 65536, 4294967295]) expect(names.has(`multi-view · ${e} · four views · seed ${s}`), `${e} ${s}`).toBe(true)
    }
    for (const s of [0, 1, 65536, 4294967295]) expect(names.has(`generate 3d · seed ${s}`)).toBe(true)
    for (const n of ['blank prompt', 'spaced prompt', 'poly 0', 'poly 300000', ...RODIN_QUALITIES.map(q => `quality ${q}`)]) {
      expect(names.has(`multi-view · Rodin · front · ${n}`), n).toBe(true)
    }
    for (const n of ['answer model_file', 'answer dict without model_file', 'answer list']) expect(names.has(`multi-view · TRELLIS · front · ${n}`), n).toBe(true)
    expect(new Set(CASES.flatMap(c => c.calls.map(x => x.endpoint)))).toEqual(new Set([HUNYUAN3D_SLUG, HUNYUAN3D_MV_SLUG, RODIN_SLUG, TRELLIS_SLUG]))
    expect(CASES.every(c => c.calls.length === 1)).toBe(true)
    expect(CASES.length).toBeGreaterThanOrEqual(70)
  })

  it('the lists are Python\'s', () => {
    const python = readFileSync(resolve(__dirname, '../../../comfy_api_nodes/nodes_replicate.py'), 'utf8')
    expect(python).toContain(`options=[${MULTI_VIEW_ENGINES.map(e => `"${e}"`).join(', ')}]`)
    expect(python).toContain(`IO.Combo.Input("rodin_quality", options=[${RODIN_QUALITIES.map(e => `"${e}"`).join(', ')}]`)
  })
})

describe('every fixture case: what Python sends and returns', () => {
  const wholeFloat: string[] = []

  it.each(CASES.map(c => [c.name, c] as const))('%s — the request and the 3D file', async (_n, c) => {
    expect(paidNoCall(c.class_type, c.widgets)).toBe(false)
    const plan = await planOf(c)
    expect(plan.kind).toBe('provider')
    expect(plan.media).toBe('glb')
    expect(plan.take).toBe('first')
    expect(plan.backup).toBeUndefined()
    const py = c.calls[0]!
    const [sent] = normalizeSent([{ provider: plan.provider as 'replicate', endpoint: plan.endpoint, payload: plan.payload }], c.pictures ?? [])
    expect(sent).toEqual({ provider: py.provider, endpoint: py.endpoint, payload: py.payload })
    const pw = pythonWire(py.payload_json!)
    if (pw !== py.payload_json) wholeFloat.push(c.name)
    expect(wireText(sent!.payload)).toBe(pw)
    // The builders alone give the same.
    const url = (n: string) => `IMG:${n}`
    if (c.class_type === 'Hunyuan3DMultiViewNode') {
      const has = (n: string) => (c.pictures ?? []).includes(n)
      const views = { front: url('front_image'), back: has('back_image') ? url('back_image') : null, left: has('left_image') ? url('left_image') : null, right: has('right_image') ? url('right_image') : null }
      expect(multiViewInput(String(c.widgets.engine), c.widgets, views)).toEqual({ endpoint: py.endpoint, payload: py.payload })
    }
    else {
      expect(hunyuan3dInput(c.widgets, url('image'))).toEqual(py.payload)
    }
    // The 3D file: the URL Python hands on; none where Python raises, but Hunyuan3D 2's
    // `{mesh}`, which the runner reads (the deliberate deviation, R3.9 fix round 1).
    const got = plan.urlsOf!(c.answers[0])
    if (isMeshAnswer(c)) {
      expect(c.error!.message).toMatch(/Replicate returned no output/)
      expect(got).toEqual([GLB_URL])
    }
    else if (c.error) {
      expect(c.error.message).toMatch(/Replicate returned no output/)
      expect(got).toEqual([])
    }
    else {
      expect(got).toEqual([(c.output as string[])[0]])
    }
    // Python returns no ui.
    expect(c.ui).toBeNull()
    expect(plan.uiFor([{ filename: 'x.glb', subfolder: '', type: 'output' }])).toBeNull()
  })

  it('whole-number FLOAT settings are the only wire difference (R3.3 ruling 1)', () => {
    expect(wholeFloat.length).toBeGreaterThan(0)
  })

  it('every payload fits its published schema, but Hunyuan3D 2\'s `texture` (not in its schema: sent as Python) and the settings the runner refuses', () => {
    for (const c of CASES) {
      const errs = checkPayload(SCHEMAS[c.calls[0]!.endpoint]!, c.calls[0]!.payload)
      if (c.calls[0]!.endpoint !== HUNYUAN3D_SLUG) {
        expect(errs, c.name).toEqual([])
        continue
      }
      const rest = errs.filter(e => e !== 'texture: not in the schema')
      expect(errs, c.name).toContain('texture: not in the schema')
      // What is left is exactly what requestProblems refuses on a runner run.
      expect(rest.length > 0, c.name).toBe(refusedByRunner(c))
    }
  })

  it('TRELLIS: model_file, else the first URL; a dict without a file, an empty one, or one that isn\'t text is no file', () => {
    expect(trellisGlbUrl({ output: { model_file: GLB_URL } })).toEqual([GLB_URL])
    expect(trellisGlbUrl({ output: [GLB_URL, 'x'] })).toEqual([GLB_URL])
    expect(trellisGlbUrl({ output: GLB_URL })).toEqual([GLB_URL])
    expect(trellisGlbUrl({ output: { color_video: 'v.mp4' } })).toEqual([])
    expect(trellisGlbUrl({ output: { model_file: '' } })).toEqual([])
    expect(trellisGlbUrl({ output: { model_file: ['a.glb'] } })).toEqual([])
    expect(trellisGlbUrl({ output: null })).toEqual([])
  })
})

describe('every fixture case through the engine (cards and gen-3d on)', () => {
  const runnable = CASES.filter(c => !refusedByRunner(c))

  it.each(runnable.map(c => [c.name, c] as const))('%s — sent, saved and charged', async (_n, c) => {
    const run = await runPaidCase(c, { families: ON })
    expect(normalizeSent(run.sent, c.pictures ?? [])).toEqual([{ provider: 'replicate', endpoint: c.calls[0]!.endpoint, payload: c.calls[0]!.payload }])
    expect(wireText(normalizeSent(run.sent, c.pictures ?? [])[0]!.payload)).toBe(pythonWire(c.calls[0]!.payload_json!))
    const price = priceNode(c.class_type, c.widgets)
    if ('refused' in price) throw new Error(price.refused)
    expect(run.credits).toBe(price.credits)
    if (c.error && !isMeshAnswer(c)) {
      // Python's `_first_output_url` raises: the node fails plainly (not charged, rule: an answer with no file).
      expect(run.status).toBe('error')
      expect(run.error).toBe('The provider returned no 3D model')
      return
    }
    expect(run.status, run.error ?? '').toBe('done')
    // Sailor's own copy of the GLB Python names, handed on by its address.
    expect(run.files.length).toBe(1)
    const file = run.files[0]!
    expect(file.filename).toMatch(/^model3d_\d+_\.glb$/)
    expect(run.values).toEqual({ 0: { kind: 'glb', url: `/view?filename=${file.filename}&subfolder=&type=output`, file } })
  })

  it.each(CASES.filter(refusedByRunner).map(c => [c.name, c] as const))('%s — refused before the hold (the service\'s schema refuses it)', async (_n, c) => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    await writePictures(k.root, c)
    const want = Number(c.widgets.steps) > 50 ? HUNYUAN3D_TOO_MANY_STEPS : HUNYUAN3D_OCTREE_REFUSED
    await expect(k.engine.startRun({ userId: k.userId, takes: [withPictures(c)], ...START })).rejects.toThrow(want)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    // The ComfyUI path refuses the node itself (R3.9 fix round 1).
    expect(requestProblems({ n: node(c) }).map(p => p.message)).toEqual([GENERATE_3D_RUNNER_ONLY])
  })
})

describe('prices (ruling (a))', () => {
  it('a card per endpoint, read from its page, in no other card; the GPU-time ones are estimates', () => {
    expect(PAID_RATES[RODIN_SLUG]).toEqual({
      unit: 'per_call', usd: 0.40, service: 'replicate', source: 'https://replicate.com/hyper3d/rodin', read: '2026-09-27', confidence: 'verified',
    })
    for (const [slug, usd] of [[HUNYUAN3D_SLUG, 0.10], [HUNYUAN3D_MV_SLUG, 0.10], [TRELLIS_SLUG, 0.06]] as const) {
      expect(PAID_RATES[slug], slug).toMatchObject({ unit: 'gpu_ceiling', usd, confidence: 'estimate', read: '2026-09-27', source: `https://replicate.com/${slug}` })
    }
    for (const slug of [HUNYUAN3D_SLUG, HUNYUAN3D_MV_SLUG, RODIN_SLUG, TRELLIS_SLUG]) expect(otherCardFor(slug), slug).toBeNull()
    expect(paidCallUsd({ endpoint: HUNYUAN3D_SLUG })).toBe(0.1)
    expect(paidCallUsd({ endpoint: RODIN_SLUG })).toBe(0.4)
    expect(paidCallUsd({ endpoint: TRELLIS_SLUG })).toBe(0.06)
    // Fix round 2: Hunyuan3D-2mv's figure is at the page's 30 steps, scaled up with more, never down; no count, no price.
    expect(PAID_RATES[HUNYUAN3D_MV_SLUG]).toMatchObject({ perSteps: 30 })
    expect(paidCallUsd({ endpoint: HUNYUAN3D_MV_SLUG })).toBeNull()
    for (const [steps, usd] of [[20, 0.1], [30, 0.1], [31, 0.11], [50, 0.17], [100, 0.34]] as const) expect(paidCallUsd({ endpoint: HUNYUAN3D_MV_SLUG, steps }), String(steps)).toBe(usd)
  })

  it('priced by their calls with no flat row; the price book moved on', () => {
    for (const c of GEN_3D_CLASSES) {
      expect(PAID_NODE_CLASSES).toContain(c)
      expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, c), c).toBe(false)
      expect(PROVIDER_TYPES.has(c)).toBe(true)
    }
    expect(PRICE_BOOK_VERSION).toBe('r3-restyle-lora')
  })

  it('the runner pays the card: Hunyuan3D 2 20; Multi-View by its engine — TRELLIS 12, Hunyuan3D-2mv by its steps (20 at 20–30, 26 at 50, 51 at 100), Rodin 60; a wired engine at the dearest', () => {
    for (const ct of ['Generate3DNode', 'Hunyuan3DRemoteNode']) expect(priceNode(ct, sample(ct as Gen3dClass).widgets)).toEqual({ usd: 0.1, credits: 20 })
    const mv = sample('Hunyuan3DMultiViewNode').widgets
    const want: [unknown, unknown, number][] = [
      ['TRELLIS (textured)', 50, 12], ['Rodin (textured · quad mesh)', 50, 60],
      ['Hunyuan3D-2mv (geometry only)', 20, 20], ['Hunyuan3D-2mv (geometry only)', 30, 20], ['Hunyuan3D-2mv (geometry only)', 50, 26],
      ['Hunyuan3D-2mv (geometry only)', 100, 51], ['Hunyuan3D-2mv (geometry only)', ['s', 0], 51],
      [['e', 0], 50, 60], [['e', 0], 100, 60],
    ]
    for (const [engine, steps, credits] of want) {
      const p = priceNode('Hunyuan3DMultiViewNode', { ...mv, engine, steps }, { families: ON })
      expect('refused' in p ? p : p.credits, `${String(engine)} ${String(steps)}`).toBe(credits)
      // The runner's hold (nodeCredits, the server's families) is the same figure.
      expect(stageEstimate({ n: { class_type: 'Hunyuan3DMultiViewNode', inputs: { ...mv, engine, steps } } }, ['n'], false, ON), `${String(engine)} ${String(steps)}`).toBe(credits)
    }
    expect(creditsForUsd(0.4)).toBe(60)
    // A bare node: Python's default engine (TRELLIS).
    expect(priceNode('Hunyuan3DMultiViewNode', {})).toEqual({ usd: 0.06, credits: 12 })
  })

  it('the ComfyUI path (priceGraph, the hosted meter) and the badge: an estimate never below the flat 45 before R3 (fix round 2); Rodin (verified) 60', async () => {
    const { nodeCreditEstimate } = await import('~/lib/nodeCreditEstimate')
    const graph = (ct: string, inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: ct, inputs } }).nodes!['1']
    for (const ct of ['Generate3DNode', 'Hunyuan3DRemoteNode']) {
      expect(graph(ct, sample(ct as Gen3dClass).widgets), ct).toBe(45)
      expect(nodeCreditEstimate(ct, sample(ct as Gen3dClass).widgets), ct).toBe(45 + BASE_RENDER_CREDITS)
    }
    const mv = sample('Hunyuan3DMultiViewNode').widgets
    const want: [unknown, unknown, number][] = [
      ['TRELLIS (textured)', 50, 45], ['Rodin (textured · quad mesh)', 50, 60], ['Hunyuan3D-2mv (geometry only)', 50, 45],
      ['Hunyuan3D-2mv (geometry only)', 100, 51], [['e', 0], 50, 60],
    ]
    for (const [engine, steps, credits] of want) {
      expect(graph('Hunyuan3DMultiViewNode', { ...mv, engine, steps }), `${String(engine)} ${String(steps)}`).toBe(credits)
      expect(nodeCreditEstimate('Hunyuan3DMultiViewNode', { ...mv, engine, steps }), `${String(engine)} ${String(steps)}`).toBe(credits + BASE_RENDER_CREDITS)
    }
    // On the runner (the family on), the card: the badge too, when told the families.
    expect(nodeCreditEstimate('Hunyuan3DMultiViewNode', { ...mv, engine: 'TRELLIS (textured)' }, { families: ON })).toBe(12 + BASE_RENDER_CREDITS)
    expect(priceGraph({ 1: { class_type: 'Hunyuan3DMultiViewNode', inputs: mv } }, { families: ON }).nodes!['1']).toBe(12)
  })

  it('nothing is free: every class makes its call (no no-call branch in Python)', () => {
    for (const c of GEN_3D_CLASSES) expect(paidNoCall(c, {}), c).toBe(false)
  })

  it('hosted: held at the node\'s price and charged the same; a failed answer is not charged', async () => {
    const c = caseNamed('multi-view · Rodin · four views · defaults')
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: GLB_URL }) })
    const k = makeKit({ hosted: true, available: 5000, replicate, deps: { families: () => ON, download: async () => ({ bytes: glb(), contentType: 'model/gltf-binary' }) } })
    await writePictures(k.root, c)
    const p = withPictures(c)
    // The node's price alone: no render in the stage (a Frame or a Save image would add BASE_RENDER_CREDITS).
    const hold = stageEstimate(p, Object.keys(p), false, ON)
    expect(hold).toBe(60)
    expect(BASE_RENDER_CREDITS).toBe(1)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes.n!.status).toBe('done')
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[hold, hold]])
    // Hunyuan3D 2's `{mesh}` answer (Python can't read it; the runner reads `mesh`, R3.9 fix round 1): done, charged as normal.
    const bad = caseNamed('generate 3d · answer mesh dict')
    const r2 = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: { mesh: GLB_URL } }) })
    const k2 = makeKit({ hosted: true, available: 5000, replicate: r2, deps: { families: () => ON, download: async () => ({ bytes: glb(), contentType: null }) } })
    await writePictures(k2.root, bad)
    const run2 = await k2.engine.startRun({ userId: k2.userId, takes: [withPictures(bad)], ...START })
    await k2.engine.settled(run2.runId)
    const rec2 = (await k2.store.get(run2.runId))!.takes[0]!.nodes.n!
    expect(rec2.status, rec2.error ?? '').toBe('done')
    expect((rec2.values![0] as { kind: string }).kind).toBe('glb')
    expect([...k2.ledger.holds.values()].map(h => [h.state, h.credits, h.actual])).toEqual([['settled', 20, 20]])
    // A `mesh` that isn't text is no file: fails plainly, the hold released.
    const r3 = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: { mesh: [GLB_URL] } }) })
    const k3 = makeKit({ hosted: true, available: 5000, replicate: r3, deps: { families: () => ON, download: async () => ({ bytes: glb(), contentType: null }) } })
    await writePictures(k3.root, bad)
    const run3 = await k3.engine.startRun({ userId: k3.userId, takes: [withPictures(bad)], ...START })
    await k3.engine.settled(run3.runId)
    expect((await k3.store.get(run3.runId))!.takes[0]!.nodes.n!.error).toBe('The provider returned no 3D model')
    expect([...k3.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })
})

describe('the 3D file (ruling (k))', () => {
  const c = caseNamed('generate 3d · defaults')
  const kitFor = (o: { hosted?: boolean, download?: (url: string, opts: { maxBytes: number }) => Promise<{ bytes: Uint8Array, contentType: string | null }> } = {}) => {
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: [GLB_URL] }) })
    const download = vi.fn(o.download ?? (async () => ({ bytes: glb(), contentType: 'model/gltf-binary' })))
    const reportError = vi.fn()
    const k = makeKit({ hosted: o.hosted, available: 5000, replicate, deps: { families: () => ON, download: download as never, reportError } })
    return { k, replicate, download, reportError }
  }

  it('hosted: saved in the user\'s own folder, recorded as the user\'s; /view serves it to its owner and to no one else', async () => {
    const { k } = kitFor({ hosted: true })
    await writePictures(k.root, c)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [withPictures(c)], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    const v = rec.values![0] as { kind: 'glb', url: string, file: OutputFile }
    expect(v.kind).toBe('glb')
    expect(v.file.subfolder).toMatch(/^u_/)
    expect(Buffer.compare(readFileSync(join(k.root, 'output', v.file.subfolder, v.file.filename)), Buffer.from(glb()))).toBe(0)
    // The address as /view reads it: the gate checks the key the run recorded for its owner.
    const q = new URL(v.url, 'http://x')
    const gate = viewGateDecision({ filename: q.searchParams.get('filename')!, subfolder: q.searchParams.get('subfolder')!, type: q.searchParams.get('type')! })
    if (gate.kind !== 'check') throw new Error('the address is not checked')
    const created = (k.graphRuns.create.mock.calls as unknown as [{ promptId: string; userId: string }][]).map(x => x[0])
    const appended = k.graphRuns.appendOutput.mock.calls as unknown as [string, string][]
    const ownedBy = (userId: string) => new Set(appended.filter(([stage]) => created.some(r => r.promptId === stage && r.userId === userId)).map(a => a[1]))
    expect(ownedBy(k.userId!).has(gate.key)).toBe(true)
    expect(ownedBy('user_2').has(gate.key)).toBe(false)
  })

  it('a 600 MB answer is refused by the 3D cap after the call; the node fails plainly, not charged (a lost download)', async () => {
    const { k, download, reportError } = kitFor({
      hosted: true,
      download: async (_url, o) => {
        if (600 * MIB > o.maxBytes) throw new Error(answerTooLarge('glb', o.maxBytes))
        return { bytes: glb(), contentType: null }
      },
    })
    await writePictures(k.root, c)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [withPictures(c)], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status).toBe('error')
    expect(rec.error).toBe('The 3D model the service made is too large to keep (over 512 MB)')
    expect((download.mock.calls[0] as unknown[])[1]).toMatchObject({ maxBytes: ANSWER_MAX_BYTES.glb, kind: 'glb' })
    expect(k.replicate.client.submit).toHaveBeenCalledTimes(1)
    expect([...k.ledger.holds.values()].map(h => [h.state, h.actual ?? 0])).toEqual([['released', 0]])
    expect(reportError.mock.calls.map(x => (x[1] as { site: string }).site)).toContain('runner.download.lost')
  })

  it('bytes that aren\'t a GLB are refused plainly', async () => {
    const { k } = kitFor({ download: async () => ({ bytes: new TextEncoder().encode('<html>'), contentType: 'model/gltf-binary' }) })
    await writePictures(k.root, c)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [withPictures(c)], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes.n!.error).toBe(ANSWER_NOT_GLB)
  })

  it('the 3D model card, 3D Studio and a Text card read the address (pruned as ComfyUI prunes: each is an output node)', async () => {
    const { k } = kitFor()
    await writePictures(k.root, c)
    writeFileSync(join(k.root, 'input', 'beauty.png'), await png())
    const p = withPictures(c, {
      m: { class_type: 'Model3D', inputs: { glb_url: ['n', 0] } },
      t: { class_type: 'Text', inputs: { text: '', source: ['n', 0] } },
      s: { class_type: 'Scene3DStudio', inputs: { scene_state: '{}', beauty_image: 'beauty.png', depth_image: '', normal_image: '', glb_url: ['n', 0] } },
      o: { class_type: 'Image', inputs: { image: '', export: false, images: ['s', 0], batch_index: -1 } },
    })
    expect(isRunnerEligible(p, ON)).toBe(true)
    for (const id of ['n', 'm', 't', 's']) expect(runnerTakesNode(p, id, ON), id).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    for (const id of ['n', 'm', 't', 's', 'o']) expect(nodes[id]!.status, `${id}: ${nodes[id]!.error ?? ''}`).toBe('done')
    const url = (nodes.n!.values![0] as { url: string }).url
    expect(url).toMatch(/^\/view\?filename=model3d_\d+_\.glb&subfolder=&type=output$/)
    expect(nodes.m!.values).toEqual({ 0: { kind: 'text', text: url } })
    expect(nodes.t!.values).toEqual({ 0: { kind: 'text', text: url } })
    expect(k.replicate.client.submit).toHaveBeenCalledTimes(1)
  })

  it('a reader that takes no address (a prompt) leaves the workflow to the engine', () => {
    const p = withPictures(c, { g: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: ['n', 0], aspect_ratio: '1:1', seed: 0, model_options: '{}' } } })
    expect(runnerTakesNode(p, 'g', ON)).toBe(false)
  })
})

describe('Multi-View\'s pictures', () => {
  it('each view is its linked picture, front first; a missing front is left to the engine', async () => {
    const c = caseNamed('multi-view · TRELLIS · front and right · defaults')
    expect((await planOf(c)).payload.images).toEqual(['https://fal.storage/front_image.png', 'https://fal.storage/right_image.png'])
    const p = withPictures(c)
    expect(runnerTakesNode(p, 'n', ON)).toBe(true)
    delete p.n!.inputs.front_image
    expect(runnerTakesNode(p, 'n', ON)).toBe(false)
  })

  it('hosted: a picture that isn\'t the user\'s own is refused before the hold', async () => {
    const c = caseNamed('multi-view · Hunyuan3D-2mv · four views · defaults')
    const k = makeKit({ hosted: true, deps: { families: () => ON, ownership: { ownsInput: async () => false, ownsOutput: async () => false } } })
    await writePictures(k.root, c)
    await expect(k.engine.startRun({ userId: k.userId, takes: [withPictures(c)], ...START })).rejects.toThrow('isn’t one of yours')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })
})

describe('Hunyuan3D 2\'s `{mesh}` answer (R3.9 fix round 1, controller ruling)', () => {
  it('the runner reads `mesh` (a deliberate deviation); a list or a string as before; anything else no file', () => {
    expect(hunyuan3dGlbUrl({ output: { mesh: GLB_URL } })).toEqual([GLB_URL])
    expect(hunyuan3dGlbUrl({ output: [GLB_URL, 'x'] })).toEqual([GLB_URL])
    expect(hunyuan3dGlbUrl({ output: GLB_URL })).toEqual([GLB_URL])
    for (const mesh of ['', null, [GLB_URL], 7]) expect(hunyuan3dGlbUrl({ output: { mesh } }), String(mesh)).toEqual([])
    expect(hunyuan3dGlbUrl({ output: { glb: GLB_URL } })).toEqual([])
  })

  it('the ComfyUI path (the /prompt gate, hosted and local) refuses Generate a 3D model and its twin; Multi-View is unaffected', () => {
    for (const ct of ['Generate3DNode', 'Hunyuan3DRemoteNode'] as const) {
      const p = withPictures(sample(ct))
      expect(requestProblems(p).map(x => x.message), ct).toEqual([GENERATE_3D_RUNNER_ONLY])
      expect(blockedPromptRefusal(p)?.error.message, ct).toBe(GENERATE_3D_RUNNER_ONLY)
      // The runner takes it.
      expect(requestProblems(p, { runner: true }), ct).toEqual([])
    }
    // Multi-View's three engines answer a plain URL (Hunyuan3D-2mv, Rodin) or `{model_file}`, which Python reads.
    for (const engine of MULTI_VIEW_ENGINES) {
      const p = withPictures(sample('Hunyuan3DMultiViewNode'))
      p.n!.inputs.engine = engine
      expect(requestProblems(p), engine).toEqual([])
      expect(blockedPromptRefusal(p), engine).toBeNull()
    }
    expect(GENERATE_3D_RUNNER_ONLY).not.toMatch(/Node|_|\bid\b|Hunyuan|gen-3d/)
  })

  it('the hosted /prompt meter refuses it before pricing or any hold; Multi-View goes through', async () => {
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
    for (const ct of ['Generate3DNode', 'Hunyuan3DRemoteNode'] as const) {
      const d = meterDeps()
      const r = await meterGraphSubmit('u1', { prompt: withPictures(sample(ct)) }, d as any)
      expect(r.status, ct).toBe(400)
      expect((r.body as any).error.message).toBe(GENERATE_3D_RUNNER_ONLY)
      expect(Object.values((r.body as any).node_errors).map((e: any) => e.class_type)).toEqual([ct])
      expect(d.priceGraph).not.toHaveBeenCalled()
      expect(d.hold).not.toHaveBeenCalled()
      expect(d.forward).not.toHaveBeenCalled()
    }
    const d = meterDeps()
    const ok = await meterGraphSubmit('u1', { prompt: withPictures(sample('Hunyuan3DMultiViewNode')) }, d as any)
    expect(ok.status).toBe(200)
    expect(d.forward).toHaveBeenCalled()
  })
})

describe('refusals and moderation', () => {
  it('Hunyuan3D 2 over 50 steps or at a mesh resolution it doesn\'t take: refused on a runner run, in plain words', () => {
    const c = sample('Generate3DNode')
    expect(requestProblems({ n: node(c, { steps: 55 }) }, { runner: true }).map(p => p.message)).toEqual([HUNYUAN3D_TOO_MANY_STEPS])
    for (const o of [128, 192, 320, 448]) expect(requestProblems({ n: node(c, { octree_resolution: o }) }, { runner: true }).map(p => p.message)).toEqual([HUNYUAN3D_OCTREE_REFUSED])
    for (const o of [256, 384, 512]) expect(requestProblems({ n: node(c, { octree_resolution: o, steps: 50 }) }, { runner: true })).toEqual([])
    // Hunyuan3D-2mv takes them all (its schema: steps 1–100, octree 16–512).
    const mv = caseNamed('multi-view · Hunyuan3D-2mv · front and right · every setting')
    expect(requestProblems({ n: node(mv) }, { runner: true })).toEqual([])
    for (const w of [HUNYUAN3D_TOO_MANY_STEPS, HUNYUAN3D_OCTREE_REFUSED]) expect(w).not.toMatch(/Node|_|\bid\b/)
  })

  it('Multi-View\'s prompt is moderated only where it is sent: Rodin, or a wired engine (fix round 2); the others send no text', async () => {
    expect(PAID_TEXT_INPUTS.Hunyuan3DMultiViewNode).toEqual(['prompt'])
    expect(PAID_TEXT_INPUTS.Generate3DNode).toBeUndefined()
    const mv = sample('Hunyuan3DMultiViewNode')
    const { extractGraphPromptTexts } = await import('~~/server/utils/graphPromptText')
    for (const [engine, sent] of [['Rodin (textured · quad mesh)', true], [['e', 0], true], ['TRELLIS (textured)', false], ['Hunyuan3D-2mv (geometry only)', false]] as const) {
      const p = { n: node(mv, { prompt: 'a knight', engine }) }
      expect(extraPromptTexts(p), String(engine)).toEqual(sent ? ['a knight'] : [])
      expect(extractGraphPromptTexts(p), String(engine)).toEqual(sent ? ['a knight'] : [])
    }
    // A flagged leftover prompt on TRELLIS never reaches moderation, and the run goes on.
    {
      const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
      const c = caseNamed('multi-view · TRELLIS · front · defaults')
      const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: { model_file: GLB_URL } }) })
      const k = makeKit({ hosted: true, available: 5000, moderate, replicate, deps: { families: () => ON, download: async () => ({ bytes: glb(), contentType: null }) } })
      await writePictures(k.root, c)
      const p = withPictures(c)
      p.n!.inputs.prompt = 'a forbidden thing'
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
      await k.engine.settled(runId)
      expect(moderate.mock.calls.map(x => x[0])).not.toContain('a forbidden thing')
      expect((await k.store.get(runId))!.takes[0]!.nodes.n!.status).toBe('done')
      expect(replicate.submitted()[0]!.payload.prompt).toBeUndefined()
    }
    const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
    const c = caseNamed('multi-view · Rodin · front · defaults')
    const k = makeKit({ hosted: true, moderate, deps: { families: () => ON } })
    await writePictures(k.root, c)
    const p = withPictures(c)
    p.n!.inputs.prompt = 'a forbidden thing'
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow()
    expect(moderate.mock.calls.map(x => x[0])).toContain('a forbidden thing')
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('a Text card wired into the prompt arrives as typed (Rodin sends it stripped)', async () => {
    const c = caseNamed('multi-view · Rodin · front · defaults')
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: GLB_URL }) })
    const k = makeKit({ replicate, deps: { families: () => ON, download: async () => ({ bytes: glb(), contentType: null }) } })
    await writePictures(k.root, c)
    const p = withPictures(c, { t: { class_type: 'Text', inputs: { text: '  a knight in armour ' } } })
    p.n!.inputs.prompt = ['t', 0]
    expect(isRunnerEligible(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect(replicate.submitted()[0]!.payload.prompt).toBe('a knight in armour')
  })
})

describe('with gen-3d off (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but gen-3d', RUNNER_FAMILIES.filter(f => f !== 'gen-3d')],
  ]
  const is3d = (ct: string) => (GEN_3D_CLASSES as readonly string[]).includes(ct)
  /** The same prompt as before R3.9: the classes had no rule row (renamed to one that has none). */
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, is3d(n.class_type) ? { ...n, class_type: `${n.class_type}Before` } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        expect(valueWiresAllowed(p, id, outputKindsFor(families), families), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families), families))
      }
      expect(outputKindsFor(families).Generate3DNode, name).toBeUndefined()
    }
  }

  it('each class is left to the engine, and named by the needs-the-engine list; its route is Replicate, no backup', () => {
    for (const ct of GEN_3D_CLASSES) {
      const p = withPictures(sample(ct))
      expect(runnerTakesNode(p, 'n', new Set(['cards'])), ct).toBe(false)
      expect(runnerTakesNode(p, 'n', ON), ct).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id }), ct).toContain('n')
      expect(SWITCHED_CLASSES[ct]).toBe('gen-3d')
      expect(RUNNER_OUTPUT_CLASSES.has(ct)).toBe(true)
      expect(RUNNER_ROUTES[ct]).toMatchObject({ first: 'replicate', backup: null })
    }
    expect(outputKindsFor(ON).Hunyuan3DMultiViewNode).toEqual({ 0: 'glb' })
  })

  it('gen-3d needs cards', () => {
    expect(isRunnerEligible(withPictures(sample('Generate3DNode')), new Set<RunnerFamily>(['gen-3d']))).toBe(false)
  })

  it('over synthetic chains: alone, into a 3D model card, a Text card, 3D Studio, a Text card into the prompt', () => {
    for (const ct of GEN_3D_CLASSES) {
      const p = withPictures(sample(ct))
      sameAsBefore(p, `${ct} alone`)
      sameAsBefore({ ...p, m: { class_type: 'Model3D', inputs: { glb_url: ['n', 0] } } }, `${ct} → 3D model card`)
      sameAsBefore({ ...p, t: { class_type: 'Text', inputs: { text: '', source: ['n', 0] } } }, `${ct} → Text card`)
      sameAsBefore({ ...p, s: { class_type: 'Scene3DStudio', inputs: { scene_state: '{}', beauty_image: 'b.png', depth_image: '', normal_image: '', glb_url: ['n', 0] } } }, `${ct} → 3D Studio`)
    }
    const mv = withPictures(sample('Hunyuan3DMultiViewNode'), { t: { class_type: 'Text', inputs: { text: 'a knight' } } })
    mv.n!.inputs.prompt = ['t', 0]
    sameAsBefore(mv, 'Text → Multi-View prompt')
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (with Generate a 3D model → 3D model card spliced in beside each)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    const extra = withPictures(sample('Generate3DNode'), { d_card: { class_type: 'Model3D', inputs: { glb_url: ['n', 0] } } })
    const spliced = Object.fromEntries(Object.entries(extra).map(([id, n]) => [`d_${id}`, { ...n, inputs: Object.fromEntries(Object.entries(n.inputs).map(([k, v]) => [k, Array.isArray(v) && v.length === 2 ? [`d_${String(v[0])}`, v[1]] : v])) }])) as ApiPrompt
    let graphs = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const cv of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(cv.workflow as never, catalog) }
        catch { continue }
        graphs++
        sameAsBefore(p, uuid)
        sameAsBefore({ ...p, ...spliced }, `${uuid} + 3D → card`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`gen-3d families-off invariant: ${graphs} saved graphs`)
  }, 600_000)
})
