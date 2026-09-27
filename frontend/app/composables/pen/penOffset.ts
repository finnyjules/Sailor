// app/composables/pen/penOffset.ts
// Pen stage 8: the Offset tool (lib/sketch/offset.ts does the geometry). The
// preview lives in `view` only — the drawing is untouched until Apply, which
// is one history step; anything that ends the gesture without Apply drops it
// (Global Constraints). Pure over the refs it is handed (usePen builds it, as
// penCorners, whose patterns it follows).
import { shallowRef, toRaw, watch, type Ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import type { Vec2 } from '~/lib/sketch/geom'
import type { ViewMatrix } from '~/lib/sketch/view'
import { pxToUnits } from '~/lib/sketch/tolerance'
import { nearestCurve, type CurveRef } from '~/lib/sketch/crossings'
import type { SegPick } from '~/lib/sketch/pieces'
import { offsetSource, offsetGeom, offsetGeomD, applyOffset, offsetDistanceAt, type OffsetChain } from '~/lib/sketch/offset'
import { rulesHold } from './penCorners'

export const OFFSET_HIT_PX = 8
export const OFFSET_DEFAULT_PX = 12
export const OFFSET_DRAG_PX = 3
export const OFFSET_TOO_FAR = 'Too far for this path'
export const OFFSET_MISS = 'Click a path, line or circle to offset'
export const OFFSET_CURVE = 'Bézier curves can’t be offset'

export interface OffsetToolView {
  chains: OffsetChain[]
  d: number            // signed distance, drawing units (left of travel +)
  typed: string
  source: string       // the source's outline (drawing space)
  preview: string      // the offset's outline (drawing space)
  ok: boolean
  chip: Vec2           // drawing space
}

export interface PenOffsetContext {
  doc: Ref<SketchDoc>
  view: Ref<ViewMatrix>
  tool: Ref<string>
  status: Ref<string>
  docRevision: Ref<number>
  commitHistory: () => void
  runSolve: () => void
  clearSel: () => void
  closeMenus: () => void
}

type Picks = { sel: EntityId[]; segs: SegPick[] }

/** The distance from `p` to the nearest Bézier piece within `tol`, or null —
 *  nearestCurve leaves curves out, and a click on one must say why it can't
 *  be offset rather than "click a path". Handles missing (null) sit on the ends. */
function curveHit(doc: SketchDoc, p: Vec2, tol: number): number | null {
  const pts = new Map<EntityId, Vec2>()
  for (const e of doc.entities) if (e.kind === 'point') pts.set(e.id, e)
  let best: number | null = null
  for (const e of doc.entities) {
    if (e.kind !== 'path') continue
    const n = e.anchors.length, m = e.closed ? n : n - 1
    for (let i = 0; i < m; i++) {
      const s = e.segments[i]
      if (s?.kind !== 'cubic') continue
      const a = pts.get(e.anchors[i]!), b = pts.get(e.anchors[(i + 1) % n]!)
      if (!a || !b) continue
      const h1 = (s.h1 && pts.get(s.h1)) || a, h2 = (s.h2 && pts.get(s.h2)) || b
      let prev = a
      for (let k = 1; k <= 24; k++) {
        const t = k / 24, u = 1 - t
        const q = {
          x: u * u * u * a.x + 3 * u * u * t * h1.x + 3 * u * t * t * h2.x + t * t * t * b.x,
          y: u * u * u * a.y + 3 * u * u * t * h1.y + 3 * u * t * t * h2.y + t * t * t * b.y,
        }
        const dx = q.x - prev.x, dy = q.y - prev.y, L2 = dx * dx + dy * dy
        const w = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - prev.x) * dx + (p.y - prev.y) * dy) / L2)) : 0
        const dd = Math.hypot(p.x - prev.x - w * dx, p.y - prev.y - w * dy)
        if (dd <= tol && (best === null || dd < best)) best = dd
        prev = q
      }
    }
  }
  return best
}

