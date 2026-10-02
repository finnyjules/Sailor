/**
 * R11.7 (ruling (j)): clips past the caps.
 *
 * Slow motion (AI) sends a clip over 240 frames to RIFE in segments that share
 * their boundary frame (#shared/runner/clipSegments), one call each; the hold
 * is the segments' calls, counted by the same rule the run cuts by, so the run
 * never makes more calls than were held. The joined clip is (T − 1)·m + 1
 * frames, the shared frame neither doubled nor dropped. A failure partway, or
 * Stop, charges none of the segments (Sailor absorbs them), and leaves no tool
 * process or partial batch. A still picture is handed on as Python does.
 *
 * The per-frame classes keep their caps (300 hosted, 900 locally) until a Fly
 * measurement; a clip over the cap is refused plainly before the hold, the cap
 * in words, when its count is sure (the packets counted).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/** Every tool process started, by pid (a spy on spawn): Stop must leave none running. */
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

/** A hook in the writer: on its Nth frame, fail the write. */
const HOOK = vi.hoisted(() => ({ puts: 0, at: 0 }))
vi.mock('~~/server/media/values', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/values')>()
  return {
    ...real,
    framesSink: ((...a: Parameters<typeof real.framesSink>) => {
      const sink = real.framesSink(...a)
      return {
        ...sink,
        async put(rgb: Uint8Array) {
          if (HOOK.at && ++HOOK.puts === HOOK.at) throw new Error('the writer failed (test)')
          return sink.put(rgb)
        },
      }
    }) as typeof real.framesSink,
  }
})

import { createFakeFal, makeKit } from './__runner__/kit'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { requireMediaTools } from './__runner__/mediaParity'
import { batchBytes, keptBatch, vfxHarness, vfxIo, vfxRunId, type VfxHarness } from './__runner__/mediaEffectsParity'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { runnerTakesNode, outputKindsFor } from '#shared/runner/eligibility'
import { outputKind } from '#shared/runner/values'
import { MEDIA_CAPS } from '#shared/runner/media'
import { RIFE_SEGMENT_FRAMES, clipSegmentCount, clipSegments, segmentOutputFrames, segmentOutputStart } from '#shared/runner/clipSegments'
import {
  BG_REMOVE_CLASS, FRAME_INTERP_AI_CLASS, LOCAL_MODEL_MAX_FRAMES, LOCAL_MODEL_WORDS, OBJECT_REMOVE_CLASS, RIFE_LOCAL_MAX, RIFE_VIDEO_SLUG, SLOW_MOTION_AI_MAX_FRAMES,
  SLOW_MOTION_AI_PAST_4K_WORDS, SLOW_MOTION_AI_WORDS, SLOW_MOTION_OWN_MAX_FRAMES, SUBJECT_MASK_CLASS, UPSCALE_2X_CLASS, overCapWords, rifePricedPixels, slowMotionAiCalls,
  slowMotionAiCount, slowMotionAiOutWords,
} from '#shared/runner/localModels'
import { paidCallUsd } from '#shared/pricing/paidRates'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { stageEstimate } from '~~/server/runner/metering'
import { planNode, type PipelineCall, type PipelineIO } from '~~/server/runner/executors'
import { localModelStartProblems, slowMotionAiStart } from '~~/server/runner/localModelStart'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import { encodeVideo, writeFfv1 } from '~~/server/media/encode'
import { decodeFrames } from '~~/server/media/decode'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-video', 'slow-motion-ai'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const LONG = { timeout: 180_000 }
const SCHEMA = loadProviderSchema('fal', RIFE_VIDEO_SLUG)
const W = 16
const H = 16

type Frames = Extract<RunnerValue, { kind: 'frames' }>

