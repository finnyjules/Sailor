/**
 * R3.10: sound in (family `sound-in`) — Transcribe audio (fal's Wizper) and
 * its hidden twin Whisper, Identify speakers (whisper-diarization), Clone a
 * singing voice (realistic-voice-cloning) and Sync lips to audio
 * (sync/lipsync-2-pro) and its hidden twin — against what their real Python
 * sends and returns (fixtures/runner-paid-sound-in.json,
 * scripts/runner_paid_fixtures.py --group sound-in). Each sends Python's WAV
 * of its sound (the first 60 s, int16), made with Sailor's own tools and
 * compared with Python's by samples; each is priced by the seconds it sends.
 * Hosted refuses the presets named after real people (ruling (m)) and any
 * Sync lips address but https or the user's own upload (ruling (r)).
 *
 * The WAV parts need the real tools (R5.1a): they fail, never skip, when the
 * tools are missing.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny'
import { MEDIA_WORDS } from '#shared/runner/media'
import { describe, expect, it, vi } from 'vitest'
import { createFakeFal, createFakeLedger, createFakeReplicate, makeKit, until } from './__runner__/kit'
import { normalizeSent, runPaidCase, wireText, type PaidCase } from './__runner__/paidParity'
import { requireMediaTools } from './__runner__/mediaParity'
import { checkPayload, type ProviderSchemaFixture } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { FAMILY_REQUIRES, MEDIA_TOOL_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import {
  AUDIO_CARD_SOUND_IN_RULE, PROVIDER_TYPES, SWITCHED_CLASSES, isRunnerEligible, outputKindsFor, runnerRuleFor, runnerTakesNode, valueWiresAllowed,
} from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import {
  DIARIZATION_SLUG, LIPSYNC_2_PRO_SLUG, LIPSYNC_NEEDS_VIDEO, LIPSYNC_VIDEO_ADDRESS, LIPSYNC_VIDEO_MISSING, RVC_CUSTOM_URL_MAX, RVC_CUSTOM_URL_REFUSED, RVC_PRESET_VOICES, RVC_REAL_PEOPLE, RVC_SLUG,
  RVC_VOICE_NOT_OFFERED, SOUND_IN_CHANNELS, SOUND_IN_CLASSES, SOUND_IN_EMPTY, SOUND_IN_LANGUAGES, WIZPER_APP, type SoundInClass,
} from '#shared/runner/soundIn'
import { PAID_RATES, otherCardFor, paidCallUsd } from '#shared/pricing/paidRates'
import { PAID_NODE_CLASSES, paidNoCall } from '#shared/pricing/paidSettings'
import { priceNode } from '#shared/pricing/nodePrice'
import { GRAPH_NODE_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { PAID_TEXT_INPUTS, extraPromptTexts } from '~~/server/runner/metering'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { diarizationInput, lipsync2ProInput, rvcInput, wizperInput, wizperText } from '~~/server/runner/generators/soundIn'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { hostedRequestProblems, requestProblems } from '~~/server/runner/requestRules'
import { pyInt16, pythonWav, pythonWavOf, silenceWav, type PythonWav } from '~~/server/runner/soundWav'
import { decodeAudio } from '~~/server/media/decode'
import { probeMedia } from '~~/server/media/probe'
import { catalogOptions } from './helpers/nodeCatalog'

// ── The fixture ──────────────────────────────────────────────────────────────

interface WavCase {
  name: string; kind: 'pcm16' | 'float32'; rate: number; channels: number; seconds: number; seed: number
  file_sha256: string
  sent: { channels: number; sample_width: number; rate: number; frames: number; pcm_sha256: string; head: number[]; seconds: number }
}
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-sound-in.json'), 'utf8')) as { cases: PaidCase[]; wavs: WavCase[]; silence: WavCase['sent'] & { wav_sha256: string } }
const CASES = FIXTURE.cases
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-sound', 'sound-in'])
/** The case's sound (paid_case's default: 0.25 s at 8 kHz): the seconds sent. */
const CASE_SECONDS = 0.25

/** The FLOAT setting Python writes as `5.0` where the runner's JSON writes `5`: the same JSON number (R3.3 ruling 1). */
function pythonWire(payloadJson: string): string {
  return payloadJson.replace(/"(pitch_change_all)": (-?\d+)\.0([,}])/g, '"$1": $2$3')
}

const node = (c: PaidCase, inputs: Record<string, unknown> = {}) => ({ class_type: c.class_type, inputs: { ...c.widgets, ...inputs } })
const byName = (name: string) => CASES.find(c => c.name === name)!
const sample = (ct: SoundInClass) => CASES.find(c => c.class_type === ct && !c.error)!
/** An empty Audio card's case (fix round 1): Python names the silence WAV it made by its sha256. */
const isSilent = (c: PaidCase) => !!c.silent_card?.length
/** The calls as Python writes them: a handed-off `audio.wav` is `WAV:audio`, or, for the card's silence, `WAV:<sha256>`. */
function pyNorm(c: PaidCase, sent: Parameters<typeof normalizeSent>[0]) {
  const got = normalizeSent(sent, [], ['audio'])
  if (!isSilent(c)) return got
  const swap = (v: unknown): unknown => (v === 'WAV:audio' ? `WAV:${FIXTURE.silence.wav_sha256}` : v)
  return got.map(g => ({ ...g, payload: Object.fromEntries(Object.entries(g.payload).map(([k, v]) => [k, swap(v)])) }))
}
/** The seconds a case sends: its 0.25 s sound, or the card's 1 s of silence. */
const secondsOf = (c: PaidCase) => (isSilent(c) ? 1 : CASE_SECONDS)

/** Each case whose Python made its call (not the blank addresses). */
const CALLED = CASES.filter(c => !c.error)

/** A stand-in WAV for planning alone: the builders never read it. */
const WAV_STUB: PythonWav = { wav: new Uint8Array(46), seconds: CASE_SECONDS, frames: 2000, rate: 8000, channels: 1 }

async function planOf(c: PaidCase, o: { hosted?: boolean } = {}): Promise<Extract<NodePlan, { kind: 'provider' }>> {
  return await planNode({
    prompt: { n: { ...node(c), inputs: { ...c.widgets, audio: ['s', 0] } }, s: { class_type: 'LoadAudio', inputs: { audio: 'audio.wav' } } },
    nodeId: 'n', gateOpen: false, filesFrom: () => [], hosted: !!o.hosted,
    toUrl: async f => `https://fal.storage/${f.filename}`,
    bytesToUrl: async f => `https://fal.storage/${f.filename}`,
    soundWav: async () => WAV_STUB,
  }) as Extract<NodePlan, { kind: 'provider' }>
}

/** Python's STRING (Transcribe, Identify speakers) or the URL it downloaded (Clone, Sync lips). */
function pythonOut(c: PaidCase): { text: string } | { url: string } {
  const out = (c.output as unknown[])[0]
  if (typeof out === 'string') return { text: out }
  const o = out as { audio?: string; video?: string }
  return { url: (o.audio ?? o.video)! }
}

/** The answer as the engine hands it to the plan: its body text, and what JSON.parse reads of it. */
function answerOf(c: PaidCase): { result: unknown; raw: string } {
  const a = c.answers[0] as Record<string, unknown>
  const raw = typeof a.__body__ === 'string' ? a.__body__ : JSON.stringify(a)
  return { result: JSON.parse(raw), raw }
}

