/**
 * R3.4: describe, read and find (family `describe`) — Describe an image and
 * its hidden twin (moondream2), Describe a video (Gemini 2.5 Flash), Extract
 * text (Dolphin), Find objects (YOLO-World) — against what their real Python
 * sends and returns (fixtures/runner-paid-describe.json,
 * scripts/runner_paid_fixtures.py --group describe), priced from Replicate's
 * cards on both paths.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny'
import sharp from 'sharp'
import { createFakeReplicate, makeKit, ofType, rgbPng1x1 } from './__runner__/kit'
import { normalizeSent, runPaidCase, wireText, type PaidCase } from './__runner__/paidParity'
import { checkPayload, loadProviderSchema, type ProviderSchemaFixture } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { OUTPUT_KINDS } from '#shared/runner/values'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import { PY_STR_UNREADABLE, parsePyJson } from '#shared/runner/pyJson'
import {
  DESCRIBE_CLASSES, DESCRIBE_ENDPOINTS, DESCRIBE_VIDEO_MAX_ANSWER_TOKENS, DESCRIBE_VIDEO_MAX_SECONDS, DESCRIBE_VIDEO_NEEDS_LINK,
  DESCRIBE_VIDEO_NEEDS_WEB_ADDRESS, DESCRIBE_VIDEO_TOKENS_PER_SECOND, DESCRIBE_VIDEO_TOO_LONG, DESCRIBE_VIDEO_UPLOAD_ONLY, describeRequestProblem, type DescribeClass,
} from '#shared/runner/describe'
import { PAID_RATES, otherCardFor, paidCallUsd } from '#shared/pricing/paidRates'
import { EDIT_RATES } from '#shared/pricing/editRates'
import { PAID_NODE_CLASSES, paidCalls, paidNoCall, utf8Bytes } from '#shared/pricing/paidSettings'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { GRAPH_NODE_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { PAID_TEXT_INPUTS, extraPromptTexts, stageEstimate } from '~~/server/runner/metering'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { extractTextOf, findObjectsJson } from '~~/server/runner/generators/describe'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { mediaNodeKind, nodeMediaChangedWords, nodeMediaFiles } from '~~/server/runner/nodeMedia'
import { DESCRIBE_VIDEO_CHANGED, DESCRIBE_VIDEO_RULE } from '~~/server/runner/describeVideoMedia'
import { requestProblems } from '~~/server/runner/requestRules'

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-describe.json'), 'utf8')) as { cases: PaidCase[] }
const CASES = FIXTURE.cases
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'describe'])
const cls = (c: PaidCase) => c.class_type as DescribeClass
const IMAGE_URL = 'https://fal.storage/image.png'
const NO_UI = null

/** The answer a case gives, as the engine reads it: its body text and the object parsed from it. */
function answerOf(c: PaidCase): { result: unknown; raw: string } {
  const a = c.answers[0] as { __body__: string }
  return { result: JSON.parse(a.__body__.replace(/\bNaN\b|-?\bInfinity\b/g, 'null')), raw: a.__body__ }
}

/**
 * Python's wire text, with its one known difference from the runner's
 * (R3.3 ruling 1, FLOAT widgets only): Find objects' confidence is a float
 * in Python, so a whole one is written `0.0` / `1.0` where the runner's JSON
 * writes `0` / `1` — the same JSON number to Replicate's schema (number).
 */
function pythonWire(c: PaidCase, payloadJson: string, sent: Record<string, unknown>): string {
  if (c.class_type === 'FindObjectsNode' && typeof sent.score_thr === 'number' && Number.isInteger(sent.score_thr)) {
    return payloadJson.replace(/"score_thr": (-?\d+)\.0([,}])/, '"score_thr": $1$2')
  }
  return payloadJson
}

/** The runner's refusals where Python sends (or raises): Describe a video with no address, or one of spaces. */
function expectedRefusal(c: PaidCase): string | null {
  if (c.class_type !== 'DescribeVideoNode') return null
  const url = c.widgets.video_url
  return typeof url === 'string' && !url.trim() ? DESCRIBE_VIDEO_NEEDS_LINK : null
}

/** A LoadImage feeding the node's picture input, as the kit's cases do. */
function withPicture(c: PaidCase): ApiPrompt {
  const p: ApiPrompt = { n: { class_type: c.class_type, inputs: { ...c.widgets } } }
  if (c.pictures?.length) {
    p.p_image = { class_type: 'LoadImage', inputs: { image: 'image.png', upload: 'image' } }
    p.n!.inputs.image = ['p_image', 0]
  }
  return p
}

async function planOf(c: PaidCase, hosted = false): Promise<NodePlan> {
  return planNode({
    prompt: withPicture(c), nodeId: 'n', gateOpen: false, hosted,
    filesFrom: link => (link[0] === 'p_image' ? [{ filename: 'image.png', subfolder: '', type: 'input' }] : []),
    toUrl: async f => `https://fal.storage/${f.filename}`,
  })
}

