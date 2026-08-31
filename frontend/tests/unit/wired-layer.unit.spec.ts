import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from 'vitest'
import { reactive } from 'vue'
import {
  createWiredLayer, wiredBoxFromWidgets, widgetsFromWiredBox,
  syncWiredWidgets, syncAllWiredWidgets,
} from '~/lib/compositor/wiredLayer'
import { widgetNum, setWidget, type WidgetHostData } from '~/lib/compositor/nodeWidgets'
import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'
import {
  _registerWiredContent, localLayerBox, paintLayerStack,
  type LocalLayer, type WiredLayer,
} from '~/composables/useCompositorLayers'
import { DEFAULT_CLONER } from '~/composables/useCloner'
import { getClipboard, _resetClipboard } from '~/lib/compositor/layerClipboard'

describe('wired layer mapping', () => {
  const natural = { w: 800, h: 600 }          // content pixels
  const canvas = { w: 1024, h: 1024 }

  it('creates a wired layer with defaults matching the old default placement', () => {
    const l = createWiredLayer(3)
    expect(l.kind).toBe('wired')
    expect(l.slot).toBe(3)
    expect(l.x).toBeCloseTo(0.5)
    expect(l.y).toBeCloseTo(0.5)
    expect(l.rotation).toBe(0)
    expect(l.opacity).toBe(1)
  })

  it('round-trips widget transform -> box -> widget transform', () => {
    const tf = { x: 0.1, y: -0.2, rotation: 15, scale: 1.5, opacity: 0.8 }
    const box = wiredBoxFromWidgets(tf, natural, canvas)
    const back = widgetsFromWiredBox({ ...createWiredLayer(0), ...box }, natural, canvas)
    expect(back.x).toBeCloseTo(tf.x, 5)
    expect(back.y).toBeCloseTo(tf.y, 5)
    expect(back.rotation).toBeCloseTo(tf.rotation, 5)
    expect(back.scale).toBeCloseTo(tf.scale, 5)
    expect(back.opacity).toBeCloseTo(tf.opacity, 5)
  })

  it('identity transform maps to the same box the old fit-draw produced', () => {
    // scale=1, x=y=0 must reproduce the legacy "fit to canvas" box so migrated
    // frames render pixel-identically.
    const box = wiredBoxFromWidgets({ x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 }, natural, canvas)
    expect(box.x).toBeCloseTo(0.5)
    expect(box.y).toBeCloseTo(0.5)
    // 800x600 in 1024x1024: fit => width-limited => w = 1 (full canvas width)
    expect(box.w).toBeCloseTo(1)
  })

  it('height-limited fit matches the legacy contain math', () => {
    // 600x800 (portrait) in 1024x1024: iAspect < cAspect => height-limited, so
    // fitH = H and fitW = H * iAspect => normalized w = 0.75.
    const box = wiredBoxFromWidgets({ x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 }, { w: 600, h: 800 }, canvas)
    expect(box.w).toBeCloseTo(0.75)
    expect(box.lastAspect).toBeCloseTo(800 / 600)
  })

  it('records the content aspect so the unlinked state keeps its last size', () => {
    const box = wiredBoxFromWidgets({ x: 0, y: 0, rotation: 0, scale: 1, opacity: 1 }, natural, canvas)
    expect(box.lastAspect).toBeCloseTo(600 / 800)
  })

  it('round-trips on a non-square canvas', () => {
    const wide = { w: 1920, h: 1080 }
    const tf = { x: -0.33, y: 0.07, rotation: -42, scale: 0.65, opacity: 0.4 }
    const box = wiredBoxFromWidgets(tf, natural, wide)
    const back = widgetsFromWiredBox({ ...createWiredLayer(1), ...box }, natural, wide)
    expect(back.x).toBeCloseTo(tf.x, 5)
    expect(back.y).toBeCloseTo(tf.y, 5)
    expect(back.scale).toBeCloseTo(tf.scale, 5)
  })

  it('gives each created layer a distinct id', () => {
    expect(createWiredLayer(0).id).not.toBe(createWiredLayer(0).id)
  })
})

// ── Paint dispatch (Task 2) ──────────────────────────────────────────────────
//
// These run in vitest's default `node` environment: there is no DOM and no real
// 2D context anywhere in this repo's unit suite (node-canvas is not a dependency
// and happy-dom's canvas does not rasterize), so a pixel-probe test is not
// available. The repo's existing pattern for canvas code is a stub context
// (see tests/unit/spacetype-canvas2d-branch.unit.spec.ts); this extends it into
// a RECORDING context that tracks the full affine transform stack, so what is
// asserted is the real device-space geometry of the draw — the same thing a
// pixel probe would establish — rather than the raw drawImage arguments.

interface DrawRecord { cx: number; cy: number; w: number; h: number; alpha: number; op: string; src: unknown }

/** A CanvasRenderingContext2D stand-in that tracks [a,b,c,d,e,f] through
 *  save/restore/translate/rotate/scale and records each drawImage in DEVICE space. */
function recordingCtx(devW = 100, devH = 100) {
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const stack: (typeof m)[] = []
  const draws: DrawRecord[] = []
  const apply = (x: number, y: number) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f })
  const ctx: any = {
    canvas: { width: devW, height: devH },
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    filter: 'none',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    save() { stack.push({ ...m }) },
    restore() { const p = stack.pop(); if (p) m = p },
    translate(tx: number, ty: number) { m.e += m.a * tx + m.c * ty; m.f += m.b * tx + m.d * ty },
    scale(sx: number, sy: number) { m.a *= sx; m.b *= sx; m.c *= sy; m.d *= sy },
    rotate(r: number) {
      const cos = Math.cos(r), sin = Math.sin(r)
      const a = m.a * cos + m.c * sin, b = m.b * cos + m.d * sin
      const c = m.a * -sin + m.c * cos, d = m.b * -sin + m.d * cos
      m.a = a; m.b = b; m.c = c; m.d = d
    },
    transform() { /* skew — unused by these cases */ },
    setTransform(a: any, b?: number, c?: number, d?: number, e?: number, f?: number) {
      m = typeof a === 'object' ? { ...a } : { a, b: b!, c: c!, d: d!, e: e!, f: f! }
    },
    getTransform() { return { ...m } },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, rect() {}, roundRect() {},
    ellipse() {}, clip() {}, fill() {}, stroke() {}, fillRect() {}, clearRect() {},
    drawImage(src: unknown, dx: number, dy: number, dw: number, dh: number) {
      const ctr = apply(dx + dw / 2, dy + dh / 2)
      draws.push({
        cx: ctr.x, cy: ctr.y,
        w: dw * Math.hypot(m.a, m.b), h: dh * Math.hypot(m.c, m.d),
        alpha: ctx.globalAlpha, op: ctx.globalCompositeOperation, src,
      })
    },
  }
  return { ctx: ctx as CanvasRenderingContext2D, draws }
}

