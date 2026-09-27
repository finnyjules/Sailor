/**
 * The Frame editor's shared-pen SESSION (Plan B, Task 7).
 *
 * One drawing session at a time: `open(target)` creates a fresh pen over a
 * fresh (or, in later tasks, cloned) drawing, `commitSession()` writes the
 * result into the Frame, `cancelSession()` drops it. The host (CompositorModal)
 * renders `session.pen` with PenOverlay / PenToolbar, re-keyed by
 * `session.key` — both read their pen once at setup (see the HOST CONTRACT at
 * the top of `composables/pen/usePen.ts`).
 *
 * Targets:
 *   - `{ kind: 'new' }` — a brand-new drawing. On commit it is re-centred
 *     (`recentreSketch`) and becomes ONE new path layer that remembers its
 *     drawing (`sketch`, with `d === sketchToLocalD(sketch)`), planted where it
 *     was drawn (`placementAfterRecentre`). No outline → nothing written.
 *   - `{ kind: 'layer', id }` — reopening a drawn path layer (Task 8). The pen
 *     edits a clone of the layer's `sketch` through the layer's own placement
 *     (`layerView` of its LIVE x/y/rotation/skew and effective scale — see
 *     `layerPlacementForView`), and every change is previewed ON the layer
 *     itself with `commit` (no history), so its own fill, stroke and effects
 *     render the drawing live. History is recorded LAZILY — once, just before
 *     the first write that changes something — so opening and leaving without
 *     an edit leaves no undo step (and keeps the redo stack). Commit re-centres
 *     and writes `d`/`sketch`/`bbox`/`x`/`y` (not re-centred when the layer's
 *     cloner would make copies jump — `clonerBlocksRecentre`); cancel, and
 *     tearing the host down mid-session, put back only what the pen wrote
 *     (`d`/`sketch` — previews never touch x/y/bbox), so an inspector edit made
 *     meanwhile (fill, stroke) survives.
 *   - `{ kind: 'guide', textId }` — drawing (or re-editing) a text layer's
 *     "Drawn path" guide (Task 9). Open paths only (`openOnly`, Select/Pen/
 *     Curve). The view is FIXED at open: `guideView` of the guide when it
 *     already remembers a drawing, else `layerView` of the text's placement at
 *     scale 1 (you draw at true size around the text's origin). Every change
 *     re-lays the type live (same lazy history as a layer). What you see is
 *     what you get: `guideFromPathD` re-centres the guide on its own bbox
 *     midpoint and refits it to `size`, so each write keeps the refit factor at
 *     the opening `k` (`size = k × x-extent`) and moves the text's `x`/`y` by
 *     the midpoint's drift (`guideWrite`) — the type stays on the line being
 *     drawn. Cancel puts the text's `path`, `x` and `y` back exactly; so does
 *     a preview whose drawing has become empty again (undo back to nothing),
 *     without closing, so the type never sits on a line that is gone.
 *
 * Construction is side-effect free (no DOM, no lifecycle hooks) so vitest can
 * run it in `node`; the pen is disposed whenever a session closes and, when
 * created inside a component's scope, when that scope is torn down.
 */
import { ref, shallowRef, computed, getCurrentScope, onScopeDispose, type Ref, type ComputedRef } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { cloneDoc } from '~/lib/sketch/clone'
import { addPath } from '~/lib/sketch/edit'
import { layoutScaleOf } from '~/lib/frame/responsive/layoutScale'
import type { ViewMatrix } from '~/lib/sketch/view'
import { usePen, type Pen, type PenTool } from '~/composables/pen/usePen'
import { createPathLayer } from '~/composables/useCompositorLayers'
import {
  sketchToLocalD, localOutlineBounds, recentreSketch, newDrawingView, placementAfterRecentre, layerView, guideView,
  penOutlines, withPenOutlines,
  type LayerPlacement,
} from '~/lib/compositor/penFrame'
import { fillPathData, withoutFills } from '~/lib/sketch/fills'
import { hasPaint } from '~/lib/paint/resolve'
import { customGuideMapping, guideSizeToTargetWidthPx } from '~/lib/compositor/textPath'

export type FramePenTarget = { kind: 'new' } | { kind: 'layer'; id: string } | { kind: 'guide'; textId: string }

export interface FramePenHost {
  layers: () => any[]                                   // current local layers
  size: () => { W: number; H: number }                  // canvasDisplay
  recordHistory: () => void
  commit: (next: any[]) => void
  addPathLayers: (layers: any[]) => void
  selectLocal: (id: string | null) => void
}

