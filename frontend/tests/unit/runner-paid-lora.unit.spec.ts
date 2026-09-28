/**
 * R3.13: Flux Dev + LoRA and Flux Dev + LoRAs (family `lora`) — the user's
 * trained model or black-forest-labs/flux-dev-lora, and
 * lucataco/flux-dev-multi-lora with its reload retry — against what their
 * real Python sends and returns (fixtures/runner-paid-lora.json,
 * scripts/runner_paid_fixtures.py --group lora, run with a temporary
 * models/loras/ and the HuggingFace look-up served found / not found /
 * offline), priced per call on both paths.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createFakeReplicate, makeKit } from './__runner__/kit'
import { normalizeSent, readerFor, runPaidCase, wireText, type PaidCase } from './__runner__/paidParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { IMAGE_OUTPUT_CLASSES, PAID_PICTURE_FAMILY, RUNNER_NODE_RULES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import {
  FLUX_DEV_LORA_GUIDANCE_MAX, FLUX_DEV_LORA_SLUG, FLUX_LORA_GUIDANCE_TOO_HIGH, FLUX_MULTI_LORA_SLUG, LORA_BY_NAME_HOSTED, LORA_CLASSES, LORA_LINK_NOT_PUBLIC, LORA_TRAINED_MODEL_HOSTED, LORA_WIRED_HOSTED,
  MULTI_LORA_NEEDS_LORA, bareOwnerModel, foldPromptIn, hostedLoraProblem, isReplicateModelRef, multiLoraCount, multiloraCollect, normalizeLoraRef,
  replicateModelToLoraRef, type LoraClass,
} from '#shared/runner/lora'
import { parsePyJson, pyJsonDumps, type PyJson } from '#shared/runner/pyJson'
import { PAID_RATES, otherCardFor, paidCallUsd } from '#shared/pricing/paidRates'
import { EDIT_RATES } from '#shared/pricing/editRates'
import { PAID_NODE_CLASSES, paidNoCall } from '#shared/pricing/paidSettings'
import { PRE_R3_FLAT, readsEstimateCard } from '#shared/pricing/estimateFloor'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { BASE_RENDER_CREDITS, GRAPH_NODE_CREDITS, LORA_RENDER_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { __setInputUploadsEngineRootForTests } from '~~/server/utils/inputUploads'
import { PAID_TEXT_INPUTS, extraPromptTexts, stageEstimate } from '~~/server/runner/metering'
import { planNode, type NodePlan, type PipelineIO } from '~~/server/runner/executors'
import {
  LORA_NO_PICTURE, __setHuggingFaceLookupForTests, __setMultiLoraRotationForTests, autodetectHuggingface, loraWeightsLoaded, multiLoraRotation,
} from '~~/server/runner/generators/lora'
import { LORA_NOT_LISTED, LORA_SIDECAR_MAX_BYTES, LORA_SIDECAR_TOO_LARGE, LORA_SIDECAR_UNREADABLE, loraStartProblem, readLoraSidecar } from '~~/server/runner/loraFiles'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { hostedRequestProblems, requestProblems } from '~~/server/runner/requestRules'
import * as safeFetchModule from '~~/server/templates/safeFetch'
import { checkPayload, type ProviderSchemaFixture } from './helpers/providerSchema'

vi.mock('~~/server/templates/safeFetch', async (importOriginal) => {
  const mod = await importOriginal<typeof import('~~/server/templates/safeFetch')>()
  return { ...mod, safeFetch: vi.fn(mod.safeFetch) }
})

interface Catalogue {
  is_model_ref: Record<string, boolean>
  bare_owner_model: Record<string, string>
  normalize: Record<string, string>
  to_lora_ref: Record<string, string>
  collect: { resolved: [string | null, number][]; out: [string[], number[]] }[]
  fold: { prompt: string; prompt_in: string; out: string }[]
}
type LoraCase = PaidCase & { rotate?: number }
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-lora.json'), 'utf8')) as { cases: LoraCase[]; loras: Record<string, string | null>; catalogue: Catalogue }
const CASES = FIXTURE.cases
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'lora'])
const OUT = 'https://r.test/lora/out.png'
const MARKER_LOGS = 'Downloading LoRA weights from https://x\n'

const caseNamed = (name: string): LoraCase => {
  const c = CASES.find(x => x.name === name)
  if (!c) throw new Error(`no fixture case ${name}`)
  return c
}
const isMulti = (c: PaidCase) => c.class_type === 'FluxMultiLoRARemoteNode'

// ── A models/loras/ with the fixture's files, and the engine root pointing at it ──

function loraRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'runner-lora-root-'))
  for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
  for (const [name, sidecar] of Object.entries(FIXTURE.loras)) {
    const file = join(root, 'models', 'loras', name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '')
    if (sidecar !== null) writeFileSync(file.replace(/\.safetensors$/, '.json'), sidecar)
  }
  return root
}
let ROOT = ''
beforeAll(() => { ROOT = loraRoot() })
// After the setup's own engine-root safety net (which points every test at an empty folder).
beforeEach(() => __setInputUploadsEngineRootForTests(ROOT))
afterEach(() => __setHuggingFaceLookupForTests(null))

// ── The HuggingFace look-up, served as the case served it (no network) ──

function hfFrom(c: PaidCase, seen: string[] = []) {
  return async (repo: string) => {
    const url = `https://huggingface.co/api/models/${repo}`
    seen.push(url)
    const l = c.links?.[url]
    if (l === undefined) throw new Error(`${c.name}: look-up ${url} is not served by the case`)
    if (typeof l === 'object' && 'raise' in l) throw new Error(l.raise)
    return (typeof l === 'string' ? 200 : l.status) === 200
  }
}
const hfGets = (c: PaidCase) => (c.gets ?? []).filter(g => g.url.startsWith('https://huggingface.co/api/models/')).map(g => g.url)

/** A LoadImage feeding the picture (image-to-image), and a card showing the result. */
function withPictures(c: PaidCase, id = 'n'): ApiPrompt {
  const p: ApiPrompt = { [id]: { class_type: c.class_type, inputs: { ...c.widgets } }, ...readerFor(c.class_type, id) }
  for (const name of c.pictures ?? []) {
    p[`p_${name}`] = { class_type: 'LoadImage', inputs: { image: `${name}.png`, upload: 'image' } }
    p[id]!.inputs[name] = [`p_${name}`, 0]
  }
  return p
}

