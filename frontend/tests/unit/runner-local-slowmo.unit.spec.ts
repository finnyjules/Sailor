/**
 * R7.6: Slow motion (AI) on fal's RIFE video (family `slow-motion-ai`).
 *
 * One call for the whole clip: the batch encoded once as H.264, handed off,
 * RIFE asked for m − 1 frames between each pair, its answer decoded, forced
 * to Python's (T − 1)·m + 1 frames by nearest frame, and Python's originals
 * put back at i·m exactly (server/runner/generators/localModels.ts
 * planSlowMotionAi). The provider runs RIFE on a GPU, not Python's ONNX, so
 * its in-betweens can't match; given the same in-betweens, the output is
 * Python's byte for byte: fixtures/runner-paid-local-slowmo.json, the real
 * execute with RIFE's session a stand-in (scripts/runner_paid_fixtures.py
 * --group local-slowmo), whose in-betweens the fake RIFE answers back here
 * (losslessly, as FFV1). A multiplier RIFE video doesn't make (6–8) runs on
 * Sailor's own interpolation (R6.6's minterpolate), never on the engine.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

import { createFakeFal, makeKit } from './__runner__/kit'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'
import { batchBytes, keptBatch, vfxHarness, vfxIo, vfxRunId, type VfxHarness } from './__runner__/mediaEffectsParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { ALL_RUNNER_FAMILIES, LOCAL_MODEL_FAMILIES, LOCAL_MODEL_REQUIRES, LOCAL_MODEL_TOOL_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { PROVIDER_TYPES, RUNNER_NODE_RULES, SWITCHED_CLASSES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { outputKind } from '#shared/runner/values'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import { FRAMES_LINK_SOURCES } from '#shared/runner/mediaEffects'
import { MEDIA_CAPS } from '#shared/runner/media'
import {
  FRAME_INTERP_AI_CLASS, LOCAL_MODEL_FAMILY_OF, RIFE_MAX_MULTIPLIER, RIFE_VIDEO_SLUG, SERVICE_OF, SLOW_MOTION_AI_MAX_FRAMES, SLOW_MOTION_AI_WORDS,
  RIFE_LOCAL_MAX, SLOW_MOTION_AI_PAST_4K_WORDS, fitsRifeLocal, overCapWords, rifeMakes, rifePricedPixels, rifeTakes, serviceTooltip, slowMotionAiCount, slowMotionAiOutWords,
} from '#shared/runner/localModels'
import { clipSegments, segmentOutputFrames } from '#shared/runner/clipSegments'
import { PAID_RATES, paidCallUsd } from '#shared/pricing/paidRates'
import { paidNoCall } from '#shared/pricing/paidSettings'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { estimateUsdForNodes, localModelFrames, localModelSeconds, upstreamInputSeconds, vueNodesToEstimateInput } from '~/lib/costEstimate'
import { modelPricedUsd, nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { stageEstimate } from '~~/server/runner/metering'
import { planNode, type PipelineCall, type PipelineIO } from '~~/server/runner/executors'
import { RIFE_SEND_FPS, fitRifeFrame, rifeAnswerIndex, rifeVideoInput } from '~~/server/runner/generators/localModels'
import { localModelStartProblems, slowMotionAiAtCap, slowMotionAiStart, slowMotionAiTurnRefusal } from '~~/server/runner/localModelStart'
import { frameShapes, batchesOf } from '~~/server/runner/video/shapes'
import { KEPT_MEDIA_MAKERS } from '~~/server/runner/keptRelease'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import { writeFfv1 } from '~~/server/media/encode'
import { decodeFrames } from '~~/server/media/decode'
import { probeMedia } from '~~/server/media/probe'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'

interface SlowCase {
  name: string; class_type: string; multiplier: number; w: number; h: number; count: number
  frames: string; asked: string[]; out_count: number; out: string; handed_on: boolean
}
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-local-slowmo.json'), 'utf8')) as { cases: SlowCase[] }
const CASES = FIXTURE.cases
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'media-video', 'slow-motion-ai'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const LONG = { timeout: 120_000 }
const SCHEMA = loadProviderSchema('fal', RIFE_VIDEO_SLUG)
const ANSWER_URL = 'https://fal.media/files/rife-answer.mp4'

type Frames = Extract<RunnerValue, { kind: 'frames' }>
type Link = [string, number]

const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const hexFloat = (h: string) => Buffer.from(h, 'hex').readDoubleBE(0)
const caseNamed = (name: string) => {
  const c = CASES.find(x => x.name.startsWith(name))
  if (!c) throw new Error(`no case ${name}`)
  return c
}
const split = (bytes: Uint8Array, per: number) => Array.from({ length: bytes.length / per }, (_, i) => bytes.slice(i * per, (i + 1) * per))
const inputFrames = (c: SlowCase) => split(b64(c.frames), c.w * c.h * 3)
const pythonFrames = (c: SlowCase) => split(b64(c.out), c.w * c.h * 3)

const scratch = mkdtempSync(join(tmpdir(), 'local-slowmo-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let runs = 0

/** Frames of w × h as a lossless FFV1 clip (the fake RIFE's answer). */
async function ffv1Clip(frames: readonly Uint8Array[], w: number, h: number): Promise<Uint8Array> {
  const dir = mkdtempSync(join(scratch, 'answer-'))
  const out = join(dir, 'answer.mkv')
  async function* each() { for (const f of frames) yield f }
  await writeFfv1({ frames: each(), w, h, out, outRoots: [dir], userId: null })
  return new Uint8Array(readFileSync(out))
}

/** RIFE's answer as the fake service gives it: Python's frames, its originals changed (so putting them back shows), padded to even with junk. */
async function rifeAnswer(c: SlowCase): Promise<Uint8Array> {
  const W = c.w + (c.w % 2)
  const H = c.h + (c.h % 2)
  const frames = pythonFrames(c).map((f, j) => {
    const out = new Uint8Array(W * H * 3).fill(77)
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w * 3; x++) {
        const v = f[y * c.w * 3 + x]!
        out[y * W * 3 + x] = j % c.multiplier === 0 ? 255 - v : v
      }
    }
    return out
  })
  return ffv1Clip(frames, W, H)
}

interface ByHand {
  calls: PipelineCall[]; handed: Uint8Array[]; undelivered: [string, string][]
  run: Promise<{ values: Record<number, RunnerValue>; ui: unknown }>
}