/** A stand-in for the host's live content: anything with numeric width/height is a
 *  CanvasImageSource as far as the renderer is concerned. */
const content = (w: number, h: number) => ({ width: w, height: h } as unknown as CanvasImageSource)

function paint(ctx: CanvasRenderingContext2D, layer: LocalLayer, W = 100, H = 100) {
  paintLayerStack(ctx, W, H, [{ type: 'local', key: `l:${layer.id}`, layer }], [layer])
}

describe('wired layer paint dispatch', () => {
  afterEach(() => { _registerWiredContent(null) })

  const wired = (partial: Partial<WiredLayer> = {}): WiredLayer =>
    createWiredLayer(0, { x: 0.5, y: 0.5, w: 0.5, lastAspect: 0.5, ...partial })

  it('draws the registered provider content into the layer box', () => {
    _registerWiredContent(() => content(200, 100))     // 2:1 ⇒ aspect 0.5
    const { ctx, draws } = recordingCtx()
    paint(ctx, wired())
    expect(draws).toHaveLength(1)
    // w = 0.5 * 100 = 50px; h = 50 * 0.5 = 25px; centred at (0.5*100, 0.5*100).
    expect(draws[0]!.cx).toBeCloseTo(50, 5)
    expect(draws[0]!.cy).toBeCloseTo(50, 5)
    expect(draws[0]!.w).toBeCloseTo(50, 5)
    expect(draws[0]!.h).toBeCloseTo(25, 5)
  })

  it('honours the layer centre like every other layer kind', () => {
    _registerWiredContent(() => content(200, 100))
    const { ctx, draws } = recordingCtx()
    paint(ctx, wired({ x: 0.25, y: 0.75 }))
    expect(draws[0]!.cx).toBeCloseTo(25, 5)
    expect(draws[0]!.cy).toBeCloseTo(75, 5)
  })

  it('draws nothing when no provider is registered', () => {
    const { ctx, draws } = recordingCtx()
    paint(ctx, wired())
    expect(draws).toHaveLength(0)
  })

  it('draws nothing (not a placeholder) when the provider returns null', () => {
    _registerWiredContent(() => null)
    const { ctx, draws } = recordingCtx()
    paint(ctx, wired({ unlinked: true }))
    expect(draws).toHaveLength(0)
  })

  it('uses the LIVE content aspect when it differs from lastAspect', () => {
    _registerWiredContent(() => content(100, 200))     // live aspect 2 …
    const { ctx, draws } = recordingCtx()
    paint(ctx, wired({ lastAspect: 0.5 }))             // … stale cached aspect 0.5
    expect(draws[0]!.h).toBeCloseTo(100, 5)            // 50 * 2, not 50 * 0.5
  })

  it('does not mutate the layer while painting (paint stays pure)', () => {
    _registerWiredContent(() => content(100, 200))
    const { ctx } = recordingCtx()
    const layer = wired({ lastAspect: 0.5 })
    paint(ctx, layer)
    expect(layer.lastAspect).toBe(0.5)
  })

  it('keeps lastAspect for an unlinked layer even when live content differs', () => {
    _registerWiredContent(() => content(100, 200))     // live aspect 2
    const { ctx, draws } = recordingCtx()
    paint(ctx, wired({ lastAspect: 0.5, unlinked: true }))
    expect(draws[0]!.h).toBeCloseTo(25, 5)             // 50 * 0.5 — the size the user set
  })

  it('resolves the provider on EVERY paint, so re-running upstream re-fits', () => {
    let dims = content(200, 100)
    let calls = 0
    _registerWiredContent(() => { calls++; return dims })
    const layer = wired()
    const first = recordingCtx()
    paint(first.ctx, layer)
    expect(first.draws[0]!.h).toBeCloseTo(25, 5)
    dims = content(100, 100)                            // upstream re-ran square
    const second = recordingCtx()
    paint(second.ctx, layer)
    expect(second.draws[0]!.h).toBeCloseTo(50, 5)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('folds opacity and blend through the shared LayerCommon machinery', () => {
    _registerWiredContent(() => content(200, 100))
    const { ctx, draws } = recordingCtx()
    paint(ctx, wired({ opacity: 0.4, blend: 'multiply' }))
    expect(draws[0]!.alpha).toBeCloseTo(0.4, 5)
    expect(draws[0]!.op).toBe('multiply')
  })

  it('rotates around the layer centre', () => {
    _registerWiredContent(() => content(200, 100))
    const { ctx, draws } = recordingCtx()
    paint(ctx, wired({ rotation: 90 }))
    expect(draws[0]!.cx).toBeCloseTo(50, 5)
    expect(draws[0]!.cy).toBeCloseTo(50, 5)
  })

  it('skips a hidden wired layer', () => {
    _registerWiredContent(() => content(200, 100))
    const { ctx, draws } = recordingCtx()
    paint(ctx, wired({ visible: false }))
    expect(draws).toHaveLength(0)
  })

  it('stamps once per clone through the shared cloner', () => {
    _registerWiredContent(() => content(200, 100))
    const { ctx, draws } = recordingCtx()
    paint(ctx, wired({ cloner: { ...DEFAULT_CLONER, enabled: true, countX: 3, countY: 1 } }))
    expect(draws).toHaveLength(3)
  })

  // Regression for the "resolved twice per draw" bug: paintLayer used to call the
  // wired provider once (via localLayerBox) to size a warp/DOF offscreen and again
  // (via drawLayerContent) to actually draw — separately for EVERY clone. A provider
  // that hands back a fresh surface each call (a live studio surface, not a static
  // cached image) could then size one call's dimensions and draw a differently-sized
  // one, producing a misfit warp. The corner-pin path itself needs a real 2D canvas
  // context to rasterize (this suite runs with `environment: 'node'` — no DOM, see
  // the file-level comment above), so it isn't reachable with the recordingCtx
  // stand-in; a multi-clone plain wired layer exercises the same "one resolve must
  // serve every consumer within a single paint call" contract without needing one:
  // pre-fix, each clone's draw independently re-ran the provider (N calls for N
  // clones, each potentially sized differently); post-fix, paintLayer resolves once
  // up front and threads that single result to every clone's draw.
  it('resolves the wired provider exactly once per paint, even across clones, so a provider returning different dimensions on every call cannot desync one clone from another within the same frame', () => {
    let calls = 0
    // A DIFFERENT size every call — if anything downstream re-resolved instead of
    // reusing the one paintLayer-level result, later clones would render at a
    // different size than earlier ones within this same paint.
    const sizes: [number, number][] = [[200, 100], [50, 400], [300, 30]]
    _registerWiredContent(() => content(...sizes[calls++]!))
    const { ctx, draws } = recordingCtx()
    paint(ctx, wired({ cloner: { ...DEFAULT_CLONER, enabled: true, countX: 3, countY: 1 } }))
    expect(draws).toHaveLength(3)
    expect(calls).toBe(1)
    const h0 = draws[0]!.h
    expect(draws[1]!.h).toBeCloseTo(h0, 5)
    expect(draws[2]!.h).toBeCloseTo(h0, 5)
  })

  it('bboxes a wired layer as w × w*lastAspect, centred', () => {
    const box = localLayerBox(null, wired({ w: 0.5, lastAspect: 0.5 }), 100, 100)
    expect(box.w).toBeCloseTo(50, 5)
    expect(box.h).toBeCloseTo(25, 5)
  })

  it('bboxes from the live aspect when the provider has fresher content', () => {
    _registerWiredContent(() => content(100, 200))
    const box = localLayerBox(null, wired({ w: 0.5, lastAspect: 0.5 }), 100, 100)
    expect(box.h).toBeCloseTo(100, 5)   // box tracks what actually paints
  })

  it('never produces NaN geometry from a degenerate aspect', () => {
    _registerWiredContent(() => content(0, 0))
    const { ctx, draws } = recordingCtx()
    paint(ctx, wired({ lastAspect: 0 }))
    const box = localLayerBox(null, wired({ lastAspect: 0 }), 100, 100)
    expect(Number.isFinite(box.h)).toBe(true)
    expect(draws).toHaveLength(0)       // zero-sized content is not drawable
  })

  // The migration's UNRESOLVED_WIRED_W sentinel (w: -1) must paint and measure as
  // NOTHING, not as a negative-width box — canvas drawImage FLIPS on a negative
  // width instead of skipping the draw, so a naive path would render a mirrored,
  // wrong-sized layer until the first real paint resolves it.
  it('draws nothing for a sentinel (w <= 0) wired layer, even with live content available', () => {
    _registerWiredContent(() => content(200, 100))
    const { ctx, draws } = recordingCtx()
    paint(ctx, wired({ w: -1, lastAspect: 1 }))
    expect(draws).toHaveLength(0)
  })

  it('bboxes a sentinel wired layer as a zero-size box at the layer centre', () => {
    const box = localLayerBox(null, wired({ w: -1, lastAspect: 1 }), 100, 100)
    expect(box.w).toBe(0)
    expect(box.h).toBe(0)
  })
})

// ── Widget write-through (Task 4) ────────────────────────────────────────────
//
// The Python Compositor node and the server Render path both read the legacy
// `layer{N}_*` widgets, and neither knows about the unified layer model. So the
// layer stays the single source of truth in the editor, and every mutation of a
// wired layer is MIRRORED down into its slot's widgets. One-way, on purpose:
// nothing reads the widgets back into the layer after migration.

/** Widget names in the order the Frame node type declares them, for two slots.
 *  `widgetsValues` is positionally aligned with `widgetDefs` — that alignment is
 *  the whole contract `widgetIdx` depends on. */
const FIXTURE_WIDGETS: [string, any][] = [
  ['width', 1024], ['height', 1024],
  ['layer1_x', 0], ['layer1_y', 0], ['layer1_rotation', 0], ['layer1_scale', 1],
  ['layer1_opacity', 1], ['layer1_blend', 'normal'], ['layer1_protect', true], ['layer1_z', 0],
  ['layer2_x', 0], ['layer2_y', 0], ['layer2_rotation', 0], ['layer2_scale', 1],
  ['layer2_opacity', 1], ['layer2_blend', 'normal'], ['layer2_protect', false], ['layer2_z', 1],
]

function fixtureNode(overrides: Record<string, any> = {}) {
  return {
    data: {
      widgetDefs: FIXTURE_WIDGETS.map(([name]) => ({ name })),
      widgetsValues: FIXTURE_WIDGETS.map(([name, v]) => (name in overrides ? overrides[name] : v)),
      properties: {} as Record<string, any>,
    },
  }
}
/** Read a widget back by name (the same positional lookup the hosts do). */
function wv(node: any, name: string): any {
  const i = node.data.widgetDefs.findIndex((w: any) => w.name === name)
  return i >= 0 ? node.data.widgetsValues[i] : undefined
}

describe('wired widget write-through', () => {
  const canvas = { w: 1024, h: 1024 }
  const natural = { w: 800, h: 600 }          // landscape ⇒ width-limited fit (1)

  it('writes the exact transform widgetsFromWiredBox derives', () => {
    const node = fixtureNode()
    const layer = createWiredLayer(0, { x: 0.62, y: 0.41, rotation: 23, opacity: 0.55, w: 1.4, lastAspect: 600 / 800 })
    expect(syncWiredWidgets(node, layer, canvas, natural)).toBe(true)
    const expected = widgetsFromWiredBox(layer, natural, canvas)
    expect(wv(node, 'layer1_x')).toBeCloseTo(expected.x, 6)
    expect(wv(node, 'layer1_y')).toBeCloseTo(expected.y, 6)
    expect(wv(node, 'layer1_rotation')).toBeCloseTo(expected.rotation, 6)
    expect(wv(node, 'layer1_scale')).toBeCloseTo(expected.scale, 6)
    expect(wv(node, 'layer1_opacity')).toBeCloseTo(expected.opacity, 6)
  })

  it('addresses slot N through layer{N+1}_* and leaves every other slot alone', () => {
    const node = fixtureNode()
    const layer = createWiredLayer(1, { x: 0.25, y: 0.75, w: 0.5, lastAspect: 600 / 800 })
    syncWiredWidgets(node, layer, canvas, natural)
    expect(wv(node, 'layer2_x')).toBeCloseTo(-0.25, 6)
    expect(wv(node, 'layer2_y')).toBeCloseTo(0.25, 6)
    expect(wv(node, 'layer1_x')).toBe(0)         // untouched
    expect(wv(node, 'layer1_scale')).toBe(1)
  })

  it('mirrors the blend mode, and writes "normal" when the layer has none', () => {
    const node = fixtureNode({ layer1_blend: 'screen' })
    syncWiredWidgets(node, createWiredLayer(0, { blend: 'multiply' }), canvas, natural)
    expect(wv(node, 'layer1_blend')).toBe('multiply')
    syncWiredWidgets(node, createWiredLayer(0), canvas, natural)
    expect(wv(node, 'layer1_blend')).toBe('normal')
  })

  it('never touches the protect widget (a server flag the layer model does not carry)', () => {
    const node = fixtureNode()
    syncWiredWidgets(node, createWiredLayer(0, { x: 0.9 }), canvas, natural)
    expect(wv(node, 'layer1_protect')).toBe(true)
    expect(wv(node, 'layer2_protect')).toBe(false)
  })

  it('is a NO-OP for a sentinel (w <= 0) layer — the widgets still carry the truth', () => {
    const node = fixtureNode({ layer1_x: 0.3, layer1_scale: 2 })
    const layer = createWiredLayer(0, { x: 0.5, y: 0.5, w: -1, lastAspect: 1 })
    expect(syncWiredWidgets(node, layer, canvas, natural)).toBe(false)
    expect(wv(node, 'layer1_x')).toBe(0.3)
    expect(wv(node, 'layer1_scale')).toBe(2)
  })

  it('derives the fit from lastAspect when the host supplies no content dims', () => {
    const node = fixtureNode()
    const portrait = { w: 600, h: 800 }
    const layer = createWiredLayer(0, { x: 0.5, y: 0.5, w: 0.6, lastAspect: 800 / 600 })
    syncWiredWidgets(node, layer, canvas)                       // no natural dims
    const withDims = fixtureNode()
    syncWiredWidgets(withDims, layer, canvas, portrait)
    expect(wv(node, 'layer1_scale')).toBeCloseTo(wv(withDims, 'layer1_scale'), 10)
    expect(wv(node, 'layer1_scale')).toBeCloseTo(0.6 / 0.75, 6)  // portrait fit = 0.75
  })

  it('prefers the host content dims over a stale lastAspect', () => {
    const node = fixtureNode()
    const layer = createWiredLayer(0, { w: 0.6, lastAspect: 1 })  // stale square cache
    syncWiredWidgets(node, layer, canvas, { w: 600, h: 800 })     // live portrait
    expect(wv(node, 'layer1_scale')).toBeCloseTo(0.6 / 0.75, 6)
  })

  it('round-trips a legacy transform untouched through box → widgets', () => {
    const node = fixtureNode()
    const tf = { x: 0.12, y: -0.08, rotation: -30, scale: 0.66, opacity: 0.9 }
    const box = wiredBoxFromWidgets(tf, natural, canvas)
    syncWiredWidgets(node, createWiredLayer(0, box), canvas, natural)
    expect(wv(node, 'layer1_x')).toBeCloseTo(tf.x, 6)
    expect(wv(node, 'layer1_y')).toBeCloseTo(tf.y, 6)
    expect(wv(node, 'layer1_rotation')).toBeCloseTo(tf.rotation, 6)
    expect(wv(node, 'layer1_scale')).toBeCloseTo(tf.scale, 6)
    expect(wv(node, 'layer1_opacity')).toBeCloseTo(tf.opacity, 6)
  })

  it('is a no-op (never throws) when the node has no widget arrays at all', () => {
    expect(syncWiredWidgets({ data: {} } as any, createWiredLayer(0), canvas, natural)).toBe(false)
    expect(syncWiredWidgets(null as any, createWiredLayer(0), canvas, natural)).toBe(false)
    expect(syncWiredWidgets(undefined as any, createWiredLayer(0), canvas, natural)).toBe(false)
  })

  it('is a no-op for a slot whose widgets this node type does not declare', () => {
    const node = fixtureNode()
    expect(syncWiredWidgets(node, createWiredLayer(9, { x: 0.9 }), canvas, natural)).toBe(false)
    expect(node.data.widgetsValues).toEqual(FIXTURE_WIDGETS.map(([, v]) => v))
  })

  it('is a no-op on a degenerate canvas rather than writing a bogus scale', () => {
    const node = fixtureNode()
    expect(syncWiredWidgets(node, createWiredLayer(0, { x: 0.9 }), { w: 0, h: 0 }, natural)).toBe(false)
    expect(wv(node, 'layer1_x')).toBe(0)
  })

  it('syncs every wired layer in a stack and ignores the native ones', () => {
    const node = fixtureNode()
    const layers: LocalLayer[] = [
      createWiredLayer(0, { x: 0.75, w: 1, lastAspect: 600 / 800 }),
      { id: 'r', kind: 'rect', x: 0.1, y: 0.1, rotation: 0, opacity: 1, w: 0.2, h: 0.2 } as any,
      createWiredLayer(1, { y: 0.25, w: 1, lastAspect: 600 / 800 }),
    ]
    expect(syncAllWiredWidgets(node, layers, canvas)).toBe(2)
    expect(wv(node, 'layer1_x')).toBeCloseTo(0.25, 6)
    expect(wv(node, 'layer2_y')).toBeCloseTo(-0.25, 6)
  })

  it('reads back through the shared widgetIdx lookup the hosts and migration use', () => {
    const node = fixtureNode()
    syncWiredWidgets(node, createWiredLayer(0, { x: 0.7, w: 1, lastAspect: 600 / 800 }), canvas, natural)
    expect(widgetNum(node.data, 'layer1_x')).toBeCloseTo(0.2, 6)
  })
})

// ── setWidget: no holes, fail-closed writes are visible ─────────────────────
//
// `setWidget` used to guard `i < 0` and a missing array, but not `i >=
// widgetsValues.length` — a write past the end left a HOLE in the array
// (`arr[5] = x` on a length-3 array leaves indices 3-4 empty, not null), and
// `JSON.stringify` serializes an array hole as `null` too, but `i in arr`
// and `Object.keys` disagree — a hole is invisible to those, which is how a
// short array smuggled a missing widget past code that checked "is this key
// present" rather than round-tripping through JSON. Padding with real nulls
// (the same loop VueNodeCanvas.vue's `setVal` already uses) keeps the array
// dense so every consumer agrees on its shape.
describe('setWidget: dense writes and fail-closed visibility', () => {
  const host = (widgetsValues: any[]): WidgetHostData => ({
    widgetDefs: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    widgetsValues,
  })

  it('pads with real nulls (not holes) when writing past the current length', () => {
    const data = host([1])
    expect(setWidget(data, 'c', 42)).toBe(true)
    expect(data.widgetsValues).toEqual([1, null, 42])
    // A hole would still equal [1, undefined, 42] under toEqual and would still
    // stringify as null — the real test is that the index is densely present.
    expect(1 in data.widgetsValues!).toBe(true)
    expect(Object.keys(data.widgetsValues!)).toEqual(['0', '1', '2'])
    expect(JSON.stringify(data.widgetsValues)).toBe('[1,null,42]')
  })

  it('writes in place, no padding needed, when the index is already in range', () => {
    const data = host([1, 2, 3])
    expect(setWidget(data, 'b', 99)).toBe(true)
    expect(data.widgetsValues).toEqual([1, 99, 3])
  })

  it('lands the value at the declared index after padding, not appended at the end', () => {
    const data: WidgetHostData = {
      widgetDefs: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
      widgetsValues: [1],
    }
    expect(setWidget(data, 'd', 'x')).toBe(true)
    expect(data.widgetsValues).toEqual([1, null, null, 'x'])
  })

  it('is still a no-op (returns false, writes nothing) for an undeclared widget', () => {
    const data = host([1, 2, 3])
    expect(setWidget(data, 'ghost', 5)).toBe(false)
    expect(data.widgetsValues).toEqual([1, 2, 3])
  })

  it('warns naming the widget it could not write, in dev builds', () => {
    // import.meta.dev is a Nuxt build-time replacement; this plain-vite unit
    // suite does not define it (see resolveField's token-mismatch tests in
    // shaderfill-field-frame.unit.spec.ts for the same caveat), so it is falsy
    // here and the guard below is expected NOT to run under `vitest run`. The
    // assertions still hold real value once run inside the Nuxt-built app,
    // and the "no write happened" behavior above is verified unconditionally.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setWidget(host([1, 2, 3]), 'ghost', 5)
    if ((import.meta as any).dev) {
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]![0])).toContain('ghost')
    }
    warnSpy.mockRestore()
  })
})