// ── The published inputs (each page's schema, read 2026-09-30), until the controller saves them ──

const publishedInput = (properties: Record<string, unknown>, required: string[]): ProviderSchemaFixture => ({
  endpoint: '', fetchedAt: '2026-09-30', input: { type: 'object', required, properties }, output: {}, components: { schemas: {} },
})
/** fal-ai/wizper (its llms.txt): `language` is an enum of 98 codes; the thirteen the node offers are among them. */
const WIZPER_SCHEMA = publishedInput({
  audio_url: { type: 'string' }, task: { enum: ['transcribe', 'translate'], type: 'string', default: 'transcribe' },
  language: { type: 'string', default: 'en' }, chunk_level: { type: 'string', default: 'segment' },
  max_segment_len: { type: 'integer', default: 29, minimum: 10, maximum: 29 }, merge_chunks: { type: 'boolean', default: true },
  version: { type: 'string', default: '3' },
}, ['audio_url'])
const DIARIZATION_SCHEMA = publishedInput({
  file: { type: 'string', format: 'uri', nullable: true }, prompt: { type: 'string', nullable: true }, file_url: { type: 'string', nullable: true },
  language: { type: 'string', nullable: true }, translate: { type: 'boolean', default: false }, file_string: { type: 'string', nullable: true },
  num_speakers: { type: 'integer', maximum: 50, minimum: 1, nullable: true },
}, [])
const RVC_SCHEMA = publishedInput({
  song_input: { type: 'string', format: 'uri' },
  rvc_model: { enum: [...RVC_PRESET_VOICES], type: 'string', default: 'Squidward' },
  custom_rvc_model_download_url: { type: 'string' },
  pitch_change: { enum: ['no-change', 'male-to-female', 'female-to-male'], type: 'string', default: 'no-change' },
  pitch_change_all: { type: 'number', default: 0 },
  pitch_detection_algorithm: { enum: ['rmvpe', 'mangio-crepe'], type: 'string', default: 'rmvpe' },
  output_format: { enum: ['mp3', 'wav'], type: 'string', default: 'mp3' },
  protect: { type: 'number', default: 0.33, maximum: 0.5, minimum: 0 }, index_rate: { type: 'number', default: 0.5, maximum: 1, minimum: 0 },
}, [])
const LIPSYNC_SCHEMA = publishedInput({
  audio: { type: 'string', format: 'uri' }, video: { type: 'string', format: 'uri' },
  sync_mode: { enum: ['loop', 'bounce', 'cut_off', 'silence', 'remap'], type: 'string', default: 'loop' },
  temperature: { type: 'number', default: 0.5, maximum: 1, minimum: 0 }, active_speaker: { type: 'boolean', default: false },
}, ['video', 'audio'])
const SCHEMAS: Record<string, ProviderSchemaFixture> = {
  [WIZPER_APP]: WIZPER_SCHEMA, [DIARIZATION_SLUG]: DIARIZATION_SCHEMA, [RVC_SLUG]: RVC_SCHEMA, [LIPSYNC_2_PRO_SLUG]: LIPSYNC_SCHEMA,
}

// ── The standard clips, made as the fixture script makes them ───────────────

function clipSamples(frames: number, channels: number, seed: number): Int16Array {
  const out = new Int16Array(frames * channels)
  let state = seed & 0x7FFFFFFF
  for (let i = 0; i < out.length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7FFFFFFF
    out[i] = ((state >> 8) & 0xFFFF) - 32768
  }
  return out
}

function clipBytes(kind: 'pcm16' | 'float32', rate: number, channels: number, frames: number, seed: number): Uint8Array {
  const samples = clipSamples(frames, channels, seed)
  const width = kind === 'pcm16' ? 2 : 4
  const data = Buffer.alloc(samples.length * width)
  samples.forEach((v, i) => (kind === 'pcm16' ? data.writeInt16LE(v, i * 2) : data.writeFloatLE(v / 8192, i * 4)))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(kind === 'pcm16' ? 1 : 3, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * channels * width, 28); h.writeUInt16LE(channels * width, 32); h.writeUInt16LE(width * 8, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return new Uint8Array(Buffer.concat([h, data]))
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

// ── Tests ────────────────────────────────────────────────────────────────────

describe('the fixture', () => {
  it('covers every class, language, speaker count, preset, pitch setting, format, sync mode, address kind and answer shape', () => {
    const names = new Set(CASES.map(c => c.name))
    expect(new Set(CASES.map(c => c.class_type))).toEqual(new Set(SOUND_IN_CLASSES))
    for (const l of SOUND_IN_LANGUAGES) {
      expect(names.has(`transcribe · language ${l}`), l).toBe(true)
      expect(names.has(`speakers · language ${l}`), l).toBe(true)
    }
    for (const p of RVC_PRESET_VOICES) expect(names.has(`clone · preset ${p}`), p).toBe(true)
    for (const m of ['loop', 'bounce', 'cut_off', 'silence', 'remap']) {
      expect(names.has(`lipsync · mode ${m}`), m).toBe(true)
      expect(names.has(`lipsync twin · mode ${m}`), m).toBe(true)
    }
    for (const n of ['text missing', 'text null', 'text with spaces', 'non-ASCII text', 'text a float']) expect(names.has(`transcribe · ${n}`), n).toBe(true)
    expect(new Set(CALLED.flatMap(c => c.calls.map(x => x.endpoint)))).toEqual(new Set([WIZPER_APP, DIARIZATION_SLUG, RVC_SLUG, LIPSYNC_2_PRO_SLUG]))
    expect(CALLED.every(c => c.calls.length === 1)).toBe(true)
    expect(CASES.length).toBeGreaterThanOrEqual(85)
  })

  it('the lists are Python\'s', () => {
    // As the Python nodes declared them (the node catalogue, C6).
    expect(catalogOptions('CloneSingingVoiceNode', 'rvc_model')).toEqual([...RVC_PRESET_VOICES])
    for (const ct of ['TranscribeAudioNode', 'IdentifySpeakersNode']) expect(catalogOptions(ct, 'language'), ct).toEqual([...SOUND_IN_LANGUAGES])
  })
})

describe('Python\'s WAV: the samples sent equal Python\'s exactly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sound-in-clips-'))

  it.each(FIXTURE.wavs.map(w => [w.name, w] as const))('%s', async (_n, w) => {
    await requireMediaTools()
    const bytes = clipBytes(w.kind, w.rate, w.channels, w.rate * w.seconds, w.seed)
    expect(sha(bytes), 'the clip is the fixture\'s').toBe(w.file_sha256)
    const path = join(dir, `${w.seed}.wav`)
    writeFileSync(path, bytes)
    // As the node decodes it (fix round 1, Minor 3): the first 60 s only, no length cap.
    const sound = await decodeAudio(path, { decoder: 'load', userId: null, roots: [dir], maxSamples: 100_000_000, firstSeconds: 60 })
    expect(sound.channels[0]!.length).toBe(Math.min(w.rate * w.seconds, 60 * w.rate))
    const made = pythonWav(sound)
    expect({ channels: made.channels, rate: made.rate, frames: made.frames }).toEqual({ channels: w.sent.channels, rate: w.sent.rate, frames: w.sent.frames })
    expect(made.seconds).toBe(w.sent.seconds)
    const pcm = made.wav.subarray(44)
    expect(Array.from(new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + 2 * w.sent.head.length)))).toEqual(w.sent.head)
    expect(sha(pcm), 'the PCM samples').toBe(w.sent.pcm_sha256)
    // The header: RIFF/WAVE, PCM, 16-bit, the rate and channels, the data's size.
    const v = new DataView(made.wav.buffer, made.wav.byteOffset)
    expect([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true), v.getUint32(40, true)])
      .toEqual([1, w.sent.channels, w.sent.rate, 16, w.sent.frames * w.sent.channels * 2])
  }, 120_000)

  it('a 75 s clip is cut at 60 s (int(60 · rate) samples)', () => {
    const long = FIXTURE.wavs.filter(w => w.seconds === 75)
    expect(long.length).toBe(2)
    for (const w of long) expect(w.sent.frames).toBe(60 * w.rate)
  })

  it('int16 as torch casts it: clamp, a float32 product, truncated toward zero', () => {
    expect([pyInt16(1), pyInt16(-1), pyInt16(4), pyInt16(-4), pyInt16(0.5), pyInt16(-0.5), pyInt16(0)]).toEqual([32767, -32767, 32767, -32767, 16383, -16383, 0])
    expect(pyInt16(Math.fround(0.99999994))).toBe(32766)
    expect(pyInt16(Number.POSITIVE_INFINITY)).toBe(32767)
    expect(pyInt16(Number.NaN)).toBe(0)
    // -17119 / 32768 as float32, times 32767: -17118.48 → -17118.
    expect(pyInt16(Math.fround(-17119 / 32768))).toBe(-17118)
  })

  it('no samples, or more than two channels: refused in plain words (PyAV raises)', () => {
    expect(() => pythonWav({ rate: 8000, channels: [new Float32Array(0)] })).toThrow(SOUND_IN_EMPTY)
    expect(() => pythonWav({ rate: 8000, channels: [] })).toThrow(SOUND_IN_EMPTY)
    expect(() => pythonWav({ rate: 8000, channels: [0, 1, 2].map(() => new Float32Array(4)) })).toThrow(SOUND_IN_CHANNELS)
    for (const w of [SOUND_IN_EMPTY, SOUND_IN_CHANNELS, LIPSYNC_NEEDS_VIDEO, LIPSYNC_VIDEO_ADDRESS, RVC_VOICE_NOT_OFFERED]) expect(w).not.toMatch(/Node|_|url\b/)
  })
})

