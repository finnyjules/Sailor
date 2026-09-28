/**
 * R3.8: music and speech (family `audio-gen`) — Generate music (MusicGen) and
 * Generate speech (MiniMax Speech-02 HD), and their hidden twins — against
 * what their real Python sends and returns (fixtures/runner-paid-audio-gen.json,
 * scripts/runner_paid_fixtures.py --group audio-gen), priced on both paths
 * from Replicate's pages: speech per thousand characters of its text, music
 * by the seconds it asks for (a GPU-time estimate). The Audio card shows the
 * node's own file (ruling (t)); Lip-sync on sync-3 reads it through the card;
 * hosted takes the 17 preset voices only (ruling (j)).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny'
import { createFakeReplicate, makeKit, ofType, until } from './__runner__/kit'
import { normalizeSent, runPaidCase, wireText, type PaidCase } from './__runner__/paidParity'
import { checkPayload, type ProviderSchemaFixture } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import {
  AUDIO_CARD_AUDIO_GEN_RULE, PROVIDER_TYPES, RUNNER_NODE_RULES, SWITCHED_CLASSES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed,
} from '#shared/runner/eligibility'
import { needsEngineReasons, nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import {
  AUDIO_GEN_CLASSES, MINIMAX_EMOTIONS, MINIMAX_LANGUAGES, MINIMAX_SPEECH_SLUG, MINIMAX_VOICES, MUSICGEN_SLUG, MUSIC_MODEL_VERSIONS,
  SPEECH_MAX_CHARS, SPEECH_NEEDS_TEXT, SPEECH_TOO_LONG, SPEECH_VOICE_NOT_OFFERED, speechChars, type AudioGenClass,
} from '#shared/runner/audioGen'
import { PAID_RATES, otherCardFor, paidCallUsd } from '#shared/pricing/paidRates'
import { PAID_NODE_CLASSES, paidNoCall } from '#shared/pricing/paidSettings'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { LIPSYNC_MAX_SECONDS } from '#shared/pricing/clipSettings'
import { GRAPH_NODE_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { PAID_TEXT_INPUTS, extraPromptTexts, stageEstimate } from '~~/server/runner/metering'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { musicGenInput, speechInput } from '~~/server/runner/generators/audioGen'
import { firstOutputUrl } from '~~/server/runner/generators/repair'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { SYNC_3_APP, sync3NodeProblem, sync3Sources } from '~~/server/runner/generators/sync3'
import { hostedRequestProblems, requestProblems } from '~~/server/runner/requestRules'
import { meterGraphSubmit } from '~~/server/utils/meterGraphRun'
import { ANSWER_NOT_SOUND } from '~~/server/runner/answerDownload'
import { NO_OUTPUTS_MESSAGE, pruneInvalidOutputs, runnerTakesWorkflow } from '#shared/runner/validate'
import { nodeMediaCheck } from '~~/server/runner/nodeMedia'
import { createFakeFal } from './__runner__/kit'

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-audio-gen.json'), 'utf8')) as {
  cases: (PaidCase & { text_len?: number })[]
  text_lengths: { text: string; len: number }[]
}
const CASES = FIXTURE.cases
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'audio-gen'])
const MUSIC_URL = 'https://r.test/music/out.wav'
const SPEECH_URL = 'https://r.test/speech/out.wav'

/** The FLOAT settings Python writes as `1.0` where the runner's JSON writes `1`: the same JSON number (R3.3 ruling 1). */
const FLOAT_KEYS = ['temperature', 'top_p', 'speed', 'volume']
function pythonWire(payloadJson: string): string {
  return payloadJson.replace(new RegExp(`"(${FLOAT_KEYS.join('|')})": (-?\\d+)\\.0([,}])`, 'g'), '"$1": $2$3')
}

/** A 16-bit mono PCM WAV of `seconds`. */
function wav(seconds: number, rate = 8000): Buffer {
  const n = Math.round(seconds * rate)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  return b
}

/** A picture-only MP4 whose video track lasts `seconds` (10 fps), muxed without an encoder (as runner-sync-3's). */
async function mp4(seconds: number, width = 320, height = 240): Promise<Buffer> {
  const out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const src = new EncodedVideoPacketSource('avc')
  out.addVideoTrack(src, { frameRate: 10 })
  await out.start()
  const description = new Uint8Array([1, 0x42, 0xC0, 0x1E, 0xFF, 0xE1, 0, 0x0A, 0x67, 0x42, 0xC0, 0x1E, 0xDA, 0x02, 0x80, 0xBF, 0xE5, 0x84, 1, 0, 4, 0x68, 0xCE, 0x3C, 0x80])
  const frames = Math.round(seconds * 10)
  for (let i = 0; i < frames; i++) {
    await src.add(new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x65]), i === 0 ? 'key' : 'delta', i / 10, 0.1),
      i === 0 ? { decoderConfig: { codec: 'avc1.42c01e', codedWidth: width, codedHeight: height, description } } : undefined)
  }
  await out.finalize()
  return Buffer.from((out.target as BufferTarget).buffer!)
}

