// app/composables/pen/penCorners.ts
// Pen stage 8: the Round corner and Chamfer tools (lib/sketch/corners.ts
// does the geometry). The preview lives in `view` only — the drawing is
// untouched until Apply, which is one history step; anything that ends the
// gesture without Apply drops it (Global Constraints). Pure over the refs it
// is handed (usePen builds it, as penCopies).
import { shallowRef, toRaw, type Ref } from 'vue'
import type { SketchDoc, EntityId, PointEntity } from '~/lib/sketch/model'
import type { Vec2 } from '~/lib/sketch/geom'
import type { ViewMatrix } from '~/lib/sketch/view'
import { pxToUnits } from '~/lib/sketch/tolerance'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { cornersOf, cornerAt, cornerPreview, roundCorners, sizeFromPointer, fittingSize, type CornerKind, type Corner } from '~/lib/sketch/corners'

export const CORNER_HIT_PX = 10
export const CORNER_DEFAULT_PX = 12
export const CORNER_DRAG_PX = 3
export const CORNER_TOO_BIG = 'Too big for this corner'
export const CORNER_MISS = 'Click a corner where two pieces meet'

export interface CornerToolView {
  kind: CornerKind
  corners: EntityId[]
  size: number
  typed: string
  d: string
  fits: boolean
  bad: { at: Vec2; d: string }[]
  chip: Vec2
}

export interface PenCornersContext {
  doc: Ref<SketchDoc>
  view: Ref<ViewMatrix>
  tool: Ref<string>
  status: Ref<string>
  docRevision: Ref<number>
  commitHistory: () => void
  runSolve: () => void
  clearSel: () => void
  closeMenus: () => void
  sparkle: (x: number, y: number) => void
}

/** The new rules hold as placed (Global Constraints: Apply solves only when they don't). */
export function rulesHold(doc: SketchDoc, ids: readonly EntityId[]): boolean {
  if (!ids.length) return true
  const set = new Set(ids)
  const r = constraintResiduals({ entities: doc.entities, constraints: doc.constraints.filter(c => set.has(c.id)) })
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const e of doc.entities) if (e.kind === 'point') { x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y); x1 = Math.max(x1, e.x); y1 = Math.max(y1, e.y) }
  const tol = 1e-7 * Math.max(1, Number.isFinite(x0) ? Math.hypot(x1 - x0, y1 - y0) : 1)
  return r.every(v => Math.abs(v) <= tol)
}