// ── The editor choke point actually fires it ─────────────────────────────────
//
// `useLocalLayerEditor.commit` is the single mutation choke point for the layer
// document (see the history comment in that file), so hooking it there is what
// makes "every mutation mirrors down" true for moves, nudges, opacity, undo and
// every future edit without each call site remembering.

describe('editor write-through hook', () => {
  function makeEditor(layers: LocalLayer[], wiredDims?: (slot: number) => { w: number; h: number } | undefined) {
    const fx = fixtureNode()
    const node = reactive({ data: { ...fx.data, properties: { sailor_localLayers: layers } } })
    const ed = useLocalLayerEditor({
      node: () => node,
      dims: () => ({ w: 1024, h: 1024 }),
      getRect: () => null,
      wiredDims,
    })
    return { node, ed }
  }

  it('mirrors a wired layer edit into its slot widgets', () => {
    const { node, ed } = makeEditor([createWiredLayer(0, { x: 0.5, y: 0.5, w: 1, lastAspect: 600 / 800 })])
    const id = (node.data.properties.sailor_localLayers as LocalLayer[])[0]!.id
    ed.setLocal(id, { x: 0.75, opacity: 0.5 })
    expect(wv(node, 'layer1_x')).toBeCloseTo(0.25, 6)
    expect(wv(node, 'layer1_opacity')).toBeCloseTo(0.5, 6)
  })

  it('mirrors a keyboard nudge (proving the hook is on commit, not one call site)', () => {
    const { node, ed } = makeEditor([createWiredLayer(0, { x: 0.5, y: 0.5, w: 1, lastAspect: 600 / 800 })])
    const id = (node.data.properties.sailor_localLayers as LocalLayer[])[0]!.id
    ed.selectLocal(id)
    ed.handleEditorKey({ key: 'ArrowRight', shiftKey: false, metaKey: false, ctrlKey: false, preventDefault() {} } as any)
    expect(wv(node, 'layer1_x')).toBeGreaterThan(0)
  })

  it('follows undo back to the previous widget values', () => {
    const { node, ed } = makeEditor([createWiredLayer(0, { x: 0.5, y: 0.5, w: 1, lastAspect: 600 / 800 })])
    const id = (node.data.properties.sailor_localLayers as LocalLayer[])[0]!.id
    ed.setLocal(id, { x: 0.9 })
    expect(wv(node, 'layer1_x')).toBeCloseTo(0.4, 6)
    ed.undo()
    expect(wv(node, 'layer1_x')).toBeCloseTo(0, 6)
  })

  it('restores sailor_frametemplates on undo, atomically with the layers', () => {
    const { node, ed } = makeEditor([createWiredLayer(0, { x: 0.5, y: 0.5, w: 1, lastAspect: 600 / 800 })])
    ;(node.data.properties as any).sailor_frametemplates = [{ id: 't1', slotIndex: 0 }]
    ed.recordHistory()
    ;(node.data.properties as any).sailor_frametemplates = [{ id: 't1', slotIndex: 0 }, { id: 't2', slotIndex: 1 }]
    expect((node.data.properties as any).sailor_frametemplates).toHaveLength(2)
    ed.undo()
    expect((node.data.properties as any).sailor_frametemplates).toEqual([{ id: 't1', slotIndex: 0 }])
  })

  it('snapshots/restores an empty sailor_frametemplates array when a Frame has none', () => {
    const { node, ed } = makeEditor([createWiredLayer(0, { x: 0.5, y: 0.5, w: 1, lastAspect: 600 / 800 })])
    const id = (node.data.properties.sailor_localLayers as LocalLayer[])[0]!.id
    ed.setLocal(id, { x: 0.75 })
    expect((node.data.properties as any).sailor_frametemplates).toBeUndefined()
    ed.undo()
    expect((node.data.properties as any).sailor_frametemplates).toEqual([])
  })

  it('leaves the widgets alone when a wired layer is deleted (the edge disconnect removes it)', () => {
    const { node, ed } = makeEditor([createWiredLayer(0, { x: 0.75, y: 0.5, w: 1, lastAspect: 600 / 800 })])
    const id = (node.data.properties.sailor_localLayers as LocalLayer[])[0]!.id
    ed.setLocal(id, { x: 0.75 })
    ed.deleteLocal(id)
    expect(wv(node, 'layer1_x')).toBeCloseTo(0.25, 6)
  })

  it('uses the host-injected content dims when they are available', () => {
    const { node, ed } = makeEditor(
      [createWiredLayer(0, { x: 0.5, y: 0.5, w: 0.6, lastAspect: 1 })],
      slot => (slot === 0 ? { w: 600, h: 800 } : undefined),
    )
    const id = (node.data.properties.sailor_localLayers as LocalLayer[])[0]!.id
    ed.setLocal(id, { w: 0.6 })
    expect(wv(node, 'layer1_scale')).toBeCloseTo(0.6 / 0.75, 6)  // portrait fit, not the square cache
  })

  it('does not touch widgets for a stack with no wired layers', () => {
    const { node, ed } = makeEditor([{ id: 'a', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.1, h: 0.1 } as any])
    ed.setLocal('a', { x: 0.9 })
    expect(node.data.widgetsValues).toEqual(FIXTURE_WIDGETS.map(([, v]) => v))
  })
})