const card = (from: string, extra: Record<string, unknown> = {}) =>
  ({ class_type: 'Audio', inputs: { audio: '', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0', source: [from, 0], ...extra } })
const sample = (ct: AudioGenClass) => CASES.find(c => c.class_type === ct && c.name.endsWith('defaults'))
  ?? CASES.find(c => c.class_type === ct)!
const node = (c: PaidCase, inputs: Record<string, unknown> = {}) => ({ class_type: c.class_type, inputs: { ...c.widgets, ...inputs } })

async function planOf(c: PaidCase): Promise<Extract<NodePlan, { kind: 'provider' }>> {
  return await planNode({
    prompt: { n: node(c) }, nodeId: 'n', gateOpen: false, filesFrom: () => [], toUrl: async f => `https://fal.storage/${f.filename}`,
  }) as Extract<NodePlan, { kind: 'provider' }>
}

// ── The published inputs (each model page's schema, read 2026-09-27), until the controller saves them ──

const publishedInput = (properties: Record<string, unknown>, required: string[]): ProviderSchemaFixture => ({
  endpoint: '', fetchedAt: '2026-09-27', input: { type: 'object', required, properties }, output: {}, components: { schemas: {} },
})
const MUSICGEN_SCHEMA = publishedInput({
  seed: { type: 'integer' }, top_k: { type: 'integer', default: 250 }, top_p: { type: 'number', default: 0 }, prompt: { type: 'string' },
  duration: { type: 'integer', default: 8 }, input_audio: { type: 'string', format: 'uri' }, temperature: { type: 'number', default: 1 },
  continuation: { type: 'boolean', default: false },
  model_version: { enum: ['stereo-melody-large', 'stereo-large', 'melody-large', 'large'], type: 'string', default: 'stereo-melody-large' },
  output_format: { enum: ['wav', 'mp3'], type: 'string', default: 'wav' },
  continuation_end: { type: 'integer', minimum: 0 }, continuation_start: { type: 'integer', default: 0, minimum: 0 },
  multi_band_diffusion: { type: 'boolean', default: false },
  normalization_strategy: { enum: ['loudness', 'clip', 'peak', 'rms'], type: 'string', default: 'loudness' },
  classifier_free_guidance: { type: 'integer', default: 3 },
}, [])
const LANGS = ['None', 'Automatic', 'Chinese', 'Chinese,Yue', 'English', 'Arabic', 'Russian', 'Spanish', 'French', 'Portuguese', 'German', 'Turkish', 'Dutch',
  'Ukrainian', 'Vietnamese', 'Indonesian', 'Japanese', 'Italian', 'Korean', 'Thai', 'Polish', 'Romanian', 'Greek', 'Czech', 'Finnish', 'Hindi']
/** The page shows two input schemas (an older version's, max 5,000 characters, and the newer 10,000 one): Python's payloads fit both. */
const SPEECH_SCHEMAS: ProviderSchemaFixture[] = [
  publishedInput({
    text: { type: 'string' }, pitch: { type: 'integer', default: 0, maximum: 12, minimum: -12 }, speed: { type: 'number', default: 1, maximum: 2, minimum: 0.5 },
    volume: { type: 'number', default: 1, maximum: 10, minimum: 0 }, bitrate: { enum: [32000, 64000, 128000, 256000], type: 'integer', default: 128000 },
    channel: { enum: ['mono', 'stereo'], type: 'string', default: 'mono' },
    emotion: { enum: ['auto', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'neutral'], type: 'string', default: 'auto' },
    english_normalization: { type: 'boolean', default: false },
    language_boost: { enum: [...LANGS, 'Cantonese', 'Bulgarian', 'Danish', 'Hebrew', 'Malay', 'Persian', 'Slovak', 'Swedish', 'Croatian', 'Filipino', 'Hungarian', 'Norwegian', 'Slovenian', 'Catalan', 'Nynorsk', 'Tamil', 'Afrikaans'], type: 'string', default: 'None' },
    sample_rate: { enum: [8000, 16000, 22050, 24000, 32000, 44100], type: 'integer', default: 32000 },
    voice_id: { type: 'string', default: 'English_Wiselady' }, audio_format: { enum: ['mp3', 'wav', 'flac', 'pcm'], type: 'string', default: 'mp3' },
    subtitle_enable: { type: 'boolean', default: false },
  }, ['text']),
  publishedInput({
    text: { type: 'string' }, pitch: { type: 'integer', default: 0, maximum: 12, minimum: -12 }, speed: { type: 'number', default: 1, maximum: 2, minimum: 0.5 },
    volume: { type: 'number', default: 1, maximum: 10, minimum: 0 }, bitrate: { enum: [32000, 64000, 128000, 256000], type: 'integer', default: 128000 },
    channel: { enum: ['mono', 'stereo'], type: 'string', default: 'mono' },
    emotion: { enum: ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'], type: 'string', default: 'neutral' },
    english_normalization: { type: 'boolean', default: false },
    language_boost: { enum: LANGS, type: 'string', default: 'None' },
    sample_rate: { enum: [8000, 16000, 22050, 24000, 32000, 44100], type: 'integer', default: 32000 },
    voice_id: { type: 'string', default: 'Wise_Woman' },
  }, ['text']),
]

describe('the fixture', () => {
  it('covers every class, version, length, top_p, seed, emotion, language, bound, a non-ASCII text and a cloned voice', () => {
    const names = new Set(CASES.map(c => c.name))
    expect(new Set(CASES.map(c => c.class_type))).toEqual(new Set(AUDIO_GEN_CLASSES))
    for (const v of MUSIC_MODEL_VERSIONS) for (const s of [1, 30]) expect(names.has(`music · ${v} ${s} s`), `${v} ${s}`).toBe(true)
    for (const p of ['0.0', '0.5']) for (const s of [0, 7]) expect(names.has(`music · top_p ${p} seed ${s}`)).toBe(true)
    for (const e of MINIMAX_EMOTIONS) expect(names.has(`speech · emotion ${e}`), e).toBe(true)
    for (const l of MINIMAX_LANGUAGES) expect(names.has(`speech · language ${l}`), l).toBe(true)
    for (const n of ['speed 0.5', 'speed 2.0', 'pitch -12', 'pitch 12', 'volume 0.1', 'volume 10.0', 'non-ASCII text', 'cloned voice']) {
      expect(names.has(`speech · ${n}`), n).toBe(true)
    }
    expect(new Set(CASES.flatMap(c => c.calls.map(x => x.endpoint)))).toEqual(new Set([MUSICGEN_SLUG, MINIMAX_SPEECH_SLUG]))
    expect(CASES.every(c => c.calls.length === 1 && !c.error)).toBe(true)
    expect(CASES.length).toBeGreaterThanOrEqual(55)
  })

  it('the lists are Python\'s', () => {
    expect(MINIMAX_VOICES.length).toBe(17)
    const python = readFileSync(resolve(__dirname, '../../../comfy_api_nodes/nodes_replicate.py'), 'utf8')
    for (const v of MINIMAX_VOICES) expect(python).toContain(`"${v}"`)
    expect(python).toContain(`_MINIMAX_EMOTIONS = [${MINIMAX_EMOTIONS.map(e => `"${e}"`).join(', ')}]`)
  })
})

describe('every fixture case: what Python sends and returns', () => {
  const wholeFloat: string[] = []

  it.each(CASES.map(c => [c.name, c] as const))('%s — the request and the sound', async (_n, c) => {
    expect(requestProblems({ n: node(c) }, { runner: true })).toEqual([])
    expect(paidNoCall(c.class_type, c.widgets)).toBe(false)
    const plan = await planOf(c)
    expect(plan.kind).toBe('provider')
    expect(plan.media).toBe('audio')
    expect(plan.take).toBe('first')
    expect(plan.backup).toBeUndefined()
    const py = c.calls[0]!
    expect({ provider: plan.provider, endpoint: plan.endpoint, payload: plan.payload }).toEqual({ provider: py.provider, endpoint: py.endpoint, payload: py.payload })
    const pw = pythonWire(py.payload_json!)
    if (pw !== py.payload_json) wholeFloat.push(c.name)
    expect(wireText(plan.payload)).toBe(pw)
    // The builders alone give the same.
    expect(c.class_type.includes('Speech') ? speechInput(c.widgets) : musicGenInput(c.widgets)).toEqual(py.payload)
    // Every payload fits the published schema (both of MiniMax's).
    for (const schema of plan.endpoint === MUSICGEN_SLUG ? [MUSICGEN_SCHEMA] : SPEECH_SCHEMAS) expect(checkPayload(schema, plan.payload)).toEqual([])
    // The sound: Python's `_first_output_url`; no ui (Python returns none).
    expect(plan.urlsOf!(c.answers[0])).toEqual([(c.output as { audio: string }[])[0]!.audio])
    expect(c.ui).toBeNull()
    expect(plan.uiFor([{ filename: 'x.wav', subfolder: '', type: 'output' }])).toBeNull()
    // Speech's characters are Python's len().
    if (c.text_len !== undefined) expect(speechChars(String(c.widgets.text))).toBe(c.text_len)
  })

  it('whole-number FLOAT settings are the only wire difference (R3.3 ruling 1)', () => {
    expect(wholeFloat.length).toBeGreaterThan(40)
  })

  it('an answer with no sound fails plainly (firstOutputUrl gives none)', () => {
    expect(firstOutputUrl({ output: [] })).toEqual([])
    expect(firstOutputUrl({ output: null })).toEqual([])
    expect(firstOutputUrl({ output: { url: MUSIC_URL } })).toEqual([])
  })
})

describe('Python\'s len(), the characters priced', () => {
  it.each(FIXTURE.text_lengths.map(t => [JSON.stringify(t.text).slice(0, 40), t] as const))('%s', (_n, t) => {
    expect(speechChars(t.text)).toBe(t.len)
  })
})

describe('every fixture case through the engine (cards and audio-gen on)', () => {
  it.each(CASES.map(c => [c.name, c] as const))('%s — sent, saved and charged', async (_n, c) => {
    const run = await runPaidCase(c, { families: ON })
    expect(run.status, run.error ?? '').toBe('done')
    expect(normalizeSent(run.sent)).toEqual([{ provider: 'replicate', endpoint: c.calls[0]!.endpoint, payload: c.calls[0]!.payload }])
    expect(wireText(normalizeSent(run.sent)[0]!.payload)).toBe(pythonWire(c.calls[0]!.payload_json!))
    expect(run.values).toBeUndefined()
    // The sound, saved with its header's extension.
    expect(run.files.length).toBe(1)
    expect(run.files[0]!.filename).toMatch(c.class_type.includes('Speech') ? /^speech.*\.wav$/ : /^music.*\.wav$/)
    const price = priceNode(c.class_type, c.widgets)
    if ('refused' in price) throw new Error(price.refused)
    expect(run.credits).toBe(price.credits)
  })
})

describe('prices (ruling (a))', () => {
  it('a card per endpoint, read from its page, in no other card', () => {
    expect(PAID_RATES[MINIMAX_SPEECH_SLUG]).toEqual({
      unit: 'per_thousand_chars', perThousand: 0.10,
      service: 'replicate', source: 'https://replicate.com/minimax/speech-02-hd', read: '2026-09-27', confidence: 'verified',
    })
    expect(PAID_RATES[MUSICGEN_SLUG]).toMatchObject({
      unit: 'gpu_per_output_second', perSecond: 0.012, minUsd: 0.042, confidence: 'estimate', read: '2026-09-27', source: 'https://replicate.com/meta/musicgen',
    })
    for (const slug of [MINIMAX_SPEECH_SLUG, MUSICGEN_SLUG]) expect(otherCardFor(slug), slug).toBeNull()
    expect(paidCallUsd({ endpoint: MUSICGEN_SLUG, outputSeconds: 1 })).toBe(0.042)
    expect(paidCallUsd({ endpoint: MUSICGEN_SLUG, outputSeconds: 30 })).toBe(0.36)
    expect(paidCallUsd({ endpoint: MUSICGEN_SLUG })).toBeNull()
    expect(paidCallUsd({ endpoint: MINIMAX_SPEECH_SLUG, chars: 20 })).toBe(0.002)
  })

  it('priced by their calls with no flat row; the price book moved on', () => {
    for (const c of AUDIO_GEN_CLASSES) {
      expect(PAID_NODE_CLASSES).toContain(c)
      expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, c), c).toBe(false)
      expect(PROVIDER_TYPES.has(c)).toBe(true)
    }
    expect(PRICE_BOOK_VERSION).toBe('r3-image-extras')
  })

  it('music by the seconds asked for, on both paths: 1 s 9, 8 s 20, 30 s 54; wired 30 s', () => {
    const music = (d: unknown) => ({ model: 'MusicGen', prompt: 'x', duration: d, model_version: 'large', temperature: 1, top_p: 0, seed: 0 })
    const want: [unknown, number, number][] = [[1, 0.042, 9], [3, 0.042, 9], [4, 0.048, 10], [8, 0.096, 20], [30, 0.36, 54], [['p', 0], 0.36, 54]]
    for (const ct of ['GenerateMusicNode', 'MusicGenRemoteNode']) {
      for (const [d, usd, credits] of want) {
        expect(priceNode(ct, music(d)), `${ct} ${String(d)}`).toEqual({ usd, credits })
        expect(priceGraph({ 1: { class_type: ct, inputs: music(d) } }).nodes!['1']).toBe(credits)
      }
      // A bare node: its default 8 s.
      expect(priceNode(ct, {})).toEqual({ usd: 0.096, credits: 20 })
    }
  })

  it('speech by the characters of its text: 20 → 1 credit, 1,000 → 20; a wired text at 10,000 (150), charged what it sent', () => {
    const speech = (text: unknown) => ({ ...sample('GenerateSpeechNode').widgets, text })
    for (const ct of ['GenerateSpeechNode', 'MiniMaxSpeechRemoteNode']) {
      expect(priceNode(ct, speech('x'.repeat(20)))).toEqual({ usd: 0.002, credits: 1 })
      expect(priceNode(ct, speech('x'.repeat(1000)))).toEqual({ usd: 0.1, credits: 20 })
      // Characters are code points: 18 emoji are 18 characters, not 36 UTF-16 units or 72 bytes.
      expect(priceNode(ct, speech('😀'.repeat(1000)))).toEqual({ usd: 0.1, credits: 20 })
      expect(priceNode(ct, speech(['t', 0]))).toEqual({ usd: 1, credits: creditsForUsd(1) })
      expect(creditsForUsd(1)).toBe(150)
      expect(priceGraph({ 1: { class_type: ct, inputs: speech(['t', 0]) } }).nodes!['1']).toBe(150)
      // The charge: what was sent, never above the hold.
      expect(priceNode(ct, speech(['t', 0]), { inputChars: 300 })).toEqual({ usd: 0.03, credits: 6 })
      expect(priceNode(ct, speech('x'.repeat(20)), { inputChars: 5000 })).toEqual({ usd: 0.002, credits: 1 })
    }
    expect(SPEECH_MAX_CHARS).toBe(10_000)
  })

  it('nothing is free: every class makes its call (no no-call branch in Python)', () => {
    for (const c of AUDIO_GEN_CLASSES) expect(paidNoCall(c, {}), c).toBe(false)
  })
})

describe('refusals before the hold, in plain words', () => {
  const speech = sample('GenerateSpeechNode')

  it('a blank or too-long typed text (runner); the ComfyUI path sends as Python', () => {
    for (const [text, want] of [['', SPEECH_NEEDS_TEXT], ['   \n', SPEECH_NEEDS_TEXT], ['x'.repeat(SPEECH_MAX_CHARS + 1), SPEECH_TOO_LONG]] as const) {
      expect(requestProblems({ n: node(speech, { text }) }, { runner: true }).map(p => p.message)).toEqual([want])
      expect(requestProblems({ n: node(speech, { text }) })).toEqual([])
    }
    expect(requestProblems({ n: node(speech, { text: '😀'.repeat(SPEECH_MAX_CHARS) }) }, { runner: true })).toEqual([])
    for (const w of [SPEECH_NEEDS_TEXT, SPEECH_TOO_LONG, SPEECH_VOICE_NOT_OFFERED]) expect(w).not.toMatch(/Node|_|\bid\b/)
  })

  it('hosted: a cloned or wired voice, on both paths (ruling (j)); the 17 presets pass', () => {
    const cloned = CASES.find(c => c.name === 'speech · cloned voice')!
    expect(hostedRequestProblems({ n: node(cloned) }).map(p => p.message)).toEqual([SPEECH_VOICE_NOT_OFFERED])
    expect(hostedRequestProblems({ n: node(speech, { voice_id: ['p', 0] }) }).map(p => p.message)).toEqual([SPEECH_VOICE_NOT_OFFERED])
    for (const v of MINIMAX_VOICES) expect(hostedRequestProblems({ n: node(speech, { voice_id: v }) })).toEqual([])
    expect(hostedRequestProblems({ n: node(sample('GenerateMusicNode')) })).toEqual([])
  })

  it('the engine refuses them before the hold (a cloned voice in hosted only)', async () => {
    const cloned = CASES.find(c => c.name === 'speech · cloned voice')!
    for (const [p, hosted, want] of [
      [{ n: node(speech, { text: '' }), a: card('n') }, false, SPEECH_NEEDS_TEXT],
      [{ n: node(speech, { text: 'x'.repeat(SPEECH_MAX_CHARS + 1) }), a: card('n') }, true, SPEECH_TOO_LONG],
      [{ n: node(cloned), a: card('n') }, true, SPEECH_VOICE_NOT_OFFERED],
    ] as const) {
      const k = makeKit({ hosted, deps: { families: () => ON } })
      await expect(k.engine.startRun({ userId: k.userId, takes: [p as ApiPrompt], ...START })).rejects.toThrow(want)
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
    }
    // Locally the cloned voice runs, as Python sends it.
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: SPEECH_URL }) })
    const k = makeKit({ replicate, deps: { families: () => ON, download: async () => ({ bytes: new Uint8Array(wav(0.2)), contentType: 'audio/wav' }) } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ n: node(cloned), a: card('n') }], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.takes[0]!.nodes.n!.status).toBe('done')
    expect(replicate.submitted()[0]!.payload.voice_id).toBe('sailor_clone_7f3a')
  })

  it('the hosted /prompt meter (the ComfyUI path) refuses a cloned voice, a wired voice and a twin\'s cloned voice before pricing or any hold', async () => {
    const cloned = CASES.find(c => c.name === 'speech · cloned voice')!
    const twin = sample('MiniMaxSpeechRemoteNode')
    const prompts: ApiPrompt[] = [
      { n: node(cloned), a: card('n') },
      { v: { class_type: 'PrimitiveString', inputs: { value: 'Wise_Woman' } }, n: node(speech, { voice_id: ['v', 0] }), a: card('n') },
      { n: node(twin, { voice_id: 'sailor_clone_7f3a' }), a: card('n') },
    ]
    for (const prompt of prompts) {
      const d = meterDeps()
      const r = await meterGraphSubmit('u1', { prompt }, d as any)
      expect(r.status).toBe(400)
      expect((r.body as any).error.message).toBe(SPEECH_VOICE_NOT_OFFERED)
      expect(Object.values((r.body as any).node_errors).map((e: any) => e.class_type)).toEqual([prompt.n!.class_type])
      expect(d.priceGraph).not.toHaveBeenCalled()
      expect(d.hold).not.toHaveBeenCalled()
      expect(d.forward).not.toHaveBeenCalled()
    }
    // A preset voice goes through to pricing and ComfyUI.
    const d = meterDeps()
    const ok = await meterGraphSubmit('u1', { prompt: { n: node(twin), a: card('n') } }, d as any)
    expect(ok.status).toBe(200)
    expect(d.forward).toHaveBeenCalled()
  })
})

