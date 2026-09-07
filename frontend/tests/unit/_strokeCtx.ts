import { beforeEach, afterEach } from 'vitest'

/**
 * Shared "recording fake 2D context" harness for the stroke-painter unit suites
 * (`compositor-stroke-style.unit.spec.ts` and `compositor-stroke-band.unit.spec.ts`).
 *
 * This suite runs in the node environment (no DOM, no rasterizing canvas — see
 * tests/unit/compositor-corner-radius.unit.spec.ts and wired-layer.unit.spec.ts).
 * So the recording context below logs the draw ops, and `inkAt` replays that log
 * under Canvas2D's own compositing rules to answer ONE question per probe point:
 * is this point painted?  That is a pixel probe in everything but the raster —
 * geometry (rect distance, dash phase), clipping, destination-out and the
 * offscreen stamp are all modelled, so a knockout aimed at the wrong surface, a
 * missing clip, or a leaked dash all change the answer.
 *
 * Geometry supported: axis-aligned rects (radius ignored — probes stay away from
 * the corners) and straight segments. Enough for the alignment/dash/distance claims.
 *
 * Extracted (not copied) out of `compositor-stroke-style.unit.spec.ts` so a change
 * to the fake context's semantics can never accidentally diverge between the two
 * suites — see MEMORY note "playgrnd guards" / this repo's own house rule against
 * duplicating a logic block.
 */

export type Pt = { x: number; y: number }
export type Pred = (p: Pt) => boolean

export type Op =
  | { kind: 'save' } | { kind: 'restore' }
  | { kind: 'clip'; pred: Pred }
  | { kind: 'fill'; pred: Pred; erase: boolean }
  // `erase`/`lineJoin`/`lineWidth` are captured at call time (mirrors how `erase`
  // already worked for `fill`) so a distance-band stroke's exact radius and join —
  // and an erosion's destination-out — are directly observable, not just replayed.
  | { kind: 'stroke'; pred: Pred; erase: boolean; lineJoin: string; lineWidth: number }
  // `erase` on a stamp models `ctx.globalCompositeOperation === 'destination-out'`
  // at the moment of `drawImage`: paintStrokeBand's own knockout (one scratch's
  // dilation subtracted from another's) is expressed exactly this way.
  | { kind: 'stamp'; from: Recorder; erase: boolean }

/**
 * A `fillText` / `strokeText` call, recorded separately from `ops`.
 *
 * Text has no geometry in this harness (there are no glyph outlines to model), so a text
 * draw can't take part in the `inkAt` replay the way a rect or a segment does. What it CAN
 * answer is the structural question the text stroke band needs: which surface was the run
 * drawn on, with what `lineWidth`, and was the context erasing at the time. Kept off `ops`
 * so every existing `rec.ops` assertion is untouched.
 */
export type TextOp = { kind: 'fillText' | 'strokeText'; text: string; x: number; y: number; lineWidth: number; erase: boolean }

export interface Recorder { name: string; ops: Op[]; texts: TextOp[] }

/** Signed distance to an axis-aligned rect centred on (0,0): negative inside. */
export function sdRect(p: Pt, w: number, h: number): number {
  const dx = Math.abs(p.x) - w / 2
  const dy = Math.abs(p.y) - h / 2
  const out = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return out > 0 ? out : Math.max(dx, dy)
}

/** Distance from p to the segment a→b, plus the arc length of its projection. */
export function segProject(p: Pt, a: Pt, b: Pt) {
  const vx = b.x - a.x, vy = b.y - a.y
  const len = Math.hypot(vx, vy) || 1
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (len * len)))
  const cx = a.x + vx * t, cy = a.y + vy * t
  return { dist: Math.hypot(p.x - cx, p.y - cy), along: t * len }
}

/** A dashed pattern is "on" where the arc length falls in a dash, not a gap. */
export function dashOn(along: number, dash: [number, number] | null): boolean {
  if (!dash) return true
  const period = dash[0] + dash[1]
  if (!(period > 0)) return true
  return ((along % period) + period) % period < dash[0]
}

export function inkAt(rec: Recorder, p: Pt): boolean {
  let ink = false
  let clip: Pred | null = null
  const stack: (Pred | null)[] = []
  for (const op of rec.ops) {
    if (op.kind === 'save') { stack.push(clip); continue }
    if (op.kind === 'restore') { clip = stack.pop() ?? null; continue }
    if (op.kind === 'clip') { const prev = clip; clip = prev ? (q: Pt) => prev(q) && op.pred(q) : op.pred; continue }
    if (op.kind === 'stamp') { const hit = inkAt(op.from, p); if (hit) ink = op.erase ? false : true; continue }
    const inClip = !clip || clip(p)
    if (!inClip) continue
    if (op.kind === 'fill') { if (op.pred(p)) ink = op.erase ? false : true; continue }
    if (op.kind === 'stroke') { if (op.pred(p)) ink = op.erase ? false : true }
  }
  return ink
}

// ── Recording context ────────────────────────────────────────────────────────

const _byCanvas = new Map<object, Recorder>()

