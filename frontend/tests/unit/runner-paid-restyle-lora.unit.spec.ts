/**
 * R3.14: Restyle an Image · Style LoRA (family `lora`) — Moondream's caption,
 * the LoRA's Flux Dev restyle, Moondream's photo-or-illustration verdicts and
 * up to three Nano Banana 2 passes on fal — against what its real Python sends
 * and returns (fixtures/runner-paid-restyle-lora.json, scripts/
 * runner_paid_fixtures.py --group restyle-lora, run with a temporary
 * models/loras/), priced call by call on both paths and charged for the calls
 * that finished.
 *
 * The runner hands on its own kept copy of the LoRA's picture and of each
 * pass where Python hands on the provider's link (the hand-off rule): the
 * spec maps each copy's link back to the link Python sent.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createFakeFal, createFakeReplicate, makeKit } from './__runner__/kit'
import { readerFor, type PaidCase } from './__runner__/paidParity'
import { checkPayload, loadProviderSchema, type ProviderSchemaFixture } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { PAID_PICTURE_FAMILY, RUNNER_NODE_RULES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import {
  FLUX_DEV_LORA_SLUG, LORA_LINK_NOT_PUBLIC, LORA_NOT_LISTED, LORA_TRAINED_MODEL_HOSTED, LORA_WIRED_HOSTED, RESTYLE_GUIDANCE_TOO_HIGH,
  RESTYLE_LORA_BY_NAME_HOSTED, RESTYLE_LORA_CLASS, hostedLoraProblem, loraNamesUsed,
} from '#shared/runner/lora'
import { parsePyJson, pyJsonDumps, type PyJson } from '#shared/runner/pyJson'
import { MOONDREAM_SLUG } from '#shared/runner/describe'
import { paidCallUsd } from '#shared/pricing/paidRates'
import { EDIT_RATES } from '#shared/pricing/editRates'
import { RESTYLE_LORA_NB_RETRIES, editSteps } from '#shared/pricing/editSettings'
import { PAID_NODE_CLASSES, paidCalls, paidNoCall, restyleLoraCalls } from '#shared/pricing/paidSettings'
import { PRE_R3_FLAT, readsEstimateCard } from '#shared/pricing/estimateFloor'
import { priceNode } from '#shared/pricing/nodePrice'
import { callCredits } from '#shared/pricing/pipelinePrice'
import { BASE_RENDER_CREDITS, GRAPH_NODE_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { __setInputUploadsEngineRootForTests } from '~~/server/utils/inputUploads'
import { PAID_TEXT_INPUTS, extraPromptTexts, stageEstimate } from '~~/server/runner/metering'
import { planNode, type NodePlan, type PipelineCall, type PipelineIO } from '~~/server/runner/executors'
import { LORA_NO_PICTURE, __setHuggingFaceLookupForTests } from '~~/server/runner/generators/lora'
import {
  RESTYLE_ANTIPHOTO_RETRY, RESTYLE_CAPTION_STAND_IN, RESTYLE_CLASSIFY_PROMPT, RESTYLE_DESCRIBE_PROMPT, RESTYLE_NB_NO_PICTURE, RESTYLE_NB_PASSES,
  aestheticToKeywords, buildFluxStylePrompt, classifyStyleAnswer, firstFalImageUrl, passSeed, restyleStyleStrengthToKnobs, sidecarAesthetic, verdictText,
} from '~~/server/runner/generators/restyleLora'
import { buildRestyleInstruction } from '~~/server/runner/generators/restyle'
import { NANO_BANANA_2_FAL_EDIT, RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { LORA_SIDECAR_MAX_BYTES, LORA_SIDECAR_TOO_LARGE, LORA_SIDECAR_UNREADABLE, loraStartProblem } from '~~/server/runner/loraFiles'
import { hostedRequestProblems, requestProblems } from '~~/server/runner/requestRules'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'

interface Catalogue {
  knobs: { style: number; override: number; out: [number, number] }[]
  aesthetic: { sidecar: Record<string, unknown> | null; out: string }[]
  keywords: { aesthetic: string; out: string }[]
  prompt: { trigger: string; aesthetic: string; caption: string; out: string }[]
  classify: Record<string, string>
  instruction: { structure: number; extra: string; out: string }[]
  retry: string
  describe_prompt: string
  max_retries: number
}
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-restyle-lora.json'), 'utf8')) as { cases: PaidCase[]; loras: Record<string, string | null>; catalogue: Catalogue }
const CASES = FIXTURE.cases
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'lora'])

const caseNamed = (name: string): PaidCase => {
  const c = CASES.find(x => x.name === name)
  if (!c) throw new Error(`no fixture case ${name}`)
  return c
}
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

// ── A models/loras/ with the fixture's files, and the engine root pointing at it ──

function loraRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'runner-restyle-lora-root-'))
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
beforeEach(() => __setInputUploadsEngineRootForTests(ROOT))
afterEach(() => __setHuggingFaceLookupForTests(null))

/** The HuggingFace look-up, served as the case served it (no network). */
function hfFrom(c: PaidCase) {
  return async (repo: string) => {
    const l = c.links?.[`https://huggingface.co/api/models/${repo}`]
    if (l === undefined) throw new Error(`${c.name}: look-up ${repo} is not served by the case`)
    if (typeof l === 'object' && 'raise' in l) throw new Error(l.raise)
    return (typeof l === 'string' ? 200 : l.status) === 200
  }
}

/** The node, a LoadImage feeding its picture, and nothing else (it is an output node itself). */
function promptOf(c: PaidCase, widgets: Record<string, unknown> = {}): ApiPrompt {
  return {
    n: { class_type: c.class_type, inputs: { ...c.widgets, ...widgets, content_image: ['p_content_image', 0] } },
    p_content_image: { class_type: 'LoadImage', inputs: { image: 'content_image.png', upload: 'image' } },
  }
}

// ── What Python sent, and what the runner sends in its place ──

/** Python's answer URLs of the LoRA's picture and of each pass, by the name the runner hands its copy on under. */
function pythonLinks(c: PaidCase): Map<string, string> {
  const m = new Map<string, string>([['https://fal.storage/content_image.png', 'IMG:content_image']])
  const flux = (c.answers[1] as { output?: string[] } | undefined)?.output?.[0]
  if (flux) m.set('https://fal.storage/restyle_style.png', flux)
  let pass = 0
  for (const a of c.answers) {
    const url = (a as { images?: { url: string }[] }).images?.[0]?.url
    if (url) m.set(`https://fal.storage/restyle_pass_${++pass}.png`, url)
  }
  return m
}
function asPython(c: PaidCase, payload: Record<string, unknown>): Record<string, unknown> {
  const m = pythonLinks(c)
  const walk = (v: unknown): unknown => (typeof v === 'string' ? (m.get(v) ?? v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v)
  return walk(payload) as Record<string, unknown>
}

/** A payload's wire text, keys sorted (numbers keep their written form). */
function wireText(payload: unknown): string {
  const sorted = (v: PyJson): PyJson => {
    if (Array.isArray(v)) return v.map(sorted)
    if (v && typeof v === 'object' && 'obj' in v) return { obj: [...v.obj].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sorted(x)] as [string, PyJson]) }
    return v
  }
  return pyJsonDumps(sorted(parsePyJson(JSON.stringify(payload))))
}
/** Python's wire text with its one known difference (R3.3 ruling 1, FLOAT widgets only): a whole float `1.0` is the runner's `1`. */
const FLOAT_KEYS = new Set(['guidance', 'guidance_scale', 'lora_scale', 'prompt_strength'])
function pythonWire(payloadJson: string): string {
  const whole = (v: PyJson): PyJson => (v && typeof v === 'object' && 'float' in v && Number.isInteger(v.float) ? { int: String(v.float) } : v)
  const walk = (v: PyJson): PyJson => (v && typeof v === 'object' && 'obj' in v ? { obj: v.obj.map(([k, x]) => [k, FLOAT_KEYS.has(k) ? whole(x) : x] as [string, PyJson]) } : v)
  return pyJsonDumps(walk(parsePyJson(payloadJson)))
}