describe('moderation (every text sent)', () => {
  it('lists Music\'s prompt and Speech\'s text, the twins too', () => {
    expect(PAID_TEXT_INPUTS.GenerateMusicNode).toEqual(['prompt'])
    expect(PAID_TEXT_INPUTS.MusicGenRemoteNode).toEqual(['prompt'])
    expect(PAID_TEXT_INPUTS.GenerateSpeechNode).toEqual(['text'])
    expect(PAID_TEXT_INPUTS.MiniMaxSpeechRemoteNode).toEqual(['text'])
    expect(extraPromptTexts({ m: node(sample('GenerateMusicNode'), { prompt: 'drums' }), s: node(sample('GenerateSpeechNode'), { text: 'hello' }) })).toEqual(['drums', 'hello'])
  })

  it('hosted: a flagged text is refused before the hold', async () => {
    const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
    for (const c of [sample('GenerateSpeechNode'), sample('MusicGenRemoteNode')]) {
      const k = makeKit({ hosted: true, moderate, deps: { families: () => ON } })
      const key = c.class_type.includes('Speech') ? 'text' : 'prompt'
      await expect(k.engine.startRun({ userId: k.userId, takes: [{ n: node(c, { [key]: 'a forbidden thing' }), a: card('n') }], ...START })).rejects.toThrow()
      expect(moderate.mock.calls.map(x => x[0])).toContain('a forbidden thing')
      expect(k.ledger.hold).not.toHaveBeenCalled()
    }
  })
})

