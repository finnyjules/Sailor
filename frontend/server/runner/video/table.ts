/**
 * The video effects the runner computes (step 3, R6): per ported class, its
 * worker op, the frame batches it reads and how (rule 6), the batch it makes
 * (its count and size, from its widgets and its inputs' shapes: rule 3's start
 * pass reads the same function), the frames it holds at once, its work, and
 * whether it writes a live preview (rule 9).
 *
 * `reads`:
 *   stream    — the input's frames one at a time, as they decode; each makes
 *               at most one output frame (`streamOut`), in order; with more
 *               than one input, their frames are read side by side;
 *   window    — a sliding window of 8-bit frames (R6.2's motion blur);
 *   held      — every frame held (8-bit, under MEDIA_CAPS.heldFrameBytes),
 *               each output frame reading the one `heldSource` names;
 *   two-pass  — the batch decoded twice (R6.5's Stabilize);
 *   generator — no input (R6.7, R6.8).
 *
 * Each op is '<core>.<fn>' of ./cores.ts, called once per output frame.
 */
import { MEDIA_EFFECTS_PORTED, type MediaEffectFamily } from '#shared/runner/mediaEffects'
import type { MediaEffectSchema } from '#shared/runner/mediaEffectSchemas.generated'
import { isLink } from '#shared/runner/graph'
import { pyFloatOf, pyIntOf, pyTruthy } from '#shared/runner/pyText'
import { MEDIA_EFFECT_WORDS } from '#shared/runner/mediaEffects'
import { videoCores } from './cores'

/**
 * A frame batch's count and size; `exact: false` when the count is an upper
 * bound. `counted`: the bound comes from the file's packets, counted (R6.1 fix
 * round 1). `soundBytes`: the sound a source keeps beside the batch (Get video
 * components' float WAV), bounded.
 */
export interface FrameShape { count: number; w: number; h: number; exact: boolean; counted?: true; soundBytes?: number }
/** A sound's rate, channels and length (R6.9's sound start pass); `exact: false` when the length is an upper bound. */
export interface SoundShape { rate: number; channels: number; samples: number; exact: boolean }

export interface VideoEffectSpec {
  family: MediaEffectFamily
  /** The worker op run once per output frame: '<core>.<fn>'. */
  op: string
  /** The frame-batch inputs, in order ([] for a generator). */
  inputs: readonly string[]
  reads: 'stream' | 'window' | 'held' | 'two-pass' | 'generator'
  shape(widgets: Record<string, unknown>, ins: readonly FrameShape[]): FrameShape
  /** 8-bit frames held at once (rule 6), for the start pass; an op's own float state counts in bytes too. */
  heldBytes(widgets: Record<string, unknown>, ins: readonly FrameShape[]): number
  /** Pixel·steps, against MEDIA_CAPS.effectWork. */
  work(widgets: Record<string, unknown>, ins: readonly FrameShape[], out: FrameShape): number
  /** Writes live_preview_<id>.png of frame T // 2 (rule 9). */
  preview: boolean
  /** 'stream': the output frame input frame `i` becomes, or null when it is dropped (default: `i`). */
  streamOut?(widgets: Record<string, unknown>, ins: readonly FrameShape[], i: number): number | null
  /** 'held': the input frame output frame `j` reads. */
  heldSource?(widgets: Record<string, unknown>, ins: readonly FrameShape[], j: number): number
  /** The result is the input unchanged (rule 2): the input value is handed on with no work (its preview still written). */
  passThrough?(widgets: Record<string, unknown>, ins: readonly FrameShape[]): boolean
  /** 'window': the input frames each output frame reads, in the order the op takes them, and each output frame's own params. */
  windowOf?(widgets: Record<string, unknown>, ins: readonly FrameShape[]): WindowPlan
  /**
   * 'held', reading many frames per output frame (Slit scan, Time
   * displacement): per output frame, the input frame each pixel comes from
   * (h × w, row by row). The plan gathers that frame from the held frames
   * (selection only, so exact whatever the thread) and the op sees it as its
   * one input. The array returned may be reused by the next call.
   */
  gatherOf?(widgets: Record<string, unknown>, ins: readonly FrameShape[]): (j: number) => Int32Array
  /** Where Python itself raises for these widgets and inputs: its plain words (rule 14), said before any work. */
  pythonRaises?(widgets: Record<string, unknown>, ins: readonly FrameShape[]): string | null
}

