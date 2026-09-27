// frontend/tests/unit/responsive-view-edit-grid.unit.spec.ts — edits at a viewing size on a Frame
// with a layout grid: a unit re-holds when an edit moves it onto or off a column/row span.
import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer, type LocalLayer } from '~/composables/useCompositorLayers'
import { resolveLayout, effectivePins, holdOf } from '~/lib/frame/responsive'
import { buildUnits } from '~/lib/frame/responsive/units'
import { moveUnitAtView, resizeLayerAtView, type ViewEdit } from '~/lib/frame/responsive/viewEdit'
import { suggestedLayoutGrid, resolveLayoutGrid, type LayoutGrid } from '~/lib/frame/layoutGrid'
import type { FrameDoc } from '~/lib/frame/responsive/types'

const own = (over: Partial<LayoutGrid> = {}): LayoutGrid => ({
  v: 2, auto: false, show: true, line: 40,
  cols: { count: 2, fit: 'stretch', margin: 0, gutter: 0, width: 0 },
  rows: { mode: 'off', count: 4 }, ...over,
})
interface Setup { W0: number; H0: number; W: number; H: number; grid: LayoutGrid }
const doc = (S: Setup, layers: LocalLayer[]): FrameDoc => ({
  responsive: true, designW: S.W0, designH: S.H0, layers, stackOrder: layers.map(l => `l:${l.id}`),
  groups: [], grid: S.grid, motion: null,
})
const resolveAt = (S: Setup, layers: LocalLayer[]) => resolveLayout(doc(S, layers), S.W, S.H, { withBoxes: true })
function apply(layers: LocalLayer[], e: ViewEdit): LocalLayer[] {
  return layers.map((l) => {
    const p = e.patches.find(x => x.id === l.id)?.patch
    let out: LocalLayer = p ? ({ ...l, ...p } as LocalLayer) : l
    if (e.pins && !e.pins.onGroup && e.pins.unitId === l.id) {
      const pins: Record<string, unknown> = { ...(l.pins ?? {}), ...e.pins.patch }
      for (const k of Object.keys(pins)) if (pins[k] === undefined) delete pins[k]
      out = { ...out, pins: Object.keys(pins).length ? pins : undefined } as LocalLayer
    }
    return out
  })
}
const drawnAfter = (S: Setup, layers: LocalLayer[], e: ViewEdit, id: string) => resolveAt(S, apply(layers, e)).boxes.get(id)!

const near = (got: number, want: number, eps = 1e-6) => expect(Math.abs(got - want)).toBeLessThan(eps)
/** A drop and the drag frame before it: both draw the unit at `want` (view px). */
function expectDrawnAt(S: Setup, layers: LocalLayer[], edit: (phase: 'drag' | 'drop') => ViewEdit, id: string, want: { x?: number; y?: number; w?: number; h?: number }) {
  for (const phase of ['drag', 'drop'] as const) {
    const b = drawnAfter(S, layers, edit(phase), id)
    for (const k of ['x', 'y', 'w', 'h'] as const) if (want[k] != null) near(b[k], want[k]!, 1e-6)
  }
}

// A 2-column grid with no margin on a 1000×500 design, viewed at 3000×500. Column 1 is 0..500
// (view 0..1500), column 2 500..1000 (view 1500..3000). A 100-wide rect at 300..400 sits right in
// column 1 and is drawn at 1050..1150.
const TWO = { W0: 1000, H0: 500, W: 3000, H: 500, grid: own() }
const inCol1 = () => [createRectLayer({ id: 'a', x: 0.35, y: 0.5, w: 0.1, h: 0.1 })]