describe('a wired text (hosted): a card\'s text priced at its length; a text made in the run held at the ceiling, charged the characters sent', () => {
  const kitOf = () => {
    const replicate = createFakeReplicate({
      bodyText: ({ model }) => JSON.stringify(model === MINIMAX_SPEECH_SLUG
        ? { id: 'p', status: 'succeeded', output: SPEECH_URL }
        : { id: 'p', status: 'succeeded', output: ['y'.repeat(300)], metrics: { input_token_count: 10, output_token_count: 300 } }),
    })
    const moderate = vi.fn(async () => ({ ok: true as const }))
    const k = makeKit({ hosted: true, available: 5000, replicate, moderate, deps: { families: () => new Set<RunnerFamily>([...ON, 'llm-text']), download: async () => ({ bytes: new Uint8Array(wav(0.2)), contentType: 'audio/wav' }) } })
    return { k, replicate, moderate }
  }
  const speechOf = (text: string) => {
    const { k, replicate, moderate } = kitOf()
    const p: ApiPrompt = {
      t: { class_type: 'PrimitiveStringMultiline', inputs: { value: text } },
      n: node(sample('GenerateSpeechNode'), { text: ['t', 0] }),
      a: card('n'),
    }
    return { k, p, replicate, moderate }
  }

  it('a card\'s 300 characters: held 6 (+1 render) and charged 6 on the runner; the ComfyUI path the same', async () => {
    const { k, p, replicate, moderate } = speechOf('y'.repeat(300))
    expect(isRunnerEligible(p, ON)).toBe(true)
    expect(stageEstimate(p, ['n'], false, ON)).toBe(6)
    expect(priceGraph(p).nodes!.n).toBe(6)
    // Through a Gate too (its value is still known at the start).
    const gated: ApiPrompt = { ...p, g: { class_type: 'ComfyGateNode', inputs: { data_in: ['t', 0], bypass: true } }, n: node(sample('GenerateSpeechNode'), { text: ['g', 0] }) }
    expect(priceGraph(gated).nodes!.n).toBe(6)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(replicate.submitted()[0]!.payload.text).toBe('y'.repeat(300))
    expect(moderate.mock.calls.map(x => (x as unknown[])[0])).toContain('y'.repeat(300))
    expect(rec.credits).toBe(6)
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[7, 7]])
  })

  it('a text made in the run (an LLM\'s answer): held at 10,000 characters (150), charged the 300 sent', async () => {
    const { k, replicate } = kitOf()
    const chat = { class_type: 'ChatLLMNode', inputs: { model: 'GPT-5', prompt: 'say y', system_prompt: '', temperature: 1, max_tokens: 1024 } }
    const p: ApiPrompt = { c: chat, n: node(sample('GenerateSpeechNode'), { text: ['c', 0] }), a: card('n') }
    expect(isRunnerEligible(p, new Set<RunnerFamily>([...ON, 'llm-text']))).toBe(true)
    expect(priceGraph(p).nodes!.n).toBe(150)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    expect(nodes.n!.status, nodes.n!.error ?? '').toBe('done')
    expect(replicate.submitted().map(r => r.endpoint)).toEqual(['openai/gpt-5', MINIMAX_SPEECH_SLUG])
    expect(replicate.submitted()[1]!.payload.text).toBe('y'.repeat(300))
    expect(nodes.n!.credits).toBe(6)
    // Held: the LLM's ceiling + the speech's 10,000 characters + the render credit; charged what each used.
    const fams = new Set<RunnerFamily>([...ON, 'llm-text'])
    const chatCeiling = stageEstimate(p, ['c'], false, fams)
    expect(stageEstimate(p, ['c', 'n', 'a'], true, fams)).toBe(chatCeiling + 150 + 1)
    const [hold] = [...k.ledger.holds.values()]
    expect([hold!.credits, hold!.actual]).toEqual([chatCeiling + 150 + 1, nodes.c!.credits + 6 + 1])
  })

  it('a card\'s text over 10,000 characters is refused before the hold (its value is known at the start)', async () => {
    const { k, p, replicate } = speechOf('z'.repeat(SPEECH_MAX_CHARS + 1))
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(SPEECH_TOO_LONG)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(replicate.client.submit).not.toHaveBeenCalled()
  })

  it('a text made in the run over 10,000 characters (or blank) fails at its turn, before the call', async () => {
    const speech = sample('GenerateSpeechNode')
    for (const [text, want] of [['z'.repeat(SPEECH_MAX_CHARS + 1), SPEECH_TOO_LONG], [' ', SPEECH_NEEDS_TEXT]] as const) {
      // planNode is handed the node with the wired value substituted (engine.ts withWiredValues).
      await expect(planNode({ prompt: { n: node(speech, { text }) }, nodeId: 'n', gateOpen: false, filesFrom: () => [], toUrl: async () => '' })).rejects.toThrow(want)
    }
  })
})