const scratch = mkdtempSync(join(tmpdir(), 'clip-caps-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let runs = 0

/** T distinct input frames of W × H. */
const inputFrames = (t: number) => Array.from({ length: t }, (_, k) => new Uint8Array(W * H * 3).map((_, i) => (i * 7 + k * 13) & 255))

/** Segment k's answer frame i: [k + 1, i & 255, i >> 8] in every pixel (its originals junk, so putting them back shows). */
const answerFrame = (k: number, i: number, m: number) => {
  const f = new Uint8Array(W * H * 3)
  for (let p = 0; p < W * H; p++) {
    f[p * 3] = i % m === 0 ? 250 : k + 1
    f[p * 3 + 1] = i & 255
    f[p * 3 + 2] = i >> 8
  }
  return f
}

/** Frames of W × H as a lossless FFV1 clip (the fake RIFE's answer). */
async function ffv1Clip(frames: readonly Uint8Array[]): Promise<Uint8Array> {
  const dir = mkdtempSync(join(scratch, 'answer-'))
  const out = join(dir, 'answer.mkv')
  async function* each() { for (const f of frames) yield f }
  await writeFfv1({ frames: each(), w: W, h: H, out, outRoots: [dir], userId: null })
  const bytes = new Uint8Array(readFileSync(out))
  rmSync(dir, { recursive: true, force: true })
  return bytes
}

/** Segment k's whole answer, Python's count for its frames. */
const segmentAnswer = (k: number, count: number, m: number) => ffv1Clip(Array.from({ length: segmentOutputFrames(count, m) }, (_, i) => answerFrame(k, i, m)))

const answerUrl = (k: number) => `https://fal.media/files/rife-answer-${k + 1}.mp4`
const segmentOfUrl = (url: string) => Number(/rife-answer-(\d+)/.exec(url)![1]) - 1

interface ByHand { calls: PipelineCall[]; handed: Uint8Array[]; undelivered: [string, string][]; run: Promise<{ values: Record<number, RunnerValue>; ui: unknown }> }

/** The node's plan, run by hand with the real stores and tools, a fake RIFE answering each segment. */
async function byHand(h: VfxHarness, runId: string, input: RunnerValue, m: number, o: {
  noUrlAt?: number; signal?: AbortSignal; onCall?: (n: number) => void; measured?: Record<string, number>
} = {}): Promise<ByHand> {
  const prompt: ApiPrompt = {
    l: { class_type: 'LoadVideo', inputs: { file: 'a.mp4' } }, g: { class_type: 'GetVideoComponents', inputs: { video: ['l', 0] } },
    n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0], multiplier: m } },
  }
  const f = input.kind === 'frames' ? input : null
  const plan = await planNode({
    prompt, nodeId: 'n', families: ON, gateOpen: false,
    filesFrom: () => [], valueFrom: l => (l[0] === 'g' ? input : undefined), toUrl: async () => '',
    measured: o.measured ?? (f ? { frames: f.count, videoWidth: f.w, videoHeight: f.h, place: 'hosted' } : { frames: 1 }),
  })
  if (plan.kind !== 'pipeline') throw new Error(`planned ${plan.kind}`)
  const calls: PipelineCall[] = []
  const handed: Uint8Array[] = []
  const undelivered: [string, string][] = []
  const segs = f ? clipSegments(f.count) : []
  const io: PipelineIO = {
    ...vfxIo(h, 'n', runId, o.signal ?? new AbortController().signal),
    call: async (c) => {
      calls.push(c)
      o.onCall?.(calls.length)
      const k = calls.length - 1
      return { result: { video: { url: answerUrl(k) } }, raw: null, urls: o.noUrlAt === calls.length ? [] : [answerUrl(k)] }
    },
    download: async (url) => {
      const k = segmentOfUrl(url)
      return { bytes: await segmentAnswer(k, segs[k]!.count, m), contentType: 'video/mp4' }
    },
    savedOnce: async (_c, _k, make) => make(),
    recorded: () => null,
    handOff: async (bytes, name) => { handed.push(bytes); return `https://fal.storage/${name}` },
    toUrl: async () => '',
    undelivered: async (key, why) => { undelivered.push([key, why]) },
  }
  return { calls, handed, undelivered, run: plan.run(io) }
}

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

async function framesOfFile(bytes: Uint8Array): Promise<number> {
  const dir = mkdtempSync(join(scratch, 'sent-'))
  const path = join(dir, 'clip.mp4')
  writeFileSync(path, bytes)
  let n = 0
  await decodeFrames(path, { userId: null, maxFrames: 10_000, roots: [dir], onFrame: async () => { n++ } })
  rmSync(dir, { recursive: true, force: true })
  return n
}