async function planOf(c: PaidCase, hosted = false): Promise<NodePlan> {
  return planNode({
    prompt: withPictures(c), nodeId: 'n', gateOpen: false, hosted,
    filesFrom: link => (String(link[0]).startsWith('p_') ? [{ filename: `${String(link[0]).slice(2)}.png`, subfolder: '', type: 'input' }] : []),
    toUrl: async f => `https://fal.storage/${f.filename}`,
  })
}

/** A pipeline run with a fake io: the case's answers in call order, its files downloaded; what it sent. */
async function runPipeline(plan: Extract<NodePlan, { kind: 'pipeline' }>, c: PaidCase, recorded: (key: string) => Record<string, unknown> | null = () => null) {
  const queue = [...c.answers]
  const sent: { key: string; provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown>; usd: number }[] = []
  const saved: { prefix: string; bytes: Uint8Array }[] = []
  const io = {
    call: async (x: { key: string; provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown>; usd: number }) => {
      sent.push({ key: x.key, provider: x.provider, endpoint: x.endpoint, payload: x.payload, usd: x.usd })
      if (!queue.length) throw new Error(`${c.name}: more calls than Python`)
      const result = { id: 'p', status: 'succeeded', ...(queue.shift() as Record<string, unknown>) }
      return { result, raw: JSON.stringify(result), urls: [] }
    },
    download: async (url: string) => ({ bytes: new Uint8Array(Buffer.from(c.files![url]!, 'base64')), contentType: 'image/png' }),
    savedOnce: async (_k: string, _s: string, make: () => Promise<unknown>) => make(),
    saveAsset: async (bytes: Uint8Array, o: { prefix: string }) => {
      saved.push({ prefix: o.prefix, bytes })
      return { filename: `${o.prefix}_00001_.png`, subfolder: '', type: 'output' }
    },
    recorded,
    signal: new AbortController().signal,
  } as unknown as PipelineIO
  let error: string | null = null
  let made: Awaited<ReturnType<typeof plan.run>> | null = null
  try { made = await plan.run(io) }
  catch (e) { error = e instanceof Error ? e.message : String(e) }
  return { sent, saved, made, error }
}

/** Python's picture link `IMG:<input>` is the handed-off picture. */
const asPython = (c: PaidCase, payload: Record<string, unknown>) => normalizeSent([{ provider: 'replicate', endpoint: '', payload }], c.pictures ?? [])[0]!.payload

/**
 * Python's wire text with its one known difference from the runner's (R3.3
 * ruling 1, FLOAT widgets only): a whole float (lora_scale 1.0, guidance
 * 0.0, a scale of 0.0) is written `1.0` by Python and `1` by the runner — the
 * same JSON number.
 */
const FLOAT_KEYS = new Set(['guidance', 'guidance_scale', 'lora_scale', 'prompt_strength', 'lora_scales'])
function pythonWire(payloadJson: string): string {
  const whole = (v: PyJson): PyJson => (v && typeof v === 'object' && 'float' in v && Number.isInteger(v.float) ? { int: String(v.float) } : v)
  const walk = (v: PyJson): PyJson => {
    if (v && typeof v === 'object' && 'obj' in v) {
      return { obj: v.obj.map(([k, x]) => [k, FLOAT_KEYS.has(k) ? (Array.isArray(x) ? x.map(whole) : whole(x)) : x] as [string, PyJson]) }
    }
    return v
  }
  return pyJsonDumps(walk(parsePyJson(payloadJson)))
}

/** What the runner says where Python raised (its own words are about sidecars and field names). */
function expectedError(c: PaidCase): string | null {
  if (!c.error) return null
  if (c.error.type === 'AttributeError') return LORA_SIDECAR_UNREADABLE
  if (c.error.message.startsWith('No LoRAs resolved')) return MULTI_LORA_NEEDS_LORA
  if (c.error.message.startsWith('Replicate returned no output')) return 'no picture'
  throw new Error(`${c.name}: an error the test doesn't map: ${c.error.message}`)
}

/** A guidance flux-dev-lora's schema refuses (max 10): the runner refuses it before the hold; Python sends it. */
const guidanceRefused = (c: PaidCase) => c.calls[0]?.endpoint === FLUX_DEV_LORA_SLUG && (c.calls[0]!.payload.guidance as number) > FLUX_DEV_LORA_GUIDANCE_MAX

// ── The published inputs (each model page's schema, read 2026-09-27), until the controller saves them ──

const publishedInput = (properties: Record<string, unknown>): ProviderSchemaFixture => ({
  endpoint: '', fetchedAt: '2026-09-27', input: { type: 'object', required: ['prompt'], properties }, output: {}, components: { schemas: {} },
})
const RATIOS = ['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3', '9:16', '9:21']
const PUBLISHED: Record<string, ProviderSchemaFixture> = {
  [FLUX_DEV_LORA_SLUG]: publishedInput({
    seed: { type: 'integer' }, image: { type: 'string', format: 'uri' }, prompt: { type: 'string' }, go_fast: { type: 'boolean' },
    guidance: { type: 'number', maximum: 10, minimum: 0 }, extra_lora: { type: 'string' }, lora_scale: { type: 'number', maximum: 3, minimum: -1 },
    megapixels: { enum: ['1', '0.25'], type: 'string' }, num_outputs: { type: 'integer', maximum: 4, minimum: 1 }, aspect_ratio: { enum: RATIOS, type: 'string' },
    lora_weights: { type: 'string' }, output_format: { enum: ['webp', 'jpg', 'png'], type: 'string' }, output_quality: { type: 'integer', maximum: 100, minimum: 0 },
    prompt_strength: { type: 'number', maximum: 1, minimum: 0 }, num_inference_steps: { type: 'integer', maximum: 50, minimum: 1 }, disable_safety_checker: { type: 'boolean' },
  }),
  [FLUX_MULTI_LORA_SLUG]: publishedInput({
    seed: { type: 'integer' }, image: { type: 'string', format: 'uri' }, prompt: { type: 'string' }, hf_loras: { type: 'array' }, lora_scales: { type: 'array' },
    num_outputs: { type: 'integer', maximum: 4, minimum: 1 }, aspect_ratio: { enum: RATIOS, type: 'string' }, output_format: { enum: ['webp', 'jpg', 'png'], type: 'string' },
    guidance_scale: { type: 'number', maximum: 10, minimum: 0 }, output_quality: { type: 'integer', maximum: 100, minimum: 0 },
    prompt_strength: { type: 'number', maximum: 1, minimum: 0 }, num_inference_steps: { type: 'integer', maximum: 50, minimum: 1 }, disable_safety_checker: { type: 'boolean' },
  }),
}
const offSchema: string[] = []

async function png(w: number, h: number, channels: 3 | 4 = 3): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } }).png().toBuffer()
}

