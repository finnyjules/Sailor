/**
 * Step 3, R7.8: Vocal separator (family `vocal-split`) on Replicate's demucs
 * (`ryan5453/demucs`) in two-stem mode.
 *
 * comfy_extras/nodes_audio_ml.py takes batch 0 of the sound, repeats mono to
 * stereo, cuts more than two channels to two, resamples to Demucs' 44.1 kHz,
 * runs htdemucs and hands on the vocals and the sum of the other stems. The
 * runner sends Python's stereo at the sound's own rate as a 16-bit FLAC
 * (the service resamples, as Python does), asks for the vocals and
 * `no_vocals` (the sum of the other stems) as float32 WAVs, and keeps them as
 * they come. The fixture (scripts/runner_paid_fixtures.py --group
 * local-vocals) runs the real execute with Demucs a stand-in, and records
 * what Python hands it and what it returns.
 *
 * The sound parts need the real tools (R5.1a): they fail, never skip, when the
 * tools are missing.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeReplicate, makeKit } from './__runner__/kit'
import { requireMediaTools } from './__runner__/mediaParity'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import type { ApiPrompt } from '#shared/runner/graph'
import { ALL_RUNNER_FAMILIES, LOCAL_MODEL_FAMILIES, LOCAL_MODEL_REQUIRES, LOCAL_MODEL_TOOL_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { PROVIDER_TYPES, SOUND_OUTPUTS, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import {
  LOCAL_MODEL_FAMILY_OF, SERVICE_OF, VOCALS_CLASS, VOCALS_MAX_SECONDS, VOCALS_MODELS, VOCALS_MODEL_SENT, VOCALS_RATE, VOCALS_SHIFTS, VOCALS_SLUG,
  VOCALS_CEILING_SECONDS, VOCALS_WORDS, localModelCalls, serviceTooltip, vocalsCalls, vocalsStemsReadable, vocalsWork,
} from '#shared/runner/localModels'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { PAID_RATES, paidCallUsd } from '#shared/pricing/paidRates'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { estimateUsdForNodes } from '~/lib/costEstimate'
import { planNode, type NodePlan, type PipelineIO } from '~~/server/runner/executors'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { vocalsInput, vocalsStemMaxBytes, vocalsStemUrls } from '~~/server/runner/generators/localModels'
import { vocalsSilence, vocalsSilentStems, vocalsSound, vocalsStereo, type VocalsSound } from '~~/server/runner/soundWav'
import { cardSilenceFor } from '~~/server/runner/soundInMedia'
import { localModelStartProblems, maskBytesBound, soundBoundOf } from '~~/server/runner/localModelStart'
import { keptBatchBound } from '~~/server/runner/video/start'
import { soundShapes } from '~~/server/runner/video/soundShapes'
import { decodeAudio, type DecodedSound } from '~~/server/media/decode'
import { floatWav } from '~~/server/media/encode'
import { mediaLimiter } from '~~/server/media/run'
import { createMemoryKeptBytes, type KeptBytes } from '~~/server/runner/keptBytes'
import { KEPT_ROOM_MEDIA_REFUSED } from '~~/server/runner/engine'

/** Every tool process the tests start (none may outlive a closed request), and a hook on each spawn. */
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