describe('the Audio card shows the node\'s file (ruling (t))', () => {
  const music = sample('GenerateMusicNode')

  it('Music → Audio card: the card hands the sound on and shows it; the sound is the provider\'s file', async () => {
    const bytes = wav(0.5)
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: MUSIC_URL }) })
    const download = vi.fn(async () => ({ bytes: new Uint8Array(bytes), contentType: null }))
    const k = makeKit({ replicate, deps: { families: () => ON, download } })
    const p: ApiPrompt = { m: node(music), a: card('m') }
    expect(isRunnerEligible(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    expect(nodes.a!.status, nodes.a!.error ?? '').toBe('done')
    const made = nodes.m!.outputs[0]!
    expect(made.filename).toMatch(/^music.*\.wav$/)
    expect(Buffer.compare(readFileSync(join(k.root, 'output', made.subfolder, made.filename)), bytes)).toBe(0)
    expect(nodes.a!.outputs).toEqual([made])
    const executed = ofType(k.seen, 'executed').map(m => (m as any).data)
    expect(executed.find((d: any) => d.node === 'a')?.output).toEqual({ audio: [made] })
    // The music node shows nothing itself.
    expect(executed.find((d: any) => d.node === 'm')).toBeUndefined()
    expect(download.mock.calls.map(c => (c as unknown[])[0])).toEqual([MUSIC_URL])
  })

  it('the rows: the card taken with source wired from the four classes only, export off, feeding lip-sync or nothing', () => {
    for (const ct of AUDIO_GEN_CLASSES) {
      const p: ApiPrompt = { m: node(sample(ct)), a: card('m') }
      expect(runnerTakesNode(p, 'a', ON), ct).toBe(true)
      expect(runnerTakesNode(p, 'm', ON), ct).toBe(true)
    }
    const p: ApiPrompt = { m: node(music), a: card('m') }
    // Export on: the card (and so the run) stays with the engine.
    expect(runnerTakesNode({ ...p, a: card('m', { export: true }) }, 'a', ON)).toBe(false)
    expect(isRunnerEligible({ ...p, a: card('m', { export: true }) }, ON)).toBe(false)
    // A card fed from anything else keeps its own row.
    expect(runnerTakesNode({ l: { class_type: 'LoadAudio', inputs: { audio: 'v.wav' } }, a: card('l') }, 'a', ON)).toBe(false)
    // Any other reader of the sound: left to the engine.
    expect(runnerTakesNode({ ...p, s: { class_type: 'SaveAudio', inputs: { audio: ['m', 0] } } }, 'm', ON)).toBe(false)
    expect(runnerTakesNode({ ...p, v: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'x', audio: ['a', 0] } } }, 'a', ON)).toBe(false)
    // The card is the one row that changes, only while audio-gen is on.
    expect(AUDIO_CARD_AUDIO_GEN_RULE.family).toBe('audio-gen')
    expect(RUNNER_NODE_RULES.Audio!.family).toBe('sync-3')
    expect(RUNNER_NODE_RULES.Audio!.mustNotLink).toContain('source')
    expect(RUNNER_OUTPUT_CLASSES.has('GenerateMusicNode')).toBe(false)
  })

  it('a wired prompt from a Text card arrives as typed; a wired setting leaves the node to the engine', async () => {
    const p: ApiPrompt = { t: { class_type: 'Text', inputs: { text: 'slow jazz' } }, m: node(music, { prompt: ['t', 0] }), a: card('m') }
    expect(isRunnerEligible(p, ON)).toBe(true)
    expect(runnerTakesNode({ ...p, m: node(music, { duration: ['x', 0] }), x: { class_type: 'PrimitiveInt', inputs: { value: 3 } } }, 'm', ON)).toBe(false)
    const plan = await planNode({ prompt: { m: node(music, { prompt: 'slow jazz' }) }, nodeId: 'm', gateOpen: false, filesFrom: () => [], toUrl: async () => '' }) as Extract<NodePlan, { kind: 'provider' }>
    expect(plan.payload.prompt).toBe('slow jazz')
  })
})

