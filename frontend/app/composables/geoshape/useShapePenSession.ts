/**
 * Shape Studio's shared-pen SESSION (Plan C, Task 4): the active layer's Drawn
 * unit is drawn and edited with the pen over the preview.
 *
 * - `open()` works on the ACTIVE layer. It remembers the mark's `shape`, `sketch` and
 *   `size` exactly (cancel puts them back — these are the only fields the session
 *   itself writes, via `settle`/`open`), fixes the refit factor `k` and the drawing's
 *   outline centre (Decision 3), asks the host for the frozen preview frame
 *   (Decision 5), and switches the mark to `drawn` if it was something else.
 *   `paintTarget` is NOT remembered: the Paint section stays live and editable while
 *   the pen is open, so a "Colour applies to" change the user makes mid-session is
 *   their own and survives Cancel — only Decision 6, at commit, ever flips it.
 * - Settled pen changes (`onChange`: a finished gesture, undo, redo) write the
 *   drawing into the mark WITHOUT re-centring, with `size = k × extent`, so the
 *   composite behind the pen follows and the frozen view stays valid. Mid-gesture
 *   changes (`onLiveChange`) write nothing — the overlay shows those live, and every
 *   write triggers the surface's full re-render.
 * - `commitSession()` re-centres (`commitDrawn`) and writes the result; an open
 *   drawing on a filled mark becomes an outline (Decision 6). No outline → cancel.
 * - `cancelSession()` restores the three remembered fields. Tearing down the host's
 *   scope mid-session cancels too.
 *
 * Shape Studio has no undo of its own: the pen's history is the only undo, and it
 * lives as long as the session. Construction is side-effect free (vitest, node env).
 */
import { ref, shallowRef, computed, getCurrentScope, onScopeDispose, type Ref, type ComputedRef, type ShallowRef } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { cloneDoc } from '~/lib/sketch/clone'
import type { GeoStudioDoc, GeoLayer } from '~/lib/geoshape/studio'
import type { GeoShapeConfig } from '~/lib/geoshape/config'
import { sketchOutlineBounds } from '~/lib/geoshape/shapes'
import { naturalExtent, refitFactor, shapePenView, commitDrawn, type PreviewFrame } from '~/lib/geoshape/penShape'
import { usePen, type Pen, type PenTool } from '~/composables/pen/usePen'

export interface ShapePenHost {
  /** The live, reactive studio doc. */
  doc: () => GeoStudioDoc
  /** The active layer's index. */
  layerIndex: () => number
  /** The preview framing to freeze for the session (called once, at open). */
  frameFor: (layer: GeoLayer) => PreviewFrame
}

export interface ShapePenSession {
  pen: Pen
  doc: Ref<SketchDoc>
  view: ComputedRef<ViewMatrix>
  key: number
  layerId: string
  /** The frozen preview framing (CSS px per doc unit, see PreviewFrame). Frozen against
   *  the drawing, not against the window: `resize` re-fits it to a new preview size. */
  frame: ShallowRef<PreviewFrame>
}

/**
 * The same frozen framing for a preview resized to `cssW × cssH` CSS px. The preview keeps
 * the canvas's aspect and pads in DOC units, so its normal fit scales in proportion to the
 * box: the doc point at the centre stays the centre and the scale follows the box (the
 * tighter axis, should rounding make the two ratios differ). Resizing back returns the original framing (up to rounding).
 */
export function resizedFrame(frame: PreviewFrame, cssW: number, cssH: number): PreviewFrame {
  if (!(cssW > 0) || !(cssH > 0) || !(frame.cssW > 0) || !(frame.cssH > 0)) return frame
  const r = Math.min(cssW / frame.cssW, cssH / frame.cssH)
  return { cx: frame.cx, cy: frame.cy, scale: frame.scale * r, cssW, cssH }
}

/** The tools a Drawn shape offers (Select is always added by the pen). */
export const SHAPE_PEN_TOOLS: PenTool[] = ['select', 'path', 'curve', 'line', 'circle', 'point', 'trim', 'cut', 'dissolve']