interface Facts { shape: number[]; sha256: string; head: string[]; spots: [number, string][] }
interface SoundCase {
  name: string; kind: 'pcm16' | 'float32'; rate: number; channels: number; seconds: number; seed: number
  sent: Facts; rate_sent: number; split: boolean; shifts: number; model: string; get_model: string[]
  vocals: Facts & { rate: number }; instrumental: Facts & { rate: number }; vocals_is_stem: boolean; instrumental_vs_no_vocals_max_abs: string
}
interface Fixture {
  sounds: SoundCase[]
  resampled: { rate_in: number; frames_in: number; sent_shape: number[]; out_rate: number; out_shape: number[] }
  settings: { model: string; shifts: number; get_model: string[]; model_used: string; shifts_sent: number; split: boolean }[]
  options: { model: string[]; model_default: string; shifts: { default: number; min: number; max: number }; inputs: string[]; outputs: string[] }
}
const FX = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-paid-local-vocals.json'), 'utf8')) as Fixture
const SCHEMA = loadProviderSchema('replicate', VOCALS_SLUG)
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-sound', 'vocal-split'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const fromHex = (h: string) => new DataView(Uint8Array.from(Buffer.from(h, 'hex')).buffer).getFloat64(0)
const credits = (seconds: Record<string, unknown>, inputs: Record<string, unknown> = { model: 'htdemucs', shifts: 1 }) => {
  const p = priceNode(VOCALS_CLASS, inputs, { families: ON, inputSeconds: seconds })
  if ('refused' in p) throw new Error(p.refused)
  return p.credits
}
/** A sound's channels, channel after channel, as float32 bytes (torch's [C, T] contiguous). */
const channelMajor = (s: DecodedSound) => {
  const n = s.channels[0]?.length ?? 0
  const out = new Float32Array(s.channels.length * n)
  s.channels.forEach((ch, c) => out.set(ch, c * n))
  return new Uint8Array(out.buffer)
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

/** A stem as Replicate's demucs sends it (`wav_format: 'float32'`): a stereo float32 WAV at 44.1 kHz. */
function stemWav(seconds: number, level: number): Uint8Array {
  const n = Math.round(seconds * VOCALS_RATE)
  const ch = () => Float32Array.from({ length: n }, (_, i) => level * Math.sin(i / 7))
  return floatWav({ rate: VOCALS_RATE, channels: [ch(), ch()] })
}

const vocalsNode = (inputs: Record<string, unknown> = {}) => ({ class_type: VOCALS_CLASS, inputs: { audio: ['s', 0], model: 'htdemucs', shifts: 1, ...inputs } })
const loadAudio = (file = 'song.wav') => ({ class_type: 'LoadAudio', inputs: { audio: file } })
/** Karaoke's two saves (KaraokeMakerApp.vue). */
const saves = (): ApiPrompt => ({
  v: { class_type: 'SaveAudioMP3', inputs: { audio: ['n', 0], filename_prefix: 'karaoke_vocals', quality: 'V0' } },
  i: { class_type: 'SaveAudioMP3', inputs: { audio: ['n', 1], filename_prefix: 'karaoke_instrumental', quality: 'V0' } },
})
const STEM_URLS = { vocals: 'https://replicate.delivery/vocals.wav', no_vocals: 'https://replicate.delivery/no_vocals.wav' }
/** Downloads of the two stems (`seconds` long), everything else as the kit does. */
const stemDownload = (seconds: number) => async (url: string) => {
  if (url === STEM_URLS.vocals) return { bytes: stemWav(seconds, 0.5), contentType: 'audio/wav' }
  if (url === STEM_URLS.no_vocals) return { bytes: stemWav(seconds, 0.25), contentType: 'audio/wav' }
  return { bytes: new TextEncoder().encode(url), contentType: 'image/png' }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('the fixture', () => {
  it('mono, stereo, 6-channel and a float clip beyond ±1; the node\'s options are Python\'s', () => {
    expect(FX.sounds.map(s => s.name)).toEqual(['mono 44.1 kHz 1 s', 'stereo 48 kHz 1 s', '6-channel 44.1 kHz 1 s', 'stereo 22.05 kHz float, beyond ±1'])
    expect(FX.options).toEqual({ model: [...VOCALS_MODELS], model_default: 'htdemucs', shifts: { ...VOCALS_SHIFTS }, inputs: ['audio', 'model', 'shifts'], outputs: ['vocals', 'instrumental'] })
    // Python asks for the model by its name, passes shifts through, and always splits.
    for (const s of FX.settings) expect([s.get_model, s.model_used, s.shifts_sent, s.split]).toEqual([[s.model], s.model, s.shifts, true])
  })

  it('Python hands on the vocals stem itself and all the stems minus it; Replicate\'s no_vocals (the other stems summed) is the same within float rounding', () => {
    for (const s of FX.sounds) {
      expect(s.vocals_is_stem, s.name).toBe(true)
      expect(fromHex(s.instrumental_vs_no_vocals_max_abs), s.name).toBeLessThanOrEqual(1e-6)
      expect([s.vocals.shape, s.instrumental.shape], s.name).toEqual([[1, ...s.sent.shape], [1, ...s.sent.shape]])
    }
    // Python resamples to Demucs' 44.1 kHz and its stems come out at that rate: the service does the same.
    expect(FX.resampled).toMatchObject({ rate_in: 48000, out_rate: VOCALS_RATE, sent_shape: [1, 2, VOCALS_RATE], out_shape: [1, 2, VOCALS_RATE] })
  })
})

describe('the sound sent: Python\'s channels, at the sound\'s own rate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vocals-clips-'))
  it.each(FX.sounds.map(s => [s.name, s] as const))('%s: the same float32 samples Python hands Demucs, bit for bit', async (_n, s) => {
    await requireMediaTools()
    const path = join(dir, `${s.seed}.wav`)
    writeFileSync(path, clipBytes(s.kind, s.rate, s.channels, s.rate * s.seconds, s.seed))
    const sound = await decodeAudio(path, { decoder: 'load', userId: null, roots: [dir], maxSamples: 100_000_000 })
    const stereo = vocalsStereo(sound)
    expect([stereo.channels.length, stereo.channels[0]!.length, stereo.rate]).toEqual([s.sent.shape[0], s.sent.shape[1], s.rate_sent])
    expect(sha(channelMajor(stereo))).toBe(s.sent.sha256)
    // Sent as a 16-bit FLAC (R5.3's encoder): its samples are Python's, clipped and quantised to 16 bits.
    const sent = await vocalsSound(sound, { userId: null })
    expect([sent.silent, sent.ext, sent.channels, sent.rate, sent.frames, sent.seconds]).toEqual([false, 'flac', 2, s.rate, s.rate * s.seconds, s.seconds])
    expect(String.fromCharCode(...sent.wav.subarray(0, 4))).toBe('fLaC')
    const flac = join(dir, `${s.seed}.flac`)
    writeFileSync(flac, sent.wav)
    const back = await decodeAudio(flac, { decoder: 'load', userId: null, roots: [dir], maxSamples: 100_000_000 })
    expect([back.rate, back.channels.length, back.channels[0]!.length]).toEqual([s.rate, 2, s.rate * s.seconds])
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < back.channels[c]!.length; i += 97) {
        const want = Math.max(-1, Math.min(1, stereo.channels[c]![i]!))
        expect(Math.abs(back.channels[c]![i]! - want), `ch ${c} sample ${i}`).toBeLessThanOrEqual(1 / 32767)
      }
    }
  }, 120_000)

  it('a silent sound is not encoded (no call); the empty card\'s second is silent stereo; Python\'s silent stems are 44.1 kHz stereo', async () => {
    const zeros = await vocalsSound({ rate: 22050, channels: [new Float32Array(22050)] }, { userId: null })
    expect([zeros.silent, zeros.ext, zeros.channels, zeros.frames, zeros.seconds]).toEqual([true, 'wav', 2, 22050, 1])
    expect(vocalsSilence()).toMatchObject({ silent: true, rate: 44100, frames: 44100, seconds: 1, channels: 2 })
    expect(cardSilenceFor(VOCALS_CLASS)).toEqual(vocalsSilence())
    const stems = vocalsSilentStems(22050, 22050)
    expect([stems.rate, stems.channels.length, stems.channels[0]!.length]).toEqual([VOCALS_RATE, 2, VOCALS_RATE])
    expect(vocalsSilentStems(48000, 48000).channels[0]!.length).toBe(VOCALS_RATE)
    expect(vocalsSilentStems(1, 48000).channels[0]!.length).toBe(1)
  })
})