/** Python's `IMG:image` is the handed-off picture. */
const asPython = (payload: Record<string, unknown>) => normalizeSent([{ provider: 'replicate', endpoint: '', payload }], ['image'])[0]!.payload

/** An MP4 of `seconds` (mediabunny: a real container, never decoded), as runner-topaz-video's. */
async function mp4(seconds: number, width = 640, height = 360, fps = 10): Promise<Buffer> {
  const out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const src = new EncodedVideoPacketSource('avc')
  out.addVideoTrack(src, { frameRate: fps })
  await out.start()
  const description = new Uint8Array([1, 0x42, 0xC0, 0x1E, 0xFF, 0xE1, 0, 0x0A, 0x67, 0x42, 0xC0, 0x1E, 0xDA, 0x02, 0x80, 0xBF, 0xE5, 0x84, 1, 0, 4, 0x68, 0xCE, 0x3C, 0x80])
  const frames = Math.round(seconds * fps)
  for (let i = 0; i < frames; i++) {
    await src.add(new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x65]), i === 0 ? 'key' : 'delta', i / fps, 1 / fps),
      i === 0 ? { decoderConfig: { codec: 'avc1.42c01e', codedWidth: width, codedHeight: height, description } } : undefined)
  }
  await out.finalize()
  return Buffer.from((out.target as BufferTarget).buffer!)
}

// ── The published inputs (each model page's schema, read 2026-09-27), until the controller saves them ──

const publishedInput = (properties: Record<string, unknown>, required: string[]): ProviderSchemaFixture => ({
  endpoint: '', fetchedAt: '2026-09-27', input: { type: 'object', required, properties }, output: {}, components: { schemas: {} },
})
const PUBLISHED: Record<string, ProviderSchemaFixture> = {
  'lucataco/moondream2': publishedInput({
    image: { type: 'string', format: 'uri' },
    prompt: { type: 'string', default: 'Describe this image' },
  }, ['image']),
  'google/gemini-2.5-flash': publishedInput({
    top_p: { type: 'number', default: 0.95, maximum: 1, minimum: 0 },
    images: { type: 'array', items: { type: 'string', format: 'uri' }, default: [] },
    prompt: { type: 'string' },
    videos: { type: 'array', items: { type: 'string', format: 'uri' }, default: [] },
    temperature: { type: 'number', default: 1, maximum: 2, minimum: 0 },
    thinking_budget: { type: 'integer', maximum: 24576, minimum: 0, nullable: true },
    dynamic_thinking: { type: 'boolean', default: false },
    max_output_tokens: { type: 'integer', default: 65535, maximum: 65535, minimum: 1 },
    system_instruction: { type: 'string', nullable: true },
  }, ['prompt']),
  'bytedance/dolphin': publishedInput({
    file: { type: 'string', format: 'uri' },
    output_format: { enum: ['markdown_content', 'json_content'], type: 'string', default: 'markdown_content' },
  }, ['file']),
  'zsxkib/yolo-world': publishedInput({
    nms_thr: { type: 'number', default: 0.5, maximum: 1, minimum: 0 },
    score_thr: { type: 'number', default: 0.05, maximum: 1, minimum: 0 },
    class_names: { type: 'string' },
    input_media: { type: 'string', format: 'uri' },
    max_num_boxes: { type: 'integer', default: 100, maximum: 300, minimum: 1 },
  }, ['input_media']),
}
/** The saved schema where the controller has snapshotted it, else the published inputs above. */
function schemaOf(slug: string): ProviderSchemaFixture {
  const file = join(__dirname, 'fixtures', 'provider-schemas', 'replicate', `${slug.replace('/', '__')}.json`)
  return existsSync(file) ? loadProviderSchema('replicate', slug) : PUBLISHED[slug]!
}

describe('the fixture', () => {
  it('covers each class with the default, an empty and a non-ASCII prompt, and every answer shape the brief names', () => {
    const names = new Set(CASES.map(c => c.name))
    expect(new Set(CASES.map(c => c.class_type))).toEqual(new Set(DESCRIBE_CLASSES))
    for (const p of ['default', 'empty', 'non-ASCII']) {
      for (const t of ['describe', 'describe twin', 'video']) expect(names.has(`${t} · ${p}`), `${t} ${p}`).toBe(true)
    }
    for (const q of ['confidence 0.0', 'confidence 0.25', 'confidence 1.0', 'query spaces and commas', 'query empty']) expect(names.has(`find · ${q}`), q).toBe(true)
    for (const a of ['string', 'dict with floats', 'list', 'null']) expect(names.has(`answer · find · ${a}`), a).toBe(true)
    for (const a of ['pages list', 'dict text', 'dict markdown', 'dict transcription', 'dict none']) expect(names.has(`extract · ${a}`), a).toBe(true)
    // Every endpoint is reached by some case, and each class makes at most one call (ruling (e)).
    expect(new Set(CASES.flatMap(c => c.calls.map(x => x.endpoint)))).toEqual(new Set(Object.values(DESCRIBE_ENDPOINTS)))
    expect(CASES.every(c => c.calls.length <= 1)).toBe(true)
    expect(CASES.length).toBeGreaterThanOrEqual(60)
  })
})