export function createPenOffset(ctx: PenOffsetContext) {
  const view = shallowRef<OffsetToolView | null>(null)
  const hover = shallowRef<string | null>(null)
  let lastD: number | null = null
  let press: { sx: number; sy: number; moved: boolean } | null = null
  let picks: Picks = { sel: [], segs: [] }
  // the source's outline, kept for the chains it was drawn from (a drag frame
  // only redraws the offset)
  let sourceOf: { chains: OffsetChain[]; d: string } | null = null
  // the drawing the live preview was built on: when it changes any other way
  // (a menu action, Delete, undo…) the preview no longer describes it and is
  // dropped untouched
  let built: { rev: number; raw: SketchDoc } | null = null

  const raw = () => toRaw(ctx.doc.value)
  const active = () => ctx.tool.value === 'offset'
  const tol = () => pxToUnits(OFFSET_HIT_PX, ctx.view.value)
  /** Drops a preview built on a drawing that has since changed; true when it did. */
  function dropStale(): boolean {
    if (!view.value || (built && built.rev === ctx.docRevision.value && built.raw === raw())) return false
    cancel(false)
    return true
  }
  watch(() => [ctx.docRevision.value, ctx.doc.value], () => { dropStale() }, { flush: 'sync' })
  /** Typed text that is no distance ('0', '.', '0.0'): Enter and a release wait. */
  const typedOk = (v: OffsetToolView) => !v.typed || Number(v.typed) > 0

  function show(chains: OffsetChain[], d: number, typed: string, chip?: Vec2): void {
    const r = raw()
    const g = offsetGeom(r, chains, d)
    if (!sourceOf || sourceOf.chains !== chains) sourceOf = { chains, d: offsetGeomD(offsetGeom(r, chains, 0)) }
    const first = g.chains.find(c => c.pts.length)?.pts[0] ?? g.chains[0]?.circle?.c ?? { x: 0, y: 0 }
    view.value = { chains, d, typed, source: sourceOf.d, preview: offsetGeomD(g), ok: g.ok, chip: chip ?? view.value?.chip ?? first }
    built = { rev: ctx.docRevision.value, raw: r }
  }
  const defaultSize = () => Math.abs(lastD ?? pxToUnits(OFFSET_DEFAULT_PX, ctx.view.value))
  /** Shows the picks' preview. `keep`: the live preview's distance and typed
   *  text carry over (Shift-click adds); otherwise the default distance, on
   *  the side of the click `at` (Ruling 11). Nothing changes when the picks
   *  can't be offset. */
  function fromPicks(next: Picks, keep: boolean, at?: Vec2): boolean {
    const r = raw()
    const s = offsetSource(r, next.sel, next.segs)
    if (!s.ok) { if (s.why === 'curve') ctx.status.value = OFFSET_CURVE; return false }
    const v = keep ? view.value : null
    let d: number
    if (v) d = v.d
    else if (at) d = (offsetDistanceAt(r, s.chains, at) < 0 ? -1 : 1) * defaultSize()
    else d = lastD ?? defaultSize()
    picks = next
    show(s.chains, d, v?.typed ?? '')
    return true
  }
  /** The tool was just picked: the selection starts as the source. */
  function start(sel: readonly EntityId[], segs: readonly SegPick[]): void {
    cancel(false)
    const next = { sel: [...sel], segs: segs.map(s => ({ pathId: s.pathId, segIndex: s.segIndex })) }
    if (next.sel.length || next.segs.length) fromPicks(next, false)
  }
  function pickOf(ref: CurveRef, onePiece: boolean): Picks {
    if (ref.kind === 'seg') return onePiece ? { sel: [], segs: [{ pathId: ref.pathId, segIndex: ref.segIndex }] } : { sel: [ref.pathId], segs: [] }
    return { sel: [ref.id], segs: [] }
  }
  /** The hit is already part of the live source. */
  function inSource(ref: CurveRef): boolean {
    if (ref.kind !== 'seg') return picks.sel.includes(ref.id)
    return picks.sel.includes(ref.pathId) || picks.segs.some(s => s.pathId === ref.pathId && s.segIndex === ref.segIndex)
  }
  function move(x: number, y: number): void {
    if (!active()) { if (hover.value) hover.value = null; return }
    dropStale()
    const v = view.value
    if (press) {
      if (!v) return
      if (!press.moved && Math.hypot(x - press.sx, y - press.sy) > pxToUnits(OFFSET_DRAG_PX, ctx.view.value)) press.moved = true
      if (!press.moved || v.typed) return   // a typed distance wins over the pointer
      show(v.chains, offsetDistanceAt(raw(), v.chains, { x, y }), '', { x, y })
      return
    }
    if (v) { if (hover.value) hover.value = null; return }
    const r = raw()
    const hit = nearestCurve(r, { x, y }, tol())
    const p = hit ? pickOf(hit.ref, false) : null
    const s = p ? offsetSource(r, p.sel, p.segs) : null
    const d = s?.ok ? offsetGeomD(offsetGeom(r, s.chains, 0)) : null
    if (d !== hover.value) hover.value = d
  }
  function down(x: number, y: number, additive: boolean, onePiece: boolean): void {
    if (!active()) return
    ctx.closeMenus()
    dropStale()
    const r = raw(), at = { x, y }
    const hit = nearestCurve(r, at, tol())
    const curve = curveHit(r, at, tol())
    if (curve !== null && (!hit || curve < hit.dist)) { ctx.status.value = OFFSET_CURVE; return }
    if (hit) {
      if (!view.value || !inSource(hit.ref)) {
        const p = pickOf(hit.ref, onePiece)
        const add = additive && !!view.value
        const next = add ? { sel: [...picks.sel, ...p.sel], segs: [...picks.segs, ...p.segs] } : p
        if (!fromPicks(next, add, at)) return
      }
      hover.value = null
      press = { sx: x, sy: y, moved: false }
      return
    }
    if (!view.value) { ctx.status.value = OFFSET_MISS; return }
    press = { sx: x, sy: y, moved: false }
  }
  function up(): void {
    const p = press
    press = null
    if (p?.moved && view.value) apply()
  }
  /** Digits, `.`, Backspace, −, Enter, Escape while a preview is live. */
  function key(ev: KeyboardEvent): boolean {
    if (!active() || ev.metaKey || ev.ctrlKey || ev.altKey) return false
    dropStale()
    const v = view.value
    if (!v) return false
    const sign = v.d < 0 ? -1 : 1
    const typeTo = (s: string) => { const n = Number(s); show(v.chains, s && Number.isFinite(n) && n > 0 ? sign * n : v.d, s) }
    if (/^[0-9]$/.test(ev.key) || (ev.key === '.' && !v.typed.includes('.'))) { typeTo(v.typed + ev.key); return true }
    if (ev.key === 'Backspace' && v.typed) { typeTo(v.typed.slice(0, -1)); return true }
    if (ev.key === '-' || ev.key === '−') { show(v.chains, -v.d, v.typed); return true }
    if (ev.key === 'Enter') { apply(); return true }   // typed text that is no distance: Enter waits
    if (ev.key === 'Escape') { cancel(true); return true }
    return false
  }
  function apply(): boolean {
    if (dropStale()) return false
    const v = view.value
    if (!v || !typedOk(v)) return false
    // a source piece that has gone is not "too far"
    const again = offsetSource(raw(), picks.sel, picks.segs)
    if (!again.ok) { cancel(false); ctx.status.value = OFFSET_MISS; return false }
    if (!v.ok) { ctx.status.value = OFFSET_TOO_FAR; return false }
    // applyOffset leaves the drawing exactly as it was when it refuses, and
    // otherwise adds to the doc it is handed (the raw one — never through
    // Vue's proxies). The doc ref then gets a fresh shell over those arrays
    // so everything reading `doc.value` redraws.
    const work = raw()
    const made = applyOffset(work, v.chains, v.d)
    if (!made.ok) { ctx.status.value = OFFSET_TOO_FAR; return false }
    press = null
    view.value = null
    hover.value = null
    built = null
    sourceOf = null
    picks = { sel: [], segs: [] }
    lastD = v.d
    ctx.doc.value = { ...work }
    ctx.clearSel()
    if (!rulesHold(work, made.rules)) ctx.runSolve()
    ctx.commitHistory()
    ctx.status.value = 'Offset'
    return true
  }
  function cancel(say: boolean): void {
    press = null
    built = null
    sourceOf = null
    picks = { sel: [], segs: [] }
    const had = !!view.value
    view.value = null
    if (say && had) ctx.status.value = 'Cancelled'
  }
  return { view, hover, start, move, down, up, key, apply, cancel }
}