describe('Lip-sync on sync-3 reads the sound through the card', () => {
  const VIDEO_VIEW = '/view?filename=face.mp4&type=input'
  const lip = (mode = 'loop') => ({
    class_type: 'LipSyncNode',
    inputs: {
      engine: 'sync-3', resolution: '720p', sync_mode: mode, audio: ['a', 0],
      model_options: JSON.stringify({ engine: 'sync-3', resolution: '720p', face_video: VIDEO_VIEW, sync_mode: mode }),
    },
  })
  const take = (): ApiPrompt => ({
    s: node(sample('GenerateSpeechNode'), { text: 'Say hello to Sailor.' }),
    a: card('s'),
    l: lip(),
    v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['l', 0] } },
  })
  const FAMS: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'audio-gen', 'sync-3'])

  it('the sound is made in the run: nothing to read at the start, the node\'s turn reads what the card brought', async () => {
    const p = take()
    expect(isRunnerEligible(p, FAMS)).toBe(true)
    // Without sync-3 the lip-sync is the engine's.
    expect(isRunnerEligible(p, ON)).toBe(false)
    expect(sync3Sources(p, 'l').audio).toEqual({ produced: ['a', 0] })
    expect(sync3NodeProblem(p, 'l')).toBeNull()
    // The start: the video alone is judged; nothing recorded (held at the 60 s cap).
    const reads = { read: async () => new Uint8Array(await mp4(5)), strict: true }
    expect(await nodeMediaCheck(p, 'l', reads)).toBeNull()
  })

  it('end to end (hosted): speech, the card, sync-3 with the speech file; lip-sync held at 60 s, charged the sound measured', async () => {
    const { mkdtempSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const root = mkdtempSync(join(tmpdir(), 'audio-gen-lipsync-'))
    for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
    writeFileSync(join(root, 'input', 'face.mp4'), await mp4(5))
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: SPEECH_URL }) })
    const fal = createFakeFal()
    const k = makeKit({
      hosted: true, available: 5000, root, replicate, fal,
      deps: {
        families: () => FAMS,
        download: async (url: string) => (url === SPEECH_URL
          ? { bytes: new Uint8Array(wav(3.4)), contentType: 'audio/wav' }
          : { bytes: new Uint8Array(await mp4(3.4)), contentType: 'video/mp4' }),
      },
    })
    const p = take()
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await until(() => ofType(k.seen, 'execution_success').length === 1 || ofType(k.seen, 'execution_error').length === 1, 10_000)
    expect(ofType(k.seen, 'execution_error')).toEqual([])
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    const speechFile = nodes.s!.outputs[0]!
    const sent = k.fal.submitted()
    expect(sent.map(r => r.endpoint)).toEqual([SYNC_3_APP])
    expect(sent[0]!.payload).toEqual({ video_url: 'https://fal.storage/face.mp4', audio_url: `https://fal.storage/${speechFile.filename}`, sync_mode: 'loop' })
    // Held: speech (20 characters: 1) + the lip-sync at its 60 s cap + the render credit. Charged: the 3.4 s sound (billed 4 s).
    const lipCap = priceNode('LipSyncNode', p.l!.inputs, { inputSeconds: {} }) as { credits: number }
    const lipMeasured = priceNode('LipSyncNode', p.l!.inputs, { inputSeconds: { audio: 3.4, video: 5 } }) as { credits: number }
    expect(lipCap).toEqual(priceNode('LipSyncNode', p.l!.inputs, { inputSeconds: { audio: LIPSYNC_MAX_SECONDS } }))
    expect(lipMeasured.credits).toBeLessThan(lipCap.credits)
    expect(nodes.s!.credits).toBe(1)
    expect(nodes.l!.credits).toBe(lipMeasured.credits)
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[1 + lipCap.credits + 1, 1 + lipMeasured.credits + 1]])
  }, 30_000)
})