describe('the fixture', () => {
  it('covers every sidecar kind, every link form, 0/1/2/4 slots, repeats, prompt_in / style_in, the marker and the toggle', () => {
    const names = new Set(CASES.map(c => c.name))
    expect(new Set(CASES.map(c => c.class_type))).toEqual(new Set(LORA_CLASSES))
    for (const f of Object.keys(FIXTURE.loras)) expect(names.has(`single · name ${f}`), f).toBe(true)
    for (const n of ['trained ref', 'trained ref with version', 'huggingface https', 'hf.co', 'civitai', 'safetensors url', 'bare four parts found', 'bare four parts missing', 'bare four parts offline']) {
      expect(names.has(`single · url ${n}`), n).toBe(true)
    }
    for (const n of ['multi · no slots', 'multi · one slot name · loaded', 'multi · two slots · rotate 0 · retried', 'multi · four slots · rotate 1 · loaded', 'multi · repeated · one left', 'multi · repeated · two left']) {
      expect(names.has(n), n).toBe(true)
    }
    for (const pi of ['blank', 'set']) for (const st of ['blank', 'set']) expect(names.has(`multi · prompt_in ${pi} · style_in ${st} · prompt`)).toBe(true)
    // Every endpoint is reached: flux-dev-lora, two trained models, the multi-LoRA model.
    expect(new Set(CASES.flatMap(c => c.calls.map(x => x.endpoint)))).toEqual(new Set([FLUX_DEV_LORA_SLUG, 'finnyjules/my-style', 'finnyjules/other-style', FLUX_MULTI_LORA_SLUG]))
    // The look-up's three branches (found, not found, offline) all happen.
    expect(new Set(CASES.flatMap(c => (c.gets ?? []).filter(g => g.url.includes('huggingface.co/api')).map(g => g.status)))).toEqual(new Set([200, 404, 0]))
    // Retried: two calls, the second the first's order flipped.
    const r = caseNamed('multi · two slots · rotate 0 · retried').calls
    expect(r.length).toBe(2)
    expect(r[1]!.payload.hf_loras).toEqual([...(r[0]!.payload.hf_loras as string[])].reverse())
    expect(CASES.length).toBeGreaterThanOrEqual(95)
  })
})

describe('replicate_refs.py, ported line for line', () => {
  const cat = FIXTURE.catalogue
  it('the reference readers over awkward strings', () => {
    for (const [r, want] of Object.entries(cat.is_model_ref)) expect(isReplicateModelRef(r), JSON.stringify(r)).toBe(want)
    for (const [r, want] of Object.entries(cat.bare_owner_model)) expect(bareOwnerModel(r), JSON.stringify(r)).toBe(want)
    for (const [r, want] of Object.entries(cat.normalize)) expect(normalizeLoraRef(r), JSON.stringify(r)).toBe(want)
    for (const [r, want] of Object.entries(cat.to_lora_ref)) expect(replicateModelToLoraRef(r), JSON.stringify(r)).toBe(want)
  })

  it('_multilora_collect and _fold_prompt_in', () => {
    for (const x of cat.collect) {
      const got = multiloraCollect(x.resolved)
      expect([got.loras, got.scales], JSON.stringify(x.resolved)).toEqual(x.out)
    }
    for (const x of cat.fold) expect(foldPromptIn(x.prompt, x.prompt_in), JSON.stringify(x)).toBe(x.out)
  })

  it('the sidecars as _read_lora_sidecar reads them', async () => {
    expect(await readLoraSidecar('[None]')).toBeNull()
    expect(await readLoraSidecar('')).toBeNull()
    expect(await readLoraSidecar('nosidecar.safetensors')).toBeNull()
    expect(await readLoraSidecar('broken.safetensors')).toBeNull()
    expect([...(await readLoraSidecar('null.safetensors'))!]).toEqual([])
    await expect(readLoraSidecar('list.safetensors')).rejects.toThrow(LORA_SIDECAR_UNREADABLE)
    expect((await readLoraSidecar('sub/nested.safetensors'))!.get('replicate_url')).toBe('https://replicate.delivery/n/nested.tar')
    // A name reaching outside the folder is refused, never read.
    await expect(readLoraSidecar('../../outside.safetensors')).rejects.toThrow(LORA_NOT_LISTED)
  })
})