/** Python fails after its caption (paid) where the runner fails at planning, before any call. */
const failsBeforeCalls = (c: PaidCase) => !!c.error
/** A guidance flux-dev-lora's schema refuses: the runner refuses it before the hold; Python sends it. */
const guidanceRefused = (c: PaidCase) => c.calls[1]?.endpoint === FLUX_DEV_LORA_SLUG && (c.calls[1]!.payload.guidance as number) > 10

// ── The published inputs, read 2026-09-27 (R3.13) and 2026-09-28, where no schema is saved ──

const published = (properties: Record<string, unknown>, required: string[]): ProviderSchemaFixture => ({
  endpoint: '', fetchedAt: '2026-09-28', input: { type: 'object', required, properties }, output: {}, components: { schemas: {} },
})
const RATIOS = ['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3', '9:16', '9:21']
const SCHEMAS: Record<string, ProviderSchemaFixture> = {
  [FLUX_DEV_LORA_SLUG]: published({
    seed: { type: 'integer' }, image: { type: 'string', format: 'uri' }, prompt: { type: 'string' }, go_fast: { type: 'boolean' },
    guidance: { type: 'number', maximum: 10, minimum: 0 }, extra_lora: { type: 'string' }, lora_scale: { type: 'number', maximum: 3, minimum: -1 },
    megapixels: { enum: ['1', '0.25'], type: 'string' }, num_outputs: { type: 'integer', maximum: 4, minimum: 1 }, aspect_ratio: { enum: RATIOS, type: 'string' },
    lora_weights: { type: 'string' }, output_format: { enum: ['webp', 'jpg', 'png'], type: 'string' }, output_quality: { type: 'integer', maximum: 100, minimum: 0 },
    prompt_strength: { type: 'number', maximum: 1, minimum: 0 }, num_inference_steps: { type: 'integer', maximum: 50, minimum: 1 }, disable_safety_checker: { type: 'boolean' },
  }, ['prompt']),
  // lucataco/moondream2's page (read 2026-09-28): an image and a prompt.
  [MOONDREAM_SLUG]: published({ image: { type: 'string', format: 'uri' }, prompt: { type: 'string' } }, ['image']),
  [NANO_BANANA_2_FAL_EDIT]: loadProviderSchema('fal', NANO_BANANA_2_FAL_EDIT),
}
const offSchema: string[] = []

// ── A pipeline run with a fake io: the case's answers in call order ──

interface Sent { key: string; provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown>; usd: number }
async function planOf(c: PaidCase, o: { hosted?: boolean; widgets?: Record<string, unknown> } = {}): Promise<NodePlan> {
  return planNode({
    prompt: promptOf(c, o.widgets), nodeId: 'n', gateOpen: false, hosted: !!o.hosted,
    filesFrom: link => (link[0] === 'p_content_image' ? [{ filename: 'content_image.png', subfolder: '', type: 'input' }] : []),
    toUrl: async f => `https://fal.storage/${f.filename}`,
  })
}
async function runPipeline(plan: Extract<NodePlan, { kind: 'pipeline' }>, c: PaidCase, answers: unknown[] = c.answers) {
  const queue = [...answers]
  const sent: Sent[] = []
  const saved: { prefix: string; bytes: Uint8Array }[] = []
  const moderated: string[] = []
  const kept = new Map<string, Uint8Array>()
  const io = {
    call: async (x: PipelineCall) => {
      sent.push({ key: x.key, provider: x.provider as 'fal' | 'replicate', endpoint: x.endpoint, payload: x.payload, usd: x.usd })
      if (!queue.length) throw new Error(`${c.name}: more calls than Python`)
      const a = queue.shift() as Record<string, unknown>
      if (a && '__raise__' in a) throw new Error(String(a.__raise__))
      const result = x.provider === 'replicate' ? { id: 'p', status: 'succeeded', ...a } : a
      return { result, raw: JSON.stringify(result), urls: [] }
    },
    download: async (url: string) => ({ bytes: b64(c.files![url]!), contentType: 'image/png' }),
    savedOnce: async (_k: string, _s: string, make: () => Promise<unknown>) => make(),
    keep: async (bytes: Uint8Array) => {
      kept.set(sha(bytes), bytes)
      return { filename: `${sha(bytes)}.bin`, subfolder: 'run', type: 'kept' }
    },
    read: async (f: { filename: string }) => kept.get(f.filename.replace(/\.bin$/, ''))!,
    handOff: async (_b: Uint8Array, name: string) => `https://fal.storage/${name}`,
    saveAsset: async (bytes: Uint8Array, o: { prefix: string }) => {
      saved.push({ prefix: o.prefix, bytes })
      return { filename: `${o.prefix}_00001_.png`, subfolder: '', type: 'output' }
    },
    moderateText: async (t: string) => { moderated.push(t) },
    signal: new AbortController().signal,
  } as unknown as PipelineIO
  let error: string | null = null
  let made: Awaited<ReturnType<typeof plan.run>> | null = null
  try { made = await plan.run(io) }
  catch (e) { error = e instanceof Error ? e.message : String(e) }
  return { sent, saved, made, error, moderated }
}

/** The 8-bit RGB pixels of a PNG, hashed as capture_calls hashes Python's tensor. */
async function pixelSha(png: Uint8Array): Promise<{ sha: string; shape: number[] }> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  return { sha: sha(new Uint8Array(data)), shape: [1, info.height, info.width, info.channels] }
}
const pythonPicture = (c: PaidCase) => ((c.output as { tensor: { sha256: string; shape: number[] } }[])[0]!.tensor)

/** The keys of Python's calls, in order: describe, stylize, classify-ref, then nb-k and classify-k. */
function keysOf(c: PaidCase): string[] {
  const keys = ['describe', 'stylize', 'classify-ref']
  let pass = 0
  for (const x of c.calls.slice(3)) keys.push(x.provider === 'fal' ? `nb-${++pass}` : `classify-${pass}`)
  return keys.slice(0, c.calls.length)
}

describe('the fixture', () => {
  it('covers every branch the brief names', () => {
    const names = new Set(CASES.map(c => c.name))
    for (const s of ['0.0', '0.5', '1.0']) for (const f of ['0.0', '0.7']) expect(names.has(`strength ${s} · flux strength ${f}`)).toBe(true)
    for (const n of ['lora · trained by name', 'lora · trained ref link', 'lora · collage by name', 'lora · bare ref found', 'target · photo', 'target · illustration · first',
      'target · illustration · third', 'target · illustration · never', 'classifier fails · reference', 'classifier fails · first pass', 'caption · empty', 'seed 0', 'seed 4294967295']) {
      expect(names.has(n), n).toBe(true)
    }
    for (const r of ['1K', '2K', '4K']) for (const f of ['png', 'jpg']) expect(names.has(`resolution ${r} · format ${f}`)).toBe(true)
    // Every endpoint: Moondream, flux-dev-lora, two trained models, fal Nano Banana 2.
    expect(new Set(CASES.flatMap(c => c.calls.map(x => `${x.provider} ${x.endpoint}`))))
      .toEqual(new Set([`replicate ${MOONDREAM_SLUG}`, `replicate ${FLUX_DEV_LORA_SLUG}`, 'replicate finnyjules/my-style', `fal ${NANO_BANANA_2_FAL_EDIT}`]))
    // Python never falls back past fal's Nano Banana 2 in these cases.
    expect(CASES.flatMap(c => c.calls).filter(x => x.provider === 'fal').every(x => x.endpoint === NANO_BANANA_2_FAL_EDIT)).toBe(true)
    // The longest run: nine calls (three passes, each judged).
    expect(caseNamed('target · illustration · never').calls.length).toBe(9)
    expect(CASES.length).toBeGreaterThanOrEqual(55)
  })
})