describe('every fixture case: what Python sends and returns', () => {
  const wholeFloat: string[] = []

  it.each(CALLED.map(c => [c.name, c] as const))('%s — the request and the answer', async (_n, c) => {
    expect(paidNoCall(c.class_type, c.widgets)).toBe(false)
    const plan = await planOf(c)
    expect(plan.kind).toBe('provider')
    expect(plan.backup).toBeUndefined()
    const py = c.calls[0]!
    expect(pyNorm(c, [{ provider: plan.provider, endpoint: plan.endpoint, payload: plan.payload }]))
      .toEqual([{ provider: py.provider, endpoint: py.endpoint, payload: py.payload }])
    const pw = pythonWire(py.payload_json!)
    if (pw !== py.payload_json) wholeFloat.push(c.name)
    expect(wireText(pyNorm(c, [{ provider: plan.provider, endpoint: plan.endpoint, payload: plan.payload }])[0]!.payload)).toBe(pw)
    // Every payload fits the published schema (a Python address that isn't one aside: Python sends it as typed).
    const problems = checkPayload(SCHEMAS[plan.endpoint]!, plan.payload)
    expect(problems).toEqual([])
    // Python's output: the text byte for byte, or the URL it downloaded; no ui.
    const out = pythonOut(c)
    const { result, raw } = answerOf(c)
    if ('text' in out) {
      expect(plan.media).toBe('value')
      const v = plan.valuesOf!(result, raw)[0]!
      expect(v).toEqual({ kind: c.class_type === 'IdentifySpeakersNode' ? 'json' : 'text', text: out.text })
    }
    else {
      expect(plan.take).toBe('first')
      expect(plan.urlsOf!(result)).toEqual([out.url])
    }
    expect(c.ui).toBeNull()
    expect(plan.uiFor([])).toBeNull()
  })

  it('the builders alone give the same', () => {
    for (const c of CALLED) {
      const py = c.calls[0]!.payload
      const wav = c.class_type.startsWith('Transcribe') || c.class_type.startsWith('Whisper') ? 'UPLOAD:whisper.wav' : isSilent(c) ? `WAV:${FIXTURE.silence.wav_sha256}` : 'WAV:audio'
      const built = c.class_type === 'IdentifySpeakersNode' ? diarizationInput(c.widgets, wav)
        : c.class_type === 'CloneSingingVoiceNode' ? rvcInput(c.widgets, wav)
          : c.class_type.startsWith('Lipsync') ? lipsync2ProInput(c.widgets, String(c.widgets.video_url), wav)
            : wizperInput(c.widgets, wav)
      expect(built, c.name).toEqual(py)
    }
  })

  it('whole-number FLOAT settings (pitch_change_all) are the only wire difference', () => {
    expect(wholeFloat.length).toBeGreaterThanOrEqual(20)
    expect(wholeFloat.every(n => n.startsWith('clone'))).toBe(true)
  })

  it('Transcribe keeps the text\'s spaces (Python doesn\'t strip)', () => {
    expect(wizperText({ text: '  Hello,  world.  \n' }, null)).toBe('  Hello,  world.  \n')
    expect(pythonOut(byName('transcribe · text with spaces'))).toEqual({ text: '  Hello,  world.  \n' })
    expect(() => wizperText(null, '"just text"')).toThrow()
    expect(() => wizperText(null, '{"text": {"a": 1}}')).toThrow()
  })

  it('a blank address: Python raises before its call; the runner refuses before the hold', async () => {
    for (const c of CASES.filter(x => x.error)) {
      expect(c.calls).toEqual([])
      expect(c.error!.message).toMatch(/^video_url is required/)
      expect(requestProblems({ n: node(c) }, { runner: true }).map(p => p.message)).toEqual([LIPSYNC_NEEDS_VIDEO])
      await expect(planOf(c)).rejects.toThrow(LIPSYNC_NEEDS_VIDEO)
    }
  })
})