/** The node's plan, run by hand with the real stores and tools, a fake RIFE answering `answer`. */
async function byHand(h: VfxHarness, runId: string, input: Frames, m: number, o: {
  answer?: () => Promise<Uint8Array>; urls?: string[]; measured?: Record<string, number>; signal?: AbortSignal; place?: 'hosted' | 'local'
} = {}): Promise<ByHand> {
  const prompt: ApiPrompt = {
    l: { class_type: 'LoadVideo', inputs: { file: 'a.mp4' } }, g: { class_type: 'GetVideoComponents', inputs: { video: ['l', 0] } },
    n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0], multiplier: m } },
  }
  const plan = await planNode({
    prompt, nodeId: 'n', families: ON, gateOpen: false,
    filesFrom: () => [], valueFrom: l => (l[0] === 'g' ? input : undefined), toUrl: async () => '',
    measured: { ...(o.measured ?? { frames: input.count, videoWidth: input.w, videoHeight: input.h }), ...(o.place ? { place: o.place } : {}) },
  })
  if (plan.kind !== 'pipeline') throw new Error(`planned ${plan.kind}`)
  const calls: PipelineCall[] = []
  const handed: Uint8Array[] = []
  const undelivered: [string, string][] = []
  const signal = o.signal ?? new AbortController().signal
  const io: PipelineIO = {
    ...vfxIo(h, 'n', runId, signal),
    call: async (c) => {
      calls.push(c)
      return { result: { video: { url: ANSWER_URL } }, raw: null, urls: o.urls ?? [ANSWER_URL] }
    },
    download: async () => ({ bytes: await (o.answer ?? (async () => new Uint8Array(0)))(), contentType: 'video/mp4' }),
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

// ── Python's facts ───────────────────────────────────────────────────────────

describe('the fixture: Python’s real execute, RIFE a stand-in', () => {
  it('covers ×2, ×5 on an odd size, ×3 on two frames, one frame handed on, ×7 (not a RIFE video multiplier) and a clip under 16 pixels a side', () => {
    expect(CASES.map(c => [c.count, c.multiplier])).toEqual([[3, 2], [4, 5], [2, 3], [1, 4], [3, 7], [3, 2]])
    expect(CASES.some(c => c.w % 2 === 1 && c.h % 2 === 1)).toBe(true)
  })

  it('(T − 1)·m + 1 frames, the originals at i·m exactly; RIFE asked at k / m between each pair (its timestep map is float32); one frame handed on as it is', () => {
    for (const c of CASES) {
      expect(c.out_count, c.name).toBe(slowMotionAiCount(c.count, c.multiplier))
      const ins = inputFrames(c)
      const outs = pythonFrames(c)
      for (let i = 0; i < c.count; i++) expect(Buffer.from(outs[i * c.multiplier]!).equals(Buffer.from(ins[i]!)), `${c.name} original ${i}`).toBe(true)
      const want = c.count < 2 ? [] : Array.from({ length: c.count - 1 }, () => Array.from({ length: c.multiplier - 1 }, (_, k) => Math.fround((k + 1) / c.multiplier))).flat()
      expect(c.asked.map(hexFloat), c.name).toEqual(want)
      expect(c.handed_on, c.name).toBe(c.count < 2)
    }
  })
})

// ── The call ─────────────────────────────────────────────────────────────────

describe('the call, against the saved schema', () => {
  it('m − 1 frames between each pair for m 2–5 (the schema’s num_frames 1–4); 6–8 are no call RIFE video takes', () => {
    for (let m = 2; m <= 8; m++) {
      const payload = rifeVideoInput('https://fal.storage/clip.mp4', m)
      expect(payload).toEqual({ video_url: 'https://fal.storage/clip.mp4', num_frames: m - 1, use_scene_detection: false, use_calculated_fps: true, loop: false })
      expect(checkPayload(SCHEMA, payload).length === 0, `m ${m}`).toBe(m <= RIFE_MAX_MULTIPLIER)
      expect(rifeMakes(m)).toBe(m <= 5)
    }
    // The clip is sent slow enough that RIFE's own output rate (×m) stays within the schema's 60.
    expect(RIFE_SEND_FPS.num * RIFE_MAX_MULTIPLIER / RIFE_SEND_FPS.den).toBeLessThanOrEqual(60)
  })

  it('nearest frame: frame for frame when the answer has Python’s count, spread over it otherwise; the answer fitted back to the clip', async () => {
    expect(Array.from({ length: 5 }, (_, j) => rifeAnswerIndex(j, 5, 5))).toEqual([0, 1, 2, 3, 4])
    expect(Array.from({ length: 5 }, (_, j) => rifeAnswerIndex(j, 9, 5))).toEqual([0, 2, 4, 6, 8])
    expect(Array.from({ length: 5 }, (_, j) => rifeAnswerIndex(j, 3, 5))).toEqual([0, 1, 1, 2, 2])
    // The even padding sent is cropped off; any other size is resized.
    const padded = new Uint8Array(4 * 2 * 3).map((_, i) => i)
    expect([...await fitRifeFrame(padded, 4, 2, 3, 1)]).toEqual([...padded.subarray(0, 9)])
    expect((await fitRifeFrame(new Uint8Array(16 * 12 * 3), 16, 12, 9, 7)).length).toBe(9 * 7 * 3)
  })
})

// ── Through the node's plan, with the real stores and tools ──────────────────

describe('every RIFE case through the plan: Python’s output given the same in-betweens, byte for byte', () => {
  for (const name of ['slowmo · 3 frames · ×2', 'slowmo · 4 frames · ×5', 'slowmo · 2 frames · ×3']) {
    it(name, LONG, async () => {
      await requireMediaTools()
      const c = caseNamed(name)
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const input = await keptBatch(h, runId, { frames: inputFrames(c), w: c.w, h: c.h })
      const before = PROCS.pids.length
      const r = await byHand(h, runId, input, c.multiplier, { answer: () => rifeAnswer(c) })
      const got = await r.run
      // One call, its payload the saved schema's, priced by the frames it makes at the size sent.
      expect(r.calls.length).toBe(1)
      const call = r.calls[0]!
      expect([call.provider, call.endpoint, call.media]).toEqual(['fal', RIFE_VIDEO_SLUG, 'video'])
      expect(checkPayload(SCHEMA, call.payload)).toEqual([])
      expect(call.payload.num_frames).toBe(c.multiplier - 1)
      expect(call.usd).toBe(paidCallUsd({ endpoint: RIFE_VIDEO_SLUG, outputFrames: c.out_count, outputPixels: rifePricedPixels(c.w, c.h) }))
      // The clip handed off: H.264, T frames, padded to even.
      expect(r.handed.length).toBe(1)
      const sent = join(mkdtempSync(join(scratch, 'sent-')), 'clip.mp4')
      writeFileSync(sent, r.handed[0]!)
      const p = await probeMedia(sent, { userId: null, roots: [join(sent, '..')] })
      expect([p.video[0]!.codec, p.video[0]!.w, p.video[0]!.h]).toEqual(['h264', c.w + (c.w % 2), c.h + (c.h % 2)])
      let sentFrames = 0
      await decodeFrames(sent, { userId: null, maxFrames: 1000, roots: [join(sent, '..')], onFrame: async () => { sentFrames++ } })
      expect(sentFrames).toBe(c.count)
      // Python's frames exactly: the in-betweens as answered, the originals put back.
      const out = got.values[0] as Frames
      expect([out.kind, out.count, out.w, out.h]).toEqual(['frames', c.out_count, c.w, c.h])
      expect(Buffer.from(await batchBytes(h, runId, out)).equals(Buffer.from(b64(c.out)))).toBe(true)
      expect(got.ui).toBeNull()
      expect(r.undelivered).toEqual([])
      await allGone(pids(before))
    })
  }

  it('an answer of another count and size: forced to (T − 1)·m + 1 by nearest frame, fitted, the originals still exact', LONG, async () => {
    await requireMediaTools()
    const c = caseNamed('slowmo · 4 frames · ×5')
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const ins = inputFrames(c)
    const input = await keptBatch(h, runId, { frames: ins, w: c.w, h: c.h })
    for (const n of [c.out_count + 3, 4]) {
      const grey = (k: number) => new Uint8Array(16 * 12 * 3).fill(10 + k)
      const r = await byHand(h, runId, input, c.multiplier, { answer: () => ffv1Clip(Array.from({ length: n }, (_, k) => grey(k)), 16, 12) })
      const out = (await r.run).values[0] as Frames
      expect([out.count, out.w, out.h], `n ${n}`).toEqual([c.out_count, c.w, c.h])
      const frames = split(await batchBytes(h, runId, out), c.w * c.h * 3)
      for (let j = 0; j < out.count; j++) {
        if (j % c.multiplier === 0) expect(Buffer.from(frames[j]!).equals(Buffer.from(ins[j / c.multiplier]!)), `n ${n}, original ${j}`).toBe(true)
        // A flat grey answer frame resized is the same grey: which one tells the nearest frame taken.
        else expect(frames[j]![0], `n ${n}, frame ${j}`).toBe(10 + rifeAnswerIndex(j, n, out.count))
      }
    }
  })

  it('an answer that names no clip, or one that can’t be read: not delivered (charged nothing), the node fails plainly, nothing kept', LONG, async () => {
    await requireMediaTools()
    const c = caseNamed('slowmo · 3 frames · ×2')
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const input = await keptBatch(h, runId, { frames: inputFrames(c), w: c.w, h: c.h })
    const none = await byHand(h, runId, input, 2, { urls: [] })
    await expect(none.run).rejects.toThrow(SLOW_MOTION_AI_WORDS.noAnswer)
    expect(none.undelivered).toEqual([['rife', 'no-file']])
    const junk = await byHand(h, runId, input, 2, { answer: async () => new TextEncoder().encode('not a video at all') })
    await expect(junk.run).rejects.toThrow(SLOW_MOTION_AI_WORDS.badAnswer)
    expect(junk.undelivered).toEqual([['rife', 'no-file']])
    expect(readdirSync(join(h.root, 'kept', runId))).toEqual([input.file.filename])
  })

  it('a clip longer or larger than measured before the run: refused before any call (the hold covers no more)', async () => {
    const c = caseNamed('slowmo · 3 frames · ×2')
    const h = vfxHarness(scratch)
    const input: Frames = { kind: 'frames', file: { filename: 'x.mkv', subfolder: 'r', type: 'kept' }, count: c.count, w: c.w, h: c.h }
    await expect(byHand(h, 'r', input, 2, { measured: { frames: 2, videoWidth: c.w, videoHeight: c.h } })).rejects.toThrow(SLOW_MOTION_AI_WORDS.moreThanHeld)
    await expect(byHand(h, 'r', input, 2, { measured: { frames: 3, videoWidth: c.w - 2, videoHeight: c.h } })).rejects.toThrow(SLOW_MOTION_AI_WORDS.moreThanHeld)
    await expect(byHand(h, 'r', input, 2, { measured: {} })).rejects.toThrow(SLOW_MOTION_AI_WORDS.moreThanHeld)
  })

  it('one frame: handed on as it is, no call; ×7, or a clip under 16 pixels a side: Sailor’s own interpolation, no call, Python’s count, the originals bit for bit', LONG, async () => {
    await requireMediaTools()
    const one = caseNamed('slowmo · one frame')
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const single = await keptBatch(h, runId, { frames: inputFrames(one), w: one.w, h: one.h })
    const a = await byHand(h, runId, single, 4)
    expect((await a.run).values[0]).toEqual(single)
    expect(a.calls).toEqual([])
    for (const name of ['slowmo · 3 frames · ×7', 'slowmo · 3 frames · ×2 · under 16']) {
      const c = caseNamed(name)
      const ins = inputFrames(c)
      const input = await keptBatch(h, runId, { frames: ins, w: c.w, h: c.h })
      const before = PROCS.pids.length
      const r = await byHand(h, runId, input, c.multiplier)
      const out = (await r.run).values[0] as Frames
      expect(r.calls, name).toEqual([])
      expect([out.count, out.w, out.h], name).toEqual([c.out_count, c.w, c.h])
      const frames = split(await batchBytes(h, runId, out), c.w * c.h * 3)
      for (let i = 0; i < c.count; i++) expect(Buffer.from(frames[i * c.multiplier]!).equals(Buffer.from(ins[i]!)), `${name}, original ${i}`).toBe(true)
      await allGone(pids(before))
    }
  })
})

// ── Stop, and an early leave ─────────────────────────────────────────────────

describe('Stop and an early leave leave no tool process and no partial batch', () => {
  it('stopped mid-decode: every process gone within a second, nothing kept but the input', LONG, async () => {
    await requireMediaTools()
    const c = caseNamed('slowmo · 4 frames · ×5')
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const input = await keptBatch(h, runId, { frames: inputFrames(c), w: c.w, h: c.h })
    const before = PROCS.pids.length
    const ctl = new AbortController()
    Object.assign(HOOK, { puts: 0, at: 6, mode: 'stop', ctl })
    try {
      const r = await byHand(h, runId, input, 5, { answer: () => rifeAnswer(c), signal: ctl.signal })
      await expect(r.run).rejects.toThrow()
      expect(r.calls.length).toBe(1)
    }
    finally { Object.assign(HOOK, { at: 0, ctl: null }) }
    // The encode, the answer's probe and count, its decode, the originals' decode and the writer.
    expect(pids(before).length).toBeGreaterThanOrEqual(4)
    await allGone(pids(before))
    expect(readdirSync(join(h.root, 'kept', runId))).toEqual([input.file.filename])
  })

  it('a writer failing mid-run: Sailor’s fault with what was delivered (not charged), no ffmpeg left, nothing kept but the input', LONG, async () => {
    await requireMediaTools()
    const c = caseNamed('slowmo · 4 frames · ×5')
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const input = await keptBatch(h, runId, { frames: inputFrames(c), w: c.w, h: c.h })
    const before = PROCS.pids.length
    Object.assign(HOOK, { puts: 0, at: 4, mode: 'fail', ctl: null })
    try {
      const r = await byHand(h, runId, input, 5, { answer: () => rifeAnswer(c) })
      await expect(r.run).rejects.toThrow('the writer failed (test)')
      expect(r.undelivered).toEqual([['rife', 'sailor-fault']])
    }
    finally { Object.assign(HOOK, { at: 0 }) }
    await allGone(pids(before))
    expect(readdirSync(join(h.root, 'kept', runId))).toEqual([input.file.filename])
  })
})

// ── With ComfyUI off: the acceptance chain through the engine ────────────────

describe('Load video → Get video components → Slow motion (AI) → Create video → Save video, with ComfyUI off', () => {
  const clip = 'v_stereo_aac.mp4'
  const prompt = (m = 2): ApiPrompt => ({
    l: { class_type: 'LoadVideo', inputs: { file: clip } },
    g: { class_type: 'GetVideoComponents', inputs: { video: ['l', 0] } },
    n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0] as Link, multiplier: m } },
    c: { class_type: 'CreateVideo', inputs: { images: ['n', 0] as Link, fps: 24 } },
    s: { class_type: 'SaveVideo', inputs: { video: ['c', 0] as Link, filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } },
  })
  const charged = (k: { ledger: { holds: Map<number, { credits: number; state: string; actual: number | null }> } }) =>
    [...k.ledger.holds.values()].map(x => [x.credits, x.state === 'released' ? 0 : x.actual])

  function kitFor(o: { fal: ReturnType<typeof createFakeFal>; answer: () => Promise<Uint8Array> }) {
    const dir = mkdtempSync(join(scratch, 'kit-'))
    const k = makeKit({
      hosted: true, dir, fal: o.fal,
      deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')), download: async () => ({ bytes: await o.answer(), contentType: 'video/mp4' }) },
    })
    writeFileSync(join(k.root, 'input', clip), readFileSync(clipPath(clip)))
    return { k, dir }
  }

  it('hosted: one RIFE call, held and charged its price plus the render credit, (T − 1)·2 + 1 frames saved', LONG, async () => {
    await requireMediaTools()
    const fal = createFakeFal({ answer: () => ({ video: { url: ANSWER_URL } }) })
    // RIFE's answer here: 5 flat frames of 16 × 12 (fitted and forced to Python's count by the runner).
    const { k } = kitFor({ fal, answer: () => ffv1Clip(Array.from({ length: 5 }, (_, i) => new Uint8Array(16 * 12 * 3).fill(40 * i)), 16, 12) })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt()], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['l', 'g', 'n', 'c', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    const g = take.nodes.g!.values![0] as Frames
    const n = take.nodes.n!.values![0] as Frames
    expect([n.count, n.w, n.h]).toEqual([(g.count - 1) * 2 + 1, g.w, g.h])
    expect(take.measured?.n?.seconds).toMatchObject({ frames: g.count, videoWidth: g.w, videoHeight: g.h })
    expect(fal.submitted().length).toBe(1)
    expect(fal.submitted()[0]!.endpoint).toBe(RIFE_VIDEO_SLUG)
    expect(checkPayload(SCHEMA, fal.submitted()[0]!.payload)).toEqual([])
    const credits = (priceNode(FRAME_INTERP_AI_CLASS, { multiplier: 2 }, { families: ON, inputSeconds: { frames: g.count, videoWidth: g.w, videoHeight: g.h } }) as { credits: number }).credits
    expect(credits).toBeGreaterThan(0)
    expect(take.nodes.n!.credits).toBe(credits)
    expect(charged(k)).toEqual([[credits + 1, credits + 1]])
    // The saved video holds (T − 1)·2 + 1 frames.
    const saved = take.nodes.s!.outputs[0]!
    const path = join(k.root, 'output', saved.subfolder, saved.filename)
    let count = 0
    await decodeFrames(path, { userId: null, maxFrames: 10_000, roots: [join(path, '..')], onFrame: async () => { count++ } })
    expect(count).toBe(n.count)
  })

  it('Stop during the call: the call cancelled, the hold released, no tool process left within a second, no partial batch', LONG, async () => {
    await requireMediaTools()
    const fal = createFakeFal({ answer: () => ({ video: { url: ANSWER_URL } }) })
    fal.holdNext(1)
    const { k, dir } = kitFor({ fal, answer: async () => new Uint8Array(0) })
    const before = PROCS.pids.length
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt()], ...START })
    for (let i = 0; i < 4000 && fal.submitted().length < 1; i++) await new Promise(r => setTimeout(r, 5))
    expect(fal.submitted().length).toBe(1)
    await k.engine.stop(k.userId)
    await k.engine.settled(runId)
    expect(fal.submitted()[0]!.cancelled).toBe(true)
    expect(charged(k).map(x => x[1])).toEqual([0])
    expect(pids(before).length).toBeGreaterThan(0)
    await allGone(pids(before))
    expect((await k.store.get(runId))!.takes[0]!.nodes.n!.values).toBeUndefined()
    // Only Get video components' batch is kept.
    expect(readdirSync(join(dir, 'kept'), { recursive: true }).map(String).filter(x => x.endsWith('.mkv')).length).toBe(1)
  })
})