describe('with audio-gen off (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but audio-gen', RUNNER_FAMILIES.filter(f => f !== 'audio-gen')],
  ]
  const isAudioGen = (ct: string) => (AUDIO_GEN_CLASSES as readonly string[]).includes(ct)
  /** The same prompt as before R3.8: the classes had no rule row (renamed to one that has none). */
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, isAudioGen(n.class_type) ? { ...n, class_type: `${n.class_type}Before` } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        // Every node, the four classes too (fix round 1): as runnerTakesNode asks it, with the families.
        expect(valueWiresAllowed(p, id, outputKindsFor(families), families), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families), families))
      }
    }
  }

  it('each class is left to the engine, and named by the needs-the-engine list; its route is Replicate, no backup', () => {
    for (const c of AUDIO_GEN_CLASSES) {
      const p: ApiPrompt = { n: node(sample(c)), a: card('n') }
      expect(runnerTakesNode(p, 'n', new Set(['cards'])), c).toBe(false)
      expect(runnerTakesNode(p, 'n', ON), c).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n', 'a'])
      expect(SWITCHED_CLASSES[c]).toBe('audio-gen')
      expect(RUNNER_ROUTES[c]).toEqual({ first: 'replicate', backup: null, why: 'MiniMax Speech and MusicGen aren\'t carded on fal' })
    }
  })

  it('audio-gen needs cards', () => {
    const p: ApiPrompt = { n: node(sample('GenerateMusicNode')), a: card('n') }
    expect(isRunnerEligible(p, new Set<RunnerFamily>(['audio-gen']))).toBe(false)
  })

  it('over synthetic chains: into an Audio card, into Save audio, a Text card into the text, a lip-sync through the card', () => {
    for (const c of AUDIO_GEN_CLASSES) {
      const p: ApiPrompt = { n: node(sample(c)) }
      sameAsBefore(p, `${c} alone`)
      sameAsBefore({ ...p, a: card('n') }, `${c} → Audio card`)
      sameAsBefore({ ...p, a: card('n', { export: true }) }, `${c} → Audio card (export)`)
      sameAsBefore({ ...p, s: { class_type: 'SaveAudio', inputs: { audio: ['n', 0], filename_prefix: 'audio/x' } } }, `${c} → Save audio`)
      const text = PAID_TEXT_INPUTS[c]![0]!
      sameAsBefore({ ...p, t: { class_type: 'Text', inputs: { text: 'hi' } }, n: { ...p.n!, inputs: { ...p.n!.inputs, [text]: ['t', 0] } }, a: card('n') }, `Text → ${c}`)
    }
    const lipTake: ApiPrompt = {
      s: node(sample('GenerateSpeechNode')), a: card('s'),
      l: { class_type: 'LipSyncNode', inputs: { engine: 'sync-3', resolution: '720p', sync_mode: 'loop', audio: ['a', 0], model_options: JSON.stringify({ engine: 'sync-3', face_video: '/view?filename=f.mp4&type=input', sync_mode: 'loop' }) } },
    }
    sameAsBefore(lipTake, 'speech → card → lip-sync')
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (with Generate speech → Audio card spliced in beside each)', async () => {
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
        sameAsBefore({ ...p, d_sp: node(sample('GenerateSpeechNode')), d_card: card('d_sp') }, `${uuid} + speech → card`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`audio-gen families-off invariant: ${graphs} saved graphs`)
  }, 600_000)
})