export interface FramePenSession {
  target: FramePenTarget
  pen: Pen
  doc: Ref<SketchDoc>
  view: ComputedRef<ViewMatrix>
  key: number
}

/** The tools a new Frame drawing offers (Select is always added by the pen). */
export const FRAME_PEN_TOOLS: PenTool[] = ['select', 'path', 'curve', 'line', 'circle', 'point', 'trim', 'cut', 'dissolve', 'fill']

/** Plan B decision 4: a closed drawing is filled, an open one is stroked — a
 *  filled open path would draw a chord-closed blob, which reads as a bug. */
export const PEN_STYLE_CLOSED = { fill: '#3b82f6', stroke: '', strokeWidth: 0 } as const
export const PEN_STYLE_OPEN = { fill: 'none', stroke: '#3b82f6', strokeWidth: 0.004 } as const

/** The style a path layer takes when its closed drawing is made open (Trim,
 *  Cut, Delete — or, pen stage 7, its last filled area emptied): the pen's own
 *  closed style (untouched) becomes the pen's open style; so does the pen's open
 *  style that took the pen's fill colour with its first filled area
 *  (`filledStyle`); a style of the user's own keeps its fill and gains the pen's
 *  stroke only if it has no visible stroke; otherwise nothing changes. Mirrors
 *  Shape Studio, which paints an outline once the drawing is no longer closed. */
export function openedStyle(l: { fill?: string; stroke?: string; strokeWidth?: number }): Partial<typeof PEN_STYLE_OPEN> {
  const visibleStroke = !!l.stroke && (l.strokeWidth ?? 0) > 0
  const pensOpenStroke = l.stroke === PEN_STYLE_OPEN.stroke && l.strokeWidth === PEN_STYLE_OPEN.strokeWidth
  if (l.fill === PEN_STYLE_CLOSED.fill && (!visibleStroke || pensOpenStroke)) return { ...PEN_STYLE_OPEN }
  if (!visibleStroke) return { stroke: PEN_STYLE_OPEN.stroke, strokeWidth: PEN_STYLE_OPEN.strokeWidth }
  return {}
}

/** True when the drawing's visible outline is closed: any non-construction
 *  path that is closed, or any non-construction circle — or (pen stage 7) it
 *  has a filled area. */
export function isClosedDrawing(doc: SketchDoc): boolean {
  return doc.entities.some(e =>
    !e.construction && ((e.kind === 'path' && e.closed) || e.kind === 'circle'))
    || !!fillPathData(doc)
}

/** Pen stage 7: the fill a layer takes when its drawing gains a filled area
 *  while its own fill paints nothing (an open drawing's style) — the pen's
 *  fill colour. Nothing when it already has a fill of its own. */
export function filledStyle(l: { fill?: unknown }): { fill?: string } {
  return hasPaint(l.fill as never) ? {} : { fill: PEN_STYLE_CLOSED.fill }
}

/**
 * A path layer's placement as the PAINTER draws it (`applyXform` then
 * `drawPath` in `useCompositorLayers.ts`): translate·rotate·shear, then
 * `applyXform`'s extra uniform scale — the responsive layout scale
 * `layoutScaleOf(layer)` (times the cloner copy's own `dscale`, which is 1 for
 * copy 0) — then `drawPath`'s `scale·W`. So the effective scale for
 * `layerView` / `placementAfterRecentre` is `layer.scale × layoutScaleOf(layer)`.
 */
export function layerPlacementForView(l: any): LayerPlacement {
  return {
    x: l.x, y: l.y,
    rotation: l.rotation || 0,
    skewX: l.skewX || 0, skewY: l.skewY || 0,
    scale: (l.scale || 1) * layoutScaleOf(l),
  }
}

/**
 * True when re-centring a layer would make its cloner copies jump. Re-centring
 * moves the layer's pivot and shifts `x`/`y` to compensate — exact for copy 0
 * and for copies that only translate, but a copy drawn with its own extra
 * rotation or scale (`expandClones` in `useCloner.ts`: `drot = k·stepRotation
 * (+ the radial faceCenter angle)`, `dscale = stepScale^k`) turns/scales the
 * compensating shift too, so it lands somewhere else. Such a layer is committed
 * without re-centring.
 */
export function clonerBlocksRecentre(l: any): boolean {
  const c = l?.cloner
  if (!c || !c.enabled) return false
  return (c.stepRotation || 0) !== 0
    || (c.stepScale ?? 1) !== 1
    || (c.mode === 'radial' && !!c.faceCenter)
}