// ── Before the run ───────────────────────────────────────────────────────────

/** Why the start pass won't run a clip (R11.7: a plain refusal, or the engine when the count is only an upper bound), or null. */
const whyNot = (r: ReturnType<typeof slowMotionAiStart>) => ('refused' in r ? r.refused : 'problem' in r ? r.problem : null)

describe('R11.9c fix round 4: a LoadImage’s animated GIF is the clip Slow motion (AI) interpolates, as Python’s batch', () => {
  /** A GIF of `n` flat frames of w × h, each its own grey, no see-through parts. */
  async function gifOf(n: number, w: number, h: number): Promise<Uint8Array> {
    const sharp = (await import('sharp')).default
    const px = new Uint8Array(w * h * n * 3)
    for (let f = 0; f < n; f++) px.fill(40 + f * 50, f * w * h * 3, (f + 1) * w * h * 3)
    const b = new Uint8Array(await sharp(px, { raw: { width: w, height: h * n, channels: 3, pageHeight: h } as never }).gif().toBuffer())
    for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0x21 && b[i + 1] === 0xF9 && b[i + 2] === 4) b[i + 3] = b[i + 3]! & ~1
    return b
  }
  const prompt = (m: number): ApiPrompt => ({
    l: { class_type: 'LoadImage', inputs: { image: 'anim4.gif', upload: 'image' } },
    n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['l', 0] as Link, multiplier: m } },
    s: { class_type: 'SaveImage', inputs: { images: ['n', 0] as Link, filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: false } },
  })
  const saved = (root: string) => (readdirSync(join(root, 'output'), { recursive: true }) as string[]).filter(f => f.endsWith('.png'))
  const charged = (k: { ledger: { holds: Map<number, { credits: number; state: string; actual: number | null }> } }) =>
    [...k.ledger.holds.values()].map(x => [x.credits, x.state === 'released' ? 0 : x.actual])

  it('4-frame GIF → Slow motion (AI) ×2 → Save image: one RIFE call, held and charged as a 4-frame clip, 7 frames saved', LONG, async () => {
    await requireMediaTools()
    const fal = createFakeFal({ answer: () => ({ video: { url: ANSWER_URL } }) })
    const dir = mkdtempSync(join(scratch, 'kit-'))
    const k = makeKit({
      hosted: true, dir, fal,
      deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')), download: async () => ({ bytes: await ffv1Clip(Array.from({ length: 7 }, (_, i) => new Uint8Array(32 * 24 * 3).fill(30 * i)), 32, 24), contentType: 'video/mp4' }) },
    })
    writeFileSync(join(k.root, 'input', 'anim4.gif'), await gifOf(4, 32, 24))
    expect(isRunnerEligible(prompt(2), ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt(2)], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['l', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    // The batch measured as the clip (its frames and size), one call, the hold its price.
    expect(take.measured?.n?.seconds).toMatchObject({ frames: 4, videoWidth: 32, videoHeight: 24 })
    expect(fal.submitted().map(c => c.endpoint)).toEqual([RIFE_VIDEO_SLUG])
    const credits = (priceNode(FRAME_INTERP_AI_CLASS, { multiplier: 2 }, { families: ON, inputSeconds: { frames: 4, videoWidth: 32, videoHeight: 24 } }) as { credits: number }).credits
    expect(take.nodes.n!.credits).toBe(credits)
    expect(charged(k)).toEqual([[credits + 1, credits + 1]])
    // Handed on as pictures, as it came: (4 − 1)·2 + 1 = 7, the originals at i·2 exactly.
    const v = take.nodes.n!.values![0] as Extract<RunnerValue, { kind: 'files' }>
    expect([v.kind, v.files.length]).toEqual(['files', 7])
    expect(saved(k.root)).toHaveLength(7)
  })

  it('×7 (no RIFE video multiplier): Sailor’s own interpolation, no call, 22 frames saved, nothing held for it', LONG, async () => {
    await requireMediaTools()
    const fal = createFakeFal()
    const dir = mkdtempSync(join(scratch, 'kit-'))
    const k = makeKit({ dir, fal, deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')) } })
    writeFileSync(join(k.root, 'input', 'anim4.gif'), await gifOf(4, 16, 12))
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt(7)], ...START })
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['l', 'n', 's']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    expect(fal.submitted()).toEqual([])
    expect(saved(k.root)).toHaveLength(slowMotionAiCount(4, 7))
  })
})