describe('every fixture case: what Python sends and returns', () => {
  it.each(CASES.map(c => [c.name, c] as const))('%s', async (_n, c) => {
    const seen: string[] = []
    __setHuggingFaceLookupForTests(hfFrom(c, seen))
    if (c.rotate !== undefined) __setMultiLoraRotationForTests(c.rotate as 0 | 1)
    const want = expectedError(c)
    expect(paidNoCall(c.class_type, c.widgets)).toBe(false)
    if (want === LORA_SIDECAR_UNREADABLE || want === MULTI_LORA_NEEDS_LORA) {
      expect(c.calls).toEqual([])
      await expect(planOf(c)).rejects.toThrow(want)
      // No LoRA at all is known from the prompt: refused before the hold on a runner run (not on the ComfyUI path).
      const blank = c.name === 'multi · no slots'
      expect(requestProblems(withPictures(c), { runner: true }).map(p => p.message)).toEqual(blank ? [MULTI_LORA_NEEDS_LORA] : [])
      expect(requestProblems(withPictures(c))).toEqual([])
      return
    }
    if (guidanceRefused(c)) {
      expect(requestProblems(withPictures(c), { runner: true }).map(p => p.message)).toEqual([FLUX_LORA_GUIDANCE_TOO_HIGH])
      expect(requestProblems(withPictures(c))).toEqual([])
      await expect(planOf(c)).rejects.toThrow(FLUX_LORA_GUIDANCE_TOO_HIGH)
      offSchema.push(`${c.name}: ${checkPayload(PUBLISHED[FLUX_DEV_LORA_SLUG]!, c.calls[0]!.payload).join('; ')}`)
      return
    }
    expect(requestProblems(withPictures(c), { runner: true })).toEqual([])
    const plan = await planOf(c)
    // The HuggingFace look-ups, in Python's order.
    expect(seen).toEqual(hfGets(c))
    if (!isMulti(c)) {
      if (plan.kind !== 'provider') throw new Error('not a provider plan')
      expect({ provider: plan.provider, endpoint: plan.endpoint, payload: asPython(c, plan.payload) })
        .toEqual({ provider: c.calls[0]!.provider, endpoint: c.calls[0]!.endpoint, payload: c.calls[0]!.payload })
      expect(wireText(asPython(c, plan.payload))).toBe(pythonWire(c.calls[0]!.payload_json!))
      expect([plan.media, plan.take, plan.rgb, plan.prefix, plan.backup]).toEqual(['image', 'first', true, 'flux_lora', undefined])
      // The user's trained model is private: no published schema to check against.
      if (plan.endpoint === FLUX_DEV_LORA_SLUG) for (const e of checkPayload(PUBLISHED[FLUX_DEV_LORA_SLUG]!, plan.payload)) offSchema.push(`${c.name}: ${e}`)
      const files = [{ filename: 'x.png', subfolder: '', type: 'output' as const }]
      expect(plan.uiFor(files)).toEqual({ images: files, animated: [false] })
      expect((c.ui as { images: { prefix: string }[] } | null)?.images[0]!.prefix ?? 'flux_lora').toBe('flux_lora')
      return
    }
    if (plan.kind !== 'pipeline') throw new Error('not a pipeline')
    expect(plan.prefix).toBe('flux_multilora')
    const run = await runPipeline(plan, c)
    expect(run.sent.map(s => ({ provider: s.provider, endpoint: s.endpoint, payload: asPython(c, s.payload) })))
      .toEqual(c.calls.map(x => ({ provider: x.provider, endpoint: x.endpoint, payload: x.payload })))
    for (const [i, s] of run.sent.entries()) expect(wireText(asPython(c, s.payload)), `call ${i + 1}`).toBe(pythonWire(c.calls[i]!.payload_json!))
    for (const s of run.sent) for (const e of checkPayload(PUBLISHED[FLUX_MULTI_LORA_SLUG]!, s.payload)) offSchema.push(`${c.name}: ${e}`)
    expect(run.sent.map(s => s.key)).toEqual(['first', 'retry'].slice(0, c.calls.length))
    // Each call is priced by the card at the steps sent.
    for (const s of run.sent) expect(s.usd).toBe(paidCallUsd({ endpoint: FLUX_MULTI_LORA_SLUG, steps: c.widgets.num_inference_steps as number }))
    expect(run.error).toBeNull()
    expect(run.saved.map(s => s.prefix)).toEqual(['flux_multilora'])
    expect(run.made!.ui).toEqual({ images: [{ filename: 'flux_multilora_00001_.png', subfolder: '', type: 'output' }], animated: [false] })
    // The toggle stands where Python's stood after the case.
    const turned = c.calls.length && ((c.calls[0]!.payload.hf_loras as string[]).length >= 2)
    expect(multiLoraRotation()).toBe(turned ? (c.rotate! ^ 1) : c.rotate)
  })

  it('every payload fits its published schema but the guidance the runner refuses', () => {
    expect(offSchema.sort()).toEqual(['single · flux-dev-lora · steps 50: guidance: 20 is above the maximum 10'])
    // The trained model's guidance_scale isn't flux-dev-lora's: sent as Python sends it.
    expect(caseNamed('single · trained · steps 50').calls[0]!.payload.guidance_scale).toBe(20)
  })

  it('an answer with no picture fails plainly after the call (Python: "Replicate returned no output")', async () => {
    const c = caseNamed('single · answer none')
    expect(c.calls.length).toBe(1)
    const m = caseNamed('multi · two slots · rotate 0 · loaded')
    __setHuggingFaceLookupForTests(hfFrom(m))
    __setMultiLoraRotationForTests(0)
    const run = await runPipeline(await planOf(m) as Extract<NodePlan, { kind: 'pipeline' }>, { ...m, answers: [{ output: null, logs: MARKER_LOGS }] })
    expect(run.sent.length).toBe(1)
    expect(run.error).toBe(LORA_NO_PICTURE)
  })

  it('the logs as Python\'s `in` reads them', () => {
    expect(loraWeightsLoaded({ logs: MARKER_LOGS })).toBe(true)
    expect(loraWeightsLoaded({ logs: 'nothing' })).toBe(false)
    expect(loraWeightsLoaded({ logs: null })).toBe(false)
    expect(loraWeightsLoaded({})).toBe(false)
    expect(loraWeightsLoaded({ logs: ['Downloading LoRA weights'] })).toBe(true)
    expect(loraWeightsLoaded({ logs: ['Downloading LoRA weights from x'] })).toBe(false)
    expect(() => loraWeightsLoaded({ logs: 5 })).toThrow()
  })
})