describe('replicate_refs.py and nodes_replicate.py, ported line for line', () => {
  const cat = FIXTURE.catalogue
  it('restyle_style_strength_to_knobs', () => {
    for (const x of cat.knobs) expect(restyleStyleStrengthToKnobs(x.style, x.override), JSON.stringify(x)).toEqual(x.out)
  })
  it('sidecar_aesthetic, aesthetic_to_keywords and build_flux_style_prompt', () => {
    for (const x of cat.aesthetic) {
      const meta = x.sidecar === null ? null : new Map(Object.entries(x.sidecar).map(([k, v]) => [k, parsePyJson(JSON.stringify(v))]))
      expect(sidecarAesthetic(meta), JSON.stringify(x.sidecar)).toBe(x.out)
    }
    for (const x of cat.keywords) expect(aestheticToKeywords(x.aesthetic), JSON.stringify(x.aesthetic)).toBe(x.out)
    for (const x of cat.prompt) expect(buildFluxStylePrompt(x.trigger, x.aesthetic, x.caption), JSON.stringify(x)).toBe(x.out)
  })
  it('classify_style_answer, build_restyle_instruction and the constants', () => {
    for (const [a, want] of Object.entries(cat.classify)) expect(classifyStyleAnswer(a), JSON.stringify(a)).toBe(want)
    for (const x of cat.instruction) expect(buildRestyleInstruction(x.structure, x.extra), JSON.stringify(x)).toBe(x.out)
    expect(RESTYLE_ANTIPHOTO_RETRY).toBe(cat.retry)
    expect(RESTYLE_DESCRIBE_PROMPT).toBe(cat.describe_prompt)
    expect(RESTYLE_NB_PASSES).toBe(1 + cat.max_retries)
    expect(RESTYLE_LORA_NB_RETRIES).toBe(cat.max_retries)
  })
  it('the verdict\'s answer as Python reads it, and fal\'s first picture', () => {
    expect(verdictText(['illus', 'tration'])).toBe('illustration')
    expect(verdictText(null)).toBe('')
    expect(verdictText({ int: '3' })).toBe('3')
    expect(verdictText({ obj: [['medium', 'illustration'], ['sure', true]] })).toBe('{\'medium\': \'illustration\', \'sure\': True}')
    expect(verdictText([{ obj: [['m', 'photo']] }, ' x'])).toBe('{\'m\': \'photo\'} x')
    expect(firstFalImageUrl({ images: [{ url: 'https://f/x.png' }] })).toBe('https://f/x.png')
    for (const r of [null, {}, { images: [] }, { images: ['https://f/x.png'] }, { images: [{ url: '' }] }, { images: [{ url: 5 }] }]) expect(firstFalImageUrl(r)).toBeNull()
    expect([passSeed(0, 0), passSeed(0, 1), passSeed(0xFFFFFFFF, 0), passSeed(0xFFFFFFFF, 1), passSeed(0xFFFFFFFE, 2)]).toEqual([0, 1, 0xFFFFFFFF, 0, 0])
  })
})

describe('every fixture case: what Python sends and returns', () => {
  it.each(CASES.map(c => [c.name, c] as const))('%s', async (_n, c) => {
    __setHuggingFaceLookupForTests(hfFrom(c))
    expect(paidNoCall(c.class_type, c.widgets)).toBe(false)
    if (failsBeforeCalls(c)) {
      // Python fails after its caption (paid) on a sidecar it can't read; the runner before its first call.
      expect(c.calls.map(x => x.endpoint)).toEqual([MOONDREAM_SLUG])
      await expect(planOf(c)).rejects.toThrow(LORA_SIDECAR_UNREADABLE)
      return
    }
    if (guidanceRefused(c)) {
      expect(requestProblems(promptOf(c), { runner: true }).map(p => p.message)).toEqual([RESTYLE_GUIDANCE_TOO_HIGH])
      expect(requestProblems(promptOf(c))).toEqual([])
      await expect(planOf(c)).rejects.toThrow(RESTYLE_GUIDANCE_TOO_HIGH)
      offSchema.push(`${c.name}: ${checkPayload(SCHEMAS[FLUX_DEV_LORA_SLUG]!, c.calls[1]!.payload).join('; ')}`)
      return
    }
    expect(requestProblems(promptOf(c), { runner: true })).toEqual([])
    const plan = await planOf(c)
    if (plan.kind !== 'pipeline') throw new Error('not a pipeline')
    expect(plan.prefix).toBe('restyle_lora')
    const run = await runPipeline(plan, c)
    expect(run.error).toBeNull()
    expect(run.sent.map(s => ({ provider: s.provider, endpoint: s.endpoint, payload: asPython(c, s.payload) })))
      .toEqual(c.calls.map(x => ({ provider: x.provider, endpoint: x.endpoint, payload: x.payload })))
    for (const [i, s] of run.sent.entries()) expect(wireText(asPython(c, s.payload)), `call ${i + 1}`).toBe(pythonWire(c.calls[i]!.payload_json!))
    expect(run.sent.map(s => s.key)).toEqual(keysOf(c))
    for (const s of run.sent) {
      const schema = SCHEMAS[s.endpoint]
      if (schema) for (const e of checkPayload(schema, s.payload)) offSchema.push(`${c.name} ${s.key}: ${e}`)
    }
    // Each call priced by the node's priced calls (the hold's calculation), at the route that serves it (fix round 1:
    // a pass is fal's Nano Banana 2 alone, its fallbacks only in the hold).
    const calls = restyleLoraCalls(c.widgets)
    for (const s of run.sent) {
      const want = s.provider === 'fal' ? { ...calls.nanoBanana.call, fallbacks: [] } : s.key === 'stylize' ? calls.stylize.call : calls.moondream.call
      expect(s.usd, s.key).toBe(paidCallUsd(want))
    }
    // The caption is moderated before it is sent on (hosted; locally the engine's moderateText does nothing).
    expect(run.moderated).toEqual([c.calls[1]!.payload.prompt])
    // The result: one picture as Python's tensor saves it (alpha dropped), shown under restyle_lora.
    expect(run.saved.map(s => s.prefix)).toEqual(['restyle_lora'])
    const got = await pixelSha(run.saved[0]!.bytes)
    expect(got).toEqual({ sha: pythonPicture(c).sha256, shape: pythonPicture(c).shape })
    expect(run.made!.ui).toEqual({ images: [{ filename: 'restyle_lora_00001_.png', subfolder: '', type: 'output' }], animated: [false] })
    expect((c.ui as { images: { prefix: string }[] }).images[0]!.prefix).toBe('restyle_lora')
  })

  it('every payload fits its published schema but the guidance the runner refuses', () => {
    expect(offSchema.sort()).toEqual(['flux guidance 20: guidance: 20 is above the maximum 10'])
    // The trained model's guidance_scale isn't flux-dev-lora's: sent as Python sends it.
    expect(caseNamed('lora · trained by name · guidance 20').calls[1]!.payload.guidance_scale).toBe(20)
  })

  it('the Nano Banana seed: (seed + pass) & 0xFFFFFFFF, sent only above 0', () => {
    const seeds = (n: string) => caseNamed(n).calls.filter(x => x.provider === 'fal').map(x => x.payload.seed ?? null)
    expect(seeds('seed 0')).toEqual([null, 1, 2])
    expect(seeds('seed 42')).toEqual([42, 43, 44])
    expect(seeds('seed 4294967294')).toEqual([4294967294, 4294967295, null])
    expect(seeds('seed 4294967295')).toEqual([4294967295, null, 1])
    // Flux always gets the seed, 0 included.
    expect(caseNamed('seed 0').calls[1]!.payload.seed).toBe(0)
  })

  it('the branches: a photo target takes the first pass; an illustration target the first still illustrated, else the LoRA\'s picture', () => {
    expect(caseNamed('target · photo').calls.length).toBe(4)
    expect(caseNamed('target · illustration · first').calls.length).toBe(5)
    expect(caseNamed('target · illustration · third').calls.length).toBe(9)
    // Never: the LoRA's picture is the result (Python downloads its link).
    expect(caseNamed('target · illustration · never').gets!.map(g => g.url)).toEqual(['https://r.test/restyle/flux.png'])
    // A failed verdict reads as a photo: one pass on the reference; a re-roll on a pass.
    expect(caseNamed('classifier fails · reference').calls.length).toBe(4)
    expect(caseNamed('classifier fails · first pass').calls.length).toBe(7)
    // An empty caption: the stand-in.
    expect(caseNamed('caption · empty').calls[1]!.payload.prompt).toBe(RESTYLE_CAPTION_STAND_IN)
    // The classify prompt is Python's.
    expect(caseNamed('target · photo').calls[2]!.payload.prompt).toBe(RESTYLE_CLASSIFY_PROMPT)
  })

  it('a pass answered with no picture fails plainly after its call (Python would try fal Nano Banana Pro there)', async () => {
    const c = caseNamed('target · photo')
    __setHuggingFaceLookupForTests(hfFrom(c))
    const run = await runPipeline(await planOf(c) as Extract<NodePlan, { kind: 'pipeline' }>, c, [...c.answers.slice(0, 3), { images: [] }])
    expect(run.sent.map(s => s.key)).toEqual(['describe', 'stylize', 'classify-ref', 'nb-1'])
    expect(run.error).toBe(RESTYLE_NB_NO_PICTURE)
    const noFlux = await runPipeline(await planOf(c) as Extract<NodePlan, { kind: 'pipeline' }>, c, [c.answers[0], { output: null }])
    expect(noFlux.sent.map(s => s.key)).toEqual(['describe', 'stylize'])
    expect(noFlux.error).toBe(LORA_NO_PICTURE)
  })

  it('a caption Sailor can\'t read (a dict) fails plainly after the caption (R3.3/R3.4 precedent)', async () => {
    const c = caseNamed('target · photo')
    __setHuggingFaceLookupForTests(hfFrom(c))
    const run = await runPipeline(await planOf(c) as Extract<NodePlan, { kind: 'pipeline' }>, c, [{ output: { text: 'x' } }])
    expect(run.sent.map(s => s.key)).toEqual(['describe'])
    expect(run.error).toMatch(/form Sailor can’t read/)
  })
})