describe('every fixture case through the engine (cards, media-sound and sound-in on; the sound from Load audio, or an empty Audio card)', () => {
  // Sync lips' "silence" is left to the engine (it can't be priced), so it isn't run here.
  const RUN = CALLED.filter(c => c.widgets.sync_mode !== 'silence')

  it.each(RUN.map(c => [c.name, c] as const))('%s — sent, kept and charged', async (_n, c) => {
    await requireMediaTools()
    const run = await runPaidCase(c, { families: ON })
    expect(run.status, run.error ?? '').toBe('done')
    const sent = pyNorm(c, run.sent)
    expect(sent).toEqual([{ provider: c.calls[0]!.provider, endpoint: c.calls[0]!.endpoint, payload: c.calls[0]!.payload }])
    expect(wireText(sent[0]!.payload)).toBe(pythonWire(c.calls[0]!.payload_json!))
    const out = pythonOut(c)
    if ('text' in out) {
      expect(run.values?.[0]).toEqual({ kind: c.class_type === 'IdentifySpeakersNode' ? 'json' : 'text', text: out.text })
    }
    else {
      expect(run.files.length).toBe(1)
      expect(run.files[0]!.filename).toMatch(c.class_type === 'CloneSingingVoiceNode' ? /^voice_clone.*\.wav$/ : /^lipsync.*\.mp4$/)
    }
    // Charged on the seconds sent (0.25 s of the case's sound, or the empty card's 1 s of silence).
    const price = priceNode(c.class_type, c.widgets, { inputSeconds: { audio: secondsOf(c) } })
    if ('refused' in price) throw new Error(price.refused)
    expect(run.credits).toBe(price.credits)
  }, 60_000)

  it('the WAV handed off is Python\'s WAV of the case\'s sound', async () => {
    await requireMediaTools()
    const c = sample('IdentifySpeakersNode')
    const uploads: Uint8Array[] = []
    const fal = createFakeFal()
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: 'x' }) })
    const k = makeKit({ fal, replicate, deps: { families: () => ON } })
    k.upload.mockImplementation(async (b: Uint8Array, name: string) => { uploads.push(b); return `https://fal.storage/${name}` })
    const dir = join(k.root, 'input')
    writeFileSync(join(dir, 'audio.wav'), Buffer.from(c.sound_files!.audio!, 'base64'))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ s: { class_type: 'LoadAudio', inputs: { audio: 'audio.wav' } }, n: { ...node(c), inputs: { ...c.widgets, audio: ['s', 0] } } }], ...START })
    await k.engine.settled(runId)
    expect(uploads.length).toBe(1)
    const sound = await decodeAudio(join(dir, 'audio.wav'), { decoder: 'load', userId: null, roots: [dir], maxSamples: 1e8 })
    expect(Buffer.from(uploads[0]!).equals(Buffer.from(pythonWav(sound).wav))).toBe(true)
  }, 60_000)
})

describe('prices (ruling (a))', () => {
  it('a card per endpoint, read from its page; Sync lips keeps its clip card', () => {
    expect(PAID_RATES[WIZPER_APP]).toMatchObject({ unit: 'per_input_second', perSecond: 0.0001, service: 'fal', confidence: 'verified', read: '2026-09-30', source: 'https://fal.ai/models/fal-ai/wizper' })
    // LC1 (2026-10-01): diarization verified by the owed live checks; RVC at least 36 s (money-rule break #1), still an estimate.
    expect(PAID_RATES[DIARIZATION_SLUG]).toMatchObject({ unit: 'per_input_second', perSecond: 0.00005, minSeconds: 36, confidence: 'verified', source: 'https://replicate.com/thomasmol/whisper-diarization' })
    expect(PAID_RATES[RVC_SLUG]).toMatchObject({ unit: 'per_input_second', perSecond: 0.0007, minSeconds: 36, confidence: 'estimate', source: 'https://replicate.com/zsxkib/realistic-voice-cloning' })
    for (const e of [WIZPER_APP, DIARIZATION_SLUG, RVC_SLUG]) expect(otherCardFor(e), e).toBeNull()
    expect(otherCardFor(LIPSYNC_2_PRO_SLUG)).toBe('clip')
    expect(PAID_RATES[LIPSYNC_2_PRO_SLUG]).toBeUndefined()
    expect(paidCallUsd({ endpoint: WIZPER_APP, inputSeconds: 60 })).toBe(0.006)
    expect(paidCallUsd({ endpoint: DIARIZATION_SLUG, inputSeconds: 10 })).toBe(0.0018)
    expect(paidCallUsd({ endpoint: DIARIZATION_SLUG, inputSeconds: 60 })).toBe(0.003)
    expect(paidCallUsd({ endpoint: RVC_SLUG, inputSeconds: 60 })).toBe(0.042)
    expect(paidCallUsd({ endpoint: RVC_SLUG })).toBeNull()
  })

  it('priced by their calls with no flat row; the price book moved on', () => {
    for (const c of SOUND_IN_CLASSES) {
      expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, c), c).toBe(false)
      expect(PROVIDER_TYPES.has(c)).toBe(true)
      expect(PAID_NODE_CLASSES.includes(c), c).toBe(!c.startsWith('Lipsync'))
    }
    expect(PRICE_BOOK_VERSION).toBe('lineup-flux-3-1k')
  })

  it('by the seconds sent: a 75 s sound is priced at 60 s; unmeasured (the ComfyUI path, a sound made in the run) at 60 s', () => {
    const credits = (c: PaidCase, audio?: number) => {
      const p = priceNode(c.class_type, c.widgets, audio === undefined ? {} : { inputSeconds: { audio } })
      if ('refused' in p) throw new Error(p.refused)
      return p.credits
    }
    const transcribe = sample('TranscribeAudioNode')
    const speakers = sample('IdentifySpeakersNode')
    const clone = sample('CloneSingingVoiceNode')
    const lipsync = sample('LipsyncNode')
    expect([credits(transcribe, 10), credits(transcribe, 60), credits(transcribe, 75), credits(transcribe)]).toEqual([1, 2, 2, 2])
    expect([credits(speakers, 10), credits(speakers, 60), credits(speakers)]).toEqual([1, 1, 1])
    expect([credits(clone, 10), credits(clone, 60), credits(clone, 75), credits(clone)]).toEqual([6, 9, 9, 9])
    expect([credits(lipsync, 2), credits(lipsync, 60), credits(lipsync)]).toEqual([25, 750, 750])
    // The ComfyUI path (priceGraph, nothing measured): the 60 s ceiling, never below the flat row
    // before R3 while the card is an estimate (R3.9 fix round 2): Identify speakers stays 10.
    const onPath = (c: PaidCase, families?: ReadonlySet<RunnerFamily>) =>
      priceGraph({ n: node(c) }, families ? { families } : {}).breakdown.filter(b => b.action !== 'base_render').reduce((s, b) => s + b.credits, 0)
    // LC1: Identify speakers' card verified, so no longer floored at its flat 10.
    for (const [c, comfy, runner] of [[transcribe, 2, 2], [sample('WhisperRemoteNode'), 2, 2], [speakers, 1, 1], [clone, 9, 9]] as const) {
      expect(onPath(c), c.class_type).toBe(comfy)
      // The runner (its family on) pays the card.
      expect(onPath(c, ON), c.class_type).toBe(runner)
    }
  })

  it('the hold is the 60 s ceiling for a sound made in the run; the start measures a loaded file; the charge is what was sent', async () => {
    await requireMediaTools()
    // A 75 s Load audio: measured before the hold, held and charged at 60 s.
    const long = clipBytes('pcm16', 8000, 1, 8000 * 75, 7)
    const fal = createFakeFal({ bodyText: () => JSON.stringify({ text: 'hi' }) })
    const k = makeKit({ hosted: true, fal, deps: { families: () => ON } })
    const t = sample('TranscribeAudioNode')
    const inputDir = join(k.root, 'input', 'user_1')
    mkdirSync(inputDir, { recursive: true })
    writeFileSync(join(inputDir, 'long.wav'), long)
    writeFileSync(join(k.root, 'input', 'long.wav'), long)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ s: { class_type: 'LoadAudio', inputs: { audio: 'long.wav' } }, n: { ...node(t), inputs: { ...t.widgets, audio: ['s', 0] } } }], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(rec.credits).toBe(2)
    expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([2])
  }, 60_000)
})