describe('the reload retry and the order toggle (ruling (g))', () => {
  const two = caseNamed('multi · two slots · rotate 0 · loaded')

  it('the toggle alternates across two runs in one process, as Python\'s did', async () => {
    const first = caseNamed('multi · rotation · first run')
    const second = caseNamed('multi · rotation · second run')
    expect([first.rotate, second.rotate]).toEqual([0, 1])
    __setHuggingFaceLookupForTests(hfFrom(first))
    __setMultiLoraRotationForTests(0)
    const a = await runPipeline(await planOf(first) as Extract<NodePlan, { kind: 'pipeline' }>, first)
    const b = await runPipeline(await planOf(second) as Extract<NodePlan, { kind: 'pipeline' }>, second)
    expect(a.sent[0]!.payload.hf_loras).toEqual(first.calls[0]!.payload.hf_loras)
    expect(b.sent[0]!.payload.hf_loras).toEqual(second.calls[0]!.payload.hf_loras)
    expect(b.sent[0]!.payload.hf_loras).toEqual([...(a.sent[0]!.payload.hf_loras as string[])].reverse())
  })

  it('a resumed node keeps the order its first call was written down in, and never turns the toggle', async () => {
    __setHuggingFaceLookupForTests(hfFrom(two))
    __setMultiLoraRotationForTests(0)
    const plan = await planOf(two) as Extract<NodePlan, { kind: 'pipeline' }>
    const once = await runPipeline(plan, two)
    expect(multiLoraRotation()).toBe(1)
    // Resumed (the toggle has moved on since): the recorded order is sent again, the toggle left alone.
    const again = await runPipeline(plan, two, key => (key === 'first' ? once.sent[0]!.payload : null))
    expect(again.sent[0]!.payload).toEqual(once.sent[0]!.payload)
    expect(multiLoraRotation()).toBe(1)
    const straight = await runPipeline(plan, two, key => (key === 'first' ? { ...once.sent[0]!.payload, hf_loras: [...(once.sent[0]!.payload.hf_loras as string[])].reverse(), lora_scales: [...(once.sent[0]!.payload.lora_scales as number[])].reverse() } : null))
    expect(straight.sent[0]!.payload.hf_loras).toEqual([...(once.sent[0]!.payload.hf_loras as string[])].reverse())
    expect(multiLoraRotation()).toBe(1)
  })

  async function multiRun(answers: unknown[], o: { failSecond?: boolean } = {}) {
    const queue = [...answers]
    const bodyOf = new Map<unknown, string>()
    const k = makeKit({
      hosted: true, root: loraRoot(),
      replicate: createFakeReplicate({ bodyText: ({ input }) => bodyOf.get(input)! }),
      deps: { families: () => ON, download: async () => ({ bytes: new Uint8Array(await png(8, 6, 4)), contentType: 'image/png' }) },
    })
    __setInputUploadsEngineRootForTests(k.root)
    const submit = k.replicate.client.submit
    let n = 0
    k.replicate.client.submit = (async (endpoint: string, payload: Record<string, unknown>, ...rest: unknown[]) => {
      if (++n === 2 && o.failSecond) k.replicate.failNext(1)
      bodyOf.set(payload, JSON.stringify({ id: 'p', status: 'succeeded', ...(queue.shift() as object) }))
      return (submit as (...a: unknown[]) => Promise<unknown>)(endpoint, payload, ...rest)
    }) as typeof submit
    __setHuggingFaceLookupForTests(async () => false)
    __setMultiLoraRotationForTests(0)
    const p = withPictures({ ...two, widgets: { ...two.widgets, lora_a: '[None]', lora_a_url: 'https://huggingface.co/alice/two' } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    const charged = [...k.ledger.holds.values()].map(h => [h.credits, h.actual])
    return { k, rec, sent: k.replicate.submitted(), charged }
  }

  it('the marker missing: a second call, the order flipped, both charged; present: one call, one charged (hold two)', async () => {
    const per = creditsForUsd(paidCallUsd({ endpoint: FLUX_MULTI_LORA_SLUG, steps: 28 })!)
    expect(per).toBe(10)
    const skipped = await multiRun([{ output: [OUT], logs: 'no marker' }, { output: [OUT], logs: MARKER_LOGS }])
    expect(skipped.rec.status, skipped.rec.error ?? '').toBe('done')
    expect(skipped.sent.length).toBe(2)
    expect(skipped.sent[1]!.payload.hf_loras).toEqual([...(skipped.sent[0]!.payload.hf_loras as string[])].reverse())
    expect(skipped.sent[1]!.payload.lora_scales).toEqual([...(skipped.sent[0]!.payload.lora_scales as number[])].reverse())
    // The node's record holds its hold: both calls.
    expect(skipped.rec.credits).toBe(2 * per)
    expect(skipped.charged).toEqual([[2 * per + BASE_RENDER_CREDITS, 2 * per + BASE_RENDER_CREDITS]])
    const loaded = await multiRun([{ output: [OUT], logs: MARKER_LOGS }])
    expect(loaded.sent.length).toBe(1)
    expect(loaded.charged).toEqual([[2 * per + BASE_RENDER_CREDITS, per + BASE_RENDER_CREDITS]])
    // The picture is kept as Python's tensor saves it: alpha dropped.
    const out = loaded.rec.outputs[0]!
    expect(out.filename).toMatch(/^flux_multilora/)
    expect((await sharp(readFileSync(join(loaded.k.root, 'output', out.subfolder, out.filename))).metadata()).channels).toBe(3)
  })

  it('a second call that fails at the provider is not charged; the first is', async () => {
    const r = await multiRun([{ output: [OUT], logs: 'no marker' }, { output: [OUT], logs: MARKER_LOGS }], { failSecond: true })
    expect(r.sent.length).toBe(2)
    expect(r.rec.status).toBe('error')
    expect(r.charged).toEqual([[20 + BASE_RENDER_CREDITS, 10 + BASE_RENDER_CREDITS]])
  })

  it('a second answer with no picture fails plainly: both calls were made, both charged', async () => {
    const r = await multiRun([{ output: [OUT], logs: 'no marker' }, { output: null, logs: MARKER_LOGS }])
    expect(r.sent.length).toBe(2)
    expect(r.rec.status).toBe('error')
    expect(r.rec.error).toContain(LORA_NO_PICTURE)
    expect(r.charged).toEqual([[20 + BASE_RENDER_CREDITS, 20 + BASE_RENDER_CREDITS]])
  })
})

describe('every calling case through the engine (cards and lora on)', () => {
  const calling = CASES.filter(c => c.calls.length && !c.error && !guidanceRefused(c))
  it.each(calling.map(c => [c.name, c] as const))('%s — sent, saved and charged', async (_n, c) => {
    const root = loraRoot()
    __setInputUploadsEngineRootForTests(root)
    __setHuggingFaceLookupForTests(hfFrom(c))
    if (c.rotate !== undefined) __setMultiLoraRotationForTests(c.rotate as 0 | 1)
    const run = await runPaidCase(c, { families: ON, root })
    expect(run.status, run.error ?? '').toBe('done')
    const sent = normalizeSent(run.sent, c.pictures ?? [])
    expect(sent).toEqual(c.calls.map(x => ({ provider: x.provider, endpoint: x.endpoint, payload: x.payload })))
    for (const [i, s] of sent.entries()) expect(wireText(s.payload)).toBe(pythonWire(c.calls[i]!.payload_json!))
    expect(run.files.length).toBe(1)
    expect(run.files[0]!.filename).toMatch(isMulti(c) ? /^flux_multilora/ : /^flux_lora/)
    // Held at priceNode's figure: Flux Dev + LoRA its one call; Flux Dev + LoRAs every call it may make
    // (two with two or more LoRAs; the charge is the calls made: the hosted runs above).
    const price = priceNode(c.class_type, withPictures(c).n!.inputs)
    if ('refused' in price) throw new Error(price.refused)
    expect(run.credits).toBe(price.credits)
    if (isMulti(c)) {
      const per = creditsForUsd(paidCallUsd({ endpoint: FLUX_MULTI_LORA_SLUG, steps: c.widgets.num_inference_steps as number })!)
      const most = (c.calls[0]!.payload.hf_loras as string[]).length >= 2 ? 2 : 1
      expect(price.credits).toBeGreaterThanOrEqual(per * most)
    }
    // Alpha dropped (rule 3): the kept picture is RGB.
    const bytes = readFileSync(join(root, 'output', run.files[0]!.subfolder, run.files[0]!.filename))
    expect((await sharp(bytes).metadata()).channels).toBe(3)
  })
})

describe('prices (ruling (a))', () => {
  const single = (w: Record<string, unknown> = {}) => ({ ...caseNamed('single · url huggingface https').widgets, ...w })
  const multi = (w: Record<string, unknown> = {}) => ({ ...caseNamed('multi · two slots · rotate 0 · loaded').widgets, ...w })

  it('the cards: flux-dev-lora keeps its edit card; flux-dev-multi-lora is a GPU-time estimate read from its page', () => {
    expect(EDIT_RATES[FLUX_DEV_LORA_SLUG]).toMatchObject({ unit: 'per_image', usd: 0.04, confidence: 'estimate' })
    expect(PAID_RATES[FLUX_DEV_LORA_SLUG]).toBeUndefined()
    expect(PAID_RATES[FLUX_MULTI_LORA_SLUG]).toMatchObject({
      unit: 'gpu_ceiling', usd: 0.043, perSteps: 28, service: 'replicate', source: 'https://replicate.com/lucataco/flux-dev-multi-lora', read: '2026-09-27', confidence: 'estimate',
    })
    expect(otherCardFor(FLUX_MULTI_LORA_SLUG)).toBeNull()
    expect(paidCallUsd({ endpoint: FLUX_MULTI_LORA_SLUG, steps: 28 })).toBe(0.05)
    expect(paidCallUsd({ endpoint: FLUX_MULTI_LORA_SLUG, steps: 4 })).toBe(0.05)
    expect(paidCallUsd({ endpoint: FLUX_MULTI_LORA_SLUG, steps: 50 })).toBe(0.08)
  })

  it('priced by their calls with no flat row; the price book moved on', () => {
    for (const c of LORA_CLASSES) {
      expect(PAID_NODE_CLASSES).toContain(c)
      expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, c), c).toBe(false)
      expect(PRE_R3_FLAT[c]).toEqual({ credits: LORA_RENDER_CREDITS, badgeUsd: 0.04, family: 'lora' })
    }
    // The category price stays for the direct LoRA routes (requestMeter.ts).
    expect(LORA_RENDER_CREDITS).toBe(8)
    expect(readsEstimateCard('FluxMultiLoRARemoteNode', multi())).toBe(true)
    expect(PRICE_BOOK_VERSION).toBe('r3-lora')
  })

  it('Flux Dev + LoRA 8 whatever the LoRA; Flux Dev + LoRAs 10 a call, held for two with two or more LoRAs, on both paths', async () => {
    const { nodeCreditEstimate } = await import('~/lib/nodeCreditEstimate')
    const want: [LoraClass, Record<string, unknown>, number][] = [
      ['FluxLoRARemoteNode', single(), 8],
      ['FluxLoRARemoteNode', single({ lora_url: '', lora_name: 'trained.safetensors' }), 8],
      ['FluxLoRARemoteNode', single({ num_inference_steps: 50 }), 8],
      ['FluxMultiLoRARemoteNode', multi(), 20],
      ['FluxMultiLoRARemoteNode', multi({ lora_a: '[None]' }), 10],
      ['FluxMultiLoRARemoteNode', multi({ num_inference_steps: 50 }), 32],
      ['FluxMultiLoRARemoteNode', multi({ num_inference_steps: ['x', 0] }), 32],
      // The same link twice (as the node reads it) is one LoRA: no retry.
      ['FluxMultiLoRARemoteNode', multi({ lora_a: '[None]', lora_a_url: 'hf.co/alice/one', lora_b_url: 'https://huggingface.co/alice/one' }), 10],
      ['FluxMultiLoRARemoteNode', multi({ lora_c_url: ['x', 0] }), 20],
    ]
    for (const [ct, inputs, credits] of want) {
      expect((priceNode(ct, inputs) as { credits: number }).credits, `${ct} ${JSON.stringify(inputs)}`).toBe(credits)
      if (Object.values(inputs).some(v => Array.isArray(v))) continue
      expect(priceGraph({ 1: { class_type: ct, inputs } }).nodes!['1'], ct).toBe(credits)
      expect(priceGraph({ 1: { class_type: ct, inputs } }, { families: ON }).nodes!['1'], ct).toBe(credits)
      expect(nodeCreditEstimate(ct, inputs), ct).toBe(credits + BASE_RENDER_CREDITS)
    }
    expect(multiLoraCount(multi())).toBe(2)
    expect(priceNode('FluxLoRARemoteNode', {})).toEqual({ usd: 0.04, credits: 8 })
  })

  it('nothing is free: Python calls unless it raises', () => {
    for (const c of LORA_CLASSES) expect(paidNoCall(c, {}), c).toBe(false)
  })

  it('hosted: Flux Dev + LoRA held at its price and charged the same', async () => {
    const c = caseNamed('single · url huggingface https')
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: [OUT] }) })
    const root = loraRoot()
    __setInputUploadsEngineRootForTests(root)
    __setHuggingFaceLookupForTests(async () => false)
    const k = makeKit({ hosted: true, root, replicate, deps: { families: () => ON, download: async () => ({ bytes: new Uint8Array(await png(8, 6)), contentType: 'image/png' }) } })
    const p = withPictures(c)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(rec.credits).toBe(8)
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[8 + BASE_RENDER_CREDITS, 8 + BASE_RENDER_CREDITS]])
    expect(stageEstimate(p, Object.keys(p), false, ON)).toBe(8)
  })
})

