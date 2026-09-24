/**
 * The Compositor node's static composite (`CompositorNode.execute` in
 * comfy_extras/nodes_compositor.py, everything after the baked-motion path),
 * on decoded pictures. The runner never takes a Frame with baked motion
 * (eligibility), so that path is not here.
 *
 * Same order as Python: gather the connected layers by slot, size the canvas
 * (the explicit width × height, else the lowest connected slot's picture),
 * expand each layer's cloner, composite by ascending z on implicit black,
 * lay the overlay on top, clamp, and union the protected layers' coverage.
 * Pure: no files, no sharp; `decode.ts` feeds it and encodes the result.
 */
import { pyTruthy } from '#shared/runner/pyText'
import { drawable, expandLayer, parseClonerJson, pyFloat, pyInt, type Clone } from './cloner'
import {
  blendValue, channel, channels, concat, fitToCanvas, plane, repeat3, resizeTo, transform, type Plane,
} from './plane'
import { hexToRgb } from '~/lib/vary'

export const MAX_LAYERS = 16

export interface FrameSources {
  /** layer1 … layer16: the picture on each connected slot (1, 3 or 4 channels), else null. */
  layers: ReadonlyArray<Plane | null>
  /** layer1_mask … layer16_mask: a ComfyUI MASK (1 − alpha, one channel, any size), else null. */
  masks: ReadonlyArray<Plane | null>
  overlay: Plane | null
  overlayMask: Plane | null
}

export interface FrameResult {
  /** The composite, 3 channels, clamped to [0, 1]. */
  image: Plane
  /** The protect_mask output: 1 where a protected layer covers. */
  protect: Plane
}

interface GatheredLayer extends Clone {
  image: Plane
  blend: string
  z: number
  mask: Plane | null
  protect: boolean
}

/** A widget as execute() reads it: `kwargs.get(name, def)`. */
const get = (inputs: Record<string, unknown>, name: string, def: unknown): unknown =>
  Object.prototype.hasOwnProperty.call(inputs, name) ? inputs[name] : def

/** Every operation rounds to float32, as torch's float32 tensors do (see plane.ts). */
const f = Math.fround

/** Yields to the event loop between layers, so a large Frame does not hold the server up. */
const breathe = () => new Promise<void>(r => setImmediate(r))

/**
 * `_prep_layer`: the layer (one copy of it) at canvas size, as its RGB and its
 * alpha (coverage × opacity × embedded alpha × (1 − mask)).
 */
export function prepLayer(l: GatheredLayer, ch: number, cw: number): { rgb: Plane; a: Float32Array } {
  let t = l.image
  if (t.c === 1) t = repeat3(t)
  else if (t.c === 2) t = concat(repeat3(channels(t, 0, 1)), channels(t, 1, 2))
  t = fitToCanvas(t, ch, cw)
  const { out, geo } = transform(t, l.x, l.y, l.rot, l.scl)
  const n = ch * cw
  let rgb = channels(out, 0, 3)
  if (l.tint) {
    // _tint_rgb: rgb·(1 − s) + tint·s, for a strength s = clamp01 > 0.
    const s0 = typeof l.tintStrength === 'number' ? l.tintStrength : 1
    const s = s0 < 0 ? 0 : s0 > 1 ? 1 : s0
    if (s > 0) {
      const [r, g, b] = hexToRgb(l.tint)
      const tint = [f(r / 255), f(g / 255), f(b / 255)]
      // Python scalars: (1.0 − s) in double, then float32 like s itself.
      const keep = f(1 - s)
      const sf = f(s)
      const tinted = plane(3, ch, cw)
      for (let k = 0; k < 3; k++) {
        const src = channel(rgb, k)
        const dst = channel(tinted, k)
        const tk = tint[k]!
        const tintPart = f(tk * sf)
        for (let i = 0; i < n; i++) dst[i] = f(f(src[i]! * keep) + tintPart)
      }
      rgb = tinted
    }
  }
  const a = new Float32Array(n)
  const g = geo.data
  const op = f(l.op)
  for (let i = 0; i < n; i++) {
    const v = f(g[i]! * op)
    a[i] = v < 0 ? 0 : v > 1 ? 1 : v
  }
  if (out.c >= 4) {
    const emb = channel(out, 3)
    for (let i = 0; i < n; i++) {
      const e = emb[i]! < 0 ? 0 : emb[i]! > 1 ? 1 : emb[i]!
      const v = f(a[i]! * e)
      a[i] = v < 0 ? 0 : v > 1 ? 1 : v
    }
  }
  if (l.mask) {
    const m = resizeTo(l.mask, ch, cw).data
    for (let i = 0; i < n; i++) {
      const v = f(a[i]! * f(1 - m[i]!))
      a[i] = v < 0 ? 0 : v > 1 ? 1 : v
    }
  }
  return { rgb, a }
}

