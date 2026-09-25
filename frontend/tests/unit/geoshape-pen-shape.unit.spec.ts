import { describe, it, expect, afterEach } from 'vitest'
import type { SketchDoc } from '~/lib/sketch/model'
import { addPoint, addPath, addCircle } from '~/lib/sketch/edit'
import { applyView } from '~/lib/sketch/view'
import { drawnPath, sketchOutlineBounds } from '~/lib/geoshape/shapes'
import { drawToCanvas } from '~/lib/geoshape/render'
import { transformCommands } from '~/lib/vector/svg'
import {
  naturalExtent, refitFactor, frozenPreviewFrame, shapePenView, commitDrawn,
} from '~/lib/geoshape/penShape'

// An off-centre triangle, 60 × 40 drawing units, bbox centre (40, 30).
const VERTS = [{ x: 10, y: 10 }, { x: 70, y: 10 }, { x: 40, y: 50 }]
const tri = (): SketchDoc => {
  const d: SketchDoc = { entities: [], constraints: [] }
  const ids = VERTS.map(v => addPoint(d, v.x, v.y))
  addPath(d, ids, [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
  return d
}
const empty = (): SketchDoc => ({ entities: [], constraints: [] })

/** Every coordinate pair of an absolute M/L/Z path, in order. */
const mlPoints = (d: string) => {
  const t = d.trim().split(/[\s,]+/)
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < t.length;) {
    const c = t[i++]
    if (c === 'M' || c === 'L') out.push({ x: Number(t[i++]), y: Number(t[i++]) })
  }
  return out
}
/** Every number in a path string (commands dropped) — for arcs and curves too. */
const nums = (d: string) => d.trim().split(/[\s,]+/).filter(s => !/^[A-Za-z]$/.test(s)).map(Number)

describe('naturalExtent / refitFactor', () => {
  it('measure the larger side of the outline; empty is 0 / 1', () => {
    expect(naturalExtent(tri())).toBe(60)
    expect(naturalExtent(undefined)).toBe(0)
    expect(naturalExtent(empty())).toBe(0)
    expect(refitFactor(tri(), 120)).toBe(2)
    expect(refitFactor(undefined, 120)).toBe(1)
    expect(refitFactor(empty(), 120)).toBe(1)
  })
  it('measure a circle by its ink, like drawnPath does', () => {
    const d = empty()
    addCircle(d, addPoint(d, 30, 40), 10)
    expect(naturalExtent(d)).toBeCloseTo(20, 6)
  })
})

describe('the view agrees with the renderer', () => {
  it('(a) drawnPath puts each drawing vertex at k·(vertex − centre)', () => {
    const size = 150
    const k = refitFactor(tri(), size)
    const b = sketchOutlineBounds(tri())!
    const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
    const pts = mlPoints(drawnPath(tri(), size))   // closed: the last segment returns to the first vertex
    expect(pts.length).toBeGreaterThanOrEqual(3)
    pts.forEach((p, i) => {
      const v = VERTS[i % VERTS.length]!
      expect(p.x).toBeCloseTo(k * (v.x - c.x), 4)
      expect(p.y).toBeCloseTo(k * (v.y - c.y), 4)
    })
  })

  it('(b) shapePenView maps a drawing vertex to the CSS px the preview paints it at', () => {
    const size = 150
    const k = refitFactor(tri(), size)
    const b = sketchOutlineBounds(tri())!
    const centre = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
    const frame = { cx: 5, cy: -3, scale: 2.5, cssW: 400, cssH: 300 }
    const offset = { x: 12, y: -7, scale: 1.5, rotate: 30 }
    const view = shapePenView(frame, offset, k, centre)
    const marks = mlPoints(drawnPath(tri(), size))   // the renderer's own mark points
    const rad = (30 * Math.PI) / 180
    VERTS.forEach((v, i) => {
      const m = marks[i]!
      // Facts: doc = offset.xy + R(rotate)·(offset.scale·m); CSS = (W/2, H/2) + scale·(doc − (cx, cy))
      const sx = 1.5 * m.x, sy = 1.5 * m.y
      const doc = { x: 12 + sx * Math.cos(rad) - sy * Math.sin(rad), y: -7 + sx * Math.sin(rad) + sy * Math.cos(rad) }
      // …and the rotate unit and sign are the ones applyLayerOffset really uses:
      const viaRender = transformCommands([{ command: 'moveTo', args: [m.x, m.y] }],
        { x: 12, y: -7, scale: 1.5, rotate: 30, flipY: false })[0]!.args
      expect(viaRender[0]).toBeCloseTo(doc.x, 9)
      expect(viaRender[1]).toBeCloseTo(doc.y, 9)
      const css = { x: 200 + 2.5 * (doc.x - 5), y: 150 + 2.5 * (doc.y + 3) }
      const got = applyView(view, v)
      expect(got.x).toBeCloseTo(css.x, 3)
      expect(got.y).toBeCloseTo(css.y, 3)
    })
  })
})

describe('commitDrawn', () => {
  it('(c) re-centres the drawing and sizes it so nothing jumps', () => {
    const src = tri()
    const before = JSON.stringify(src)
    const k = 1.7
    const out = commitDrawn(src, k)!
    expect(JSON.stringify(src)).toBe(before)                // input untouched
    const b = sketchOutlineBounds(out.sketch)!
    expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 9)
    expect((b.minY + b.maxY) / 2).toBeCloseTo(0, 9)
    expect(out.size).toBeCloseTo(k * naturalExtent(src), 9)
    expect(refitFactor(out.sketch, out.size)).toBeCloseTo(k, 9)
    const a = nums(drawnPath(out.sketch, out.size))
    const e = nums(drawnPath(src, k * naturalExtent(src)))
    expect(a.length).toBe(e.length)
    a.forEach((v, i) => expect(v).toBeCloseTo(e[i]!, 4))
  })
  it('keeps arcs in place too (circle centre point moves, radius does not)', () => {
    const d = empty()
    addCircle(d, addPoint(d, 30, 40), 10)
    const out = commitDrawn(d, 3)!
    expect(out.size).toBeCloseTo(60, 6)
    expect(drawnPath(out.sketch, out.size)).toBe(drawnPath(d, 60))
  })
  it('is null for an empty or missing drawing', () => {
    expect(commitDrawn(empty(), 2)).toBeNull()
  })
})

