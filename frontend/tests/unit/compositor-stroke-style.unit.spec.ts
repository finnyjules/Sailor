import { describe, it, expect, vi } from 'vitest'
import {
  strokeDashSegments, strokeAlignOf, strokeAligned, outsideStrokePadPx, paintLayerStack,
  createRectLayer, createLineLayer, createPathLayer,
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
describe('outsideStrokePadPx', () => {
  it('is 0 for a rect with no stroke at all', () => {
    const l = createRectLayer({ stroke: '', strokeWidth: 0.1, strokeAlign: 'outside' })
    expect(outsideStrokePadPx(l, 200)).toBe(0)
  })

  it('is 0 for a rect with a zero-width stroke', () => {
    const l = createRectLayer({ stroke: '#fff', strokeWidth: 0, strokeAlign: 'outside' })
    expect(outsideStrokePadPx(l, 200)).toBe(0)
  })

  // A centred stroke AT DISTANCE 0 stays 0 — not because its ink is inside the box (half
  // of it is not), but because this pad also scales the corner-pin quad, so any value here
  // re-warps every saved centred-stroke frame. See outsideStrokePadPx's doc comment and
  // the quad tests at the bottom of this file.
  it('is 0 for a centre- or inside-aligned stroke sitting on the edge', () => {
    const center = createRectLayer({ stroke: '#fff', strokeWidth: 0.1, strokeAlign: 'center' })
    const inside = createRectLayer({ stroke: '#fff', strokeWidth: 0.1, strokeAlign: 'inside' })
    const absent = createRectLayer({ stroke: '#fff', strokeWidth: 0.1 })
    expect(outsideStrokePadPx(center, 200)).toBe(0)
    expect(outsideStrokePadPx(inside, 200)).toBe(0)
    expect(outsideStrokePadPx(absent, 200)).toBe(0)   // absent ⇒ 'center'
  })

  // The silhouette raster asks for the OTHER answer — it only needs to be big enough, and
  // must not shrink below what the pre-stack rule gave. Same helper, one explicit flag, so
  // the two callers can never drift apart on what the rest of a stack reaches.
  it('counts a centred edge stroke when the caller asks for the raster answer', () => {
    const center = createRectLayer({ stroke: '#fff', strokeWidth: 0.1, strokeAlign: 'center' })
    expect(outsideStrokePadPx(center, 200, true)).toBe(10)   // 0.1 * 200 / 2
    expect(outsideStrokePadPx(center, 200, false)).toBe(0)
  })

  // The exception is exactly and only distance 0: a stroke the stack pushed away from the
  // edge has no legacy counterpart, so padding for it cannot move any saved frame.
  it('DOES pad a centred stroke that a distance pushed off the edge', () => {
    const l = createRectLayer({ stroke: undefined, strokeWidth: undefined }) as unknown as Record<string, unknown>
    l.strokes = [{ id: 's1', paint: '#fff', width: 0.1, distance: 0.05, align: 'center' }]
    expect(outsideStrokePadPx(l as unknown as LocalLayer, 200)).toBe(20)  // (0.05 + 0.05) * 200
  })

  // Task 3b item 4 (Minor, fix wave 1): a non-finite stored `distance` must read as 0,
  // exactly like the painter's own `strokeDistancePx` and `silhouettePadPx` already do —
  // this pad also SCALES the corner-pin quad (`hw = box.w/2 + pad`), so an unguarded
  // Infinity here would re-warp the quad to an infinite size, not just mis-size a raster.
  it('treats a non-finite stored distance as 0, not Infinity/NaN', () => {
    const inf = createRectLayer({ stroke: undefined, strokeWidth: undefined }) as unknown as Record<string, unknown>
    inf.strokes = [{ id: 's1', paint: '#fff', width: 0.1, distance: Infinity, align: 'center' }]
    expect(outsideStrokePadPx(inf as unknown as LocalLayer, 200)).toBe(0)

    // A NaN distance with an outside-aligned stroke: the reach must fall back to the
    // width alone (0 + width), not silently drop the stroke's reach to 0 via a NaN
    // comparison that is always false.
    const nan = createRectLayer({ stroke: undefined, strokeWidth: undefined }) as unknown as Record<string, unknown>
    nan.strokes = [{ id: 's1', paint: '#fff', width: 0.1, distance: NaN, align: 'outside' }]
    expect(outsideStrokePadPx(nan as unknown as LocalLayer, 200)).toBe(20)
  })

  it('is the full stroke width in px for an outside-aligned rect/ellipse/polygon/star', () => {
    // strokeWidth is normalized to canvas width for these kinds — 0.1 * 200 = 20px.
    const l = createRectLayer({ stroke: '#fff', strokeWidth: 0.1, strokeAlign: 'outside' })
    expect(outsideStrokePadPx(l, 200)).toBe(20)
  })

  it('scales a path\'s pad by its own `scale`, not just canvas width', () => {
    // strokeWidth is LOCAL units at scale=1 for a path — the rendered ctx is
    // pre-scaled by (scale*W), so the outward px extent must fold scale in too.
    const l = createPathLayer({ stroke: '#fff', strokeWidth: 0.1, strokeAlign: 'outside', scale: 2 })
    expect(outsideStrokePadPx(l, 200)).toBe(40) // 0.1 * 2 * 200
  })

  it('is 0 for a line — alignment does not apply (no interior)', () => {
    const l = createLineLayer({ stroke: '#fff', strokeWidth: 0.1 })
    expect(outsideStrokePadPx(l, 200)).toBe(0)
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
// warp path builds — not just the pure `outsideStrokePadPx` calculation.
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