/** The hosted meter's ports (as request-refusals.unit.spec.ts's). */
function meterDeps() {
  return {
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
  }
}

describe('fix round 1: the runner runs only what an output needs (ComfyUI\'s pruning, runner-wide)', () => {
  const music = sample('GenerateMusicNode')

  it('a lone music or speech node: not run (not an output node); the runner refuses it in plain words, nothing names the engine', async () => {
    for (const ct of AUDIO_GEN_CLASSES) {
      const p: ApiPrompt = { n: node(sample(ct)) }
      expect(runnerTakesNode(p, 'n', ON), ct).toBe(false)
      expect(RUNNER_NODE_RULES[ct]!.needsReader).toBe(true)
      // Fix round 2: sent to the runner (engine on or off), which says why; never "needs the local engine".
      expect(runnerTakesWorkflow(p, ON), ct).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: ON, titleOf: id => id }), ct).toEqual([])
      expect(needsEngineReasons(p, { runnerOn: true, families: ON }), ct).toEqual([])
      for (const hosted of [false, true]) {
        const k = makeKit({ hosted, deps: { families: () => ON } })
        await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START }), ct).rejects.toThrow(NO_OUTPUTS_MESSAGE)
        expect(k.replicate.client.submit).not.toHaveBeenCalled()
        expect(k.ledger.hold).not.toHaveBeenCalled()
      }
    }
    // With audio-gen off the classes are unknown to the runner: left to the engine, exactly as before.
    expect(runnerTakesWorkflow({ n: node(music) }, new Set(['cards']))).toBe(false)
  })

  it('a prompt with no output node is refused plainly before the hold; nothing is sent', async () => {
    const lone: ApiPrompt = { 1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } } }
    expect(pruneInvalidOutputs(lone, ON)).toMatchObject({ failed: true, noOutputs: true, prompt: {} })
    // The browser sends it where it went before; the runner refuses it in plain words.
    expect(runnerTakesWorkflow(lone, ON)).toBe(true)
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    await expect(k.engine.startRun({ userId: k.userId, takes: [lone], ...START })).rejects.toThrow(NO_OUTPUTS_MESSAGE)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(NO_OUTPUTS_MESSAGE).not.toMatch(/[A-Z][a-z]+Node|_|\bid\b|prompt/)
  })

  it('a generator nothing reads, beside one an Image card shows, is neither run nor held nor charged', async () => {
    const gen = (seed: number) => ({ class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed, model_options: '{}' } })
    const p: ApiPrompt = { 1: gen(1), 2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } }, 3: gen(2) }
    const pruned = pruneInvalidOutputs(p, ON)
    expect(Object.keys(pruned.prompt).sort()).toEqual(['1', '2'])
    expect(pruned.unread).toEqual(['3'])
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(Object.keys(run.takes[0]!.nodes).sort()).toEqual(['1', '2'])
    expect(k.fal.client.submit).toHaveBeenCalledTimes(1)
    const one = stageEstimate({ 1: p[1]!, 2: p[2]! }, ['1', '2'], true, ON)
    expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([one])
  })

  it('the Audio card counts in ComfyUI\'s validation pass while audio-gen is on (fix 6)', () => {
    const bad: ApiPrompt = { m: node(music, { duration: 99 }), a: card('m') }
    // audio-gen on, sync-3 off: the card's output fails (the music's duration), so ComfyUI refuses the prompt.
    const on = pruneInvalidOutputs(bad, ON)
    expect(on.failed).toBe(true)
    expect(on.noOutputs).toBeUndefined()
    expect(Object.keys(on.nodeErrors)).toEqual(['m'])
    // Beside a valid one, only the failing card and what it needs are dropped.
    const both: ApiPrompt = { ...bad, m2: node(music), a2: card('m2') }
    const r = pruneInvalidOutputs(both, ON)
    expect(r.dropped).toEqual(['a'])
    expect(Object.keys(r.prompt).sort()).toEqual(['a2', 'm2'])
    // Neither family on: the card is unknown, the prompt is left whole, as before.
    expect(pruneInvalidOutputs(bad, new Set(['cards']))).toMatchObject({ failed: false, prompt: bad })
  })
})

describe('the sound kept, whatever the service answers (finding 6)', () => {
  const MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64, ...new Array(64).fill(0)])

  it('an MP3 answer (MiniMax\'s own default) is saved .mp3 by its header, and the card shows it', async () => {
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: 'https://r.test/speech/out' }) })
    const k = makeKit({ replicate, deps: { families: () => ON, download: async () => ({ bytes: MP3, contentType: 'application/octet-stream' }) } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ n: node(sample('GenerateSpeechNode')), a: card('n') }], ...START })
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    expect(nodes.a!.status, nodes.a!.error ?? '').toBe('done')
    const made = nodes.n!.outputs[0]!
    expect(made.filename).toMatch(/^speech.*\.mp3$/)
    expect(Buffer.compare(readFileSync(join(k.root, 'output', made.subfolder, made.filename)), Buffer.from(MP3))).toBe(0)
    const executed = ofType(k.seen, 'executed').map(m => (m as any).data)
    expect(executed.find((d: any) => d.node === 'a')?.output).toEqual({ audio: [made] })
  })

  it('an answer that isn\'t a sound fails plainly; hosted, the hold is released and nothing charged', async () => {
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: MUSIC_URL }) })
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON, download: async () => ({ bytes: new TextEncoder().encode('<html>oops</html>'), contentType: 'text/html' }) } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ m: node(sample('GenerateMusicNode')), a: card('m') }], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.m!
    expect(rec.status).toBe('error')
    expect(rec.error).toContain(ANSWER_NOT_SOUND)
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })
})