describe('the start of the run: the clip counted and sized for the hold; past a limit, refused plainly (R11.7) or, on an uncounted bound, held at the cap (R11.8)', () => {
  const p: ApiPrompt = {
    l: { class_type: 'LoadVideo', inputs: { file: 'a.mp4' } }, g: { class_type: 'GetVideoComponents', inputs: { video: ['l', 0] } },
    n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0], multiplier: 3 } },
    c: { class_type: 'CreateVideo', inputs: { images: ['n', 0], fps: 24 } },
  }
  const at = (count: number, w = 640, h = 360) => async () => new Map([['g:0', { count, w, h, exact: false }]])

  it('the count and size recorded; over the frame cap or an output past the batch caps on an uncounted bound, or unknown: held at the cap, never the engine (R11.8)', async () => {
    const ok = await localModelStartProblems(p, ON, { hosted: true, shapes: at(48) })
    expect(ok).toMatchObject({ counts: { n: 48 }, sizes: { n: { w: 640, h: 360 } }, problem: null })
    expect(ok.keptBytes).toBeGreaterThan(0)
    // R11.8 (M3): an uncounted bound past a cap is held at the most a clip may be there (×3 at 640 × 360 hosted:
    // 200 frames, 598 out within the 600-frame batch), and its turn refuses the clip itself past the caps.
    expect(await localModelStartProblems(p, ON, { hosted: true, shapes: at(SLOW_MOTION_AI_MAX_FRAMES.hosted + 1) })).toMatchObject({ counts: { n: 200 }, problem: null })
    expect((await localModelStartProblems(p, ON, { hosted: false, shapes: at(SLOW_MOTION_AI_MAX_FRAMES.hosted + 1) })).problem).toBeNull()
    // Hosted, 240 frames × 3 is 718 frames: past the 600-frame batch cap (on a bound: held at 200).
    expect(await localModelStartProblems(p, ON, { hosted: true, shapes: at(240) })).toMatchObject({ counts: { n: 200 }, problem: null })
    expect(slowMotionAiTurnRefusal(3, { count: 240, w: 640, h: 360 }, true)).toBe(slowMotionAiOutWords(600))
    expect(slowMotionAiTurnRefusal(3, { count: SLOW_MOTION_AI_MAX_FRAMES.hosted + 1, w: 64, h: 36 }, true)).toBe(overCapWords(FRAME_INTERP_AI_CLASS, SLOW_MOTION_AI_MAX_FRAMES.hosted))
    expect(slowMotionAiTurnRefusal(3, { count: 200, w: 640, h: 360 }, true)).toBeNull()
    // Unknown (R11.8, ruling (k)): held at the cap where it runs, priced at the canvas's own ceiling there.
    const unknown = await localModelStartProblems(p, ON, { hosted: true, shapes: async () => new Map() })
    expect(unknown).toMatchObject({ counts: { n: 200 }, sizes: { n: { upTo: true, place: 'hosted' } }, problem: null })
    // ×7 (Sailor's own interpolation) holds R6.6's limits: hosted 1080p is past what it may hold, 720p runs.
    expect(whyNot(slowMotionAiStart({ multiplier: 7 }, { count: 24, w: 1920, h: 1080, exact: false }, true))).toBe(SLOW_MOTION_AI_WORDS.tooBig)
    expect(slowMotionAiStart({ multiplier: 7 }, { count: 24, w: 1280, h: 720, exact: false }, true)).toEqual({ frames: 24, w: 1280, h: 720 })
    expect(slowMotionAiStart({ multiplier: 3 }, { count: 24, w: 1920, h: 1080, exact: false }, true)).toEqual({ frames: 24, w: 1920, h: 1080 })
    expect(slowMotionAiStart({ multiplier: 2 }, { count: 2, w: 5000, h: 5000, exact: false }, true)).toEqual({ refused: SLOW_MOTION_AI_WORDS.tooBig })
  })

  it('the frame shapes: (T − 1)·m + 1 of the clip’s size, its own kept batch (the input handed on under two frames)', async () => {
    const shapes = await frameShapes(p, ON, async () => ({ count: 5, w: 64, h: 36, exact: false }))
    expect(shapes.get('n:0')).toEqual({ count: 13, w: 64, h: 36, exact: false })
    expect(batchesOf(p, ON, shapes).batches.has('n')).toBe(true)
    const one = await frameShapes(p, ON, async () => ({ count: 1, w: 64, h: 36, exact: false }))
    expect(one.get('n:0')?.count).toBe(1)
    expect(batchesOf(p, ON, one).batches.has('n')).toBe(false)
    expect((await frameShapes(p, new Set(['cards', 'media-video']), async () => ({ count: 5, w: 64, h: 36, exact: false }))).has('n:0')).toBe(false)
  })
})