describe('the request, against the saved schema', () => {
  it('two-stem mode, float32 WAVs, never rescaled, for every model the service takes and every shifts Python allows', () => {
    for (const model of VOCALS_MODELS) {
      for (let shifts = VOCALS_SHIFTS.min; shifts <= VOCALS_SHIFTS.max; shifts++) {
        const p = vocalsInput('https://fal.storage/vocal_separator.flac', model, shifts)
        expect(checkPayload(SCHEMA, p), `${model} ${shifts}`).toEqual([])
        expect(p).toEqual({ audio: 'https://fal.storage/vocal_separator.flac', model: VOCALS_MODEL_SENT[model], shifts, split: true, stem: 'vocals', output_format: 'wav', wav_format: 'float32', clip_mode: 'none' })
      }
    }
    // Fix round 1 (controller ruling): the schema has no mdx_extra, only its quantised mdx_extra_q, which is sent for it.
    expect(VOCALS_MODEL_SENT).toEqual({ htdemucs: 'htdemucs', htdemucs_ft: 'htdemucs_ft', mdx_extra: 'mdx_extra_q' })
    expect(checkPayload(SCHEMA, { ...vocalsInput('https://x.test/a.flac', 'htdemucs', 1), model: 'mdx_extra' })).not.toEqual([])
  })

  it('the answer\'s two stems: `vocals` and `no_vocals`; anything else is no answer', () => {
    expect(vocalsStemUrls({ output: STEM_URLS })).toEqual({ vocals: STEM_URLS.vocals, instrumental: STEM_URLS.no_vocals })
    for (const bad of [null, {}, { output: [STEM_URLS.vocals] }, { output: { vocals: STEM_URLS.vocals } }, { output: { vocals: '', no_vocals: 'x' } }]) expect(vocalsStemUrls(bad), JSON.stringify(bad)).toBeNull()
    // A stem is at most its seconds of stereo float32 at 44.1 kHz, two seconds over.
    expect(vocalsStemMaxBytes(600)).toBe(VOCALS_RATE * 8 * 602 + 65536)
    expect(vocalsStemMaxBytes(VOCALS_MAX_SECONDS.local)).toBeLessThan(512 * 1024 * 1024)
  })

  async function pipelineOf(o: { wav: VocalsSound; hosted?: boolean; inputs?: Record<string, unknown>; recorded?: Record<string, unknown>; measured?: Record<string, unknown> }) {
    const sent: string[] = []
    const plan = await planNode({
      prompt: { s: loadAudio(), n: vocalsNode(o.inputs) }, nodeId: 'n', gateOpen: false, filesFrom: () => [], hosted: !!o.hosted, families: ON,
      toUrl: async f => `https://fal.storage/${f.filename}`,
      bytesToUrl: async (f) => { sent.push(f.filename); return `https://fal.storage/${f.filename}` },
      soundWav: async () => o.wav,
      ...(o.measured ? { measured: o.measured } : {}),
    })
    expect(plan.kind).toBe(o.wav.silent && o.measured ? 'derive' : 'pipeline')
    const calls: { key: string; provider: string; endpoint: string; payload: Record<string, unknown>; media: string; wait?: string; usd: number }[] = []
    const kept: Uint8Array[] = []
    const lost: string[] = []
    const io = {
      signal: new AbortController().signal,
      media: {
        runId: 'r', hosted: !!o.hosted, userId: null, access: {} as never,
        kept: {
          checkRoom: async () => {},
          put: async (_r: string, b: Uint8Array) => { kept.push(b); return { filename: `k${kept.length}.wav`, subfolder: '', type: 'kept' as const } },
          workDir: async () => mkdtempSync(join(tmpdir(), 'vocals-kept-')),
          putPath: async (_r: string, path: string) => { kept.push(new Uint8Array(readFileSync(path))); return { filename: `k${kept.length}.wav`, subfolder: '', type: 'kept' as const } },
        } as never,
      },
      recorded: () => o.recorded ?? null,
      call: async (c: (typeof calls)[number]) => { calls.push(c); return { result: { output: STEM_URLS }, raw: null, urls: [] } },
      download: async (url: string) => (await stemDownload(1)(url)),
      undelivered: async (_k: string, why: string) => { lost.push(why) },
    } as unknown as PipelineIO
    return { plan: plan as Extract<NodePlan, { kind: 'pipeline' }>, derive: plan as Extract<NodePlan, { kind: 'derive' }>, io, sent, calls, kept, lost }
  }
  const flacOf = (seconds: number): VocalsSound => ({ wav: Uint8Array.of(0x66, 0x4C, 0x61, 0x43), seconds, frames: seconds * 44100, rate: 44100, channels: 2, silent: false, ext: 'flac' })

  it('through planNode: one Replicate call with the FLAC handed off, priced on the seconds sent; the two stems kept, vocals on slot 0', async () => {
    const t = await pipelineOf({ wav: flacOf(2), inputs: { model: 'htdemucs_ft', shifts: 3 } })
    const made = await t.plan.run(t.io)
    expect(t.sent).toEqual(['vocal_separator.flac'])
    expect(t.calls).toHaveLength(1)
    const c = t.calls[0]!
    expect([c.provider, c.endpoint, c.media, c.wait, c.key]).toEqual(['replicate', VOCALS_SLUG, 'value', 'video', 'demucs'])
    expect(c.payload).toEqual(vocalsInput('https://fal.storage/vocal_separator.flac', 'htdemucs_ft', 3))
    // A typed 3.7 is ComfyUI's int(3.7): 3.
    const t2 = await pipelineOf({ wav: flacOf(2), inputs: { model: 'htdemucs', shifts: 3.7 } })
    await t2.plan.run(t2.io)
    expect(t2.calls[0]!.payload.shifts).toBe(3)
    // 2 s × 4 (htdemucs_ft) × 3 shifts = 24 s of work: under the page's floor.
    expect(c.usd).toBe(paidCallUsd({ endpoint: VOCALS_SLUG, inputSeconds: 24 }))
    expect(made.values).toEqual({
      0: { kind: 'files', files: [{ filename: 'k1.wav', subfolder: '', type: 'kept' }], sound: { decode: 'load' } },
      1: { kind: 'files', files: [{ filename: 'k2.wav', subfolder: '', type: 'kept' }], sound: { decode: 'load' } },
    })
    expect(t.kept.map(sha)).toEqual([sha(stemWav(1, 0.5)), sha(stemWav(1, 0.25))])
    expect(made.ui).toBeNull()
  })

  it('a silent sound: no call, two silent stems; over this place\'s longest: refused before the hand-off; a resumed node sends its written-down request', async () => {
    // Known silent this turn: a derive plan (no call, free).
    const silent = await pipelineOf({ wav: vocalsSilence(), measured: { audio: 1, place: 'hosted' } })
    const quiet = await silent.derive.derive(silent.io)
    expect([silent.calls, silent.sent]).toEqual([[], []])
    // Not known before planning (a resumed node whose call was never sent): no call either.
    const late = await pipelineOf({ wav: vocalsSilence() })
    await late.plan.run(late.io)
    expect([late.calls, late.sent]).toEqual([[], []])
    expect(quiet.values[0]).toEqual({ kind: 'files', files: [{ filename: 'k1.wav', subfolder: '', type: 'kept' }], sound: { decode: 'exact' } })
    expect(quiet.values[1]).toEqual({ kind: 'files', files: [{ filename: 'k2.wav', subfolder: '', type: 'kept' }], sound: { decode: 'exact' } })
    // Two 1 s silent stereo float WAVs at 44.1 kHz (header 58 bytes, then 44,100 × 2 × 4 zero bytes).
    expect(silent.kept.map(b => [b.length, b.subarray(58).every(x => x === 0)])).toEqual([[58 + 44100 * 8, true], [58 + 44100 * 8, true]])
    const long = await pipelineOf({ wav: flacOf(VOCALS_MAX_SECONDS.hosted + 1), hosted: true })
    await expect(long.plan.run(long.io)).rejects.toThrow(VOCALS_WORDS.tooLong)
    expect([long.sent, long.calls]).toEqual([[], []])
    // On this computer twenty minutes are allowed.
    const local = await pipelineOf({ wav: flacOf(VOCALS_MAX_SECONDS.hosted + 1) })
    await local.plan.run(local.io)
    expect(local.sent).toEqual(['vocal_separator.flac'])
    const recorded = vocalsInput('https://fal.storage/vocal_separator.flac', 'htdemucs', 1)
    const resumed = await pipelineOf({ wav: flacOf(2), recorded })
    await resumed.plan.run(resumed.io)
    expect([resumed.sent, resumed.calls[0]!.payload]).toEqual([[], recorded])
  })

  it('an answer missing a stem, or a stem that isn\'t a WAV: not delivered (charged nothing), in plain words', async () => {
    const t = await pipelineOf({ wav: flacOf(2) })
    const io = { ...t.io, call: async () => ({ result: { output: { vocals: STEM_URLS.vocals } }, raw: null, urls: [] }) } as unknown as PipelineIO
    await expect(t.plan.run(io)).rejects.toThrow(VOCALS_WORDS.noAnswer)
    expect(t.lost).toEqual(['no-file'])
    const u = await pipelineOf({ wav: flacOf(2) })
    const io2 = { ...u.io, download: async () => ({ bytes: new TextEncoder().encode('<html>'), contentType: 'audio/wav' }) } as unknown as PipelineIO
    await expect(u.plan.run(io2)).rejects.toThrow(VOCALS_WORDS.noAnswer)
    expect(u.lost).toEqual(['no-file'])
  })
})

