import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  strokeDashSegments, strokeAlignOf, strokeAligned, strokeReachPx, cornerPinPadPx, silhouettePadPx, paintLayerStack,
  createRectLayer, createLineLayer, createPathLayer, createTextLayer,
  type LocalLayer, type RectLayer, type LineLayer, type CornerPin,
} from '~/composables/useCompositorLayers'
import {
  type Recorder,
  inkAt, makeCtx, allOps, installScratchDocument,
} from './_strokeCtx'

// The corner-pin path hands `drawQuadWarp` the QUAD it warps the layer's offscreen onto.
// That quad is derived from the SAME `pad` that sizes the offscreen, so a pad change moves
// the warp of every saved corner-pinned frame — a regression the `sizes` assertions below
// are structurally blind to. Replacing the real warp with a recorder is the only way to see
// the quad the production call site actually built.
const warpRec = vi.hoisted(() => ({ quads: [] as { x: number; y: number }[][] }))
vi.mock('~/lib/compositor/warp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/compositor/warp')>()
  return {
    ...actual,
    drawQuadWarp: (_ctx: unknown, _src: unknown, quad: { x: number; y: number }[]) => {
      warpRec.quads.push(quad.map(p => ({ x: p.x, y: p.y })))
    },
  }
})

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('strokeDashSegments', () => {
  it('is null (solid) for an absent or malformed dash', () => {
    expect(strokeDashSegments(undefined)).toBeNull()
    expect(strokeDashSegments(null)).toBeNull()
    expect(strokeDashSegments({ dash: 0, gap: 0.02 })).toBeNull()
    expect(strokeDashSegments({ dash: -1, gap: 0.02 })).toBeNull()
    expect(strokeDashSegments({ dash: NaN, gap: 0.02 })).toBeNull()
    expect(strokeDashSegments({ dash: 'x', gap: 1 } as any)).toBeNull()
  })

  it('scales both segments by the caller unit (width-normalized storage)', () => {
    expect(strokeDashSegments({ dash: 0.02, gap: 0.01 }, 100)).toEqual([2, 1])
    expect(strokeDashSegments({ dash: 0.02, gap: 0.01 })).toEqual([0.02, 0.01])
  })

  it('clamps a bad gap to zero rather than dropping the dash', () => {
    expect(strokeDashSegments({ dash: 0.02, gap: -5 }, 100)).toEqual([2, 0])
    expect(strokeDashSegments({ dash: 0.02, gap: NaN }, 100)).toEqual([2, 0])
  })
})

describe('strokeAlignOf', () => {
  it('passes the two real alignments through', () => {
    expect(strokeAlignOf('inside')).toBe('inside')
    expect(strokeAlignOf('outside')).toBe('outside')
  })
  it('falls back to center for absent or unrecognized values', () => {
    expect(strokeAlignOf(undefined)).toBe('center')
    expect(strokeAlignOf('center')).toBe('center')
    expect(strokeAlignOf('middle')).toBe('center')
  })
})

// An outside-aligned stroke paints entirely beyond localLayerBox's plain w×h (see
// the box's own "no stroke padding" comment) — the corner-pin offscreen has to be
// padded by exactly this much, and only in this one case, or it clips the stroke
// away (center/inside) or shrinks a byte-identical no-stroke box (everything else).
describe('strokeReachPx / cornerPinPadPx', () => {
  it('is 0 for a rect with no stroke at all', () => {
    const l = createRectLayer({ stroke: '', strokeWidth: 0.1, strokeAlign: 'outside' })
    expect(cornerPinPadPx(l, 200)).toBe(0)
  })

  it('is 0 for a rect with a zero-width stroke', () => {
    const l = createRectLayer({ stroke: '#fff', strokeWidth: 0, strokeAlign: 'outside' })
    expect(cornerPinPadPx(l, 200)).toBe(0)
  })

  // A centred stroke AT DISTANCE 0 stays 0 — not because its ink is inside the box (half
  // of it is not), but because this pad also scales the corner-pin quad, so any value here
  // re-warps every saved centred-stroke frame. See cornerPinPadPx's doc comment and
  // the quad tests at the bottom of this file.
  it('is 0 for a centre- or inside-aligned stroke sitting on the edge', () => {
    const center = createRectLayer({ stroke: '#fff', strokeWidth: 0.1, strokeAlign: 'center' })
    const inside = createRectLayer({ stroke: '#fff', strokeWidth: 0.1, strokeAlign: 'inside' })
    const absent = createRectLayer({ stroke: '#fff', strokeWidth: 0.1 })
    expect(cornerPinPadPx(center, 200)).toBe(0)
    expect(cornerPinPadPx(inside, 200)).toBe(0)
    expect(cornerPinPadPx(absent, 200)).toBe(0)   // absent ⇒ 'center'
  })

  // The silhouette raster asks for the OTHER answer — it only needs to be big enough, and
  // must not shrink below what the pre-stack rule gave. Same helper, one explicit flag, so
  // the two callers can never drift apart on what the rest of a stack reaches.
  it('counts a centred edge stroke when the caller asks for the raster answer', () => {
    const center = createRectLayer({ stroke: '#fff', strokeWidth: 0.1, strokeAlign: 'center' })
    expect(strokeReachPx(center, 200)).toBe(10)   // 0.1 * 200 / 2
    expect(cornerPinPadPx(center, 200)).toBe(0)
  })

  // The exception is exactly and only distance 0: a stroke the stack pushed away from the
  // edge has no legacy counterpart, so padding for it cannot move any saved frame.
  it('DOES pad a centred stroke that a distance pushed off the edge', () => {
    const l = createRectLayer({ stroke: undefined, strokeWidth: undefined }) as unknown as Record<string, unknown>
    l.strokes = [{ id: 's1', paint: '#fff', width: 0.1, distance: 0.05, align: 'center' }]
    expect(cornerPinPadPx(l as unknown as LocalLayer, 200)).toBe(20)  // (0.05 + 0.05) * 200
  })

  // Task 3b item 4 (Minor, fix wave 1): a non-finite stored `distance` must read as 0,
  // exactly like the painter's own `strokeDistancePx` and `silhouettePadPx` already do —
  // this pad also SCALES the corner-pin quad (`hw = box.w/2 + pad`), so an unguarded
  // Infinity here would re-warp the quad to an infinite size, not just mis-size a raster.
  it('treats a non-finite stored distance as 0, not Infinity/NaN', () => {
    const inf = createRectLayer({ stroke: undefined, strokeWidth: undefined }) as unknown as Record<string, unknown>
    inf.strokes = [{ id: 's1', paint: '#fff', width: 0.1, distance: Infinity, align: 'center' }]
    expect(cornerPinPadPx(inf as unknown as LocalLayer, 200)).toBe(0)

    // A NaN distance with an outside-aligned stroke: the reach must fall back to the
    // width alone (0 + width), not silently drop the stroke's reach to 0 via a NaN
    // comparison that is always false.
    const nan = createRectLayer({ stroke: undefined, strokeWidth: undefined }) as unknown as Record<string, unknown>
    nan.strokes = [{ id: 's1', paint: '#fff', width: 0.1, distance: NaN, align: 'outside' }]
    expect(cornerPinPadPx(nan as unknown as LocalLayer, 200)).toBe(20)
  })

  it('is the full stroke width in px for an outside-aligned rect/ellipse/polygon/star', () => {
    // strokeWidth is normalized to canvas width for these kinds — 0.1 * 200 = 20px.
    const l = createRectLayer({ stroke: '#fff', strokeWidth: 0.1, strokeAlign: 'outside' })
    expect(cornerPinPadPx(l, 200)).toBe(20)
  })

  it('scales a path\'s pad by its own `scale`, not just canvas width', () => {
    // strokeWidth is LOCAL units at scale=1 for a path — the rendered ctx is
    // pre-scaled by (scale*W), so the outward px extent must fold scale in too.
    const l = createPathLayer({ stroke: '#fff', strokeWidth: 0.1, strokeAlign: 'outside', scale: 2 })
    expect(cornerPinPadPx(l, 200)).toBe(40) // 0.1 * 2 * 200
  })

  it('is 0 for a line — alignment does not apply (no interior)', () => {
    const l = createLineLayer({ stroke: '#fff', strokeWidth: 0.1 })
    expect(cornerPinPadPx(l, 200)).toBe(0)
  })
})

