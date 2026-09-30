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

/** A frame batch's count and size; `exact: false` when the count is an upper bound. */
export interface FrameShape { count: number; w: number; h: number; exact: boolean }
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
}

/**
 * The work of moving one output pixel through the node (rule 6: the decode of
 * the kept batch, the worker's k / 255 and quantise, the FFV1 encode), in
 * VideoEffectSpec.work's units. An op adds its own steps per pixel.
 */
export const VIDEO_IO_WORK_PER_PIXEL = 1

/** The bytes of one 8-bit frame. */
const frameBytes = (s: FrameShape) => s.w * s.h * 3

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

export const VIDEO_EFFECTS: Readonly<Record<string, VideoEffectSpec>> = {
  VideoTrim: {
    family: 'video-time', op: 'time.select', inputs: ['frames'], reads: 'stream', preview: true,
    shape: (w, ins) => {
      const x = oneInput(ins)
      const r = trimRange(w, x.count)
      return { count: r.e - r.s, w: x.w, h: x.h, exact: x.exact }
    },
    // One frame in hand, one out.
    heldBytes: (_w, ins) => 2 * frameBytes(oneInput(ins)),
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
    heldBytes: (_w, ins) => (oneInput(ins).count + 1) * frameBytes(oneInput(ins)),
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
    shape: (_w, ins) => ({ ...oneInput(ins) }),
    // A frame in, one out, and the trail (three float32 planes).
    heldBytes: (_w, ins) => 2 * frameBytes(oneInput(ins)) + 4 * frameBytes(oneInput(ins)),
    work: (_w, ins, out) => (oneInput(ins).count + out.count) * out.w * out.h * VIDEO_IO_WORK_PER_PIXEL + out.count * out.w * out.h * TRAIL_STEPS,
    passThrough: (_w, ins) => oneInput(ins).count <= 1,
  },
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
