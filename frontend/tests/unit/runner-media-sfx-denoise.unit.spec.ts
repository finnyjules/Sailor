/**
 * Task R6.10: Audio denoise (family `sound-denoise`):
 * server/runner/video/core/denoise.ts (noisereduce 3.0.3's spectral gating,
 * both methods, on R6.5's shared FFT), its plan in
 * server/runner/media/soundEffects.ts and its start pass in
 * server/runner/video/soundShapes.ts.
 *
 * By the user's matching rule (the brief's controller note for R6.10) this
 * is judged by ear and by a loose figure, not last-bit parity. Against the
 * real node's output (scripts/runner_media_fixtures.py --group sfx-denoise):
 *   - the signal-to-noise figure of the runner's samples against Python's
 *     (over the fixture's windows) is at least SNR_DB;
 *   - the level left in the noise-only stretches (the noise floor) drops by
 *     the same amount as Python's, within FLOOR_DB.
 * Python's non-stationary method turns digital silence into NaN (0 / 0);
 * the runner keeps it silent (the bug fixed, rule 3).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** Every tool process started, by pid. */
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

/** A spy on the worker's sound calls: each fn and its channels' lengths; a hook after the Nth chunk (Stop, or a failure). */
const SPY = vi.hoisted(() => ({ calls: [] as { fn: string; lengths: number[] }[], chunks: 0, at: 0, mode: 'stop' as 'stop' | 'fail', ctl: null as AbortController | null }))
vi.mock('~~/server/runner/compositor/worker', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/compositor/worker')>()
  return {
    ...real,
    soundInWorker: (async (fn: string, channels: readonly Float32Array[], params: Record<string, unknown>, signal?: AbortSignal) => {
      SPY.calls.push({ fn, lengths: channels.map(c => c.length) })
      const r = await real.soundInWorker(fn, channels, params, signal)
      if (fn === 'dn.chunk' && SPY.at && ++SPY.chunks === SPY.at) {
        if (SPY.mode === 'fail') throw new Error('the worker failed (test)')
        SPY.ctl?.abort()
      }
      return r
    }) as typeof real.soundInWorker,
  }
})