// ── The segments: one rule for the hold and the run ──────────────────────────

describe('the segments (#shared/runner/clipSegments)', () => {
  it('240 frames at most a call, sharing their boundary frame: 300 frames make two (0–239, 239–299)', () => {
    expect(RIFE_SEGMENT_FRAMES).toBe(240)
    expect(clipSegments(300)).toEqual([{ start: 0, count: 240 }, { start: 239, count: 61 }])
    expect(clipSegments(240)).toEqual([{ start: 0, count: 240 }])
    expect(clipSegments(241)).toEqual([{ start: 0, count: 240 }, { start: 239, count: 2 }])
    expect(clipSegments(900).map(s => s.count)).toEqual([240, 240, 240, 183])
    expect([clipSegments(1), clipSegments(0)]).toEqual([[], []])
  })

  it('for every clip: the count is the segments’ count, never falls as the clip shortens, every frame covered once but the shared ones, and the joined output is (T − 1)·m + 1', () => {
    let before = 0
    for (let t = 2; t <= 1000; t++) {
      const segs = clipSegments(t)
      expect(segs.length, `T ${t}`).toBe(clipSegmentCount(t))
      expect(segs.length, `T ${t}`).toBeGreaterThanOrEqual(before)
      before = segs.length
      expect(segs[0]!.start).toBe(0)
      for (let k = 0; k < segs.length; k++) {
        const s = segs[k]!
        expect(s.count >= 2 && s.count <= 240, `T ${t} segment ${k}`).toBe(true)
        if (k > 0) expect(s.start, `T ${t} segment ${k} shares its first frame`).toBe(segs[k - 1]!.start + segs[k - 1]!.count - 1)
      }
      expect(segs.at(-1)!.start + segs.at(-1)!.count).toBe(t)
      for (const m of [2, 3, 5]) {
        // Joined: the first segment whole, every later one without its first (shared) frame.
        const joined = segs.reduce((n, s, k) => n + segmentOutputFrames(s.count, m) - (k ? 1 : 0), 0)
        expect(joined, `T ${t} ×${m}`).toBe(slowMotionAiCount(t, m))
        // Each later segment's output starts where the one before it ended.
        for (let k = 1; k < segs.length; k++) expect(segmentOutputStart(segs[k]!, m)).toBe(segmentOutputStart(segs[k - 1]!, m) + segmentOutputFrames(segs[k - 1]!.count, m) - 1)
      }
    }
  })
})

// ── Prices: the hold is the segments ─────────────────────────────────────────

