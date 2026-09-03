/**
 * Pure path arithmetic over the shape library's absolute `M L C Z` data.
 * Two consumers: the Compositor's path layers (fit by width) and Shape
 * Studio's base shape (fit by the larger side). No DOM, no paper.js.
 */
import type { LibraryShape } from '~~/shared/shape-library'

const r5 = (v: number) => { const x = Math.round(v * 1e5) / 1e5; return Object.is(x, -0) ? 0 : x }

/** Every coordinate becomes ((x − cx)·k, (y − cy)·k). Only M L C Z; throws otherwise. */
export function transformShapePath(shape: LibraryShape, k: number, cx: number, cy: number): string {
  let out = ''
  const re = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g
  let m: RegExpExecArray | null
  let pending: number | null = null
  while ((m = re.exec(shape.d))) {
    if (m[1]) {
      if (!'MLCZ'.includes(m[1])) throw new Error(`transformShapePath: unsupported path command "${m[1]}" in shape "${shape.id}"`)
      if (pending !== null) throw new Error(`transformShapePath: odd coordinate count in shape "${shape.id}"`)
      out += m[1]
    } else {
      if (!out) throw new Error(`transformShapePath: path data must start with a command in shape "${shape.id}"`)
      const v = Number(m[2])
      if (pending === null) { pending = v; continue }
      const x = (pending - cx) * k, y = (v - cy) * k
      out += (/[MLC]$/.test(out) ? '' : ',') + `${r5(x)},${r5(y)}`
      pending = null
    }
  }
  if (pending !== null) throw new Error(`transformShapePath: odd coordinate count in shape "${shape.id}"`)
  return out
}

/** Ink box's larger side = `size`, centred on the origin. */
export function fitShapePath(shape: LibraryShape, size: number): { d: string; w: number; h: number } {
  const [bx, by, bw, bh] = shape.box
  if (!(bw > 0) || !(bh > 0) || !(size > 0)) throw new Error(`fitShapePath: degenerate box for shape "${shape.id}"`)
  const k = size / Math.max(bw, bh)
  return { d: transformShapePath(shape, k, bx + bw / 2, by + bh / 2), w: bw * k, h: bh * k }
}