/**
 * A MARCHING-SHAPES STROKE'S REACH.
 *
 * Both pad helpers used to size every stroke from `st.width` and skip it on `!(st.width > 0)`.
 * A `style: 'shapes'` stroke is sized by `shapes.size` instead, and since Task 7 hid the width
 * row for one, the `width` such an entry carries is a stale leftover — usually 0 on a stroke
 * created as shapes, and usually WRONG on one switched over. So the marks were padded for the
 * wrong number, or the whole entry was skipped: clipped at the corner-pin / DOF offscreen edge
 * and cut by the torn-edge silhouette. Silently — a slightly wrong box, not an error.
 *
 * The numbers come from `shapeStrokeMarkMatrices`' own placement maths, not from a rule of
 * thumb: a mark is the library shape's ink box fitted into `size` (`min(size/bw, size/bh)`, so
 * the larger fitted side is exactly `size`) and CENTRED on the guide point. 'badge' has a
 * square 88×88 ink box, so its fitted mark is `size × size`: upright it reaches `size/2`,
 * following the tangent it turns about that centre and a corner swings to half the diagonal,
 * `size·√2/2`. 'beak' is 44×88, so its fitted mark is `size/2 × size` and the diagonal is
 * shorter — which is what makes these two shapes tell an exact answer apart from `size/2`.
 */