/** A window effect's reads (VideoEffectSpec.windowOf). */
export interface WindowPlan {
  /** The input frames output frame `j` reads, in the order its op takes them. */
  at(j: number): readonly number[]
  /** Output frame `j`'s own params, added to the node's. */
  params?(j: number): Record<string, unknown>
}

/**
 * How a window effect streams (./plan.ts): every output frame's window, and
 * for each output frame the lowest input frame any later output still reads
 * (`keepFrom[j]`: frames below it are let go once frame j is made; the last
 * is the input's count). `maxHeld`: the most frames held at once (every
 * frame decoded and not yet let go).
 */
export function windowSchedule(plan: WindowPlan, count: number, inputCount: number): { wins: (readonly number[])[]; keepFrom: Int32Array; maxHeld: number } {
  const wins: (readonly number[])[] = []
  for (let j = 0; j < count; j++) {
    const w = plan.at(j)
    if (!w.length || w.some(i => !Number.isInteger(i) || i < 0 || i >= inputCount)) throw new Error('A video effect read a frame its clip doesn’t have')
    wins.push(w)
  }
  const keepFrom = new Int32Array(count + 1)
  keepFrom[count] = inputCount
  for (let j = count - 1; j >= 0; j--) keepFrom[j] = Math.min(keepFrom[j + 1]!, ...wins[j]!)
  // Frame i is held from its decode (when the reads first reach it) until the output after which keepFrom passes it.
  let maxHeld = 0
  let decoded = 0
  for (let j = 0; j < count; j++) {
    decoded = Math.max(decoded, Math.max(...wins[j]!) + 1)
    maxHeld = Math.max(maxHeld, decoded - keepFrom[j]!)
  }
  return { wins, keepFrom, maxHeld }
}

/** A frame gathered from held frames (VideoEffectSpec.gatherOf): pixel p of held frame src[p], rgb24. */
export function gatherFrame(held: readonly (Uint8Array | null)[], src: Int32Array, w: number, h: number): Uint8Array {
  const n = w * h
  if (src.length !== n) throw new Error('A video frame is not the size its batch says')
  const out = new Uint8Array(n * 3)
  for (let p = 0; p < n; p++) {
    const f = held[src[p]!]
    if (!f) throw new Error('A video frame is missing')
    const q = 3 * p
    out[q] = f[q]!
    out[q + 1] = f[q + 1]!
    out[q + 2] = f[q + 2]!
  }
  return out
}

/**
 * The work of moving one output pixel through the node (rule 6: the decode of
 * the kept batch, the worker's k / 255 and quantise, the FFV1 encode), in
 * VideoEffectSpec.work's units. An op adds its own steps per pixel.
 */
export const VIDEO_IO_WORK_PER_PIXEL = 1

/** The bytes of one 8-bit frame. */
const frameBytes = (s: FrameShape) => s.w * s.h * 3

/**
 * The memory one video effect node holds at once (rule 6, R6.1 fix round 1:
 * one cost model every effect's `heldBytes` uses), in bytes, for frames of
 * `s`'s size:
 *   - on the main thread: the 8-bit frames the plan holds (`held8`: all of
 *     them for a held effect, a window's for a window effect), one frame in
 *     hand from each input's decode (`reads`), and one on its way to the
 *     encoder;
 *   - on the worker, per output frame: the 8-bit frames it was handed
 *     (`reads`), their float32 tensors (k / 255, 4 bytes a value), the
 *     output's float32 tensor, and its 8-bit forms (the frame and the
 *     preview's);
 *   - the float32 state an op carries between frames (`state32`, in frames:
 *     Frame trail's trail is one).
 */
export function effectHeldBytes(s: FrameShape, o: { reads: number; held8?: number; state32?: number }): number {
  const f8 = frameBytes(s)
  const main8 = (o.held8 ?? 0) + o.reads + 1
  const worker8 = o.reads + 2
  const floats = o.reads + 1 + (o.state32 ?? 0)
  return f8 * (main8 + worker8) + 4 * f8 * floats
}

/** Python's int() of a validated INT widget (already converted by the plan). */
const int = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback)

