/**
 * Task R6.9: the sound effects and Silence cut (family `sound-effects`), and
 * Save audio (Opus) (server/runner/media/soundEffects.ts,
 * server/runner/video/core/sound.ts, server/runner/video/soundShapes.ts).
 *
 * Parity is against scripts/runner_media_fixtures.py --group sfx: each
 * class's real execute over standard sounds of a fixed formula. By the
 * user's matching rule:
 *   - exact (bit for bit in float32): Trim, Split, Join / Concat / Merge at
 *     one rate, Adjust volume, Empty audio, Fade (`linear`, `exponential`),
 *     Normalize to a peak;
 *   - library (within LIB_EPS of Python, or for the equalizer's feedback
 *     loop at least EQ_SNR_DB against Python): a resample (torchaudio's),
 *     the equalizer, `equal_power`, Normalize to an RMS, Duck;
 *   - band: Silence cut's loud mask (samples whose level sat within the
 *     fixture's band of the threshold may differ); the ranges exact given the
 *     mask. Python's walk drops a loud run followed by a short silence (a
 *     bug): the runner's ranges are the fixture's `fixedRanges` (the walk as
 *     meant), and equal Python's own wherever the bug doesn't arise;
 *   - Save audio (Opus): R5's export, as R5 rule 3 judges Opus (60 dB).
 *
 * Every case runs through its plan with the real stores and tools (the
 * sounds kept as float WAVs, read back as the next node reads them).
 */
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** Every tool process started, by pid (a spy on the process table's side of spawn). */
const PROCS = vi.hoisted(() => ({ pids: [] as number[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: ((...a: Parameters<typeof real.spawn>) => {
      const c = real.spawn(...a)
      if (c.pid) PROCS.pids.push(c.pid)
      return c
    }) as typeof real.spawn,
  }
})

/** A hook in the writer: on its Nth frame, Stop the node, or fail the write (an early leave). */
const HOOK = vi.hoisted(() => ({ puts: 0, at: 0, mode: 'stop' as 'stop' | 'fail', ctl: null as AbortController | null, firedAt: 0 }))
vi.mock('~~/server/media/values', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/values')>()
  return {
    ...real,
    framesSink: ((...a: Parameters<typeof real.framesSink>) => {
      const sink = real.framesSink(...a)
      return {
        ...sink,
        async put(rgb: Uint8Array) {
          if (HOOK.at && ++HOOK.puts === HOOK.at) {
            HOOK.firedAt = Date.now()
            if (HOOK.mode === 'fail') throw new Error('the writer failed (test)')
            HOOK.ctl?.abort()
          }
          return sink.put(rgb)
        },
      }
    }) as typeof real.framesSink,
  }
})

import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { FRAMES_OUTPUTS, MEDIA_EFFECTS_PORTED, MEDIA_EFFECT_WORDS, SOUND_EFFECT_OUTPUTS, mediaEffectRows, mediaEffectSwitchedClasses } from '#shared/runner/mediaEffects'
import { PICTURE_OUTPUTS, RUNNER_NODE_RULES, SOUND_OUTPUTS } from '#shared/runner/eligibility'
import { RUNNER_OUTPUT_CLASSES, runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { TOO_MUCH_WORK_WORDS, withAdvice } from '#shared/runner/messages'
import type { RunnerValue } from '~~/server/runner/types'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import { workerScript } from '~~/server/runner/compositor/worker'
import { videoCores } from '~~/server/runner/video/cores'
import { VIDEO_EFFECTS } from '~~/server/runner/video/table'
import { SOUND_EFFECT_CLASSES, soundEffectRefusals, soundEffectStartProblems, soundShapes } from '~~/server/runner/video/soundShapes'
import { silenceFrames } from '~~/server/runner/media/soundEffects'
import { decodeAudio, type DecodedSound } from '~~/server/media/decode'
import { resampleLikeTorchaudio } from '~~/server/media/resample'
import { keepSound, readSound } from '~~/server/media/values'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'
import { makeKit } from './__runner__/kit'
import {
  batchBytes, hash16, invariantAnswers, keptBatch, rule12Pin, runVfxNode, sha256, vfxHarness, vfxRunId, type VfxHarness,
} from './__runner__/mediaEffectsParity'

// ── The fixture ──────────────────────────────────────────────────────────────

interface PyOut { rate: number; channels: number; samples: number; sha256: string; f32z: string }
interface SfxRun { class_type: string; name: string; sounds: Record<string, string>; widgets: Record<string, unknown>; outputs?: PyOut[]; error?: string }
interface SilenceRun extends SfxRun { frames: number; keptFrames: number[]; loudRuns: [number, number][]; near: number[]; pyRanges: [number, number][]; fixedRanges: [number, number][] }
interface OpusRun { rate: number; quality: string; input: string; ui: { audio: { filename: string; subfolder: string; type: string }[] }; saved: { decoded: { rate: number; rows: number; samples: number; f32z: string } } }
interface SfxFixture {
  sounds: Record<string, { rate: number; channels: number; f32z: string }>
  runs: SfxRun[]; silence: SilenceRun[]; bandDb: number; opus: OpusRun[]; gains: number[]
  linspace: { n: number; a: number; b: number; sha256: string; f32?: string }[]
}
const FX = (JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-media-sfx.json'), 'utf8')) as { cases: SfxFixture }).cases
const LONG = { timeout: 120_000 }
const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-sound', 'media-video', 'sound-effects'])
const SOUND_ONLY: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-sound', 'media-video'])

/**
 * The library classes' bound against Python (the outline's 1e-6), and the
 * equalizer's: torch's conv1d (its BLAS) sums the three forward taps in an
 * order of its own, and a low shelf's feedback loop carries that last bit
 * on, so the equalizer is judged as sounding the same (the controller's
 * note: at least 60 dB against Python's; measured 67 dB at worst, a 20 Hz
 * shelf).
 */
const LIB_EPS = 1e-6
const EQ_SNR_DB = 60

const scratch = mkdtempSync(join(tmpdir(), 'media-sfx-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let runs = 0

const f32Of = (z: string) => {
  const b = inflateSync(Buffer.from(z, 'base64'))
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}
/** A recorded sound ([C][N] float32, zlib'd) as channels. */
function channelsOf(z: string, channels: number): Float32Array[] {
  const all = f32Of(z)
  const n = all.length / channels
  return Array.from({ length: channels }, (_, c) => all.slice(c * n, (c + 1) * n))
}
const soundOf = (name: string): DecodedSound => {
  const s = FX.sounds[name]!
  return { rate: s.rate, channels: channelsOf(s.f32z, s.channels) }
}
const pyOf = (o: PyOut): DecodedSound => ({ rate: o.rate, channels: channelsOf(o.f32z, o.channels) })

/** The class's parity for a case: exact, or library (EQ: by its SNR). */
function parityOf(r: SfxRun): 'exact' | 'library' | 'eq' {
  const rates = new Set(Object.values(r.sounds).map(n => FX.sounds[n]!.rate))
  if (r.class_type === 'AudioEqualizer3Band') return 'eq'
  if (r.class_type === 'AudioDuck') return 'library'
  if (r.class_type === 'AudioFade' && r.widgets.curve === 'equal_power') return 'library'
  if (r.class_type === 'AudioNormalize' && r.widgets.mode === 'rms') return 'library'
  return rates.size > 1 ? 'library' : 'exact'
}

/** The largest difference and the signal-to-noise figure of two sounds (dB; Infinity when equal). */
function compare(got: DecodedSound, want: DecodedSound): { maxDiff: number; snrDb: number; equal: boolean } {
  let max = 0
  let sig = 0
  let noise = 0
  let equal = true
  for (let c = 0; c < want.channels.length; c++) {
    const a = got.channels[c]!
    const b = want.channels[c]!
    for (let i = 0; i < b.length; i++) {
      // NaN where Python's is NaN (a filter past half the rate blows up in both) is the same sample.
      const both = Number.isNaN(a[i]!) && Number.isNaN(b[i]!)
      const d = both ? 0 : Number.isNaN(a[i]!) || Number.isNaN(b[i]!) ? Infinity : Math.abs(a[i]! - b[i]!)
      if (!Object.is(a[i], b[i])) equal = false
      if (both) continue
      if (d > max) max = d
      sig += b[i]! * b[i]!
      noise += d * d
    }
  }
  return { maxDiff: max, snrDb: noise === 0 ? Infinity : 10 * Math.log10(sig / noise), equal }
}

/** Python's error in the runner's plain words. */
const PY_WORDS: Record<string, string> = {
  AudioTrim: MEDIA_EFFECT_WORDS.trimEmpty,
  AudioSplit: MEDIA_EFFECT_WORDS.splitNeedsStereo,
  AudioJoin: MEDIA_EFFECT_WORDS.joinNeedsMono,
}

/** A look number: printed, and written where SFX_FIGURES names (for the task's report). */
function figure(text: string): void {
  console.info(text)
  if (process.env.SFX_FIGURES) appendFileSync(process.env.SFX_FIGURES, `${text}\n`)
}

// ── Harness ──────────────────────────────────────────────────────────────────

const loader = () => ({ class_type: 'LoadAudio', inputs: { audio: 'a.wav' } })
function effectPrompt(r: SfxRun): ApiPrompt {
  const p: ApiPrompt = {}
  const inputs: Record<string, unknown> = { ...r.widgets }
  for (const [input] of Object.entries(r.sounds)) {
    p[`in_${input}`] = loader()
    inputs[input] = [`in_${input}`, 0]
  }
  p.e = { class_type: r.class_type, inputs }
  return p
}

async function runCase(h: VfxHarness, r: SfxRun): Promise<{ values: Record<number, RunnerValue>; runId: string }> {
  const runId = vfxRunId(++runs)
  const values: Record<string, Record<number, RunnerValue>> = {}
  for (const [input, name] of Object.entries(r.sounds)) values[`in_${input}`] = { 0: await keepSound(runId, soundOf(name), h.kept, { hosted: false }) }
  const d = await runVfxNode(h, effectPrompt(r), 'e', values, { runId, families: ON })
  return { values: d.values as Record<number, RunnerValue>, runId }
}

const readBack = (h: VfxHarness, v: RunnerValue) => readSound(v, 'TrimAudioDuration', { access: h.access, userId: null, hosted: false })

// ── The fixture, and the shared float32 steps ────────────────────────────────

describe('the fixture and torch’s float32 steps', () => {
  it('was made from the real nodes: every class, its raises, Silence cut and Opus', () => {
    const classes = new Set(FX.runs.map(r => r.class_type))
    for (const cls of SOUND_EFFECT_CLASSES.filter(c => c !== 'VideoSilenceCut')) expect(classes.has(cls), cls).toBe(true)
    expect(FX.runs.filter(r => r.error).map(r => r.error!.split(':')[1])).toEqual([' AudioTrim', ' AudioSplit', ' AudioJoin'])
    expect(FX.silence.length).toBeGreaterThanOrEqual(10)
    expect(FX.opus.map(o => `${o.rate} ${o.quality}`)).toHaveLength(10)
  })

  it('torch.linspace in float32 is exact', () => {
    for (const l of FX.linspace) {
      const got = videoCores.sfx.linspace32(l.a, l.b, l.n)
      expect(sha256(new Uint8Array(got.buffer)), `${l.n} ${l.a}..${l.b}`).toBe(l.sha256)
    }
  })

  it('every gain Adjust volume makes, f32(10^(v/20)), is torch’s', () => {
    for (let v = -100; v <= 100; v++) expect(Math.fround(10 ** (v / 20)), `${v}`).toBe(FX.gains[v + 100])
  })

  it('Python’s round() of a float: halves to even', () => {
    const r = videoCores.sfx.pyRound
    expect([0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 2.4999, 2.5001].map(r)).toEqual([0, 2, 2, -0, -2, -2, 2, 3])
  })
})

// ── Every case through its plan ──────────────────────────────────────────────

describe('every class through its plan: Python’s samples by class', () => {
  let h: VfxHarness
  beforeAll(() => { h = vfxHarness(scratch) })
  const figures: Record<string, { maxDiff: number; snrDb: number }> = {}
  afterAll(() => {
    const worst = (k: string) => Object.entries(figures).filter(([n]) => n.startsWith(k)).reduce((m, [, f]) => ({ maxDiff: Math.max(m.maxDiff, f.maxDiff), snrDb: Math.min(m.snrDb, f.snrDb) }), { maxDiff: 0, snrDb: Infinity })
    for (const k of ['JoinAudioChannels', 'AudioConcat', 'AudioMerge', 'AudioEqualizer3Band', 'AudioFade', 'AudioNormalize', 'AudioDuck']) {
      const w = worst(k)
      figure(`[sfx] ${k}: library cases' largest difference ${w.maxDiff.toExponential(2)}, lowest SNR ${w.snrDb.toFixed(1)} dB`)
    }
  })

  for (const r of FX.runs) {
    it(`${r.class_type}: ${r.name}`, LONG, async () => {
      await requireMediaTools()
      if (r.error) {
        const word = PY_WORDS[r.error.split(':')[1]!.trim()]!
        expect(word).toBeDefined()
        await expect(runCase(h, r)).rejects.toThrow(word)
        return
      }
      const { values } = await runCase(h, r)
      const parity = parityOf(r)
      for (const [slot, py] of r.outputs!.entries()) {
        const v = values[slot]!
        expect(v, `slot ${slot}`).toBeDefined()
        const got = await readBack(h, v)
        expect(got.rate).toBe(py.rate)
        expect(got.channels.length).toBe(py.channels)
        expect(got.channels[0]?.length ?? 0).toBe(py.samples)
        const c = compare(got, pyOf(py))
        if (parity !== 'exact') figures[`${r.class_type} ${r.name} ${slot}`] = c
        if (parity === 'exact') expect(c.equal, `bit for bit (largest difference ${c.maxDiff})`).toBe(true)
        else if (parity === 'library') expect(c.maxDiff, `within ${LIB_EPS}`).toBeLessThanOrEqual(LIB_EPS)
        else expect(c.snrDb, `the equalizer at least ${EQ_SNR_DB} dB from Python's (largest difference ${c.maxDiff})`).toBeGreaterThanOrEqual(EQ_SNR_DB)
      }
      expect(Object.keys(values)).toHaveLength(r.outputs!.length)
    })
  }

  it('a sound handed on (volume 0, no fade, silence normalised) is the input value itself, no new file', LONG, async () => {
    await requireMediaTools()
    for (const r of FX.runs.filter(x => x.name === 'volume 0' || x.name === 'none (handed on)' || x.name.includes('on silence (handed on)'))) {
      const runId = vfxRunId(++runs)
      const input = await keepSound(runId, soundOf(Object.values(r.sounds)[0]!), h.kept, { hosted: false })
      const before = readdirSync(join(h.root, 'kept', runId)).sort()
      const d = await runVfxNode(h, effectPrompt(r), 'e', { [`in_${Object.keys(r.sounds)[0]}`]: { 0: input } }, { runId, families: ON })
      expect((d.values[0] as Extract<RunnerValue, { kind: 'files' }>).files, r.name).toEqual((input as Extract<RunnerValue, { kind: 'files' }>).files)
      expect(readdirSync(join(h.root, 'kept', runId)).sort(), `${r.name}: nothing new kept`).toEqual(before)
    }
  })

  it('the worker’s ops equal this thread’s, bit for bit (eq, duck, fade, merge, silence)', LONG, async () => {
    const { soundInWorker } = await import('~~/server/runner/compositor/worker')
    const s = soundOf('tone44-stereo')
    const side = soundOf('bursts16')
    const ops: [string, Float32Array[], Record<string, unknown>][] = [
      ['eq', s.channels, { rate: 44100, low_gain_dB: 4.5, low_freq: 100, mid_gain_dB: -3.2, mid_freq: 1000, mid_q: 0.707, high_gain_dB: 7.7, high_freq: 5000 }],
      ['duck', [...s.channels, ...side.channels], { split: 2, rate: 44100, sideRate: 16000, threshold_db: -30, depth_db: -12, attack_ms: 20, release_ms: 300 }],
      ['fade', s.channels, { nIn: 300, nOut: 500, curve: 'equal_power' }],
      ['merge', [...s.channels, s.channels[0]!], { split: 2, method: 'mean' }],
      ['silence', side.channels, { rate: 16000, threshold_db: -40, min_silence_ms: 300, keep_padding_ms: 80 }],
    ]
    for (const [fn, chs, params] of ops) {
      const here = (videoCores.sfx as unknown as Record<string, (c: Float32Array[], p: unknown) => { channels?: Float32Array[]; ranges?: number[] }>)[fn]!(chs.map(c => c.slice()), params)
      const there = await soundInWorker(fn, chs.map(c => c.slice()), params)
      if (here.ranges) expect(there.ranges, fn).toEqual(here.ranges)
      else for (const [k, c] of here.channels!.entries()) expect(sha256(new Uint8Array(there.channels![k]!.buffer)), fn).toBe(sha256(new Uint8Array(c.buffer)))
    }
  })
})

// ── Silence cut ──────────────────────────────────────────────────────────────

/** Frame i is filled with byte i: what Silence cut kept reads back as its indices. */
const taggedFrames = (T: number, w = 8, hh = 8) => ({ frames: Array.from({ length: T }, (_, i) => new Uint8Array(w * hh * 3).fill(i % 256)), w, h: hh })
const flat = (rs: [number, number][]) => rs.flat()

describe('Silence cut: the loud mask by band, the ranges as the walk was meant, the frames and the sound', () => {
  let h: VfxHarness
  beforeAll(() => { h = vfxHarness(scratch) })

  it('the loud mask equals Python’s outside the band; the fixed ranges are the fixture’s; Python’s own where its walk doesn’t drop a run', () => {
    let differing = 0
    for (const c of FX.silence) {
      const s = soundOf(c.sounds.audio!)
      const w = c.widgets as { fps: number; threshold_db: number; min_silence_ms: number; keep_padding_ms: number }
      const mask = videoCores.sfx.loudMask(s.channels, { rate: s.rate, threshold_db: w.threshold_db })
      const py = new Uint8Array(mask.length)
      for (const [a, b] of c.loudRuns) py.fill(1, a, b)
      const near = new Set(c.near)
      for (let i = 0; i < mask.length; i++) if (mask[i] !== py[i]) expect(near.has(i), `${c.name}: sample ${i} off the band`).toBe(true)
      const ranges = videoCores.sfx.silence(s.channels, { rate: s.rate, ...w }).ranges!
      expect(ranges, c.name).toEqual(flat(c.fixedRanges))
      if (JSON.stringify(c.pyRanges) !== JSON.stringify(c.fixedRanges)) differing++
    }
    // The bug is real in the fixture: most cases with short pauses differ from Python's walk.
    expect(differing).toBeGreaterThanOrEqual(5)
  })

  for (const c of FX.silence) {
    it(`through its plan: ${c.name}`, LONG, async () => {
      await requireMediaTools()
      const runId = vfxRunId(++runs)
      const s = soundOf(c.sounds.audio!)
      const values: Record<string, Record<number, RunnerValue>> = {
        f: { 0: await keptBatch(h, runId, taggedFrames(c.frames)) },
        a: { 0: await keepSound(runId, s, h.kept, { hosted: false }) },
      }
      const p: ApiPrompt = { f: loader(), a: loader(), e: { class_type: 'VideoSilenceCut', inputs: { frames: ['f', 0], audio: ['a', 0], ...c.widgets } } }
      const d = await runVfxNode(h, p, 'e', values, { runId, families: ON })
      const fv = d.values[0] as Extract<RunnerValue, { kind: 'frames' }>
      const bytes = await batchBytes(h, runId, fv)
      const got = Array.from({ length: fv.count }, (_, i) => bytes[i * 8 * 8 * 3]!)
      const fixedFrames = c.fixedRanges.length ? silenceFrames(flat(c.fixedRanges), s.rate, c.widgets.fps as number, c.frames) : [0]
      expect(got, 'the frames the fixed ranges keep').toEqual(fixedFrames.map(i => i % 256))
      const sound = await readBack(h, d.values[1]!)
      const want = c.fixedRanges.length
        ? s.channels.map(ch => Float32Array.from(c.fixedRanges.flatMap(([a, b]) => Array.from(ch.subarray(a, b)))))
        : s.channels.map(ch => ch.slice(0, 1))
      expect(compare(sound, { rate: s.rate, channels: want }).equal, 'the sound sliced by the ranges').toBe(true)
      if (JSON.stringify(c.pyRanges) === JSON.stringify(c.fixedRanges)) {
        expect(got, 'Python’s own frames').toEqual(c.keptFrames.map(i => i % 256))
        expect(compare(sound, pyOf(c.outputs![0]!)).equal, 'Python’s own sound').toBe(true)
      }
    })
  }

  it('silence, or every frame kept: the batch handed on as it came', LONG, async () => {
    await requireMediaTools()
    const runId = vfxRunId(++runs)
    const frames = await keptBatch(h, runId, taggedFrames(60))
    const values = { f: { 0: frames }, a: { 0: await keepSound(runId, soundOf('bursts16'), h.kept, { hosted: false }) } }
    const p: ApiPrompt = { f: loader(), a: loader(), e: { class_type: 'VideoSilenceCut', inputs: { frames: ['f', 0], audio: ['a', 0], fps: 30, threshold_db: -40, min_silence_ms: 300, keep_padding_ms: 2000 } } }
    const d = await runVfxNode(h, p, 'e', values, { runId, families: ON })
    expect(d.values[0]).toBe(frames)
  })
})

// ── Save audio (Opus) ────────────────────────────────────────────────────────

describe('Save audio (Opus): R5.3’s export, family sound-effects', () => {
  let h: VfxHarness
  beforeAll(() => { h = vfxHarness(scratch) })

  for (const o of FX.opus) {
    it(`${o.rate} Hz at ${o.quality}: Python’s name, and its samples within 60 dB`, LONG, async () => {
      await requireMediaTools()
      const hh = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const input = await keepSound(runId, { rate: o.rate, channels: channelsOf(o.input, 2) }, hh.kept, { hosted: false })
      const p: ApiPrompt = { a: loader(), s: { class_type: 'SaveAudioOpus', inputs: { audio: ['a', 0], filename_prefix: 'audio/ComfyUI', quality: o.quality } } }
      const d = await runVfxNode(hh, p, 's', { a: { 0: input } }, { runId, families: ON })
      expect(d.ui).toEqual(o.ui)
      const path = join(hh.root, 'output', o.ui.audio[0]!.subfolder, o.ui.audio[0]!.filename)
      const got = await decodeAudio(path, { decoder: 'load', userId: null, maxSamples: 1e9, roots: [join(hh.root, 'output')] })
      const want = { rate: o.saved.decoded.rate, channels: channelsOf(o.saved.decoded.f32z, o.saved.decoded.rows) }
      expect(got.rate).toBe(want.rate)
      expect(got.channels[0]!.length).toBe(want.channels[0]!.length)
      const snr = compare(got, want).snrDb
      if (snr < 60) {
        // R5.3's named rule for Opus from a resampled source at a low bit rate (the resampler's last bits cross
        // s16 steps and the encoder's choices part): no further from the source than Python's file (within 0.5 dB).
        expect(o.rate, 'only a resampled source').not.toBe(48000)
        const source = { rate: 48000, channels: resampleLikeTorchaudio(channelsOf(o.input, 2), o.rate, 48000) }
        const cut = (x: DecodedSound) => ({ rate: x.rate, channels: x.channels.map(c => c.subarray(0, source.channels[0]!.length)) })
        const [py, ours] = [compare(cut(want), source).snrDb, compare(cut(got), source).snrDb]
        figure(`[sfx] Opus ${o.rate} ${o.quality}: ${snr.toFixed(1)} dB from Python's; from the source Python ${py.toFixed(1)}, Sailor ${ours.toFixed(1)}`)
        expect(ours).toBeGreaterThanOrEqual(py - 0.5)
      }
    })
  }
  void h
})

// ── The family ───────────────────────────────────────────────────────────────

const music = () => ({ class_type: 'GenerateMusicNode', inputs: { prompt: 'x', model: 'm', duration: 10 } })
const saveAudio = (from: string, slot = 0) => ({ class_type: 'SaveAudio', inputs: { audio: [from, slot], filename_prefix: 'audio/ComfyUI' } })
const fade = (from: string) => ({ class_type: 'AudioFade', inputs: { audio: [from, 0], fade_in: 0.5, fade_out: 0.5, curve: 'linear' } })

describe('the family', () => {
  it('rows: each class a local render reading sounds from SOUND_OUTPUTS; its sound slots in SOUND_OUTPUTS; Silence cut’s batch in FRAMES_OUTPUTS', () => {
    const rows = mediaEffectRows(SOUND_OUTPUTS)
    for (const cls of SOUND_EFFECT_CLASSES) {
      expect(MEDIA_EFFECTS_PORTED).toContain(cls)
      expect(mediaEffectSwitchedClasses()[cls]).toBe('sound-effects')
      expect(rows[cls]).toMatchObject({ family: 'sound-effects', local: 'render' })
      expect(RUNNER_OUTPUT_CLASSES.has(cls)).toBe(false)
    }
    expect(SOUND_EFFECT_OUTPUTS.map(x => x.join(':'))).toEqual(expect.arrayContaining(['SplitAudioChannels:0', 'SplitAudioChannels:1', 'VideoSilenceCut:1', 'EmptyAudio:0']))
    for (const s of SOUND_EFFECT_OUTPUTS) expect(SOUND_OUTPUTS).toContainEqual(s)
    expect(FRAMES_OUTPUTS.map(x => x.join(':'))).toContain('VideoSilenceCut:0')
    expect(VIDEO_EFFECTS.VideoSilenceCut!.family).toBe('sound-effects')
    expect(RUNNER_NODE_RULES.SaveAudioOpus).toMatchObject({ family: 'sound-effects', local: 'render' })
    expect(RUNNER_OUTPUT_CLASSES.has('SaveAudioOpus')).toBe(true)
  })

  it('with sound-effects off, a workflow with any is left to the engine and the node named; on, it is taken', () => {
    const graphs: ApiPrompt[] = [
      { l: loader(), e: fade('l'), s: saveAudio('e') },
      { e: { class_type: 'EmptyAudio', inputs: { duration: 1, sample_rate: 8000, channels: 1 } }, s: saveAudio('e') },
      { l: loader(), e: { class_type: 'SplitAudioChannels', inputs: { audio: ['l', 0] } }, s: saveAudio('e', 1) },
      { l: loader(), e: { class_type: 'SaveAudioOpus', inputs: { audio: ['l', 0], filename_prefix: 'audio/ComfyUI', quality: '128k' } } },
    ]
    for (const p of graphs) {
      expect(runnerTakesWorkflow(p, ON)).toBe(true)
      for (const fam of [SOUND_ONLY, new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['sound-effects', 'media-sound'])]) {
        expect(runnerTakesWorkflow(p, fam)).toBe(false)
        expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id })).toContain('e')
      }
    }
    // A sound from a node the runner doesn't take (a music node with audio-gen off) leaves it to the engine.
    expect(runnerTakesWorkflow({ g: music(), e: fade('g'), s: saveAudio('e') }, ON)).toBe(false)
    // Silence cut's frames into Preview image: saved one file per frame, as Python saves a batch (R11.9a, row 15, ruling (q)).
    expect(runnerTakesWorkflow({ l: loader(), v: { class_type: 'LoadVideo', inputs: { file: 'a.mp4' } }, g: { class_type: 'GetVideoComponents', inputs: { video: ['v', 0] } }, e: { class_type: 'VideoSilenceCut', inputs: { frames: ['g', 0], audio: ['g', 1], fps: 30, threshold_db: -40, min_silence_ms: 300, keep_padding_ms: 80 } }, p: { class_type: 'PreviewImage', inputs: { images: ['e', 0] } } }, ON)).toBe(true)
  })

  it('rule 12 over the synthetic graphs: with the family off, or on with its media family off, every answer is the pinned one', () => {
    const pin = rule12Pin()
    for (const cls of [...SOUND_EFFECT_CLASSES, 'SaveAudioOpus']) {
      const g = pin.graphs[`synthetic ${cls}`]!
      expect(g, cls).toBeDefined()
      for (const [set, fam] of Object.entries(pin.sets)) expect(hash16(invariantAnswers(g.prompt, new Set(fam as RunnerFamily[]))), `${cls} ${set}`).toBe(g.answers[set])
      const on = new Set<RunnerFamily>([...pin.sets['every family before R6']! as RunnerFamily[], 'sound-effects'])
      expect(hash16(invariantAnswers(g.prompt, on)), `${cls}: teeth`).not.toBe(g.answers['every family before R6'])
      expect(Object.hasOwn(PICTURE_OUTPUTS, cls)).toBe(false)
    }
    expect(PICTURE_OUTPUTS).toEqual(pin.pictureOutputs)
  })
})

// ── The start pass ───────────────────────────────────────────────────────────

describe('the start pass: every sound bounded before the run', () => {
  const src = (shape: { rate: number; channels: number; samples: number } | null) => async () => (shape ? { ...shape, exact: false } : null)

  it('a sound over effectSoundSamples (hosted) leaves the workflow to the engine; locally it runs; an unknown source too', async () => {
    const p: ApiPrompt = { l: loader(), e: fade('l'), s: saveAudio('e') }
    const long = await soundShapes(p, ON, src({ rate: 48000, channels: 2, samples: 48000 * 400 }))
    expect(soundEffectStartProblems(p, ON, { hosted: true, sounds: long })).toMatchObject({ nodeId: 'e', engine: true, message: MEDIA_EFFECT_WORDS.soundTooLong })
    expect(soundEffectStartProblems(p, ON, { hosted: false, sounds: long })).toBeNull()
    const short = await soundShapes(p, ON, src({ rate: 48000, channels: 2, samples: 48000 * 60 }))
    expect(soundEffectStartProblems(p, ON, { hosted: true, sounds: short })).toBeNull()
    expect(soundEffectStartProblems(p, ON, { hosted: true, sounds: await soundShapes(p, ON, src(null)) })).toMatchObject({ nodeId: 'e', engine: true, message: MEDIA_EFFECT_WORDS.soundUnknown })
    // The kept total: many long sounds kept in one run.
    const chain: ApiPrompt = { l: loader(), ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`e${i}`, fade(i ? `e${i - 1}` : 'l')])), s: saveAudio('e39') }
    expect(soundEffectStartProblems(chain, ON, { hosted: true, sounds: await soundShapes(chain, ON, src({ rate: 48000, channels: 2, samples: 48000 * 300 })) }))
      .toMatchObject({ engine: true, message: MEDIA_EFFECT_WORDS.soundKeptTooMuch })
    // Empty audio's length comes from its widgets: past the output cap → engine.
    const empty: ApiPrompt = { e: { class_type: 'EmptyAudio', inputs: { duration: 4000, sample_rate: 48000, channels: 2 } }, s: saveAudio('e') }
    expect(soundEffectStartProblems(empty, ON, { hosted: true, sounds: await soundShapes(empty, ON, src(null)) })).toMatchObject({ engine: true })
  })

  it('Python’s raises on what is known before the run are refused in its words', async () => {
    const at = async (p: ApiPrompt, ch: number) => soundEffectRefusals(p, ON, await soundShapes(p, ON, src({ rate: 44100, channels: ch, samples: 44100 })))
    expect(await at({ l: loader(), e: { class_type: 'SplitAudioChannels', inputs: { audio: ['l', 0] } }, s: saveAudio('e') }, 1)).toMatchObject({ message: MEDIA_EFFECT_WORDS.splitNeedsStereo, nodeId: 'e' })
    expect(await at({ l: loader(), e: { class_type: 'SplitAudioChannels', inputs: { audio: ['l', 0] } }, s: saveAudio('e') }, 2)).toBeNull()
    expect(await at({ l: loader(), m: loader(), e: { class_type: 'JoinAudioChannels', inputs: { audio_left: ['l', 0], audio_right: ['m', 0] } }, s: saveAudio('e') }, 2)).toMatchObject({ message: MEDIA_EFFECT_WORDS.joinNeedsMono })
    expect(await at({ l: loader(), e: { class_type: 'TrimAudioDuration', inputs: { audio: ['l', 0], start_index: 0, duration: 0 } }, s: saveAudio('e') }, 2)).toMatchObject({ message: MEDIA_EFFECT_WORDS.trimEmpty })
  })

  it('in the engine, hosted: Empty audio past the sound cap leaves the workflow to the engine before any work', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'refuse-'))
    const k = makeKit({ hosted: true, dir, deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')) } })
    const p: ApiPrompt = { e: { class_type: 'EmptyAudio', inputs: { duration: 700, sample_rate: 48000, channels: 2 } }, s: saveAudio('e') }
    expect(runnerTakesWorkflow(p, ON)).toBe(true)
    const err = await k.engine.startRun({ userId: k.userId, takes: [p], workflow: null, canvasId: null, projectUuid: null, projectName: null }).catch(e => e)
    // R11.9a (row 23): refused plainly before the hold, never the engine.
    // Fix round 1 (m5): an untitled node is named by its display name.
    expect(err).toMatchObject({ statusCode: 400, message: `“Empty Audio”: ${withAdvice(MEDIA_EFFECT_WORDS.soundTooLong, TOO_MUCH_WORK_WORDS)}`, data: { nodeId: 'e', code: 'too-much-work' } })
    expect(err.data.reason).toBeUndefined()
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })
})

