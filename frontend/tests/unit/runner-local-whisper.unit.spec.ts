/**
 * Step 3, R7.7: Whisper transcribe (family `whisper-captions`) on fal's Wizper
 * (`fal-ai/wizper`, R3.10's call and card).
 *
 * comfy_extras/nodes_audio_ml.py runs faster-whisper on the whole sound (its
 * channels' mean at 16 kHz) and makes three texts of its segments: the caption
 * track, an SRT and the plain text. The runner sends the same 16 kHz mono sound
 * as a 16-bit WAV to Wizper, asks for its segments unmerged, and makes the three
 * texts exactly as Python does given the same segments, with two fixes: the SRT
 * blocks are numbered without gaps, and a segment with no end ends at the
 * sound's end. The fixture (scripts/runner_paid_fixtures.py --group
 * local-whisper) runs the real execute with faster-whisper a stand-in that
 * answers recorded segments, and records the samples Python hands Whisper.
 *
 * The sound parts need the real tools (R5.1a): they fail, never skip, when the
 * tools are missing.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeFal, makeKit } from './__runner__/kit'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { ALL_RUNNER_FAMILIES, LOCAL_MODEL_FAMILIES, LOCAL_MODEL_REQUIRES, LOCAL_MODEL_TOOL_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { PROVIDER_TYPES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { outputKind } from '#shared/runner/values'
import {
  LOCAL_MODEL_FAMILY_OF, SERVICE_OF, WHISPER_CLASS, WHISPER_MAX_SECONDS, WHISPER_MODEL_SIZES, WHISPER_SLUG, WHISPER_WORDS, WIZPER_LANGUAGES,
  localModelCalls, serviceTooltip, whisperCalls,
} from '#shared/runner/localModels'
import { WIZPER_APP } from '#shared/runner/soundIn'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
import { PAID_RATES, paidCallUsd } from '#shared/pricing/paidRates'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { estimateUsdForNodes } from '~/lib/costEstimate'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import {
  pyRoundHalfEven, srtTime, whisperFps, whisperInput, whisperLanguage, whisperOutputs, wizperChunks, type WhisperChunk,
} from '~~/server/runner/generators/localModels'
import { whisperMono16k, whisperSilenceWav, whisperWavOfSamples, wavIsSilent, type PythonWav } from '~~/server/runner/soundWav'
import { decodeAudio } from '~~/server/media/decode'
import { mediaLimiter } from '~~/server/media/run'
import { WHISPER_RESAMPLE_SLACK, whisperSoundBound } from '~~/server/runner/localModelStart'
import { MEDIA_WORDS } from '#shared/runner/media'

/** Every tool process the tests start (fix round 1: none may outlive a closed request), and a hook on each spawn. */
const PROCS = vi.hoisted(() => ({ pids: [] as number[], onSpawn: null as null | ((tool: string, pid: number) => void) }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: ((...a: Parameters<typeof real.spawn>) => {
      const c = real.spawn(...a)
      if (c.pid) PROCS.pids.push(c.pid)
      const hook = PROCS.onSpawn
      if (hook && c.pid) { const pid = c.pid; setImmediate(() => hook(String(a[0]), pid)) }
      return c
    }) as typeof real.spawn,
  }
})

// ── The fixture ──────────────────────────────────────────────────────────────

