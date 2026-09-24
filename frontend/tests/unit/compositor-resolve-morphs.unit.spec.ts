/**
 * Frame Morph — `resolveMorphs` (useCompositorLayers.ts), the painter step that swaps a layer
 * carrying a transient `motionMorph` for the path clone that turns it into its target (final
 * review #2, #6). The cache is observed through `morphCacheSize()` rather than a spy on
 * `prepareMorph`: the composable imports it as an ES binding a spy cannot reach, and the cache
 * size is exactly the thing that matters — one entry per ANALYSIS (~100–300 ms), so a frame that
 * did not add one did not re-analyse.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createImageLayer, createPathLayer, createPolygonLayer, createRectLayer, resolveMorphs,
  type LocalLayer, type StackItem,
} from '~/composables/useCompositorLayers'
import { clearMorphCache, morphCacheSize } from '~/lib/vector/morphPieces'
import { ringsBBoxOfD } from '~/lib/compositor/morphDraw'
import { polygonPathData } from '~/lib/compositor/polygonGeometry'

const W = 1000
const noSibling = () => null
const itemsOf = (layers: LocalLayer[]): StackItem[] => layers.map(l => ({ type: 'local', key: `l:${l.id}`, layer: l }))
const morphing = (l: LocalLayer, target: LocalLayer, amount: number, style: 'letters' | 'shape' = 'shape') =>
  ({ ...l, motionMorph: { target: `l:${target.id}`, style, amount } }) as unknown as LocalLayer
const run = (layers: LocalLayer[]) => resolveMorphs(itemsOf(layers), layers, W, noSibling)
/** The clone's drawn size in canvas px: `drawPath` scales its `d` by `scale·W`. */
const drawnPx = (clone: LocalLayer) => {
  const c = clone as unknown as { d: string; scale: number }
  const b = ringsBBoxOfD(c.d)
  return { w: b.w * c.scale * W, h: b.h * c.scale * W }
}

const SQUARE = 'M-0.05 -0.05L0.05 -0.05L0.05 0.05L-0.05 0.05Z' // path-local units (1 = W)
const STAR_ISH = 'M0 -0.1L0.03 -0.03L0.1 0L0.03 0.03L0 0.1L-0.03 0.03L-0.1 0L-0.03 -0.03Z'

beforeEach(() => clearMorphCache())

describe('resolveMorphs', () => {
  it('an idle stack comes back as the same references', () => {
    const a = createRectLayer({}), b = createRectLayer({})
    const items = itemsOf([a, b]), layers = [a, b]
    const out = resolveMorphs(items, layers, W, noSibling)
    expect(out.items).toBe(items)
    expect(out.localLayers).toBe(layers)
  })

  it('swaps the morphing layer for a path clone, in the items and the layer list', () => {
    const a = createRectLayer({ id: 'A', w: 0.2, h: 0.1 } as never)
    const b = createPathLayer({ id: 'B', d: STAR_ISH, x: 0.7, y: 0.3 })
    const out = run([morphing(a, b, 0.5), b])
    const clone = out.localLayers[0]! as unknown as Record<string, unknown>
    expect(clone.kind).toBe('path')
    expect(clone.id).toBe('A')
    expect(clone.motionMorph).toBeUndefined()
    expect(typeof clone.d).toBe('string')
    expect((clone.d as string).length).toBeGreaterThan(0)
    expect((out.items[0] as { layer: LocalLayer }).layer).toBe(out.localLayers[0])
    expect(out.localLayers[1]).toBe(b)
    expect(clone.x).toBeCloseTo(0.6) // placement interpolated
  })

  it('moving A, turning it, or changing a path\'s scale does NOT re-analyse the morph', () => {
    const a = createPathLayer({ id: 'A', d: SQUARE, scale: 1 })
    const b = createPathLayer({ id: 'B', d: STAR_ISH, scale: 1.5, x: 0.2 })
    run([morphing(a, b, 0.3), b])
    expect(morphCacheSize()).toBe(1)
    run([morphing({ ...a, x: 0.8, rotation: 40 } as LocalLayer, b, 0.4), b])
    run([morphing({ ...a, scale: 2.3 } as LocalLayer, { ...b, scale: 0.7 } as LocalLayer, 0.5), { ...b, scale: 0.7 } as LocalLayer])
    // A Pulse on a rect is a transient motionScale — also size, not shape.
    const r = createRectLayer({ id: 'R', w: 0.1, h: 0.1 } as never)
    run([morphing(r, b, 0.3), b])
    expect(morphCacheSize()).toBe(2)
    run([morphing({ ...r, motionScale: 1.4 } as unknown as LocalLayer, b, 0.6), b])
    expect(morphCacheSize()).toBe(2)
  })

  describe('drawn size matches each side at the ends (drawPath scales d by scale·W)', () => {
    const near = (got: { w: number; h: number }, want: { w: number; h: number }) => {
      expect(got.w).toBeCloseTo(want.w, 0)
      expect(got.h).toBeCloseTo(want.h, 0)
    }
    it('a path at its own scale, into a path at another scale with a Pulse size on top', () => {
      const a = createPathLayer({ id: 'A', d: SQUARE, scale: 2 })
      const b = { ...createPathLayer({ id: 'B', d: STAR_ISH, scale: 0.5 }), motionScale: 1.2 } as unknown as LocalLayer
      const at0 = run([morphing(a, b, 0), b]).localLayers[0]!
      near(drawnPx(at0), { w: 0.1 * 2 * W, h: 0.1 * 2 * W })
      expect((at0 as { motionScale?: number }).motionScale).toBeUndefined()
      // B's own path scale AND its transient motionScale both apply at amount 1.
      near(drawnPx(run([morphing(a, b, 1), b]).localLayers[0]!), { w: 0.2 * 0.5 * 1.2 * W, h: 0.2 * 0.5 * 1.2 * W })
    })
    it('a polygon (drawn at W) with a motionScale, into a rect (px)', () => {
      const pg = { ...createPolygonLayer({ id: 'P', w: 0.2, h: 0.2 }), motionScale: 1.5 } as unknown as LocalLayer
      const box = ringsBBoxOfD(polygonPathData((pg as unknown as { sides: number }).sides, 0.2, 0.2, (pg as unknown as { cornerRadius: number }).cornerRadius))
      const rect = createRectLayer({ id: 'R', w: 0.3, h: 0.1 } as never)
      near(drawnPx(run([morphing(pg, rect, 0), rect]).localLayers[0]!), { w: box.w * W * 1.5, h: box.h * W * 1.5 })
      near(drawnPx(run([morphing(pg, rect, 1), rect]).localLayers[0]!), { w: 0.3 * W, h: 0.1 * W })
    })
    it('a rect with a Pulse size, at amount 0', () => {
      const r = { ...createRectLayer({ id: 'R', w: 0.3, h: 0.1 } as never), motionScale: 0.8 } as unknown as LocalLayer
      const b = createPathLayer({ id: 'B', d: STAR_ISH })
      near(drawnPx(run([morphing(r, b, 0), b]).localLayers[0]!), { w: 0.3 * W * 0.8, h: 0.1 * W * 0.8 })
    })
  })

  it('a target that cannot take geometry gives the cross-fade', () => {
    const a = createRectLayer({ id: 'A', opacity: 0.8 } as never)
    const photo = { ...createImageLayer('p.png', 1, { id: 'I', opacity: 0.5 } as never), motionHidden: true } as unknown as LocalLayer
    const out = run([morphing(a, photo, 0.25), photo])
    const [fa, fb] = out.localLayers as unknown as Array<Record<string, unknown>>
    expect(fa!.kind).toBe('rect')
    expect(fa!.motionMorph).toBeUndefined()
    expect(fa!.opacity).toBeCloseTo(0.8 * 0.75)
    expect(fb!.kind).toBe('image')
    expect(fb!.motionHidden).toBeUndefined()
    expect(fb!.opacity).toBeCloseTo(0.5 * 0.25)
    expect(morphCacheSize()).toBe(0)
  })
})