// ── Handle drags on a wired layer never persist a NaN height ────────────────
//
// A wired layer has NO independent height (its height is `w * lastAspect`), but
// both drag starters snapshotted `(l as RectLayer).h` — `undefined` — and the
// pointer-move maths turned that into NaN, which the commit then persisted as
// the layer's `h`. Both handle sets are reachable for a wired layer: the modal
// falls back to `startScale` for any non-`resizableKind` selection, and the card
// wires its corner handles straight to it.
describe('wired layer handle drags', () => {
  const listeners: Record<string, (e: any) => void> = {}
  const realWindow = (globalThis as any).window
  beforeAll(() => {
    ;(globalThis as any).window = {
      addEventListener: (type: string, fn: any) => { listeners[type] = fn },
      removeEventListener: (type: string) => { delete listeners[type] },
    }
  })
  afterAll(() => { (globalThis as any).window = realWindow })

  const RECT = { left: 0, top: 0, width: 1024, height: 1024 } as DOMRect
  function editorWith(layers: LocalLayer[]) {
    const node = reactive({ data: { properties: { sailor_localLayers: layers } } })
    const ed = useLocalLayerEditor({
      node: () => node,
      dims: () => ({ w: 1024, h: 1024 }),
      getRect: () => RECT,
      wiredDims: () => ({ w: 800, h: 600 }),
    })
    return { node, ed }
  }
  const ptr = (x: number, y: number) => ({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {}, altKey: false, shiftKey: false }) as any
  const layerAt = (node: any, i = 0) => (node.data.properties.sailor_localLayers as any[])[i]

  it('corner SCALE grows the width and leaves h absent (not NaN)', () => {
    const w = createWiredLayer(0, { x: 0.5, y: 0.5, w: 0.4, lastAspect: 0.75 })
    const { node, ed } = editorWith([w as LocalLayer])
    ed.selectLocal(w.id)
    ed.startScale(ptr(612, 612))              // grab a corner, 100px from centre-ish
    listeners.pointermove!(ptr(712, 712))     // drag outward
    const l = layerAt(node)
    expect(l.w).toBeGreaterThan(0.4)
    expect(Number.isNaN(l.h)).toBe(false)
    expect(l.h).toBeUndefined()
  })

  it('GROUP resize scales a wired member by width only', () => {
    const w = createWiredLayer(0, { x: 0.4, y: 0.5, w: 0.3, lastAspect: 0.5 })
    const rect = { id: 'r', kind: 'rect', x: 0.6, y: 0.5, rotation: 0, opacity: 1, w: 0.2, h: 0.2 } as any
    const { node, ed } = editorWith([w as LocalLayer, rect])
    ed.selectLocal(w.id)
    ed.toggleSelect('r')
    expect(ed.selectedIds.value.size).toBe(2)
    ed.startGroupResize('br', ptr(900, 700))
    listeners.pointermove!(ptr(1000, 800))
    const l = layerAt(node)
    expect(Number.isNaN(l.h)).toBe(false)
    expect(l.h).toBeUndefined()
    expect(Number.isNaN(l.w)).toBe(false)
    expect(l.w).toBeGreaterThan(0.3)
  })
})