/** The tools a text guide offers: open paths only (no Line/Circle/Point), and the editing tools. */
export const GUIDE_PEN_TOOLS: PenTool[] = ['select', 'path', 'curve', 'trim', 'cut', 'dissolve']

/**
 * What a guide session fixes at open (see the header): the text's placement,
 * the guide's refit factor `k` and its bbox midpoint `mid` (LOCAL units), as
 * `customGuideMapping` reports them for the opening guide. A fresh guide (no
 * drawing yet) is `k = 1`, `mid = (0,0)`.
 */
export interface GuideAnchor {
  x: number
  y: number
  rotation: number
  skewX: number
  skewY: number
  k: number
  mid: { x: number; y: number }
}

/**
 * The text layer after writing drawing `sk` as its guide, so the type sits
 * exactly where the drawing is under the session's fixed view: `size` keeps the
 * refit factor at `a.k`, and `x`/`y` move by the guide midpoint's drift so the
 * re-centred guide lands back under the drawing. `null` when the drawing has no
 * usable outline (nothing to write).
 */
export function guideWrite(text: any, sk: SketchDoc, a: GuideAnchor, W: number, H: number): any | null {
  const d = sketchToLocalD(sk)
  const m0 = customGuideMapping(d, W, 0)
  if (!m0) return null
  let lo = Infinity, hi = -Infinity
  for (const p of m0.sub.pts) { if (p.x < lo) lo = p.x; if (p.x > hi) hi = p.x }
  // a zero-width outline (a perfectly vertical line) has no width to refit: keep
  // the guide's own size rather than write 0, which would silently drop Path size
  const size = hi - lo > 0 ? a.k * (hi - lo) : text.path?.size
  const m = customGuideMapping(d, W, guideSizeToTargetWidthPx(size, W)) ?? m0
  const { x, y } = placementAfterRecentre(
    { x: a.x, y: a.y, rotation: a.rotation, skewX: a.skewX, skewY: a.skewY, scale: a.k },
    { x: m.mid.x - a.mid.x, y: m.mid.y - a.mid.y }, W, H)
  // a guide never fills (pen stage 7): its drawing is stored without fills
  return { ...text, x, y, path: { ...(text.path ?? {}), follow: 'custom', d, sketch: withoutFills(cloneDoc(sk)), size } }
}

/**
 * The drawing with the pen's in-progress path (`pen.pendingPath`, not yet in
 * the doc until the path is finished) added as an open path, so a live preview
 * shows what is being drawn. The doc itself when nothing is pending.
 */
export function withPendingPath(doc: SketchDoc, pp: Pen['pendingPath']['value']): SketchDoc {
  if (!pp || pp.anchors.length < 2 || pp.segments.length !== pp.anchors.length - 1) return doc
  const out = cloneDoc(doc)
  addPath(out, pp.anchors, pp.segments, false)
  return out
}

/** The text with its guide and position as they were at `orig` (other edits survive). */
function restoreGuide(l: any, orig: any): any {
  return { ...l, path: orig.path, x: orig.x, y: orig.y }
}