describe('every fixture case: what Python sends and returns', () => {
  const refused: string[] = []
  const wholeFloat: string[] = []

  it.each(CASES.map(c => [c.name, c] as const))('%s — the request and the value', async (_n, c) => {
    const want = expectedRefusal(c)
    expect(describeRequestProblem(c.class_type, c.widgets)?.message ?? null).toBe(want)
    if (want) {
      refused.push(c.name)
      await expect(planOf(c)).rejects.toThrow(want)
      expect(requestProblems(withPicture(c), { runner: true }).map(p => p.message)).toEqual([want])
      // Python raises "video_url is required." (no call) on the blank one, and sends the spaces.
      expect(c.calls.length).toBe(c.widgets.video_url === '' ? 0 : 1)
      return
    }
    expect(c.error).toBeUndefined()
    expect(paidNoCall(c.class_type, c.widgets)).toBe(false)
    const plan = await planOf(c) as Extract<NodePlan, { kind: 'provider' }>
    expect(plan.kind).toBe('provider')
    expect(plan.reuse).toBe('same-request')
    expect(plan.media).toBe('value')
    expect(plan.wait).toBe(c.class_type === 'DescribeVideoNode' ? 'video' : undefined)
    const py = c.calls[0]!
    expect({ provider: plan.provider, endpoint: plan.endpoint, payload: asPython(plan.payload) }).toEqual({ provider: py.provider, endpoint: py.endpoint, payload: py.payload })
    const pw = pythonWire(c, py.payload_json!, plan.payload)
    if (pw !== py.payload_json) wholeFloat.push(c.name)
    expect(wireText(asPython(plan.payload))).toBe(pw)
    expect(checkPayload(schemaOf(plan.endpoint), plan.payload)).toEqual([])
    // The answer: Python's text (or JSON) byte for byte, and no ui.
    const { result, raw } = answerOf(c)
    const kind = c.class_type === 'FindObjectsNode' ? 'json' : 'text'
    expect(plan.valuesOf!(result, raw)).toEqual({ 0: { kind, text: (c.output as string[])[0] } })
    expect(plan.uiFor([], plan.valuesOf!(result, raw))).toBe(NO_UI)
    expect(c.ui).toBeNull()
  })

  it('the deviations are the brief\'s: Describe a video with no address (blank, or spaces)', () => {
    expect(refused.sort()).toEqual(['video · blank address', 'video · spaces address'])
  })

  it('whole confidences (0 and 1) are the only wire difference, and only Find objects sends one', () => {
    expect(wholeFloat.sort()).toEqual(['find · confidence 0.0', 'find · confidence 1.0'])
  })
})

describe('every fixture case through the engine (cards and describe on)', () => {
  const calling = CASES.filter(c => c.calls.length && !expectedRefusal(c))

  it.each(calling.map(c => [c.name, c] as const))('%s — sent, handed on and charged', async (_n, c) => {
    const run = await runPaidCase(c, { families: ON })
    expect(run.status, run.error ?? '').toBe('done')
    const sent = normalizeSent(run.sent, c.pictures ?? [])
    expect(sent).toEqual([{ provider: 'replicate', endpoint: c.calls[0]!.endpoint, payload: c.calls[0]!.payload }])
    expect(wireText(sent[0]!.payload)).toBe(pythonWire(c, c.calls[0]!.payload_json!, run.sent[0]!.payload))
    const kind = c.class_type === 'FindObjectsNode' ? 'json' : 'text'
    expect(run.values).toEqual({ 0: { kind, text: (c.output as string[])[0] } })
    expect(run.files).toEqual([])
    // Charged the node's price: per call, or (Describe a video) the hold, as no answer here reports tokens.
    const hold = priceNode(c.class_type, withPicture(c).n!.inputs)
    if ('refused' in hold) throw new Error(hold.refused)
    expect(run.credits).toBe(hold.credits)
  })

  it('the pictures are handed off as the linked file (Python\'s first frame)', async () => {
    const c = CASES.find(x => x.name === 'describe · default')!
    const run = await runPaidCase(c, { families: ON })
    expect(run.sent[0]!.payload.image).toBe(IMAGE_URL)
  })
})