// ── The chain in the engine ──────────────────────────────────────────────────

describe('Load audio → Fade → Normalize → Save audio in the engine', () => {
  it('runs with no engine and no provider; the saved sound is the chain’s', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'engine-'))
    const k = makeKit({ dir, deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')) } })
    copyFileSync(clipPath('a_s16.wav'), join(k.root, 'input', 'a_s16.wav'))
    const p: ApiPrompt = {
      l: { class_type: 'LoadAudio', inputs: { audio: 'a_s16.wav' } }, f: fade('l'),
      n: { class_type: 'AudioNormalize', inputs: { audio: ['f', 0], mode: 'peak', target_db: -1 } }, s: saveAudio('n'),
    }
    expect(runnerTakesWorkflow(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    for (const id of ['l', 'f', 'n', 's']) expect(t.nodes[id]!.status, `${id}: ${t.nodes[id]!.error ?? ''}`).toBe('done')
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.ledger.hold).not.toHaveBeenCalled()
    const out = join(k.root, 'output', 'audio')
    const saved = await decodeAudio(join(out, readdirSync(out)[0]!), { decoder: 'load', userId: null, maxSamples: 1e9, roots: [out] })
    let peak = 0
    for (const c of saved.channels) for (const x of c) peak = Math.max(peak, Math.abs(x))
    expect(peak).toBeCloseTo(10 ** (-1 / 20), 4)
    expect(saved.channels[0]![0]).toBe(0)
  })
})