describe('a sound made in the run: held at the 60 s ceiling, charged the seconds sent', () => {
  it('Generate speech → Transcribe (hosted): the hold counts Transcribe at 60 s; its turn measures the speech and charges it', async () => {
    await requireMediaTools()
    const t = sample('TranscribeAudioNode')
    const speechWav = clipBytes('pcm16', 8000, 1, 1600, 11) // 0.2 s
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: 'https://r.test/speech.wav' }) })
    const fal = createFakeFal({ bodyText: () => JSON.stringify({ text: 'hello' }) })
    const k = makeKit({
      hosted: true, fal, replicate,
      deps: { families: () => new Set<RunnerFamily>([...ON, 'audio-gen']), download: async () => ({ bytes: speechWav, contentType: 'audio/wav' }) },
    })
    const speech = { class_type: 'GenerateSpeechNode', inputs: { model: 'MiniMax Speech-02 HD', text: 'Hello.', voice_id: 'Wise_Woman', emotion: 'auto', speed: 1, volume: 1, pitch: 0, language_boost: 'auto' } }
    const p: ApiPrompt = { sp: speech, n: { ...node(t), inputs: { ...t.widgets, audio: ['sp', 0] } } }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    expect(nodes.n!.status, nodes.n!.error ?? '').toBe('done')
    const at = (audio?: number) => { const q = priceNode(t.class_type, t.widgets, audio === undefined ? {} : { inputSeconds: { audio } }); if ('refused' in q) throw new Error(q.refused); return q.credits }
    expect(at()).toBe(2)
    expect(nodes.n!.credits).toBe(at(0.2))
    expect(nodes.n!.credits).toBe(1)
    const held = [...k.ledger.holds.values()].reduce((sum, h) => sum + h.credits, 0)
    // Held: the speech's call and Transcribe at the ceiling; settled at what was sent (no render work here).
    expect(held).toBe(nodes.sp!.credits + at())
    expect([...k.ledger.holds.values()].map(h => h.actual)).toEqual([nodes.sp!.credits + at(0.2)])
    expect(nodes.n!.values?.[0]).toEqual({ kind: 'text', text: 'hello' })
    // The speech's own file, decoded as Python's download reader does, is what was sent.
    expect(fal.submitted()[0]!.payload.audio_url).toBe('https://fal.storage/whisper.wav')
  }, 60_000)
})

describe('media-sound off: an Audio card playing its own file feeds a sound-in node', () => {
  it('the card hands its file on; Identify speakers sends Python\'s WAV of it', async () => {
    await requireMediaTools()
    const c = sample('IdentifySpeakersNode')
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: { segments: [] } }) })
    const k = makeKit({ replicate, deps: { families: () => new Set<RunnerFamily>(['cards', 'sound-in']) } })
    writeFileSync(join(k.root, 'input', 'voice.wav'), clipBytes('pcm16', 16000, 2, 16000, 5))
    const card = { class_type: 'Audio', inputs: { audio: 'voice.wav', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0' } }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ a: card, n: { ...node(c), inputs: { ...c.widgets, audio: ['a', 0] } } }], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(rec.values?.[0]).toEqual({ kind: 'json', text: '{"segments": []}' })
    expect(replicate.submitted()[0]!.payload.file).toBe('https://fal.storage/audio.wav')
    const p = priceNode(c.class_type, c.widgets, { inputSeconds: { audio: 1 } })
    expect(rec.credits).toBe('refused' in p ? -1 : p.credits)
  }, 60_000)
})

describe('refusals before the hold, in plain words', () => {
  it('hosted: a preset named after a real person, on both paths (ruling (m)); every other preset and custom models pass', () => {
    const clone = sample('CloneSingingVoiceNode')
    for (const p of RVC_PRESET_VOICES) {
      const got = hostedRequestProblems({ n: node(clone, { rvc_model: p }) }).map(x => x.message)
      expect(got, p).toEqual(RVC_REAL_PEOPLE.includes(p) ? [RVC_VOICE_NOT_OFFERED] : [])
    }
    expect(RVC_REAL_PEOPLE).toEqual(['Trump', 'Biden', 'Obama', 'Drake'])
    expect(hostedRequestProblems({ n: node(clone, { rvc_model: ['p', 0] }) }).map(x => x.message)).toEqual([RVC_VOICE_NOT_OFFERED])
    // Locally every preset runs, as Python offers them.
    for (const p of RVC_PRESET_VOICES) expect(requestProblems({ n: node(clone, { rvc_model: p }) }, { runner: true })).toEqual([])
  })

  it('the engine (hosted) refuses a real-person preset, a non-https address and a blank one before any hold or call', async () => {
    const clone = byName('clone · preset Trump')
    const http = byName('lipsync · http address')
    const blank = byName('lipsync · blank address')
    for (const [c, want] of [[clone, RVC_VOICE_NOT_OFFERED], [http, LIPSYNC_VIDEO_ADDRESS], [blank, LIPSYNC_NEEDS_VIDEO]] as const) {
      const k = makeKit({ hosted: true, deps: { families: () => ON } })
      const p: ApiPrompt = { s: { class_type: 'LoadAudio', inputs: { audio: 'audio.wav' } }, n: { ...node(c), inputs: { ...c.widgets, audio: ['s', 0] } }, v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['n', 0] } } }
      if (c.class_type === 'CloneSingingVoiceNode') p.v = { class_type: 'Audio', inputs: { audio: '', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0', source: ['n', 0] } }
      await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(want)
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
    }
  })

  it('hosted: an upload that isn\'t the user\'s is refused by its name, the same whether or not it exists', async () => {
    const upload = byName('lipsync · upload link')
    for (const there of [true, false]) {
      const k = makeKit({ hosted: true, deps: { families: () => ON, ownership: { ownsInput: async (_u: string, f: { filename: string }) => f.filename !== 'face.mp4', ownsOutput: async () => true } } })
      if (there) writeFileSync(join(k.root, 'input', 'face.mp4'), new Uint8Array(64))
      const p: ApiPrompt = { s: { class_type: 'LoadAudio', inputs: { audio: 'audio.wav' } }, n: { ...node(upload), inputs: { ...upload.widgets, audio: ['s', 0] } }, v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['n', 0] } } }
      await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow('This workflow uses a file that isn’t one of yours')
      expect(k.ledger.hold).not.toHaveBeenCalled()
    }
  })

  it('locally an http or relative address is sent as typed (Python\'s own request); hosted hands an upload off', async () => {
    const http = byName('lipsync · http address')
    const plan = await planOf(http)
    expect(plan.payload.video).toBe('http://r.test/face.mp4')
    const upload = byName('lipsync · upload link')
    expect((await planOf(upload)).payload.video).toBe('/view?filename=face.mp4&type=input')
    expect((await planOf(upload, { hosted: true })).payload.video).toBe('https://fal.storage/face.mp4')
    await expect(planOf(http, { hosted: true })).rejects.toThrow(LIPSYNC_VIDEO_ADDRESS)
  })

  it('a sound with three channels is refused before the hold (PyAV raises), nothing sent', async () => {
    await requireMediaTools()
    const c = sample('IdentifySpeakersNode')
    const k = makeKit({ deps: { families: () => ON } })
    writeFileSync(join(k.root, 'input', 'three.wav'), clipBytes('pcm16', 8000, 3, 800, 3))
    await expect(k.engine.startRun({ userId: k.userId, takes: [{ s: { class_type: 'LoadAudio', inputs: { audio: 'three.wav' } }, n: { ...node(c), inputs: { ...c.widgets, audio: ['s', 0] } } }], ...START }))
      .rejects.toThrow(SOUND_IN_CHANNELS)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  }, 60_000)

})