describe('strokeReachPx / cornerPinPadPx — a shapes stroke is sized by its marks', () => {
  const W = 200
  /** A rect carrying ONE shapes stroke. `width` is deliberately the stale leftover the
   *  inspector no longer shows — every expectation below must be blind to it. */
  const shapesRect = (spec: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    const l = createRectLayer({ stroke: undefined, strokeWidth: undefined }) as unknown as Record<string, unknown>
    l.strokes = [{ id: 's1', paint: '#fff', width: 0, distance: 0, style: 'shapes', shapes: spec, ...over }]
    return l as unknown as LocalLayer
  }

  it('reaches half a following mark\'s DIAGONAL, not half its size', () => {
    const l = shapesRect({ shapeId: 'badge', size: 0.2, spacing: 0.05 })
    // 0.2 · √2 / 2 · 200 — a square mark turned to the tangent, not 0.1 · 200.
    expect(cornerPinPadPx(l, W)).toBeCloseTo(0.2 * Math.SQRT2 / 2 * W, 6)
    expect(strokeReachPx(l, W)).toBeCloseTo(0.2 * Math.SQRT2 / 2 * W, 6)
  })

  it('reaches exactly half the size when the marks stay upright', () => {
    const l = shapesRect({ shapeId: 'badge', size: 0.2, spacing: 0.05, follow: false })
    expect(cornerPinPadPx(l, W)).toBeCloseTo(0.1 * W, 6)
  })

  it("follows the shape's own ink box — an oblong mark reaches less than a square one", () => {
    // 'beak' is 44 × 88: fitted to size 0.2 that is 0.1 × 0.2, half-diagonal √(0.01+0.04)/2.
    const l = shapesRect({ shapeId: 'beak', size: 0.2, spacing: 0.05 })
    expect(cornerPinPadPx(l, W)).toBeCloseTo(Math.hypot(0.1, 0.2) / 2 * W, 6)
    expect(cornerPinPadPx(l, W)).toBeLessThan(0.2 * Math.SQRT2 / 2 * W)
  })

  it('adds the distance the marks march at', () => {
    const l = shapesRect({ shapeId: 'badge', size: 0.2, spacing: 0.05, follow: false }, { distance: 0.05 })
    expect(cornerPinPadPx(l, W)).toBeCloseTo((0.05 + 0.1) * W, 6)
  })

  it('is NOT excused by the centre-on-edge exception — a shapes stroke has no alignment', () => {
    // The corner-pin exception exists to keep SAVED frames' quads still; no saved frame can
    // carry a shapes stroke, so both callers get the same honest answer.
    const l = shapesRect({ shapeId: 'badge', size: 0.2, spacing: 0.05, follow: false }, { align: 'center' })
    expect(cornerPinPadPx(l, W)).toBeCloseTo(0.1 * W, 6)
    expect(strokeReachPx(l, W)).toBeCloseTo(0.1 * W, 6)
  })

  it("scales a path's shapes stroke by its own `scale`, like every other stroke number", () => {
    const l = createPathLayer({ stroke: undefined, strokeWidth: undefined, scale: 2 }) as unknown as Record<string, unknown>
    l.strokes = [{ id: 's1', paint: '#fff', width: 0, distance: 0, style: 'shapes', shapes: { shapeId: 'badge', size: 0.2, spacing: 0.05, follow: false } }]
    expect(cornerPinPadPx(l as unknown as LocalLayer, W)).toBeCloseTo(0.1 * 2 * W, 6)
  })

  it('pads 0 for every entry `paintShapeStroke` itself draws nothing for', () => {
    // Each of these no-ops in the painter, so padding for them would grow a raster around ink
    // that never appears.
    expect(cornerPinPadPx(shapesRect({ shapeId: 'no-such-shape', size: 0.2, spacing: 0.05 }), W)).toBe(0)
    expect(cornerPinPadPx(shapesRect({ shapeId: 'badge', size: 0, spacing: 0.05 }), W)).toBe(0)
    expect(cornerPinPadPx(shapesRect({ shapeId: 'badge', size: 0.2, spacing: 0 }), W)).toBe(0)
    expect(cornerPinPadPx(shapesRect({ shapeId: '', size: 0.2, spacing: 0.05 }), W)).toBe(0)
    // …and a hidden or inkless one, the same gates the painter re-checks.
    expect(cornerPinPadPx(shapesRect({ shapeId: 'badge', size: 0.2, spacing: 0.05 }, { visible: false }), W)).toBe(0)
    expect(cornerPinPadPx(shapesRect({ shapeId: 'badge', size: 0.2, spacing: 0.05 }, { paint: 'none' }), W)).toBe(0)
  })

  it('takes the furthest of a mixed stack — band, marks, and back to a band', () => {
    const l = createRectLayer({ stroke: undefined, strokeWidth: undefined }) as unknown as Record<string, unknown>
    l.strokes = [
      { id: 'a', paint: '#fff', width: 0.02, distance: 0, align: 'outside' },                                  // 0.02
      { id: 'b', paint: '#fff', width: 0, distance: 0.01, style: 'shapes', shapes: { shapeId: 'badge', size: 0.2, spacing: 0.05, follow: false } }, // 0.11
      { id: 'c', paint: '#fff', width: 0.01, distance: 0.03, align: 'outside' },                               // 0.04
    ]
    expect(cornerPinPadPx(l as unknown as LocalLayer, W)).toBeCloseTo(0.11 * W, 6)
  })

  // The OTHER helper the same blind spot sat in: the torn-edge / feather silhouette raster.
  // It defers to `strokeReachPx`, so the fix reaches it — but only a test that goes through
  // `silhouettePadPx` with a real LAYER proves the deferral actually happens for this style.
  it('grows the silhouette raster by the marks\' reach', () => {
    const box = { w: 100, h: 100 }
    const bare = createRectLayer({ stroke: undefined, strokeWidth: undefined }) as unknown as LocalLayer
    const marked = shapesRect({ shapeId: 'badge', size: 0.2, spacing: 0.05, follow: false })
    expect(silhouettePadPx(marked, W, 1, box) - silhouettePadPx(bare, W, 1, box)).toBeCloseTo(0.1 * W, 6)
  })
})

// ── Ink model ────────────────────────────────────────────────────────────────
//
// The recording fake context + `inkAt` replay model live in `./_strokeCtx` —
// shared verbatim with `compositor-stroke-band.unit.spec.ts` (Task 2) so the two
// suites can never accidentally diverge on what the fake context does. See that
// file's header comment for the full description of what is and isn't modelled.

const scratchDoc = installScratchDocument()

function paint(layers: LocalLayer[], W = 200, H = 200) {
  const { ctx, rec } = makeCtx('main', W, H)
  paintLayerStack(ctx, W, H, layers.map(l => ({ type: 'local' as const, key: `l:${l.id}`, layer: l })), layers)
  return { rec, ink: (x: number, y: number) => inkAt(rec, { x, y }) }
}

// A 100x100 px square (0.5 of a 200px artboard) with a fat 20px outline.
const SQ = (partial: Partial<RectLayer> = {}) =>
  createRectLayer({ x: 0.5, y: 0.5, w: 0.5, h: 0.5, radius: 0, fill: '', stroke: '#ffffff', strokeWidth: 0.1, ...partial })