describe('the price: a new card, by the seconds sent times the settings\' work', () => {
  it('Replicate\'s demucs: $0.0002 a second of sound, at least the page\'s $0.034; measured', () => {
    expect(PAID_RATES[VOCALS_SLUG]).toMatchObject({ unit: 'per_input_second', perSecond: 0.0002, minSeconds: 170, service: 'replicate', confidence: 'verified' })
    expect(paidCallUsd({ endpoint: VOCALS_SLUG, inputSeconds: 30 })).toBe(0.034)
    expect(paidCallUsd({ endpoint: VOCALS_SLUG, inputSeconds: 600 })).toBe(0.12)
    expect([vocalsWork('htdemucs', 0), vocalsWork('htdemucs', 1), vocalsWork('htdemucs', 10), vocalsWork('htdemucs_ft', 2), vocalsWork('htdemucs', ['x', 0]), vocalsWork('mdx_extra', 1), vocalsWork('nope', 1)]).toEqual([1, 1, 10, 8, 10, 4, null])
  })

  it('measured: those seconds; bounded: the bound; neither: the longest where it runs (hosted 10 minutes, this computer 20)', () => {
    const call = (s: Record<string, unknown>, inputs: Record<string, unknown> = { model: 'htdemucs', shifts: 1 }) => vocalsCalls(inputs, s).steps?.[0]?.call.inputSeconds
    expect(call({ audio: 12.5 })).toBe(12.5)
    expect(call({ audio: 12.5 }, { model: 'htdemucs_ft', shifts: 2 })).toBe(100)
    expect(call({ audioUpTo: 9, place: 'hosted' })).toBe(9)
    expect(call({ audioUpTo: 5000, place: 'hosted' })).toBe(600)
    expect(call({ place: 'hosted' })).toBe(600)
    expect(call({ framesUpTo: 'hosted' })).toBe(600)
    expect(call({ framesUpTo: 'local' })).toBe(1200)
    expect(call({})).toBe(1200)
    expect(call({ audio: 10 }, { model: 'mdx_extra', shifts: 1 })).toBe(40)
    expect('refused' in vocalsCalls({ model: 'nope', shifts: 1 }, {})).toBe(true)
    expect(localModelCalls(VOCALS_CLASS, 300, { model: 'htdemucs', shifts: 1 }, { audio: 3 })).toEqual(vocalsCalls({ model: 'htdemucs', shifts: 1 }, { audio: 3 }))
    expect(credits({ audio: 30 })).toBe(creditsForUsd(0.034))
    expect(credits({ place: 'hosted' })).toBe(creditsForUsd(0.12))
    expect(credits({ place: 'local' })).toBe(creditsForUsd(0.24))
    // Family off: not priced here (ComfyUI runs Demucs locally, free).
    expect('refused' in priceNode(VOCALS_CLASS, { model: 'htdemucs', shifts: 1 }, { families: new Set<RunnerFamily>(['cards', 'media-sound']) })).toBe(true)
    expect(serviceTooltip(VOCALS_CLASS, ON)).toBe('Runs on Replicate')
    expect(SERVICE_OF[VOCALS_CLASS]).toBe('replicate')
  })

  it('the canvas shows "up to" the ceiling where it runs: never below the hold', () => {
    const n = { id: 'n', type: VOCALS_CLASS, title: 'Vocal separator', badgeExpr: null, category: null, widgetDefs: [{ name: 'model' }, { name: 'shifts' }], widgetsValues: ['htdemucs', 1], linkedInputs: ['audio'], inputPixels: null, inputSeconds: null, pictures: null }
    const hosted = estimateUsdForNodes([n as never], { hosted: true, families: ON })!
    expect(hosted.breakdown[0]!.upTo).toBe(true)
    expect(hosted.hostedCredits).toBe(credits({ place: 'hosted' }) + 1)
    const local = estimateUsdForNodes([n as never], { families: ON })!
    expect(local.breakdown[0]!.usd).toBeCloseTo(0.24, 8)
  })
})