// ── Prices ───────────────────────────────────────────────────────────────────

describe('prices (R7 rule 4, ruling (j))', () => {
  it('RIFE video’s card: fal, read from the page, measured 2026-10-01 (18.6 s for 119 frames out)', () => {
    const card = PAID_RATES[RIFE_VIDEO_SLUG]!
    expect(card).toMatchObject({ unit: 'gpu_per_output_megapixel_frame', service: 'fal', confidence: 'verified', read: '2026-10-01' })
    expect(SCHEMA.pricingText).toContain('$0.0013')
    // The live check's clip: 2 s of 854 × 480 at 30 fps, ×2: 119 frames, about $0.044.
    expect(paidCallUsd({ endpoint: RIFE_VIDEO_SLUG, outputFrames: 119, outputPixels: rifePricedPixels(854, 480) })).toBeCloseTo(0.0444, 3)
    expect(paidCallUsd({ endpoint: RIFE_VIDEO_SLUG, outputFrames: 119 })).toBeNull()
  })

  it('priced only while its family is on: the measured frames and size; nothing under two frames or for ×6–8; held = charged', () => {
    const at = (m: number, frames: number) => priceNode(FRAME_INTERP_AI_CLASS, { multiplier: m }, { families: ON, inputSeconds: { frames, videoWidth: 641, videoHeight: 360 } })
    const usd = paidCallUsd({ endpoint: RIFE_VIDEO_SLUG, outputFrames: 95, outputPixels: 641 * 360 })!
    expect(at(2, 48)).toEqual({ usd, credits: creditsForUsd(usd) })
    expect(at(2, 1)).toEqual({ usd: 0, credits: 0 })
    for (const m of [6, 7, 8]) {
      expect(at(m, 48)).toEqual({ usd: 0, credits: 0 })
      expect(paidNoCall(FRAME_INTERP_AI_CLASS, { multiplier: m })).toBe(true)
    }
    expect(paidNoCall(FRAME_INTERP_AI_CLASS, { multiplier: 5 })).toBe(false)
    // The hold: the stage holds it (plus the render credit) on what was measured; ×7 holds nothing for it.
    const prompt: ApiPrompt = { n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0], multiplier: 2 } } }
    const measured = { n: { seconds: { frames: 48, videoWidth: 641, videoHeight: 360 } } }
    expect(stageEstimate(prompt, ['n'], true, ON, measured)).toBe(creditsForUsd(usd) + 1)
    expect(stageEstimate({ n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0], multiplier: 7 } } }, ['n'], true, ON, measured)).toBe(0)
    // Unmeasured (the canvas): a ceiling at the hosted frame cap, never 0.
    expect((priceNode(FRAME_INTERP_AI_CLASS, { multiplier: 2 }, { families: ON }) as { credits: number }).credits).toBeGreaterThan(0)
    // Off: not priced as a moved class.
    expect('refused' in priceNode(FRAME_INTERP_AI_CLASS, { multiplier: 2 }, { families: new Set(['cards', 'media-video']) })).toBe(true)
    expect(serviceTooltip(FRAME_INTERP_AI_CLASS, ON)).toBe('Runs on fal')
    expect(serviceTooltip(FRAME_INTERP_AI_CLASS, new Set(['cards']))).toBeNull()
  })
})