describe('stroke alignment — where the ink lands', () => {
  // Silhouette edge is at x = ±50. A centered 20px outline spans 40..60.
  it('centers by default: ink straddles the edge (the pre-change behavior)', () => {
    const { ink, rec } = paint([SQ()])
    expect(ink(45, 0)).toBe(true)    // inside half
    expect(ink(55, 0)).toBe(true)    // outside half
    expect(ink(65, 0)).toBe(false)   // beyond the outline
    expect(ink(35, 0)).toBe(false)
    // …and it takes the legacy code path: no clip, no offscreen, no dash.
    expect(rec.ops.some(o => o.kind === 'clip' || o.kind === 'stamp')).toBe(false)
    expect(scratchDoc.count()).toBe(0)
  })

  it('inside: the whole outline sits within the silhouette, nothing outside it', () => {
    const { ink } = paint([SQ({ strokeAlign: 'inside' })])
    expect(ink(45, 0)).toBe(true)    // just inside the edge
    expect(ink(32, 0)).toBe(true)    // 20px band reaches x=30
    expect(ink(25, 0)).toBe(false)   // interior stays clean
    expect(ink(50.5, 0)).toBe(false) // NO ink outside the silhouette
    expect(ink(55, 0)).toBe(false)
    expect(ink(0, 55)).toBe(false)   // same on the other axis
    expect(ink(0, -55)).toBe(false)
  })

  it('outside: the whole outline sits beyond the silhouette, nothing inside it', () => {
    const { ink } = paint([SQ({ strokeAlign: 'outside' })])
    expect(ink(55, 0)).toBe(true)    // just outside the edge
    expect(ink(68, 0)).toBe(true)    // 20px band reaches x=70
    expect(ink(75, 0)).toBe(false)   // and no further
    expect(ink(49.5, 0)).toBe(false) // NO ink strictly inside
    expect(ink(45, 0)).toBe(false)
    expect(ink(0, -45)).toBe(false)
  })

  it('outside keeps the shape\'s OWN fill — the knockout only eats the outline', () => {
    const { ink } = paint([SQ({ fill: '#ff0000', strokeAlign: 'outside' })])
    expect(ink(0, 0)).toBe(true)     // fill survives
    expect(ink(55, 0)).toBe(true)    // outline outside it
  })

  // The Critical this feature can cause: a destination-out on the SHARED canvas
  // would punch a hole through everything already painted under the shape.
  it('outside never eats the backdrop under it', () => {
    const back = createRectLayer({ id: 'back', x: 0.5, y: 0.5, w: 1, h: 1, radius: 0, fill: '#123456', stroke: '', strokeWidth: 0 } as any)
    const { ink, rec } = paint([back, SQ({ strokeAlign: 'outside' })])
    expect(ink(0, 0)).toBe(true)     // backdrop intact under the shape's middle
    expect(ink(45, 0)).toBe(true)    // …and under the knocked-out ring
    expect(ink(-45, 20)).toBe(true)
    // The knockout happened on an offscreen, never on the shared context.
    expect(scratchDoc.count()).toBe(1)
    expect(rec.ops.some(o => o.kind === 'fill' && o.erase)).toBe(false)
    expect(allOps(rec).some(o => o.kind === 'fill' && o.erase)).toBe(true)
  })

  it('an unknown alignment degrades to center', () => {
    const { ink, rec } = paint([SQ({ strokeAlign: 'sideways' as any })])
    expect(ink(45, 0)).toBe(true)
    expect(ink(55, 0)).toBe(true)
    expect(rec.ops.some(o => o.kind === 'clip' || o.kind === 'stamp')).toBe(false)
  })
})

// Corner-pin renders a layer to a box-sized offscreen (localLayerBox — plain w×h,
// NO stroke padding) and warps that onto the pin quad. An outside-aligned stroke
// lies entirely beyond that box (see the previous describe block) and used to be
// 100% clipped away by the offscreen's own edges. `paintWithSizes` intercepts every
// canvas the paint makes and records what its width/height end up being SET to
// (production code always creates-then-sizes: `document.createElement('canvas');
// cc.width = …; cc.height = …`), so these tests observe the real offscreen size the
// warp path builds — not just the pure `cornerPinPadPx` calculation.
function paintWithSizes(layers: LocalLayer[], W = 200, H = 200) {
  const sizes: { w: number; h: number }[] = []
  const { ctx, rec } = makeCtx('main', W, H)
  // Its own local counter — this override replaces the shared `installScratchDocument`
  // mock for the duration of one `paintWithSizes` call, so it can't reuse that mock's
  // (private) count and doesn't need to: no test here reads a scratch count.
  let localScratchCount = 0
  ;(globalThis as any).document = {
    createElement(tag: string) {
      if (tag !== 'canvas') return {}
      localScratchCount += 1
      const inner = makeCtx(`scratch${localScratchCount}`).ctx.canvas as any
      return new Proxy(inner, {
        set(target, prop, value) {
          target[prop] = value
          // Production always sets `.width` then `.height` right after — capture
          // only once BOTH have landed (on the `height` write), not the
          // momentarily-mismatched state mid-assignment (width already new,
          // height still the object's default).
          if (prop === 'height') sizes.push({ w: target.width, h: target.height })
          return true
        },
      })
    },
  }
  paintLayerStack(ctx, W, H, layers.map(l => ({ type: 'local' as const, key: `l:${l.id}`, layer: l })), layers)
  return { rec, sizes }
}

