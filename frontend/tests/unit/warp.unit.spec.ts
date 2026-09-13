import { describe, it, expect } from 'vitest'
import { squareToQuad, applyHomography, drawMeshWarp, drawQuadWarp, type Quad, type Pt } from '~/lib/compositor/warp'

const at = (q: Quad, u: number, v: number) => applyHomography(squareToQuad(q), u, v)

/** A minimal recording 2D context: captures the affine `transform` in force at each
 *  `drawImage`, which is exactly the source-uv → dest-xy map `drawTri` solved for that
 *  triangle. Enough to prove `drawMeshWarp` maps a known cell correctly without a rasterizer. */
function recordingCtx() {
  const draws: { m: number[] }[] = []
  let cur = [1, 0, 0, 1, 0, 0]
  const stack: number[][] = []
  const mul = (a: number[], b: number[]) => [
    a[0]! * b[0]! + a[2]! * b[1]!,
    a[1]! * b[0]! + a[3]! * b[1]!,
    a[0]! * b[2]! + a[2]! * b[3]!,
    a[1]! * b[2]! + a[3]! * b[3]!,
    a[0]! * b[4]! + a[2]! * b[5]! + a[4]!,
    a[1]! * b[4]! + a[3]! * b[5]! + a[5]!,
  ]
  const ctx = {
    save() { stack.push(cur.slice()) },
    restore() { cur = stack.pop() ?? [1, 0, 0, 1, 0, 0] },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, clip() {},
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { cur = [a, b, c, d, e, f] },
    transform(a: number, b: number, c: number, d: number, e: number, f: number) { cur = mul(cur, [a, b, c, d, e, f]) },
    drawImage() { draws.push({ m: cur.slice() }) },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, draws }
}

const src = { width: 100, height: 80 } as unknown as HTMLCanvasElement

/** Build an (N+1)×(N+1) grid whose node (i,j) is `f` of the SOURCE pixel point. */
function grid(N: number, f: (sx: number, sy: number) => Pt): Pt[][] {
  const g: Pt[][] = []
  for (let j = 0; j <= N; j++) {
    const row: Pt[] = []
    for (let i = 0; i <= N; i++) row.push(f((i / N) * 100, (j / N) * 80))
    g.push(row)
  }
  return g
}

describe('squareToQuad + applyHomography', () => {
  it('identity quad maps (u,v) → (u,v)', () => {
    const q: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1], [0.3, 0.7], [0.5, 0.5]]) {
      const p = at(q, u!, v!)
      expect(p.x).toBeCloseTo(u!, 6)
      expect(p.y).toBeCloseTo(v!, 6)
    }
  })

  it('the 4 corners map exactly onto the quad (affine rect)', () => {
    const q: Quad = [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 70 }, { x: 10, y: 70 }]
    expect(at(q, 0, 0)).toMatchObject({ x: expect.closeTo(10), y: expect.closeTo(20) })
    expect(at(q, 1, 0)).toMatchObject({ x: expect.closeTo(110), y: expect.closeTo(20) })
    expect(at(q, 1, 1)).toMatchObject({ x: expect.closeTo(110), y: expect.closeTo(70) })
    expect(at(q, 0, 1)).toMatchObject({ x: expect.closeTo(10), y: expect.closeTo(70) })
    // affine rect → centre is the geometric centre
    const c = at(q, 0.5, 0.5)
    expect(c.x).toBeCloseTo(60); expect(c.y).toBeCloseTo(45)
  })

  it('a trapezoid is a real PROJECTIVE map (corners exact, centre foreshortened)', () => {
    // top edge narrow [20..80] at y=0, bottom edge wide [0..100] at y=100
    const q: Quad = [{ x: 20, y: 0 }, { x: 80, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]
    expect(at(q, 0, 0)).toMatchObject({ x: expect.closeTo(20), y: expect.closeTo(0) })
    expect(at(q, 1, 0)).toMatchObject({ x: expect.closeTo(80), y: expect.closeTo(0) })
    expect(at(q, 1, 1)).toMatchObject({ x: expect.closeTo(100), y: expect.closeTo(100) })
    expect(at(q, 0, 1)).toMatchObject({ x: expect.closeTo(0), y: expect.closeTo(100) })
    const c = at(q, 0.5, 0.5)
    expect(c.x).toBeCloseTo(50, 4)               // symmetric → x stays centred
    expect(Math.abs(c.y - 50)).toBeGreaterThan(1) // ≠ 50 ⇒ projective foreshortening, not affine
    expect(c.y).toBeGreaterThan(0)
    expect(c.y).toBeLessThan(100)
  })
})