describe('I1 — a unit dropped onto another span is drawn where it was dropped', () => {
  it('moved across the column boundary (it now holds to column 2)', () => {
    const l = inCol1(), u = resolveAt(TWO, l).units.get('a')!
    expect(u.viewBox.x).toBeCloseTo(1050, 9)
    // +300 keeps it in view column 1, but the design position that draws there is in column 2.
    expectDrawnAt(TWO, l, ph => moveUnitAtView(u, l, 1000, 500, 300, 0, ph), 'a', { x: 1350, w: 100 })
    // +1000 lands it in view column 2.
    expectDrawnAt(TWO, l, ph => moveUnitAtView(u, l, 1000, 500, 1000, 0, ph), 'a', { x: 2050, w: 100 })
  })
  it('resized across the column boundary', () => {
    const l = inCol1(), u = resolveAt(TWO, l).units.get('a')!
    const box = (w: number) => ({ x: u.viewBox.x, y: u.viewBox.y, w, h: u.viewBox.h })
    for (const w of [400, 1200]) {
      expectDrawnAt(TWO, l, ph => resizeLayerAtView(u, l[0]!, box(w), 1000, 500, ph, { w: 'w', h: 'h' }), 'a', { x: 1050, w })
    }
  })

  // The suggested grid of a 1080×1350 Frame at 1600×1350 (fit scale 1): design rows are 64 tall at
  // an 80 pitch from 48; view rows 112 tall at a 128 pitch from 48 (9 of them, for 15 at the design).
  const TALL = { W0: 1080, H0: 1350, W: 1600, H: 1350, grid: suggestedLayoutGrid(1080, 1350, null) }
  const d = resolveLayoutGrid(TALL.grid, 1080, 1350, null)
  const rect = (id: string, cx: number, cy: number, w: number, h: number) => createRectLayer({ id, x: cx / 1080, y: cy / 1350, w: w / 1080, h: h / 1080 })
  it('the fixture grid is as described', () => {
    const v = resolveAt(TALL, [rect('z', 540, 675, 10, 10)]).grid!
    expect(d.rows.slice(0, 2).map(r => [r.a, r.w])).toEqual([[48, 64], [128, 64]])
    expect(v.rows.slice(0, 2).map(r => [r.a, r.w])).toEqual([[48, 112], [176, 112]])
    expect(d.rows.length).toBe(15); expect(v.rows.length).toBe(9)
  })
  it('a small rect moved onto other rows, and off the rows (below the last one)', () => {
    const l = [rect('a', 400, 160, 30, 30)]                 // in row 2 (128..192), drawn at 217
    const u = resolveAt(TALL, l).units.get('a')!
    near(u.refView.y, 176); near(u.refView.h, 112)          // held to view row 2
    for (const dy of [30, 100, 400, 1080]) {
      expectDrawnAt(TALL, l, ph => moveUnitAtView(u, l, 1080, 1350, 0, dy, ph), 'a', { y: u.viewBox.y + dy, h: u.viewBox.h })
    }
  })
  it('a small rect below the last row moved onto the rows', () => {
    const l = [rect('a', 400, 1290, 30, 30)]                // 1275..1305: below the last row (1168..1232)
    const u = resolveAt(TALL, l).units.get('a')!
    near(u.refView.y, 0); near(u.refView.h, 1350)           // held to the frame down
    for (const dy of [-50, -300, -700]) {
      expectDrawnAt(TALL, l, ph => moveUnitAtView(u, l, 1080, 1350, 0, dy, ph), 'a', { y: u.viewBox.y + dy, h: u.viewBox.h })
    }
  })
  it('every drop lands near the pointer, exactly where the last drag frame drew it (sweep)', () => {
    // Some view spots no design position reaches: between two view rows, or where a row's tolerance
    // captures the design box. There the nearest reachable spot is taken.
    const l = [rect('a', 400, 160, 30, 30)]
    const u = resolveAt(TALL, l).units.get('a')!
    let worst = 0
    for (let dy = -150; dy <= 1090; dy += 10) {
      const drag = drawnAfter(TALL, l, moveUnitAtView(u, l, 1080, 1350, 0, dy, 'drag'), 'a')
      const drop = drawnAfter(TALL, l, moveUnitAtView(u, l, 1080, 1350, 0, dy, 'drop'), 'a')
      near(drop.y, drag.y, 1e-6)
      worst = Math.max(worst, Math.abs(drop.y - (u.viewBox.y + dy)))
    }
    // Worst just below the last view row: a design box there within the 16 px tolerance of the last
    // design row holds to it, so the nearest spot held to the frame is 33 px away.
    expect(worst).toBeLessThanOrEqual(34)
  })
  it('a small rect resized down across rows', () => {
    const l = [rect('a', 400, 160, 30, 30)]
    const u = resolveAt(TALL, l).units.get('a')!
    for (const h of [60, 150, 250, 400]) {
      const box = { x: u.viewBox.x, y: u.viewBox.y, w: u.viewBox.w, h }
      expectDrawnAt(TALL, l, ph => resizeLayerAtView(u, l[0]!, box, 1080, 1350, ph, { w: 'w', h: 'h' }), 'a', { y: u.viewBox.y, h })
    }
  })
  it('a rect stretched over its row moved down by whole view rows lands on those rows', () => {
    const r = d.rows[1]!, c3 = d.cols[2]!, c4 = d.cols[3]!
    const l = [rect('a', (c3.a + c4.a + c4.w) / 2, r.a + r.w / 2, c4.a + c4.w - c3.a, r.w)]
    const u = resolveAt(TALL, l).units.get('a')!
    expect(u.v.kind).toBe('both'); expect(u.viewBox.y).toBeCloseTo(176, 9); expect(u.viewBox.h).toBeCloseTo(112, 9)
    for (const k of [1, 2, 4, -1]) {
      expectDrawnAt(TALL, l, ph => moveUnitAtView(u, l, 1080, 1350, 0, 128 * k, ph), 'a', { y: 176 + 128 * k, h: 112 })
    }
  })
})