describe('corner-pin offscreen padding for outside-aligned strokes', () => {
  // A non-identity pin so cornerPinActive() sees real distortion and the warp
  // path (not the plain fast path) actually runs.
  const PIN: CornerPin = { tl: { x: -0.1, y: 0 }, tr: { x: 0.1, y: 0 }, br: { x: 0, y: 0 }, bl: { x: 0, y: 0 } }

  it('grows the offscreen by the full stroke width on each side when outside-aligned', () => {
    // SQ() is a 100×100 box (0.5 of 200px) with a 20px outline (strokeWidth 0.1).
    const { sizes } = paintWithSizes([SQ({ strokeAlign: 'outside', cornerPin: PIN })])
    // 100 + 2*20 = 140 on both axes, and centered (translate to the new center is
    // exercised implicitly — a mis-centered draw would still report this size).
    expect(sizes).toContainEqual({ w: 140, h: 140 })
  })

  // A centred stroke on the edge pads NOTHING, so its offscreen is the plain box — the
  // pre-stack behaviour, preserved because the pad also scales the quad (see below).
  it('does NOT pad a centered stroke sitting on the edge', () => {
    const { sizes } = paintWithSizes([SQ({ strokeAlign: 'center', cornerPin: PIN })])
    expect(sizes).toContainEqual({ w: 100, h: 100 })
    expect(sizes.some(s => s.w > 100 || s.h > 100)).toBe(false)
  })

  it('does NOT pad an inside-aligned stroke — it never left the box to begin with', () => {
    const { sizes } = paintWithSizes([SQ({ strokeAlign: 'inside', cornerPin: PIN })])
    expect(sizes).toContainEqual({ w: 100, h: 100 })
    expect(sizes.some(s => s.w > 100 || s.h > 100)).toBe(false)
  })

  it('does NOT pad a layer with no stroke at all', () => {
    const l = createRectLayer({ x: 0.5, y: 0.5, w: 0.5, h: 0.5, radius: 0, fill: '#fff', stroke: '', strokeWidth: 0, cornerPin: PIN })
    const { sizes } = paintWithSizes([l])
    expect(sizes).toContainEqual({ w: 100, h: 100 })
    expect(sizes.some(s => s.w > 100 || s.h > 100)).toBe(false)
  })

  // THE REGRESSION GUARD. `pad` sizes the offscreen AND scales the quad
  // (`hw = box.w / 2 + pad`, then every corner is pulled by `cp.*.x * hw`), so any pad a
  // stroke contributes also DEFORMS the pin. A saved frame's warp must not move because
  // the painter learned to read a stack, and only the quad shows that — the `sizes`
  // assertions above pass happily while the corners have all shifted.
  const lastQuad = (layer: LocalLayer) => {
    warpRec.quads.length = 0
    paintWithSizes([layer])
    expect(warpRec.quads.length).toBeGreaterThan(0)   // the warp path really ran
    return warpRec.quads[warpRec.quads.length - 1]!
  }
  const NO_STROKE = () => createRectLayer({ x: 0.5, y: 0.5, w: 0.5, h: 0.5, radius: 0, fill: '#fff', stroke: '', strokeWidth: 0, cornerPin: PIN })

  it('warps a centre-stroked rect onto EXACTLY the quad an unstroked rect gets', () => {
    const plain = lastQuad(NO_STROKE())
    const centred = lastQuad(SQ({ strokeAlign: 'center', cornerPin: PIN }))
    // hw = 50 with pad 0 ⇒ tl.x = -50 + (-0.1 * 50) = -55. A 10px pad would make it -66.
    expect(plain[0]!.x).toBeCloseTo(-55, 6)
    expect(centred).toEqual(plain)
  })

  it('an inside-aligned stroke leaves the quad alone too', () => {
    expect(lastQuad(SQ({ strokeAlign: 'inside', cornerPin: PIN }))).toEqual(lastQuad(NO_STROKE()))
  })

  it('an OUTSIDE stroke does move the quad — the pad it needs is real', () => {
    const out = lastQuad(SQ({ strokeAlign: 'outside', cornerPin: PIN }))
    // hw = 50 + 20 = 70 ⇒ tl.x = -70 + (-0.1 * 70) = -77.
    expect(out[0]!.x).toBeCloseTo(-77, 6)
  })

  it('a centre-aligned stroke pushed OUT by a distance does pad, and does move the quad', () => {
    const far = lastQuad(SQ({
      strokeAlign: 'center', cornerPin: PIN,
      strokes: [{ id: 's1', paint: '#fff', width: 0.1, distance: 0.05, align: 'center' }],
      stroke: undefined, strokeWidth: undefined,
    } as unknown as Partial<RectLayer>))
    // reach = 0.05 + 0.1/2 = 0.1 ⇒ 20px pad ⇒ hw = 70 ⇒ tl.x = -77.
    expect(far[0]!.x).toBeCloseTo(-77, 6)
  })
})