describe('moderation', () => {
  it('no text these nodes send is the user\'s (the RVC model address is a link, not text)', () => {
    for (const c of SOUND_IN_CLASSES) expect(PAID_TEXT_INPUTS[c], c).toBeUndefined()
    expect(extraPromptTexts({ n: node(byName('clone · CUSTOM with a URL')) })).toEqual([])
  })
})

describe('with sound-in off (rule 15), and its rows', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family', [...RUNNER_FAMILIES]],
    ['every family and the media families but sound-in', [...RUNNER_FAMILIES, 'media-sound', 'media-video']],
  ]
  const isSoundIn = (ct: string) => (SOUND_IN_CLASSES as readonly string[]).includes(ct)
  /** The same prompt as before R3.10: the classes had no rule row (renamed to one that has none). */
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, isSoundIn(n.class_type) ? { ...n, class_type: `${n.class_type}Before` } : n]))
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
    }
  }
  const load: ApiPrompt = { s: { class_type: 'LoadAudio', inputs: { audio: 'audio.wav' } } }
  const wired = (c: PaidCase): ApiPrompt => ({ ...load, n: { ...node(c), inputs: { ...c.widgets, audio: ['s', 0] } } })
  const shown = (c: PaidCase): ApiPrompt => c.class_type === 'CloneSingingVoiceNode'
    ? { out: { class_type: 'Audio', inputs: { audio: '', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0', source: ['n', 0] } } }
    : c.class_type.startsWith('Lipsync') ? { v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['n', 0] } } } : {}

  it('each class is left to the engine, and named by the needs-the-engine list; on, the runner takes it; its route, no backup', () => {
    for (const ct of SOUND_IN_CLASSES) {
      const c = sample(ct)
      const p: ApiPrompt = { ...wired(c), ...shown(c) }
      expect(runnerTakesNode(p, 'n', new Set(['cards', 'media-sound'])), ct).toBe(false)
      expect(runnerTakesNode(p, 'n', ON), ct).toBe(true)
      expect(isRunnerEligible(p, ON), ct).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards', 'media-sound']), titleOf: id => id })).toContain('n')
      expect(SWITCHED_CLASSES[ct]).toBe('sound-in')
      expect(RUNNER_ROUTES[ct]!.backup).toBeNull()
      expect(RUNNER_ROUTES[ct]!.first).toBe(ct.includes('Transcribe') || ct.includes('Whisper') ? 'fal' : 'replicate')
    }
    expect(RUNNER_OUTPUT_CLASSES.has('TranscribeAudioNode') && RUNNER_OUTPUT_CLASSES.has('WhisperRemoteNode') && RUNNER_OUTPUT_CLASSES.has('IdentifySpeakersNode')).toBe(true)
    expect(RUNNER_OUTPUT_CLASSES.has('CloneSingingVoiceNode') || RUNNER_OUTPUT_CLASSES.has('LipsyncNode')).toBe(false)
  })

  it('sound-in needs cards and the video tools (a media family)', () => {
    expect(FAMILY_REQUIRES['sound-in']).toBe('cards')
    expect(MEDIA_TOOL_FAMILIES).toContain('sound-in')
    expect(RUNNER_FAMILIES).not.toContain('sound-in')
    const c = sample('TranscribeAudioNode')
    expect(isRunnerEligible(wired(c), new Set<RunnerFamily>(['sound-in', 'media-sound']))).toBe(false)
  })

  it('a wired setting, Sync lips\' "silence", or a sound from a class the runner doesn\'t know leaves the node to the engine', () => {
    const t = sample('TranscribeAudioNode')
    expect(runnerTakesNode({ ...wired(t), n: { ...wired(t).n!, inputs: { ...t.widgets, audio: ['s', 0], language: ['x', 0] } }, x: { class_type: 'PrimitiveString', inputs: { value: 'en' } } }, 'n', ON)).toBe(false)
    const silence = byName('lipsync · mode silence')
    expect(runnerTakesNode({ ...wired(silence), ...shown(silence) }, 'n', ON)).toBe(false)
    expect(runnerTakesNode({ s: { class_type: 'SomeAudioNode', inputs: {} }, n: { ...node(t), inputs: { ...t.widgets, audio: ['s', 0] } } }, 'n', ON)).toBe(false)
  })

  it('media-sound off: an Audio card playing its own file feeds a sound-in node (its sound-in row); music or speech through its card too', () => {
    const fam = new Set<RunnerFamily>(['cards', 'sound-in', 'audio-gen'])
    const t = sample('TranscribeAudioNode')
    const card = { class_type: 'Audio', inputs: { audio: 'voice.wav', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0' } }
    const p: ApiPrompt = { a: card, n: { ...node(t), inputs: { ...t.widgets, audio: ['a', 0] } } }
    expect(runnerRuleFor('Audio', card.inputs, fam)).toBe(AUDIO_CARD_SOUND_IN_RULE)
    expect(isRunnerEligible(p, fam)).toBe(true)
    const speech: ApiPrompt = {
      sp: { class_type: 'GenerateSpeechNode', inputs: { model: 'MiniMax Speech-02 HD', text: 'Hello.', voice_id: 'Wise_Woman', emotion: 'auto', speed: 1, volume: 1, pitch: 0, language_boost: 'auto' } },
      a: { class_type: 'Audio', inputs: { audio: '', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0', source: ['sp', 0] } },
      n: { ...node(t), inputs: { ...t.widgets, audio: ['a', 0] } },
    }
    expect(isRunnerEligible(speech, fam)).toBe(true)
    // Straight from the speech node, too.
    expect(isRunnerEligible({ sp: speech.sp!, n: { ...node(t), inputs: { ...t.widgets, audio: ['sp', 0] } } }, fam)).toBe(true)
  })

  it('over synthetic chains: each class from Load audio, from an Audio card, into its reader', () => {
    for (const ct of SOUND_IN_CLASSES) {
      const c = sample(ct)
      sameAsBefore(wired(c), `${ct} alone`)
      // Clone a singing voice → Audio card: the card's own answer is R5.3's (SOUND_OUTPUTS has listed
      // Clone a singing voice since R5.3), which the renamed "before" prompt can't reproduce; that graph
      // was compared with HEAD's code itself (the report's probe). The node itself is left to the engine.
      if (ct === 'CloneSingingVoiceNode') {
        for (const [, fam] of OFF_SETS) expect(nodesNeedingEngine({ ...wired(c), ...shown(c) }, { runnerOn: true, families: new Set(fam), titleOf: id => id })).toContain('n')
      }
      else sameAsBefore({ ...wired(c), ...shown(c) }, `${ct} shown`)
      const card = { class_type: 'Audio', inputs: { audio: 'voice.wav', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0' } }
      const fromCard: ApiPrompt = { a: card, n: { ...node(c), inputs: { ...c.widgets, audio: ['a', 0] } }, ...shown(c) }
      if (ct === 'CloneSingingVoiceNode') {
        for (const [, fam] of OFF_SETS) expect(nodesNeedingEngine(fromCard, { runnerOn: true, families: new Set(fam), titleOf: id => id })).toContain('n')
      }
      else sameAsBefore(fromCard, `card → ${ct}`)
    }
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (with Load audio → Transcribe spliced in beside each)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/assets/nodeCatalog.json.gz'))).toString('utf8'))
    const t = sample('TranscribeAudioNode')
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
        sameAsBefore({ ...p, d_s: { class_type: 'LoadAudio', inputs: { audio: 'a.wav' } }, d_t: { ...node(t), inputs: { ...t.widgets, audio: ['d_s', 0] } } }, `${uuid} + Load audio → Transcribe`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`sound-in families-off invariant: ${graphs} saved graphs`)
  }, 600_000)
})

/** The hosted meter's ports (as runner-paid-audio-gen's). */
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

// ── Fix round 1 ──────────────────────────────────────────────────────────────

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

const emptyCard = () => ({ class_type: 'Audio', inputs: { audio: '', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0' } })

describe('fix round 1 · Important: an empty Audio card sends Python\'s 1 s of silence, priced at 1 s', () => {
  it('the silence WAV equals Python\'s (the real card\'s AUDIO, through the real encoder), by samples', () => {
    const w = silenceWav()
    expect({ channels: w.channels, rate: w.rate, frames: w.frames, seconds: w.seconds })
      .toEqual({ channels: FIXTURE.silence.channels, rate: FIXTURE.silence.rate, frames: FIXTURE.silence.frames, seconds: FIXTURE.silence.seconds })
    expect(sha(w.wav.subarray(44))).toBe(FIXTURE.silence.pcm_sha256)
    expect(CASES.filter(isSilent).map(c => c.class_type).sort()).toEqual([...SOUND_IN_CLASSES].sort())
  })

  it.each([['media-sound on', ON], ['media-sound off', new Set<RunnerFamily>(['cards', 'sound-in'])]] as const)('%s: the run succeeds, held and charged for 1 s', async (_n, families) => {
    const t = sample('TranscribeAudioNode')
    const fal = createFakeFal({ bodyText: () => JSON.stringify({ text: 'silence' }) })
    const k = makeKit({ hosted: true, fal, deps: { families: () => families } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ a: emptyCard(), n: { ...node(t), inputs: { ...t.widgets, audio: ['a', 0] } } }], ...START })
    await k.engine.settled(runId)
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    const one = priceNode(t.class_type, t.widgets, { inputSeconds: { audio: 1 } })
    if ('refused' in one) throw new Error(one.refused)
    expect(rec.credits).toBe(one.credits)
    // The hold: the start knew the 1 s already (1 credit, not the 60 s ceiling's 2), plus the render
    // credit; settled at exactly what was held.
    const sixty = priceNode(t.class_type, t.widgets, {})
    if ('refused' in sixty) throw new Error(sixty.refused)
    expect(sixty.credits).toBeGreaterThan(one.credits)
    const holds = [...k.ledger.holds.values()]
    expect(holds.map(h => [h.credits, h.actual])).toEqual([[one.credits + 1, one.credits + 1]])
    // What went up is Python's silence WAV.
    expect(fal.submitted()[0]!.payload.audio_url).toBe('https://fal.storage/whisper.wav')
    expect(k.upload.mock.calls.map(c => sha((c[0] as Uint8Array).subarray(44)))).toContain(FIXTURE.silence.pcm_sha256)
  }, 60_000)
})

describe('fix round 1 · Minor 1: a CUSTOM voice model address in hosted', () => {
  it('https only, at most 2,048 characters; refused before the hold in plain words; not sent (not CUSTOM) is not judged', () => {
    const clone = sample('CloneSingingVoiceNode')
    const judge = (w: Record<string, unknown>) => hostedRequestProblems({ n: node(clone, w) }).map(x => x.message)
    expect(judge({ rvc_model: 'CUSTOM', custom_rvc_model_url: 'https://huggingface.co/a/v.zip' })).toEqual([])
    expect(judge({ rvc_model: 'CUSTOM', custom_rvc_model_url: `https://h.test/${'a'.repeat(RVC_CUSTOM_URL_MAX - 15)}` })).toEqual([])
    expect(judge({ rvc_model: 'CUSTOM', custom_rvc_model_url: `https://h.test/${'a'.repeat(RVC_CUSTOM_URL_MAX)}` })).toEqual([RVC_CUSTOM_URL_REFUSED])
    for (const url of ['http://h.test/v.zip', 'data:application/zip;base64,UEsDBA==', '/view?filename=v.zip&type=input', 'ftp://h.test/v.zip']) {
      expect(judge({ rvc_model: 'CUSTOM', custom_rvc_model_url: url }), url).toEqual([RVC_CUSTOM_URL_REFUSED])
      // Not CUSTOM: Python doesn't send it, so it isn't judged.
      expect(judge({ rvc_model: 'Guitar', custom_rvc_model_url: url }), url).toEqual([])
      // Locally it is sent as typed, as Python does.
      expect(requestProblems({ n: node(clone, { rvc_model: 'CUSTOM', custom_rvc_model_url: url }) }, { runner: true })).toEqual([])
    }
    expect(judge({ rvc_model: 'CUSTOM', custom_rvc_model_url: '' })).toEqual([])
    expect(RVC_CUSTOM_URL_REFUSED).not.toMatch(/Node|_|url\b/)
  })

  it('the engine refuses it before any hold or call', async () => {
    const clone = sample('CloneSingingVoiceNode')
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const p: ApiPrompt = {
      s: { class_type: 'LoadAudio', inputs: { audio: 'audio.wav' } },
      n: { ...node(clone), inputs: { ...clone.widgets, rvc_model: 'CUSTOM', custom_rvc_model_url: 'http://h.test/v.zip', audio: ['s', 0] } },
      out: { class_type: 'Audio', inputs: { audio: '', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0', source: ['n', 0] } },
    }
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow(RVC_CUSTOM_URL_REFUSED)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })
})

describe('fix round 1 · Minor 2: a resumed node never decodes or uploads its sound again', () => {
  it('its job running, the sound gone after a restart: the job carries on with the link it was sent; nothing cancelled', async () => {
    await requireMediaTools()
    const c = sample('IdentifySpeakersNode')
    const root = mkdtempSync(join(tmpdir(), 'sound-in-resume-'))
    for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
    writeFileSync(join(root, 'input', 'voice.wav'), clipBytes('pcm16', 8000, 1, 8000, 21))
    const replicate = createFakeReplicate({ bodyText: () => JSON.stringify({ id: 'p', status: 'succeeded', output: { segments: [] } }) })
    const ledger = createFakeLedger(5000)
    const state = { crashed: false }
    const k1 = makeKit({ root, replicate, ledger, deps: { families: () => ON, sleep: () => (state.crashed ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1))) } })
    replicate.holdNext(1)
    const take: ApiPrompt = { s: { class_type: 'LoadAudio', inputs: { audio: 'voice.wav' } }, n: { ...node(c), inputs: { ...c.widgets, audio: ['s', 0] } } }
    const { runId } = await k1.engine.startRun({ userId: k1.userId, takes: [take], ...START })
    await until(() => (replicate.submitted()[0]?.polls ?? 0) >= 2)
    state.crashed = true
    await new Promise(r => setTimeout(r, 20))
    const uploadsBefore = k1.upload.mock.calls.length
    // While the server is down the sound becomes unreadable.
    writeFileSync(join(root, 'input', 'voice.wav'), 'not a sound')
    const k2 = makeKit({ dir: k1.dir, root, replicate, ledger, deps: { families: () => ON } })
    expect(await k2.engine.reattach()).toBe(1)
    replicate.release()
    await k2.engine.settled(runId)
    const rec = (await k2.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.status, rec.error ?? '').toBe('done')
    expect(replicate.submitted()).toHaveLength(1)
    expect(replicate.client.cancel).not.toHaveBeenCalled()
    expect(rec.payload).toEqual(replicate.submitted()[0]!.payload)
    // Nothing uploaded after the restart (k2 has its own hand-off; k1's count is unchanged).
    expect(k2.upload).not.toHaveBeenCalled()
    expect(k1.upload.mock.calls.length).toBe(uploadsBefore)
  }, 60_000)

  it('planning with the request written down reads nothing: no WAV, no upload, the links as sent', async () => {
    for (const ct of SOUND_IN_CLASSES) {
      const c = sample(ct)
      const recorded = { ...c.calls[0]!.payload }
      const plan = await planNode({
        prompt: { n: { ...node(c), inputs: { ...c.widgets, audio: ['s', 0] } } }, nodeId: 'n', gateOpen: false, filesFrom: () => [], hosted: true,
        toUrl: async () => { throw new Error('read') }, bytesToUrl: async () => { throw new Error('uploaded') },
        soundWav: async () => { throw new Error('decoded') }, recordedPayload: recorded,
      }) as Extract<NodePlan, { kind: 'provider' }>
      expect(plan.payload, ct).toEqual(recorded)
    }
  })
})

describe('fix round 1 · Minor 3: only the first 60 s are decoded, with no length cap', () => {
  it('a sound past the sample cap decodes its first 60 s (the whole decode refuses it)', async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(tmpdir(), 'sound-in-cap-'))
    const path = join(dir, 'long.wav')
    writeFileSync(path, clipBytes('pcm16', 8000, 1, 8000 * 70, 33))
    await expect(decodeAudio(path, { decoder: 'load', userId: null, roots: [dir], maxSamples: 8000 * 10 })).rejects.toThrow(MEDIA_WORDS.tooLong)
    const cut = await decodeAudio(path, { decoder: 'load', userId: null, roots: [dir], maxSamples: 8000 * 10, firstSeconds: 60 })
    const whole = await decodeAudio(path, { decoder: 'load', userId: null, roots: [dir], maxSamples: 1e9 })
    expect(cut.channels[0]!.length).toBe(8000 * 60)
    expect(Buffer.from(cut.channels[0]!.buffer, cut.channels[0]!.byteOffset, cut.channels[0]!.byteLength)
      .equals(Buffer.from(whole.channels[0]!.subarray(0, 8000 * 60).buffer, whole.channels[0]!.byteOffset, 8000 * 60 * 4))).toBe(true)
  })

  it('a sound whose header says it is past the length cap is still decoded, its first 60 s (the whole decode refuses it)', async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(tmpdir(), 'sound-in-liar-'))
    const path = join(dir, 'liar.wav')
    writeFileSync(path, clipBytes('pcm16', 8000, 1, 8000 * 70, 34))
    // The header's length as the caps read it, stretched past the local hour.
    const real = await probeMedia(path, { userId: null, roots: [dir], kind: 'sound' })
    const probe = { ...real, containerDuration: 75 * 3600 * 1e6, sound: real.sound.map(t => ({ ...t, duration: null, measuredSeconds: 75 * 3600 })) }
    await expect(decodeAudio(path, { decoder: 'load', userId: null, roots: [dir], maxSamples: 1e12, probe })).rejects.toThrow(MEDIA_WORDS.tooLong)
    const cut = await decodeAudio(path, { decoder: 'load', userId: null, roots: [dir], maxSamples: 1e12, probe, firstSeconds: 60 })
    expect(cut.channels[0]!.length).toBe(8000 * 60)
  })
})

describe('fix round 1 · Minor 5: Sync lips\' upload in hosted, judged by the video caps before the hold', () => {
  const lipTake = (c: PaidCase): ApiPrompt => ({
    s: { class_type: 'LoadAudio', inputs: { audio: 'audio.wav' } },
    n: { ...node(c), inputs: { ...c.widgets, audio: ['s', 0] } },
    v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['n', 0] } },
  })

  it('missing, or not a video: refused before any hold, in plain words', async () => {
    await requireMediaTools()
    const upload = byName('lipsync · upload link')
    for (const [bytes, want] of [[null, LIPSYNC_VIDEO_MISSING], [Buffer.from('not a video at all'), MEDIA_WORDS.unreadable]] as const) {
      const k = makeKit({ hosted: true, deps: { families: () => ON } })
      const dir = join(k.root, 'input')
      writeFileSync(join(dir, 'audio.wav'), Buffer.from(upload.sound_files!.audio!, 'base64'))
      if (bytes) writeFileSync(join(dir, 'face.mp4'), bytes)
      const err = await k.engine.startRun({ userId: k.userId, takes: [lipTake(upload)], ...START }).then(() => null, (e: Error) => e.message)
      expect(err === want || (want === MEDIA_WORDS.unreadable && err !== null && err !== LIPSYNC_VIDEO_MISSING), String(err)).toBe(true)
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
    }
  })

  it('a video within the caps is handed off; one gone after the start fails at its turn, before its call, and is not charged', async () => {
    await requireMediaTools()
    const upload = byName('lipsync · upload link')
    const speech = { class_type: 'GenerateSpeechNode', inputs: { model: 'MiniMax Speech-02 HD', text: 'Hello.', voice_id: 'Wise_Woman', emotion: 'auto', speed: 1, volume: 1, pitch: 0, language_boost: 'auto' } }
    const replicate = createFakeReplicate({ bodyText: ({ model }) => JSON.stringify({ id: 'p', status: 'succeeded', output: model === LIPSYNC_2_PRO_SLUG ? 'https://r.test/l.mp4' : 'https://r.test/s.wav' }) })
    const k = makeKit({
      hosted: true, replicate, available: 5000,
      deps: { families: () => new Set<RunnerFamily>([...ON, 'audio-gen']), download: async (url: string) => ({ bytes: url.endsWith('.wav') ? clipBytes('pcm16', 8000, 1, 1600, 12) : new Uint8Array(16), contentType: null }) },
    })
    const dir = join(k.root, 'input')
    writeFileSync(join(dir, 'face.mp4'), await mp4(2))
    replicate.holdNext(1)
    const p: ApiPrompt = { sp: speech, n: { ...node(upload), inputs: { ...upload.widgets, audio: ['sp', 0] } }, v: { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['n', 0] } } }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await until(() => (replicate.submitted()[0]?.polls ?? 0) >= 2)
    // Gone while the speech is made.
    rmSync(join(dir, 'face.mp4'))
    replicate.release()
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    expect(nodes.n!.status).toBe('error')
    expect(nodes.n!.error).toBe(LIPSYNC_VIDEO_MISSING)
    expect(replicate.submitted().map(r => r.endpoint)).toEqual(['minimax/speech-02-hd'])
    // Charged the speech only.
    expect([...k.ledger.holds.values()].map(h => h.actual)).toEqual([nodes.sp!.credits])
  }, 60_000)
})