describe('the HuggingFace look-up (ruling (h))', () => {
  it('goes through the safe fetcher, 8 seconds, to huggingface.co\'s model API', async () => {
    const sf = vi.mocked(safeFetchModule.safeFetch)
    sf.mockResolvedValueOnce({ status: 200, contentType: 'application/json', data: new ArrayBuffer(2) })
    expect(await autodetectHuggingface('alice/lora/file.bin', { hosted: true })).toBe('huggingface.co/alice/lora/file.bin')
    expect(sf).toHaveBeenLastCalledWith('https://huggingface.co/api/models/alice/lora', expect.objectContaining({ timeoutMs: 8000, hosted: true, loopbackView: false }))
    sf.mockResolvedValueOnce({ status: 404, contentType: 'application/json', data: new ArrayBuffer(2) })
    expect(await autodetectHuggingface(' bob/missing ', { hosted: false })).toBe('bob/missing')
    sf.mockRejectedValueOnce(new safeFetchModule.FetchRefused('refused'))
    expect(await autodetectHuggingface('carol/x', { hosted: false })).toBe('carol/x')
    // Full addresses and explicit hosts are never looked up.
    sf.mockClear()
    for (const r of ['https://x.y/a/b', 'huggingface.co/a/b', 'civitai.com/a/b', 'replicate.com/a/b', 'plain']) await autodetectHuggingface(r, { hosted: false })
    expect(sf).not.toHaveBeenCalled()
  })
})

