/**
 * The Compositor node's static composite (`CompositorNode.execute` in
 * comfy_extras/nodes_compositor.py, everything after the baked-motion path).
 * The runner never takes a Frame with baked motion (eligibility), so that
 * path is not here.
 *
 * Same order as Python: gather the connected layers by slot, size the canvas
 * (the explicit width × height, else the lowest connected slot's picture),
 * expand each layer's cloner, composite by ascending z on implicit black,
 * lay the overlay on top, clamp, and union the protected layers' coverage.
 *
 * `composeFrame` does the reading and ordering here and hands the pixel work
 * to a backend: `workerBackend` (worker.ts) on the runner, the in-thread core
 * for `renderFrame` (the parity spec). Each layer's picture is decoded only
 * when its turn comes and let go after, so at most the canvas, one layer and
 * the first layer (which sets the size) are held at once.
 */
import { MAX_FRAME_WORK } from '#shared/runner/eligibility'
import { pyTruthy } from '#shared/runner/pyText'
import { hexToRgb } from '~/lib/vary'
import { expandLayer, parseClonerJson, pyFloat, pyInt } from './cloner'
import { core, type CopyPose, type Picture, type Plane } from './plane'

export const MAX_LAYERS = 16
/** The largest canvas the runner renders: 8192 × 8192, the Frame's own widget limit. */
export const MAX_CANVAS_PIXELS = 8192 * 8192

export interface FrameSources {
  /** layer1 … layer16: the picture on each connected slot (1, 3 or 4 channels), else null. */
  layers: ReadonlyArray<Plane | null>
  /** layer1_mask … layer16_mask: a ComfyUI MASK (1 − alpha, one channel, any size), else null. */
  masks: ReadonlyArray<Plane | null>
  overlay: Plane | null
  overlayMask: Plane | null
}

/** A picture, decoded when asked for (a tensor, or a raw RGBA8 picture the backend turns into one). */
export type Loader = () => Promise<Picture>

export interface FrameLoaders {
  layers: ReadonlyArray<Loader | null>
  masks: ReadonlyArray<Loader | null>
  overlay: Loader | null
  overlayMask: Loader | null
}

export interface FrameResult {
  /** The composite, 3 channels, clamped to [0, 1]. */
  image: Plane
  /** The protect_mask output: 1 where a protected layer covers; null when it was not asked for. */
  protect: Plane | null
}

/** Where the pixel work happens, and what it hands back. One composite at a time per backend. */
export interface FrameBackend<R> {
  begin(ch: number, cw: number): Promise<void>
  paint(image: Picture, mask: Picture | null, blend: string, copies: CopyPose[], protect: boolean): Promise<void>
  overlay(image: Picture, mask: Picture | null): Promise<void>
  finish(): Promise<R>
}

export interface ComposeOptions {
  /** Union the protected layers' coverage (the protect_mask output). The runner never reads it. */
  protect: boolean
  signal?: AbortSignal
  /** The largest canvas (default 8192²; hosted passes 4096²). */
  maxCanvasPixels?: number
  /** The most copies × canvas pixels (default MAX_FRAME_WORK). */
  maxWork?: number
}

/** A widget as execute() reads it: `kwargs.get(name, def)`. */
const get = (inputs: Record<string, unknown>, name: string, def: unknown): unknown =>
  Object.prototype.hasOwnProperty.call(inputs, name) ? inputs[name] : def

const f = Math.fround

function checkStop(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Stopped')
}