interface WhisperCase {
  name: string; fps: string; fps_value: number; language: string; model_size: string
  segments: { start: string; end: string; text: string }[]
  captions: string; srt: string; text: string; srt_gapless: string
  language_sent: string | null; vad_filter: boolean; model_size_used: string
}
interface SoundCase {
  name: string; kind: 'pcm16' | 'float32'; rate: number; channels: number; seconds: number; seed: number
  samples: number; sha256: string; head: string[]; spots: [number, string][]
}
const FX = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-paid-local-whisper.json'), 'utf8')) as { cases: WhisperCase[]; sounds: SoundCase[] }
const SCHEMA = loadProviderSchema('fal', WHISPER_SLUG)
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-sound', 'whisper-captions'])
const ON_VIDEO: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>([...ON, 'media-video'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const USD_PER_SECOND = 0.0001

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const fromHex = (h: string) => new DataView(Uint8Array.from(Buffer.from(h, 'hex')).buffer).getFloat64(0)
const chunksOf = (c: WhisperCase): WhisperChunk[] => c.segments.map(s => ({ start: fromHex(s.start), end: fromHex(s.end), text: s.text }))
/** Wizper's answer for a case: its segments as `chunks` (`timestamp: [start, end]`). */
const answerOf = (c: WhisperCase) => ({ text: c.text, chunks: chunksOf(c).map(x => ({ timestamp: [x.start, x.end], text: x.text })), languages: ['en'] })
const caseNamed = (name: string) => FX.cases.find(c => c.name === name)!
const credits = (seconds: Record<string, unknown>) => {
  const p = priceNode(WHISPER_CLASS, { model_size: 'base', language: 'auto', fps: 30 }, { families: ON, inputSeconds: seconds })
  if ('refused' in p) throw new Error(p.refused)
  return p.credits
}

/** The standard clips, made as the fixture script makes them (its LCG). */
function clipBytes(kind: 'pcm16' | 'float32', rate: number, channels: number, frames: number, seed: number): Uint8Array {
  const n = frames * channels
  const width = kind === 'pcm16' ? 2 : 4
  const data = Buffer.alloc(n * width)
  let state = seed & 0x7FFFFFFF
  for (let i = 0; i < n; i++) {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7FFFFFFF
    const v = ((state >> 8) & 0xFFFF) - 32768
    if (kind === 'pcm16') data.writeInt16LE(v, i * 2)
    else data.writeFloatLE(v / 8192, i * 4)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(kind === 'pcm16' ? 1 : 3, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * channels * width, 28); h.writeUInt16LE(channels * width, 32); h.writeUInt16LE(width * 8, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return new Uint8Array(Buffer.concat([h, data]))
}

/** A file the user uploaded (hosted reads the user's own folder). */
function putInput(root: string, name: string, bytes: Uint8Array) {
  mkdirSync(join(root, 'input', 'user_1'), { recursive: true })
  writeFileSync(join(root, 'input', 'user_1', name), bytes)
  writeFileSync(join(root, 'input', name), bytes)
}

const whisperNode = (inputs: Record<string, unknown> = {}) => ({ class_type: WHISPER_CLASS, inputs: { audio: ['s', 0], model_size: 'base', language: 'auto', fps: 30, ...inputs } })
const loadAudio = (file = 'speech.wav') => ({ class_type: 'LoadAudio', inputs: { audio: file } })
/** Text cards reading the three outputs (a text value each). */
const readers = (): ApiPrompt => ({
  t0: { class_type: 'Text', inputs: { source: ['n', 0], text: '' } },
  t1: { class_type: 'Text', inputs: { source: ['n', 1], text: '' } },
  t2: { class_type: 'Text', inputs: { source: ['n', 2], text: '' } },
})

async function planOf(inputs: Record<string, unknown>, o: { hosted?: boolean; wav?: PythonWav; recordedPayload?: Record<string, unknown>; measured?: Record<string, unknown> } = {}) {
  const sent: string[] = []
  let made = 0
  const plan = await planNode({
    prompt: { s: loadAudio(), n: whisperNode(inputs) },
    nodeId: 'n', gateOpen: false, filesFrom: () => [], hosted: !!o.hosted, families: ON,
    toUrl: async f => `https://fal.storage/${f.filename}`,
    bytesToUrl: async (f) => { sent.push(f.filename); return `https://fal.storage/${f.filename}` },
    soundWav: async () => { made++; return o.wav ?? whisperWavOfSamples(new Float32Array(16000).fill(0.25)) },
    ...(o.recordedPayload ? { recordedPayload: o.recordedPayload } : {}),
    ...(o.measured ? { measured: o.measured } : {}),
  })
  return { plan, sent, made: () => made }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('the fixture', () => {
  it('covers blank and whitespace texts, .5 frame edges, fps 1 · 2 · 23.976 · 30 · 120, times past an hour, every kind of language, the clips', () => {
    expect(FX.cases.length).toBeGreaterThanOrEqual(20)
    expect(new Set(FX.cases.map(c => c.fps_value))).toEqual(new Set([1, 2, 23.976, 30, 120, 24]))
    expect(FX.cases.every(c => c.vad_filter === true)).toBe(true)
    // A skipped segment leaves a gap in Python's numbers (the bug the runner fixes).
    expect(caseNamed('basic · 30 fps').srt).toContain('\n3\n')
    expect(caseNamed('basic · 30 fps').srt_gapless).toContain('\n2\n')
    expect(FX.sounds.map(s => s.name)).toEqual(['mono 16 kHz 3 s', 'stereo 16 kHz 3 s', 'mono 44.1 kHz 2 s', 'stereo 48 kHz 2 s', 'stereo 44.1 kHz float, beyond ±1'])
  })

  it('the options are Python\'s', () => {
    const python = readFileSync(resolve(__dirname, '../../../comfy_extras/nodes_audio_ml.py'), 'utf8')
    expect(python).toContain(`options=[${WHISPER_MODEL_SIZES.map(s => `"${s}"`).join(', ')}]`)
    expect(python).toContain('IO.Float.Input(\n                    "fps", default=30.0, min=1.0, max=120.0')
    // Wizper's languages are its saved schema's.
    const lang = (SCHEMA.components!.schemas as Record<string, any>).WizperInput.properties.language.anyOf[0].enum as string[]
    expect(WIZPER_LANGUAGES).toEqual(lang)
  })
})

describe('the three texts, exact against Python given the segments', () => {
  it.each(FX.cases.map(c => [c.name, c] as const))('%s', (_n, c) => {
    const out = whisperOutputs(chunksOf(c), fromHex(c.fps), null)
    expect(out.captions).toBe(c.captions)
    expect(out.text).toBe(c.text)
    // The SRT: Python's blocks and times, numbered without gaps (the fix); Python's own where it left none.
    expect(out.srt).toBe(c.srt_gapless)
    if (chunksOf(c).every(x => x.text.trim() !== '')) expect(out.srt).toBe(c.srt)
    // Read back from Wizper's answer: the same.
    expect(whisperOutputs(wizperChunks(JSON.parse(JSON.stringify(answerOf(c)))), c.fps_value, null)).toEqual(out)
  })

  it('half to even, as Python\'s round; SRT times by the millisecond, past an hour', () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, 3.4999, 3.5].map(pyRoundHalfEven)).toEqual([0, 2, 2, -0, -2, 3, 4])
    expect([srtTime(0), srtTime(1.0005), srtTime(3725.0625), srtTime(360000)]).toEqual(['00:00:00,000', '00:00:01,000', '01:02:05,062', '100:00:00,000'])
  })

  it('a segment with no end ends at the sound\'s end (fix); one with no start starts where the one before ended', () => {
    const chunks = wizperChunks({ chunks: [{ timestamp: [0, 1.5], text: ' a' }, { timestamp: [null, null], text: ' b ' }] })
    expect(whisperOutputs(chunks, 10, 4.25)).toEqual({ captions: '0 15 a\n15 42 b', srt: '1\n00:00:00,000 --> 00:00:01,500\na\n\n2\n00:00:01,500 --> 00:00:04,250\nb\n', text: 'a b' })
    // A text-only answer: one caption over the whole sound.
    expect(whisperOutputs(wizperChunks({ text: ' all ' }), 30, 2)).toEqual({ captions: '0 60 all', srt: '1\n00:00:00,000 --> 00:00:02,000\nall\n', text: 'all' })
    for (const bad of [null, 'x', [], { chunks: 'no' }]) expect(() => wizperChunks(bad), JSON.stringify(bad)).toThrow(WHISPER_WORDS.noAnswer)
  })
})

describe('the request, against the saved schema', () => {
  it('Wizper\'s request for every case: transcribe, version 3, segments unmerged, the language only where Wizper lists it', () => {
    for (const c of FX.cases) {
      const p = whisperInput({ language: c.language, model_size: c.model_size, fps: c.fps_value }, 'https://fal.storage/whisper.wav')
      expect(checkPayload(SCHEMA, p), c.name).toEqual([])
      // Python's language where Wizper knows it (in lower case: Python's `EN` would fail faster-whisper);
      // a code Wizper doesn't list is detected by Wizper instead.
      const py = c.language_sent
      const want = py === null || !WIZPER_LANGUAGES.includes(py.toLowerCase()) ? undefined : py.toLowerCase()
      expect(p, c.name).toEqual({ audio_url: 'https://fal.storage/whisper.wav', task: 'transcribe', version: '3', ...(want ? { language: want } : {}), chunk_level: 'segment', merge_chunks: false })
    }
    expect([whisperLanguage(' fr '), whisperLanguage('EN'), whisperLanguage('xx'), whisperLanguage('zh-CN'), whisperLanguage(' Auto '), whisperLanguage(undefined)]).toEqual(['fr', 'en', null, null, null, null])
    expect([whisperFps(23.976), whisperFps('24'), whisperFps(undefined)]).toEqual([23.976, 24, 30])
  })

  it('through planNode: one fal call, the WAV handed off as `whisper.wav`, three text values from the answer, no ui', async () => {
    const c = caseNamed('fps 23.976')
    const { plan, sent } = await planOf({ language: ' fr ', fps: c.fps_value })
    const p = plan as Extract<NodePlan, { kind: 'provider' }>
    expect([p.kind, p.provider, p.endpoint, p.media]).toEqual(['provider', 'fal', WIZPER_APP, 'value'])
    expect(sent).toEqual(['whisper.wav'])
    expect(p.payload).toMatchObject({ audio_url: 'https://fal.storage/whisper.wav', language: 'fr' })
    expect(p.valuesOf!(answerOf(c), JSON.stringify(answerOf(c)))).toEqual({
      0: { kind: 'text', text: c.captions }, 1: { kind: 'text', text: c.srt_gapless }, 2: { kind: 'text', text: c.text },
    })
    expect(p.uiFor([], undefined as never)).toBeNull()
  })

  it('a sound Whisper hears nothing in: no call, three empty texts (free)', async () => {
    const { plan, sent } = await planOf({}, { wav: whisperSilenceWav() })
    expect(plan.kind).toBe('derive')
    expect(sent).toEqual([])
    const made = await (plan as Extract<NodePlan, { kind: 'derive' }>).derive(undefined as never)
    expect(made.values).toEqual({ 0: { kind: 'text', text: '' }, 1: { kind: 'text', text: '' }, 2: { kind: 'text', text: '' } })
    expect(wavIsSilent(whisperWavOfSamples(new Float32Array(0)))).toBe(true)
    expect(wavIsSilent(whisperWavOfSamples(Float32Array.of(0, 0.001)))).toBe(false)
  })

  it('a sound longer than this place sends: refused before the hand-off and the call', async () => {
    const long = { ...whisperWavOfSamples(Float32Array.of(0.5)), seconds: WHISPER_MAX_SECONDS.hosted + 1 }
    await expect(planOf({}, { hosted: true, wav: long })).rejects.toThrow(WHISPER_WORDS.tooLong)
    // On this computer the hour is allowed.
    expect((await planOf({}, { wav: long })).sent).toEqual(['whisper.wav'])
  })

  it('a resumed node sends its written-down request and makes no WAV again', async () => {
    const recorded = { audio_url: 'https://fal.storage/whisper.wav', task: 'transcribe', version: '3', chunk_level: 'segment', merge_chunks: false }
    const { plan, sent, made } = await planOf({}, { recordedPayload: recorded, measured: { audio: 2 } })
    expect((plan as Extract<NodePlan, { kind: 'provider' }>).payload).toBe(recorded)
    expect([sent, made()]).toEqual([[], 0])
    // A segment with no end ends at the measured sound's end.
    expect((plan as Extract<NodePlan, { kind: 'provider' }>).valuesOf!({ chunks: [{ timestamp: [1, null], text: 'x' }] }, null)[0]).toEqual({ kind: 'text', text: '30 60 x' })
  })
})

describe('the sound sent: Python\'s 16 kHz mono (`_audio_to_mono16k`)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-clips-'))
  it.each(FX.sounds.map(s => [s.name, s] as const))('%s', async (_n, s) => {
    await requireMediaTools()
    const path = join(dir, `${s.seed}.wav`)
    writeFileSync(path, clipBytes(s.kind, s.rate, s.channels, s.rate * s.seconds, s.seed))
    const sound = await decodeAudio(path, { decoder: 'load', userId: null, roots: [dir], maxSamples: 100_000_000 })
    const mono = await whisperMono16k(sound)
    expect(mono.length).toBe(s.samples)
    if (s.rate === 16000) {
      // No resample: the channels' mean, bit for bit.
      expect(sha(new Uint8Array(mono.buffer, mono.byteOffset, mono.byteLength))).toBe(s.sha256)
    }
    else {
      // torchaudio's resample (R5.3's port, a library kernel): within a millionth on every sample checked.
      const at = [...s.head.map((v, i) => [i, v] as const), ...s.spots]
      expect(at.length).toBeGreaterThan(64)
      for (const [i, v] of at) expect(Math.abs(mono[i]! - fromHex(v)), `sample ${i}`).toBeLessThanOrEqual(1e-6)
    }
    // The WAV: 16-bit mono at 16 kHz, its seconds the samples / 16,000.
    const w = whisperWavOfSamples(mono)
    expect([w.rate, w.channels, w.frames, w.seconds, w.wav.length]).toEqual([16000, 1, s.samples, s.samples / 16000, 44 + 2 * s.samples])
  }, 120_000)
})