/** True when the drawing's visible outline has a closed path or a circle. */
export function hasClosedOutline(doc: SketchDoc): boolean {
  return doc.entities.some(e => !e.construction && ((e.kind === 'path' && e.closed) || e.kind === 'circle'))
}

type Original = Pick<GeoShapeConfig, 'shape' | 'size'> & { sketch: SketchDoc | undefined }

export function useShapePenSession(host: ShapePenHost) {
  const session = shallowRef<ShapePenSession | null>(null)
  let seq = 0
  let original: Original | null = null
  let k = 1

  function layerOf(id: string): GeoLayer | undefined {
    return host.doc().layers.find(l => l.layerId === id)
  }

  function close() {
    const s = session.value
    original = null
    if (!s) return
    session.value = null
    s.pen.dispose()
  }

  function open(): void {
    cancelSession()   // a session still open puts its layer back first
    const layer = host.doc().layers[host.layerIndex()]
    if (!layer) return
    const mark = layer.mark
    original = {
      shape: mark.shape, size: mark.size,
      sketch: mark.sketch ? cloneDoc(mark.sketch) : undefined,
    }
    const start: SketchDoc = mark.sketch ? cloneDoc(mark.sketch) : { entities: [], constraints: [] }
    k = refitFactor(start, mark.size)
    const b = sketchOutlineBounds(start)
    const centre = b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 0, y: 0 }
    const frame = shallowRef(host.frameFor(layer))
    const layerId = layer.layerId
    const doc = ref<SketchDoc>(start)
    // The frame, k and centre are fixed; the placement is read live (it is not locked).
    const view = computed(() => shapePenView(frame.value, (layerOf(layerId) ?? layer).offset, k, centre))
    const settle = () => {
      const m = layerOf(layerId)?.mark
      if (!m) return
      const sk = cloneDoc(doc.value)
      m.sketch = sk
      const ext = naturalExtent(sk)
      if (ext > 0) m.size = k * ext
    }
    const pen = usePen({ doc, view, options: { tools: SHAPE_PEN_TOOLS }, onChange: settle })
    pen.selectTool(start.entities.length ? 'select' : 'path')
    if (mark.shape !== 'drawn') mark.shape = 'drawn'
    session.value = { pen, doc, view, key: ++seq, layerId, frame }
  }

  function commitSession(): void {
    const s = session.value
    if (!s) return
    s.pen.finishSession()
    const r = commitDrawn(s.doc.value, k)
    if (!r) { cancelSession(); return }
    const m = layerOf(s.layerId)?.mark
    close()
    if (!m) return
    m.shape = 'drawn'
    m.sketch = r.sketch
    m.size = r.size
    if (!hasClosedOutline(r.sketch) && m.paintTarget === 'fill') m.paintTarget = 'outline'
  }

  function cancelSession(): void {
    const s = session.value
    const orig = original
    close()
    if (!s || !orig) return
    const m = layerOf(s.layerId)?.mark
    if (!m) return
    m.shape = orig.shape
    m.size = orig.size
    // paintTarget is deliberately left as the user set it (M3): the session never
    // writes it itself (only commitSession's Decision 6 does), so cancel has nothing
    // of its own to undo there.
    if (orig.sketch) m.sketch = orig.sketch
    else delete m.sketch
  }

  /** The preview is now `cssW × cssH` CSS px: re-fit the frozen frame (view, overlay and
   *  composite stay aligned). No-op without a session or when the size is unchanged. */
  function resize(cssW: number, cssH: number): void {
    const s = session.value
    if (!s) return
    const f = s.frame.value
    if (f.cssW === cssW && f.cssH === cssH) return
    s.frame.value = resizedFrame(f, cssW, cssH)
  }

  if (getCurrentScope()) onScopeDispose(cancelSession)

  return { session, open, commitSession, cancelSession, resize }
}
