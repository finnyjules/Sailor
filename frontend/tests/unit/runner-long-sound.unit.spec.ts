/**
 * Step 3, R11.5 (ruling (h)): long sounds in pieces.
 *
 * Whisper transcribe and Vocal separator send their WHOLE sound to a service.
 * One longer than a call takes where it runs (Whisper: hosted 30 minutes,
 * locally an hour; Vocal separator: hosted 10 minutes, locally 20) is now
 * converted once and cut by the one shared splitter (server/media/split.ts)
 * at the quietest point of the last 30 s before each limit (Whisper's pieces
 * at most 30 minutes, Vocal separator's 10), one call a piece. Whisper's
 * segments are moved by each piece's start and the texts made from them all;
 * each stem is joined end to end. The hold is pieces × price from the probe,
 * a true upper bound (#shared/runner/soundPieces); only delivered pieces are
 * charged; Stop between pieces sends nothing more and releases the rest; a
 * hard ceiling (an hour of song, three hours of speech) is refused plainly
 * before the hold (runner-local-whisper, runner-local-vocals, app-karaoke-run).
 *
 * Fake fal and Replicate: no paid call. The sound parts need the real tools
 * (R5.1a): they fail, never skip, when the tools are missing.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createFakeFal, createFakeReplicate, makeKit } from './__runner__/kit'
import { requireMediaTools } from './__runner__/mediaParity'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import {
  VOCALS_CLASS, VOCALS_PIECE_SECONDS, VOCALS_RATE, VOCALS_SLUG, VOCALS_WORDS, WHISPER_CLASS, WHISPER_PIECE_SECONDS, WHISPER_SLUG,
  soundReadOnlyByPieces, vocalsCalls, whisperCalls,
} from '#shared/runner/localModels'
import { SOUND_PIECE_WINDOW_SECONDS, quietestCuts, soundPieceBounds, soundPieceCount } from '#shared/runner/soundPieces'
import { MEDIA_WORDS } from '#shared/runner/media'
import { paidCallUsd } from '#shared/pricing/paidRates'
import { localModelPrice, perFrameCredits } from '#shared/pricing/nodePrice'
import { planNode, type NodePlan, type PipelineIO } from '~~/server/runner/executors'
import { offsetChunks, whisperOutputs } from '~~/server/runner/generators/localModels'
import { floatWav } from '~~/server/media/encode'
import { probeMedia } from '~~/server/media/probe'
import { floatWavFrames, pieceSamples, pieceSpan, splitSound, type SoundPieces } from '~~/server/media/split'
import { isPieced, vocalsSoundOf, type PiecedSound } from '~~/server/runner/soundWav'

/** Fix round 1: a header that says more than the file decodes to (a VBR MP3's estimate), by `extra` seconds. */
const HEADER = vi.hoisted(() => ({ extra: 0 }))
vi.mock('~~/server/media/probe', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/probe')>()
  return { ...real, soundSeconds: (p: Parameters<typeof real.soundSeconds>[0], t: Parameters<typeof real.soundSeconds>[1]) => {
    const s = real.soundSeconds(p, t)
    return s === null ? null : s + HEADER.extra
  } }
})

const WHISPER_ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-sound', 'whisper-captions'])
const VOCALS_ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-sound', 'vocal-split'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

/** Folders this file made, removed at the end (the disk is shared). */
const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
const scratch = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  made.push(d)
  return d
}