// ── Stop and an early leave ──────────────────────────────────────────────────

describe('Silence cut stopped mid-run, and an early leave', () => {
  let h: VfxHarness
  beforeAll(() => { h = vfxHarness(scratch) })
  const cutPrompt = (): ApiPrompt => ({ f: loader(), a: loader(), e: { class_type: 'VideoSilenceCut', inputs: { frames: ['f', 0], audio: ['a', 0], fps: 30, threshold_db: -80, min_silence_ms: 300, keep_padding_ms: 80 } } })
  const big = () => ({ frames: Array.from({ length: 60 }, (_, i) => new Uint8Array(320 * 180 * 3).fill(i)), w: 320, h: 180 })

  it('stopped: no tool process left within a second, only the inputs kept', LONG, async () => {
    await requireMediaTools()
    const runId = vfxRunId(++runs)
    const values = { f: { 0: await keptBatch(h, runId, big()) }, a: { 0: await keepSound(runId, soundOf('bursts16'), h.kept, { hosted: false }) } }
    const before = PROCS.pids.length
    const inputs = readdirSync(join(h.root, 'kept', runId)).sort()
    const ctl = new AbortController()
    Object.assign(HOOK, { puts: 0, at: 5, mode: 'stop', ctl })
    try {
      await expect(runVfxNode(h, cutPrompt(), 'e', values, { runId, families: ON, signal: ctl.signal })).rejects.toThrow(MEDIA_WORDS.stopped)
      expect(Date.now() - HOOK.firedAt).toBeLessThan(1000)
    }
    finally { Object.assign(HOOK, { at: 0, ctl: null }) }
    const pids = PROCS.pids.slice(before)
    expect(pids.length).toBeGreaterThanOrEqual(2)
    for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    expect(readdirSync(join(h.root, 'kept', runId)).sort()).toEqual(inputs)
  })

  it('a writer failing mid-run: no ffmpeg left, only the inputs kept', LONG, async () => {
    await requireMediaTools()
    const runId = vfxRunId(++runs)
    const values = { f: { 0: await keptBatch(h, runId, big()) }, a: { 0: await keepSound(runId, soundOf('bursts16'), h.kept, { hosted: false }) } }
    const before = PROCS.pids.length
    const inputs = readdirSync(join(h.root, 'kept', runId)).sort()
    Object.assign(HOOK, { puts: 0, at: 3, mode: 'fail', ctl: null })
    try { await expect(runVfxNode(h, cutPrompt(), 'e', values, { runId, families: ON })).rejects.toThrow('the writer failed (test)') }
    finally { Object.assign(HOOK, { at: 0 }) }
    const pids = PROCS.pids.slice(before)
    expect(pids.length).toBeGreaterThanOrEqual(2)
    for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    expect(readdirSync(join(h.root, 'kept', runId)).sort()).toEqual(inputs)
  })
})