// ── Through the engine ──

interface KitOpts {
  hosted?: boolean
  moderate?: (t: string) => Promise<{ ok: true } | { ok: false; categories: string[] }>
  /** Called before each submit (its 1-based index across both services, its service, the key-like kind): may hang or fail it. */
  onSubmit?: (n: number, provider: 'fal' | 'replicate', fakes: { fal: ReturnType<typeof createFakeFal>; replicate: ReturnType<typeof createFakeReplicate> }) => Promise<void> | void
  dir?: string
  root?: string
  ledger?: ReturnType<typeof makeKit>['ledger']
  statusHang?: (n: number) => boolean
  download?: (url: string) => Promise<{ bytes: Uint8Array; contentType: string | null }>
  kept?: ReturnType<typeof createFileKeptBytes>
  answers?: unknown[]
}
function fakesFor(c: PaidCase, o: KitOpts, sent: { n: number; provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown>; id: string }[]) {
  const queue = [...(o.answers ?? c.answers)]
  // Keyed by the request (a request sent again after a restart gets the same answer).
  const answerOf = new Map<string, unknown>()
  const keyOf = (input: unknown) => JSON.stringify(input)
  const bodyOf = (input: unknown, wrap: (a: Record<string, unknown>) => unknown) => JSON.stringify(wrap(answerOf.get(keyOf(input)) as Record<string, unknown>))
  const fal = createFakeFal({ bodyText: ({ input }) => bodyOf(input, a => a) })
  const replicate = createFakeReplicate({ bodyText: ({ input }) => bodyOf(input, a => ({ id: 'pred', status: 'succeeded', ...a })) })
  for (const [provider, fake] of [['fal', fal], ['replicate', replicate]] as const) {
    const submit = fake.client.submit
    fake.client.submit = (async (endpoint: string, payload: Record<string, unknown>, ...rest: unknown[]) => {
      const n = sent.length + 1
      if (!answerOf.has(keyOf(payload))) answerOf.set(keyOf(payload), queue.shift())
      sent.push({ n, provider, endpoint, payload, id: '' })
      await o.onSubmit?.(n, provider, { fal, replicate })
      const r = await (submit as (...a: unknown[]) => Promise<{ requestId: string }>)(endpoint, payload, ...rest)
      sent[n - 1]!.id = r.requestId
      return r
    }) as typeof submit
  }
  return { fal, replicate }
}
async function kitRun(c: PaidCase, o: KitOpts = {}) {
  const sent: { n: number; provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown>; id: string }[] = []
  const { fal, replicate } = fakesFor(c, o, sent)
  const root = o.root ?? loraRoot()
  __setInputUploadsEngineRootForTests(root)
  __setHuggingFaceLookupForTests(hfFrom(c))
  const download = o.download ?? (async (url: string) => {
    if (!c.files?.[url]) throw new Error(`${c.name}: GET ${url} is not served`)
    return { bytes: b64(c.files[url]!), contentType: 'image/png' }
  })
  const k = makeKit({
    hosted: o.hosted, root, dir: o.dir, fal, replicate, ledger: o.ledger, moderate: o.moderate,
    deps: { families: () => ON, download, ...(o.kept ? { kept: o.kept } : {}) },
  })
  writeFileSync(join(k.root, 'input', 'content_image.png'), b64(c.picture_files!.content_image!))
  const { runId } = await k.engine.startRun({ userId: k.userId, takes: [promptOf(c)], ...START })
  return { k, runId, sent, fal, replicate }
}
async function kitDone(c: PaidCase, o: KitOpts = {}) {
  const r = await kitRun(c, o)
  await r.k.engine.settled(r.runId)
  const rec = (await r.k.store.get(r.runId))!.takes[0]!.nodes.n!
  return { ...r, rec }
}
const charged = (k: ReturnType<typeof makeKit>) => [...k.ledger.holds.values()].map(h => [h.credits, h.actual])
const credits = (c: PaidCase, key: string) => {
  const calls = restyleLoraCalls(c.widgets)
  const call = key.startsWith('nb-') ? { ...calls.nanoBanana.call, fallbacks: [] } : key === 'stylize' ? calls.stylize.call : calls.moondream.call
  return callCredits({ usd: paidCallUsd(call)! })
}