describe('I2 — a rect exactly on its columns drags sideways at a viewing size', () => {
  const grid = suggestedLayoutGrid(1080, 1350, null)
  const d = resolveLayoutGrid(grid, 1080, 1350, null)
  const c3 = d.cols[2]!, c6 = d.cols[5]!
  // On columns 3–6, in the middle of the frame down (so only the columns matter here).
  const l = () => [createRectLayer({ id: 'a', x: (c3.a + c6.a + c6.w) / 2 / 1080, y: 0.5, w: (c6.a + c6.w - c3.a) / 1080, h: 200 / 1080 })]
  for (const [W, H] of [[1600, 1350], [1080, 700], [700, 1350]] as const) {
    it(`at ${W}×${H}: moved by whole view columns it lands on those columns`, () => {
      const S = { W0: 1080, H0: 1350, W, H, grid }
      const layers = l(), r = resolveAt(S, layers), u = r.units.get('a')!, v = r.grid!
      expect(u.h.kind).toBe('both')
      near(u.viewBox.x, v.cols[2]!.a); near(u.viewBox.x + u.viewBox.w, v.cols[5]!.a + v.cols[5]!.w)
      const pitch = v.cols[1]!.a - v.cols[0]!.a
      for (const k of [1, 2, -1]) {
        expectDrawnAt(S, layers, ph => moveUnitAtView(u, layers, 1080, 1350, k * pitch, 0, ph), 'a', { x: v.cols[2 + k]!.a, w: u.viewBox.w })
      }
      // A little: drawn where dropped when a design position draws there (the frame holds it), else
      // snapped onto the nearest columns; the drop always draws where the last drag frame did.
      for (const f of [0.3, 0.7]) {
        const drag = drawnAfter(S, layers, moveUnitAtView(u, layers, 1080, 1350, f * pitch, 0, 'drag'), 'a')
        const drop = drawnAfter(S, layers, moveUnitAtView(u, layers, 1080, 1350, f * pitch, 0, 'drop'), 'a')
        near(drop.x, drag.x); near(drop.w, u.viewBox.w)
        const snapped = v.cols[f < 0.5 ? 2 : 3]!.a
        expect(Math.abs(drop.x - (u.viewBox.x + f * pitch)) < 1e-6 || Math.abs(drop.x - snapped) < 1e-6).toBe(true)
      }
    })
  }
})