export function makeCtx(name: string, W = 200, H = 200) {
  const rec: Recorder = { name, ops: [], texts: [] }
  const canvas = { width: W, height: H, getContext: () => ctx }
  _byCanvas.set(canvas, rec)
  // Current path as a predicate pair (fill area / distance to the outline).
  let fillPred: Pred = () => false
  let distTo: (p: Pt) => { dist: number; along: number } = () => ({ dist: Infinity, along: 0 })
  let dash: [number, number] | null = null
  const state: { dash: [number, number] | null }[] = []
  const ctx: any = {
    canvas,
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    shadowColor: 'transparent', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    font: '', textAlign: 'left', textBaseline: 'alphabetic',
    save() { state.push({ dash }); rec.ops.push({ kind: 'save' }) },
    restore() { dash = state.pop()?.dash ?? null; rec.ops.push({ kind: 'restore' }) },
    translate() {}, scale() {}, rotate() {}, transform() {}, setTransform() {},
    getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
    setLineDash(d: number[]) { dash = d.length ? [d[0]!, d[1] ?? 0] : null },
    getLineDash() { return dash ? [dash[0], dash[1]] : [] },
    measureText() { return { width: 10 } },
    beginPath() { fillPred = () => false; distTo = () => ({ dist: Infinity, along: 0 }) },
    closePath() {},
    rect(x: number, y: number, w: number, h: number) { ctx.roundRect(x, y, w, h, 0) },
    roundRect(_x: number, _y: number, w: number, h: number, _r: unknown) {
      // Centred rects only (every shape layer draws at the origin).
      fillPred = (p: Pt) => sdRect(p, w, h) <= 0
      distTo = (p: Pt) => ({ dist: Math.abs(sdRect(p, w, h)), along: 0 })
    },
    ellipse() {},
    moveTo(x: number, y: number) { ctx._a = { x, y } },
    lineTo(x: number, y: number) {
      const a = ctx._a as Pt, b = { x, y }
      fillPred = () => false
      distTo = (p: Pt) => segProject(p, a, b)
    },
    clip() { const pred = fillPred; rec.ops.push({ kind: 'clip', pred }) },
    fill() {
      const pred = fillPred
      rec.ops.push({ kind: 'fill', pred, erase: ctx.globalCompositeOperation === 'destination-out' })
    },
    stroke() {
      const lw = ctx.lineWidth, d = dash, dt = distTo, lj = ctx.lineJoin
      const erase = ctx.globalCompositeOperation === 'destination-out'
      rec.ops.push({
        kind: 'stroke',
        pred: (p: Pt) => { const r = dt(p); return r.dist <= lw / 2 && dashOn(r.along, d) },
        erase, lineJoin: lj, lineWidth: lw,
      })
    },
    fillText(text: string, x: number, y: number) {
      rec.texts.push({ kind: 'fillText', text, x, y, lineWidth: ctx.lineWidth, erase: ctx.globalCompositeOperation === 'destination-out' })
    },
    strokeText(text: string, x: number, y: number) {
      rec.texts.push({ kind: 'strokeText', text, x, y, lineWidth: ctx.lineWidth, erase: ctx.globalCompositeOperation === 'destination-out' })
    },
    clearRect() {},
    fillRect() {},
    drawImage(src: any) {
      const from = _byCanvas.get(src)
      if (from) rec.ops.push({ kind: 'stamp', from, erase: ctx.globalCompositeOperation === 'destination-out' })
    },
    createLinearGradient() { return { addColorStop() {} } },
    createPattern() { return null },
  }
  return { ctx: ctx as CanvasRenderingContext2D, rec }
}

/** Every op the shared painter made, flattened (main surface + any offscreen). */
export function allOps(rec: Recorder): Op[] {
  return rec.ops.flatMap(o => (o.kind === 'stamp' ? allOps(o.from) : [o]))
}

/**
 * Installs the `document.createElement('canvas')` mock that `scratchLike` (in
 * useCompositorLayers.ts) needs to produce an offscreen — every scratch it makes
 * is itself one of these recording contexts, so nested draws (the knockout onto
 * a SEPARATE scratch, then stamped back) replay correctly through `inkAt`.
 *
 * Call once per describe/file; wires its own `beforeEach`/`afterEach`. Returns
 * accessors read fresh per assertion (the counter/list are reset every test).
 */
export function installScratchDocument() {
  let count = 0
  const created: Recorder[] = []
  beforeEach(() => {
    count = 0
    created.length = 0
    ;(globalThis as any).document = {
      createElement(tag: string) {
        if (tag !== 'canvas') return {}
        count += 1
        const { ctx, rec } = makeCtx(`scratch${count}`)
        created.push(rec)
        return ctx.canvas
      },
    }
  })
  afterEach(() => { delete (globalThis as any).document })
  return {
    /** Number of scratch canvases created so far in the current test. */
    count: () => count,
    /** Recorders for each scratch canvas, in creation order. */
    scratches: () => created.slice(),
  }
}

/**
 * A context whose `scratchLike` path fails — no `document` at all, as in a
 * worker/SSR environment. Deletes any document the current test may already
 * have installed (e.g. via `installScratchDocument`'s `beforeEach`), so a
 * painter that reaches for a scratch canvas gets `null` and must fall back to
 * drawing on `ctx` directly instead of knocking out on the shared surface.
 */
export function makeCtxWithoutDocument(name: string, W = 200, H = 200) {
  delete (globalThis as any).document
  return makeCtx(name, W, H)
}