describe('every calling case through the engine (cards and lora on)', () => {
  const calling = CASES.filter(c => !failsBeforeCalls(c) && !guidanceRefused(c))
  it.each(calling.map(c => [c.name, c] as const))('%s — sent, saved and held', async (_n, c) => {
    const { k, rec, sent } = await kitDone(c)
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(sent.map(s => ({ provider: s.provider, endpoint: s.endpoint, payload: asPython(c, s.payload) })))
      .toEqual(c.calls.map(x => ({ provider: x.provider, endpoint: x.endpoint, payload: x.payload })))
    expect(rec.calls!.map(x => x.key)).toEqual(keysOf(c))
    // Held at priceNode's figure: every call the settings can make.
    const price = priceNode(c.class_type, promptOf(c).n!.inputs)
    if ('refused' in price) throw new Error(price.refused)
    expect(rec.credits).toBe(price.credits)
    expect(rec.outputs.length).toBe(1)
    expect(rec.outputs[0]!.filename).toMatch(/^restyle_lora/)
    const bytes = new Uint8Array(readFileSync(join(k.root, 'output', rec.outputs[0]!.subfolder, rec.outputs[0]!.filename)))
    expect(await pixelSha(bytes)).toEqual({ sha: pythonPicture(c).sha256, shape: pythonPicture(c).shape })
  })
})

describe('charges: the calls that finished, never above the hold (ruling (f))', () => {
  it('a photo target: held for every call it may make, charged the four it made', async () => {
    const c = caseNamed('target · photo')
    const { k, rec } = await kitDone(c, { hosted: true })
    expect(rec.status, rec.error ?? '').toBe('done')
    const hold = (priceNode(c.class_type, c.widgets) as { credits: number }).credits
    const made = ['describe', 'stylize', 'classify-ref', 'nb-1'].reduce((s, key) => s + credits(c, key), 0)
    expect([hold, made]).toEqual([61, 1 + 8 + 1 + 16])
    expect(charged(k)).toEqual([[hold, made]])
  })

  it('an illustration target that never holds: all nine calls, charged exactly the hold', async () => {
    const c = caseNamed('target · illustration · never')
    const { k, rec } = await kitDone(c, { hosted: true })
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(charged(k)).toEqual([[61, 61]])
  })

  it('a failure in nb-2 charges describe, stylize, classify-ref, nb-1 and classify-1; nb-2 (failed) is not charged', async () => {
    const c = caseNamed('target · illustration · third')
    // Python's order: describe(1) stylize(2) classify-ref(3) nb-1(4) classify-1(5) nb-2(6).
    const { k, rec, sent } = await kitDone(c, { hosted: true, onSubmit: (n, provider, f) => { if (n === 6 && provider === 'fal') f.fal.failNext(1) } })
    expect(rec.status).toBe('error')
    expect(sent.map(s => s.endpoint)).toEqual([MOONDREAM_SLUG, FLUX_DEV_LORA_SLUG, MOONDREAM_SLUG, NANO_BANANA_2_FAL_EDIT, MOONDREAM_SLUG, NANO_BANANA_2_FAL_EDIT])
    expect(rec.calls!.map(x => [x.key, x.status])).toEqual([['describe', 'done'], ['stylize', 'done'], ['classify-ref', 'done'], ['nb-1', 'done'], ['classify-1', 'done'], ['nb-2', 'error']])
    expect(charged(k)).toEqual([[61, 1 + 8 + 1 + 16 + 1]])
  })

  it('a verdict whose call fails reads as a photo and isn\'t charged: the first pass is the result', async () => {
    const c = caseNamed('target · illustration · first')
    const { k, rec, sent } = await kitDone(c, { hosted: true, onSubmit: (n, _p, f) => { if (n === 3) f.replicate.failNext(1) } })
    expect(rec.status, rec.error ?? '').toBe('done')
    // Photo: one pass, no verdict on it.
    expect(sent.map(s => s.endpoint)).toEqual([MOONDREAM_SLUG, FLUX_DEV_LORA_SLUG, MOONDREAM_SLUG, NANO_BANANA_2_FAL_EDIT])
    expect(charged(k)).toEqual([[61, 1 + 8 + 16]])
  })

  it('each pass is charged at the route that served it, fal\'s Nano Banana 2 (fix round 1 ruling): at 4K 24 a pass, not 30; the hold still covers the fallbacks', async () => {
    const photo = caseNamed('resolution 4K · format png')
    const calls = restyleLoraCalls(photo.widgets)
    expect(callCredits({ usd: paidCallUsd({ ...calls.nanoBanana.call, fallbacks: [] })! })).toBe(24)
    expect(callCredits({ usd: paidCallUsd(calls.nanoBanana.call)! })).toBe(30)
    const a = await kitDone(photo, { hosted: true })
    expect(a.rec.status, a.rec.error ?? '').toBe('done')
    expect(a.rec.calls!.find(x => x.key === 'nb-1')!.usd).toBe(0.16)
    expect(charged(a.k)).toEqual([[103, 1 + 8 + 1 + 24]])
    // Every pass at 4K, the LoRA's picture the result: 5 + 8 + 3 × 24 = 85 of the 103 held.
    const never = caseNamed('target · illustration · never')
    const b = await kitDone({ ...never, widgets: { ...never.widgets, resolution: '4K' } }, { hosted: true })
    expect(b.rec.status, b.rec.error ?? '').toBe('done')
    expect(charged(b.k)).toEqual([[103, 85]])
    // At 1K and 2K fal's own price is the pass's whole price: no difference.
    for (const r of ['1K', '2K']) {
      const x = restyleLoraCalls({ resolution: r }).nanoBanana.call
      expect(paidCallUsd({ ...x, fallbacks: [] }), r).toBe(paidCallUsd(x))
    }
  })

  it('a lost download of the LoRA\'s picture isn\'t charged for that call (Sailor absorbs it)', async () => {
    const c = caseNamed('target · photo')
    const { k, rec } = await kitDone(c, { hosted: true, download: async (url) => { throw new Error(`gone ${url}`) } })
    expect(rec.status).toBe('error')
    expect(charged(k)).toEqual([[61, 1]])
  })
})

const until = async (ok: () => Promise<boolean>) => {
  for (let i = 0; i < 2000 && !(await ok()); i++) await new Promise(r => setTimeout(r, 5))
  expect(await ok(), 'the run reached the point').toBe(true)
}
const callOf = async (k: ReturnType<typeof makeKit>, runId: string, key: string) =>
  ((await k.store.get(runId))!.takes[0]!.nodes.n!.calls ?? []).find(x => x.key === key)