describe('the hold: every segment’s call, at its own frames (R9–R11 rule 1)', () => {
  it('300 frames at ×2: two calls (479 and 121 frames out), each at the clip’s size; held = charged', () => {
    const one = (frames: number) => paidCallUsd({ endpoint: RIFE_VIDEO_SLUG, outputFrames: frames, outputPixels: rifePricedPixels(640, 360) })!
    expect(slowMotionAiCalls(2, 300, { videoWidth: 640, videoHeight: 360 })).toEqual({
      steps: [{ call: { endpoint: RIFE_VIDEO_SLUG, outputFrames: 479, outputPixels: 640 * 360 }, times: 1 }, { call: { endpoint: RIFE_VIDEO_SLUG, outputFrames: 121, outputPixels: 640 * 360 }, times: 1 }],
    })
    const usd = one(479) + one(121)
    const priced = priceNode(FRAME_INTERP_AI_CLASS, { multiplier: 2 }, { families: ON, inputSeconds: { frames: 300, videoWidth: 640, videoHeight: 360 } }) as { usd: number; credits: number }
    expect(priced.usd).toBeCloseTo(usd, 8)
    // The stage holds it, with the render credit.
    const prompt: ApiPrompt = { n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0], multiplier: 2 } } }
    expect(stageEstimate(prompt, ['n'], true, ON, { n: { seconds: { frames: 300, videoWidth: 640, videoHeight: 360 } } })).toBe(priced.credits + 1)
    // Equal segments fold into one step, `times` over.
    expect(slowMotionAiCalls(2, 479, { videoWidth: 64, videoHeight: 64 })).toEqual({ steps: [{ call: { endpoint: RIFE_VIDEO_SLUG, outputFrames: 479, outputPixels: 64 * 64 }, times: 2 }] })
    // 240 frames or fewer: one call, as before.
    expect(slowMotionAiCalls(3, 240, { videoWidth: 64, videoHeight: 64 })).toEqual({ steps: [{ call: { endpoint: RIFE_VIDEO_SLUG, outputFrames: 718, outputPixels: 64 * 64 }, times: 1 }] })
    expect(creditsForUsd(priced.usd)).toBe(priced.credits)
  })

  it('the canvas’s "up to" covers the hold of every clip each place lets through, segments included', () => {
    for (const place of ['hosted', 'local'] as const) {
      const hosted = place === 'hosted'
      for (const m of [2, 3, 5]) {
        const upTo = priceNode(FRAME_INTERP_AI_CLASS, { multiplier: m }, { families: ON, inputSeconds: { frames: SLOW_MOTION_AI_MAX_FRAMES[place], framesUpTo: place } }) as { usd: number }
        const sizes: [number, number][] = hosted ? [[640, 360], [1920, 1080], [2560, 1440], [4096, 4096], [16, 16]] : [[3840, 2160], [2160, 3840], [1920, 1080], [640, 360], [16, 16]]
        let checked = 0
        for (const t of [2, 120, 239, 240, 241, 300, 479, 480, 600, 899, 900]) {
          for (const [w, h] of sizes) {
            const got = slowMotionAiStart({ multiplier: m }, { count: t, w, h, exact: true }, hosted)
            if (!('frames' in got)) continue
            const held = priceNode(FRAME_INTERP_AI_CLASS, { multiplier: m }, { families: ON, inputSeconds: { frames: t, videoWidth: w, videoHeight: h, place } }) as { usd: number }
            expect(upTo.usd, `${place} ×${m}, ${t} frames of ${w} × ${h}`).toBeGreaterThanOrEqual(held.usd)
            checked++
          }
        }
        expect(checked, `${place} ×${m}`).toBeGreaterThan(5)
      }
    }
  })
})

// ── The run: segments through the plan ───────────────────────────────────────