/** VideoTrim's range (nodes_video_effects.py:343-348): [s, e), or frames[:1] when that is empty. */
export function trimRange(widgets: Record<string, unknown>, T: number): { s: number; e: number; first: boolean } {
  const s = Math.max(0, Math.min(T, int(widgets.start, 0)))
  const end = int(widgets.end, -1)
  const e = end < 0 ? T : Math.max(s, Math.min(T, end))
  return e > s ? { s, e, first: false } : { s: 0, e: Math.min(1, T), first: true }
}

/** VideoReverse's count (:305-315): reverse T; ping_pong 2T when T ≤ 2, else 2T − 2. */
function reverseCount(mode: unknown, T: number): number {
  if (mode !== 'ping_pong') return T
  return T <= 2 ? 2 * T : 2 * T - 2
}

const oneInput = (ins: readonly FrameShape[]): FrameShape => {
  const x = ins[0]
  if (!x) throw new Error('There are no video frames wired in')
  return x
}

/** Selection only: each output pixel is only moved (no arithmetic of its own). */
const SELECT_STEPS = 0
/** Frame trail's own steps a pixel: the decay, the max, the trail, the blend and the clamp (the luma where asked). */
const TRAIL_STEPS = 2
/** A pixel gathered on the main thread from the held frames, and its source worked out (Slit scan, Time displacement). */
const GATHER_STEPS = 2
/** Speed ramp's blend a pixel: two products, a sum and the clamp. */
const BLEND_STEPS = 1
/**
 * The frames Speed ramp holds at once, at most: a blend reads frames lo and
 * lo + 1 and lo only grows (float rounding can step it back one), so the
 * frames between the lowest still read and the highest decoded are never
 * more than four (checked over every fixture and a sweep in the spec; the
 * plan measures its own schedule and uses the larger).
 */
const RAMP_HELD = 4

/** Speed ramp's mapping for these widgets and T input frames (T > 1). */
const rampOf = (w: Record<string, unknown>, T: number) => videoCores.time.rampSources(w, T)

/** Time displacement hands its input on (nodes_video_effects.py:257): T ≤ 1, or strength ≤ 0. */
const displacePassThrough = (w: Record<string, unknown>, T: number) => T <= 1 || !((w.strength as number) > 0)