describe('resumed after a restart', () => {
  type Point = 'nb-1 in flight' | 'classify-1 not yet sent' | 'classify-1 in flight'
  const POINTS: Point[] = ['nb-1 in flight', 'classify-1 not yet sent', 'classify-1 in flight']

  it.each(POINTS.map(p => [p] as const))('restarted with %s: each call sent once, the LoRA\'s picture downloaded once, done and charged the calls made', async (point) => {
    const c = caseNamed('target · illustration · third')
    const hang = { on: true }
    const never = () => new Promise<never>(() => {})
    const gets: string[] = []
    const download = async (url: string) => {
      gets.push(url)
      return { bytes: b64(c.files![url]!), contentType: 'image/png' }
    }
    const dir = mkdtempSync(join(tmpdir(), 'runner-restyle-resume-'))
    const kept = createFileKeptBytes(join(dir, 'kept'))
    const sent: { n: number; provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown>; id: string }[] = []
    // One pair of fakes for both servers (the provider keeps its jobs across the restart).
    const fakes = fakesFor(c, { onSubmit: async (n) => { if (hang.on && point === 'classify-1 not yet sent' && n === 5) await never() } }, sent)
    // The first server stops following a job at the point (its polls never answer): the second takes over.
    const hungOf = <T extends { status: unknown }>(client: T, n: number): T => {
      const status = client.status as (...a: unknown[]) => Promise<unknown>
      return { ...client, status: (async (url: string, ...rest: unknown[]) => (hang.on && sent[n - 1] && url.includes(sent[n - 1]!.id) ? never() : status(url, ...rest))) as T['status'] }
    }
    const hungAt = point === 'nb-1 in flight' ? 4 : 5
    const root = loraRoot()
    const k1 = makeKit({
      hosted: true, dir, root,
      fal: { ...fakes.fal, client: hungOf(fakes.fal.client, hungAt) },
      replicate: { ...fakes.replicate, client: hungOf(fakes.replicate.client, hungAt) },
      deps: { families: () => ON, download, kept },
    })
    __setInputUploadsEngineRootForTests(root)
    __setHuggingFaceLookupForTests(hfFrom(c))
    writeFileSync(join(k1.root, 'input', 'content_image.png'), b64(c.picture_files!.content_image!))
    const { runId } = await k1.engine.startRun({ userId: k1.userId, takes: [promptOf(c)], ...START })
    const reached: Record<Point, () => Promise<boolean>> = {
      'nb-1 in flight': async () => !!(await callOf(k1, runId, 'nb-1'))?.request,
      'classify-1 not yet sent': async () => (await callOf(k1, runId, 'classify-1'))?.status === 'sent',
      'classify-1 in flight': async () => !!(await callOf(k1, runId, 'classify-1'))?.request,
    }
    await until(reached[point])
    await new Promise(r => setTimeout(r, 30))
    hang.on = false
    const k2 = makeKit({ hosted: true, dir: k1.dir, root: k1.root, fal: fakes.fal, replicate: fakes.replicate, ledger: k1.ledger, deps: { families: () => ON, download, kept } })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    const rec = (await k2.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    // Each of Python's nine calls sent once, in its order.
    const submitted = [...fakes.replicate.submitted().map(r => ({ id: r.id, endpoint: r.endpoint })), ...fakes.fal.submitted().map(r => ({ id: r.id, endpoint: r.endpoint }))]
    expect(submitted.length).toBe(9)
    expect(rec.calls!.map(x => [x.key, x.status])).toEqual(keysOf(c).map(key => [key, 'done']))
    // The LoRA's picture was kept for the run: downloaded once, never again.
    expect(gets.filter(u => u === 'https://r.test/restyle/flux.png')).toEqual(['https://r.test/restyle/flux.png'])
    const out = rec.outputs[0]!
    expect(await pixelSha(new Uint8Array(readFileSync(join(k2.root, 'output', out.subfolder, out.filename))))).toEqual({ sha: pythonPicture(c).sha256, shape: pythonPicture(c).shape })
    expect(charged(k1)).toEqual([[61, 61]])
  })
})

describe('prices (ruling (a))', () => {
  const at = (resolution: unknown) => ({ ...caseNamed('target · photo').widgets, resolution })

  it('the cards, re-read 2026-09-28: Moondream and flux-dev-lora on their edit cards; Nano Banana 2 on fal\'s, its fallbacks covered at cost', () => {
    expect(EDIT_RATES[MOONDREAM_SLUG]).toMatchObject({ unit: 'per_image', usd: 0.001, read: '2026-09-28', source: 'https://replicate.com/lucataco/moondream2', confidence: 'estimate' })
    expect(EDIT_RATES[FLUX_DEV_LORA_SLUG]).toMatchObject({ unit: 'per_image', usd: 0.04, confidence: 'estimate' })
    expect(EDIT_RATES[NANO_BANANA_2_FAL_EDIT]).toMatchObject({ unit: 'by_resolution', byTier: { '0.5K': 0.06, '1K': 0.08, '2K': 0.12, '4K': 0.16 }, confidence: 'verified' })
    const c = restyleLoraCalls(at('1K'))
    expect([c.moondream.times, c.stylize.times, c.nanoBanana.times]).toEqual([5, 1, 3])
    expect(c.nanoBanana.call.fallbacks!.map(f => f.endpoint)).toEqual(['fal-ai/nano-banana-pro/edit', 'google/nano-banana-2'])
    // The steps are editSteps' (one list of calls).
    expect(editSteps(RESTYLE_LORA_CLASS, at('2K'))!.map(s => [s.call.endpoint, s.times])).toEqual([[MOONDREAM_SLUG, 5], [FLUX_DEV_LORA_SLUG, 1], [NANO_BANANA_2_FAL_EDIT, 3]])
    expect([paidCallUsd(c.moondream.call), paidCallUsd(c.stylize.call), paidCallUsd(c.nanoBanana.call)]).toEqual([0.001, 0.04, 0.08])
    expect(paidCallUsd(restyleLoraCalls(at('4K')).nanoBanana.call)).toBe(0.2)
  })

  it('priced call by call on both paths: 1K 61 (was 50), 2K 67 (was 62), 4K 103 (was 95); a linked resolution at the dearest', async () => {
    const { nodeCreditEstimate } = await import('~/lib/nodeCreditEstimate')
    const want: [unknown, number][] = [['1K', 61], ['2K', 67], ['4K', 103], [undefined, 61], [['x', 0], 103]]
    for (const [r, credits] of want) {
      const inputs = r === undefined ? { ...caseNamed('target · photo').widgets, resolution: undefined } : at(r)
      expect((priceNode(RESTYLE_LORA_CLASS, inputs) as { credits: number }).credits, JSON.stringify(r)).toBe(credits)
      if (Array.isArray(r)) continue
      expect(priceGraph({ 1: { class_type: RESTYLE_LORA_CLASS, inputs } }).nodes!['1']).toBe(credits)
      expect(priceGraph({ 1: { class_type: RESTYLE_LORA_CLASS, inputs } }, { families: ON }).nodes!['1']).toBe(credits)
      expect(nodeCreditEstimate(RESTYLE_LORA_CLASS, inputs)).toBe(credits + BASE_RENDER_CREDITS)
    }
    // Every call's own credits, summed: 5 × 1 + 8 + 3 × 16 at 1K.
    expect(paidCalls(RESTYLE_LORA_CLASS, at('1K'), {})).toEqual({ steps: [restyleLoraCalls(at('1K')).moondream, restyleLoraCalls(at('1K')).stylize, restyleLoraCalls(at('1K')).nanoBanana] })
    // Whatever the LoRA (a trained model is covered by flux-dev-lora's card).
    expect((priceNode(RESTYLE_LORA_CLASS, { ...at('1K'), lora_name: 'trained.safetensors', lora_url: '' }) as { credits: number }).credits).toBe(61)
  })

  it('priced by its calls, no flat row, no estimate floor (its cards are edit cards); the price book moved on', () => {
    expect(PAID_NODE_CLASSES).toContain(RESTYLE_LORA_CLASS)
    expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, RESTYLE_LORA_CLASS)).toBe(false)
    expect(PRE_R3_FLAT[RESTYLE_LORA_CLASS]).toBeUndefined()
    expect(readsEstimateCard(RESTYLE_LORA_CLASS, at('1K'))).toBe(false)
    expect(PRICE_BOOK_VERSION).toBe('r3-nano-extras')
    expect(paidNoCall(RESTYLE_LORA_CLASS, {})).toBe(false)
  })

  it('Moondream at $0.001 (was $0.002) moves no credits: 1 a call either way (fix round 1 sweep)', () => {
    const card = EDIT_RATES[MOONDREAM_SLUG] as { usd: number }
    const sweep = () => [
      ...['1K', '2K', '4K', ['x', 0]].map(r => priceNode(RESTYLE_LORA_CLASS, at(r))),
      ...['DescribeImageNode', 'DescribeImageRemoteNode'].map(ct => priceNode(ct, { model: 'Moondream 2', image: ['x', 0], prompt: 'hi' })),
    ].map(p => (p as { credits: number }).credits)
    const now = sweep()
    try {
      card.usd = 0.002
      expect(sweep()).toEqual(now)
    }
    finally { card.usd = 0.001 }
    expect(now).toEqual([61, 67, 103, 103, 1, 1])
  })

  it('the hosted run-confirm dialog\'s row shows the credits held (fix round 1): 61, not 44', async () => {
    const { estimateUsdForNodes } = await import('~/lib/costEstimate')
    const { formatCostBadge } = await import('~/lib/pricing')
    const { creditsForUsd } = await import('#shared/pricing/markup')
    for (const [r, credits] of [['1K', 61], ['2K', 67], ['4K', 103]] as const) {
      const w = at(r)
      const names = Object.keys(w)
      const est = estimateUsdForNodes([{ id: '1', type: RESTYLE_LORA_CLASS, widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(k => w[k as keyof typeof w]) }], { hosted: true })!
      expect(creditsForUsd(est.breakdown[0]!.usd), r).toBe(credits)
      expect(formatCostBadge(est.breakdown[0]!.usd, false, true), r).toBe(`~${credits} cr`)
      expect(est.hostedCredits, r).toBe(credits + BASE_RENDER_CREDITS)
    }
  })

  it('the stage hold is the node\'s price', () => {
    const p = promptOf(caseNamed('target · photo'))
    expect(stageEstimate(p, Object.keys(p), false, ON)).toBe(61)
  })
})