describe('dashed strokes', () => {
  // 100px line (0.5 of 200), 10px dash + 10px gap: on 0..10, off 10..20, …
  const dashed = (partial: Partial<LineLayer> = {}) =>
    createLineLayer({ x: 0.5, y: 0.5, w: 0.5, strokeWidth: 0.05, stroke: '#ffffff', strokeDash: { dash: 0.05, gap: 0.05 }, ...partial })

  it('leaves a gap between the marks', () => {
    const { ink } = paint([dashed()])
    expect(ink(-45, 0)).toBe(true)   // 5px along → inside the first dash
    expect(ink(-35, 0)).toBe(false)  // 15px along → inside the first gap
    expect(ink(-25, 0)).toBe(true)   // 25px along → second dash
  })

  it('a solid line has no gaps (absent dash = today)', () => {
    const { ink } = paint([dashed({ strokeDash: undefined })])
    expect(ink(-45, 0)).toBe(true)
    expect(ink(-35, 0)).toBe(true)
    expect(ink(-25, 0)).toBe(true)
  })

  it('a zero-length dash stays solid rather than vanishing', () => {
    const { ink } = paint([dashed({ strokeDash: { dash: 0, gap: 0.05 } })])
    expect(ink(-35, 0)).toBe(true)
  })

  it('a dashed layer followed by a solid one paints the solid one without gaps', () => {
    // Real coverage of the PLUMBING (paintLayer wraps every layer's draw in its
    // own save()/restore(), so layers never see each other's canvas state) —
    // this can catch a regression there, but NOT a missing reset inside
    // strokeAligned itself: see the next test for that claim specifically.
    const solid = createLineLayer({ id: 'solid', x: 0.5, y: 0.75, w: 0.5, strokeWidth: 0.05, stroke: '#ffffff' } as any)
    const { rec } = paint([dashed(), solid])
    const strokes = rec.ops.filter(o => o.kind === 'stroke')
    expect(strokes).toHaveLength(2)
    const second: Recorder = { name: 'second', ops: [strokes[1]!] }
    expect(inkAt(second, { x: -35, y: 0 })).toBe(true)
  })

  // The claim above ("resets afterwards") can't actually fail through paintLayer:
  // its per-layer save()/restore() would isolate the canvas dash state even if
  // strokeAligned's own `if (dash) c.setLineDash([])` reset were deleted. Calling
  // the exported helper directly, on the SAME ctx, with NO save()/restore() in
  // between, is the only way to observe the reset strokeAligned makes itself —
  // deleting that line flips this test to fail (the second stroke would inherit
  // the first call's [10,10] pattern and go dark at the gap probe point).
  it('strokeAligned resets its own dash pattern (observable with no enclosing save/restore)', () => {
    const { ctx, rec } = makeCtx('direct')
    const line = (c: CanvasRenderingContext2D) => { c.beginPath(); c.moveTo(-50, 0); c.lineTo(50, 0) }
    line(ctx)
    strokeAligned(ctx, { width: 10, style: () => '#fff', dash: [10, 10] })
    line(ctx)
    strokeAligned(ctx, { width: 10, style: () => '#fff', dash: null })
    const strokes = rec.ops.filter(o => o.kind === 'stroke')
    expect(strokes).toHaveLength(2)
    const second: Recorder = { name: 'second', ops: [strokes[1]!] }
    expect(inkAt(second, { x: -35, y: 0 })).toBe(true) // 15px along → dark under a leaked [10,10] pattern
  })

  it('dashes an inside-aligned outline without leaving the pattern set', () => {
    const { rec, ink } = paint([SQ({ strokeAlign: 'inside', strokeDash: { dash: 0.05, gap: 0.05 } })])
    expect(ink(50.5, 0)).toBe(false)  // still inside the silhouette
    expect(rec.ops.filter(o => o.kind === 'clip')).toHaveLength(1)
  })
})

// ── An inkless stroke in a stack (fix wave 1, Finding 1) ─────────────────────
//
// `paint: 'none'` is one click away in the inspector's Colour row (`<FillControl allow-none>`).
// Two separate claims, and the bug conflated them: (a) the OTHER strokes must still paint —
// an inkless entry must not take the stack down with it; (b) the inkless one itself must
// paint nothing, which is the painter's own `hasPaint(st.paint)` gate, not the reader's job.
describe('a stroke whose colour was removed', () => {
  // Half-extent 50. Outer stroke: 40px wide, centred on the edge ⇒ 30..70.
  // Inner stroke: 10px wide, centred on the edge ⇒ 45..55.
  const twoStrokes = (outerPaint: string) => createRectLayer({
    x: 0.5, y: 0.5, w: 0.5, h: 0.5, radius: 0, fill: '',
    stroke: undefined, strokeWidth: undefined,
    strokes: [
      { id: 'outer', paint: outerPaint, width: 0.2 },
      { id: 'inner', paint: '#00ff00', width: 0.05 },
    ],
  } as unknown as Partial<RectLayer>)

  it('CONTROL: with both painted, both bands land where the probes expect', () => {
    const { ink } = paint([twoStrokes('#ffffff')])
    expect(ink(65, 0)).toBe(true)    // outer band only
    expect(ink(50, 0)).toBe(true)    // both
    expect(ink(35, 0)).toBe(true)    // outer band only
    expect(ink(75, 0)).toBe(false)   // beyond both
  })

  it('still paints the OTHER stroke in the stack', () => {
    const { ink } = paint([twoStrokes('none')])
    expect(ink(50, 0)).toBe(true)    // the green 10px band survives
    expect(ink(48, 0)).toBe(true)
  })

  it('paints nothing at all for the inkless one', () => {
    const { ink } = paint([twoStrokes('none')])
    expect(ink(65, 0)).toBe(false)   // where the 40px band would have been
    expect(ink(35, 0)).toBe(false)
  })
})

/**
 * A WOBBLED STROKE'S REACH — the consumer that fails silently.
 *
 * A wobble displaces the stroke's line by up to `wobbleAmount` either side of where it would
 * have run straight, so both pad helpers have to grow by that amplitude. Without the term the
 * wave is clipped at the corner-pin / DOF offscreen edge and cut by the torn-edge silhouette —
 * a slightly wrong shape, never an error. This is the THIRD time this exact pair of helpers has
 * needed a new term in this feature family (outside alignment, then marching shapes, now the
 * wobble), which is why each arm gets a case here that goes red when the term is removed.
 *
 * The numbers are the helpers' own arithmetic plus one addition, so an expectation cannot pass
 * by accident: a centred 0.1-wide band pushed to distance 0.05 reaches 0.05 + 0.05 = 0.1
 * straight, and 0.13 with a 0.03 amplitude — the difference is the whole claim.
 */
