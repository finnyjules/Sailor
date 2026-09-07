/**
 * Blueprint — a technical drafting grid as the `blueprint` Mosaic style. Each block
 * below pins one rule from the checklist in lib/compositor/blueprint. Not a playgrnd
 * port: the rules are derived from a reference drafting grid, so the tests assert the
 * DRAWING behaviour (grid weights, the polar fan struck from an origin, arcs, ticks,
 * angle labels) rather than a line-for-line match with any source.
 */
import { describe, it, expect } from 'vitest'
import {
  BLUEPRINT_LIMITS, BLUEPRINT_PALETTE_PRESETS, BLUEPRINT_PRESET_NAMES, BLUEPRINT_CORNERS, BLUEPRINT_DASH,
  defaultBlueprint, normalizeBlueprint, blueprintPresetPatch, blueprintPresetOf,
  blueprintFanBase, blueprintOrigin, blueprintSpokes, blueprintArcs, blueprintTicks,
  blueprintWeights, paintBlueprint,
  type BlueprintParams, type BlueprintCtx,
} from '~/lib/compositor/blueprint'
import { dealVocabDrivesLook } from '~/lib/compositor/dealVocab'
import { applyCompositorCommand, describeCompositor, impliedDealFill, type CompositorState } from '~/lib/agent/surfaces/compositor'

const P = (over: Partial<BlueprintParams> = {}): BlueprintParams => ({ ...defaultBlueprint(), ...over })

// ── Params, limits, palettes ─────────────────────────────────────────────────
describe('params and palettes', () => {
  it('ships sane slider ranges and starting values', () => {
    expect(BLUEPRINT_LIMITS).toEqual({
      cells: [6, 64], major: [2, 12], minorAlpha: [0, 1], majorWidth: [1, 3],
      originX: [-0.5, 0.5], originY: [-0.5, 0.5], angleStart: [0, 90], angleStep: [5, 45],
      angleSpread: [15, 360], arcs: [0, 10], arcGap: [0.05, 0.6], tickStep: [1, 30], labels: [0, 1],
      spokeWidth: [0.25, 4], arcWidth: [0.25, 4], tickWidth: [0.25, 4], dashScale: [0.3, 3],
    })
    const d = defaultBlueprint()
    expect(d).toMatchObject({
      cells: 32, major: 5, minorAlpha: 0.5, majorWidth: 1.6, corner: 'bl',
      originX: 0, originY: 0, angleStart: 0, angleStep: 15, angleSpread: 90,
      arcs: 4, arcGap: 0.22, tickStep: 5, labels: 1,
    })
    // The default palette is the reference blueprint green.
    expect(d.paper).toBe(BLUEPRINT_PALETTE_PRESETS.Blueprint.paper)
    expect(d.ink).toBe(BLUEPRINT_PALETTE_PRESETS.Blueprint.ink)
    expect(d.inkDim).toBe(BLUEPRINT_PALETTE_PRESETS.Blueprint.inkDim)
  })

  it('normalizeBlueprint clamps every dial, rounds the whole-number ones and cuts ink alpha', () => {
    const n = normalizeBlueprint({
      cells: 999, major: 0, minorAlpha: 5, majorWidth: -1, corner: 'nonsense',
      originX: 9, originY: -9, angleStart: 999, angleStep: 1, angleSpread: 1e6,
      arcs: -3, arcGap: 99, tickStep: 0, labels: 2,
      paper: '#112233ff', ink: '#AABBCCdd', inkDim: 'not-a-colour',
    })
    expect(n).toMatchObject({
      cells: 64, major: 2, minorAlpha: 1, majorWidth: 1, corner: 'bl',
      originX: 0.5, originY: -0.5, angleStart: 90, angleStep: 5, angleSpread: 360,
      arcs: 0, arcGap: 0.6, tickStep: 1, labels: 1,
    })
    expect(n.paper).toBe('#112233')            // alpha cut: an ink is opaque
    expect(n.ink).toBe('#AABBCC')
    expect(n.inkDim).toBe(defaultBlueprint().inkDim)   // junk falls back to the base
    // Nothing sensible at all falls back to the defaults entirely.
    expect(normalizeBlueprint(null)).toEqual(defaultBlueprint())
    // A valid corner survives.
    expect(normalizeBlueprint({ corner: 'tr' }).corner).toBe('tr')
    expect((BLUEPRINT_CORNERS as readonly string[])).toEqual(['auto', 'bl', 'br', 'tr', 'tl', 'center'])
  })

  it('offers named palettes of paper + ink (+ inkDim), and every one round-trips', () => {
    expect(BLUEPRINT_PRESET_NAMES.length).toBeGreaterThanOrEqual(5)
    for (const name of BLUEPRINT_PRESET_NAMES) {
      const pal = BLUEPRINT_PALETTE_PRESETS[name]
      for (const c of [pal.paper, pal.ink, pal.inkDim]) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/)
      expect(blueprintPresetOf(P(blueprintPresetPatch(name)))).toBe(name)
    }
    // A custom trio matches no preset.
    expect(blueprintPresetOf(P({ paper: '#000000', ink: '#ffffff', inkDim: '#808080' }))).toBeNull()
  })
})

