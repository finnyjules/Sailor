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
 *     render the drawing live. One undo step is recorded at open; commit
 *     re-centres and writes `d`/`sketch`/`bbox`/`x`/`y`; cancel writes the
 *     original layer back exactly.
 *   - `{ kind: 'guide' }` — drawing a text guide; arrives in Task 9. Until then
 *     `open` ignores it.
 *
 * Construction is side-effect free (no DOM, no lifecycle hooks) so vitest can
 * run it in `node`; the pen is disposed whenever a session closes and, when
 * created inside a component's scope, when that scope is torn down.
 */
import { ref, shallowRef, computed, getCurrentScope, onScopeDispose, type Ref, type ComputedRef } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { cloneDoc } from '~/lib/sketch/clone'
import { layoutScaleOf } from '~/lib/frame/responsive/layoutScale'
import type { ViewMatrix } from '~/lib/sketch/view'
import { usePen, type Pen, type PenTool } from '~/composables/pen/usePen'
import { createPathLayer } from '~/composables/useCompositorLayers'
import {
  sketchToLocalD, localOutlineBounds, recentreSketch, newDrawingView, placementAfterRecentre, layerView,
  type LayerPlacement,
} from '~/lib/compositor/penFrame'

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
export const FRAME_PEN_TOOLS: PenTool[] = ['select', 'path', 'curve', 'line', 'circle', 'point']

/** Plan B decision 4: a closed drawing is filled, an open one is stroked — a
 *  filled open path would draw a chord-closed blob, which reads as a bug. */
export const PEN_STYLE_CLOSED = { fill: '#3b82f6', stroke: '', strokeWidth: 0 } as const
export const PEN_STYLE_OPEN = { fill: 'none', stroke: '#3b82f6', strokeWidth: 0.004 } as const

/** True when the drawing's visible outline is closed: any non-construction
 *  path that is closed, or any non-construction circle. */
export function isClosedDrawing(doc: SketchDoc): boolean {
  return doc.entities.some(e =>
    !e.construction && ((e.kind === 'path' && e.closed) || e.kind === 'circle'))
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

export function useFramePenSession(host: FramePenHost) {
  const session = shallowRef<FramePenSession | null>(null)
  let seq = 0
  // `{ kind: 'layer' }`: the layer exactly as it was when the session opened
  let original: any = null

  function close() {
    const s = session.value
    original = null
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
    host.recordHistory()   // the session's ONE undo step
    const doc = ref<SketchDoc>(cloneDoc(found.sketch))
    // Read the placement from the LIVE layer (previews never touch x/y), so a
    // layer moved before the session opened is where the pen draws.
    const view = computed(() => {
      const { W, H } = host.size()
      const live = host.layers().find(l => l.id === id) ?? found
      return layerView(layerPlacementForView(live), W, H)
    })
    const preview = () => {
      const sk = cloneDoc(doc.value)
      writeLayer(id, l => ({ ...l, d: sketchToLocalD(sk), sketch: sk }))
    }
    const pen = usePen({ doc, view, options: { tools: FRAME_PEN_TOOLS }, onChange: preview, onLiveChange: preview })
    pen.selectTool('select')
    session.value = { target: { kind: 'layer', id }, pen, doc, view, key: ++seq }
  }

  function open(target: FramePenTarget): void {
    if (target.kind === 'layer') { openLayer(target.id); return }
    if (target.kind !== 'new') return   // 'guide' (Task 9)
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
            d: sketchToLocalD(r.sketch), sketch: r.sketch, bbox: r.bbox, scale: 1, x, y, ...style,
          } as any)
          close()
          host.addPathLayers([layer])
          host.selectLocal(layer.id)
          return
        }
      }
    }
    if (s.target.kind === 'layer') {
      const id = s.target.id
      const r = localOutlineBounds(sketchToLocalD(s.doc.value)) !== null ? recentreSketch(s.doc.value) : null
      if (!r) { cancelSession(); return }   // nothing left to draw: treat as cancel
      const { W, H } = host.size()
      const live = host.layers().find(l => l.id === id) ?? original
      const { x, y } = placementAfterRecentre(layerPlacementForView(live), r.shiftLocal, W, H)
      close()
      // the one undo step was recorded at open
      writeLayer(id, l => ({ ...l, d: sketchToLocalD(r.sketch), sketch: r.sketch, bbox: r.bbox, x, y }))
      return
    }
    close()
  }

  function cancelSession(): void {
    const s = session.value
    if (s?.target.kind === 'layer' && original) {
      const id = s.target.id, orig = original
      close()
      // exactly as it was; the history entry recorded at open undoes to this same state
      writeLayer(id, () => orig)
      return
    }
    close()
  }

  if (getCurrentScope()) onScopeDispose(close)

  return { session, open, commitSession, cancelSession }
}