export const VIDEO_EFFECTS: Readonly<Record<string, VideoEffectSpec>> = {
  VideoTrim: {
    family: 'video-time', op: 'time.select', inputs: ['frames'], reads: 'stream', preview: true,
    shape: (w, ins) => {
      const x = oneInput(ins)
      const r = trimRange(w, x.count)
      return { count: r.e - r.s, w: x.w, h: x.h, exact: x.exact }
    },
    heldBytes: (_w, ins) => effectHeldBytes(oneInput(ins), { reads: 1 }),
    // Every input frame is decoded (the ones outside the range dropped), every output one moved.
    work: (_w, ins, out) => (oneInput(ins).count + out.count) * out.w * out.h * (VIDEO_IO_WORK_PER_PIXEL + SELECT_STEPS),
    streamOut: (w, ins, i) => {
      const r = trimRange(w, oneInput(ins).count)
      return i >= r.s && i < r.e ? i - r.s : null
    },
    passThrough: (w, ins) => {
      const x = oneInput(ins)
      const r = trimRange(w, x.count)
      return r.s === 0 && r.e === x.count
    },
  },
  VideoReverse: {
    family: 'video-time', op: 'time.select', inputs: ['frames'], reads: 'held', preview: true,
    shape: (w, ins) => {
      const x = oneInput(ins)
      return { count: reverseCount(w.mode, x.count), w: x.w, h: x.h, exact: x.exact }
    },
    heldBytes: (_w, ins) => effectHeldBytes(oneInput(ins), { reads: 1, held8: oneInput(ins).count }),
    work: (_w, ins, out) => (oneInput(ins).count + out.count) * out.w * out.h * (VIDEO_IO_WORK_PER_PIXEL + SELECT_STEPS),
    heldSource: (w, ins, j) => {
      const T = oneInput(ins).count
      if (w.mode !== 'ping_pong') return T - 1 - j
      if (j < T) return j
      // The frames reversed: all of them when T ≤ 2, else without the two end frames.
      return T <= 2 ? 2 * T - 1 - j : T - 2 - (j - T)
    },
    passThrough: (w, ins) => w.mode !== 'ping_pong' && oneInput(ins).count <= 1,
  },
  FrameTrail: {
    family: 'video-time', op: 'time.trail', inputs: ['frames'], reads: 'stream', preview: true,
    shape: (_w, ins) => {
      const x = oneInput(ins)
      return { count: x.count, w: x.w, h: x.h, exact: x.exact }
    },
    // The trail is carried as one float32 frame.
    heldBytes: (_w, ins) => effectHeldBytes(oneInput(ins), { reads: 1, state32: 1 }),
    work: (_w, ins, out) => (oneInput(ins).count + out.count) * out.w * out.h * VIDEO_IO_WORK_PER_PIXEL + out.count * out.w * out.h * TRAIL_STEPS,
    passThrough: (_w, ins) => oneInput(ins).count <= 1,
  },
  /**
   * Motion blur (time) (nodes_video_effects.py:125-174). Python hands one
   * frame (or none) on unchanged, and RAISES on every longer clip: its
   * F.pad(…, mode='replicate') of a 4-D tensor by (r, r) is not supported
   * (torch 2.10: "Padding size 2 is not supported for 4D input tensor",
   * recorded by every fixture case with T ≥ 2). The runner says so in plain
   * words, before any work (rule 14).
   */
  TemporalMotionBlur: {
    family: 'video-time', op: 'time.select', inputs: ['frames'], reads: 'stream', preview: true,
    shape: (_w, ins) => {
      const x = oneInput(ins)
      return { count: x.count, w: x.w, h: x.h, exact: x.exact }
    },
    heldBytes: (_w, ins) => effectHeldBytes(oneInput(ins), { reads: 1 }),
    work: (_w, ins, out) => (oneInput(ins).count + out.count) * out.w * out.h * (VIDEO_IO_WORK_PER_PIXEL + SELECT_STEPS),
    passThrough: (_w, ins) => oneInput(ins).count <= 1,
    pythonRaises: (_w, ins) => oneInput(ins).count > 1 ? MEDIA_EFFECT_WORDS.motionBlurFails : null,
  },
  /**
   * Slit scan (:182-229): each column (or row) read from its own frame
   * (time/core.ts slitSources). Every frame held: an output frame reads from
   * up to W (or H) frames anywhere in time. T ≤ 1 handed on. EXACT.
   */
  SlitScan: {
    family: 'video-time', op: 'time.select', inputs: ['frames'], reads: 'held', preview: true,
    shape: (_w, ins) => {
      const x = oneInput(ins)
      return { count: x.count, w: x.w, h: x.h, exact: x.exact }
    },
    // Every frame, the gathered frame, and the sources (an int a pixel: under one float frame).
    heldBytes: (_w, ins) => effectHeldBytes(oneInput(ins), { reads: 1, held8: oneInput(ins).count + 1, state32: 1 }),
    work: (_w, ins, out) => (oneInput(ins).count + out.count) * out.w * out.h * VIDEO_IO_WORK_PER_PIXEL + out.count * out.w * out.h * GATHER_STEPS,
    passThrough: (_w, ins) => oneInput(ins).count <= 1,
    gatherOf: (w, ins) => {
      const x = oneInput(ins)
      const src = videoCores.time.slitSources(w, x.count, x.w, x.h)
      const horizontal = w.axis === 'horizontal'
      const S = horizontal ? x.w : x.h
      const map = new Int32Array(x.w * x.h)
      return (j) => {
        const row = j * S
        for (let y = 0; y < x.h; y++) {
          for (let c = 0; c < x.w; c++) map[y * x.w + c] = src[row + (horizontal ? c : y)]!
        }
        return map
      }
    },
  },
  /**
   * Time displacement (:237-279): each pixel read from its own frame, offset
   * by a seeded noise (time/core.ts displaceOffsets, displaceSources). Every
   * frame held. T ≤ 1 or strength ≤ 0 handed on. EXACT.
   */
  TimeDisplacement: {
    family: 'video-time', op: 'time.select', inputs: ['frames'], reads: 'held', preview: true,
    shape: (_w, ins) => {
      const x = oneInput(ins)
      return { count: x.count, w: x.w, h: x.h, exact: x.exact }
    },
    // Every frame, the gathered frame, the offsets (a float a pixel) and the sources (an int a pixel): under one float frame.
    heldBytes: (_w, ins) => effectHeldBytes(oneInput(ins), { reads: 1, held8: oneInput(ins).count + 1, state32: 1 }),
    work: (_w, ins, out) => (oneInput(ins).count + out.count) * out.w * out.h * VIDEO_IO_WORK_PER_PIXEL + out.count * out.w * out.h * GATHER_STEPS,
    passThrough: (w, ins) => displacePassThrough(w, oneInput(ins).count),
    gatherOf: (w, ins) => {
      const x = oneInput(ins)
      const offsets = videoCores.time.displaceOffsets(w, x.w, x.h)
      const map = new Int32Array(x.w * x.h)
      return j => videoCores.time.displaceSources(offsets, j, x.count, !!w.wrap, map)
    },
  },
  /**
   * Speed ramp (nodes_video_pro.py:59-130): N output frames, each from its
   * source position (time/core.ts rampSources); `nearest` reads one frame,
   * `blend` two. The source only grows, so frames stream through a small
   * window. T ≤ 1 handed on. EXACT (`constant`); the ramps through
   * ease_in_out's cos (LIBRARY).
   */
  SpeedRamp: {
    family: 'video-time', op: 'time.ramp', inputs: ['frames'], reads: 'window', preview: true,
    shape: (w, ins) => {
      const x = oneInput(ins)
      return { count: x.count <= 1 ? x.count : rampOf(w, x.count).N, w: x.w, h: x.h, exact: x.exact }
    },
    heldBytes: (w, ins) => {
      const x = oneInput(ins)
      const reads = w.interpolation === 'nearest' ? 1 : 2
      if (x.count <= 1) return effectHeldBytes(x, { reads: 1 })
      const r = rampOf(w, x.count)
      const measured = windowSchedule(rampWindow(w, r), r.N, x.count).maxHeld
      return effectHeldBytes(x, { reads, held8: Math.max(RAMP_HELD, measured) })
    },
    work: (w, ins, out) => (oneInput(ins).count + out.count) * out.w * out.h * VIDEO_IO_WORK_PER_PIXEL
      + (w.interpolation === 'nearest' ? 0 : out.count * out.w * out.h * BLEND_STEPS),
    passThrough: (_w, ins) => oneInput(ins).count <= 1,
    windowOf: (w, ins) => rampWindow(w, rampOf(w, oneInput(ins).count)),
  },
}

