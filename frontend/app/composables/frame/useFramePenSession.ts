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
 *   - `{ kind: 'layer' }` / `{ kind: 'guide' }` — reopening a drawn path and
 *     drawing a text guide; they arrive in Tasks 8–9. Until then `open` ignores
 *     them.
 *
 * Construction is side-effect free (no DOM, no lifecycle hooks) so vitest can
 * run it in `node`; the pen is disposed whenever a session closes and, when
 * created inside a component's scope, when that scope is torn down.
 */
import { ref, shallowRef, computed, getCurrentScope, onScopeDispose, type Ref, type ComputedRef } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { usePen, type Pen, type PenTool } from '~/composables/pen/usePen'
import { createPathLayer } from '~/composables/useCompositorLayers'
import {
  sketchToLocalD, localOutlineBounds, recentreSketch, newDrawingView, placementAfterRecentre,
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

export function useFramePenSession(host: FramePenHost) {
  const session = shallowRef<FramePenSession | null>(null)
  let seq = 0

  function close() {
    const s = session.value
    if (!s) return
    session.value = null
    s.pen.dispose()
  }

  function open(target: FramePenTarget): void {
    if (target.kind !== 'new') return   // 'layer' (Task 8) / 'guide' (Task 9)
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
    close()
  }

  function cancelSession(): void {
    close()
  }

  if (getCurrentScope()) onScopeDispose(close)

  return { session, open, commitSession, cancelSession }
}
