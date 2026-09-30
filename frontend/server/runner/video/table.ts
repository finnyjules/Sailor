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
 *   join      — two clips read side by side (R6.3's Crossfade and
 *               Transition): each output frame reads A's frame, B's, or one
 *               of each (`joinOf`, joinReads), both only moving forward, so
 *               nothing is held;
 *   generator — no input (R6.7, R6.8).
 *
 * Each op is '<core>.<fn>' of ./cores.ts, called once per output frame.
 */
import { createHash } from 'node:crypto'
import { MEDIA_EFFECTS_PORTED, type MediaEffectFamily } from '#shared/runner/mediaEffects'
import type { MediaEffectSchema } from '#shared/runner/mediaEffectSchemas.generated'
import { isLink } from '#shared/runner/graph'
import { pyFloatOf, pyIntOf, pyTruthy } from '#shared/runner/pyText'
import { MEDIA_EFFECT_WORDS } from '#shared/runner/mediaEffects'
import { videoCores } from './cores'
import type { JoinLayout } from './core/join'

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
  reads: 'stream' | 'window' | 'held' | 'two-pass' | 'generator' | 'join'
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
   * displacement): the op reads every held frame itself, handed to the
   * worker as one shared buffer (R6.2 fix round 1: the gather, and Time
   * displacement's noise, run on the worker, not this thread). Its call has
   * no inputs of its own.
   */
  heldShared?: true
  /** 'join': the two clips' layout (./core/join.ts layout): the ranges read, the overlap, the head, transition and tail. */
  joinOf?(widgets: Record<string, unknown>, ins: readonly FrameShape[]): JoinLayout
  /** Draws random numbers (Transition's glitch): the plan hands the op glitchSeed's seed as `_seed` (ruling (e)). */
  seeded?(widgets: Record<string, unknown>): boolean
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
export function effectHeldBytes(s: FrameShape, o: { reads: number; held8?: number; state32?: number; extra?: number }): number {
  const f8 = frameBytes(s)
  const main8 = (o.held8 ?? 0) + o.reads + 1
  const worker8 = o.reads + 2
  const floats = o.reads + 1 + (o.state32 ?? 0)
  return f8 * (main8 + worker8) + 4 * f8 * floats + (o.extra ?? 0)
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
/** A pixel gathered on the worker from the held frames, and its source worked out (Slit scan, Time displacement). */
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

/** Two clips' shapes (a join's inputs). */
const twoInputs = (ins: readonly FrameShape[]): [FrameShape, FrameShape] => {
  const a = ins[0]
  const b = ins[1]
  if (!a || !b) throw new Error('There are no video frames wired in')
  return [a, b]
}

const joinLayoutOf = (w: Record<string, unknown>, ins: readonly FrameShape[]): JoinLayout => {
  const [a, b] = twoInputs(ins)
  return videoCores.join.layout(w, a.count, b.count)
}

/**
 * A join's output: A's size, A's head, the transition and B's tail. With
 * bounded inputs the count is a bound too (it only grows with either clip:
 * one more frame lengthens a clip's part or the overlap, never shortens the
 * other).
 */
function joinShape(w: Record<string, unknown>, ins: readonly FrameShape[]): FrameShape {
  const [a, b] = twoInputs(ins)
  const L = joinLayoutOf(w, ins)
  return { count: L.head + L.trans + L.tail, w: a.w, h: a.h, exact: a.exact && b.exact }
}

/**
 * What a join holds (rule 6): no frames (the two clips are read side by
 * side, one frame in hand from each), on the worker two inputs, B resized
 * and the style's own planes (a whip pan's two warps and its padded blur;
 * a zoom's two warps): three float frames of state, each at the larger of
 * the two clips' sizes.
 */
function joinHeldBytes(ins: readonly FrameShape[]): number {
  const [a, b] = twoInputs(ins)
  const big: FrameShape = { count: 1, w: 1, h: Math.max(a.w * a.h, b.w * b.h), exact: true }
  return effectHeldBytes(big, { reads: 2, state32: 3 })
}

/** A transition frame's own steps a pixel, by style (a whip pan: two warps, the add and the blur's taps; a zoom: two warps and the blend). */
const JOIN_STEPS: Readonly<Record<string, number>> = {
  dissolve: 1, glitch: 1, light_leak: 3, zoom_in: 12, zoom_out: 12, whip_pan_left: 30, whip_pan_right: 30,
}
/** B resized to A's size, a pixel (the bilinear's four taps). */
const RESIZE_STEPS = 2

/**
 * A join's work: every frame of both clips decoded (an upper bound: frames
 * past a trim's end aren't), every output frame moved, the transition's own
 * steps, and B's frames resized where the sizes differ.
 */
function joinWork(w: Record<string, unknown>, ins: readonly FrameShape[], out: FrameShape): number {
  const [a, b] = twoInputs(ins)
  const L = joinLayoutOf(w, ins)
  const px = out.w * out.h
  const steps = JOIN_STEPS[typeof w.style === 'string' ? w.style : 'dissolve'] ?? JOIN_STEPS.whip_pan_left!
  const resized = a.w !== b.w || a.h !== b.h ? (L.trans + L.tail) * px * RESIZE_STEPS : 0
  return (a.count * a.w * a.h + b.count * b.w * b.h + out.count * px) * VIDEO_IO_WORK_PER_PIXEL + L.trans * px * steps + resized
}

/**
 * Each output frame of a join, in order: the frame of A (`a`) and of B
 * (`b`) it reads, as indices into each input batch, and its own params for
 * the op (./core/join.ts frame: `_part`, `_i`, `_d`, `_w`, `_h`). Both
 * indices only grow, so the plan reads the two clips side by side.
 */
export function joinReads(L: JoinLayout, aw: number, ah: number): { a: number | null; b: number | null; own: Record<string, unknown> }[] {
  const out: { a: number | null; b: number | null; own: Record<string, unknown> }[] = []
  for (let j = 0; j < L.head; j++) out.push({ a: L.a[0] + j, b: null, own: { _part: 'a' } })
  for (let i = 0; i < L.trans; i++) out.push({ a: L.a[0] + L.head + i, b: L.b[0] + i, own: { _part: 'mix', _i: i, _d: L.d } })
  for (let k = 0; k < L.tail; k++) out.push({ a: null, b: L.b[0] + L.trans + k, own: { _part: 'b', _w: aw, _h: ah } })
  return out
}

/**
 * The glitch's seed (ruling (e), as Add noise's, R2 ruling (e)): Python
 * draws from the process's generator, so no two runs match; the runner seeds
 * its own from the node's widget values (as execute() receives them, in the
 * schema's order) and its two input batches' kept sha256 (a kept batch is
 * named by it), in order: the first 8 bytes of their sha256, an unsigned
 * 64-bit value (torch keeps its low 32 bits). The glitch holds still while
 * nothing changes and changes with a clip or a setting.
 */
export function glitchSeed(schema: MediaEffectSchema | undefined, params: Record<string, unknown>, clips: readonly { filename: string }[]): bigint {
  const widgets = Object.keys(schema?.widgets ?? params).map(name => [name, params[name] ?? null])
  const shas = clips.map((c) => {
    const m = /^([0-9a-f]{64})\.[a-z0-9]+$/.exec(c.filename)
    if (!m) throw new Error('A clip to join isn’t one the runner kept')
    return m[1]
  })
  const h = createHash('sha256').update(JSON.stringify({ widgets, clips: shas })).digest()
  return h.readBigUInt64BE(0)
}

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
    family: 'video-time', op: 'time.slit', inputs: ['frames'], reads: 'held', heldShared: true, preview: true,
    shape: (_w, ins) => {
      const x = oneInput(ins)
      return { count: x.count, w: x.w, h: x.h, exact: x.exact }
    },
    // Every frame (one shared buffer), and the source table (an int per frame and step; the worker makes one row a frame).
    heldBytes: (w, ins) => {
      const x = oneInput(ins)
      return effectHeldBytes(x, { reads: 1, held8: x.count + 1, state32: 1, extra: 4 * x.count * (w.axis === 'horizontal' ? x.w : x.h) })
    },
    work: (_w, ins, out) => (oneInput(ins).count + out.count) * out.w * out.h * VIDEO_IO_WORK_PER_PIXEL + out.count * out.w * out.h * GATHER_STEPS,
    passThrough: (_w, ins) => oneInput(ins).count <= 1,
  },
  /**
   * Time displacement (:237-279): each pixel read from its own frame, offset
   * by a seeded noise (time/core.ts displaceOffsets, displaceSources). Every
   * frame held. T ≤ 1 or strength ≤ 0 handed on. EXACT.
   */
  TimeDisplacement: {
    family: 'video-time', op: 'time.displace', inputs: ['frames'], reads: 'held', heldShared: true, preview: true,
    shape: (_w, ins) => {
      const x = oneInput(ins)
      return { count: x.count, w: x.w, h: x.h, exact: x.exact }
    },
    // Every frame (one shared buffer), the offsets (a float a pixel, carried) and the sources (an int a pixel): under one float frame.
    heldBytes: (_w, ins) => effectHeldBytes(oneInput(ins), { reads: 1, held8: oneInput(ins).count + 1, state32: 1 }),
    work: (_w, ins, out) => (oneInput(ins).count + out.count) * out.w * out.h * VIDEO_IO_WORK_PER_PIXEL + out.count * out.w * out.h * GATHER_STEPS,
    passThrough: (w, ins) => displacePassThrough(w, oneInput(ins).count),
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
  /**
   * Crossfade (nodes_video_effects.py:356-421): each clip trimmed, B resized
   * to A's size, A's head, the blend a·(1 − α) + b·α over the overlap, B's
   * tail (./core/join.ts). The two clips are read side by side. EXACT
   * (linear, ease_in, ease_out); LIBRARY (ease_in_out: cos).
   */
  VideoCrossfade: {
    family: 'video-join', op: 'join.frame', inputs: ['clip_a', 'clip_b'], reads: 'join', preview: true,
    shape: joinShape,
    heldBytes: (_w, ins) => joinHeldBytes(ins),
    work: joinWork,
    joinOf: joinLayoutOf,
  },
  /**
   * Transition (nodes_video_pro.py:810-948): B resized to A's size, A's head,
   * the styled transition over the overlap, B's tail. EXACT: dissolve with
   * an exact curve, glitch under its seed (ruling (e)); LIBRARY: whip pan,
   * zoom, light leak and ease_in_out.
   */
  Transition: {
    family: 'video-join', op: 'join.frame', inputs: ['clip_a', 'clip_b'], reads: 'join', preview: true,
    shape: joinShape,
    heldBytes: (_w, ins) => joinHeldBytes(ins),
    work: joinWork,
    joinOf: joinLayoutOf,
    seeded: w => w.style === 'glitch',
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