describe('through the engine (ComfyUI off): Karaoke\'s chain held, sent, charged', () => {
  it('Load audio → Vocal separator → Save audio (MP3) × 2, hosted: bounded before the hold, the FLAC sent, both stems saved, charged ≤ held', async () => {
    await requireMediaTools()
    const replicate = createFakeReplicate({ answer: () => STEM_URLS })
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON, download: stemDownload(2) } })
    putInput(k.root, 'song.wav', clipBytes('pcm16', 44100, 1, 44100 * 2, 8401))
    const p: ApiPrompt = { s: loadAudio(), n: vocalsNode(), ...saves() }
    expect(isRunnerEligible(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['s', 'n', 'v', 'i']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(replicate.submitted().length).toBe(1)
    const sent = replicate.submitted()[0]!
    expect(sent.endpoint).toBe(VOCALS_SLUG)
    expect(checkPayload(SCHEMA, sent.payload)).toEqual([])
    expect(sent.payload).toEqual(vocalsInput('https://fal.storage/vocal_separator.flac', 'htdemucs', 1))
    // The FLAC handed off: Python's stereo of the mono song.
    const flac = k.upload.mock.calls.find(x => x[1] === 'vocal_separator.flac')![0] as Uint8Array
    expect(String.fromCharCode(...flac.subarray(0, 4))).toBe('fLaC')
    // Bounded before the hold from the file's header (2 s, plus a second); charged the 2 s sent.
    const upTo = take.measured?.n?.seconds.audioUpTo as number
    expect(take.measured?.n).toEqual({ seconds: { place: 'hosted', audioUpTo: upTo }, sha: {} })
    expect(upTo).toBeGreaterThan(2)
    expect(upTo).toBeLessThan(3.01)
    expect(take.nodes.n!.credits).toBe(credits({ audio: 2 }))
    expect(take.nodes.n!.credits).toBeLessThanOrEqual(credits({ place: 'hosted', audioUpTo: upTo }))
    // Both stems saved as MP3s.
    expect(take.nodes.v!.outputs[0]?.filename).toMatch(/^karaoke_vocals.*\.mp3$/)
    expect(take.nodes.i!.outputs[0]?.filename).toMatch(/^karaoke_instrumental.*\.mp3$/)
    const holds = [...k.ledger.holds.values()]
    expect(holds.every(h => h.actual !== null && h.actual <= h.credits)).toBe(true)
  }, 120_000)

  it('an empty Audio card (1 s of silence): no call, two silent stems, Vocal separator charged nothing', async () => {
    await requireMediaTools()
    const replicate = createFakeReplicate({ answer: () => STEM_URLS })
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON } })
    const card = { class_type: 'Audio', inputs: { audio: '', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0' } }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ s: card, n: vocalsNode(), ...saves() }], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['s', 'n', 'v', 'i']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(replicate.submitted()).toEqual([])
    expect(take.measured?.n?.seconds).toMatchObject({ audio: 1, place: 'hosted' })
    expect(take.nodes.n!.credits).toBe(0)
  }, 60_000)

  it('Stop during the call: the call cancelled, the hold released', async () => {
    await requireMediaTools()
    const replicate = createFakeReplicate({ answer: () => STEM_URLS })
    replicate.holdNext(1)
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON, download: stemDownload(1) } })
    putInput(k.root, 'song.wav', clipBytes('pcm16', 44100, 2, 44100, 8402))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ s: loadAudio(), n: vocalsNode(), ...saves() }], ...START })
    for (let i = 0; i < 4000 && replicate.submitted().length < 1; i++) await new Promise(r => setTimeout(r, 5))
    expect(replicate.submitted().length).toBe(1)
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)
    expect(replicate.submitted()[0]!.cancelled).toBe(true)
    expect([...k.ledger.holds.values()].map(h => (h.state === 'released' ? 0 : h.actual))).toEqual([0])
  }, 60_000)

  it('R11.5: hosted, a loaded song past what its joined stems can be read at (about 32.6 minutes): refused plainly before any hold, from its header (never the engine); a song past 10 minutes runs in pieces (runner-long-sound)', async () => {
    await requireMediaTools()
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    // 1 kHz keeps the file small; only its header is read.
    putInput(k.root, 'long.wav', clipBytes('pcm16', 1000, 1, 1000 * 33 * 60, 8403))
    expect(vocalsStemsReadable(33 * 60, 'hosted')).toBe(false)
    expect(vocalsStemsReadable(32 * 60, 'hosted')).toBe(true)
    expect(vocalsStemsReadable(VOCALS_CEILING_SECONDS.local, 'local')).toBe(true)
    const err = await k.engine.startRun({ userId: k.userId, takes: [{ s: loadAudio('long.wav'), n: vocalsNode(), ...saves() }], ...START }).then(() => null, (e: Error) => e)
    expect(err?.message).toBe(VOCALS_WORDS.tooLong)
    expect((err as { data?: { reason?: string } })?.data?.reason ?? (err as { reason?: string })?.reason).not.toBe(RUNNER_NOT_ELIGIBLE)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  }, 120_000)

  it('an exact chain (Empty audio) just past what the stems can be read at (hosted): refused before the hold — no second of header slack where no header source is in the chain', async () => {
    const fam = new Set<RunnerFamily>([...ON, 'sound-effects'])
    const k = makeKit({ hosted: true, deps: { families: () => fam } })
    const empty = (duration: number) => ({ class_type: 'EmptyAudio', inputs: { duration, sample_rate: 8000, channels: 1 } })
    const err = await k.engine.startRun({ userId: k.userId, takes: [{ s: empty(1959), n: vocalsNode(), ...saves() }], ...START }).then(() => null, (e: Error) => e)
    expect(err?.message).toBe(VOCALS_WORDS.tooLong)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    // The bound itself: exact, and a loaded file's is not.
    const shapes = await soundShapes({ s: empty(10), n: vocalsNode() }, fam, async () => null)
    expect(soundBoundOf({ s: empty(10), n: vocalsNode() }, ['s', 0], shapes)).toEqual({ seconds: 10 + 1e-3, exact: true })
    const loaded = new Map([['s:0', { rate: 8000, channels: 1, samples: 16000, exact: false }]])
    expect(soundBoundOf({ s: loadAudio(), n: vocalsNode() }, ['s', 0], loaded)).toEqual({ seconds: 2 + 1e-3, exact: false })
  }, 60_000)
})

