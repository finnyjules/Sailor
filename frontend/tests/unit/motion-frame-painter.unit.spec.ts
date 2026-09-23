import { describe, it, expect, vi } from 'vitest'
import { prepareMotionFramePainter } from '../../app/lib/motion/bake'

const motion = { fps: 25, duration: 0.2 } as any   // 5 frames

function fakeCtx(w: number, h: number) {
  const calls: string[] = []
  return {
    calls,
    ctx: {
      canvas: { width: w, height: h },
      setTransform: () => calls.push('reset'),
      clearRect: () => calls.push('clear'),
    } as any,
  }
}

describe('prepareMotionFramePainter', () => {
  it('counts frames from duration × fps and times them i / fps', async () => {
    const p = await prepareMotionFramePainter(() => [], [], 100, 50, motion, undefined, { paint: vi.fn(), ensure: async () => {} })
    expect(p.total).toBe(5)
    expect([0, 1, 4].map(i => p.time(i))).toEqual([0, 0.04, 0.16])
  })

  it('paints each frame at its own time, after the caller-supplied pull, on a cleared canvas', async () => {
    const order: string[] = []
    const paint = vi.fn((_ctx, w, h, _items, _layers, _a, t, _m, _b, _c, _d, _e, bake) => order.push(`paint ${t} ${w}x${h} bake=${bake}`))
    const p = await prepareMotionFramePainter(() => [], [], 100, 50, motion, async t => { order.push(`pull ${t}`) }, { paint, ensure: async () => {} })
    const { ctx, calls } = fakeCtx(100, 50)
    await p.paint(2, ctx)
    expect(order).toEqual(['pull 0.08', 'paint 0.08 100x50 bake=true'])
    expect(calls).toEqual(['reset', 'clear'])
  })

  it('snapshots the stack ONCE: later edits do not leak into later frames', async () => {
    let n = 0
    const build = vi.fn(() => [{ id: `item-${++n}` }] as any)
    const seen: string[] = []
    const paint = vi.fn((_ctx, _w, _h, items) => seen.push(items[0].id))
    const p = await prepareMotionFramePainter(build, [], 10, 10, motion, undefined, { paint, ensure: async () => {} })
    const { ctx } = fakeCtx(10, 10)
    await p.paint(0, ctx); await p.paint(1, ctx)
    expect(build).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['item-1', 'item-1'])
  })
})