describe('a 300-frame clip through the plan: two segments, joined without doubling or dropping the shared frame', () => {
  it('two RIFE calls (240 and 61 frames sent), (T − 1)·2 + 1 frames out, the originals exact, each in-between from its own segment', LONG, async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const ins = inputFrames(300)
    const input = await keptBatch(h, runId, { frames: ins, w: W, h: H })
    const before = PROCS.pids.length
    const r = await byHand(h, runId, input, 2)
    const out = (await r.run).values[0] as Frames
    expect(r.calls.length).toBe(2)
    expect(r.calls.map(c => c.key)).toEqual(['rife-1', 'rife-2'])
    for (const c of r.calls) {
      expect([c.provider, c.endpoint, c.media]).toEqual(['fal', RIFE_VIDEO_SLUG, 'video'])
      expect(checkPayload(SCHEMA, c.payload)).toEqual([])
    }
    expect(r.calls.map(c => c.usd)).toEqual([479, 121].map(f => paidCallUsd({ endpoint: RIFE_VIDEO_SLUG, outputFrames: f, outputPixels: W * H })))
    // Each segment's clip: its own frames only.
    expect(r.handed.length).toBe(2)
    expect([await framesOfFile(r.handed[0]!), await framesOfFile(r.handed[1]!)]).toEqual([240, 61])
    expect([out.count, out.w, out.h]).toEqual([599, W, H])
    const got = await batchBytes(h, runId, out)
    const frame = (j: number) => got.subarray(j * W * H * 3, (j + 1) * W * H * 3)
    const segs = clipSegments(300)
    for (let j = 0; j < 599; j++) {
      if (j % 2 === 0) {
        expect(Buffer.from(frame(j)).equals(Buffer.from(ins[j / 2]!)), `original ${j / 2}`).toBe(true)
        continue
      }
      // The segment holding output frame j, and its local index there.
      const k = j < segmentOutputStart(segs[1]!, 2) ? 0 : 1
      const i = j - segmentOutputStart(segs[k]!, 2)
      expect(Buffer.from(frame(j)).equals(Buffer.from(answerFrame(k, i, 2))), `in-between ${j} (segment ${k + 1}, frame ${i})`).toBe(true)
    }
    // The shared frame (input 239, output 478) appears once, from the originals; nothing marked undelivered.
    expect(Buffer.from(frame(478)).equals(Buffer.from(ins[239]!))).toBe(true)
    expect(r.undelivered).toEqual([])
    await allGone(pids(before))
    // Only the input and the joined batch are kept.
    expect(readdirSync(join(h.root, 'kept', runId)).sort()).toEqual([input.file.filename, out.file.filename].sort())
  })

  it('a second segment with no answer: no more calls, none charged (the first marked Sailor’s, the second not delivered), nothing kept', LONG, async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const input = await keptBatch(h, runId, { frames: inputFrames(300), w: W, h: H })
    const r = await byHand(h, runId, input, 2, { noUrlAt: 2 })
    await expect(r.run).rejects.toThrow(SLOW_MOTION_AI_WORDS.noAnswer)
    expect(r.calls.length).toBe(2)
    expect(r.undelivered.sort()).toEqual([['rife-1', 'sailor-fault'], ['rife-2', 'no-file']])
    expect(readdirSync(join(h.root, 'kept', runId))).toEqual([input.file.filename])
  })

  it('the first segment with no answer: the second is never sent', LONG, async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const input = await keptBatch(h, runId, { frames: inputFrames(300), w: W, h: H })
    const r = await byHand(h, runId, input, 2, { noUrlAt: 1 })
    await expect(r.run).rejects.toThrow(SLOW_MOTION_AI_WORDS.noAnswer)
    expect(r.calls.length).toBe(1)
    expect(r.undelivered).toEqual([['rife-1', 'no-file']])
  })

  it('Stop during the second call: no more work, both segments charged nothing, no tool process left within a second, nothing kept', LONG, async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const input = await keptBatch(h, runId, { frames: inputFrames(300), w: W, h: H })
    const before = PROCS.pids.length
    const ctl = new AbortController()
    const r = await byHand(h, runId, input, 2, { signal: ctl.signal, onCall: n => { if (n === 2) ctl.abort() } })
    await expect(r.run).rejects.toThrow()
    expect(r.calls.length).toBe(2)
    expect(r.undelivered.map(x => x[0]).sort()).toEqual(['rife-1', 'rife-2'])
    await allGone(pids(before))
    expect(readdirSync(join(h.root, 'kept', runId))).toEqual([input.file.filename])
  })

  it('the join failing partway (the writer): every segment charged nothing, no ffmpeg left, nothing kept', LONG, async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const input = await keptBatch(h, runId, { frames: inputFrames(300), w: W, h: H })
    const before = PROCS.pids.length
    // Past the first segment's 479 frames: inside the second's.
    Object.assign(HOOK, { puts: 0, at: 500 })
    try {
      const r = await byHand(h, runId, input, 2)
      await expect(r.run).rejects.toThrow('the writer failed (test)')
      expect(r.undelivered.sort()).toEqual([['rife-1', 'sailor-fault'], ['rife-2', 'sailor-fault']])
    }
    finally { Object.assign(HOOK, { at: 0 }) }
    await allGone(pids(before))
    expect(readdirSync(join(h.root, 'kept', runId))).toEqual([input.file.filename])
  })

  it('a clip longer than measured before the run: refused before any call (never more segments than held)', async () => {
    const h = vfxHarness(scratch)
    const input: Frames = { kind: 'frames', file: { filename: 'x.mkv', subfolder: 'r', type: 'kept' }, count: 300, w: W, h: H }
    await expect(byHand(h, 'r', input, 2, { measured: { frames: 240, videoWidth: W, videoHeight: H } })).rejects.toThrow(SLOW_MOTION_AI_WORDS.moreThanHeld)
  })
})

// ── A still picture ──────────────────────────────────────────────────────────