describe('the answers', () => {
  const out = (text: string) => parsePyJson(text)
  it('a dict where Python prints its repr fails the node plainly (R3.3\'s ruling, extended to top-level dicts: fix round 1)', async () => {
    const describe = await planOf(CASES.find(c => c.name === 'describe · default')!) as Extract<NodePlan, { kind: 'provider' }>
    const extract = await planOf(CASES.find(c => c.name === 'extract · dict text')!) as Extract<NodePlan, { kind: 'provider' }>
    // Python: "{'a': 1}", "a\n{'b': 1}" (repr); the runner refuses to guess a repr.
    expect(() => describe.valuesOf!(null, '{"output": {"a": 1}}')).toThrow(PY_STR_UNREADABLE)
    expect(() => describe.valuesOf!(null, '{"output": ["a", {"b": 1}]}')).toThrow(PY_STR_UNREADABLE)
    expect(() => extract.valuesOf!(null, '{"output": ["a", {"b": 1}]}')).toThrow(PY_STR_UNREADABLE)
    expect(() => extract.valuesOf!(null, '{"output": {"text": {"b": 1}}}')).toThrow(PY_STR_UNREADABLE)
    // Find objects dumps any JSON: a dict is its answer.
    const find = await planOf(CASES.find(c => c.name === 'answer · find · list')!) as Extract<NodePlan, { kind: 'provider' }>
    expect(find.valuesOf!(null, '{"output": {"a": 1}}')).toEqual({ 0: { kind: 'json', text: '{"a": 1}' } })
  })
  it('Extract text: a list joined by lines, a dict\'s text / markdown / transcription, a string, else ""', () => {
    expect(extractTextOf(out('["a", 1, 2.0, null, true]'))).toBe('a\n1\n2.0\nNone\nTrue')
    expect(extractTextOf(out('{"text": "", "markdown": [], "transcription": 0.0}'))).toBe('')
    expect(extractTextOf(out('{"transcription": " t "}'))).toBe('t')
    expect(extractTextOf(out('3'))).toBe('')
    expect(() => extractTextOf(out('[[1]]'))).toThrow()
  })
  it('Find objects: a string as it is; anything else json.dumps of what json.loads read', () => {
    expect(findObjectsJson(null, '{"output": "  as is "}')).toBe('  as is ')
    expect(findObjectsJson(null, '{"output": {"x": 1.0, "y": 1e-3, "z": "\\u00e9"}}')).toBe('{"x": 1.0, "y": 0.001, "z": "\\u00e9"}')
    expect(findObjectsJson({ output: [1, 2.5] }, null)).toBe('[1, 2.5]')
    expect(findObjectsJson({}, '{"status": "succeeded"}')).toBe('null')
  })
})

