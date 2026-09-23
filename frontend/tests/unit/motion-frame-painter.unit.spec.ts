import { describe, it, expect, vi } from 'vitest'
import { prepareMotionFramePainter } from '../../app/lib/motion/bake'

const motion = { fps: 25, duration: 0.2 } as any   // 5 frames

function fakeCtx(w: number, h: number) {
  const calls: string[] = []
  const clears: number[][] = []
  return {
    calls,
    clears,
    ctx: {
      canvas: { width: w, height: h },
      setTransform: () => calls.push('reset'),
      clearRect: (x: number, y: number, cw: number, ch: number) => { calls.push('clear'); clears.push([x, y, cw, ch]) },
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

  it('paints at the Frame size, not the (possibly larger, rounded-up) canvas size, but clears the whole canvas', async () => {
    const order: string[] = []
    const paint = vi.fn((_ctx, w, h) => order.push(`paint ${w}x${h}`))
    const p = await prepareMotionFramePainter(() => [], [], 101, 51, motion, undefined, { paint, ensure: async () => {} })
    const { ctx, calls, clears } = fakeCtx(102, 52)
    await p.paint(0, ctx)
    expect(order).toEqual(['paint 101x51'])
    expect(calls).toEqual(['reset', 'clear'])
    expect(clears).toEqual([[0, 0, 102, 52]])
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

  it('hands the Frame\'s treatments, background, groups and post effects to the painter when given', async () => {
    const doc = {
      treatments: { 'wired-1': { maskedByKey: 'local-2', showSource: false } },
      background: '#ff0000',
      groups: [{ id: 'g1' }] as any,
      post: [{ kind: 'grain' }] as any,
    }
    const paint = vi.fn()
    const p = await prepareMotionFramePainter(() => [], [], 10, 10, motion, undefined, { paint, ensure: async () => {} }, doc)
    await p.paint(0, fakeCtx(10, 10).ctx)
    const args = paint.mock.calls[0]!
    expect(args.slice(8, 12)).toEqual([doc.treatments, doc.background, doc.groups, doc.post])
    expect(args[8]).toBe(doc.treatments)
    expect(args[9]).toBe(doc.background)
    expect(args[10]).toBe(doc.groups)
    expect(args[11]).toBe(doc.post)
    expect(args[12]).toBe(true)
  })

  it('paints layers only (no doc-level parts) when no doc is given', async () => {
    const paint = vi.fn()
    const p = await prepareMotionFramePainter(() => [], [], 10, 10, motion, undefined, { paint, ensure: async () => {} })
    await p.paint(0, fakeCtx(10, 10).ctx)
    const args = paint.mock.calls[0]!
    expect(args.slice(8, 12)).toEqual([undefined, undefined, undefined, undefined])
    expect(args[12]).toBe(true)
  })
})