describe('the price: R3.10\'s Wizper card, by the seconds sent', () => {
  it('measured: those seconds; not measured: the longest sound where it runs (hosted 30 minutes, this computer an hour)', () => {
    expect(PAID_RATES[WIZPER_APP]).toMatchObject({ unit: 'per_input_second', perSecond: USD_PER_SECOND, confidence: 'estimate' })
    expect(whisperCalls({ audio: 12.5 })).toEqual({ steps: [{ call: { endpoint: WIZPER_APP, inputSeconds: 12.5 }, times: 1 }] })
    expect(whisperCalls({ place: 'hosted' }).steps?.[0]?.call.inputSeconds).toBe(1800)
    expect(whisperCalls({ framesUpTo: 'hosted' }).steps?.[0]?.call.inputSeconds).toBe(1800)
    expect(whisperCalls({ framesUpTo: 'local' }).steps?.[0]?.call.inputSeconds).toBe(3600)
    expect(whisperCalls(null).steps?.[0]?.call.inputSeconds).toBe(3600)
    expect(localModelCalls(WHISPER_CLASS, 300, {}, { audio: 3 })).toEqual(whisperCalls({ audio: 3 }))
    expect(credits({ audio: 60 })).toBe(creditsForUsd(paidCallUsd({ endpoint: WIZPER_APP, inputSeconds: 60 })!))
    expect(credits({ place: 'hosted' })).toBe(creditsForUsd(0.18))
    expect(credits({ place: 'local' })).toBe(creditsForUsd(0.36))
    // Family off: not priced here (ComfyUI runs the local model, free).
    expect('refused' in priceNode(WHISPER_CLASS, {}, { families: new Set<RunnerFamily>(['cards', 'media-sound']) })).toBe(true)
    expect(serviceTooltip(WHISPER_CLASS, ON)).toBe('Runs on fal')
    expect(SERVICE_OF[WHISPER_CLASS]).toBe('fal')
  })

  it('the canvas shows "up to" the ceiling where it runs: never below the hold', () => {
    const n = { id: 'n', type: WHISPER_CLASS, title: 'Whisper', badgeExpr: null, category: null, widgetDefs: [{ name: 'model_size' }, { name: 'language' }, { name: 'fps' }], widgetsValues: ['base', 'auto', 30], linkedInputs: ['audio'], inputPixels: null, inputSeconds: null, pictures: null }
    const hosted = estimateUsdForNodes([n as never], { hosted: true, families: ON })!
    expect(hosted.breakdown[0]!.upTo).toBe(true)
    expect(hosted.hostedCredits).toBe(credits({ place: 'hosted' }) + 1)
    const local = estimateUsdForNodes([n as never], { families: ON })!
    expect(local.breakdown[0]!.usd).toBeCloseTo(0.36, 8)
  })
})