describe('every paid class shows the dollars its credits came from (fix round 1: credits = creditsForUsd(usd))', () => {
  const L = ['x', 0]
  const golden = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'pricing', 'price-graph-golden.json'), 'utf8')) as { modelPriced: Record<string, Record<string, unknown>> }
  const variants = (ct: string): Record<string, unknown>[] => [
    {},
    { model: L, resolution: L, prompt: L, image: L, text: L, duration: L, steps: L, engine: L, num_inference_steps: L },
    ...Object.keys(golden.modelPriced[ct] ?? {}).map(model => ({ model })),
    ...['0.5K', '1K', '2K', '4K'].map(resolution => ({ resolution })),
    ...['Moondream 2', 'ByteDance Dolphin', 'YOLO-World', 'Gemini 2.5 Flash', 'GPT-5', 'Claude 4.5 Haiku', 'DeepSeek R1', 'MusicGen', 'Rodin (textured \u00b7 quad mesh)'].map(model => ({ model, image: L, prompt: 'hi', text: 'hello', engine: model })),
    ...['LaMa (fast)', 'Bria Eraser (quality)'].map(background_fill => ({ background_fill, image: L })),
    { lora_a_url: 'hf.co/a/b', lora_b_url: 'hf.co/c/d', num_inference_steps: 50 },
    { duration: 30, text: 'x'.repeat(5000), image_size: 'auto', steps: 100 },
  ]

  it('for every paid class and setting, the charge path too; Restyle and Separate background and foreground included', async () => {
    const { creditsForUsd } = await import('#shared/pricing/markup')
    const { shownUsd } = await import('#shared/pricing/nodePrice')
    let checked = 0
    for (const ct of PAID_NODE_CLASSES) {
      for (const v of variants(ct)) {
        for (const opts of [{}, { answerUsage: { inputTokens: 1234, outputTokens: 567 } }, { inputChars: 42 }, { hosted: true }]) {
          const p = priceNode(ct, v, opts)
          if ('refused' in p) continue
          checked++
          expect(creditsForUsd(p.usd), `${ct} ${JSON.stringify(v)} ${JSON.stringify(opts)}: $${p.usd}`).toBe(p.credits)
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
    // The two classes whose calls mark up apart: the dialog row now reads their hold.
    expect(priceNode('SplitPhotoLayersNode', { image: L, background_fill: 'LaMa (fast)' })).toEqual({ usd: 0.01, credits: 2 })
    expect(creditsForUsd((priceNode(RESTYLE_LORA_CLASS, { resolution: '1K' }) as { usd: number }).usd)).toBe(61)
    // One call, or calls that mark up alike: the summed basis, as before.
    expect(priceNode('DescribeImageNode', { model: 'Moondream 2', image: L, prompt: 'hi' })).toEqual({ usd: 0.001, credits: 1 })
    // The inverse holds for every credit figure.
    for (let c = 1; c <= 20_000; c++) if (creditsForUsd(shownUsd(1e9, c)) !== c) throw new Error(`shownUsd breaks at ${c}`)
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
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  }
  const base = caseNamed('target · photo')
  const with_ = (w: Record<string, unknown>) => promptOf(base, w)

  it('hosted (ruling (i)): a picked LoRA (even beside a link), a trained model\'s address, a link that isn\'t public, a wired one — on both paths', async () => {
    const cases: [ApiPrompt, string][] = [
      [with_({ lora_name: 'collage.safetensors', lora_url: '' }), RESTYLE_LORA_BY_NAME_HOSTED],
      [with_({ lora_name: 'collage.safetensors' }), RESTYLE_LORA_BY_NAME_HOSTED],
      [with_({ lora_url: 'finnyjules/my-style' }), LORA_TRAINED_MODEL_HOSTED],
      [with_({ lora_url: 'https://replicate.delivery/x/trained.tar' }), LORA_LINK_NOT_PUBLIC],
      [with_({ lora_url: 'owner/model/x.safetensors' }), LORA_LINK_NOT_PUBLIC],
    ]
    for (const [p, want] of cases) {
      expect(hostedRequestProblems(p).map(x => x.message), JSON.stringify(p.n!.inputs)).toEqual([want])
      await refusedAtStart(p, want)
    }
    expect(hostedLoraProblem(RESTYLE_LORA_CLASS, { lora_url: ['t', 0], lora_name: '[None]' })?.message).toBe(LORA_WIRED_HOSTED)
    expect(hostedLoraProblem(RESTYLE_LORA_CLASS, { lora_url: '', lora_name: ['t', 0] })?.message).toBe(LORA_WIRED_HOSTED)
    // Allowed: public links, and no LoRA at all.
    for (const url of ['https://huggingface.co/a/b', 'hf.co/a/b', 'https://civitai.com/api/download/models/1', 'https://x.test/w.safetensors', '']) {
      expect(hostedLoraProblem(RESTYLE_LORA_CLASS, { lora_name: '[None]', lora_url: url }), url).toBeNull()
    }
    // Local: unchanged.
    expect(requestProblems(with_({ lora_name: 'collage.safetensors' }), { runner: true })).toEqual([])
    // Hosted planning refuses a picked LoRA itself, whatever the caller checked.
    await expect(planOf(caseNamed('lora · collage by name'), { hosted: true })).rejects.toThrow()
  })

  it('a guidance flux-dev-lora refuses (over 10) when the link or the sidecar shows it runs flux-dev-lora; a trained model takes it', async () => {
    await refusedAtStart(with_({ flux_guidance: 12 }), RESTYLE_GUIDANCE_TOO_HIGH, false)
    await refusedAtStart(with_({ lora_url: '', lora_name: 'collage.safetensors', flux_guidance: 10.5 }), RESTYLE_GUIDANCE_TOO_HIGH, false)
    expect(await loraStartProblem(with_({ lora_url: '', lora_name: 'trained.safetensors', flux_guidance: 20 }))).toBeNull()
    expect(requestProblems(with_({ lora_url: 'finnyjules/my-style', flux_guidance: 20 }), { runner: true })).toEqual([])
    // A picked trained LoRA beside a flux-dev-lora link: the link decides (flux-dev-lora), refused by the request rules.
    expect(requestProblems(with_({ lora_name: 'trained.safetensors', flux_guidance: 20 }), { runner: true }).map(x => x.message)).toEqual([RESTYLE_GUIDANCE_TOO_HIGH])
  })

  it('a LoRA name ComfyUI doesn\'t list, and a sidecar over its cap (read even beside a link)', async () => {
    await refusedAtStart(with_({ lora_name: 'gone.safetensors' }), LORA_NOT_LISTED, false)
    const root = loraRoot()
    writeFileSync(join(root, 'models', 'loras', 'huge.safetensors'), '')
    writeFileSync(join(root, 'models', 'loras', 'huge.json'), `{"trigger": "${'x'.repeat(LORA_SIDECAR_MAX_BYTES)}"}`)
    __setInputUploadsEngineRootForTests(root)
    expect((await loraStartProblem(with_({ lora_name: 'huge.safetensors' })))?.message).toBe(LORA_SIDECAR_TOO_LARGE)
    expect(loraNamesUsed(RESTYLE_LORA_CLASS, { lora_name: 'x.safetensors', lora_url: 'hf.co/a/b' })).toEqual([{ input: 'lora_name', name: 'x.safetensors' }])
    expect(loraNamesUsed(RESTYLE_LORA_CLASS, { lora_name: '[None]' })).toEqual([])
  })

  it('the refusals are plain words', () => {
    for (const w of [RESTYLE_GUIDANCE_TOO_HIGH, RESTYLE_LORA_BY_NAME_HOSTED, RESTYLE_NB_NO_PICTURE]) expect(w).not.toMatch(/Node|_|\bid\b|sidecar|json|fal\b/i)
  })
})

describe('moderation', () => {
  it('lists the describe prompt, the extra direction and the LoRA link', () => {
    expect(PAID_TEXT_INPUTS[RESTYLE_LORA_CLASS]).toEqual(['describe_prompt', 'extra_style_direction', 'lora_url'])
    expect(extraPromptTexts({ n: { class_type: RESTYLE_LORA_CLASS, inputs: { describe_prompt: 'who?', extra_style_direction: ' ', lora_url: 'hf.co/a/b' } } })).toEqual(['who?', 'hf.co/a/b'])
  })

  it('hosted: a flagged extra direction is refused at the start, before the hold', async () => {
    const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
    const root = loraRoot()
    __setInputUploadsEngineRootForTests(root)
    const k = makeKit({ hosted: true, root, moderate, deps: { families: () => ON } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [promptOf(caseNamed('target · photo'), { extra_style_direction: 'a forbidden look' })], ...START })).rejects.toThrow()
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('hosted: a flagged caption is refused before the Flux call; the caption is charged, nothing else is sent', async () => {
    const c = caseNamed('target · photo')
    const moderate = vi.fn(async (t: string) => (t.includes('red coat') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
    const { k, rec, sent } = await kitDone(c, { hosted: true, moderate })
    expect(rec.status).toBe('error')
    expect(sent.map(s => s.endpoint)).toEqual([MOONDREAM_SLUG])
    expect(moderate.mock.calls.map(x => x[0])).toContain(c.calls[1]!.payload.prompt)
    expect(charged(k)).toEqual([[61, 1]])
  })

  it('a Text card wired into the describe prompt and the extra direction: sent as typed', async () => {
    const c = caseNamed('extra direction · set · illustration third')
    const p: ApiPrompt = { ...promptOf(c), d: { class_type: 'Text', inputs: { text: c.widgets.describe_prompt as string } }, e: { class_type: 'Text', inputs: { text: c.widgets.extra_style_direction as string } } }
    p.n!.inputs.describe_prompt = ['d', 0]
    p.n!.inputs.extra_style_direction = ['e', 0]
    expect(isRunnerEligible(p, ON)).toBe(true)
    const sent: { n: number; provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown>; id: string }[] = []
    const fakes = fakesFor(c, {}, sent)
    const root = loraRoot()
    __setInputUploadsEngineRootForTests(root)
    __setHuggingFaceLookupForTests(hfFrom(c))
    const k = makeKit({ root, ...fakes, deps: { families: () => ON, download: async url => ({ bytes: b64(c.files![url]!), contentType: 'image/png' }) } })
    writeFileSync(join(k.root, 'input', 'content_image.png'), b64(c.picture_files!.content_image!))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect(sent.map(s => asPython(c, s.payload))).toEqual(c.calls.map(x => x.payload))
  })
})

describe('with lora off (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but lora', RUNNER_FAMILIES.filter(f => f !== 'lora')],
  ]
  const isRestyle = (ct: string) => ct === RESTYLE_LORA_CLASS
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, isRestyle(n.class_type) ? { ...n, class_type: `${n.class_type}Before` } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (!isRestyle(p[id]!.class_type)) {
          expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
        }
      }
    }
  }
  const sample = () => promptOf(caseNamed('target · photo'))

  it('the class is left to the engine and named by the needs-the-engine list; with lora on, the runner takes it', () => {
    const p = sample()
    expect(runnerTakesNode(p, 'n', new Set(['cards']))).toBe(false)
    expect(runnerTakesNode(p, 'n', ON)).toBe(true)
    expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n'])
    expect(RUNNER_OUTPUT_CLASSES.has(RESTYLE_LORA_CLASS)).toBe(true)
    expect(PAID_PICTURE_FAMILY[RESTYLE_LORA_CLASS]).toBe('lora')
    expect(RUNNER_NODE_RULES[RESTYLE_LORA_CLASS]!.family).toBe('lora')
    expect(RUNNER_ROUTES[RESTYLE_LORA_CLASS]).toMatchObject({ first: 'replicate', backup: null })
  })

  it('a wired widget, a value out of range or no picture leaves the node to the engine', () => {
    const p = sample()
    const w = (x: Record<string, unknown>) => ({ ...p, t: { class_type: 'Text', inputs: { text: 'x' } }, n: { ...p.n!, inputs: { ...p.n!.inputs, ...x } } })
    expect(runnerTakesNode(w({ lora_name: ['t', 0] }), 'n', ON)).toBe(false)
    expect(runnerTakesNode(w({ lora_url: ['t', 0] }), 'n', ON)).toBe(false)
    expect(runnerTakesNode(w({ flux_steps: 51 }), 'n', ON)).toBe(false)
    expect(runnerTakesNode(w({ resolution: '8K' }), 'n', ON)).toBe(false)
    expect(runnerTakesNode(w({ output_format: 'webp' }), 'n', ON)).toBe(false)
    expect(runnerTakesNode(w({ content_image: undefined }), 'n', ON)).toBe(false)
  })

  it('over synthetic chains: into a Frame, into Flux Dev + LoRA, a Text card into the describe prompt', () => {
    const p = sample()
    sameAsBefore(p, 'alone')
    sameAsBefore({ ...p, f: { class_type: 'Compositor', inputs: { layer1: ['n', 0], width: 0, height: 0 } } }, '→ Frame')
    sameAsBefore({ ...p, i: { class_type: 'Image', inputs: { image: '', images: ['n', 0] } } }, '→ Image card')
    sameAsBefore({ ...p, t: { class_type: 'Text', inputs: { text: 'hi' } }, n: { ...p.n!, inputs: { ...p.n!.inputs, describe_prompt: ['t', 0] } } }, 'Text →')
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (with a Restyle spliced in beside each)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    let restyles = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        graphs++
        restyles += Object.values(p).filter(n => isRestyle(n.class_type)).length
        sameAsBefore(p, uuid)
        const s = sample()
        sameAsBefore({ ...p, d_r: { ...s.n!, inputs: { ...s.n!.inputs, content_image: ['d_p', 0] } }, d_p: s.p_content_image!, ...readerFor(RESTYLE_LORA_CLASS, 'd_r') }, `${uuid} + Restyle`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`restyle-lora families-off invariant: ${graphs} saved graphs, ${restyles} Restyle nodes`)
  }, 600_000)
})