// ── What the canvas shows covers what is held, where it runs (fix round 1) ──

describe('the canvas’s "up to" for a clip it can’t see covers the most the runner can hold WHERE IT RUNS (fix round 1)', () => {
  const vn = (id: string, nodeType: string, widgets: [string, unknown][], inputs: string[] = []) => ({
    id, data: { nodeType, title: nodeType, widgetDefs: widgets.map(([name]) => ({ name })), widgetsValues: widgets.map(([, v]) => v), inputs: inputs.map(name => ({ name })) },
  })
  const wire = (source: string, target: string, port: number) => ({ source, target, targetHandle: `input-${port}` })
  const canvas = (m: number) => ({
    nodes: [vn('l', 'LoadVideo', [['file', 'a.mp4']]), vn('g', 'GetVideoComponents', [], ['video']), vn('n', FRAME_INTERP_AI_CLASS, [['multiplier', m]], ['frames'])],
    edges: [wire('l', 'g', 0), wire('g', 'n', 0)],
  })
  /** What the runner holds for a clip the start of the run measured (its own price, the stage's render credit aside). */
  const held = (m: number, frames: number, w: number, h: number) => priceNode(FRAME_INTERP_AI_CLASS, { multiplier: m }, { families: ON, inputSeconds: { frames, videoWidth: w, videoHeight: h } }) as { usd: number; credits: number }
  /** Clips the start of the run lets through, at each place's edges: the frame cap, the largest frame, the batch caps. */
  const edges = (hosted: boolean): [number, number, number, number][] => {
    const cap = hosted ? SLOW_MOTION_AI_MAX_FRAMES.hosted : SLOW_MOTION_AI_MAX_FRAMES.local
    return hosted
      ? [[cap, 2, 2560, 1015], [cap, 2, 1920, 1080], [121, 5, 2560, 1040], [2, 5, 4096, 4096], [cap, 2, 640, 360]]
      : [[cap, 5, 3840, 2160], [cap, 2, 2160, 3840], [2, 5, 3840, 2160], [cap, 5, 1920, 1080], [cap, 3, 8192, 8192]]
  }

  it('locally: the badge (this computer’s caps) is at least the hold of the largest clip the start pass lets through, 900 frames included', () => {
    const f = localModelFrames(null, false)
    expect(f).toEqual({ frames: 900, upTo: true })
    let checked = 0
    for (const [t, m, w, h] of edges(false)) {
      const got = slowMotionAiStart({ multiplier: m }, { count: t, w, h, exact: false }, false)
      if (!('frames' in got)) continue
      const badge = modelPricedUsd(FRAME_INTERP_AI_CLASS, { multiplier: m }, { families: ON, inputSeconds: localModelSeconds(f, false) })!
      expect(badge, `×${m}, ${t} frames of ${w} × ${h}`).toBeGreaterThanOrEqual(held(m, got.frames, w, h).usd)
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(3)
    // The 900-frame local clip at ×2 is let through and held; before this fix the badge priced hosted's 240 frames of 1080p, below it.
    expect(whyNot(slowMotionAiStart({ multiplier: 2 }, { count: 900, w: 1920, h: 1080, exact: false }, false))).toBeNull()
    const local = modelPricedUsd(FRAME_INTERP_AI_CLASS, { multiplier: 2 }, { families: ON, inputSeconds: localModelSeconds(f, false) })!
    expect(local).toBeGreaterThanOrEqual(held(2, 900, 1920, 1080).usd)
    expect(held(2, 900, 1920, 1080).usd).toBeGreaterThan(held(2, 240, 1920, 1080).usd)
    // The run-confirm and the cost gate, locally: the same ceiling, "up to".
    const est = estimateUsdForNodes(vueNodesToEstimateInput(canvas(2).nodes, canvas(2).edges, ON), { families: ON })!
    expect(est.usd).toBe(local)
    expect(est.breakdown[0]!.upTo).toBe(true)
  })

  it('hosted: the badge, the run-confirm and the cost gate (hosted caps) are at least the hold of the largest hosted clip', () => {
    const secs = upstreamInputSeconds(canvas(2).nodes[2], canvas(2).nodes, canvas(2).edges)!
    expect(secs).toMatchObject({ upTo: true, seconds: { framesUpTo: 'hosted' } })
    let checked = 0
    for (const [t, m, w, h] of edges(true)) {
      const got = slowMotionAiStart({ multiplier: m }, { count: t, w, h, exact: false }, true)
      if (!('frames' in got)) continue
      const c = canvas(m)
      const s = upstreamInputSeconds(c.nodes[2], c.nodes, c.edges)!
      const badge = nodeCreditEstimate(FRAME_INTERP_AI_CLASS, { multiplier: m, frames: ['g', 0] }, { inputSeconds: s.seconds, families: ON })!
      const est = estimateUsdForNodes(vueNodesToEstimateInput(c.nodes, c.edges, ON), { hosted: true, families: ON })!
      expect(est.hostedCredits).toBe(badge)
      expect(est.breakdown[0]!.upTo).toBe(true)
      // The stage's hold: the node's credits and the render credit.
      expect(badge, `×${m}, ${t} frames of ${w} × ${h}`).toBeGreaterThanOrEqual(held(m, got.frames, w, h).credits + 1)
      // R11.8: a clip held at the cap (unknown, or a paid video's) is priced at that same ceiling.
      const cap = slowMotionAiAtCap(m, true)
      const capped = nodeCreditEstimate(FRAME_INTERP_AI_CLASS, { multiplier: m, frames: ['g', 0] }, { inputSeconds: { frames: cap.frames, videoWidth: cap.w, videoHeight: cap.h, place: 'hosted', framesUpTo: 'hosted' }, families: ON })!
      expect(capped, `×${m} at the cap`).toBe(badge)
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(3)
  })
})

describe('locally, RIFE takes 4K at most (fix round 2, controller ruling)', () => {
  it('the local badge for an unseen clip is the 4K ceiling: 900 frames in 240-frame segments (R11.7), each 3840 × 2160 at most, within the batch caps', () => {
    const f = localModelFrames(null, false)
    for (const m of [2, 5]) {
      const badge = modelPricedUsd(FRAME_INTERP_AI_CLASS, { multiplier: m }, { families: ON, inputSeconds: localModelSeconds(f, false) })!
      // Four segments of 900 frames, each held at a full segment's output.
      const segs = clipSegments(SLOW_MOTION_AI_MAX_FRAMES.local)
      expect(segs.length).toBe(4)
      const out = segmentOutputFrames(240, m)
      expect(badge, `×${m}`).toBeCloseTo(4 * paidCallUsd({ endpoint: RIFE_VIDEO_SLUG, outputFrames: out, outputPixels: 3840 * 2160 })!, 6)
      // It covers the largest 4K clip held, and is no longer this computer's 8192² ceiling.
      expect(badge).toBeGreaterThanOrEqual((priceNode(FRAME_INTERP_AI_CLASS, { multiplier: m }, { families: ON, inputSeconds: { frames: 900, videoWidth: 3840, videoHeight: 2160, place: 'local' } }) as { usd: number }).usd)
      expect(badge).toBeLessThan(paidCallUsd({ endpoint: RIFE_VIDEO_SLUG, outputFrames: out, outputPixels: 8192 * 8192 })!)
    }
    // ×5 at the 4K ceiling: about $20 (four segments).
    expect(modelPricedUsd(FRAME_INTERP_AI_CLASS, { multiplier: 5 }, { families: ON, inputSeconds: localModelSeconds(f, false) })!).toBeLessThan(21)
    // Hosted is unchanged: its own frame cap.
    expect(rifeTakes(2, 4096, 4096, 'hosted')).toBe(true)
  })

  it('4K in either orientation fits; past it, locally: Sailor’s own interpolation where R6.6’s limits allow (no call, nothing held), else refused plainly (R11.7)', () => {
    expect([fitsRifeLocal(3840, 2160), fitsRifeLocal(2160, 3840), fitsRifeLocal(3841, 2160), fitsRifeLocal(3840, 2161), fitsRifeLocal(4000, 1000)]).toEqual([true, true, false, false, false])
    expect(RIFE_LOCAL_MAX).toEqual({ long: 3840, short: 2160 })
    // 4000 × 1000 (4 Mpx, within minterpolate's 2048²): Sailor's interpolation, held for nothing.
    expect(slowMotionAiStart({ multiplier: 2 }, { count: 24, w: 4000, h: 1000, exact: false }, false)).toEqual({ frames: 24, w: 4000, h: 1000 })
    expect(priceNode(FRAME_INTERP_AI_CLASS, { multiplier: 2 }, { families: ON, inputSeconds: { frames: 24, videoWidth: 4000, videoHeight: 1000, place: 'local' } })).toEqual({ usd: 0, credits: 0 })
    // The same clip hosted (within its frame cap) still goes to RIFE.
    expect((priceNode(FRAME_INTERP_AI_CLASS, { multiplier: 2 }, { families: ON, inputSeconds: { frames: 24, videoWidth: 4000, videoHeight: 1000, place: 'hosted' } }) as { credits: number }).credits).toBeGreaterThan(0)
    // 5120 × 2880 locally: past 4K and past minterpolate's largest frame: refused plainly, 4K in words (R11.7, ruling (j)).
    expect(slowMotionAiStart({ multiplier: 2 }, { count: 24, w: 5120, h: 2880, exact: false }, false)).toEqual({ refused: SLOW_MOTION_AI_PAST_4K_WORDS })
  })

  it('a local clip past 4K through the plan: no call, Sailor’s interpolation, Python’s count, the originals bit for bit', LONG, async () => {
    await requireMediaTools()
    // 4000 × 16 frames: past 4K's long side, tiny in pixels.
    const w = 4000
    const hgt = 16
    const ins = Array.from({ length: 3 }, (_, t) => new Uint8Array(w * hgt * 3).map((_, i) => (i * 7 + t * 31) & 255))
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const input = await keptBatch(h, runId, { frames: ins, w, h: hgt })
    const before = PROCS.pids.length
    const r = await byHand(h, runId, input, 2, { measured: { frames: 3, videoWidth: w, videoHeight: hgt }, place: 'local' })
    const out = (await r.run).values[0] as Frames
    expect(r.calls).toEqual([])
    expect([out.count, out.w, out.h]).toEqual([5, w, hgt])
    const frames = split(await batchBytes(h, runId, out), w * hgt * 3)
    for (let i = 0; i < 3; i++) expect(Buffer.from(frames[i * 2]!).equals(Buffer.from(ins[i]!)), `original ${i}`).toBe(true)
    await allGone(pids(before))
  })
})

// ── The family, the row and rule 15 ──────────────────────────────────────────

describe('the family and its row', () => {
  it('off by default, needs the video tools and media-video; a provider class; its batch a frame source while on', () => {
    expect(LOCAL_MODEL_FAMILIES).toContain('slow-motion-ai')
    expect(LOCAL_MODEL_TOOL_FAMILIES).toContain('slow-motion-ai')
    expect(LOCAL_MODEL_REQUIRES['slow-motion-ai']).toBe('media-video')
    expect(ALL_RUNNER_FAMILIES).not.toContain('slow-motion-ai')
    expect([LOCAL_MODEL_FAMILY_OF[FRAME_INTERP_AI_CLASS], SERVICE_OF[FRAME_INTERP_AI_CLASS], SWITCHED_CLASSES[FRAME_INTERP_AI_CLASS]]).toEqual(['slow-motion-ai', 'fal', 'slow-motion-ai'])
    expect(PROVIDER_TYPES.has(FRAME_INTERP_AI_CLASS)).toBe(true)
    expect(RUNNER_OUTPUT_CLASSES.has(FRAME_INTERP_AI_CLASS)).toBe(false)
    expect(RUNNER_NODE_RULES[FRAME_INTERP_AI_CLASS]!.widgets).toEqual({ multiplier: { type: 'INT', required: true, min: 2, max: 8 } })
    expect(FRAMES_LINK_SOURCES.map(x => x.join(':'))).toContain(`${FRAME_INTERP_AI_CLASS}:0`)
    expect(KEPT_MEDIA_MAKERS.has(FRAME_INTERP_AI_CLASS)).toBe(true)
  })

  it('taken with a frame batch in, or (R11.7) a still picture, handed on as a picture; a multiplier out of range or wired: to the engine; its batch read by the frame readers', () => {
    const lv = { class_type: 'LoadVideo', inputs: { file: 'a.mp4' } }
    const g = { class_type: 'GetVideoComponents', inputs: { video: ['l', 0] } }
    const p: ApiPrompt = { l: lv, g, n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0], multiplier: 4 } }, c: { class_type: 'CreateVideo', inputs: { images: ['n', 0], fps: 24 } } }
    expect(isRunnerEligible(p, ON)).toBe(true)
    expect(outputKind(p, ['n', 0], outputKindsFor(ON))).toBe('frames')
    expect(runnerTakesNode(p, 'c', ON)).toBe(true)
    const still: ApiPrompt = { i: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['i', 0], multiplier: 2 } } }
    expect(runnerTakesNode(still, 'n', ON)).toBe(true)
    expect(outputKind(still, ['n', 0], outputKindsFor(ON))).toBe('files')
    for (const multiplier of [1, 9, ['x', 0]]) expect(runnerTakesNode({ ...p, n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0], multiplier } } }, 'n', ON), String(multiplier)).toBe(false)
    // Without media-video (its chain), or without its own family, it is left to the engine and named.
    for (const fam of [new Set<RunnerFamily>(['cards', 'slow-motion-ai']), new Set<RunnerFamily>(['cards', 'media-video'])]) {
      expect(runnerTakesNode(p, 'n', fam)).toBe(false)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id })).toContain('n')
    }
  })
})