// USER 09-24: "it doesn't look like cascade is applying" — a Cascade in under a Morph into.
describe('resolveMorphs: letter behaviours ride the morph', () => {
  const cascade = { id: 'c', layerId: 'A', kind: 'text.cascade', timing: { start: 0, duration: 1 }, params: { dir: 'in', style: 'rise', stagger: 0.5 } }
  const cellsAtPx = () => [-100, 100].map(x => ({ char: 'A', x, y: 0, w: 40, h: 40, angle: 0, word: 0, line: 0 }))
  const withCascade = (l: LocalLayer, t: number) => ({ ...l, textMotion: { behaviours: [cascade], t } }) as unknown as LocalLayer

  it('mid-cascade, the clone carries its letters as pieces and a later letter is not yet shown', () => {
    const a = createPathLayer({ id: 'A', d: 'M-0.12 -0.02L-0.08 -0.02L-0.08 0.02L-0.12 0.02ZM0.08 -0.02L0.12 -0.02L0.12 0.02L0.08 0.02Z' })
    const b = createPathLayer({ id: 'B', d: 'M-0.13 -0.03L-0.07 -0.03L-0.07 0.03L-0.13 0.03ZM0.07 -0.03L0.13 -0.03L0.13 0.03L0.07 0.03Z' })
    const layers = [withCascade(morphing(a, b, 0.1, 'letters'), 0.1), b]
    const out = resolveMorphs(itemsOf(layers), layers, W, noSibling, () => cellsAtPx())
    const clone = out.localLayers[0] as unknown as { motionPieces?: { d: string; opacity: number }[]; textMotion?: unknown }
    expect(clone.textMotion).toBeUndefined()
    expect(clone.motionPieces).toBeDefined()
    // Only the first letter has started at t = 0.1 (letters start one after another).
    const shown = clone.motionPieces!.filter(p => p.opacity > 0)
    const xs = shown.flatMap(p => [...p.d.matchAll(/(-?\d+\.?\d*) (-?\d+\.?\d*)/g)].map(m => Number(m[1])))
    expect(Math.max(...xs)).toBeLessThan(0)
  })

  it('with the cascade at rest, no pieces — the plain morph path, unchanged', () => {
    const a = createPathLayer({ id: 'A', d: SQUARE }), b = createPathLayer({ id: 'B', d: STAR_ISH })
    const layers = [withCascade(morphing(a, b, 0.5, 'letters'), 5), b]
    const out = resolveMorphs(itemsOf(layers), layers, W, noSibling, () => cellsAtPx())
    expect((out.localLayers[0] as unknown as { motionPieces?: unknown }).motionPieces).toBeUndefined()
  })
})
