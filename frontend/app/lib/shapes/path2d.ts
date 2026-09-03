/**
 * Canvas-2D side of the shape library. Every 2D consumer (the Space Type tile
 * painter today; Compositor thumbnails and picker previews later) draws a
 * library shape through `drawShape`, so "fit the ink box into a target box"
 * lives in exactly one place. Browser-only (Path2D) — never import from a
 * module the server or a node-only path reaches.
 */
import type { LibraryShape } from '~~/shared/shape-library'

const cache = new Map<string, Path2D>()

/** One Path2D per shape id, built lazily and kept for the page's life. */
export function shapePath2D(shape: LibraryShape): Path2D {
  let p = cache.get(shape.id)
  if (!p) { p = new Path2D(shape.d); cache.set(shape.id, p) }
  return p
}

/** Ink width ÷ ink height. 1 for a degenerate box. */
export function shapeAspect(shape: LibraryShape): number {
  const [, , w, h] = shape.box
  return h > 0 && w > 0 ? w / h : 1
}

export interface DrawShapeOpts {
  /** Target box, in the context's current units. The ink box is fitted inside, aspect kept, centred. */
  x: number; y: number; w: number; h: number
  fill?: string
  /** Outline in context pixels — divided by the fit scale so it matches text stroke widths. */
  stroke?: { color: string; width: number }
}

export function drawShape(ctx: CanvasRenderingContext2D, shape: LibraryShape, o: DrawShapeOpts): void {
  if (!(o.w > 0) || !(o.h > 0)) return
  const [bx, by, bw, bh] = shape.box
  if (!(bw > 0) || !(bh > 0)) return
  const s = Math.min(o.w / bw, o.h / bh)
  const dx = o.x + (o.w - bw * s) / 2 - bx * s
  const dy = o.y + (o.h - bh * s) / 2 - by * s
  const path = shapePath2D(shape)
  ctx.save()
  ctx.translate(dx, dy)
  ctx.scale(s, s)
  if (o.stroke && o.stroke.width > 0) {
    ctx.lineWidth = o.stroke.width / s
    ctx.strokeStyle = o.stroke.color
    ctx.lineJoin = 'round'
    ctx.stroke(path)
  }
  if (o.fill) {
    ctx.fillStyle = o.fill
    ctx.fill(path, shape.fillRule)
  }
  ctx.restore()
}