describe('frozenPreviewFrame', () => {
  const inside = (f: ReturnType<typeof frozenPreviewFrame>, x: number, y: number, pad: number) => {
    const px = f.cssW / 2 + f.scale * (x - f.cx), py = f.cssH / 2 + f.scale * (y - f.cy)
    expect(px).toBeGreaterThanOrEqual(pad - 1e-9)
    expect(px).toBeLessThanOrEqual(f.cssW - pad + 1e-9)
    expect(py).toBeGreaterThanOrEqual(pad - 1e-9)
    expect(py).toBeLessThanOrEqual(f.cssH - pad + 1e-9)
    return { px, py }
  }
  it('(d) contains the content bounds and the size square around the origin, with the padding', () => {
    const cb = { minX: -50, minY: -20, w: 200, h: 60 }
    const origin = { x: 30, y: 10 }
    const f = frozenPreviewFrame(cb, origin, 120, 400, 300, 16)
    expect(f.cssW).toBe(400); expect(f.cssH).toBe(300)
    for (const [x, y] of [[-50, -20], [150, -20], [-50, 40], [150, 40], [-30, -50], [90, -50], [-30, 70], [90, 70]] as const) inside(f, x, y, 16)
    // union is 200 × 120 → the tight axis is x: (400 − 32) / 200
    expect(f.scale).toBeCloseTo(368 / 200, 9)
    expect(f.cx).toBeCloseTo(50, 9); expect(f.cy).toBeCloseTo(10, 9)
  })
  it('frames the square alone when there is no content yet', () => {
    const f = frozenPreviewFrame(null, { x: 4, y: -2 }, 100, 300, 300, 10)
    expect(f.cx).toBe(4); expect(f.cy).toBe(-2)
    expect(f.scale).toBeCloseTo(280 / 100, 9)
  })
  it('never divides by zero', () => {
    const f = frozenPreviewFrame(null, { x: 0, y: 0 }, 0, 300, 200, 10)
    expect(Number.isFinite(f.scale) && f.scale > 0).toBe(true)
  })
})