// ── Task 6: verb parity ──────────────────────────────────────────────────────
// A wired layer is a LocalLayer now, so align / nudge / duplicate / copy have to
// treat it like every other layer — except duplication, where "like every other
// layer" would mean two layers on one slot. The honest copy is a snapshot, which
// only the HOST can bake (it owns the pixels and the upload), so the editor hands
// the wired members to `materializeWired` and clones only the rest.
describe('wired layer verb parity (mixed selection)', () => {
  const listeners: Record<string, (e: any) => void> = {}
  const realWindow = (globalThis as any).window
  beforeAll(() => {
    ;(globalThis as any).window = {
      addEventListener: (type: string, fn: any) => { listeners[type] = fn },
      removeEventListener: (type: string) => { delete listeners[type] },
    }
  })
  afterAll(() => { (globalThis as any).window = realWindow })

  const RECT = { left: 0, top: 0, width: 1024, height: 1024 } as DOMRect
  const ptr = (x: number, y: number) => ({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {}, altKey: false, shiftKey: false }) as any

  function mixedEditor(materializeWired?: (l: WiredLayer) => void) {
    // wired: w 0.4 (box half-width 0.2), rect: w 0.2 (half-width 0.1)
    const w = createWiredLayer(0, { x: 0.3, y: 0.3, w: 0.4, lastAspect: 0.5 })
    const rect = { id: 'r', kind: 'rect', x: 0.7, y: 0.8, rotation: 0, opacity: 1, w: 0.2, h: 0.2 } as any
    const node = reactive({ data: { properties: { sailor_localLayers: [w as LocalLayer, rect] } } })
    const ed = useLocalLayerEditor({
      node: () => node, dims: () => ({ w: 1024, h: 1024 }), getRect: () => RECT,
      materializeWired,
    })
    ed.selectLocal(w.id); ed.toggleSelect('r')
    return { node, ed, w, rect }
  }
  const read = (node: any) => node.data.properties.sailor_localLayers as any[]

  it('align-left equalises the wired and native left edges', () => {
    const { node, ed } = mixedEditor()
    ed.alignSelected('left')
    const [wl, rl] = read(node)
    expect(wl.x - 0.2).toBeCloseTo(0.1, 6)   // wired half-width 0.2
    expect(rl.x - 0.1).toBeCloseTo(0.1, 6)   // rect half-width 0.1
  })

  it('align-top equalises the wired and native top edges', () => {
    const { node, ed } = mixedEditor()
    ed.alignSelected('top')
    const [wl, rl] = read(node)
    // wired half-height = w * lastAspect / 2 = 0.1 (of WIDTH) → 0.1 of height too (square canvas)
    expect(wl.y - 0.1).toBeCloseTo(0.2, 6)
    expect(rl.y - 0.1).toBeCloseTo(0.2, 6)
  })

  it('nudge moves both members of the selection', () => {
    const { node, ed } = mixedEditor()
    ed.nudgeSelection(0.01, -0.02)
    const [wl, rl] = read(node)
    expect(wl.x).toBeCloseTo(0.31, 6); expect(wl.y).toBeCloseTo(0.28, 6)
    expect(rl.x).toBeCloseTo(0.71, 6); expect(rl.y).toBeCloseTo(0.78, 6)
  })

  it('duplicate snapshots the wired member and clones the rest — never two live layers on one slot', async () => {
    const seen: WiredLayer[] = []
    const { node, ed } = mixedEditor((l) => {
      seen.push(l)
      // What a host's materialize does: an ordinary image layer where the wire was.
      ed.addImageFromName('snap.png', 1 / (l.lastAspect || 1), { x: l.x, y: l.y, w: l.w } as any)
    })
    await ed.duplicateSelection()
    const ls = read(node)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.slot).toBe(0)
    expect(ls.filter(l => l.kind === 'wired')).toHaveLength(1)     // still exactly one live slot
    expect(ls.filter(l => l.kind === 'image')).toHaveLength(1)     // the snapshot
    expect(ls.filter(l => l.kind === 'image')[0]!.kind).toBe('image')
    expect(ls.filter(l => l.kind === 'rect')).toHaveLength(2)      // the real clone
  })

  it('duplicate without a host materializer drops the wired member rather than doubling it', async () => {
    const { node, ed } = mixedEditor()
    await ed.duplicateSelection()
    const ls = read(node)
    expect(ls.filter(l => l.kind === 'wired')).toHaveLength(1)
    expect(ls.filter(l => l.kind === 'rect')).toHaveLength(2)
  })

  it('duplicate over MULTIPLE wired layers materializes them SEQUENTIALLY, in order — not racing a host re-entrancy guard', async () => {
    // Regression for I2: `copyWiredIntoFrame`-style host materializers refuse to
    // start a second copy while one is in flight (`if (copyingSlot.value != null)
    // return`), set synchronously at call start. Firing every wired member's
    // materialize at once used to race them all against that guard, so every
    // member after the first silently vanished. `duplicateSelection` must await
    // each materialize before starting the next.
    const w0 = createWiredLayer(0, { x: 0.2, y: 0.2, w: 0.3, lastAspect: 1 })
    const w1 = createWiredLayer(1, { x: 0.6, y: 0.6, w: 0.3, lastAspect: 1 })
    const node = reactive({ data: { properties: { sailor_localLayers: [w0 as LocalLayer, w1 as LocalLayer] } } })
    const seen: number[] = []
    let inFlight = false
    const materializeWired = async (l: WiredLayer) => {
      expect(inFlight).toBe(false)   // fails if a second materialize starts before the first resolves
      inFlight = true
      await Promise.resolve(); await Promise.resolve()   // a couple microtask hops, like a real async snapshot
      seen.push(l.slot)
      inFlight = false
    }
    const ed = useLocalLayerEditor({
      node: () => node, dims: () => ({ w: 1024, h: 1024 }), getRect: () => RECT,
      materializeWired,
    })
    ed.selectLocal(w0.id); ed.toggleSelect(w1.id)
    await ed.duplicateSelection()
    expect(seen).toEqual([0, 1])   // both called, in selection order
  })

  it('copy keeps wired out of the clipboard, so paste can never re-create the slot', async () => {
    _resetClipboard()
    const { ed } = mixedEditor()
    await ed.copySelection()   // async now: bakes wired members before serializing
    const p = getClipboard()!
    expect(p.layers).toHaveLength(1)
    expect(p.layers[0]!.kind).toBe('rect')
  })

  // Coverage for the copy-bake branch (useLocalLayerEditor.ts:531-536): when the
  // selection has NO clonable member — it's wired-only — `copyIds` starts empty
  // and the bake path is the only source of anything to copy at all. A host
  // materializer that ADDS a snapshot image layer (the real "copy into frame"
  // contract, same as duplicateSelection's) must have that fresh layer picked up
  // and ride the clipboard payload as the baked kind, never the live 'wired' kind.
  it('copy over a WIRED-ONLY selection bakes a snapshot and rides the clipboard as that baked layer (kind image, not wired)', async () => {
    _resetClipboard()
    const w = createWiredLayer(0, { x: 0.3, y: 0.3, w: 0.4, lastAspect: 0.5 })
    const node = reactive({ data: { properties: { sailor_localLayers: [w as LocalLayer] } } })
    const ed = useLocalLayerEditor({
      node: () => node, dims: () => ({ w: 1024, h: 1024 }), getRect: () => RECT,
      materializeWired: (l: WiredLayer) => {
        // What a host's materialize does: bake the slot's live pixels into a
        // real image layer where the wire was — the same path ⌘D uses.
        ed.addImageFromName('snap.png', 1 / (l.lastAspect || 1), { x: l.x, y: l.y, w: l.w } as any)
      },
    })
    ed.selectLocal(w.id)
    await ed.copySelection()
    const p = getClipboard()!
    expect(p.layers).toHaveLength(1)
    expect(p.layers[0]!.kind).toBe('image')
  })
})