/** `CompositorNode.execute`, the static path, reading pictures through `loaders` and painting through `backend`. */
export async function composeFrame<R>(inputs: Record<string, unknown>, loaders: FrameLoaders, backend: FrameBackend<R>, opts: ComposeOptions): Promise<R> {
  // Gather the connected layers in slot order.
  const gathered = []
  for (let i = 1; i <= MAX_LAYERS; i++) {
    const load = loaders.layers[i - 1]
    if (!load) continue
    gathered.push({
      load,
      mask: loaders.masks[i - 1] ?? null,
      x: pyFloat(get(inputs, `layer${i}_x`, 0), `layer${i}_x`),
      y: pyFloat(get(inputs, `layer${i}_y`, 0), `layer${i}_y`),
      rot: pyFloat(get(inputs, `layer${i}_rotation`, 0), `layer${i}_rotation`),
      scl: pyFloat(get(inputs, `layer${i}_scale`, 1), `layer${i}_scale`),
      op: pyFloat(get(inputs, `layer${i}_opacity`, 1), `layer${i}_opacity`),
      blend: String(get(inputs, `layer${i}_blend`, 'normal')),
      z: pyFloat(get(inputs, `layer${i}_z`, i), `layer${i}_z`),
      protect: pyTruthy(get(inputs, `layer${i}_protect`, false)),
      cloner: parseClonerJson(get(inputs, `layer${i}_cloner`, '')),
    })
  }

  // int(kwargs.get("width", 0) or 0)
  const dim = (name: string) => {
    const v = get(inputs, name, 0)
    return pyTruthy(v) ? pyInt(v, name) : 0
  }
  const width = dim('width')
  const height = dim('height')
  const explicit = width > 0 && height > 0

  if (!explicit && !gathered.length) {
    // Nothing connected and no size: a 16×16 black picture (the overlay is not laid either).
    await backend.begin(16, 16)
    return backend.finish()
  }
  let ch: number, cw: number
  // The first gathered layer sets the size; it is kept until its own turn.
  let first: Picture | null = null
  if (explicit) { ch = height; cw = width }
  else {
    first = await gathered[0]!.load()
    ch = first.h
    cw = first.w
  }
  const maxCanvas = opts.maxCanvasPixels ?? MAX_CANVAS_PIXELS
  if (ch * cw > maxCanvas) {
    const side = Math.round(Math.sqrt(maxCanvas))
    throw new Error(`This Frame is larger than ${side} × ${side}, too large to render`)
  }

  // The cloner, now the canvas aspect is known. Copies come back to front,
  // and every copy of a layer shares its z, so a stable sort of the layers
  // is Python's stable sort of the copies.
  const aspect = ch ? cw / ch : 1
  const copiesOf = gathered.map(g => expandLayer({ x: g.x, y: g.y, rot: g.rot, scl: g.scl, op: g.op }, g.cloner, aspect).map((c): CopyPose => {
    let tint: [number, number, number] | null = null
    if (c.tint) {
      const [r, gg, b] = hexToRgb(c.tint)
      tint = [f(r / 255), f(gg / 255), f(b / 255)]
    }
    return { x: c.x, y: c.y, rot: c.rot, scl: c.scl, op: c.op, tint, tintStrength: c.tintStrength }
  }))
  const work = copiesOf.reduce((n, c) => n + c.length, 0) * ch * cw
  if (work > (opts.maxWork ?? MAX_FRAME_WORK)) throw new Error('This Frame asks for too many copies at this size to render (at most 256 copies of 4 megapixels)')

  await backend.begin(ch, cw)
  const order = gathered.map((g, i) => ({ g, i })).sort((p, q) => (p.g.z - q.g.z) || (p.i - q.i))
  for (const { g, i } of order) {
    checkStop(opts.signal)
    const copies = copiesOf[i]!
    const image = i === 0 && first ? first : await g.load()
    if (i === 0) first = null
    const mask = g.mask ? await g.mask() : null
    checkStop(opts.signal)
    await backend.paint(image, mask, g.blend, copies, opts.protect && g.protect)
  }

  if (loaders.overlay) {
    checkStop(opts.signal)
    const o = await loaders.overlay()
    const m = loaders.overlayMask ? await loaders.overlayMask() : null
    await backend.overlay(o, m)
  }
  return backend.finish()
}

/** The core in this thread, yielding to the event loop between layers (tests, the parity spec). */
export function inThreadBackend(signal?: AbortSignal, withProtect = true): FrameBackend<FrameResult> {
  let cv: ReturnType<typeof core.createCanvas> | null = null
  const breathe = () => new Promise<void>(r => setImmediate(r))
  return {
    async begin(ch, cw) { cv = core.createCanvas(ch, cw) },
    async paint(image, mask, blend, copies, protect) {
      core.paint(cv!, image, mask, blend, copies, protect, () => !!signal?.aborted)
      await breathe()
    },
    async overlay(image, mask) { core.overlay(cv!, image, mask) },
    async finish() { return core.finish(cv!, withProtect) },
  }
}

/** `CompositorNode.execute` on decoded pictures, in this thread, protect_mask included (the parity spec). */
export async function renderFrame(inputs: Record<string, unknown>, src: FrameSources): Promise<FrameResult> {
  const wrap = (p: Plane | null): Loader | null => (p ? async () => p : null)
  return composeFrame(inputs, {
    layers: src.layers.map(wrap),
    masks: src.masks.map(wrap),
    overlay: wrap(src.overlay),
    overlayMask: wrap(src.overlayMask),
  }, inThreadBackend(), { protect: true })
}