// ── The origin struck from a corner ──────────────────────────────────────────
describe('blueprintOrigin — a point in box fractions, seeded off a corner', () => {
  it('the default corner sits just outside the bottom-left, below the box', () => {
    const o = blueprintOrigin(12, P())
    expect(o.x).toBeLessThanOrEqual(0)           // left of / on the left edge
    expect(o.y).toBeGreaterThan(1)               // below the bottom edge
  })

  it('each fixed corner lands its origin just outside that corner', () => {
    expect(blueprintOrigin(3, P({ corner: 'tl' })).y).toBeLessThan(0)
    expect(blueprintOrigin(3, P({ corner: 'tr' })).x).toBeGreaterThan(1)
    expect(blueprintOrigin(3, P({ corner: 'br' })).x).toBeGreaterThan(1)
    expect(blueprintOrigin(3, P({ corner: 'br' })).y).toBeGreaterThan(1)
  })

  it('the origin dials nudge the seeded point', () => {
    const a = blueprintOrigin(7, P({ corner: 'bl' }))
    const b = blueprintOrigin(7, P({ corner: 'bl', originX: 0.2, originY: -0.3 }))
    expect(b.x - a.x).toBeCloseTo(0.2, 9)
    expect(b.y - a.y).toBeCloseTo(-0.3, 9)
  })

  it('two seeds give two origins; the same seed repeats exactly', () => {
    const a = blueprintOrigin(1, P()), b = blueprintOrigin(2, P()), c = blueprintOrigin(1, P())
    expect(a).toEqual(c)
    expect(a).not.toEqual(b)
  })

  it("'auto' lets the seed pick the corner, so some seed opens each way", () => {
    const corners = new Set<string>()
    for (let s = 0; s < 40; s++) {
      const o = blueprintOrigin(s, P({ corner: 'auto' }))
      corners.add(`${o.x < 0.5 ? 'l' : 'r'}${o.y < 0.5 ? 't' : 'b'}`)
    }
    expect(corners.size).toBeGreaterThan(1)      // not every seed opens from the same corner
  })
})

// ── The radial fan ───────────────────────────────────────────────────────────
describe('blueprintFanBase — the corner orients the fan into the box', () => {
  it('is 90° per corner, anticlockwise from the bottom-left', () => {
    expect(blueprintFanBase('bl')).toBe(0)
    expect(blueprintFanBase('br')).toBe(90)
    expect(blueprintFanBase('tr')).toBe(180)
    expect(blueprintFanBase('tl')).toBe(270)
  })
})