describe('prices (rulings (a), (c), (s))', () => {
  const inputs = (c: DescribeClass): Record<string, unknown> => ({
    DescribeImageNode: { model: 'Moondream 2', image: ['p', 0], prompt: 'Describe this image in detail.' },
    DescribeImageRemoteNode: { image: ['p', 0], prompt: 'Describe this image in detail.' },
    DescribeVideoNode: { model: 'Gemini 2.5 Flash', video_url: 'https://example.test/a.mp4', prompt: 'Describe this video in detail.' },
    ExtractTextNode: { model: 'ByteDance Dolphin', image: ['p', 0] },
    FindObjectsNode: { model: 'YOLO-World', image: ['p', 0], query: 'person, car, dog', confidence: 0.25 },
  })[c]

  it('one card per endpoint, read from its page; moondream2 keeps its edit card', () => {
    expect(PAID_RATES['google/gemini-2.5-flash']).toEqual({
      unit: 'per_token', inputPerMillion: 0.3, outputPerMillion: 2.5,
      service: 'replicate', source: 'https://replicate.com/google/gemini-2.5-flash', read: '2026-09-27', confidence: 'verified',
    })
    // LC1 (2026-10-01): Dolphin kept and verified; YOLO-World and Moondream 2 raised to $0.0025 (money-rule breaks #3, #4), verified.
    expect(PAID_RATES['bytedance/dolphin']).toMatchObject({ unit: 'gpu_ceiling', usd: 0.006, confidence: 'verified', read: '2026-10-01', source: 'https://replicate.com/bytedance/dolphin' })
    expect(PAID_RATES['zsxkib/yolo-world']).toMatchObject({ unit: 'gpu_ceiling', usd: 0.0025, confidence: 'verified', read: '2026-10-01', source: 'https://replicate.com/zsxkib/yolo-world' })
    expect(PAID_RATES['lucataco/moondream2']).toBeUndefined()
    expect(EDIT_RATES['lucataco/moondream2']).toMatchObject({ unit: 'per_image', usd: 0.0025, read: '2026-10-01', confidence: 'verified' })
    for (const slug of ['google/gemini-2.5-flash', 'bytedance/dolphin', 'zsxkib/yolo-world']) expect(otherCardFor(slug), slug).toBeNull()
  })

  it('the classes are priced by their calls, have no flat row, and the price book moved on', () => {
    for (const c of DESCRIBE_CLASSES) {
      expect(PAID_NODE_CLASSES).toContain(c)
      expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, c), c).toBe(false)
    }
    expect(PRICE_BOOK_VERSION).toBe('lineup-flux-3-1k')
  })

  it('per call: Describe an image 1, Extract text 2, Find objects 1, on both paths', () => {
    const want: Record<string, { usd: number; credits: number }> = {
      DescribeImageNode: { usd: 0.0025, credits: 1 }, DescribeImageRemoteNode: { usd: 0.0025, credits: 1 },
      ExtractTextNode: { usd: 0.006, credits: 2 }, FindObjectsNode: { usd: 0.0025, credits: 1 },
    }
    for (const [c, p] of Object.entries(want)) {
      expect(priceNode(c, inputs(c as DescribeClass)), c).toEqual(p)
      expect(priceGraph({ 1: { class_type: c, inputs: inputs(c as DescribeClass) } }).nodes!['1'], c).toBe(p.credits)
    }
  })

  it('Describe a video: the prompt, the video at 300 tokens a second and Gemini\'s longest answer; unmeasured, 45 minutes', () => {
    const i = inputs('DescribeVideoNode')
    const prompt = utf8Bytes('Describe this video in detail.')
    const usdAt = (seconds: number) => (prompt + Math.ceil(seconds * DESCRIBE_VIDEO_TOKENS_PER_SECOND)) * 0.3 / 1e6 + DESCRIBE_VIDEO_MAX_ANSWER_TOKENS * 2.5 / 1e6
    const ceiling = priceNode('DescribeVideoNode', i) as { usd: number; credits: number }
    expect(ceiling.usd).toBeCloseTo(usdAt(DESCRIBE_VIDEO_MAX_SECONDS), 8)
    expect(ceiling.credits).toBe(creditsForUsd(usdAt(DESCRIBE_VIDEO_MAX_SECONDS)))
    expect(ceiling.credits).toBe(62)
    const three = priceNode('DescribeVideoNode', i, { inputSeconds: { video: 3 } }) as { usd: number; credits: number }
    expect(three.usd).toBeCloseTo(usdAt(3), 8)
    expect(three.credits).toBe(25)
    // The ComfyUI path can't see the video's length or read the usage: the ceiling.
    expect(priceGraph({ 1: { class_type: 'DescribeVideoNode', inputs: i } }).nodes!['1']).toBe(62)
    // A wired prompt counts at the moderation cap.
    const wired = paidCalls('DescribeVideoNode', { ...i, prompt: ['t', 0] }, { inputSeconds: { video: 3 } }) as { steps: { call: { inputTokens: number } }[] }
    expect(wired.steps[0]!.call.inputTokens).toBe(32_768 + 900)
  })

  it('Describe a video\'s charge: the reported tokens through the card, never above the hold; none reported, the hold', async () => {
    const i = inputs('DescribeVideoNode')
    const plan = await planNode({
      prompt: { n: { class_type: 'DescribeVideoNode', inputs: i } }, nodeId: 'n', gateOpen: false, filesFrom: () => [],
      toUrl: async () => { throw new Error('no files') }, measured: { video: 3 }, priceInputs: i,
    }) as Extract<NodePlan, { kind: 'provider' }>
    const hold = (priceNode('DescribeVideoNode', i, { inputSeconds: { video: 3 } }) as { credits: number }).credits
    const small = plan.chargeOf!({ metrics: { input_token_count: 1000, output_token_count: 200 } })
    expect(small).toBe(creditsForUsd(1000 * 0.3e-6 + 200 * 2.5e-6))
    expect(plan.chargeOf!({ metrics: { input_token_count: 5e6, output_token_count: 5e5 } })).toBe(hold)
    expect(plan.chargeOf!({ metrics: { predict_time: 2 } })).toBeNull()
    // The per-call classes have no chargeOf: the charge is the hold.
    const find = await planOf(CASES.find(c => c.class_type === 'FindObjectsNode')!) as Extract<NodePlan, { kind: 'provider' }>
    expect(find.chargeOf).toBeUndefined()
  })

  it('a wired prompt or query is priced as a call, never free', () => {
    for (const c of DESCRIBE_CLASSES) expect(paidNoCall(c, { ...inputs(c), prompt: ['t', 0], query: ['t', 0] }), c).toBe(false)
    const p: ApiPrompt = { t: { class_type: 'Text', inputs: { text: 'x' } }, n: { class_type: 'FindObjectsNode', inputs: { ...inputs('FindObjectsNode'), query: ['t', 0] } } }
    expect(stageEstimate(p, ['n', 't'], false, ON)).toBe(1)
  })
})