describe('strokeReachPx / cornerPinPadPx — a wobble reaches by its amplitude too', () => {
  const W = 200
  const WOBBLE = { wobble: 'wave', wobbleAmount: 0.03, wobbleLength: 0.2, wobblePhase: 0 }

  /** A rect carrying ONE stroke, described entirely by the stack (no legacy fields). */
  const withStroke = (st: Record<string, unknown>) => {
    const l = createRectLayer({ stroke: undefined, strokeWidth: undefined }) as unknown as Record<string, unknown>
    l.strokes = [{ id: 's1', paint: '#fff', width: 0.1, distance: 0, align: 'center', ...st }]
    return l as unknown as LocalLayer
  }

  it('adds the amplitude to a BAND\'s reach, for both callers', () => {
    const straight = withStroke({ distance: 0.05 })
    const wavy = withStroke({ distance: 0.05, ...WOBBLE })
    // Straight: 0.05 + 0.1/2 = 0.1. Wavy: + 0.03 amplitude = 0.13.
    expect(strokeReachPx(straight, W)).toBeCloseTo(0.1 * W, 6)
    expect(cornerPinPadPx(straight, W)).toBeCloseTo(0.1 * W, 6)
    expect(strokeReachPx(wavy, W)).toBeCloseTo(0.13 * W, 6)
    expect(cornerPinPadPx(wavy, W)).toBeCloseTo(0.13 * W, 6)
  })

  it('adds it for every alignment, on top of wherever the band already reached', () => {
    expect(strokeReachPx(withStroke({ align: 'outside', ...WOBBLE }), W)).toBeCloseTo((0.1 + 0.03) * W, 6)
    expect(strokeReachPx(withStroke({ align: 'inside', distance: 0.05, ...WOBBLE }), W)).toBeCloseTo((0.05 + 0.03) * W, 6)
  })

  // The corner-pin exception (a centred stroke sitting ON the edge contributes 0, so the quad
  // of every already-saved frame stays put) does NOT apply to a wobbled one: no frame saved
  // before this feature can carry a wobble, so counting it moves nothing — and excusing it
  // would clip the wave, which is the whole failure this term prevents.
  it('is NOT excused by the centre-on-edge exception once it wobbles', () => {
    const still = withStroke({})
    const wavy = withStroke({ ...WOBBLE })
    expect(cornerPinPadPx(still, W)).toBe(0)
    expect(cornerPinPadPx(wavy, W)).toBeCloseTo((0.05 + 0.03) * W, 6)
    expect(strokeReachPx(wavy, W)).toBeCloseTo((0.05 + 0.03) * W, 6)
  })

  it('adds the amplitude to a SHAPES stroke\'s reach too — the marks ride the wobbled guide', () => {
    const marks = { width: 0, distance: 0.05, style: 'shapes', shapes: { shapeId: 'badge', size: 0.2, spacing: 0.05, follow: false } }
    // badge fitted to size 0.2 upright reaches 0.1 past its guide point; the guide itself is
    // displaced by up to 0.03.
    expect(strokeReachPx(withStroke(marks), W)).toBeCloseTo((0.05 + 0.1) * W, 6)
    expect(strokeReachPx(withStroke({ ...marks, ...WOBBLE }), W)).toBeCloseTo((0.05 + 0.1 + 0.03) * W, 6)
    expect(cornerPinPadPx(withStroke({ ...marks, ...WOBBLE }), W)).toBeCloseTo((0.05 + 0.1 + 0.03) * W, 6)
  })

  // `wobbleSpecOf` is the ONE place "is this wobble live" is answered — the pad must not
  // re-derive it from the raw fields, or a wobble that paints nothing would still pad.
  it('adds nothing for a wobble that is off, however it is off', () => {
    const base = 0.05 * W  // centred 0.1 band on the edge, raster answer
    expect(strokeReachPx(withStroke({ ...WOBBLE, wobble: 'squiggle' }), W)).toBeCloseTo(base, 6)
    expect(strokeReachPx(withStroke({ ...WOBBLE, wobbleLength: 0 }), W)).toBeCloseTo(base, 6)
    expect(strokeReachPx(withStroke({ ...WOBBLE, wobbleLength: NaN }), W)).toBeCloseTo(base, 6)
    expect(strokeReachPx(withStroke({ ...WOBBLE, wobbleAmount: NaN }), W)).toBeCloseTo(base, 6)
    expect(strokeReachPx(withStroke({ ...WOBBLE, wobbleAmount: 0 }), W)).toBeCloseTo(base, 6)
    expect(strokeReachPx(withStroke({ wobble: undefined }), W)).toBeCloseTo(base, 6)
  })

  it('scales a path\'s amplitude by its own `scale`, like every other stroke number', () => {
    const l = createPathLayer({ stroke: undefined, strokeWidth: undefined, scale: 2 }) as unknown as Record<string, unknown>
    l.strokes = [{ id: 's1', paint: '#fff', width: 0.1, distance: 0, align: 'outside', ...WOBBLE }]
    expect(strokeReachPx(l as unknown as LocalLayer, W)).toBeCloseTo((0.1 + 0.03) * 2 * W, 6)
  })

  // TEXT never paints a wobble: it does not reach `paintStrokeStack` at all (its bands go
  // through `paintTextStrokeBands` → `paintStrokeBand`, which has no wobble route) and it has
  // no outline to displace. Padding for a wave that never appears would grow the raster — and
  // the corner-pin quad — around nothing.
  it('adds nothing for TEXT, which has no route that paints a wobble', () => {
    const t = createTextLayer({ text: 'hi' }) as unknown as Record<string, unknown>
    t.strokes = [{ id: 's1', paint: '#fff', width: 0.1, distance: 0.05, align: 'center', ...WOBBLE }]
    expect(strokeReachPx(t as unknown as LocalLayer, W)).toBeCloseTo(0.1 * W, 6)
  })
})