// Corner resize on a wired layer is ANCHORED, like every other layer: the grabbed
// corner follows the pointer and the OPPOSITE corner stays put. It is aspect-
// locked without Shift (a wired layer has no independent height — the height is
// `w * lastAspect`), and only `w` plus the recomputed centre are written back.
describe('wired layer anchored corner resize', () => {
  const listeners: Record<string, (e: any) => void> = {}
  const realWindow = (globalThis as any).window
  beforeAll(() => {
    ;(globalThis as any).window = {
      addEventListener: (type: string, fn: any) => { listeners[type] = fn },
      removeEventListener: (type: string) => { delete listeners[type] },
    }
  })
  afterAll(() => { (globalThis as any).window = realWindow })

  const W = 1024
  const RECT = { left: 0, top: 0, width: W, height: W } as DOMRect
  const ptr = (x: number, y: number, mod: Record<string, boolean> = {}) =>
    ({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {}, altKey: false, shiftKey: false, ...mod }) as any

  function wiredEditor() {
    const w = createWiredLayer(0, { x: 0.5, y: 0.5, w: 0.4, lastAspect: 0.75 })
    const node = reactive({ data: { properties: { sailor_localLayers: [w as LocalLayer] } } })
    const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: W, h: W }), getRect: () => RECT })
    ed.selectLocal(w.id)
    return { node, ed, w }
  }
  // box: 409.6 × 307.2 px centred at (512, 512) → tl (307.2, 358.4), br (716.8, 665.6)
  const boxOf = (l: any) => {
    const wPx = l.w * W, hPx = l.w * l.lastAspect * W
    const cx = l.x * W, cy = l.y * W
    return { wPx, hPx, l: cx - wPx / 2, t: cy - hPx / 2, r: cx + wPx / 2, b: cy + hPx / 2 }
  }

  it('dragging the BR corner leaves the TL corner fixed and follows the pointer in x', () => {
    const { node, ed } = wiredEditor()
    ed.startResize('br', ptr(716.8, 665.6))
    listeners.pointermove!(ptr(816.8, 665.6))
    const l = node.data.properties.sailor_localLayers[0] as any
    const b = boxOf(l)
    expect(b.l).toBeCloseTo(307.2, 3)
    expect(b.t).toBeCloseTo(358.4, 3)
    expect(b.r).toBeCloseTo(816.8, 3)
    expect(l.h).toBeUndefined()
  })

  it('dragging the TL corner leaves the BR corner fixed', () => {
    const { node, ed } = wiredEditor()
    ed.startResize('tl', ptr(307.2, 358.4))
    listeners.pointermove!(ptr(207.2, 358.4))
    const l = node.data.properties.sailor_localLayers[0] as any
    const b = boxOf(l)
    expect(b.r).toBeCloseTo(716.8, 3)
    expect(b.b).toBeCloseTo(665.6, 3)
    expect(b.l).toBeCloseTo(207.2, 3)
    expect(l.h).toBeUndefined()
  })

  it('stays aspect-locked WITHOUT shift and never writes an `h`', () => {
    const { node, ed } = wiredEditor()
    ed.startResize('br', ptr(716.8, 665.6))
    listeners.pointermove!(ptr(900, 700))          // pointer off the aspect diagonal
    const l = node.data.properties.sailor_localLayers[0] as any
    const b = boxOf(l)
    expect(b.hPx / b.wPx).toBeCloseTo(0.75, 6)
    expect('h' in l).toBe(false)
    expect(Number.isNaN(l.w)).toBe(false)
    expect(l.w).toBeGreaterThan(0.4)
  })

  it('mirrors the resized box back into the slot widgets', () => {
    const { node, ed } = wiredEditor()
    ;(node.data as any).widgets_values = []
    ;(node.data as any).widgets = []
    ed.startResize('br', ptr(716.8, 665.6))
    listeners.pointermove!(ptr(816.8, 665.6))
    // The write-through is the commit's job; with no widget host declared it is a
    // clean no-op rather than a crash (see syncWiredWidgets).
    expect((node.data.properties.sailor_localLayers[0] as any).w).toBeGreaterThan(0.4)
  })
})

// Backstop for the duplicate-slot hazard the verb sweep closes at the editor
// boundary: if two live wired layers ever DID reach one slot, the write-through
// would silently last-write-wins while the server rendered a single copy. Say so.
describe('syncAllWiredWidgets duplicate-slot guard', () => {
  const canvas = { w: 1024, h: 1024 }
  function host(): { data: WidgetHostData } {
    const data: any = { widgets_values: {} }
    for (const k of ['x', 'y', 'rotation', 'scale', 'opacity', 'blend']) data.widgets_values[`layer1_${k}`] = 0
    return { data }
  }
  it('warns once when two layers claim the same slot', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = createWiredLayer(0, { w: 0.5, lastAspect: 1 })
    const b = createWiredLayer(0, { w: 0.8, lastAspect: 1 })
    syncAllWiredWidgets(host(), [a as LocalLayer, b as LocalLayer], canvas)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/slot 0/)
    warn.mockRestore()
  })
  it('stays quiet for distinct slots', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    syncAllWiredWidgets(host(), [createWiredLayer(0, { w: 0.5, lastAspect: 1 }) as LocalLayer,
      createWiredLayer(1, { w: 0.5, lastAspect: 1 }) as LocalLayer], canvas)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