describe('moderation', () => {
  it('lists the prompt and the query (Extract text sends no text)', () => {
    for (const c of DESCRIBE_CLASSES) {
      expect(PAID_TEXT_INPUTS[c] ?? [], c).toEqual(c === 'ExtractTextNode' ? [] : c === 'FindObjectsNode' ? ['query'] : ['prompt'])
    }
    expect(extraPromptTexts({ n: { class_type: 'FindObjectsNode', inputs: { query: 'a knife', confidence: 0.25 } } })).toEqual(['a knife'])
  })

  it('a hosted Describe an image moderates its prompt at the start; a flagged one is refused before the hold', async () => {
    const c = CASES.find(x => x.name === 'describe · default')!
    const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
    const k = makeKit({ hosted: true, moderate, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'image.png'), Buffer.from(c.picture_files!.image!, 'base64'))
    const p = withPicture({ ...c, widgets: { ...c.widgets, prompt: 'a forbidden thing' } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow()
    expect(moderate.mock.calls.map(x => x[0])).toContain('a forbidden thing')
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })
})

describe('Describe a video\'s video (rulings (r), (s))', () => {
  const node = (video_url: string, prompt = 'What happens?') => ({ class_type: 'DescribeVideoNode', inputs: { model: 'Gemini 2.5 Flash', video_url, prompt } })
  const answer = '{"id": "p", "status": "succeeded", "output": ["A ", "dog runs."], "metrics": {"input_token_count": 950, "output_token_count": 40}}'

  it('the ComfyUI path (the /prompt gate, hosted and local): only an https address; the badge says "up to" (fix round 1)', async () => {
    const { upstreamInputSeconds } = await import('~/lib/costEstimate')
    const { blockedPromptRefusal } = await import('~~/server/utils/blockedModels')
    for (const url of ['/view?filename=clip.mp4&type=input', 'http://example.test/a.mp4', 'data:video/mp4;base64,AAAA', ' https://example.test/a.mp4', 'ftp://x/a.mp4']) {
      expect(requestProblems({ n: node(url) }).map(p => p.message), url).toEqual([DESCRIBE_VIDEO_NEEDS_WEB_ADDRESS])
      expect(blockedPromptRefusal({ n: node(url) })?.error.message, url).toBe(DESCRIBE_VIDEO_NEEDS_WEB_ADDRESS)
    }
    for (const url of ['https://example.test/a.mp4', 'HTTPS://example.test/a.mp4']) expect(requestProblems({ n: node(url) }), url).toEqual([])
    // A blank address is left to Python (it raises before any call); a wired one can't be judged.
    expect(requestProblems({ n: node('') })).toEqual([])
    expect(requestProblems({ n: { class_type: 'DescribeVideoNode', inputs: { ...node('').inputs, video_url: ['t', 0] } } })).toEqual([])
    // The runner takes an upload (hosted: only an upload), so its own rules apply there.
    expect(requestProblems({ n: node('/view?filename=clip.mp4&type=input') }, { runner: true })).toEqual([])
    // The message names no identifiers.
    expect(DESCRIBE_VIDEO_NEEDS_WEB_ADDRESS).not.toMatch(/video_url|Node|\/view/)
    const canvas = { id: '5', data: { nodeType: 'DescribeVideoNode', widgetDefs: [], widgetsValues: [], inputs: [] } }
    expect(upstreamInputSeconds(canvas, [canvas], [])).toEqual({ seconds: {}, upTo: true })
  })

  it('the media node dispatch: an uploaded file is measured; an address is not', () => {
    const p: ApiPrompt = { 1: node('/view?filename=clip.mp4&type=input'), 2: node('https://example.test/a.mp4') }
    expect(mediaNodeKind(p['1'])).toBe('describe-video')
    expect(nodeMediaFiles(p, '1')).toEqual([{ filename: 'clip.mp4', subfolder: '', type: 'input' }])
    expect(nodeMediaFiles(p, '2')).toEqual([])
    expect(nodeMediaChangedWords(p['1'])).toBe(DESCRIBE_VIDEO_CHANGED)
  })

  it('hosted: an uploaded video is measured before the hold, handed off, held and charged by its length', async () => {
    const replicate = createFakeReplicate({ bodyText: () => answer })
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'clip.mp4'), await mp4(3))
    const p: ApiPrompt = { n: node('/view?filename=clip.mp4&type=input') }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect(ofType(k.seen, 'execution_error')).toEqual([])
    const sent = replicate.submitted()
    expect(sent.map(r => [r.endpoint, r.payload])).toEqual([['google/gemini-2.5-flash', { prompt: 'What happens?', videos: ['https://fal.storage/clip.mp4'] }]])
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.values).toEqual({ 0: { kind: 'text', text: 'A dog runs.' } })
    const hold = (priceNode('DescribeVideoNode', p.n!.inputs, { inputSeconds: { video: 3 } }) as { credits: number }).credits
    const used = creditsForUsd(950 * 0.3e-6 + 40 * 2.5e-6)
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[hold, used]])
  })

  it('hosted: Gemini\'s own metric names (token_input_count / token_output_count only, as the live check got) are charged by tokens, not the hold (LC1 B1)', async () => {
    // The live check's prediction: 891 in, 508 out, under the `token_*` names alone.
    const gemini = '{"id": "p", "status": "succeeded", "output": ["A ", "dog runs."], "metrics": {"predict_time": 3.2, "token_input_count": 891, "token_output_count": 508}}'
    const replicate = createFakeReplicate({ bodyText: () => gemini })
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'clip.mp4'), await mp4(3))
    const p: ApiPrompt = { n: node('/view?filename=clip.mp4&type=input') }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    expect(ofType(k.seen, 'execution_error')).toEqual([])
    const hold = (priceNode('DescribeVideoNode', p.n!.inputs, { inputSeconds: { video: 3 } }) as { credits: number }).credits
    const used = creditsForUsd(891 * 0.3e-6 + 508 * 2.5e-6)
    expect(used).toBe(1)
    expect(hold).toBeGreaterThan(20)
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[hold, used]])
    expect((await k.store.get(runId))!.takes[0]!.nodes.n!.credits).toBe(used)
  })

  it('refused before the hold, hosted: a web address, no address, too long, not a video, not the caller\'s own', async () => {
    const cases: [string, Buffer | null, string, boolean?][] = [
      ['https://example.test/a.mp4', null, DESCRIBE_VIDEO_UPLOAD_ONLY],
      ['http://example.test/a.mp4', null, DESCRIBE_VIDEO_UPLOAD_ONLY],
      ['data:video/mp4;base64,AAAA', null, DESCRIBE_VIDEO_UPLOAD_ONLY],
      ['', null, DESCRIBE_VIDEO_NEEDS_LINK],
      ['/view?filename=clip.mp4&type=input', await mp4(DESCRIBE_VIDEO_MAX_SECONDS + 1, 64, 64, 1), DESCRIBE_VIDEO_TOO_LONG],
      ['/view?filename=clip.mp4&type=input', Buffer.from('RIFF0000WAVEfmt '), DESCRIBE_VIDEO_RULE.words.wrongFormat],
      ['/view?filename=clip.mp4&type=input', await mp4(2), 'This workflow uses a file that isn’t one of yours', true],
    ]
    for (const [url, file, message, foreign] of cases) {
      const k = makeKit({ hosted: true, deps: { families: () => ON } })
      if (file) writeFileSync(join(k.root, 'input', 'clip.mp4'), file)
      if (foreign) k.deps.ownership.ownsInput = async () => false
      await expect(k.engine.startRun({ userId: k.userId, takes: [{ n: node(url) }], ...START }), url).rejects.toThrow(message)
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
      expect(k.upload).not.toHaveBeenCalled()
    }
  })

  it('local: an address is sent as typed (as Python) and held at the ceiling; an uploaded file is handed off', async () => {
    const replicate = createFakeReplicate({ bodyText: () => answer })
    const k = makeKit({ replicate, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'clip.mp4'), await mp4(2))
    const p: ApiPrompt = { a: node('http://example.test/a.mp4'), b: node('/view?filename=clip.mp4&type=input', 'Other') }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const byPrompt = Object.fromEntries(replicate.submitted().map(r => [r.payload.prompt, r.payload.videos]))
    expect(byPrompt).toEqual({ 'What happens?': ['http://example.test/a.mp4'], 'Other': ['https://fal.storage/clip.mp4'] })
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    expect(nodes.a!.values).toEqual({ 0: { kind: 'text', text: 'A dog runs.' } })
  })
})