describe('blueprintSpokes — one spoke every angleStep across the spread', () => {
  it('runs from angleStart across the spread, both ends included, at the step', () => {
    const s = blueprintSpokes(12, P({ angleStart: 0, angleStep: 15, angleSpread: 90 }))
    expect(s.map(x => x.localDeg)).toEqual([0, 15, 30, 45, 60, 75, 90])
    // The label reads the LOCAL angle, not the screen angle.
    expect(s.map(x => x.label)).toEqual(['0°', '15°', '30°', '45°', '60°', '75°', '90°'])
  })

  it('adds the corner base to get the screen angle and a screen-space direction', () => {
    const s = blueprintSpokes(12, P({ corner: 'br', angleStart: 0, angleStep: 45, angleSpread: 90 }))
    // br base is 90°, so screen angles are 90, 135, 180.
    expect(s.map(x => x.screenDeg)).toEqual([90, 135, 180])
    // screenDeg 90 points straight up (screen y is down): dir ≈ (0, -1).
    expect(s[0]!.dir.x).toBeCloseTo(0, 9)
    expect(s[0]!.dir.y).toBeCloseTo(-1, 9)
    // screenDeg 180 points left: dir ≈ (-1, 0).
    expect(s[2]!.dir.x).toBeCloseTo(-1, 9)
    expect(s[2]!.dir.y).toBeCloseTo(0, 9)
  })

  it('a full 360 spread closes the ring without repeating 0°', () => {
    const s = blueprintSpokes(12, P({ angleStart: 0, angleStep: 45, angleSpread: 360 }))
    expect(s.length).toBe(8)                              // 360 / 45, no wrap-around duplicate
    expect(s.map(x => x.localDeg)).toEqual([0, 45, 90, 135, 180, 225, 270, 315])
    expect(s.map(x => x.localDeg)).not.toContain(360)
  })
})

// ── Arcs, ticks ──────────────────────────────────────────────────────────────
describe('blueprintArcs — concentric arcs at an even step', () => {
  it('are evenly spaced by arcGap and there are `arcs` of them', () => {
    const four = blueprintArcs(P({ arcs: 4, arcGap: 0.2 }))
    expect(four.length).toBe(4)
    four.forEach((r, i) => expect(r).toBeCloseTo(0.2 * (i + 1), 9))
    expect(blueprintArcs(P({ arcs: 0 }))).toEqual([])
    const r = blueprintArcs(P({ arcs: 6, arcGap: 0.15 }))
    expect(r.length).toBe(6)
    for (let i = 1; i < r.length; i++) expect(r[i]! - r[i - 1]!).toBeCloseTo(0.15, 9)
  })
})

describe('blueprintTicks — hatch marks along the fan at a tick interval', () => {
  it('are one every tickStep across the spread', () => {
    expect(blueprintTicks(P({ angleStart: 0, tickStep: 15, angleSpread: 90 }))).toEqual([0, 15, 30, 45, 60, 75, 90])
    expect(blueprintTicks(P({ angleStart: 0, tickStep: 30, angleSpread: 90 }))).toEqual([0, 30, 60, 90])
    // Finer than the spokes.
    expect(blueprintTicks(P({ tickStep: 5, angleSpread: 90 })).length)
      .toBeGreaterThan(blueprintSpokes(12, P({ angleStep: 15, angleSpread: 90 })).length)
  })
})

// ── Weights ──────────────────────────────────────────────────────────────────
describe('blueprintWeights — a thin minor, a heavier major', () => {
  it('the minor is ~min(W,H)/2400 floored at 1, the major is majorWidth× the minor', () => {
    const w = blueprintWeights(2400, 2400, P({ majorWidth: 1.6 }))
    expect(w.minor).toBeCloseTo(1, 6)
    expect(w.major).toBeCloseTo(1.6, 6)
    // A small box floors the minor at 1 box unit so it never vanishes.
    expect(blueprintWeights(600, 600, P()).minor).toBe(1)
    // A big export scales the minor up.
    expect(blueprintWeights(4800, 4800, P()).minor).toBeCloseTo(2, 6)
    // The major always outweighs the minor.
    expect(w.major).toBeGreaterThan(w.minor)
  })
})