import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { MEDIA_EFFECTS_PORTED, MEDIA_EFFECT_WORDS, mediaEffectRows, mediaEffectSwitchedClasses } from '#shared/runner/mediaEffects'
import { PICTURE_OUTPUTS, SOUND_OUTPUTS } from '#shared/runner/eligibility'
import { RUNNER_OUTPUT_CLASSES, runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
import type { RunnerValue } from '~~/server/runner/types'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import { soundInWorker, workerScript } from '~~/server/runner/compositor/worker'
import { videoCores } from '~~/server/runner/video/cores'
import { SOUND_DENOISE_CLASSES, denoiseRateRaise, soundEffectRefusals, soundEffectStartProblems, soundShapes } from '~~/server/runner/video/soundShapes'
import type { DecodedSound } from '~~/server/media/decode'
import { keepSound, readSound } from '~~/server/media/values'
import { requireMediaTools } from './__runner__/mediaParity'
import { makeKit } from './__runner__/kit'
import { hash16, invariantAnswers, rule12Pin, runVfxNode, sha256, vfxHarness, vfxRunId, type VfxHarness } from './__runner__/mediaEffectsParity'

// ── The fixture ──────────────────────────────────────────────────────────────

interface DnRun {
  kind: 'tone' | 'speech' | 'silence'; rate: number; channels: number; samples: number; noise_type: string; strength: number
  input_sha256: string; error?: string; handedOn?: boolean; nan?: number; output_sha256?: string
  floorIn?: number; floorOut?: number; levelOut?: number; windows?: { start: number; f32: string }[]
}
const FX = (JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-media-sfx-denoise.json'), 'utf8')) as { cases: { window: number; marginSeconds: number; runs: DnRun[] } }).cases
const LONG = { timeout: 120_000 }
const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-sound', 'media-video', 'sound-denoise'])

/** The loose acceptance (the controller's note: "e.g. ≥ 25 dB"; the noise floor's drop within a few dB of Python's). */
const SNR_DB = 25
const FLOOR_DB = 3

const scratch = mkdtempSync(join(tmpdir(), 'media-dn-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let runs = 0

/** A look number: printed, and written where DN_FIGURES names (for the task's report). */
function figure(text: string): void {
  console.info(text)
  if (process.env.DN_FIGURES) writeFileSync(process.env.DN_FIGURES, `${text}\n`, { flag: 'a' })
}
const nameOf = (r: DnRun) => `${r.kind} ${r.rate} Hz ×${r.channels} ${r.samples} samples, ${r.noise_type} at ${r.strength}`

// ── The sounds, from the fixture script's formula (dn_sound) ─────────────────

function hash32(x: number): number {
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}
function gateOf(kind: string, rate: number, n: number): number {
  const t = n / rate
  if (kind === 'tone') return Math.floor(n / (rate / 2)) % 2
  if (kind === 'speech') return (t / 1.2) % 1.0 < 0.7 ? 1 : 0
  return 0
}
function dnSound(kind: string, rate: number, C: number, N: number): DecodedSound {
  const seed = kind === 'tone' ? 3 : 5
  const channels = Array.from({ length: C }, (_, c) => {
    const y = new Float32Array(N)
    if (kind === 'silence') return y
    for (let n = 0; n < N; n++) {
      let noise = 0
      for (let j = 0; j < 4; j++) noise += hash32(((c * N + n) * 4 + j + seed * 16777259) >>> 0) / 4294967296 - 0.5
      const t = n / rate
      const g = gateOf(kind, rate, n)
      if (kind === 'tone') y[n] = g * 0.4 * Math.sin(2 * Math.PI * (440 + 220 * c) * t) + 0.05 * noise
      else {
        const phase = 2 * Math.PI * (140 + 20 * c) * t - (40 / 0.7) * Math.cos(2 * Math.PI * 0.7 * t)
        let voice = 0
        for (let h = 1; h <= 10; h++) voice += Math.sin(h * phase) / h
        voice /= 2.93
        const s = Math.sin(Math.PI * ((t * 4) % 1.0))
        y[n] = 0.3 * g * (s * s) * voice + 0.03 * noise
      }
    }
    return y
  })
  return { rate, channels }
}
function floorMask(kind: string, rate: number, N: number): Uint8Array {
  const m = Math.trunc(FX.marginSeconds * rate)
  const off = new Uint8Array(N)
  for (let n = 0; n < N; n++) {
    off[n] = gateOf(kind, rate, n) === 0 && gateOf(kind, rate, Math.max(0, n - m)) === 0 && gateOf(kind, rate, Math.min(N - 1, n + m)) === 0 ? 1 : 0
  }
  return off
}
function levelDb(chs: Float32Array[], mask: Uint8Array, want: 0 | 1): number {
  let s = 0
  let k = 0
  for (const c of chs) for (let i = 0; i < c.length; i++) if (mask[i] === want) { s += c[i]! * c[i]!; k++ }
  return 10 * Math.log10(s / k + 1e-30)
}
const bytesOf = (c: Float32Array) => new Uint8Array(c.buffer, c.byteOffset, c.byteLength)
const f32 = (b64: string) => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }

/** The runner's samples against Python's over the fixture's windows (dB). */
function windowSnr(r: DnRun, got: Float32Array[]): number {
  let sig = 0
  let err = 0
  for (const w of r.windows!) {
    const py = f32(w.f32)
    const n = py.length / r.channels
    for (let c = 0; c < r.channels; c++) {
      for (let i = 0; i < n; i++) {
        const a = py[c * n + i]!
        const d = got[c]![w.start + i]! - a
        sig += a * a
        err += d * d
      }
    }
  }
  return err === 0 ? Infinity : 10 * Math.log10(sig / err)
}

const soundCache = new Map<string, DecodedSound>()
const soundOfRun = (r: DnRun) => {
  const k = `${r.kind} ${r.rate} ${r.channels} ${r.samples}`
  if (!soundCache.has(k)) soundCache.set(k, dnSound(r.kind, r.rate, r.channels, r.samples))
  return soundCache.get(k)!
}
const coreOut = (r: DnRun) => videoCores.dn.denoise(soundOfRun(r).channels, { rate: r.rate, stationary: r.noise_type === 'stationary', prop: r.strength })
const worked = FX.runs.filter(r => !r.error && !r.handedOn)

// ── The fixture and the sounds ───────────────────────────────────────────────

describe('the fixture: the real node over sounds of a shared formula', () => {
  it('covers both methods, strength 1 / 0.5 / 0, chunks crossed, 8 / 44.1 / 48 kHz, mono and stereo, silence and the raise', () => {
    for (const m of ['stationary', 'non_stationary']) {
      const rs = FX.runs.filter(r => r.noise_type === m)
      expect(new Set(rs.map(r => r.strength))).toEqual(new Set([1, 0.5, 0]))
      expect(rs.some(r => r.samples > 600000)).toBe(true)
      expect(new Set(rs.map(r => r.rate))).toEqual(new Set([4000, 8000, 44100, 48000]))
      expect(new Set(rs.map(r => r.channels))).toEqual(new Set([1, 2]))
      expect(rs.some(r => r.kind === 'speech')).toBe(true)
      expect(rs.filter(r => r.error).map(r => r.rate)).toEqual([4000])
      expect(rs.filter(r => r.handedOn).map(r => r.strength)).toEqual([0])
    }
    // Python's non-stationary method on digital silence: NaN throughout.
    expect(FX.runs.find(r => r.kind === 'silence' && r.noise_type === 'non_stationary')!.nan).toBe(8000)
  })

  it('the sounds are the script’s (its sha256, or within a float32 step where a sine’s last bit differs)', () => {
    for (const r of FX.runs) {
      const s = soundOfRun(r)
      const flat = new Float32Array(r.channels * r.samples)
      s.channels.forEach((c, k) => flat.set(c, k * r.samples))
      if (sha256(new Uint8Array(flat.buffer)) === r.input_sha256) continue
      // Not byte-equal: only a sine's last bit may differ (V8's and the platform's libm); every noise sample is integer-exact.
      throw new Error(`${nameOf(r)}: the sound differs from the script's`)
    }
  })
})

// ── The core against Python ──────────────────────────────────────────────────

describe('the core on this thread: sounds like Python’s (loose SNR, the same noise-floor drop)', () => {
  for (const r of worked) {
    it(nameOf(r), LONG, () => {
      const got = coreOut(r)
      expect(got).toHaveLength(r.channels)
      for (const c of got) {
        expect(c.length).toBe(r.samples)
        expect(c.some(Number.isNaN), 'no NaN').toBe(false)
      }
      if (r.kind === 'silence') {
        // Stationary: Python's zeros. Non-stationary: Python's NaN, fixed to silence.
        for (const c of got) expect(c.every(x => x === 0)).toBe(true)
        return
      }
      const snr = windowSnr(r, got)
      const mask = floorMask(r.kind, r.rate, r.samples)
      const input = soundOfRun(r).channels
      const inFloor = levelDb(input, mask, 1)
      expect(inFloor).toBeCloseTo(r.floorIn!, 3)
      const ours = inFloor - levelDb(got, mask, 1)
      const py = r.floorIn! - r.floorOut!
      const level = levelDb(got, mask, 0)
      const flatOut = new Float32Array(r.channels * r.samples)
      got.forEach((c, k) => flatOut.set(c, k * r.samples))
      const same = sha256(new Uint8Array(flatOut.buffer)) === r.output_sha256
      figure(`[dn] ${nameOf(r)}: ${same ? 'bit-identical to Python; ' : ''}SNR against Python ${snr.toFixed(1)} dB; noise floor drop Python ${py.toFixed(2)} dB, Sailor ${ours.toFixed(2)} dB; level elsewhere Python ${r.levelOut!.toFixed(2)}, Sailor ${level.toFixed(2)} dB`)
      if (process.env.DN_LISTEN) {
        mkdirSync(process.env.DN_LISTEN, { recursive: true })
        writeFileSync(join(process.env.DN_LISTEN, `sailor_${r.kind}_${r.rate}_${r.channels}ch_${r.samples}_${r.noise_type}_${r.strength}.f32`), Buffer.from(flatOut.buffer))
      }
      expect(snr, 'against Python’s samples').toBeGreaterThanOrEqual(SNR_DB)
      expect(Math.abs(ours - py), 'the noise floor’s drop').toBeLessThanOrEqual(FLOOR_DB)
      expect(Math.abs(level - r.levelOut!), 'the level outside the noise-only stretches').toBeLessThanOrEqual(FLOOR_DB)
    })
  }

  it('the rate too low (or too high) for the smoothing filter raises, as Python; 5,120 Hz to 256 kHz work', () => {
    expect(denoiseRateRaise(4000)).toBe(MEDIA_EFFECT_WORDS.denoiseRateLow)
    expect(denoiseRateRaise(5119)).toBe(MEDIA_EFFECT_WORDS.denoiseRateLow)
    expect(denoiseRateRaise(5120)).toBeNull()
    expect(denoiseRateRaise(256000)).toBeNull()
    expect(denoiseRateRaise(256001)).toBe(MEDIA_EFFECT_WORDS.denoiseRateHigh)
    expect(videoCores.dn.smoothingOf(4000)).toBe('low')
  })

  it('filtfilt matches scipy’s first-order case on a step (a constant row stays constant)', () => {
    const y = videoCores.dn.filtfilt(new Float64Array(50).fill(3), 0.02)
    for (const v of y) expect(v).toBeCloseTo(3, 12)
  })

  it('the STFT and its inverse give the sound back (no mask)', () => {
    const x = dnSound('tone', 8000, 1, 5000).channels[0]!
    const { re, im, nseg } = videoCores.dn.stft(x)
    const y = videoCores.dn.istft(re, im, nseg)
    expect(y.length).toBe(Math.floor(5000 / 256) * 256)
    for (let i = 0; i < y.length; i++) expect(Math.abs(y[i]! - x[i]!)).toBeLessThan(1e-12)
  })
})

// ── Through its plan ─────────────────────────────────────────────────────────

const loader = () => ({ class_type: 'LoadAudio', inputs: { audio: 'a.wav' } })
const denoisePrompt = (r: Pick<DnRun, 'noise_type' | 'strength'>): ApiPrompt => ({ in: loader(), e: { class_type: 'AudioDenoise', inputs: { audio: ['in', 0], strength: r.strength, noise_type: r.noise_type } } })
const readBack = (h: VfxHarness, v: RunnerValue) => readSound(v, 'AudioDenoise', { access: h.access, userId: null, hosted: false })

describe('through its plan, on the worker (family sound-denoise)', () => {
  let h: VfxHarness
  beforeAll(() => { h = vfxHarness(scratch) })

  const picked = FX.runs.filter(r => r.samples <= 150000)
  for (const r of picked) {
    it(nameOf(r), LONG, async () => {
      await requireMediaTools()
      const runId = vfxRunId(++runs)
      const input = await keepSound(runId, soundOfRun(r), h.kept, { hosted: false })
      const before = readdirSync(join(h.root, 'kept', runId)).sort()
      const go = () => runVfxNode(h, denoisePrompt(r), 'e', { in: { 0: input } }, { runId, families: ON })
      if (r.error) {
        await expect(go()).rejects.toThrow(MEDIA_EFFECT_WORDS.denoiseRateLow)
        return
      }
      const d = await go()
      if (r.handedOn) {
        expect((d.values[0] as Extract<RunnerValue, { kind: 'files' }>).files).toEqual((input as Extract<RunnerValue, { kind: 'files' }>).files)
        expect(readdirSync(join(h.root, 'kept', runId)).sort(), 'nothing new kept').toEqual(before)
        return
      }
      const got = await readBack(h, d.values[0]!)
      expect(got.rate).toBe(r.rate)
      // The worker's chunks are this thread's, bit for bit, and the kept WAV reads back exactly.
      const here = coreOut(r)
      for (let c = 0; c < r.channels; c++) expect(sha256(bytesOf(got.channels[c]!)), `channel ${c}`).toBe(sha256(bytesOf(here[c]!)))
      expect(d.ui).toBeNull()
    })
  }

  it('a 70-second sound is worked on chunk by chunk: the profile once, then one worker call per 600,000 samples, each padded', LONG, async () => {
    await requireMediaTools()
    const runId = vfxRunId(++runs)
    const N = 48000 * 70
    const input = await keepSound(runId, dnSound('tone', 48000, 1, N), h.kept, { hosted: false })
    SPY.calls.length = 0
    const t0 = Date.now()
    await runVfxNode(h, denoisePrompt({ noise_type: 'stationary', strength: 1 }), 'e', { in: { 0: input } }, { runId, families: ON })
    figure(`[dn] 70 s mono at 48 kHz, stationary, through its plan: ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    const chunks = SPY.calls.filter(c => c.fn === 'dn.chunk')
    expect(SPY.calls.filter(c => c.fn === 'dn.profile').map(c => c.lengths)).toEqual([[600000]])
    expect(chunks).toHaveLength(Math.ceil(N / 600000))
    for (const c of chunks) expect(c.lengths).toEqual([660000])
  })

  it('Stop between chunks: the work ends within one chunk, nothing new kept, no tool process left', LONG, async () => {
    await requireMediaTools()
    const runId = vfxRunId(++runs)
    const input = await keepSound(runId, dnSound('tone', 48000, 1, 48000 * 70), h.kept, { hosted: false })
    const before = readdirSync(join(h.root, 'kept', runId)).sort()
    const pids = PROCS.pids.length
    const ctl = new AbortController()
    SPY.calls.length = 0
    Object.assign(SPY, { chunks: 0, at: 1, mode: 'stop', ctl })
    try {
      await expect(runVfxNode(h, denoisePrompt({ noise_type: 'non_stationary', strength: 1 }), 'e', { in: { 0: input } }, { runId, families: ON, signal: ctl.signal })).rejects.toThrow()
    }
    finally { Object.assign(SPY, { at: 0, ctl: null }) }
    expect(SPY.calls.filter(c => c.fn === 'dn.chunk')).toHaveLength(1)
    expect(readdirSync(join(h.root, 'kept', runId)).sort()).toEqual(before)
    for (const pid of PROCS.pids.slice(pids)) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
  })

  it('an early leave (the worker fails mid-sound): no ffmpeg left, nothing new kept', LONG, async () => {
    await requireMediaTools()
    const runId = vfxRunId(++runs)
    const input = await keepSound(runId, dnSound('tone', 16000, 2, 16000 * 50), h.kept, { hosted: false })
    const before = readdirSync(join(h.root, 'kept', runId)).sort()
    const pids = PROCS.pids.length
    Object.assign(SPY, { chunks: 0, at: 1, mode: 'fail', ctl: null })
    try { await expect(runVfxNode(h, denoisePrompt({ noise_type: 'stationary', strength: 0.5 }), 'e', { in: { 0: input } }, { runId, families: ON })).rejects.toThrow('the worker failed (test)') }
    finally { Object.assign(SPY, { at: 0 }) }
    expect(PROCS.pids.length, 'the input was read by the tools').toBeGreaterThan(pids)
    for (const pid of PROCS.pids.slice(pids)) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    expect(readdirSync(join(h.root, 'kept', runId)).sort()).toEqual(before)
  })

  it('the worker’s profile is this thread’s', LONG, async () => {
    const s = dnSound('speech', 44100, 2, 44100)
    const there = await soundInWorker('dn.profile', s.channels.map(c => c.slice()), {}) as { thresh?: Float64Array }
    expect(Array.from(there.thresh!)).toEqual(Array.from(videoCores.dn.profile(s.channels, {}).thresh!))
  })
})

// ── The family ───────────────────────────────────────────────────────────────

const saveAudio = (from: string) => ({ class_type: 'SaveAudio', inputs: { audio: [from, 0], filename_prefix: 'audio/ComfyUI' } })

describe('the family', () => {
  it('row: a local render reading a sound from SOUND_OUTPUTS; its sound slot a source; not an output node', () => {
    expect(SOUND_DENOISE_CLASSES).toEqual(['AudioDenoise'])
    expect(MEDIA_EFFECTS_PORTED).toContain('AudioDenoise')
    expect(mediaEffectSwitchedClasses().AudioDenoise).toBe('sound-denoise')
    expect(mediaEffectRows(SOUND_OUTPUTS).AudioDenoise).toMatchObject({ family: 'sound-denoise', local: 'render', mustLink: ['audio'] })
    expect(SOUND_OUTPUTS).toContainEqual(['AudioDenoise', 0])
    expect(RUNNER_OUTPUT_CLASSES.has('AudioDenoise')).toBe(false)
  })

  it('with sound-denoise off (or its media family off), a workflow with it is left to the engine and the node named; on, it is taken', () => {
    const p: ApiPrompt = { l: loader(), e: { class_type: 'AudioDenoise', inputs: { audio: ['l', 0], strength: 1, noise_type: 'stationary' } }, s: saveAudio('e') }
    expect(runnerTakesWorkflow(p, ON)).toBe(true)
    for (const fam of [new Set<RunnerFamily>(['cards', 'media-sound', 'media-video', 'sound-effects']), new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['sound-denoise', 'media-sound'])]) {
      expect(runnerTakesWorkflow(p, fam)).toBe(false)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id })).toContain('e')
    }
  })

  it('rule 12 over its synthetic graph: every answer the pinned one, with the family off; teeth with it on', () => {
    const pin = rule12Pin()
    const g = pin.graphs['synthetic AudioDenoise']!
    expect(g).toBeDefined()
    for (const [set, fam] of Object.entries(pin.sets)) expect(hash16(invariantAnswers(g.prompt, new Set(fam as RunnerFamily[]))), set).toBe(g.answers[set])
    const on = new Set<RunnerFamily>([...pin.sets['every family before R6']! as RunnerFamily[], 'sound-denoise'])
    expect(hash16(invariantAnswers(g.prompt, on))).not.toBe(g.answers['every family before R6'])
    expect(Object.hasOwn(PICTURE_OUTPUTS, 'AudioDenoise')).toBe(false)
    expect(PICTURE_OUTPUTS).toEqual(pin.pictureOutputs)
  })
})

// ── The start pass ───────────────────────────────────────────────────────────

describe('the start pass', () => {
  const src = (shape: { rate: number; channels: number; samples: number } | null, exact = false) => async () => (shape ? { ...shape, exact } : null)
  const p = (strength = 1): ApiPrompt => ({ l: loader(), e: { class_type: 'AudioDenoise', inputs: { audio: ['l', 0], strength, noise_type: 'non_stationary' } }, s: saveAudio('e') })

  it('the sound is bounded as the other sound effects’: over effectSoundSamples hosted → engine; locally it runs; unknown → engine', async () => {
    const long = await soundShapes(p(), ON, src({ rate: 48000, channels: 2, samples: 48000 * 400 }))
    expect(long.get('e:0')).toMatchObject({ rate: 48000, channels: 2 })
    expect(soundEffectStartProblems(p(), ON, { hosted: true, sounds: long })).toMatchObject({ nodeId: 'e', engine: true, message: MEDIA_EFFECT_WORDS.soundTooLong })
    expect(soundEffectStartProblems(p(), ON, { hosted: false, sounds: long })).toBeNull()
    expect(soundEffectStartProblems(p(), ON, { hosted: true, sounds: await soundShapes(p(), ON, src(null)) })).toMatchObject({ engine: true, message: MEDIA_EFFECT_WORDS.soundUnknown })
  })

  it('a rate too low is refused before the hold where the sound is known to have samples; strength 0 never raises', async () => {
    const at = async (q: ApiPrompt, exact: boolean) => soundEffectRefusals(q, ON, await soundShapes(q, ON, src({ rate: 4000, channels: 1, samples: 4000 }, exact)))
    expect(await at(p(), true)).toMatchObject({ nodeId: 'e', message: MEDIA_EFFECT_WORDS.denoiseRateLow })
    expect(await at(p(0), true)).toBeNull()
    // Only a bound: the sound might be empty (Python hands it on), so the plan decides.
    expect(await at(p(), false)).toBeNull()
  })

  it('in the engine, hosted: a sound too long leaves the workflow to the engine before any hold', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'refuse-'))
    const fam = new Set<RunnerFamily>([...ON, 'sound-effects'])
    const k = makeKit({ hosted: true, dir, deps: { families: () => fam, kept: createFileKeptBytes(join(dir, 'kept')) } })
    // Empty audio's 400 s of stereo fits on its own; the denoise holds it twice (in and out), past the hosted limit.
    const q: ApiPrompt = {
      e0: { class_type: 'EmptyAudio', inputs: { duration: 400, sample_rate: 48000, channels: 2 } },
      e: { class_type: 'AudioDenoise', inputs: { audio: ['e0', 0], strength: 1, noise_type: 'stationary' } }, s: saveAudio('e'),
    }
    expect(runnerTakesWorkflow(q, fam)).toBe(true)
    const err = await k.engine.startRun({ userId: k.userId, takes: [q], workflow: null, canvasId: null, projectUuid: null, projectName: null }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 400, message: MEDIA_EFFECT_WORDS.soundTooLong, data: { nodeId: 'e', reason: RUNNER_NOT_ELIGIBLE } })
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })
})

// ── The worker builds the core ───────────────────────────────────────────────

describe('esbuild guard: the denoise core survives Nitro’s build', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = existsSync(pnpm) ? readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild')) : []
  const read = (f: string) => readFileSync(fileURLToPath(new URL(`../../server/runner/video/core/${f}`, import.meta.url)), 'utf8')

  it('finds an esbuild to build with', () => { expect(builds.length).toBeGreaterThan(0) })

  for (const esbuildDir of builds) {
    for (const minify of [false, true]) {
      it(`${esbuildDir.split('/').at(-3)} target es2019, minify ${minify}: dn.chunk runs in a Worker as on this thread`, LONG, async () => {
        const esb = require(esbuildDir) as typeof import('esbuild')
        const built: Record<string, unknown> = {}
        for (const [f, name] of [['fft.ts', 'fftCore'], ['denoise.ts', 'denoiseCore']] as const) {
          let code = (await esb.transform(read(f), { loader: 'ts', target: 'es2019', format: 'esm' })).code
          if (minify) code = (await esb.transform(code, { loader: 'js', target: 'es2019', minify: true })).code
          const file = join(scratch, `${name}-${minify}-${Math.random().toString(36).slice(2)}.mjs`)
          writeFileSync(file, code)
          built[name] = (await import(pathToFileURL(file).href) as Record<string, unknown>)[name]
        }
        const w = new Worker(workerScript(undefined, undefined, [
          { name: 'ft', fn: built.fftCore as never, args: [] }, { name: 'dn', fn: built.denoiseCore as never, args: ['ft'] },
        ]), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          const s = dnSound('speech', 16000, 1, 16000)
          const dn = videoCores.dn
          const thresh = dn.profile(s.channels, {}).thresh!
          for (const stationary of [true, false]) {
            const params = { rate: 16000, stationary, prop: 1, thresh, from: dn.PAD, to: dn.PAD + 16000 }
            const chs = dn.padded(s.channels, 0, 16000)
            const r = await reply({ id: 1, op: 'sfx.run', fn: 'dn.chunk', channels: chs.map(c => c.slice()), params })
            expect(r.error).toBeUndefined()
            expect(sha256(new Uint8Array(r.value.channels[0].buffer))).toBe(sha256(new Uint8Array(dn.chunk(chs, params).channels![0]!.buffer)))
          }
        }
        finally { await w.terminate() }
      })
    }
  }

  it('dn composes into the worker script, after the FFT', () => {
    const s = workerScript()
    expect(s.indexOf('built["dn"] = ')).toBeGreaterThan(s.indexOf('built["ft"] = '))
  })
})