describe('chains through the cards', () => {
  it('Find objects → a Text card shows Python\'s exact JSON', async () => {
    const c = CASES.find(x => x.name === 'answer · find · dict with floats')!
    const replicate = createFakeReplicate({ bodyText: () => (c.answers[0] as { __body__: string }).__body__ })
    const k = makeKit({ replicate, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'image.png'), Buffer.from(c.picture_files!.image!, 'base64'))
    const p: ApiPrompt = { ...withPicture(c), t: { class_type: 'Text', inputs: { text: '', source: ['n', 0] } } }
    expect(isRunnerEligible(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    const json = (c.output as string[])[0]!
    expect(json).toContain('"x": 12.0, "y": 0.001, "width": 100.0')
    expect(nodes.n!.values).toEqual({ 0: { kind: 'json', text: json } })
    expect(nodes.t!.values).toEqual({ 0: { kind: 'text', text: json } })
    const executed = k.seen.filter(m => m.type === 'executed').map(m => (m as any).data)
    expect(executed.find((d: any) => d.node === 't')?.output).toEqual({ text: [json] })
    expect(executed.find((d: any) => d.node === 'n')).toBeUndefined()
  })

  it('a picture from Generate an image is handed off as the RGBA tensor Python downloads (R3.H2), under its own name', async () => {
    const replicate = createFakeReplicate({ bodyText: ({ model }) => (model === 'lucataco/moondream2' ? '{"id": "p", "status": "succeeded", "output": "A cat."}' : JSON.stringify({ id: 'q', status: 'succeeded', output: ['https://replicate.delivery/gen.png'] })) })
    // A real picture (R3.H2: a provider's answer is decoded as Python's bytesio_to_image_tensor before it is handed on).
    const download = async () => ({ bytes: rgbPng1x1(200, 100, 50), contentType: 'image/png' })
    const k = makeKit({ replicate, deps: { families: () => new Set<RunnerFamily>([...ON, 'replicate-image']), download } })
    const p: ApiPrompt = {
      1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a cat', aspect_ratio: '1:1', seed: 3, model_options: '{}' } },
      n: { class_type: 'DescribeImageNode', inputs: { model: 'Moondream 2', prompt: 'What is it?', image: ['1', 0] } },
    }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    expect(nodes.n!.status, nodes.n!.error ?? '').toBe('done')
    const made = nodes['1']!.outputs[0]!
    const describeCall = replicate.submitted().find(r => r.endpoint === 'lucataco/moondream2')!
    expect(describeCall.payload).toEqual({ image: `https://fal.storage/${made.filename}`, prompt: 'What is it?' })
    // PIL's convert("RGBA") of the answer: its RGB and an opaque alpha.
    const [[sentBytes]] = k.upload.mock.calls as unknown as [Uint8Array, string][]
    const { data, info } = await sharp(sentBytes).raw().toBuffer({ resolveWithObject: true })
    expect([info.width, info.height, info.channels, [...data]]).toEqual([1, 1, 4, [200, 100, 50, 255]])
    expect(nodes.n!.values).toEqual({ 0: { kind: 'text', text: 'A cat.' } })
  })

  it('a byte-identical request gives back the last answer, free (ruling (d))', async () => {
    const c = CASES.find(x => x.name === 'extract · dict text')!
    const replicate = createFakeReplicate({ bodyText: () => (c.answers[0] as { __body__: string }).__body__ })
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'image.png'), Buffer.from(c.picture_files!.image!, 'base64'))
    const once = async () => {
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [withPicture(c)], ...START })
      await k.engine.settled(runId)
      return (await k.store.get(runId))!.takes[0]!.nodes.n!
    }
    const first = await once()
    expect(first.credits).toBe(2)
    const again = await once()
    expect(again.reused).toBe(true)
    expect(again.values).toEqual(first.values)
    expect(replicate.client.submit).toHaveBeenCalledTimes(1)
  })
})