// ── Paint ────────────────────────────────────────────────────────────────────
type Op =
  | { op: 'fillRect'; x: number; y: number; w: number; h: number; style: string }
  | { op: 'stroke'; style: string; width: number; dash: number[]; segs: number }
  | { op: 'arc'; cx: number; cy: number; r: number; style: string; width: number; dash: number[] }
  | { op: 'text'; text: string; x: number; y: number; style: string }

function recorder() {
  const ops: Op[] = []
  let pending = 0
  let dash: number[] = []
  const ctx = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    font: '', textAlign: 'start', textBaseline: 'alphabetic',
    setLineDash(d: number[]) { dash = [...d] },
    beginPath() { pending = 0 },
    moveTo() { pending++ },
    lineTo() { pending++ },
    fillRect(x: number, y: number, w: number, h: number) {
      ops.push({ op: 'fillRect', x, y, w, h, style: String(ctx.fillStyle) })
    },
    arc(cx: number, cy: number, r: number) {
      ops.push({ op: 'arc', cx, cy, r, style: String(ctx.strokeStyle), width: ctx.lineWidth, dash: [...dash] })
    },
    stroke() {
      if (pending > 0) ops.push({ op: 'stroke', style: String(ctx.strokeStyle), width: ctx.lineWidth, dash: [...dash], segs: pending })
      pending = 0
    },
    fill() {},
    fillText(text: string, x: number, y: number) {
      ops.push({ op: 'text', text, x, y, style: String(ctx.fillStyle) })
    },
    save() {}, restore() {},
  }
  return { ctx: ctx as unknown as BlueprintCtx, ops }
}