describe('I3 — a full-bleed layer holds to the frame, whatever the grid margin', () => {
  it('a 728×90 full-bleed rect draws at 0..970 × 0..250', () => {
    const grid = suggestedLayoutGrid(728, 90, null)
    const S = { W0: 728, H0: 90, W: 970, H: 250, grid }
    const l = createRectLayer({ id: 'bg', x: 0.5, y: 0.5, w: 1, h: 90 / 728 })
    const unit = buildUnits([l], [], null, 728, 90)[0]!
    const p = resolveAt(S, [l])
    expect(holdOf(unit, l, { design: resolveLayoutGrid(grid, 728, 90, null), view: p.grid!, s: 250 / 90 > 970 / 728 ? 970 / 728 : 250 / 90 }, 728, 90, 970, 250, null).onGrid).toEqual({ h: false, v: false })
    const b = p.boxes.get('bg')!
    near(b.x, 0); near(b.y, 0); near(b.w, 970); near(b.h, 250)
  })
  it('a band touching one frame edge holds to the frame on that axis only', () => {
    const grid = suggestedLayoutGrid(1080, 1350, null)
    const d = resolveLayoutGrid(grid, 1080, 1350, null)
    const c = d.cols[2]!
    // Column 3 across, from the top edge down to 300.
    const l = createRectLayer({ id: 'a', x: (c.a + c.w / 2) / 1080, y: 150 / 1350, w: c.w / 1080, h: 300 / 1080 })
    const r = resolveAt({ W0: 1080, H0: 1350, W: 1600, H: 1350, grid }, [l]), u = r.units.get('a')!
    near(u.refView.x, r.grid!.cols[2]!.a); near(u.refView.w, r.grid!.cols[2]!.w)   // across: column 3
    near(u.refView.y, 0); near(u.refView.h, 1350)                                  // down: the frame
  })
})

describe('M1 — the pins card infers as the resolver does with Keep size', () => {
  it('a wide layer that keeps its size reads centred, not stretched', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.9, h: 0.1, pins: { keepSize: true } })
    const doc1: FrameDoc = { responsive: true, designW: 1000, designH: 500, layers: [l], stackOrder: ['l:a'], groups: [], grid: null, motion: null }
    const e = effectivePins(doc1, 'a', null)!
    expect(e.h).toBe('center')
    expect(resolveLayout(doc1, 3000, 500, { withBoxes: true }).units.get('a')!.h.kind).toBe('center')
  })
})

describe('M2 — a text on rows settles as the resolver reads it (capitals to last baseline)', () => {
  it('a text dropped where it was stays automatic', () => {
    const S = { W0: 1080, H0: 1350, W: 1600, H: 1350, grid: suggestedLayoutGrid(1080, 1350, null) }
    // Its box (64.8 tall) fills most of its 64-px row; its capitals-to-baseline (37.8) do not.
    const l = [createTextLayer({ id: 't', text: 'Hello', x: 0.3, y: 400 / 1350, fontSize: 0.05, boxW: 0.3 })]
    const u = resolveAt(S, l).units.get('t')!
    near(u.refView.h, 112); expect(u.v.kind).toBe('center')    // held to its row
    const e = moveUnitAtView(u, l, 1080, 1350, 0, 0, 'drop')
    expect(e.pins!.patch).toStrictEqual({ h: undefined, v: undefined })
    expectDrawnAt(S, l, ph => moveUnitAtView(u, l, 1080, 1350, 0, 128, ph), 't', { y: u.viewBox.y + 128 })
  })
})