/** Speed ramp's reads: the nearest frame, or lo and hi with this frame's frac. */
function rampWindow(w: Record<string, unknown>, r: ReturnType<typeof rampOf>): WindowPlan {
  if (w.interpolation === 'nearest') return { at: j => [r.nearest[j]!] }
  return { at: j => [r.lo[j]!, r.hi[j]!], params: j => ({ _frac: r.frac[j]! }) }
}

/** A ported video effect's spec, or undefined. */
export function videoEffectSpec(classType: string): VideoEffectSpec | undefined {
  return MEDIA_EFFECTS_PORTED.includes(classType) && Object.prototype.hasOwnProperty.call(VIDEO_EFFECTS, classType) ? VIDEO_EFFECTS[classType] : undefined
}

/** A widget as ComfyUI's validate_inputs converts it (int(), float(), str(), bool()); eligibility has checked it converts. */
function widgetValue(type: string, v: unknown): unknown {
  if (v === undefined) return undefined
  switch (type) {
    case 'FLOAT': return typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : typeof v === 'string' ? pyFloatOf(v) : v
    case 'INT': return typeof v === 'number' ? Math.trunc(v) : typeof v === 'boolean' ? Number(v) : typeof v === 'string' ? pyIntOf(v) : v
    case 'BOOLEAN': return pyTruthy(v)
    case 'STRING':
    case 'COMBO':
      if (typeof v === 'string') return v
      if (typeof v === 'boolean') return v ? 'True' : 'False'
      return v === null ? 'None' : String(v)
    default: return v
  }
}

/** The node's widgets as its execute() receives them (a stand-in class with no schema: its inputs as they are). */
export function mediaEffectParams(schema: MediaEffectSchema | undefined, inputs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!schema) {
    for (const [k, v] of Object.entries(inputs)) if (!isLink(v)) out[k] = v
    return out
  }
  for (const [name, w] of Object.entries(schema.widgets)) {
    const v = widgetValue(w.fileList ? 'STRING' : w.type, inputs[name])
    if (v !== undefined) out[name] = v
  }
  return out
}