describe('refusals before the hold, in plain words', () => {
  async function refusedAtStart(p: ApiPrompt, want: string, hosted = true) {
    const root = loraRoot()
    __setInputUploadsEngineRootForTests(root)
    const k = makeKit({ hosted, root, deps: { families: () => ON } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(want)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  }
  const single = (w: Record<string, unknown>) => withPictures({ ...caseNamed('single · name [None]'), widgets: { ...caseNamed('single · name [None]').widgets, ...w } })
  const multi = (w: Record<string, unknown>) => withPictures({ ...caseNamed('multi · no slots'), widgets: { ...caseNamed('multi · no slots').widgets, ...w } })

  it('hosted (ruling (i)): a LoRA picked by name, a trained model\'s address, a link that isn\'t public, a wired one — on both paths', async () => {
    const cases: [ApiPrompt, string][] = [
      [single({ lora_name: 'trained.safetensors' }), LORA_BY_NAME_HOSTED],
      [single({ lora_url: 'finnyjules/my-style' }), LORA_TRAINED_MODEL_HOSTED],
      [single({ lora_url: 'finnyjules/my-style:abc' }), LORA_TRAINED_MODEL_HOSTED],
      [single({ lora_url: 'https://replicate.delivery/x/trained.tar' }), LORA_LINK_NOT_PUBLIC],
      [multi({ lora_b: 'legacy.safetensors' }), LORA_BY_NAME_HOSTED],
      [multi({ lora_a_url: 'https://huggingface.co/a/b', lora_c_url: 'https://replicate.com/finnyjules/my-style' }), LORA_LINK_NOT_PUBLIC],
      [{ ...multi({}), t: { class_type: 'Text', inputs: { text: 'hf.co/a/b' } }, n: { ...multi({}).n!, inputs: { ...multi({}).n!.inputs, lora_a_url: ['t', 0] } } }, LORA_WIRED_HOSTED],
    ]
    for (const [p, want] of cases) {
      expect(hostedRequestProblems(p).map(x => x.message), JSON.stringify(p.n!.inputs)).toEqual([want])
      if (!Object.values(p.n!.inputs).some(v => Array.isArray(v))) await refusedAtStart(p, want)
    }
    // Local: unchanged (each is taken).
    expect(requestProblems(single({ lora_name: 'trained.safetensors' }), { runner: true })).toEqual([])
  })

  it('hosted allows public links: HuggingFace, hf.co, CivitAI, .safetensors; bare names on Flux Dev + LoRAs', () => {
    for (const url of ['https://huggingface.co/a/b', 'huggingface.co/a/b/w.safetensors', 'hf.co/a/b', 'https://civitai.com/api/download/models/1', 'https://x.test/w.safetensors?download=1']) {
      expect(hostedLoraProblem('FluxLoRARemoteNode', { lora_name: 'trained.safetensors', lora_url: url }), url).toBeNull()
      expect(hostedLoraProblem('FluxMultiLoRARemoteNode', { lora_a_url: url, lora_b: '[None]', lora_c: '[None]', lora_d: '[None]', lora_a: '[None]' }), url).toBeNull()
    }
    expect(hostedLoraProblem('FluxMultiLoRARemoteNode', { lora_a_url: 'alice/hf-lora', lora_a: '[None]' })).toBeNull()
    expect(hostedLoraProblem('FluxLoRARemoteNode', { lora_url: 'alice/hf-lora/x/y', lora_name: '[None]' })?.message).toBe(LORA_LINK_NOT_PUBLIC)
  })

  it('no LoRA in any slot (Python raises before its call), locally and hosted', async () => {
    await refusedAtStart(multi({}), MULTI_LORA_NEEDS_LORA, false)
    await refusedAtStart(multi({}), MULTI_LORA_NEEDS_LORA, true)
  })

  it('a guidance flux-dev-lora refuses, when the sidecar shows it runs flux-dev-lora (a trained model takes it)', async () => {
    await refusedAtStart(single({ lora_name: 'legacy.safetensors', guidance: 12 }), FLUX_LORA_GUIDANCE_TOO_HIGH, false)
    await refusedAtStart(single({ lora_url: 'hf.co/a/b', guidance: 10.5 }), FLUX_LORA_GUIDANCE_TOO_HIGH, false)
    expect(await loraStartProblem(single({ lora_name: 'trained.safetensors', guidance: 12 }))).toBeNull()
    expect(await loraStartProblem(single({ lora_name: 'legacy.safetensors', guidance: 10 }))).toBeNull()
    expect(requestProblems(single({ lora_url: 'finnyjules/my-style', guidance: 20 }), { runner: true })).toEqual([])
  })

  it('a LoRA name ComfyUI doesn\'t list, and a sidecar over its cap', async () => {
    await refusedAtStart(single({ lora_name: 'gone.safetensors' }), LORA_NOT_LISTED, false)
    await refusedAtStart(multi({ lora_a_url: 'hf.co/a/b', lora_d: '../../escape.safetensors' }), LORA_NOT_LISTED, false)
    const root = loraRoot()
    writeFileSync(join(root, 'models', 'loras', 'huge.safetensors'), '')
    writeFileSync(join(root, 'models', 'loras', 'huge.json'), `{"replicate_url": "${'x'.repeat(LORA_SIDECAR_MAX_BYTES)}"}`)
    __setInputUploadsEngineRootForTests(root)
    expect((await loraStartProblem(single({ lora_name: 'huge.safetensors' })))?.message).toBe(LORA_SIDECAR_TOO_LARGE)
    // A name that isn't read (a link wins) must still be one ComfyUI lists, but its sidecar isn't measured.
    expect(await loraStartProblem(single({ lora_name: 'huge.safetensors', lora_url: 'hf.co/a/b' }))).toBeNull()
    await expect(readLoraSidecar('huge.safetensors')).rejects.toThrow(LORA_SIDECAR_TOO_LARGE)
  })

  it('the refusals are plain words', () => {
    for (const w of [FLUX_LORA_GUIDANCE_TOO_HIGH, LORA_BY_NAME_HOSTED, LORA_TRAINED_MODEL_HOSTED, LORA_LINK_NOT_PUBLIC, LORA_WIRED_HOSTED, MULTI_LORA_NEEDS_LORA, LORA_NOT_LISTED, LORA_SIDECAR_TOO_LARGE, LORA_SIDECAR_UNREADABLE, LORA_NO_PICTURE]) {
      expect(w).not.toMatch(/Node|_|\bid\b|sidecar|json/i)
    }
  })
})

describe('wired text and moderation', () => {
  it('lists the prompt and the LoRA links; prompt_in and style_in are moderated when wired', () => {
    expect(PAID_TEXT_INPUTS.FluxLoRARemoteNode).toEqual(['prompt', 'lora_url'])
    expect(PAID_TEXT_INPUTS.FluxMultiLoRARemoteNode).toEqual(['prompt', 'prompt_in', 'style_in', 'lora_a_url', 'lora_b_url', 'lora_c_url', 'lora_d_url'])
    expect(extraPromptTexts({ n: { class_type: 'FluxLoRARemoteNode', inputs: { prompt: 'a cat', lora_url: 'hf.co/a/b' } } })).toEqual(['a cat', 'hf.co/a/b'])
  })

  for (const cls of LORA_CLASSES) {
    it(`${cls}: a hosted flagged prompt is refused at the start, before the hold`, async () => {
      const c = caseNamed(cls === 'FluxLoRARemoteNode' ? 'single · url huggingface https' : 'multi · two slots · rotate 0 · loaded')
      const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
      const root = loraRoot()
      __setInputUploadsEngineRootForTests(root)
      const k = makeKit({ hosted: true, root, moderate, deps: { families: () => ON } })
      const widgets = cls === 'FluxLoRARemoteNode' ? { ...c.widgets, prompt: 'a forbidden thing' } : { ...c.widgets, lora_a: '[None]', lora_a_url: 'hf.co/a/b', prompt: 'a forbidden thing' }
      await expect(k.engine.startRun({ userId: k.userId, takes: [withPictures({ ...c, widgets })], ...START })).rejects.toThrow()
      expect(moderate.mock.calls.map(x => x[0])).toContain('a forbidden thing')
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
    })
  }

  it('Text cards wired into prompt_in and style_in: folded as Python folds them', async () => {
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: [OUT], logs: MARKER_LOGS }) })
    const root = loraRoot()
    __setInputUploadsEngineRootForTests(root)
    __setHuggingFaceLookupForTests(async () => false)
    __setMultiLoraRotationForTests(0)
    const k = makeKit({ root, replicate, deps: { families: () => ON, download: async () => ({ bytes: new Uint8Array(await png(8, 6)), contentType: 'image/png' }) } })
    const c = caseNamed('multi · prompt_in set · style_in set · prompt')
    const p: ApiPrompt = {
      ...withPictures(c),
      i: { class_type: 'Text', inputs: { text: c.widgets.prompt_in as string } },
      s: { class_type: 'Text', inputs: { text: c.widgets.style_in as string } },
    }
    p.n!.inputs.prompt_in = ['i', 0]
    p.n!.inputs.style_in = ['s', 0]
    expect(isRunnerEligible(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect(replicate.submitted()[0]!.payload.prompt).toBe(c.calls[0]!.payload.prompt)
  })
})