describe('a still picture into Slow motion (AI): handed on as Python does (one frame, no call)', () => {
  const still: ApiPrompt = {
    i: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
    n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['i', 0], multiplier: 2 } },
    s: { class_type: 'SaveImage', inputs: { images: ['n', 0], filename_prefix: 'x' } },
  }

  it('taken while its family is on; a picture out (as Background remove’s is); nothing held', async () => {
    expect(runnerTakesNode(still, 'n', ON)).toBe(true)
    expect(outputKind(still, ['n', 0], outputKindsFor(ON))).toBe('files')
    expect(runnerTakesNode(still, 'n', new Set(['cards', 'media-video']))).toBe(false)
    const counted = await localModelStartProblems(still, ON, { hosted: true, shapes: async () => new Map() })
    expect(counted).toMatchObject({ counts: { n: 1 }, problem: null })
    expect(priceNode(FRAME_INTERP_AI_CLASS, { multiplier: 2 }, { families: ON, inputSeconds: { frames: 1 } })).toEqual({ usd: 0, credits: 0 })
    // Several pictures (Python would slow the batch down): left to the engine, named.
    const batch: ApiPrompt = { e: { class_type: 'EmptyImage', inputs: { width: 64, height: 64, batch_size: 3, color: 0 } }, n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['e', 0], multiplier: 2 } } }
    expect((await localModelStartProblems(batch, ON, { hosted: true, shapes: async () => new Map() })).problem?.message).toBe(SLOW_MOTION_AI_WORDS.pictureBatch)
  })

  it('through the plan: the picture handed on as it came, no call', async () => {
    const h = vfxHarness(scratch)
    const pic: RunnerValue = { kind: 'files', files: [{ filename: 'a.png', subfolder: '', type: 'input' } as OutputFile] }
    const r = await byHand(h, vfxRunId(++runs), pic, 3)
    expect((await r.run).values[0]).toEqual(pic)
    expect(r.calls).toEqual([])
    const two: RunnerValue = { kind: 'files', files: [pic.files[0]!, pic.files[0]!] }
    await expect(byHand(h, 'r', two, 3)).rejects.toThrow(SLOW_MOTION_AI_WORDS.onePicture)
  })
})

// ── Before the run: past the caps, refused plainly ──────────────────────────