/**
 * THE WOBBLED BAND'S CONSTRUCTION.
 *
 * A band at a distance is normally the difference of two raster DILATIONS, and a dilation has
 * one radius — it cannot express a line whose distance from the edge varies. A wobbled band is
 * built the other way round: flatten the outline, displace it through `offsetPolyline`, build a
 * `Path2D` and stroke it. These tests watch that route actually RUN (the repo's own lesson: a
 * graceful fallback hides an integration failure, so assert the path ran) rather than infer it.
 *
 * `Path2D` does not exist in this suite's node environment, so it is stubbed with a recorder —
 * which is also what makes the DISPLACED GEOMETRY itself assertable, point by point, without a
 * rasterizer.
 */
describe('a wobbled band strokes a displaced path, not a pair of dilations', () => {
  type StubPath = { pts: { x: number; y: number }[]; closed: boolean }
  const built: StubPath[] = []
  beforeEach(() => {
    built.length = 0
    ;(globalThis as any).Path2D = class {
      pts: { x: number; y: number }[] = []
      closed = false
      constructor() { built.push(this as unknown as StubPath) }
      moveTo(x: number, y: number) { this.pts.push({ x, y }) }
      lineTo(x: number, y: number) { this.pts.push({ x, y }) }
      closePath() { this.closed = true }
    }
  })
  afterEach(() => { delete (globalThis as any).Path2D })

  // A 100×100 px square on a 200px artboard, one 10px band, a 6px wobble every 40px. The
  // perimeter is 400, so `effectiveWavelength` snaps to exactly 40 and the phase closes.
  const wavyRect = (st: Record<string, unknown> = {}) => {
    const l = createRectLayer({
      x: 0.5, y: 0.5, w: 0.5, h: 0.5, radius: 0, fill: '',
      stroke: undefined, strokeWidth: undefined,
    } as unknown as Partial<RectLayer>) as unknown as Record<string, unknown>
    l.strokes = [{
      id: 's1', paint: '#ffffff', width: 0.05, distance: 0, align: 'center', join: 'sharp', style: 'band',
      wobble: 'wave', wobbleAmount: 0.03, wobbleLength: 0.2, wobblePhase: 0, ...st,
    }]
    return l as unknown as LocalLayer
  }

  /** Signed deviation from the square's own edge, for the points that sit on the TOP or BOTTOM
   *  edge well away from a corner (the corner vertex carries a miter scale of its own, which is
   *  the band meeting itself, not the wobble). Positive = outside the silhouette. */
  const edgeDeviations = (p: StubPath) =>
    p.pts.filter(q => Math.abs(q.x) <= 40).map(q => Math.abs(q.y) - 50)

  it('strokes ONE path on the shared context and builds no dilation pair at all', () => {
    const { rec } = paint([wavyRect()])
    expect(scratchDoc.count()).toBe(0)                       // no scratch ⇒ no dilation, no knockout
    expect(built).toHaveLength(1)
    expect(built[0]!.closed).toBe(true)                      // a closed outline closes
    const strokes = allOps(rec).filter(o => o.kind === 'stroke') as any[]
    expect(strokes).toHaveLength(1)
    expect(strokes[0]!.lineWidth).toBeCloseTo(10, 6)         // 0.05 * 200, stroked at width
    expect(strokes[0]!.lineJoin).toBe('miter')               // 'sharp' honours the join
    expect(allOps(rec).some(o => (o as any).erase)).toBe(false)
    expect(rec.ops.some(o => o.kind === 'stamp')).toBe(false)  // nothing stamped back
  })

  it('honours the Corners control the straight distance-0 band cannot', () => {
    const { rec } = paint([wavyRect({ join: 'round' })])
    const stroke = allOps(rec).find(o => o.kind === 'stroke') as any
    expect(stroke.lineJoin).toBe('round')
  })

  it('resamples the outline and displaces it by exactly the amplitude', () => {
    paint([wavyRect()])
    const p = built[0]!
    // 400px of perimeter at a step of 40/16 = 2.5 ⇒ ~160 points, not the rect's 4 corners.
    expect(p.pts.length).toBeGreaterThan(100)
    const dev = edgeDeviations(p)
    expect(Math.max(...dev)).toBeCloseTo(6, 0)    // 0.03 * 200, outward
    expect(Math.min(...dev)).toBeCloseTo(-6, 0)   // …and the same inward
  })

  // The alignment moves the LINE, not the construction: the band an alignment describes spans
  // [d, d+width] outside, so its midpoint — the line this route strokes — is half a width out.
  it('puts an outside-aligned band\'s line half a width out, where the dilation pair put it', () => {
    paint([wavyRect({ align: 'outside' })])
    const dev = edgeDeviations(built[0]!)
    const mean = dev.reduce((a, b) => a + b, 0) / dev.length
    expect(mean).toBeCloseTo(5, 0)                // 10px band centred on +5 ⇒ spans 0..10
    expect(Math.max(...dev)).toBeCloseTo(11, 0)   // 5 + 6
  })

  // CONTROL: with no wobble the straight construction runs untouched — no Path2D is built and
  // the distance band still makes its two dilation scratches. This is the unit-level shadow of
  // the byte-identity fixture.
  it('CONTROL: an unwobbled band builds no path and still uses the dilation pair', () => {
    const { rec } = paint([wavyRect({ wobble: undefined, distance: 0.05 })])
    expect(built).toHaveLength(0)
    expect(scratchDoc.count()).toBeGreaterThan(0)
    // The dilation pair is stamped back onto the shared ctx from its scratch — the op the
    // wobbled route above never makes. (`allOps` flattens a stamp into the ops it carries, so
    // the stamp itself is only visible on the un-flattened recorder.)
    expect(rec.ops.some(o => o.kind === 'stamp')).toBe(true)
  })

  it('CONTROL: a wobble that is off takes the straight route as well', () => {
    paint([wavyRect({ wobbleLength: 0, distance: 0.05 })])
    expect(built).toHaveLength(0)
  })
})