describe('with lora off (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but lora', RUNNER_FAMILIES.filter(f => f !== 'lora')],
  ]
  const isLora = (ct: string) => (LORA_CLASSES as readonly string[]).includes(ct)
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, isLora(n.class_type) ? { ...n, class_type: `${n.class_type}Before` } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (!isLora(p[id]!.class_type)) {
          expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
        }
      }
    }
  }
  const sample = (c: LoraClass) => withPictures(caseNamed(c === 'FluxLoRARemoteNode' ? 'single · url huggingface https' : 'multi · two slots · rotate 0 · loaded'))

  it('each class is left to the engine, and named by the needs-the-engine list', () => {
    for (const c of LORA_CLASSES) {
      const p = sample(c)
      expect(runnerTakesNode(p, 'n', new Set(['cards'])), c).toBe(false)
      expect(runnerTakesNode(p, 'n', ON), c).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n'])
      expect(RUNNER_OUTPUT_CLASSES.has(c), c).toBe(false)
      expect(IMAGE_OUTPUT_CLASSES.has(c)).toBe(false)
      expect(PAID_PICTURE_FAMILY[c]).toBe('lora')
      expect(RUNNER_NODE_RULES[c]!.family).toBe('lora')
      expect(RUNNER_ROUTES[c]!.first).toBe('replicate')
      expect(RUNNER_ROUTES[c]!.backup).toBeNull()
    }
    // Image-to-image is taken too.
    expect(runnerTakesNode(withPictures(caseNamed('single · trained · image')), 'n', ON)).toBe(true)
    expect(runnerTakesNode(withPictures(caseNamed('multi · image')), 'n', ON)).toBe(true)
  })

  it('a wired widget (a LoRA picker, the steps) or a value out of range leaves the node to the engine', () => {
    const p = sample('FluxLoRARemoteNode')
    expect(runnerTakesNode({ ...p, t: { class_type: 'Text', inputs: { text: 'x' } }, n: { ...p.n!, inputs: { ...p.n!.inputs, lora_name: ['t', 0] } } }, 'n', ON)).toBe(false)
    expect(runnerTakesNode({ ...p, n: { ...p.n!, inputs: { ...p.n!.inputs, num_inference_steps: 51 } } }, 'n', ON)).toBe(false)
    const m = sample('FluxMultiLoRARemoteNode')
    expect(runnerTakesNode({ ...m, n: { ...m.n!, inputs: { ...m.n!.inputs, guidance: 10.5 } } }, 'n', ON)).toBe(false)
  })

  it('over synthetic chains: into a Frame, into another of them, a Text card into the prompt', () => {
    for (const c of LORA_CLASSES) {
      const p = sample(c)
      sameAsBefore(p, `${c} alone`)
      sameAsBefore({ ...p, f: { class_type: 'Compositor', inputs: { layer1: ['n', 0], width: 0, height: 0 } } }, `${c} → Frame`)
      sameAsBefore({ ...p, r: { class_type: 'FluxLoRARemoteNode', inputs: { ...caseNamed('single · url hf.co').widgets, image: ['n', 0] } } }, `${c} → Flux Dev + LoRA`)
      sameAsBefore({ ...p, i: { class_type: 'Image', inputs: { image: '', images: ['n', 0] } } }, `${c} → Image card`)
      sameAsBefore({ ...p, t: { class_type: 'Text', inputs: { text: 'hi' } }, n: { ...p.n!, inputs: { ...p.n!.inputs, prompt: ['t', 0] } } }, `Text → ${c}`)
    }
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (with Flux Dev + LoRAs spliced in beside each)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    let loras = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        graphs++
        loras += Object.values(p).filter(n => isLora(n.class_type)).length
        sameAsBefore(p, uuid)
        sameAsBefore({
          ...p,
          d_m: { class_type: 'FluxMultiLoRARemoteNode', inputs: { ...caseNamed('multi · two slots · rotate 0 · loaded').widgets } },
          ...readerFor('FluxMultiLoRARemoteNode', 'd_m'),
        }, `${uuid} + Flux Dev + LoRAs`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`lora families-off invariant: ${graphs} saved graphs, ${loras} LoRA nodes`)
  }, 600_000)
})