describe('through the engine (ComfyUI off): held, sent, charged', () => {
  it('Load audio → Whisper (hosted): the start measures the sound; the fake Wizper gets the request; three texts; held = charged', async () => {
    await requireMediaTools()
    const c = caseNamed('fps 23.976')
    const fal = createFakeFal({ answer: () => answerOf(c) })
    const k = makeKit({ hosted: true, fal, deps: { families: () => ON } })
    putInput(k.root, 'speech.wav', clipBytes('pcm16', 44100, 2, 44100 * 2, 7201))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ s: loadAudio(), n: whisperNode({ fps: c.fps_value, language: 'en' }), ...readers() }], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['s', 'n', 't0', 't1', 't2']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(take.nodes.n!.values).toEqual({ 0: { kind: 'text', text: c.captions }, 1: { kind: 'text', text: c.srt_gapless }, 2: { kind: 'text', text: c.text } })
    expect(take.nodes.t1!.values?.[0]).toEqual({ kind: 'text', text: c.srt_gapless })
    expect(fal.submitted().length).toBe(1)
    const sentPayload = fal.submitted()[0]!.payload
    expect(checkPayload(SCHEMA, sentPayload)).toEqual([])
    expect(sentPayload).toMatchObject({ audio_url: 'https://fal.storage/whisper.wav', language: 'en', chunk_level: 'segment', merge_chunks: false })
    // The WAV handed off: 2 s of 16 kHz mono.
    const wav = k.upload.mock.calls.map(x => x[0] as Uint8Array).find(b => b.length === 44 + 2 * 32000)
    expect(wav).toBeDefined()
    // Fix round 1: bounded before the hold from the file's header (2 s, plus a second), nothing decoded;
    // the turn measures the 2 s it sends and is charged on them.
    const upTo = take.measured?.n?.seconds.audioUpTo
    expect(take.measured?.n).toEqual({ seconds: { place: 'hosted', audioUpTo: upTo }, sha: {} })
    expect(upTo).toBeCloseTo(3 + WHISPER_RESAMPLE_SLACK, 6)
    expect(take.nodes.n!.credits).toBe(credits({ audio: 2 }))
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[credits({ audioUpTo: upTo }), credits({ audio: 2 })]])
    expect(credits({ audio: 2 })).toBeLessThanOrEqual(credits({ audioUpTo: upTo }))
  }, 120_000)

  it('Auto subtitle up to Caption track, hosted: Load video → Get video components → Whisper (its rate wired) → a Text card; held on the video\'s sound bound, charged the seconds sent', async () => {
    await requireMediaTools()
    const clip = 'v_stereo_aac.mp4'
    const fal = createFakeFal({ answer: () => ({ text: 'hi', chunks: [{ timestamp: [0, 0.5], text: ' hi ' }], languages: ['en'] }) })
    const k = makeKit({ hosted: true, fal, deps: { families: () => ON_VIDEO } })
    writeFileSync(join(k.root, 'input', clip), readFileSync(clipPath(clip)))
    const p: ApiPrompt = {
      l: { class_type: 'LoadVideo', inputs: { file: clip } },
      g: { class_type: 'GetVideoComponents', inputs: { video: ['l', 0] } },
      n: { class_type: WHISPER_CLASS, inputs: { audio: ['g', 1], model_size: 'base', language: 'auto', fps: ['g', 2] } },
      t0: { class_type: 'Text', inputs: { source: ['n', 0], text: '' } },
    }
    expect(isRunnerEligible(p, ON_VIDEO)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['l', 'g', 'n', 't0']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    // Fix round 1: the sound is made in the run, bounded before the hold by the video file's sound stream
    // (its header, plus a second); the hold is that, not the hosted ceiling.
    const upTo = take.measured?.n?.seconds.audioUpTo as number
    expect(take.measured?.n).toEqual({ seconds: { place: 'hosted', audioUpTo: upTo }, sha: {} })
    expect(upTo).toBeGreaterThan(1)
    expect(upTo).toBeLessThan(WHISPER_MAX_SECONDS.hosted)
    const fps = (take.nodes.g!.values![2] as { kind: 'number'; value: number }).value
    expect(take.nodes.n!.values?.[0]).toEqual({ kind: 'text', text: `0 ${Math.max(pyRoundHalfEven(0.5 * fps), 1)} hi` })
    const seconds = (k.upload.mock.calls.map(x => x[0] as Uint8Array).find(b => b.length > 44 && b[22] === 1 && new DataView(b.buffer, b.byteOffset).getUint32(24, true) === 16000)!.length - 44) / 2 / 16000
    expect(seconds).toBeGreaterThan(0)
    const holds = [...k.ledger.holds.values()]
    expect(holds.map(h => h.credits)).toEqual([credits({ place: 'hosted', audioUpTo: upTo })])
    expect(seconds).toBeLessThanOrEqual(upTo)
    expect(take.nodes.n!.credits).toBe(credits({ audio: seconds }))
    expect(holds.map(h => h.actual)).toEqual([credits({ audio: seconds })])
  }, 120_000)

  it('an empty Audio card (1 s of silence): no call, Whisper charged nothing', async () => {
    const fal = createFakeFal({ answer: () => ({ text: 'never', chunks: [] }) })
    const k = makeKit({ hosted: true, fal, deps: { families: () => ON } })
    const card = { class_type: 'Audio', inputs: { audio: '', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0' } }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ s: card, n: whisperNode(), ...readers() }], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    expect(take.nodes.n!.status, take.nodes.n!.error ?? '').toBe('done')
    expect(take.nodes.n!.values?.[2]).toEqual({ kind: 'text', text: '' })
    expect(fal.submitted()).toEqual([])
    // The start knew the silence (1 s): held at its price plus the card's render credit; settled at the
    // render credit alone (Whisper made no call).
    expect(take.measured?.n?.seconds).toMatchObject({ audio: 1, place: 'hosted' })
    expect(take.nodes.n!.credits).toBe(0)
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[credits({ audio: 1 }) + 1, 1]])
  }, 60_000)

  it('Stop during the call: the call cancelled, the hold released', async () => {
    await requireMediaTools()
    const fal = createFakeFal({ answer: () => ({ text: '', chunks: [] }) })
    fal.holdNext(1)
    const k = makeKit({ hosted: true, fal, deps: { families: () => ON } })
    putInput(k.root, 'speech.wav', clipBytes('pcm16', 16000, 1, 16000, 7202))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ s: loadAudio(), n: whisperNode(), ...readers() }], ...START })
    for (let i = 0; i < 4000 && fal.submitted().length < 1; i++) await new Promise(r => setTimeout(r, 5))
    expect(fal.submitted().length).toBe(1)
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)
    expect(fal.submitted()[0]!.cancelled).toBe(true)
    expect([...k.ledger.holds.values()].map(h => (h.state === 'released' ? 0 : h.actual))).toEqual([0])
  }, 60_000)

  it('hosted, a loaded sound longer than 30 minutes: refused plainly before any hold (fix round 1: never the engine), from its header', async () => {
    await requireMediaTools()
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    putInput(k.root, 'long.wav', clipBytes('pcm16', 8000, 1, 8000 * (WHISPER_MAX_SECONDS.hosted + 1), 7203))
    const err = await k.engine.startRun({ userId: k.userId, takes: [{ s: loadAudio('long.wav'), n: whisperNode(), ...readers() }], ...START }).then(() => null, (e: Error & { data?: { reason?: string } }) => e)
    expect(err?.message).toBe(WHISPER_WORDS.tooLong)
    expect((err as { data?: { reason?: string } })?.data?.reason ?? (err as { reason?: string })?.reason).not.toBe(RUNNER_NOT_ELIGIBLE)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  }, 180_000)
})