describe('the start of the run: a clip past a cap is refused plainly before the hold, the cap in words', () => {
  const lv = { class_type: 'LoadVideo', inputs: { file: 'a.mp4' } }
  const g = { class_type: 'GetVideoComponents', inputs: { video: ['l', 0] } }
  const counted = (count: number, w = 64, h = 36) => async () => new Map([['g:0', { count, w, h, exact: false, counted: true as const }]])
  const bound = (count: number, w = 64, h = 36) => async () => new Map([['g:0', { count, w, h, exact: false }]])
  const fams: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-video', 'slow-motion-ai', 'bg-remove', 'upscale-2x', 'object-remove', 'subject-mask'])

  it('the per-frame classes keep 300 hosted and 900 locally (raised only after a Fly measurement); over, refused with the cap', async () => {
    expect(LOCAL_MODEL_MAX_FRAMES).toEqual({ hosted: 300, local: 900 })
    for (const cls of [BG_REMOVE_CLASS, UPSCALE_2X_CLASS, SUBJECT_MASK_CLASS]) {
      const p: ApiPrompt = { l: lv, g, n: { class_type: cls, inputs: { frames: ['g', 0], output: 'transparent', edge_softness: 0, tile_size: 512, point_x: 0.5, point_y: 0.5, output_mode: 'best', mask_grow: 0 } } }
      for (const hosted of [true, false]) {
        const cap = hosted ? 300 : 900
        const over = await localModelStartProblems(p, fams, { hosted, shapes: counted(cap + 1) })
        expect(over.refused?.message, `${cls} ${hosted}`).toBe(overCapWords(cls, cap))
        expect(over.problem).toBeNull()
        expect((await localModelStartProblems(p, fams, { hosted, shapes: counted(cap) })).refused, `${cls} ${hosted} at the cap`).toBeUndefined()
        // A count that is only an upper bound (its packets not counted) proves nothing: the engine, as before.
        expect((await localModelStartProblems(p, fams, { hosted, shapes: bound(cap + 1) })).problem?.message).toBe(overCapWords(cls, cap))
      }
    }
    expect(overCapWords(BG_REMOVE_CLASS, 300)).toBe('This clip is too long to cut out here. Use a clip of 300 frames or fewer.')
    expect(overCapWords(OBJECT_REMOVE_CLASS, 900)).toBe('This clip is too long to remove objects from here. Use a clip of 900 frames or fewer.')
    expect(LOCAL_MODEL_WORDS.overCap).toBe('This clip is too long to cut out here.')
  })

  it('Slow motion (AI): over its cap, past the batch caps, a frame too large, or locally past 4K where Sailor’s own can’t take it: refused, with the cap', async () => {
    const p: ApiPrompt = { l: lv, g, n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0], multiplier: 2 } } }
    expect(SLOW_MOTION_AI_MAX_FRAMES).toEqual(LOCAL_MODEL_MAX_FRAMES)
    for (const hosted of [true, false]) {
      const cap = SLOW_MOTION_AI_MAX_FRAMES[hosted ? 'hosted' : 'local']
      expect((await localModelStartProblems(p, ON, { hosted, shapes: counted(cap + 1) })).refused?.message).toBe(overCapWords(FRAME_INTERP_AI_CLASS, cap))
      const ok = await localModelStartProblems(p, ON, { hosted, shapes: counted(cap) })
      expect(ok).toMatchObject({ counts: { n: cap }, problem: null })
      expect(ok.refused).toBeUndefined()
    }
    expect(overCapWords(FRAME_INTERP_AI_CLASS, 300)).toBe('This clip is too long to slow down here. Use a clip of 300 frames or fewer.')
    // Hosted ×3 on 300 frames: 898 out, past the 600-frame batch: refused, with the most it can keep.
    const x3: ApiPrompt = { ...p, n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0], multiplier: 3 } } }
    expect((await localModelStartProblems(x3, ON, { hosted: true, shapes: counted(300) })).refused?.message).toBe(slowMotionAiOutWords(MEDIA_CAPS.hosted.batchFrames))
    expect(slowMotionAiOutWords(600)).toBe('Slowed down, this clip would have too many frames to keep here. At this size it can have 600 frames at most: use a shorter clip or a smaller multiplier.')
    // Locally past 4K and past what Sailor's own interpolation takes: refused, 4K in words.
    expect(slowMotionAiStart({ multiplier: 2 }, { count: 24, w: 5120, h: 2880, exact: false, counted: true }, false)).toEqual({ refused: SLOW_MOTION_AI_PAST_4K_WORDS })
    expect(SLOW_MOTION_AI_PAST_4K_WORDS).toBe(`This clip’s frames are too large to slow down here. Use frames of ${RIFE_LOCAL_MAX.long} × ${RIFE_LOCAL_MAX.short} or smaller.`)
    // Sailor's own interpolation (a clip under 16 pixels a side, or ×6–8) keeps hosted's 240 until its memory is measured on Fly.
    expect(SLOW_MOTION_OWN_MAX_FRAMES.hosted).toBe(240)
    expect(slowMotionAiStart({ multiplier: 2 }, { count: 241, w: 8, h: 8, exact: true }, true)).toEqual({ refused: overCapWords(FRAME_INTERP_AI_CLASS, 240) })
    expect(slowMotionAiStart({ multiplier: 2 }, { count: 240, w: 8, h: 8, exact: true }, true)).toEqual({ frames: 240, w: 8, h: 8 })
    // RIFE (16 pixels a side and up) takes the full 300 hosted.
    expect(slowMotionAiStart({ multiplier: 2 }, { count: 300, w: 16, h: 16, exact: true }, true)).toEqual({ frames: 300, w: 16, h: 16 })
    // Unknown: the engine (R11.8 bounds it).
    expect((await localModelStartProblems(p, ON, { hosted: true, shapes: async () => new Map() })).problem?.message).toBe(LOCAL_MODEL_WORDS.unknownCount)
  })
})

// ── With ComfyUI off: the acceptance chain through the engine ────────────────