describe('drawToCanvas fixed frame + alpha', () => {
  const realPath2D = (globalThis as any).Path2D
  afterEach(() => { (globalThis as any).Path2D = realPath2D })
  const record = () => {
    ;(globalThis as any).Path2D = class { d: string; constructor(d?: string) { this.d = d ?? '' } addPath() {} }
    const log: any[] = []
    const ctx: any = new Proxy({}, {
      get(_t, k) { return (...a: any[]) => { log.push([k, ...a.map(x => (x && x.d !== undefined) ? `path:${x.d}` : x)]) } },
      set(_t, k, v) { log.push(['set', k, v]); return true },
    })
    return { ctx, log }
  }
  const SHAPES: any = [
    { commands: [{ command: 'moveTo', args: [-10, -5] }, { command: 'lineTo', args: [30, -5] }, { command: 'lineTo', args: [10, 25] }, { command: 'closePath', args: [] }], fill: '#123456', fillRule: 'evenodd' },
    { commands: [{ command: 'moveTo', args: [0, 0] }, { command: 'lineTo', args: [5, 40] }], stroke: '#ff0000', strokeWidth: 3 },
  ]
  // Recorded from drawToCanvas at 5b6b664e4, before `opts` existed.
  const RECORDED = [['clearRect', 0, 0, 400, 300], ['set', 'fillStyle', '#eeeeee'], ['fillRect', 0, 0, 400, 300], ['save'], ['translate', 200, 150], ['scale', 4.3478260869565215, 4.3478260869565215], ['translate', -10, -17.5], ['set', 'fillStyle', '#123456'], ['fill', 'path:M-10 -5L30 -5L10 25Z', 'evenodd'], ['set', 'lineWidth', 3], ['set', 'strokeStyle', '#ff0000'], ['stroke', 'path:M0 0L5 40'], ['restore']]

  it('(e) with no opts issues exactly the recorded call sequence', () => {
    const { ctx, log } = record()
    drawToCanvas(SHAPES, ctx, 400, 300, 12, '#eeeeee')
    expect(log).toEqual(RECORDED)
    const r2 = record()
    drawToCanvas(SHAPES, r2.ctx, 400, 300, 12, '#eeeeee', {})
    expect(r2.log).toEqual(RECORDED)
  })
  it('with a frame uses its centre and scale instead of fitting', () => {
    const { ctx, log } = record()
    drawToCanvas(SHAPES, ctx, 400, 300, 12, '#eeeeee', { frame: { cx: 7, cy: -4, scale: 3 } })
    expect(log.slice(0, 7)).toEqual([...RECORDED.slice(0, 4), ['translate', 200, 150], ['scale', 3, 3], ['translate', -7, 4]])
    expect(log.slice(7)).toEqual(RECORDED.slice(7))
  })
  it('with alpha fades the shapes but not the background', () => {
    const { ctx, log } = record()
    drawToCanvas(SHAPES, ctx, 400, 300, 12, '#eeeeee', { alpha: 0.3 })
    const iBg = log.findIndex(c => c[0] === 'fillRect')
    const iAlpha = log.findIndex(c => c[0] === 'set' && c[1] === 'globalAlpha')
    const iSave = log.findIndex(c => c[0] === 'save')
    expect(log[iAlpha]).toEqual(['set', 'globalAlpha', 0.3])
    expect(iAlpha).toBeGreaterThan(iBg)
    expect(iAlpha).toBeGreaterThan(iSave)                   // restored with the transform
    expect(log.filter(c => !(c[0] === 'set' && c[1] === 'globalAlpha'))).toEqual(RECORDED)
  })
})