describe('fix round 1 · Finding 2: a sound made in the run is bounded before the hold, from its maker', () => {
  const FX_ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>([...ON, 'sound-effects'])

  it('an R6 sound-effect chain from a long source into Whisper (hosted): refused plainly before the hold; nothing upstream charged or run', async () => {
    await requireMediaTools()
    const fal = createFakeFal({ answer: () => ({ text: '', chunks: [] }) })
    const k = makeKit({ hosted: true, fal, deps: { families: () => FX_ON } })
    // 20 minutes, joined to itself: 40 minutes, past the hosted 30.
    putInput(k.root, 'long.wav', clipBytes('pcm16', 8000, 1, 8000 * 20 * 60, 7301))
    const p: ApiPrompt = {
      s: loadAudio('long.wav'),
      c: { class_type: 'AudioConcat', inputs: { audio1: ['s', 0], audio2: ['s', 0], direction: 'after' } },
      v: { class_type: 'AudioAdjustVolume', inputs: { audio: ['c', 0], volume: 1 } },
      n: { ...whisperNode(), inputs: { ...whisperNode().inputs, audio: ['v', 0] } },
      ...readers(),
    }
    expect(isRunnerEligible(p, FX_ON)).toBe(true)
    const err = await k.engine.startRun({ userId: k.userId, takes: [p], ...START }).then(() => null, (e: Error) => e)
    expect(err?.message).toBe(WHISPER_WORDS.tooLong)
    expect((err as { data?: { reason?: string } })?.data?.reason ?? (err as { reason?: string })?.reason).not.toBe(RUNNER_NOT_ELIGIBLE)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(fal.submitted()).toEqual([])
  }, 120_000)

  it('the same chain from a short source: held on the chain\'s bound, charged the seconds sent', async () => {
    await requireMediaTools()
    const fal = createFakeFal({ answer: () => ({ text: 'a', chunks: [{ timestamp: [0, 1], text: 'a' }] }) })
    const k = makeKit({ hosted: true, fal, deps: { families: () => FX_ON } })
    putInput(k.root, 'short.wav', clipBytes('pcm16', 8000, 1, 8000, 7302))
    const p: ApiPrompt = {
      s: loadAudio('short.wav'),
      c: { class_type: 'AudioConcat', inputs: { audio1: ['s', 0], audio2: ['s', 0], direction: 'after' } },
      n: { ...whisperNode(), inputs: { ...whisperNode().inputs, audio: ['c', 0] } },
      ...readers(),
    }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    expect(take.nodes.n!.status, take.nodes.n!.error ?? '').toBe('done')
    // Two 1 s sources, each bounded at 2 s by its header: 4 s, held on that.
    expect(take.measured?.n?.seconds.audioUpTo).toBeCloseTo(4 + WHISPER_RESAMPLE_SLACK, 6)
    const sent = take.measured?.n?.seconds.audioUpTo as number
    expect(take.nodes.n!.credits).toBe(credits({ audio: 2 }))
    expect(take.nodes.n!.credits).toBeLessThanOrEqual(credits({ audioUpTo: sent }))
  }, 120_000)

  it('whisperSoundBound: the sound start pass\'s shapes; Generate music by its duration; speech and a cloned voice can\'t be bounded', () => {
    const shapes = new Map([['s:0', { rate: 8000, channels: 1, samples: 16000, exact: false }]])
    const p: ApiPrompt = {
      s: loadAudio(),
      g: { class_type: 'ComfyGateNode', inputs: { data_in: ['s', 0], bypass: true } },
      m: { class_type: 'GenerateMusicNode', inputs: { model: 'MusicGen', prompt: 'x', duration: 8 } },
      w: { class_type: 'GenerateMusicNode', inputs: { model: 'MusicGen', prompt: 'x', duration: ['x', 0] } },
      a: { class_type: 'Audio', inputs: { source: ['m', 0], audio: '' } },
      sp: { class_type: 'GenerateSpeechNode', inputs: { text: 'Hello.' } },
      cl: { class_type: 'CloneSingingVoiceNode', inputs: { audio: ['s', 0] } },
    }
    expect(whisperSoundBound(p, ['s', 0], shapes)).toBe(2 + WHISPER_RESAMPLE_SLACK)
    expect(whisperSoundBound(p, ['g', 0], shapes)).toBe(2 + WHISPER_RESAMPLE_SLACK)
    expect(whisperSoundBound(p, ['m', 0], shapes)).toBe(9)
    expect(whisperSoundBound(p, ['a', 0], shapes)).toBe(9)
    expect(whisperSoundBound(p, ['w', 0], shapes)).toBe(31)
    expect(whisperSoundBound(p, ['sp', 0], shapes)).toBeNull()
    expect(whisperSoundBound(p, ['cl', 0], shapes)).toBeNull()
    // The hold reads the bound, never past the place's cap.
    expect(whisperCalls({ audioUpTo: 9, place: 'hosted' }).steps?.[0]?.call.inputSeconds).toBe(9)
    expect(whisperCalls({ audioUpTo: 5000, place: 'hosted' }).steps?.[0]?.call.inputSeconds).toBe(1800)
    expect(whisperCalls({ audio: 2, audioUpTo: 9 }).steps?.[0]?.call.inputSeconds).toBe(2)
  })
})