describe('drawMeshWarp (the shared triangle-mesh drawer, F3 4b)', () => {
  it('emits two textured triangles per cell (2·N²)', () => {
    const { ctx, draws } = recordingCtx()
    const N = 4
    drawMeshWarp(ctx, src, grid(N, (sx, sy) => ({ x: sx, y: sy })), N)
    expect(draws.length).toBe(2 * N * N)
  })

  it('an identity grid maps every source cell to itself (transform ≈ identity)', () => {
    const { ctx, draws } = recordingCtx()
    const N = 3
    drawMeshWarp(ctx, src, grid(N, (sx, sy) => ({ x: sx, y: sy })), N)
    for (const d of draws) {
      expect(d.m[0]).toBeCloseTo(1, 6); expect(d.m[1]).toBeCloseTo(0, 6)
      expect(d.m[2]).toBeCloseTo(0, 6); expect(d.m[3]).toBeCloseTo(1, 6)
      expect(d.m[4]).toBeCloseTo(0, 6); expect(d.m[5]).toBeCloseTo(0, 6)
    }
  })

  it('a uniformly scaled grid scales each cell by the same factor', () => {
    const { ctx, draws } = recordingCtx()
    const N = 2
    drawMeshWarp(ctx, src, grid(N, (sx, sy) => ({ x: sx * 2, y: sy * 2 })), N)
    for (const d of draws) {
      expect(d.m[0]).toBeCloseTo(2, 6); expect(d.m[3]).toBeCloseTo(2, 6)
      expect(d.m[1]).toBeCloseTo(0, 6); expect(d.m[2]).toBeCloseTo(0, 6)
      // dst = 2·src, sampled from the origin ⇒ no net translation.
      expect(d.m[4]).toBeCloseTo(0, 6); expect(d.m[5]).toBeCloseTo(0, 6)
    }
  })

  it('a translated grid maps a known cell with the exact offset', () => {
    const { ctx, draws } = recordingCtx()
    const N = 2
    drawMeshWarp(ctx, src, grid(N, (sx, sy) => ({ x: sx + 10, y: sy + 5 })), N)
    for (const d of draws) {
      expect(d.m[0]).toBeCloseTo(1, 6); expect(d.m[3]).toBeCloseTo(1, 6)
      expect(d.m[4]).toBeCloseTo(10, 6); expect(d.m[5]).toBeCloseTo(5, 6)
    }
  })

  it('no-ops on a zero-area source and on a short grid', () => {
    const { ctx: c1, draws: d1 } = recordingCtx()
    drawMeshWarp(c1, { width: 0, height: 0 } as unknown as HTMLCanvasElement, grid(2, (x, y) => ({ x, y })), 2)
    expect(d1.length).toBe(0)
    const { ctx: c2, draws: d2 } = recordingCtx()
    drawMeshWarp(c2, src, [[{ x: 0, y: 0 }]], 4) // grid too small for N
    expect(d2.length).toBe(0)
  })

  it('drawQuadWarp (corner-pin) still routes through the shared drawer — identity quad is identity', () => {
    const { ctx, draws } = recordingCtx()
    // A quad that maps the unit square onto the source pixel rect ⇒ each cell draws at its
    // own source position (identity), proving drawQuadWarp delegates to the same mesh drawer.
    const q: Quad = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }]
    drawQuadWarp(ctx, src, q, 2)
    expect(draws.length).toBe(2 * 2 * 2)
    for (const d of draws) {
      expect(d.m[0]).toBeCloseTo(1, 4); expect(d.m[3]).toBeCloseTo(1, 4)
      expect(d.m[4]).toBeCloseTo(0, 4); expect(d.m[5]).toBeCloseTo(0, 4)
    }
  })
})