describe('fix round 1: the kept room before the hold, and mdx_extra', () => {
  /** A kept store that says the run already keeps `used` bytes. */
  const nearlyFull = (used: number): KeptBytes => {
    const inner = createMemoryKeptBytes()
    return { ...inner, runBytes: async (runId: string) => used + await inner.runBytes(runId) }
  }
  const HOSTED_CAP = MEDIA_CAPS.hosted.keptBytesPerRun

  it('Vocal separator whose two stems wouldn\'t fit the run\'s kept room: refused before the hold, nothing sent; with room, it runs', async () => {
    await requireMediaTools()
    // A 2 s song: held for its header bound (3 s), so its stems count 2 × vocalsStemMaxBytes(3 s + slack).
    const need = 2 * vocalsStemMaxBytes(3 + 1e-3)
    const replicate = createFakeReplicate({ answer: () => STEM_URLS })
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON, download: stemDownload(2), kept: nearlyFull(HOSTED_CAP - need + 1) } })
    putInput(k.root, 'song.wav', clipBytes('pcm16', 44100, 1, 44100 * 2, 8601))
    const err = await k.engine.startRun({ userId: k.userId, takes: [{ s: loadAudio(), n: vocalsNode(), ...saves() }], ...START }).then(() => null, (e: Error) => e)
    expect(err?.message).toBe(KEPT_ROOM_MEDIA_REFUSED)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(replicate.submitted()).toEqual([])
    expect(k.upload).not.toHaveBeenCalled()
    // The partial control: with just enough room (the same run, a little more free), it runs and keeps both stems.
    const r2 = createFakeReplicate({ answer: () => STEM_URLS })
    const k2 = makeKit({ hosted: true, replicate: r2, deps: { families: () => ON, download: stemDownload(2), kept: nearlyFull(HOSTED_CAP - need - 64 * 1024 * 1024) } })
    putInput(k2.root, 'song.wav', clipBytes('pcm16', 44100, 1, 44100 * 2, 8601))
    const { runId } = await k2.engine.startRun({ userId: k2.userId, takes: [{ s: loadAudio(), n: vocalsNode(), ...saves() }], ...START })
    await k2.engine.settled(runId)
    const take = (await k2.store.get(runId))!.takes[0]!
    expect(take.keptUpTo).toEqual({ n: need })
    for (const id of ['s', 'n', 'v', 'i']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(r2.submitted().length).toBe(1)
  }, 120_000)

  it('the start records what each clip node keeps itself: Slow motion (AI)\'s output batch, Upscale (2×)\'s doubled batch, Background remove\'s batch and masks', async () => {
    const fam = new Set<RunnerFamily>(['cards', 'media-video', 'slow-motion-ai', 'upscale-2x', 'bg-remove'])
    const lvf = { class_type: 'LoadVideoFrames', inputs: { file: 'a.mp4', max_seconds: 10, max_frames: 10, max_size: 64, start_frame: 0, stride: 1 } }
    const p: ApiPrompt = {
      v: lvf,
      m: { class_type: 'FrameInterpolateAI', inputs: { frames: ['v', 0], multiplier: 2 } },
      u: { class_type: 'UpscaleImage', inputs: { frames: ['v', 0], tile_size: 512 } },
      b: { class_type: 'BackgroundRemove', inputs: { frames: ['v', 0], output: 'transparent', edge_softness: 0 } },
    }
    const clip = { count: 10, w: 64, h: 36, exact: true }
    const shapes = new Map([['v:0', clip], ['m:0', { ...clip, count: 19 }], ['u:0', { ...clip, w: 128, h: 72 }], ['b:0', clip]])
    const got = await localModelStartProblems(p, fam, { hosted: true, shapes: async () => shapes })
    expect(got.problem).toBeNull()
    expect(got.keptByNode).toEqual({
      m: keptBatchBound({ ...clip, count: 19 }),
      u: keptBatchBound({ ...clip, w: 128, h: 72 }),
      b: keptBatchBound(clip) + maskBytesBound(clip),
    })
  })

  it('mdx_extra (Python\'s) is sent as the service\'s mdx_extra_q, through the engine; its payload passes the saved schema', async () => {
    await requireMediaTools()
    const replicate = createFakeReplicate({ answer: () => STEM_URLS })
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON, download: stemDownload(2) } })
    putInput(k.root, 'song.wav', clipBytes('pcm16', 44100, 2, 44100 * 2, 8602))
    const p: ApiPrompt = { s: loadAudio(), n: vocalsNode({ model: 'mdx_extra', shifts: 2 }), ...saves() }
    expect(isRunnerEligible(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    expect(take.nodes.n!.status, take.nodes.n!.error ?? '').toBe('done')
    const sent = replicate.submitted()[0]!.payload
    expect(sent).toMatchObject({ model: 'mdx_extra_q', shifts: 2, stem: 'vocals' })
    expect(checkPayload(SCHEMA, sent)).toEqual([])
    // Held and charged as a bag of four models × 2 shifts: 2 s × 8 = 16 s of work (under the floor).
    expect(take.nodes.n!.credits).toBe(credits({ audio: 2 }, { model: 'mdx_extra', shifts: 2 }))
  }, 120_000)
})