export function useFramePenSession(host: FramePenHost) {
  const session = shallowRef<FramePenSession | null>(null)
  let seq = 0
  // `{ kind: 'layer' }`: the layer exactly as it was when the session opened,
  // and whether this session has recorded its one undo step yet
  let original: any = null
  let recorded = false
  // `{ kind: 'layer' }`: the pen gave the layer its fill colour (its first filled
  // area, on a layer whose fill painted nothing) — Cancel puts the old fill back
  let penFilled = false
  function ensureRecorded() {
    if (recorded) return
    recorded = true
    host.recordHistory()   // nothing written yet: the snapshot is the pre-edit state
  }

  function close() {
    const s = session.value
    original = null
    guideAnchor = null
    recorded = false
    penFilled = false
    if (!s) return
    session.value = null
    s.pen.dispose()
  }

  /** Write `patch(layer)` over the target layer, no history. */
  function writeLayer(id: string, patch: (l: any) => any) {
    host.commit(host.layers().map(l => (l.id === id ? patch(l) : l)))
  }

  function openLayer(id: string): void {
    const found = host.layers().find(l => l.id === id)
    if (!found || found.kind !== 'path' || !found.sketch) return
    close()
    original = found
    let written = JSON.stringify(found.sketch)   // the drawing the layer currently shows
    const doc = ref<SketchDoc>(cloneDoc(found.sketch))
    // Read the placement from the LIVE layer (previews never touch x/y), so a
    // layer moved before the session opened is where the pen draws.
    const view = computed(() => {
      const { W, H } = host.size()
      const live = host.layers().find(l => l.id === id) ?? found
      return layerView(layerPlacementForView(live), W, H)
    })
    const preview = () => {
      const shown = pen.liveDoc()   // never an arc drag's transient guide point
      const json = JSON.stringify(shown)
      if (json === written) return   // nothing changed (a click, a selection)
      written = json
      ensureRecorded()
      const sk = cloneDoc(shown)
      writeLayer(id, l => {
        const next = withPenOutlines(l, sk)
        if (next.fillD) {
          if (hasPaint(l.fill)) return next
          penFilled = true
          return { ...next, ...filledStyle(l) }
        }
        // the pen's fill colour goes when the last filled area it came with goes
        // (unless the fill was changed meanwhile), so an open drawing is never
        // left painting its chord-closed outline
        if (penFilled) {
          penFilled = false
          if (l.fill === PEN_STYLE_CLOSED.fill) return { ...next, fill: found.fill }
        }
        return next
      })
    }
    const pen = usePen({ doc, view, options: { tools: FRAME_PEN_TOOLS }, onChange: preview, onLiveChange: preview })
    pen.selectTool('select')
    session.value = { target: { kind: 'layer', id }, pen, doc, view, key: ++seq }
  }

  // `{ kind: 'guide' }`: what the session fixed at open (see GuideAnchor)
  let guideAnchor: GuideAnchor | null = null

  function openGuide(textId: string): void {
    const text = host.layers().find(l => l.id === textId)
    if (!text || text.kind !== 'text') return
    close()
    original = text
    const { W, H } = host.size()
    const a: GuideAnchor = {
      x: text.x, y: text.y,
      rotation: text.rotation || 0, skewX: text.skewX || 0, skewY: text.skewY || 0,
      k: 1, mid: { x: 0, y: 0 },
    }
    const spec = text.path
    let fixed: ViewMatrix | null = null
    let start: SketchDoc = { entities: [], constraints: [] }
    if (spec?.sketch && spec.d) {
      const m = customGuideMapping(spec.d, W, guideSizeToTargetWidthPx(spec.size, W))
      const gv = guideView(text, spec, W, H)
      if (m && gv) { a.k = m.k; a.mid = m.mid; fixed = gv; start = withoutFills(cloneDoc(spec.sketch)) }
    }
    // a fresh guide (or one without a drawing): draw at true size around the text's origin
    if (!fixed) fixed = layerView({ x: a.x, y: a.y, rotation: a.rotation, skewX: a.skewX, skewY: a.skewY, scale: 1 }, W, H)
    guideAnchor = a
    const editing = start.entities.length > 0
    let written = JSON.stringify(start)
    const doc = ref<SketchDoc>(start)
    const view = computed(() => fixed!)   // FIXED for the session: the guide re-centres itself, the drawing must not jump
    const preview = () => {
      // the path still being drawn counts too, so the type follows it as you draw
      const shown = withPendingPath(pen.liveDoc(), pen.pendingPath.value)
      const json = JSON.stringify(shown)
      if (json === written) return
      const { W, H } = host.size()
      if (!guideWrite(text, shown, a, W, H)) {
        // no outline: before anything was written (a lone first point) keep what
        // the type shows; after a write (undo back to empty) put the opening
        // guide and position back, as cancel does, so the type matches the drawing
        if (recorded) {
          written = json
          writeLayer(textId, l => restoreGuide(l, text))
        }
        return
      }
      written = json
      ensureRecorded()
      writeLayer(textId, l => guideWrite(l, shown, a, W, H))
    }
    const pen = usePen({ doc, view, options: { openOnly: true, tools: GUIDE_PEN_TOOLS }, onChange: preview, onLiveChange: preview })
    pen.selectTool(editing ? 'select' : 'path')
    session.value = { target: { kind: 'guide', textId }, pen, doc, view, key: ++seq }
  }

  function open(target: FramePenTarget): void {
    if (target.kind === 'layer') { openLayer(target.id); return }
    if (target.kind === 'guide') { openGuide(target.textId); return }
    close()
    const doc = ref<SketchDoc>({ entities: [], constraints: [] })
    const view = computed(() => { const { W, H } = host.size(); return newDrawingView(W, H) })
    const pen = usePen({ doc, view, options: { tools: FRAME_PEN_TOOLS } })
    pen.selectTool('path')
    session.value = { target, pen, doc, view, key: ++seq }
  }

  function commitSession(): void {
    const s = session.value
    if (!s) return
    s.pen.finishSession()
    if (s.target.kind === 'new') {
      const sketch = s.doc.value
      if (localOutlineBounds(sketchToLocalD(sketch)) !== null) {
        const r = recentreSketch(sketch)
        if (r) {
          const { W, H } = host.size()
          const { x, y } = placementAfterRecentre({ x: 0.5, y: 0.5, scale: 1 }, r.shiftLocal, W, H)
          const style = isClosedDrawing(r.sketch) ? PEN_STYLE_CLOSED : PEN_STYLE_OPEN
          const layer = createPathLayer({
            ...penOutlines(r.sketch), sketch: r.sketch, bbox: r.bbox, scale: 1, x, y, ...style,
          } as any)
          close()
          host.addPathLayers([layer])
          host.selectLocal(layer.id)
          return
        }
      }
    }
    if (s.target.kind === 'guide') {
      const id = s.target.textId, a = guideAnchor!
      const startSketch = original?.path?.sketch
      const unchanged = JSON.stringify(s.doc.value) === JSON.stringify(startSketch ?? { entities: [], constraints: [] })
      if (!recorded && unchanged) { close(); host.selectLocal(id); return }   // never changed: nothing written, nothing recorded
      const { W, H } = host.size()
      const sk = cloneDoc(s.doc.value)
      if (!guideWrite(original, sk, a, W, H)) { cancelSession(); return }   // no outline: treat as cancel
      ensureRecorded()
      close()
      writeLayer(id, l => guideWrite(l, sk, a, W, H))
      host.selectLocal(id)
      return
    }
    if (s.target.kind === 'layer') {
      const id = s.target.id
      // never changed: write nothing, record nothing
      if (!recorded && JSON.stringify(s.doc.value) === JSON.stringify(original?.sketch)) { close(); return }
      const r = localOutlineBounds(sketchToLocalD(s.doc.value)) !== null ? recentreSketch(s.doc.value) : null
      if (!r) { cancelSession(); return }   // nothing left to draw: treat as cancel
      const { W, H } = host.size()
      const live = host.layers().find(l => l.id === id) ?? original
      // a closed drawing trimmed (or cut) open must not stay a fill with no stroke
      const opened = !!original?.sketch && isClosedDrawing(original.sketch) && !isClosedDrawing(s.doc.value)
      ensureRecorded()   // normally already done by the first preview
      close()
      if (clonerBlocksRecentre(live)) {
        // copies with their own rotation/scale would jump: keep the pivot, store the outline as drawn
        const sk = cloneDoc(s.doc.value)
        const b = localOutlineBounds(sketchToLocalD(sk))!
        const bbox = { w: Math.max(b.maxX - b.minX, 0.001), h: Math.max(b.maxY - b.minY, 0.001) }
        writeLayer(id, l => ({ ...withPenOutlines(l, sk), bbox, ...(opened ? openedStyle(l) : {}) }))
        return
      }
      const { x, y } = placementAfterRecentre(layerPlacementForView(live), r.shiftLocal, W, H)
      writeLayer(id, l => ({ ...withPenOutlines(l, r.sketch), bbox: r.bbox, x, y, ...(opened ? openedStyle(l) : {}) }))
      return
    }
    close()
  }

  function cancelSession(): void {
    const s = session.value
    if (s?.target.kind === 'guide' && original) {
      const id = s.target.textId, orig = original, wrote = recorded
      close()
      // the guide and the text's position exactly as they were (other edits survive)
      if (wrote) writeLayer(id, l => restoreGuide(l, orig))
      return
    }
    if (s?.target.kind === 'layer' && original) {
      const id = s.target.id, orig = original, wrote = recorded, filled = penFilled
      close()
      // only what the pen wrote goes back (previews touch d/sketch/fillD alone,
      // and the fill colour only when the pen gave it and it is still the pen's
      // colour — a colour the user picked meanwhile stays), so an inspector edit made
      // meanwhile (fill, stroke) survives; nothing written → nothing to put back,
      // and no undo step was left behind
      if (wrote) {
        writeLayer(id, l => {
          const { fillD: _pen, ...rest } = l
          return { ...rest, d: orig.d, sketch: orig.sketch, ...(orig.fillD ? { fillD: orig.fillD } : {}), ...(filled && l.fill === PEN_STYLE_CLOSED.fill ? { fill: orig.fill } : {}) }
        })
      }
      return
    }
    close()
  }

  // Torn down mid-session (the modal closed): a layer session puts its layer back
  // first, so no half-edited preview (with a stale bbox) outlives the pen.
  if (getCurrentScope()) onScopeDispose(cancelSession)

  return { session, open, commitSession, cancelSession }
}