describe('Load video → Get video components → Slow motion (AI) → Save video frames, 300 frames, with ComfyUI off', () => {
  const clip = 'clip300.mp4'
  const prompt = (m = 2): ApiPrompt => ({
    l: { class_type: 'LoadVideo', inputs: { file: clip } },
    g: { class_type: 'GetVideoComponents', inputs: { video: ['l', 0] } },
    n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0], multiplier: m } },
    c: { class_type: 'CreateVideo', inputs: { images: ['n', 0], fps: 24 } },
    s: { class_type: 'SaveVideo', inputs: { video: ['c', 0], filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } },
  })
  const charged = (k: { ledger: { holds: Map<number, { credits: number; state: string; actual: number | null }> } }) =>
    [...k.ledger.holds.values()].map(x => [x.credits, x.state === 'released' ? 0 : x.actual])

  /** A W × H H.264 clip of `t` frames at 24 fps (its packets counted at the start of the run). */
  async function clipOf(t: number, dir: string): Promise<string> {
    const out = join(dir, `c${t}.mp4`)
    async function* each() { for (const f of inputFrames(t)) yield f }
    await encodeVideo({ input: { kind: 'rgb', w: W, h: H, frames: each() }, out, fps: { num: 24, den: 1 }, quality: { crf: 17, preset: 'medium' }, userId: null, outRoots: [dir] })
    return out
  }

  function kitFor(file: string) {
    const dir = mkdtempSync(join(scratch, 'kit-'))
    const fal = createFakeFal({ answer: () => ({ video: { url: answerUrl(fal.submitted().length - 1) } }) })
    const k = makeKit({
      hosted: true, dir, fal,
      deps: {
        families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')),
        download: async (url: string) => {
          const s = segmentOfUrl(url)
          return { bytes: await segmentAnswer(s, clipSegments(300)[s]!.count, 2), contentType: 'video/mp4' }
        },
      },
    })
    writeFileSync(join(k.root, 'input', clip), readFileSync(file))
    return { k, fal, dir }
  }

  it('hosted: two RIFE calls, held and charged the two segments’ price plus the render credit, 599 frames saved', LONG, async () => {
    await requireMediaTools()
    const src = await clipOf(300, mkdtempSync(join(scratch, 'src-')))
    const { k, fal } = kitFor(src)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt()], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['l', 'g', 'n', 'c', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    const g = take.nodes.g!.values![0] as Frames
    expect(g.count).toBe(300)
    const n = take.nodes.n!.values![0] as Frames
    expect([n.count, n.w, n.h]).toEqual([599, W, H])
    expect(fal.submitted().map(x => x.endpoint)).toEqual([RIFE_VIDEO_SLUG, RIFE_VIDEO_SLUG])
    for (const x of fal.submitted()) expect(checkPayload(SCHEMA, x.payload)).toEqual([])
    const priced = priceNode(FRAME_INTERP_AI_CLASS, { multiplier: 2 }, { families: ON, inputSeconds: { frames: 300, videoWidth: W, videoHeight: H } }) as { usd: number; credits: number }
    expect(priced.usd).toBeCloseTo([479, 121].reduce((s, f) => s + paidCallUsd({ endpoint: RIFE_VIDEO_SLUG, outputFrames: f, outputPixels: W * H })!, 0), 8)
    expect(take.nodes.n!.credits).toBe(priced.credits)
    expect(charged(k)).toEqual([[priced.credits + 1, priced.credits + 1]])
    const saved = take.nodes.s!.outputs[0]!
    let count = 0
    const path = join(k.root, 'output', saved.subfolder, saved.filename)
    await decodeFrames(path, { userId: null, maxFrames: 10_000, roots: [join(path, '..')], onFrame: async () => { count++ } })
    expect(count).toBe(599)
  })

  it('hosted, 301 frames: refused plainly before the hold, the cap in words; nothing sent or held', LONG, async () => {
    await requireMediaTools()
    const src = await clipOf(301, mkdtempSync(join(scratch, 'src-')))
    const { k, fal } = kitFor(src)
    await expect(k.engine.startRun({ userId: k.userId, takes: [prompt()], ...START })).rejects.toThrow(overCapWords(FRAME_INTERP_AI_CLASS, 300))
    expect(fal.submitted()).toEqual([])
    expect(k.ledger.holds.size).toBe(0)
  })
})