/** A 16-bit mono WAV: loud noise (an LCG) everywhere but the silent spans (seconds). */
function noiseWav(rate: number, seconds: number, silent: [number, number][] = [], seed = 1): Uint8Array {
  const n = Math.round(rate * seconds)
  const data = Buffer.alloc(n * 2)
  let state = seed & 0x7FFFFFFF
  for (let i = 0; i < n; i++) {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7FFFFFFF
    const t = i / rate
    const quiet = silent.some(([a, b]) => t >= a && t < b)
    data.writeInt16LE(quiet ? 0 : ((state >> 8) & 0x3FFF) - 8192, i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return new Uint8Array(Buffer.concat([h, data]))
}

function putInput(root: string, name: string, bytes: Uint8Array) {
  mkdirSync(join(root, 'input', 'user_1'), { recursive: true })
  writeFileSync(join(root, 'input', 'user_1', name), bytes)
  writeFileSync(join(root, 'input', name), bytes)
}

/** A 130 s sound cut with 40 s pieces: silent 35–70 s and 100–101 s, so the cuts fall in silence and piece 2 is silent. */
async function smallPieces(rate: number, channels: 1 | 2): Promise<SoundPieces> {
  const dir = scratch('long-sound-src-')
  const path = join(dir, 'speech.wav')
  writeFileSync(path, noiseWav(rate, 130, [[35, 70], [100, 101]]))
  const probe = await probeMedia(path, { userId: null, roots: [dir], kind: 'sound' })
  const p = await splitSound(probe, { stream: 0, rate, channels, limit: 40, ceiling: 300, userId: null })
  made.push(p.dir)
  return p
}
const piecedOf = (p: SoundPieces): PiecedSound => ({ wav: new Uint8Array(0), seconds: p.seconds, frames: p.frames, rate: p.rate, channels: p.channels, pieces: p })

// ── The arithmetic ───────────────────────────────────────────────────────────

describe('the pieces\' arithmetic: the hold is a true upper bound of what the cutter makes', () => {
  it('at most 1 + ceil((S − limit) / (limit − window)) pieces; one for a sound that fits', () => {
    expect(SOUND_PIECE_WINDOW_SECONDS).toBe(30)
    expect([soundPieceCount(600, 600), soundPieceCount(720, 600), soundPieceCount(1170, 600), soundPieceCount(1171, 600), soundPieceCount(1801, 1800)]).toEqual([1, 2, 2, 3, 2])
    // A 12-minute song: two Demucs calls of at most 10 minutes and 150 s.
    expect(soundPieceBounds(720, 600, VOCALS_PIECE_SECONDS)).toEqual([600, 150])
    // Within one call's cap (locally 20 minutes): one call.
    expect(soundPieceBounds(1100, 1200, VOCALS_PIECE_SECONDS)).toEqual([1100])
    expect(soundPieceBounds(1250, 1200, VOCALS_PIECE_SECONDS)).toEqual([600, 600, 110])
  })

  it('random loudness, random lengths: never more pieces than held, no piece past the limit, none but the last shorter than limit − window, and the priced bounds cover the real pieces', () => {
    let seed = 7
    const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7FFFFFFF; return seed / 0x7FFFFFFF }
    for (let trial = 0; trial < 300; trial++) {
      const rate = 20
      const block = 1
      const limit = 600 * rate
      const window = 30 * rate
      const seconds = 600 + rnd() * 3000
      const total = Math.floor(seconds * rate)
      const quiet = Float64Array.from({ length: Math.ceil(total / block) }, () => Math.floor(rnd() * 4))
      const cuts = quietestCuts(quiet, { total, block, limit, window })
      const starts = [0, ...cuts]
      const lengths = starts.map((s, i) => (starts[i + 1] ?? total) - s)
      expect(starts.length).toBeLessThanOrEqual(soundPieceCount(total, limit, window))
      for (const [i, l] of lengths.entries()) {
        expect(l).toBeLessThanOrEqual(limit)
        if (i < lengths.length - 1) expect(l).toBeGreaterThanOrEqual(limit - window)
      }
      // The hold (each piece's bound, Demucs' floor per call) is never below the pieces' real price.
      const usd = (s: number) => paidCallUsd({ endpoint: VOCALS_SLUG, inputSeconds: s })!
      const real = lengths.reduce((a, l) => a + usd(l / rate), 0)
      const held = soundPieceBounds(total / rate, 600, 600).reduce((a, s) => a + usd(s), 0)
      expect(real).toBeLessThanOrEqual(held + 1e-9)
    }
  })

  it('the prices: a known sound past one call\'s cap is held as its pieces (the card\'s floor per Demucs call); an unknown one at one call\'s cap; never past the ceiling', () => {
    // A 31-minute sound through Wizper (hosted): two calls, 30 minutes and what is left.
    expect(whisperCalls({ audio: 31 * 60, place: 'hosted' })).toEqual({ steps: [
      { call: { endpoint: WHISPER_SLUG, inputSeconds: 1800 }, times: 1 }, { call: { endpoint: WHISPER_SLUG, inputSeconds: 90 }, times: 1 },
    ] })
    // Locally an hour is still one call.
    expect(whisperCalls({ audio: 3600, place: 'local' })).toEqual({ steps: [{ call: { endpoint: WHISPER_SLUG, inputSeconds: 3600 }, times: 1 }] })
    expect(whisperCalls({ place: 'hosted' })).toEqual({ steps: [{ call: { endpoint: WHISPER_SLUG, inputSeconds: 1800 }, times: 1 }] })
    // Past the ceiling, priced at the ceiling (the start of the run refuses it).
    const atCeiling = whisperCalls({ audio: 4 * 3600, place: 'hosted' })
    expect('steps' in atCeiling && atCeiling.steps.reduce((n, s) => n + s.times, 0)).toBe(soundPieceCount(3 * 3600, WHISPER_PIECE_SECONDS))
    // A 12-minute song (hosted, htdemucs_ft: four times the work): two calls.
    expect(vocalsCalls({ model: 'htdemucs_ft', shifts: 1 }, { audio: 720, place: 'hosted' })).toEqual({ steps: [
      { call: { endpoint: VOCALS_SLUG, inputSeconds: 2400 }, times: 1 }, { call: { endpoint: VOCALS_SLUG, inputSeconds: 600 }, times: 1 },
    ] })
    // At the card: 600 s and 150 s of htdemucs, the second at the $0.034 floor.
    const p = localModelPrice(vocalsCalls({ model: 'htdemucs', shifts: 1 }, { audio: 720, place: 'hosted' }))
    expect('usd' in p && p.usd).toBeCloseTo(0.12 + 0.034, 8)
    // The price only grows with the sound.
    let last = 0
    for (let s = 500; s < 3600; s += 7) {
      const q = localModelPrice(vocalsCalls({ model: 'htdemucs', shifts: 1 }, { audio: s, place: 'hosted' }))
      const usd = 'usd' in q ? q.usd : Number.NaN
      expect(usd).toBeGreaterThanOrEqual(last - 1e-12)
      last = usd
    }
  })

  it('a loaded sound read only by nodes that send it in pieces (through Audio cards) is judged by its size, not R5\'s length', () => {
    const load = { class_type: 'LoadAudio', inputs: { audio: 'a.wav' } }
    expect(soundReadOnlyByPieces({ s: load, n: { class_type: WHISPER_CLASS, inputs: { audio: ['s', 0] } } }, 's')).toBe(true)
    expect(soundReadOnlyByPieces({ s: load, c: { class_type: 'Audio', inputs: { source: ['s', 0], audio: '', export: false } }, n: { class_type: VOCALS_CLASS, inputs: { audio: ['c', 0] } } }, 's')).toBe(true)
    // Anything else reading it (a save, an exporting card, a sound effect): R5's caps as before.
    expect(soundReadOnlyByPieces({ s: load, n: { class_type: WHISPER_CLASS, inputs: { audio: ['s', 0] } }, v: { class_type: 'SaveAudio', inputs: { audio: ['s', 0] } } }, 's')).toBe(false)
    expect(soundReadOnlyByPieces({ s: load, c: { class_type: 'Audio', inputs: { source: ['s', 0], export: true } }, n: { class_type: VOCALS_CLASS, inputs: { audio: ['c', 0] } } }, 's')).toBe(false)
    expect(soundReadOnlyByPieces({ s: load }, 's')).toBe(false)
  })
})

// ── The splitter ─────────────────────────────────────────────────────────────

describe('the splitter (server/media/split.ts)', () => {
  it('cuts at the quietest point of the last 30 s before each limit, never past it; the pieces joined are the whole converted sound, sample for sample', async () => {
    await requireMediaTools()
    const p = await smallPieces(16000, 1)
    expect([p.rate, p.channels, p.frames]).toEqual([16000, 1, 130 * 16000])
    // From 0: the window is 10–40 s, silent from 35 s: the latest silent block (39.95 s), cut at its middle.
    // From there: 49.975–79.975 s, silent to 70 s. Then 79.975–109.975 s: the silence at 100–101 s.
    expect(p.starts.map(s => s / 16000)).toEqual([0, 39.975, 69.975, 100.975])
    for (let i = 0; i < p.starts.length; i++) expect(pieceSpan(p, i).seconds).toBeLessThanOrEqual(40)
    // Joined end to end: the converted sound, no gap, no overlap.
    const whole = new Int16Array(new Uint8Array(readFileSync(p.path)).slice(p.dataOffset).buffer)
    const joined = new Int16Array(whole.length)
    let at = 0
    for (let i = 0; i < p.starts.length; i++) {
      const part = await pieceSamples(p, i)
      joined.set(part, at)
      at += part.length
    }
    expect(at).toBe(whole.length)
    expect(joined.every((v, j) => v === whole[j])).toBe(true)
    // The source was 16 kHz mono already: the converted samples are the file's own.
    expect(whole[0]).toBe(new DataView(noiseWav(16000, 130, [[35, 70], [100, 101]]).buffer).getInt16(44, true))
  }, 60_000)

  it('refuses a sound past the ceiling (the decode stops a sample after it), and Stop', async () => {
    await requireMediaTools()
    const dir = scratch('long-sound-cap-')
    const path = join(dir, 'speech.wav')
    writeFileSync(path, noiseWav(8000, 70))
    const probe = await probeMedia(path, { userId: null, roots: [dir], kind: 'sound' })
    await expect(splitSound(probe, { stream: 0, rate: 16000, channels: 1, limit: 40, ceiling: 60, userId: null })).rejects.toThrow(MEDIA_WORDS.tooLong)
    const stop = new AbortController()
    stop.abort()
    await expect(splitSound(probe, { stream: 0, rate: 16000, channels: 1, limit: 40, ceiling: 300, userId: null, signal: stop.signal })).rejects.toThrow(MEDIA_WORDS.stopped)
  }, 60_000)
})

describe('fix round 1', () => {
  it('Important: the choice between one call and pieces is made on the decoded length the price reads — a song whose header says past one call but which decodes within it is sent as ONE call, never more than held', async () => {
    await requireMediaTools()
    // Locally one Vocal separator call takes 20 minutes and pieces are 10: the header says 20:50, the file is 19:10.
    const dir = scratch('long-sound-header-')
    writeFileSync(join(dir, 'song.wav'), noiseWav(1000, 1150))
    HEADER.extra = 100
    const dirs: string[] = []
    try {
      const io = {
        access: { verifiedPath: async () => join(dir, 'song.wav'), rootOf: () => dir } as never,
        userId: null, hosted: false, pieceDirs: dirs,
      }
      const got = await vocalsSoundOf({ kind: 'files', files: [{ filename: 'song.wav', subfolder: '', type: 'input' }] }, 'LoadAudio', io)
      expect(isPieced(got)).toBe(true)
      if (!isPieced(got)) return
      expect(got.seconds).toBe(1150)
      // Priced as one call on these 1,150 s: so it is one piece.
      const bounds = soundPieceBounds(got.seconds, 1200, VOCALS_PIECE_SECONDS)
      expect(bounds).toEqual([1150])
      expect(got.pieces.starts).toEqual([0])
      expect(got.pieces.starts.length).toBeLessThanOrEqual(bounds.length)
    }
    finally {
      HEADER.extra = 0
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
    }
    // Past one call (and with `single` given), it is still cut.
    const p = await smallPieces(16000, 1)
    expect(p.starts.length).toBe(4)
  }, 120_000)

  it('Minor 4: a segment stamped past its piece\'s end (or before its start) is held to the piece, so captions never cross a join', () => {
    expect(offsetChunks([{ start: -0.2, end: 3 }, { start: 39.5, end: 41.2 }].map(c => ({ ...c, text: 'x' })), { start: 100, seconds: 40 }))
      .toEqual([{ start: 100, end: 103, text: 'x' }, { start: 139.5, end: 140, text: 'x' }])
  })
})

// ── The plans, with fake calls ───────────────────────────────────────────────

describe('Whisper transcribe in pieces (the plan)', () => {
  const whisperNode = { class_type: WHISPER_CLASS, inputs: { audio: ['s', 0], model_size: 'base', language: 'en', fps: 10 } }
  async function whisperPlan(p: SoundPieces) {
    const sent: Uint8Array[] = []
    const plan = await planNode({
      prompt: { s: { class_type: 'LoadAudio', inputs: { audio: 'speech.wav' } }, n: whisperNode } as ApiPrompt,
      nodeId: 'n', gateOpen: false, filesFrom: () => [], hosted: true, families: WHISPER_ON,
      toUrl: async f => `https://fal.storage/${f.filename}`,
      bytesToUrl: async (_f, b) => { sent.push(b); return `https://fal.storage/piece-${sent.length}.wav` },
      soundWav: async () => piecedOf(p),
    })
    expect(plan.kind).toBe('pipeline')
    return { plan: plan as Extract<NodePlan, { kind: 'pipeline' }>, sent }
  }
  const ioOf = (o: { onCall?: (key: string, n: number) => void; answer?: (key: string) => unknown } = {}) => {
    const calls: { key: string; payload: Record<string, unknown>; usd: number; endpoint: string; provider: string }[] = []
    const lost: string[] = []
    const stop = new AbortController()
    const io = {
      signal: stop.signal,
      recorded: () => null,
      call: async (c: (typeof calls)[number]) => {
        calls.push(c)
        o.onCall?.(c.key, calls.length)
        return { result: o.answer?.(c.key) ?? { chunks: [{ timestamp: [1, 2], text: ` ${c.key} a ` }, { timestamp: [3, null], text: `${c.key} b` }] }, raw: null, urls: [] }
      },
      undelivered: async (k: string, why: string) => { lost.push(`${k}:${why}`) },
    } as unknown as PipelineIO
    return { io, calls, lost, stop }
  }

  it('one Wizper call a piece that has sound (the silent one makes none), each priced on its own seconds; the segments moved by each piece\'s start; one set of texts', async () => {
    await requireMediaTools()
    const p = await smallPieces(16000, 1)
    const { plan, sent } = await whisperPlan(p)
    const t = ioOf()
    const out = await plan.run(t.io)
    // Piece 2 (39.975–69.975 s) is silent: no hand-off, no call.
    expect(t.calls.map(c => c.key)).toEqual(['wizper-1', 'wizper-3', 'wizper-4'])
    expect(sent.map(b => (b.length - 44) / 2 / 16000)).toEqual([39.975, 31, 29.025])
    for (const c of t.calls) {
      expect([c.provider, c.endpoint]).toEqual(['fal', WHISPER_SLUG])
      expect(c.payload).toMatchObject({ task: 'transcribe', language: 'en', chunk_level: 'segment', merge_chunks: false })
      const i = Number(c.key.slice(-1)) - 1
      expect(c.usd).toBe(paidCallUsd({ endpoint: WHISPER_SLUG, inputSeconds: pieceSpan(p, i).seconds }))
    }
    // The texts as from one answer whose segments are each piece's, moved by its start (a missing end: the piece's end).
    const spans = [0, 2, 3].map(i => pieceSpan(p, i))
    const chunks = [0, 1, 2].flatMap(j => offsetChunks([{ start: 1, end: 2, text: ` ${t.calls[j]!.key} a ` }, { start: 3, end: null, text: `${t.calls[j]!.key} b` }], spans[j]!))
    expect(chunks[2]).toEqual({ start: 69.975 + 1, end: 69.975 + 2, text: ' wizper-3 a ' })
    expect(chunks[1]!.end).toBeCloseTo(39.975, 9)
    const want = whisperOutputs(chunks, 10, 130)
    expect(out.values).toEqual({ 0: { kind: 'text', text: want.captions }, 1: { kind: 'text', text: want.srt }, 2: { kind: 'text', text: want.text } })
    expect(want.captions.split('\n')[2]).toBe('710 720 wizper-3 a')
    expect(want.srt).toContain('00:01:10,975 --> 00:01:11,975\nwizper-3 a')
  }, 60_000)

  it('Stop between pieces: nothing more is sent; a piece that fails fails the node; either way nothing is charged (fix round 1); an answer with no transcript is undelivered', async () => {
    await requireMediaTools()
    const p = await smallPieces(16000, 1)
    const stopped = ioOf({ onCall: () => stopped.stop.abort() })
    await expect((await whisperPlan(p)).plan.run(stopped.io)).rejects.toThrow(MEDIA_WORDS.stopped)
    expect(stopped.calls.map(c => c.key)).toEqual(['wizper-1'])
    // Fix round 1 (the controller's ruling): nothing reached the person, so the piece answered is charged 0.
    expect(stopped.lost).toEqual(['wizper-1:sailor-fault'])
    const failing = ioOf({ onCall: (k) => { if (k === 'wizper-3') throw new Error('The provider refused this prompt') } })
    await expect((await whisperPlan(p)).plan.run(failing.io)).rejects.toThrow('The provider refused this prompt')
    expect(failing.calls.map(c => c.key)).toEqual(['wizper-1', 'wizper-3'])
    expect(failing.lost).toEqual(['wizper-1:sailor-fault'])
    const empty = ioOf({ answer: k => (k === 'wizper-3' ? 'nothing' : undefined) })
    await expect((await whisperPlan(p)).plan.run(empty.io)).rejects.toThrow()
    expect(empty.lost).toEqual(['wizper-3:no-file', 'wizper-1:sailor-fault'])
  }, 60_000)
})

describe('Vocal separator in pieces (the plan)', () => {
  const STEMS = (k: string) => ({ vocals: `https://replicate.delivery/${k}-vocals.wav`, no_vocals: `https://replicate.delivery/${k}-no_vocals.wav` })
  /** A stem: its piece's length (`off` frames more or less) of stereo float32 at 44.1 kHz (as the silent piece's are), every sample the piece's number (vocals) or minus it (instrumental). */
  const stemOf = (p: SoundPieces, off = 0) => (url: string) => {
    const n = Number(/demucs-(\d+)/.exec(url)![1])
    const v = url.includes('no_vocals') ? -n / 10 : n / 10
    const frames = (p.starts[n] ?? p.frames) - p.starts[n - 1]! + off
    return floatWav({ rate: VOCALS_RATE, channels: [new Float32Array(frames).fill(v), new Float32Array(frames).fill(v)] })
  }
  async function vocalsRun(p: SoundPieces, o: { onCall?: (key: string, stop: AbortController) => void; off?: (key: string) => number } = {}) {
    const sent: string[] = []
    const plan = await planNode({
      prompt: { s: { class_type: 'LoadAudio', inputs: { audio: 'song.wav' } }, n: { class_type: VOCALS_CLASS, inputs: { audio: ['s', 0], model: 'htdemucs', shifts: 1 } } } as ApiPrompt,
      nodeId: 'n', gateOpen: false, filesFrom: () => [], hosted: true, families: VOCALS_ON,
      toUrl: async f => `https://fal.storage/${f.filename}`,
      bytesToUrl: async (f) => { sent.push(f.filename); return `https://fal.storage/${f.filename}` },
      soundWav: async () => piecedOf(p),
    })
    const calls: { key: string; usd: number; payload: Record<string, unknown> }[] = []
    const kept: string[] = []
    const lost: string[] = []
    const stop = new AbortController()
    const keptDir = scratch('long-sound-kept-')
    const io = {
      signal: stop.signal,
      media: {
        runId: 'r', hosted: true, userId: null, access: {} as never,
        kept: {
          checkRoom: async () => {},
          workDir: async () => mkdtempSync(join(keptDir, 'w-')),
          putPath: async (_r: string, path: string) => {
            const to = join(keptDir, `k${kept.length + 1}.wav`)
            writeFileSync(to, readFileSync(path))
            kept.push(to)
            return { filename: `k${kept.length}.wav`, subfolder: '', type: 'kept' as const }
          },
        } as never,
      },
      recorded: () => null,
      call: async (c: (typeof calls)[number]) => { calls.push(c); o.onCall?.(c.key, stop); return { result: { output: STEMS(c.key) }, raw: null, urls: [] } },
      download: async (url: string) => ({ bytes: stemOf(p, o.off?.(/demucs-\d+/.exec(url)![0]) ?? 0)(url), contentType: 'audio/wav' }),
      undelivered: async (k: string, why: string) => { lost.push(`${k}:${why}`) },
    } as unknown as PipelineIO
    const run = (plan as Extract<NodePlan, { kind: 'pipeline' }>).run(io)
    return { run, calls, kept, lost, sent }
  }

  it('one Demucs call a piece that has sound, each priced on its seconds; each stem joined end to end in order (the silent piece\'s stems silent, its own length)', async () => {
    await requireMediaTools()
    const p = await smallPieces(VOCALS_RATE, 2)
    const t = await vocalsRun(p)
    const out = await t.run
    expect(t.calls.map(c => c.key)).toEqual(['demucs-1', 'demucs-3', 'demucs-4'])
    expect(t.sent).toEqual(['vocal_separator.flac', 'vocal_separator.flac', 'vocal_separator.flac'])
    for (const c of t.calls) {
      const i = Number(c.key.slice(-1)) - 1
      expect(c.usd).toBe(paidCallUsd({ endpoint: VOCALS_SLUG, inputSeconds: pieceSpan(p, i).seconds }))
      expect(c.payload).toMatchObject({ model: 'htdemucs', shifts: 1, stem: 'vocals', output_format: 'wav', wav_format: 'float32' })
    }
    expect(out.values).toEqual({
      0: { kind: 'files', files: [{ filename: 'k1.wav', subfolder: '', type: 'kept' }], sound: { decode: 'load' } },
      1: { kind: 'files', files: [{ filename: 'k2.wav', subfolder: '', type: 'kept' }], sound: { decode: 'load' } },
    })
    // Each piece's stem its own length (the silent piece's silence too): the whole song's length, in order.
    for (const f of t.kept) expect(await floatWavFrames(f)).toBe(p.frames)
    const vocals = new DataView(new Uint8Array(readFileSync(t.kept[0]!)).buffer)
    const at = (frame: number) => vocals.getFloat32(58 + frame * 8, true)
    expect([at(0), at(p.starts[1]! + 5), at(p.starts[2]! + 5), at(p.starts[3]! + 5), at(p.frames - 1)]).toEqual([Math.fround(0.1), 0, Math.fround(0.3), Math.fround(0.4), Math.fround(0.4)])
    const inst = new DataView(new Uint8Array(readFileSync(t.kept[1]!)).buffer)
    expect(inst.getFloat32(58, true)).toBe(Math.fround(-0.1))
    expect(t.lost).toEqual([])
  }, 120_000)

  it('Stop between pieces sends nothing more and keeps nothing; a piece that fails keeps nothing; either way nothing is charged (fix round 1)', async () => {
    await requireMediaTools()
    const p = await smallPieces(VOCALS_RATE, 2)
    const stopped = await vocalsRun(p, { onCall: (_k, stop) => stop.abort() })
    await expect(stopped.run).rejects.toThrow(MEDIA_WORDS.stopped)
    expect(stopped.calls.map(c => c.key)).toEqual(['demucs-1'])
    expect([stopped.kept, stopped.lost]).toEqual([[], ['demucs-1:sailor-fault']])
    const failing = await vocalsRun(p, { onCall: (k) => { if (k === 'demucs-3') throw new Error('Replicate: The input or output was flagged as sensitive') } })
    await expect(failing.run).rejects.toThrow('flagged')
    expect(failing.calls.map(c => c.key)).toEqual(['demucs-1', 'demucs-3'])
    // Fix round 1 (the controller's ruling): piece 1 is charged 0 too.
    expect([failing.kept, failing.lost]).toEqual([[], ['demucs-1:sailor-fault']])
  }, 120_000)

  it('Minors 2 and 3: a stem within a block of its piece\'s length is trimmed or padded; one further off is no answer, and every piece answered goes uncharged', async () => {
    await requireMediaTools()
    const p = await smallPieces(VOCALS_RATE, 2)
    const near = await vocalsRun(p, { off: k => (k === 'demucs-1' ? 300 : k === 'demucs-3' ? -300 : 0) })
    await near.run
    for (const f of near.kept) expect(await floatWavFrames(f)).toBe(p.frames)
    const far = await vocalsRun(p, { off: k => (k === 'demucs-3' ? VOCALS_RATE : 0) })
    await expect(far.run).rejects.toThrow(VOCALS_WORDS.noAnswer)
    // (The engine keeps a call's first mark: demucs-3's second is a no-op there.)
    expect([far.kept, far.lost]).toEqual([[], ['demucs-3:no-file', 'demucs-1:sailor-fault', 'demucs-3:sailor-fault']])
  }, 120_000)
})

// ── Through the engine (ComfyUI off) ─────────────────────────────────────────

describe('through the engine (ComfyUI off): held as pieces × price, charged what was delivered', () => {
  const readers = (): ApiPrompt => ({
    t0: { class_type: 'Text', inputs: { source: ['n', 0], text: '' } },
    t2: { class_type: 'Text', inputs: { source: ['n', 2], text: '' } },
  })
  const whisperPrompt = (): ApiPrompt => ({
    s: { class_type: 'LoadAudio', inputs: { audio: 'long.wav' } },
    n: { class_type: WHISPER_CLASS, inputs: { audio: ['s', 0], model_size: 'base', language: 'auto', fps: 30 } },
    ...readers(),
  })
  const SECONDS = 30 * 60 + 2
  const whisperCredits = (seen: Record<string, unknown>) => {
    const p = localModelPrice(whisperCalls({ place: 'hosted', ...seen }))
    if ('refused' in p) throw new Error(p.refused)
    return p.credits
  }

  it('Whisper, hosted, a 30-minute-and-2-second sound: two Wizper calls, the texts joined, held for its pieces and charged the two delivered', async () => {
    await requireMediaTools()
    const fal = createFakeFal({ answer: () => ({ text: 'hi', chunks: [{ timestamp: [0.5, 1], text: 'hi' }] }) })
    const k = makeKit({ hosted: true, fal, deps: { families: () => WHISPER_ON } })
    made.push(k.root, k.dir)
    // 4 kHz keeps the file small (converted to Whisper's 16 kHz).
    putInput(k.root, 'long.wav', noiseWav(4000, SECONDS, [[1785, 1786]]))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [whisperPrompt()], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['s', 'n', 't0', 't2']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(fal.submitted().map(r => r.endpoint)).toEqual([WHISPER_SLUG, WHISPER_SLUG])
    // Cut in the quiet second near the limit (its last silent block, the resampler's edge aside): the second
    // piece starts there. The first piece's WAV handed off says where.
    const wavs = k.upload.mock.calls.map(x => x[0] as Uint8Array).filter(b => b.length > 44 && new DataView(b.buffer, b.byteOffset).getUint32(24, true) === 16000)
    expect(wavs).toHaveLength(2)
    const cut = (wavs[0]!.length - 44) / 2 / 16000
    expect(cut).toBeGreaterThan(1785)
    expect(cut).toBeLessThan(1786)
    expect((wavs[1]!.length - 44) / 2 / 16000).toBeCloseTo(SECONDS - cut, 6)
    expect(take.nodes.t2!.values?.[0]).toEqual({ kind: 'text', text: 'hi hi' })
    expect(take.nodes.t0!.values?.[0]).toEqual({ kind: 'text', text: whisperOutputs([{ start: 0.5, end: 1, text: 'hi' }, { start: cut + 0.5, end: cut + 1, text: 'hi' }], 30, SECONDS).captions })
    // Held: the header's bound (2 s over and the slack) as two pieces; charged: the two pieces sent.
    const upTo = take.measured?.n?.seconds.audioUpTo as number
    expect(upTo).toBeCloseTo(SECONDS + 1 + 1e-3, 6)
    const usd = [cut, SECONDS - cut].map(s => paidCallUsd({ endpoint: WHISPER_SLUG, inputSeconds: s })!)
    expect(take.nodes.n!.credits).toBe(perFrameCredits(usd.map(u => ({ usd: u }))))
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[whisperCredits({ audioUpTo: upTo }), take.nodes.n!.credits]])
    expect(whisperCredits({ audioUpTo: upTo })).toBeGreaterThan(whisperCredits({}))
  }, 180_000)

  it('Whisper: Stop between pieces cancels the call in flight, sends nothing more, charges nothing and releases the hold', async () => {
    await requireMediaTools()
    let answered = 0
    const fal = createFakeFal({
      answer: () => {
        // The first piece's answer: the second piece's call is then held "in progress".
        if (answered++ === 0) fal.holdNext(1)
        return { text: 'hi', chunks: [{ timestamp: [0, 1], text: 'hi' }] }
      },
    })
    const k = makeKit({ hosted: true, fal, deps: { families: () => WHISPER_ON } })
    made.push(k.root, k.dir)
    putInput(k.root, 'long.wav', noiseWav(4000, SECONDS))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [whisperPrompt()], ...START })
    for (let i = 0; i < 6000 && fal.submitted().length < 2; i++) await new Promise(r => setTimeout(r, 5))
    expect(fal.submitted().length).toBe(2)
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)
    expect(fal.submitted()[1]!.cancelled).toBe(true)
    expect(fal.submitted().length).toBe(2)
    const take = (await k.store.get(runId))!.takes[0]!
    const first = take.nodes.n!.calls!.find(c => c.key === 'wizper-1')!
    const [h] = [...k.ledger.holds.values()]
    // Fix round 1 (the controller's ruling): the answered piece delivered nothing the person keeps, so it is
    // charged 0 (Sailor absorbs it), and the whole hold goes back.
    expect([first.status, first.lost]).toEqual(['done', true])
    expect(h!.state === 'released' ? 0 : h!.actual).toBe(0)
  }, 180_000)

  const vocalsPrompt = (): ApiPrompt => ({
    s: { class_type: 'LoadAudio', inputs: { audio: 'song.wav' } },
    n: { class_type: VOCALS_CLASS, inputs: { audio: ['s', 0], model: 'htdemucs', shifts: 1 } },
    v: { class_type: 'SaveAudioMP3', inputs: { audio: ['n', 0], filename_prefix: 'karaoke_vocals', quality: 'V0' } },
    i: { class_type: 'SaveAudioMP3', inputs: { audio: ['n', 1], filename_prefix: 'karaoke_instrumental', quality: 'V0' } },
  })
  const SONG = 10 * 60 + 20
  /**
   * Replicate's answers, numbered in order, and their stems: each the length of the FLAC piece it answers (read
   * from the FLAC's STREAMINFO, as the uploads came), mono float32 at 44.1 kHz.
   */
  const stemsFor = (k: { upload: { mock: { calls: unknown[][] } } }) => {
    let n = 0
    const answer = () => { n++; return { vocals: `https://replicate.delivery/${n}-vocals.wav`, no_vocals: `https://replicate.delivery/${n}-no_vocals.wav` } }
    const download = async (url: string) => {
      const i = Number(/\/(\d+)-/.exec(url)![1])
      const flacs = k.upload.mock.calls.map(c => c[0] as Uint8Array).filter(b => String.fromCharCode(...b.subarray(0, 4)) === 'fLaC')
      const b = flacs[i - 1]!
      const frames = (b[21]! & 0x0F) * 2 ** 32 + ((b[22]! << 24) >>> 0) + (b[23]! << 16) + (b[24]! << 8) + b[25]!
      return { bytes: floatWav({ rate: VOCALS_RATE, channels: [new Float32Array(frames).fill(url.includes('no_vocals') ? 0.25 : 0.5)] }), contentType: 'audio/wav' }
    }
    return { answer, download }
  }
  const vocalsCredits = (seen: Record<string, unknown>) => {
    const p = localModelPrice(vocalsCalls({ model: 'htdemucs', shifts: 1 }, { place: 'hosted', ...seen }))
    if ('refused' in p) throw new Error(p.refused)
    return p.credits
  }

  it('Karaoke\'s chain, hosted, a 10-minute-20 song: two Demucs calls, both saves made from the joined stems, held for its pieces and charged the two delivered', async () => {
    await requireMediaTools()
    const stems: { answer?: () => unknown; download?: (url: string) => Promise<{ bytes: Uint8Array; contentType: string }> } = {}
    const replicate = createFakeReplicate({ answer: () => stems.answer!() })
    const k = makeKit({ hosted: true, replicate, deps: { families: () => VOCALS_ON, download: url => stems.download!(url) } })
    Object.assign(stems, stemsFor(k))
    made.push(k.root, k.dir)
    putInput(k.root, 'song.wav', noiseWav(4000, SONG, [[590, 591]]))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [vocalsPrompt()], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['s', 'n', 'v', 'i']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(replicate.submitted().map(r => r.endpoint)).toEqual([VOCALS_SLUG, VOCALS_SLUG])
    // Each call priced on its piece: the first cut in the quiet second near the limit (590–591 s), the
    // second (about 29 s) at the card's floor.
    const calls = take.nodes.n!.calls!
    expect(calls.map(c => [c.key, c.status])).toEqual([['demucs-1', 'done'], ['demucs-2', 'done']])
    const first = calls[0]!.usd / 0.0002
    expect(first).toBeGreaterThan(590)
    expect(first).toBeLessThan(591)
    expect(calls[1]!.usd).toBe(0.034)
    // The node's turn held it at its measured 620 s in two pieces (600 s and at most 50 s: the floor), at most
    // the start's hold; it is charged the two pieces it sent.
    const upTo = take.measured?.n?.seconds.audioUpTo as number
    expect(upTo).toBeCloseTo(SONG + 1 + 1e-3, 6)
    expect(take.nodes.n!.credits).toBe(vocalsCredits({ audio: SONG }))
    expect(perFrameCredits(calls)).toBeLessThanOrEqual(take.nodes.n!.credits)
    const [h] = [...k.ledger.holds.values()]
    const rest = h!.credits - vocalsCredits({ audioUpTo: upTo })
    expect(rest).toBeGreaterThanOrEqual(0)
    expect(h!.actual).toBe(perFrameCredits(calls) + rest)
    expect(vocalsCredits({ audioUpTo: upTo })).toBeGreaterThan(vocalsCredits({}))
    expect((await k.engine.quoteRun({ userId: k.userId, takes: [vocalsPrompt()], ...START })).credits).toBe(h!.credits)
    // Its two joined stems and the converted song were counted against the kept room before the hold.
    expect(take.keptUpTo?.n).toBeGreaterThan(Math.ceil(SONG) * VOCALS_RATE * 2 * 2)
    // The joined stems are the whole song's length.
    const stem = take.nodes.n!.values![0] as { kind: 'files'; files: { filename: string; subfolder: string }[] }
    expect(stem.files).toHaveLength(1)
  }, 180_000)

  it('Karaoke\'s chain: a failure in piece 2 charges nothing (fix round 1, the controller\'s ruling: piece 1 delivered nothing the person keeps); the node fails and nothing after it runs', async () => {
    await requireMediaTools()
    let answered = 0
    const stems: { answer?: () => unknown; download?: (url: string) => Promise<{ bytes: Uint8Array; contentType: string }> } = {}
    const replicate = createFakeReplicate({
      answer: () => {
        if (answered++ === 0) replicate.failNext(1)
        return stems.answer!()
      },
    })
    const k = makeKit({ hosted: true, replicate, deps: { families: () => VOCALS_ON, download: url => stems.download!(url) } })
    Object.assign(stems, stemsFor(k))
    made.push(k.root, k.dir)
    putInput(k.root, 'song.wav', noiseWav(4000, SONG))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [vocalsPrompt()], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    expect(take.nodes.n!.status).toBe('error')
    expect(replicate.submitted().length).toBe(2)
    for (const id of ['v', 'i']) expect(take.nodes[id]!.status).not.toBe('done')
    const first = take.nodes.n!.calls!.find(c => c.key === 'demucs-1')!
    expect([first.status, first.lost]).toEqual(['done', true])
    const [h] = [...k.ledger.holds.values()]
    expect(h!.state === 'released' ? 0 : h!.actual).toBe(0)
  }, 180_000)
})