describe('with describe off (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but describe', RUNNER_FAMILIES.filter(f => f !== 'describe')],
  ]
  const isDescribe = (ct: string) => (DESCRIBE_CLASSES as readonly string[]).includes(ct)
  /** The same prompt as before R3.4: the classes had no rule row and no output kind (renamed to one that has none). */
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, isDescribe(n.class_type) ? { ...n, class_type: `${n.class_type}Before` } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (!isDescribe(p[id]!.class_type)) {
          expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
        }
      }
    }
  }

  it('each class is left to the engine, and named by the needs-the-engine list', () => {
    for (const c of DESCRIBE_CLASSES) {
      const k = CASES.find(x => x.class_type === c && x.calls.length && !expectedRefusal(x))!
      const p = withPicture(k)
      expect(runnerTakesNode(p, 'n', new Set(['cards'])), c).toBe(false)
      expect(runnerTakesNode(p, 'n', ON), c).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n'])
      expect(RUNNER_OUTPUT_CLASSES.has(c)).toBe(true)
      expect(OUTPUT_KINDS[c]).toEqual({ 0: c === 'FindObjectsNode' ? 'json' : 'text' })
      expect(outputKindsFor(new Set(['cards']))[c]).toBeUndefined()
      expect(outputKindsFor(ON)[c]).toEqual(OUTPUT_KINDS[c])
      expect(RUNNER_NODE_RULES[c]!.family).toBe('describe')
      expect(RUNNER_ROUTES[c]).toBeDefined()
    }
  })

  it('over synthetic chains: a Text card into the prompt or query, the value into a Text card and a generator', () => {
    for (const c of DESCRIBE_CLASSES) {
      const k = CASES.find(x => x.class_type === c && x.calls.length && !expectedRefusal(x))!
      const p = withPicture(k)
      sameAsBefore(p, `${c} alone`)
      const text = PAID_TEXT_INPUTS[c]?.[0]
      if (text) sameAsBefore({ ...p, t: { class_type: 'Text', inputs: { text: 'hi' } }, n: { ...p.n!, inputs: { ...p.n!.inputs, [text]: ['t', 0] } } }, `Text → ${c}`)
      sameAsBefore({ ...p, t: { class_type: 'Text', inputs: { text: '', source: ['n', 0] } } }, `${c} → Text`)
      sameAsBefore({
        ...p,
        g: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: '', prompt_in: ['n', 0], aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      }, `${c} → generate`)
    }
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (with Find objects spliced in beside each)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/assets/nodeCatalog.json.gz'))).toString('utf8'))
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
          d_find: { class_type: 'FindObjectsNode', inputs: { model: 'YOLO-World', image: ['d_img', 0], query: 'person', confidence: 0.25 } },
        }, `${uuid} + Find objects`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`describe families-off invariant: ${graphs} saved graphs`)
  }, 600_000)
})