describe('esbuild guard: the sound core survives Nitro’s build', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = existsSync(pnpm) ? readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild')) : []
  const src = readFileSync(fileURLToPath(new URL('../../server/runner/video/core/sound.ts', import.meta.url)), 'utf8')

  it('finds an esbuild to build with', () => { expect(builds.length).toBeGreaterThan(0) })

  for (const esbuildDir of builds) {
    for (const minify of [false, true]) {
      it(`${esbuildDir.split('/').at(-3)} target es2019, minify ${minify}: sfx runs in a Worker as on this thread`, async () => {
        const esb = require(esbuildDir) as typeof import('esbuild')
        let code = (await esb.transform(src, { loader: 'ts', target: 'es2019', format: 'esm' })).code
        if (minify) code = (await esb.transform(code, { loader: 'js', target: 'es2019', minify: true })).code
        const file = join(scratch, `sound-${minify}-${Math.random().toString(36).slice(2)}.mjs`)
        writeFileSync(file, code)
        const built = await import(pathToFileURL(file).href) as { soundCore: never }
        const w = new Worker(workerScript(undefined, undefined, [{ name: 'sfx', fn: built.soundCore, args: [] }]), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          const s = soundOf('noisy48')
          const p = { rate: 48000, low_gain_dB: 6, low_freq: 100, mid_gain_dB: -3, mid_freq: 1000, mid_q: 0.707, high_gain_dB: 2, high_freq: 5000 }
          const r = await reply({ id: 1, op: 'sfx.run', fn: 'eq', channels: s.channels.map(c => c.slice()), params: p })
          expect(r.error).toBeUndefined()
          expect(sha256(new Uint8Array(r.value.channels[0].buffer))).toBe(sha256(new Uint8Array(videoCores.sfx.eq(s.channels, p).channels![0]!.buffer)))
          const b = soundOf('bursts16')
          const q = { rate: 16000, threshold_db: -40, min_silence_ms: 300, keep_padding_ms: 80 }
          const r2 = await reply({ id: 2, op: 'sfx.run', fn: 'silence', channels: b.channels.map(c => c.slice()), params: q })
          expect(r2.value.ranges).toEqual(videoCores.sfx.silence(b.channels, q).ranges)
        }
        finally { await w.terminate() }
      })
    }
  }
})

describe('the worker builds the sound core from its source text', () => {
  it('sfx composes into the worker script', () => {
    const s = workerScript()
    expect(s).toContain('built["sfx"] = ')
    expect(s).toContain("m.op === 'sfx.run'")
    expect(MEDIA_CAPS.hosted.effectSoundSamples).toBe(2 * 48000 * 600)
  })
})