describe('paintBlueprint', () => {
  const W = 900, H = 900

  it('grounds the whole box in the paper colour first', () => {
    const rec = recorder()
    const d = defaultBlueprint()
    paintBlueprint(rec.ctx, d, W, H, 12)
    expect(rec.ops[0]).toMatchObject({ op: 'fillRect', x: 0, y: 0, w: W, h: H })
    expect((rec.ops[0] as any).style.toLowerCase()).toContain('rgb')     // rgba(paper)
  })

  it('draws the minor grid dimmer and thinner than the major grid', () => {
    const rec = recorder()
    paintBlueprint(rec.ctx, P(), W, H, 12)
    const strokes = rec.ops.filter(o => o.op === 'stroke') as Extract<Op, { op: 'stroke' }>[]
    const alpha = (rgba: string) => Number(rgba.split(',')[3]?.replace(')', '') ?? '1')
    // The minor grid is the only dash-free stroke at minorAlpha (0.5); the major grid
    // is the only dash-free full-strength stroke (arcs 0.9, ticks 0.9, spokes 0.7).
    const minor = strokes.find(s => s.dash.length === 0 && Math.abs(alpha(s.style) - 0.5) < 0.02)!
    const major = strokes.find(s => s.dash.length === 0 && alpha(s.style) === 1)!
    expect(minor).toBeDefined()
    expect(major).toBeDefined()
    expect(minor.width).toBeLessThan(major.width)
  })

  it('strikes dashed spokes and solid arcs from the origin', () => {
    const rec = recorder()
    paintBlueprint(rec.ctx, P({ arcs: 4, angleStep: 15, angleSpread: 90 }), W, H, 12)
    const dashed = rec.ops.filter(o => o.op === 'stroke' && (o as any).dash.length > 0)
    expect(dashed.length).toBeGreaterThan(0)            // spokes are dashed
    const arcs = rec.ops.filter(o => o.op === 'arc') as Extract<Op, { op: 'arc' }>[]
    expect(arcs.length).toBe(4)                         // one path per concentric arc
    // Arcs are struck from the same origin.
    const o = blueprintOrigin(12, P())
    expect(arcs[0]!.cx).toBeCloseTo(o.x * W, 6)
    expect(arcs[0]!.cy).toBeCloseTo(o.y * H, 6)
    // Their radii grow evenly.
    const rs = arcs.map(a => a.r)
    for (let i = 1; i < rs.length; i++) expect(rs[i]! - rs[i - 1]!).toBeGreaterThan(0)
  })

  it('leaves the line dash reset after the dashed spokes', () => {
    // After paint, a fresh solid stroke must not inherit the spokes' dash: the last
    // setLineDash the paint issues is an empty one.
    const rec = recorder()
    let lastDashEmpty = false
    const spy = rec.ctx as any
    const orig = spy.setLineDash
    spy.setLineDash = (d: number[]) => { lastDashEmpty = d.length === 0; orig.call(spy, d) }
    paintBlueprint(rec.ctx, P(), W, H, 12)
    expect(lastDashEmpty).toBe(true)
  })

  it('labels each spoke with its angle when labels are on, and none when off', () => {
    const on = recorder()
    paintBlueprint(on.ctx, P({ labels: 1, angleStep: 15, angleSpread: 90 }), W, H, 12)
    const texts = on.ops.filter(o => o.op === 'text').map(o => (o as any).text)
    expect(texts).toContain('15°')
    expect(texts).toContain('30°')
    expect(texts).toContain('45°')
    const off = recorder()
    paintBlueprint(off.ctx, P({ labels: 0 }), W, H, 12)
    expect(off.ops.some(o => o.op === 'text')).toBe(false)
  })

  it('never writes an absolute globalAlpha or composite op — alpha is baked into rgba inks', () => {
    const rec = recorder()
    const writes: string[] = []
    const guarded = new Proxy(rec.ctx as unknown as Record<string, unknown>, {
      set(t, k, v) { if (k === 'globalAlpha' || k === 'globalCompositeOperation') writes.push(String(k)); t[k as string] = v; return true },
    }) as unknown as BlueprintCtx
    ;(rec.ctx as any).globalAlpha = 0.5
    paintBlueprint(guarded, P(), W, H, 12)
    expect(writes).toEqual([])
    expect((rec.ctx as any).globalAlpha).toBe(0.5)     // untouched
  })

  it('two seeds are two pictures (the polar overlay moves); the same seed repeats', () => {
    const a = recorder(), b = recorder(), c = recorder()
    paintBlueprint(a.ctx, P({ corner: 'auto' }), W, H, 1)
    paintBlueprint(b.ctx, P({ corner: 'auto' }), W, H, 2)
    paintBlueprint(c.ctx, P({ corner: 'auto' }), W, H, 1)
    expect(JSON.stringify(a.ops)).toBe(JSON.stringify(c.ops))
    expect(JSON.stringify(a.ops)).not.toBe(JSON.stringify(b.ops))
  })

  it('survives the awkward corners without throwing or emitting junk', () => {
    for (const over of [
      { arcs: 0 }, { arcs: 10 }, { labels: 0 }, { angleSpread: 360 }, { angleSpread: 15 },
      { cells: 6 }, { cells: 64 }, { corner: 'tl' as const }, { corner: 'tr' as const },
      { corner: 'auto' as const }, { originX: 0.5, originY: 0.5 }, { major: 2 }, { major: 12 },
      { paper: '#101010', ink: '#efefef', inkDim: '#101010' },
    ]) {
      for (const [bw, bh] of [[900, 900], [640, 1000], [1600, 400], [30, 24]]) {
        const rec = recorder()
        expect(() => paintBlueprint(rec.ctx, P(over as Partial<BlueprintParams>), bw!, bh!, 7), JSON.stringify(over)).not.toThrow()
        expect(rec.ops.length).toBeGreaterThan(0)
        for (const o of rec.ops) {
          if (o.op === 'fillRect') { expect(Number.isFinite(o.x)).toBe(true); expect(o.w).toBeGreaterThanOrEqual(0) }
          if (o.op === 'arc') expect(o.r).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })
})

// ── Agent / inspector seams ──────────────────────────────────────────────────
describe('blueprint plugs into the mosaic op and the vocab gate', () => {
  const baseState = (): CompositorState => ({ layers: [] } as unknown as CompositorState)

  it('a lone blueprint tunables object, or its palette name, implies the style', () => {
    expect(impliedDealFill({ blueprint: {} })).toBe('blueprint')
    expect(impliedDealFill({ palettePreset: 'Blueprint' })).toBe('blueprint')
  })

  it('creating with style blueprint lands a blueprint deal that carries its own colours', () => {
    const r = applyCompositorCommand(baseState(), { op: 'mosaic', args: { id: 'dd', style: 'blueprint' } } as any)
    expect(r.ok).toBe(true)
    const layer = (r as any).template.layers[0]
    expect(layer.cellFill).toBe('blueprint')
    expect(dealVocabDrivesLook({ cellFill: 'blueprint' })).toBe(false)
    // describeCompositor names the preset under the look key and hides the raw ink fields.
    const desc = describeCompositor((r as any).template).objects.find((x: any) => x.id === 'dd')!.current as Record<string, any>
    expect(desc.style).toBe('blueprint')
    expect(desc.blueprint.palettePreset).toBe('Blueprint')
    expect(desc.blueprint).not.toHaveProperty('paper')
    expect(desc.blueprint.arcs).toBe(defaultBlueprint().arcs)
  })
})

describe('centre origin — concentric circles from the middle', () => {
  const P = (over = {}) => ({ ...defaultBlueprint(), ...over })
  it('sits at the box centre plus the hand nudge, with NO seeded outward offset', () => {
    // out=(0,0) at centre, so the seeded offset multiplies to zero: the origin is exactly
    // the centre, and identical across seeds (a diagram, not a re-rollable scatter).
    expect(blueprintOrigin(3, P({ corner: 'center' }))).toEqual({ x: 0.5, y: 0.5 })
    expect(blueprintOrigin(999, P({ corner: 'center' }))).toEqual({ x: 0.5, y: 0.5 })
    expect(blueprintOrigin(3, P({ corner: 'center', originX: 0.2, originY: -0.1 }))).toEqual({ x: 0.7, y: 0.4 })
  })
  it('the fan base is 0 (first spoke east), so angleStart is the only rotation', () => {
    expect(blueprintFanBase('center')).toBe(0)
    const s = blueprintSpokes(3, P({ corner: 'center', angleStart: 0 }))[0]!
    expect(s.dir.x).toBeCloseTo(1, 6); expect(s.dir.y).toBeCloseTo(0, 6)
  })
  it('Spread 360 rings the whole circle: 360/step spokes evenly around the centre', () => {
    const spokes = blueprintSpokes(3, P({ corner: 'center', angleSpread: 360, angleStep: 15 }))
    expect(spokes).toHaveLength(24)
    // the fan closes without a duplicate at 360, and the concentric arcs are still even.
    const radii = blueprintArcs(P({ corner: 'center', arcs: 4, arcGap: 0.2 }))
    expect(radii).toHaveLength(4)
    radii.forEach((r, i) => expect(r).toBeCloseTo(0.2 * (i + 1), 6))
  })
})

describe('per-type stroke width and line style', () => {
  const W = 900, H = 900
  const minorBase = Math.max(1, Math.min(W, H) / 2400)   // the paint floors the minor line at 1px
  const P = (over = {}) => ({ ...defaultBlueprint(), ...over })
  const alpha = (rgba: string) => Number(rgba.split(',')[3]?.replace(')', '') ?? '1')

  it('exposes solid | dashed and keeps the original look by default', () => {
    expect((BLUEPRINT_DASH as readonly string[])).toEqual(['solid', 'dashed'])
    expect(defaultBlueprint()).toMatchObject({
      spokeWidth: 1, arcWidth: 1.6, tickWidth: 1, dashScale: 1,
      gridDash: 'solid', spokeDash: 'dashed', arcDash: 'solid', tickDash: 'solid',
    })
  })

  it('clamps widths and rejects an unknown line style back to the base', () => {
    const n = normalizeBlueprint({ spokeWidth: 99, arcWidth: -1, tickWidth: 0, dashScale: 9, spokeDash: 'wavy', arcDash: 'dashed' })
    expect(n.spokeWidth).toBe(4); expect(n.arcWidth).toBe(0.25); expect(n.tickWidth).toBe(0.25); expect(n.dashScale).toBe(3)
    expect(n.spokeDash).toBe('dashed')   // unknown 'wavy' falls back to the default (dashed)
    expect(n.arcDash).toBe('dashed')     // a valid override is kept
  })

  it('paints each type at its own width', () => {
    const rec = recorder()
    paintBlueprint(rec.ctx, P({ spokeWidth: 3, arcWidth: 2, arcs: 3 }), W, H, 12)
    const strokes = rec.ops.filter(o => o.op === 'stroke') as Extract<Op, { op: 'stroke' }>[]
    const spoke = strokes.find(s => Math.abs(alpha(s.style) - 0.7) < 0.02)!   // spokes are the 0.7-alpha stroke
    expect(spoke.width).toBeCloseTo(minorBase * 3, 6)
    const arcs = rec.ops.filter(o => o.op === 'arc') as Extract<Op, { op: 'arc' }>[]
    expect(arcs[0]!.width).toBeCloseTo(minorBase * 2, 6)
  })

  it('switches each type between solid and dashed independently', () => {
    // Default: spokes dashed, arcs solid.
    let rec = recorder()
    paintBlueprint(rec.ctx, P({ arcs: 3 }), W, H, 12)
    let spoke = (rec.ops.filter(o => o.op === 'stroke') as any[]).find(s => Math.abs(alpha(s.style) - 0.7) < 0.02)!
    let arc = (rec.ops.filter(o => o.op === 'arc') as any[])[0]!
    expect(spoke.dash.length).toBeGreaterThan(0); expect(arc.dash.length).toBe(0)
    // Flip them: solid spokes, dashed arcs.
    rec = recorder()
    paintBlueprint(rec.ctx, P({ arcs: 3, spokeDash: 'solid', arcDash: 'dashed' }), W, H, 12)
    spoke = (rec.ops.filter(o => o.op === 'stroke') as any[]).find(s => Math.abs(alpha(s.style) - 0.7) < 0.02)!
    arc = (rec.ops.filter(o => o.op === 'arc') as any[])[0]!
    expect(spoke.dash.length).toBe(0); expect(arc.dash.length).toBeGreaterThan(0)
  })

  it('dash scale lengthens the dash pattern of every dashed stroke', () => {
    const at = (scale: number) => {
      const rec = recorder()
      paintBlueprint(rec.ctx, P({ dashScale: scale }), W, H, 12)
      return (rec.ops.filter(o => o.op === 'stroke') as any[]).find(s => Math.abs(alpha(s.style) - 0.7) < 0.02)!.dash
    }
    const a = at(1), b = at(2)
    expect(b[0]).toBeCloseTo(a[0] * 2, 6); expect(b[1]).toBeCloseTo(a[1] * 2, 6)
  })

  it('never leaves a dash set after the paint (host rule)', () => {
    // The last setLineDash the paint issues must be empty, so a solid grid never
    // inherits the polar overlay's dash on the next layer.
    let lastDash: number[] = [1]
    const rec = recorder()
    ;(rec.ctx as any).setLineDash = (d: number[]) => { lastDash = [...d] }
    paintBlueprint(rec.ctx, P({ arcs: 3, gridDash: 'dashed', arcDash: 'dashed', tickDash: 'dashed' }), W, H, 12)
    expect(lastDash).toEqual([])
  })
})