/** `CompositorNode.execute`, the static path. `inputs` are the node's widget values. */
export async function renderFrame(inputs: Record<string, unknown>, src: FrameSources): Promise<FrameResult> {
  // Gather the connected layers in slot order.
  const gathered: Array<Omit<GatheredLayer, 'tint' | 'tintStrength'> & { cloner: Record<string, unknown> | null }> = []
  for (let i = 1; i <= MAX_LAYERS; i++) {
    const image = src.layers[i - 1]
    if (!image) continue
    gathered.push({
      image,
      x: pyFloat(get(inputs, `layer${i}_x`, 0), `layer${i}_x`),
      y: pyFloat(get(inputs, `layer${i}_y`, 0), `layer${i}_y`),
      rot: pyFloat(get(inputs, `layer${i}_rotation`, 0), `layer${i}_rotation`),
      scl: pyFloat(get(inputs, `layer${i}_scale`, 1), `layer${i}_scale`),
      op: pyFloat(get(inputs, `layer${i}_opacity`, 1), `layer${i}_opacity`),
      blend: String(get(inputs, `layer${i}_blend`, 'normal')),
      z: pyFloat(get(inputs, `layer${i}_z`, i), `layer${i}_z`),
      mask: src.masks[i - 1] ?? null,
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

  if (!gathered.length && !explicit) {
    return { image: plane(3, 16, 16), protect: plane(1, 16, 16) }
  }
  const ch = explicit ? height : gathered[0]!.image.h
  const cw = explicit ? width : gathered[0]!.image.w

  // The cloner, now the canvas aspect is known. Copies come back to front.
  const aspect = ch ? cw / ch : 1
  const layers: GatheredLayer[] = []
  for (const g of gathered) {
    for (const copy of expandLayer({ x: g.x, y: g.y, rot: g.rot, scl: g.scl, op: g.op }, g.cloner, aspect)) {
      layers.push({ ...g, ...copy })
    }
  }

  // _composite_layers: ascending z, a stable sort (equal z keeps slot order).
  const n = ch * cw
  const ordered = layers.map((l, i) => ({ l, i })).sort((p, q) => (p.l.z - q.l.z) || (p.i - q.i)).map(p => p.l)
  let result: Plane | null = null
  for (const l of ordered) {
    if (!drawable(l)) continue
    const { rgb, a } = prepLayer(l, ch, cw)
    if (!result) {
      result = plane(3, ch, cw)
      for (let k = 0; k < 3; k++) {
        const s = channel(rgb, k)
        const d = channel(result, k)
        for (let i = 0; i < n; i++) d[i] = f(s[i]! * a[i]!)
      }
    }
    else {
      for (let k = 0; k < 3; k++) {
        const s = channel(rgb, k)
        const d = channel(result, k)
        for (let i = 0; i < n; i++) {
          const base = d[i]!
          const blended = blendValue(base, s[i]!, l.blend)
          d[i] = f(f(base * f(1 - a[i]!)) + f(blended * a[i]!))
        }
      }
    }
    await breathe()
  }
  if (!result) result = plane(3, ch, cw)

  // The overlay: always on top, straight per-pixel alpha.
  if (src.overlay) {
    let o = resizeTo(src.overlay, ch, cw)
    let embedded: Float32Array | null = null
    if (o.c === 1) o = repeat3(o)
    else if (o.c >= 4) {
      embedded = Float32Array.from(channel(o, 3), v => (v < 0 ? 0 : v > 1 ? 1 : v))
      o = channels(o, 0, 3)
    }
    const a = new Float32Array(n)
    if (src.overlayMask) {
      const m = resizeTo(src.overlayMask, ch, cw).data
      for (let i = 0; i < n; i++) {
        const v = f(1 - m[i]!)
        a[i] = v < 0 ? 0 : v > 1 ? 1 : v
      }
    }
    else a.fill(1)
    if (embedded) {
      for (let i = 0; i < n; i++) {
        const v = f(a[i]! * embedded[i]!)
        a[i] = v < 0 ? 0 : v > 1 ? 1 : v
      }
    }
    for (let k = 0; k < 3; k++) {
      const s = channel(o, k)
      const d = channel(result, k)
      for (let i = 0; i < n; i++) d[i] = f(f(d[i]! * f(1 - a[i]!)) + f(s[i]! * a[i]!))
    }
  }

  const out = result.data
  for (let i = 0; i < out.length; i++) {
    const v = out[i]!
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v
  }

  // _protect_coverage: the max of every protected, drawable copy's alpha.
  const protect = plane(1, ch, cw)
  for (const l of layers) {
    if (!l.protect || !drawable(l)) continue
    const { a } = prepLayer(l, ch, cw)
    const p = protect.data
    for (let i = 0; i < n; i++) if (a[i]! > p[i]!) p[i] = a[i]!
    await breathe()
  }
  return { image: result, protect }
}