describe('with every R7 family off, nothing changes (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but R7\'s', ALL_RUNNER_FAMILIES.filter(x => !LOCAL_MODEL_FAMILIES.includes(x))],
  ]
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, n.class_type === FRAME_INTERP_AI_CLASS ? { ...n, class_type: 'FrameInterpolateAIBefore' } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        if (p[id]!.class_type !== FRAME_INTERP_AI_CLASS) expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
      }
      expect(outputKindsFor(families)[FRAME_INTERP_AI_CLASS]).toBeUndefined()
    }
  }

  it('over one synthetic graph per chain (Create video, Save video frames, a Gate, a still picture)', () => {
    const lv = { class_type: 'LoadVideo', inputs: { file: 'a.mp4' } }
    const g = { class_type: 'GetVideoComponents', inputs: { video: ['l', 0] } }
    const n = (from: string) => ({ class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: [from, 0], multiplier: 2 } })
    sameAsBefore({ l: lv, g, n: n('g'), c: { class_type: 'CreateVideo', inputs: { images: ['n', 0], fps: 24 } }, s: { class_type: 'SaveVideo', inputs: { video: ['c', 0], filename_prefix: 'v', format: 'auto', codec: 'auto' } } }, '→ Create video → Save video')
    const lvf = { class_type: 'LoadVideoFrames', inputs: { file: 'a.mp4', max_seconds: 10, max_frames: 3, max_size: 64, start_frame: 0, stride: 1 } }
    sameAsBefore({ v: lvf, n: n('v'), s: { class_type: 'SaveVideoFrames', inputs: { frames: ['n', 0], fps: 24, filename_prefix: 'v', audio_file: '(none)', preset: 'veryfast', crf: 20 } } }, 'frames → Save video frames')
    sameAsBefore({ v: lvf, q: { class_type: 'ComfyGateNode', inputs: { data_in: ['v', 0], bypass: true } }, n: n('q'), s: { class_type: 'SaveImage', inputs: { images: ['n', 0], filename_prefix: 'x' } } }, 'through a Gate → Save image')
    sameAsBefore({ i: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, n: n('i') }, 'a still picture')
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
        if (Object.values(p).some(n => n.class_type === FRAME_INTERP_AI_CLASS)) withIt++
        sameAsBefore(p, uuid)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`slow-motion-ai families-off invariant: ${graphs} saved graphs, ${withIt} with Slow motion (AI)`)
  }, 600_000)
})

// MEDIA_CAPS is read by the start pass's limits (a guard that the batch cap the tests lean on is still 600 frames).
it('the hosted batch cap the start pass reads', () => expect(MEDIA_CAPS.hosted.batchFrames).toBe(600))