export function createPenCorners(ctx: PenCornersContext) {
  const view = shallowRef<CornerToolView | null>(null)
  const hover = shallowRef<EntityId | null>(null)
  const lastSize: Partial<Record<CornerKind, number>> = {}
  let press: { corner: EntityId; sx: number; sy: number; moved: boolean } | null = null
  let cache: { rev: number; raw: SketchDoc; map: Map<EntityId, Corner> } | null = null

  const raw = () => toRaw(ctx.doc.value)
  const active = () => ctx.tool.value === 'round' || ctx.tool.value === 'chamfer'
  const kindNow = (): CornerKind => (ctx.tool.value === 'chamfer' ? 'chamfer' : 'round')
  function corners(): Map<EntityId, Corner> {
    const d = raw()
    if (!cache || cache.rev !== ctx.docRevision.value || cache.raw !== d) cache = { rev: ctx.docRevision.value, raw: d, map: cornersOf(d) }
    return cache.map
  }
  function show(kind: CornerKind, picks: EntityId[], size: number, typed: string): void {
    const d = raw()
    const pv = cornerPreview(d, picks, kind, size)
    const first = d.entities.find(e => e.id === picks[0])
    const chip = first && first.kind === 'point' ? { x: first.x, y: first.y } : { x: 0, y: 0 }
    view.value = { kind, corners: picks, size, typed, d: pv.d, fits: pv.fits, bad: pv.bad, chip }
  }
  function defaultSize(kind: CornerKind, picks: EntityId[]): number {
    return fittingSize(raw(), picks, kind, lastSize[kind] ?? pxToUnits(CORNER_DEFAULT_PX, ctx.view.value))
  }
  /** The tool was just picked: the corners among `sel` start picked. */
  function start(kind: CornerKind, sel: readonly EntityId[]): void {
    cancel(false)
    const map = corners()
    const picks = sel.filter(id => map.has(id))
    if (picks.length) show(kind, picks, defaultSize(kind, picks), '')
  }
  function move(x: number, y: number): void {
    if (!active()) { if (hover.value) hover.value = null; return }
    if (press) {
      const v = view.value
      if (!v) return
      if (!press.moved && Math.hypot(x - press.sx, y - press.sy) > pxToUnits(CORNER_DRAG_PX, ctx.view.value)) press.moved = true
      if (!press.moved || v.typed) return   // a typed size wins over the pointer
      const c = corners().get(press.corner)
      if (!c) return
      show(v.kind, v.corners, sizeFromPointer(raw(), c, v.kind, { x, y }), '')
      return
    }
    const hit = cornerAt(raw(), { x, y }, pxToUnits(CORNER_HIT_PX, ctx.view.value), corners())
    if (hit !== hover.value) hover.value = hit
  }
  function down(x: number, y: number, additive: boolean): void {
    if (!active()) return
    ctx.closeMenus()
    const hit = cornerAt(raw(), { x, y }, pxToUnits(CORNER_HIT_PX, ctx.view.value), corners())
    if (!hit) { ctx.status.value = CORNER_MISS; return }
    const kind = kindNow(), v = view.value
    const had = v?.corners ?? []
    const picks = additive ? (had.includes(hit) ? had.filter(id => id !== hit) : [...had, hit]) : (had.includes(hit) ? had : [hit])
    if (!picks.length) { cancel(false); return }
    const size = v && v.kind === kind ? v.size : defaultSize(kind, picks)
    show(kind, picks, v?.typed ? Number(v.typed) || size : size, v?.typed ?? '')
    press = picks.includes(hit) ? { corner: hit, sx: x, sy: y, moved: false } : null
  }
  function up(): void {
    const p = press
    press = null
    if (p?.moved && view.value) apply()
  }
  function typeTo(s: string): void {
    const v = view.value!
    const n = Number(s)
    show(v.kind, v.corners, s && Number.isFinite(n) && n > 0 ? n : v.size, s)
  }
  /** Digits, `.`, Backspace, Enter, Escape while a preview is live. */
  function key(ev: KeyboardEvent): boolean {
    const v = view.value
    if (!v || !active() || ev.metaKey || ev.ctrlKey || ev.altKey) return false
    if (/^[0-9]$/.test(ev.key) || (ev.key === '.' && !v.typed.includes('.'))) { typeTo(v.typed + ev.key); return true }
    if (ev.key === 'Backspace' && v.typed) { typeTo(v.typed.slice(0, -1)); return true }
    if (ev.key === 'Enter') { apply(); return true }
    if (ev.key === 'Escape') { cancel(true); return true }
    return false
  }
  function apply(): boolean {
    const v = view.value
    if (!v) return false
    if (!v.fits) { ctx.status.value = CORNER_TOO_BIG; return false }
    // roundCorners leaves the drawing exactly as it was when it refuses, and
    // on success copies its result back into the doc it was handed (the raw
    // one — never through Vue's proxies). The doc ref then gets a fresh shell
    // over those arrays so everything reading `doc.value` redraws.
    const work = raw()
    const built = roundCorners(work, v.corners, v.kind, v.size)
    if (!built.ok) { ctx.status.value = CORNER_TOO_BIG; return false }
    const at = v.corners.map(id => work.entities.find(e => e.id === id)).filter((e): e is PointEntity => e?.kind === 'point')
    press = null
    view.value = null
    hover.value = null
    lastSize[v.kind] = v.size
    ctx.doc.value = { ...work }
    ctx.clearSel()
    if (!rulesHold(work, built.rules)) ctx.runSolve()
    ctx.commitHistory()
    for (const p of at.slice(0, 12)) ctx.sparkle(p.x, p.y)
    ctx.status.value = v.kind === 'round' ? 'Rounded' : 'Chamfered'
    return true
  }
  function cancel(say: boolean): void {
    press = null
    const had = !!view.value
    view.value = null
    if (say && had) ctx.status.value = 'Cancelled'
  }
  return { view, hover, start, move, down, up, key, apply, cancel }
}