describe('fix round 1 · Finding 1: a request closed while the run is being started leaves nothing running', () => {
  const pids = (from: number) => PROCS.pids.slice(from)
  async function allGone(list: number[], ms = 1000) {
    const t0 = Date.now()
    for (const pid of list) {
      while (Date.now() - t0 < ms) {
        try { process.kill(pid, 0) }
        catch { break }
        await new Promise(r => setTimeout(r, 10))
      }
      expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    }
  }

  it.each([
    ['Transcribe audio (R3.10): its WAV decoded at the start (ffmpeg)', 'TranscribeAudioNode', 'ffmpeg'],
    ['Whisper transcribe: its sound\'s header probed at the start (ffprobe)', WHISPER_CLASS, 'ffprobe'],
  ] as const)('%s — closed mid-way: refused, no tool process left within a second, the slot given back, nothing held', async (_n, cls, tool) => {
    await requireMediaTools()
    const families = new Set<RunnerFamily>([...ON, 'sound-in'])
    const k = makeKit({ hosted: true, deps: { families: () => families } })
    putInput(k.root, 'speech.wav', clipBytes('pcm16', 48000, 2, 48000 * 50, 7401))
    const n = cls === WHISPER_CLASS ? whisperNode() : { class_type: cls, inputs: { model: 'Whisper', audio: ['s', 0], language: 'auto', translate: false } }
    const ctl = new AbortController()
    const before = PROCS.pids.length
    // Checked BEFORE the clean-up below kills anything: the request's signal itself ended every tool process.
    const check = async () => allGone(pids(before))
    let seen = 0
    // The tool is frozen mid-work (SIGSTOP) as the request closes: only the request's signal can end it
    // (Stop kills with SIGKILL, which reaches a stopped process); without it the start would wait for ever.
    PROCS.onSpawn = (path, pid) => {
      if (!path.includes(tool) || seen++) return
      try { process.kill(pid, 'SIGSTOP') } catch { /* already done */ }
      ctl.abort()
    }
    try {
      const started = k.engine.startRun({ userId: k.userId, takes: [{ s: loadAudio(), n, ...(cls === WHISPER_CLASS ? readers() : {}) }], ...START, signal: ctl.signal }).then(() => null, (e: Error) => e)
      const err = await Promise.race([started, new Promise<'hung'>(r => setTimeout(() => r('hung'), 5000))])
      expect(seen).toBeGreaterThan(0)
      expect(err === 'hung' ? 'hung' : err?.message).toBe(MEDIA_WORDS.stopped)
      await check()
    }
    finally {
      PROCS.onSpawn = null
      for (const pid of pids(before)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    }
    expect(pids(before).length).toBeGreaterThan(0)
    expect(mediaLimiter().pending(k.userId)).toBe(0)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  }, 60_000)
})

describe('the row, the family and the families-off invariant (rule 15)', () => {
  it('off by default, the sound-tools family chain; taken with a sound from any runner sound; three text slots; a fal route with no backup', () => {
    expect(LOCAL_MODEL_FAMILY_OF[WHISPER_CLASS]).toBe('whisper-captions')
    expect(LOCAL_MODEL_REQUIRES['whisper-captions']).toBe('media-sound')
    expect(LOCAL_MODEL_TOOL_FAMILIES).toContain('whisper-captions')
    expect(PROVIDER_TYPES.has(WHISPER_CLASS)).toBe(true)
    expect(RUNNER_ROUTES[WHISPER_CLASS]).toMatchObject({ backup: null })
    const p: ApiPrompt = { s: loadAudio(), n: whisperNode(), ...readers() }
    expect(isRunnerEligible(p, ON)).toBe(true)
    for (const slot of [0, 1, 2]) expect(outputKind(p, ['n', slot], outputKindsFor(ON))).toBe('text')
    // A wired language (text) and a wired rate (a number) are read at the node's turn.
    const wired: ApiPrompt = { ...p, l: { class_type: 'PrimitiveString', inputs: { value: 'fr' } }, f: { class_type: 'PrimitiveFloat', inputs: { value: 24 } }, n: whisperNode({ language: ['l', 0], fps: ['f', 0] }) }
    expect(runnerTakesNode(wired, 'n', ON)).toBe(true)
    // A typed rate or model size ComfyUI refuses, a wired model size: the engine's.
    for (const bad of [{ fps: 0.5 }, { fps: 121 }, { model_size: 'huge' }, { model_size: ['l', 0] }]) expect(runnerTakesNode({ ...wired, n: whisperNode(bad) }, 'n', ON), JSON.stringify(bad)).toBe(false)
    // A picture isn't a sound.
    expect(runnerTakesNode({ s: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, n: whisperNode() }, 'n', ON)).toBe(false)
    // Without its family, or its chain, it is left to the engine and named.
    for (const fam of [new Set<RunnerFamily>(['cards', 'media-sound']), new Set<RunnerFamily>(['cards', 'whisper-captions'])]) {
      expect(runnerTakesNode(p, 'n', fam)).toBe(false)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id })).toContain('n')
    }
  })

  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but R7\'s', ALL_RUNNER_FAMILIES.filter(x => !LOCAL_MODEL_FAMILIES.includes(x))],
  ]
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, n.class_type === WHISPER_CLASS ? { ...n, class_type: 'WhisperTranscribeBefore' } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (p[id]!.class_type !== WHISPER_CLASS) expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
      }
      expect(outputKindsFor(families)[WHISPER_CLASS]).toBeUndefined()
    }
  }

  it('over one synthetic graph per chain (Load audio, an Audio card, Auto subtitle\'s whole workflow)', () => {
    sameAsBefore({ s: loadAudio(), n: whisperNode(), ...readers() }, 'Load audio → Whisper → Text cards')
    sameAsBefore({ s: { class_type: 'Audio', inputs: { audio: 'a.wav', export: false, filename_prefix: 'a', format: 'flac', quality: 'V0' } }, n: whisperNode() }, 'an Audio card → Whisper')
    sameAsBefore({
      1: { class_type: 'LoadVideo', inputs: { file: 'a.mp4' } },
      2: { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
      3: { class_type: WHISPER_CLASS, inputs: { audio: ['2', 1], model_size: 'base', language: 'auto', fps: ['2', 2] } },
      4: { class_type: 'CaptionTrack', inputs: { frames: ['2', 0], captions: ['3', 0], font_size: 44, color: '#ffffff', outline_color: '#000000', outline_width: 3, position: 'bottom', y_inset: 0.08 } },
      5: { class_type: 'CreateVideo', inputs: { images: ['4', 0], fps: ['2', 2], audio: ['2', 1] } },
      6: { class_type: 'SaveVideo', inputs: { video: ['5', 0], filename_prefix: 'auto_subtitle', format: 'auto', codec: 'auto' } },
    }, 'Auto subtitle')
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    let withIt = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const cv of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(cv.workflow as never, catalog) }
        catch { continue }
        graphs++
        if (Object.values(p).some(n => n.class_type === WHISPER_CLASS)) withIt++
        sameAsBefore(p, uuid)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`whisper-captions families-off invariant: ${graphs} saved graphs, ${withIt} with Whisper transcribe`)
  }, 600_000)
})