describe('a request closed while the run is being started leaves nothing running', () => {
  it('Vocal separator: its sound\'s header probed at the start (ffprobe), closed mid-way: refused, no tool left within a second, the slot given back, nothing held', async () => {
    await requireMediaTools()
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    putInput(k.root, 'song.wav', clipBytes('pcm16', 48000, 2, 48000 * 50, 8501))
    const ctl = new AbortController()
    const before = PROCS.pids.length
    let seen = 0
    PROCS.onSpawn = (path, pid) => {
      if (!path.includes('ffprobe') || seen++) return
      try { process.kill(pid, 'SIGSTOP') } catch { /* already done */ }
      ctl.abort()
    }
    try {
      const started = k.engine.startRun({ userId: k.userId, takes: [{ s: loadAudio(), n: vocalsNode(), ...saves() }], ...START, signal: ctl.signal }).then(() => null, (e: Error) => e)
      const err = await Promise.race([started, new Promise<'hung'>(r => setTimeout(() => r('hung'), 5000))])
      expect(seen).toBeGreaterThan(0)
      expect(err === 'hung' ? 'hung' : err?.message).toBe(MEDIA_WORDS.stopped)
      const t0 = Date.now()
      for (const pid of PROCS.pids.slice(before)) {
        while (Date.now() - t0 < 1000) {
          try { process.kill(pid, 0) }
          catch { break }
          await new Promise(r => setTimeout(r, 10))
        }
        expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
      }
    }
    finally {
      PROCS.onSpawn = null
      for (const pid of PROCS.pids.slice(before)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    }
    expect(mediaLimiter().pending(k.userId)).toBe(0)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  }, 60_000)
})

describe('the row, the family and the families-off invariant (rule 15)', () => {
  it('off by default, the sound-tools family chain; taken with a sound from any runner sound; its stems feed sound readers; a Replicate route with no backup', async () => {
    expect(LOCAL_MODEL_FAMILY_OF[VOCALS_CLASS]).toBe('vocal-split')
    expect(LOCAL_MODEL_REQUIRES['vocal-split']).toBe('media-sound')
    expect(LOCAL_MODEL_TOOL_FAMILIES).toContain('vocal-split')
    expect(PROVIDER_TYPES.has(VOCALS_CLASS)).toBe(true)
    expect(RUNNER_ROUTES[VOCALS_CLASS]).toMatchObject({ first: 'replicate', backup: null })
    expect(SOUND_OUTPUTS).toEqual(expect.arrayContaining([[VOCALS_CLASS, 0], [VOCALS_CLASS, 1]]))
    const p: ApiPrompt = { s: loadAudio(), n: vocalsNode(), ...saves() }
    expect(isRunnerEligible(p, ON)).toBe(true)
    // A model the service doesn't take, shifts ComfyUI refuses, a wired shifts or model: the engine's.
    // Fix round 1: mdx_extra is taken (sent as mdx_extra_q).
    expect(runnerTakesNode({ ...p, n: vocalsNode({ model: 'mdx_extra' }) }, 'n', ON)).toBe(true)
    for (const bad of [{ model: 'nope' }, { shifts: -1 }, { shifts: 11 }, { shifts: ['x', 0] }, { model: ['x', 0] }]) {
      expect(runnerTakesNode({ ...p, n: vocalsNode(bad) }, 'n', ON), JSON.stringify(bad)).toBe(false)
    }
    // A picture isn't a sound.
    expect(runnerTakesNode({ s: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, n: vocalsNode() }, 'n', ON)).toBe(false)
    // Without its family, or its chain, it is left to the engine and named; so are the saves reading it.
    for (const fam of [new Set<RunnerFamily>(['cards', 'media-sound']), new Set<RunnerFamily>(['cards', 'vocal-split'])]) {
      expect(runnerTakesNode(p, 'n', fam)).toBe(false)
      expect(runnerTakesNode(p, 'v', fam)).toBe(false)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id })).toContain('n')
    }
    // The start pass knows its stems while it is on: stereo at 44.1 kHz, the sound's length resampled plus a second.
    const shapes = await soundShapes(p, ON, async () => ({ rate: 48000, channels: 1, samples: 96000, exact: false }))
    expect(shapes.get('n:0')).toEqual({ rate: VOCALS_RATE, channels: 2, samples: Math.ceil(96000 * 44100 / 48000) + 1 + VOCALS_RATE, exact: false })
    expect(shapes.get('n:1')).toEqual(shapes.get('n:0'))
    expect((await soundShapes(p, new Set<RunnerFamily>(['cards', 'media-sound']), async () => null)).has('n:0')).toBe(false)
  })

  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but R7\'s', ALL_RUNNER_FAMILIES.filter(x => !LOCAL_MODEL_FAMILIES.includes(x))],
  ]
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, n.class_type === VOCALS_CLASS ? { ...n, class_type: 'VocalSeparatorBefore' } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (p[id]!.class_type !== VOCALS_CLASS) expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
      }
      expect(outputKindsFor(families)[VOCALS_CLASS]).toBeUndefined()
    }
  }

  it('over one synthetic graph per chain (Karaoke, an Audio card, a stem into a sound effect and an Audio card)', () => {
    sameAsBefore({ s: loadAudio(), n: vocalsNode(), ...saves() }, 'Karaoke')
    sameAsBefore({ s: { class_type: 'Audio', inputs: { audio: 'a.wav', export: false, filename_prefix: 'a', format: 'flac', quality: 'V0' } }, n: vocalsNode(), ...saves() }, 'an Audio card → Vocal separator')
    sameAsBefore({
      s: loadAudio(), n: vocalsNode(),
      a: { class_type: 'AudioAdjustVolume', inputs: { audio: ['n', 1], volume: 1 } },
      c: { class_type: 'Audio', inputs: { source: ['n', 0], audio: '', export: false, filename_prefix: 'a', format: 'flac', quality: 'V0' } },
      p: { class_type: 'PreviewAudio', inputs: { audio: ['a', 0] } },
    }, 'stems into an effect and a card')
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/assets/nodeCatalog.json.gz'))).toString('utf8'))
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
        if (Object.values(p).some(n => n.class_type === VOCALS_CLASS)) withIt++
        sameAsBefore(p, uuid)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`vocal-split families-off invariant: ${graphs} saved graphs, ${withIt} with Vocal separator`)
  }, 600_000)
})
