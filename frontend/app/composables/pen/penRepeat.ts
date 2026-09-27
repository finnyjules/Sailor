// app/composables/pen/penRepeat.ts
// Pen stage 8: the Repeat… panel's session (Rulings 12–17). The panel
// (PenRepeatPanel, inside PenProperties) edits it; the overlay's clicks pick
// its centre or path; the preview is drawn from the raw drawing with
// copiesPreviewD and never touches it; Apply is one step; while it is open
// the pen owns the keys (key()), as Clean up's preview does.
//
// The pure copy functions (edit.ts) refuse by returning [] with no reason,
// so every reason the status line gives is worked out here, before they run.
// Apply edits the raw drawing in place (never through Vue's proxies, never a
// whole-drawing clone) and gives the doc ref a fresh shell, as the corner and
// offset tools do; the copies are placed exactly, so it solves only when one
// of the rules it added doesn't hold as placed.
import { shallowRef, computed, toRaw, watch, type Ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import type { Vec2 } from '~/lib/sketch/geom'
import type { ViewMatrix } from '~/lib/sketch/view'
import { pxToUnits } from '~/lib/sketch/tolerance'
import { addPoint, addLine, repeatEntities, translateEntities, copyAlongPath } from '~/lib/sketch/edit'
import { drawingDirForScreenAngle } from '~/lib/sketch/sizes'
import { pieceIndex, pieceNames, pieceKey, type PieceRef } from '~/lib/sketch/pieces'
import { radialPlacements, linearPlacements, alongPlacements, copiesPreviewD, selectionCentre, selectionExtent, pathWalk, type Placement, type Spacing } from '~/lib/sketch/repeatModes'
import { rulesHold } from './penCorners'

export type RepeatMode = 'radial' | 'linear' | 'along'
export type RepeatCentre = { id: EntityId } | { at: Vec2 } | null
export type RepeatTarget = { kind: 'point'; id: EntityId } | { kind: 'piece'; ref: PieceRef } | { kind: 'empty'; at: Vec2 }
export interface RepeatState {
  mode: RepeatMode
  units: EntityId[]
  count: number
  sweep: number
  centre: RepeatCentre
  angle: number
  spacing: Spacing
  distance: number
  along: EntityId | null
  alongPiece: PieceRef | null
  preview: { d: string; ok: boolean; centre: Vec2 | null }
}
export type RepeatPatch = Partial<Pick<RepeatState, 'mode' | 'count' | 'sweep' | 'angle' | 'spacing' | 'distance'>>

export const REPEAT_NEED_SHAPE = 'Select a shape first, then Repeat…'
export const REPEAT_HINT_CENTRE = 'Click the centre of the ring — a point, or empty space'
export const REPEAT_HINT_PATH = 'Click the path to repeat along'
/** the hint row once nothing is left to click */
export const REPEAT_HINT_READY = 'Enter makes the copies · Esc cancels'
/** a path that is one of the shapes being repeated (Ruling 15) */
export const REPEAT_BAD_PATH = 'That path is being repeated — click another'
export const REPEAT_CURVE_PATH = 'Bézier curves can’t be followed'
export const REPEAT_NO_PATH = 'That path can’t be followed'
export const REPEAT_NO_DIRECTION = 'That angle can’t be drawn in this view'
/** the copy functions refused what the preview could draw (a broken drawing) */
export const REPEAT_CANT = 'These shapes can’t be repeated'
export const REPEAT_MAX = 64
const MODIFIERS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'])
const MODES: RepeatMode[] = ['radial', 'linear', 'along']
const SPACINGS: Spacing[] = ['step', 'span']
const ARROW_STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

export interface PenRepeatContext {
  doc: Ref<SketchDoc>
  view: Ref<ViewMatrix>
  status: Ref<string>
  selection: Ref<EntityId[]>
  docRevision: Ref<number>
  commitHistory: () => void
  runSolve: () => void
  clearSel: () => void
  closeMenus: () => void
}

// the key's target (else the focused element), if inside `sel`
function focused(ev: KeyboardEvent, sel: string): Element | null {
  const t = (ev.target ?? (typeof document !== 'undefined' ? document.activeElement : null)) as Element | null
  return t && typeof t.closest === 'function' ? t.closest(sel) : null
}

export function createPenRepeat(ctx: PenRepeatContext) {
  const state = shallowRef<RepeatState | null>(null)
  // the drawing the panel opened on: when it changes any other way (the host
  // swaps the layer, …) the preview no longer describes it and is dropped
  let built: { rev: number; raw: SketchDoc } | null = null
  const raw = () => toRaw(ctx.doc.value)
  const kindOf = (id: EntityId) => raw().entities.find(e => e.id === id)?.kind
  watch(() => [ctx.docRevision.value, ctx.doc.value], () => {
    if (state.value && !(built && built.rev === ctx.docRevision.value && built.raw === raw())) cancel(false)
  }, { flush: 'sync' })

  function centreAt(s: Pick<RepeatState, 'centre'>): Vec2 | null {
    const c = s.centre
    if (!c) return null
    if ('at' in c) return c.at
    const p = raw().entities.find(e => e.id === c.id)
    return p?.kind === 'point' ? { x: p.x, y: p.y } : null
  }
  function linearVec(s: Pick<RepeatState, 'angle' | 'distance'>): Vec2 | null {
    const dir = drawingDirForScreenAngle(ctx.view.value, s.angle)
    return dir ? { x: dir.x * s.distance, y: dir.y * s.distance } : null
  }
  /** Why a path can't be followed by these shapes, or null when it can. */
  function pathRefusal(units: readonly EntityId[], along: EntityId, count: number): string | null {
    if (units.includes(along)) return REPEAT_BAD_PATH
    const d = raw(), e = d.entities.find(x => x.id === along)
    if (e?.kind === 'path' && e.segments.some(s => s.kind === 'cubic')) return REPEAT_CURVE_PATH
    if (!pathWalk(d, along) || !alongPlacements(d, units, along, count)) return REPEAT_NO_PATH
    return null
  }
  function withPreview(s: Omit<RepeatState, 'preview'>): RepeatState {
    const d = raw()
    let placements: Placement[] | null = null
    let centre: Vec2 | null = null
    if (s.mode === 'radial') { centre = centreAt(s); placements = centre ? radialPlacements(centre, s.count, s.sweep) : null }
    else if (s.mode === 'linear') { const v = linearVec(s); placements = v ? linearPlacements(v, s.count, s.spacing) : null }
    else placements = s.along ? alongPlacements(d, s.units, s.along, s.count) : null
    const ok = !!placements?.length
    built = { rev: ctx.docRevision.value, raw: d }
    return { ...s, preview: { d: ok ? copiesPreviewD(d, s.units, placements!) : '', ok, centre } }
  }
  /** Why the preview can't be made (the status line on a refused Apply). */
  function refusal(s: RepeatState): string {
    if (s.mode === 'radial') return REPEAT_HINT_CENTRE
    if (s.mode === 'linear') return REPEAT_NO_DIRECTION
    return s.along ? (pathRefusal(s.units, s.along, s.count) ?? REPEAT_NO_PATH) : REPEAT_HINT_PATH
  }
  // the selection's drawn width along the linear direction, × 1.25 (Ruling
  // 14) — measured on what it draws (selectionExtent: arcs by the points they
  // sweep through, never their centres or handles), as the centre is
  function defaultDistance(units: EntityId[], angle: number): number {
    const dir = drawingDirForScreenAngle(ctx.view.value, angle)
    const x = dir ? selectionExtent(raw(), units, dir) : null
    const w = x ? x.hi - x.lo : NaN
    return Number.isFinite(w) && w > 0 ? 1.25 * w : pxToUnits(40, ctx.view.value)
  }

  function open(): boolean {
    const sel = ctx.selection.value
    const pts = sel.filter(id => kindOf(id) === 'point')
    const units = sel.filter(id => { const k = kindOf(id); return !!k && k !== 'point' })
    if (!units.length) { ctx.status.value = REPEAT_NEED_SHAPE; return false }
    ctx.closeMenus()
    state.value = withPreview({
      mode: 'radial', units, count: 6, sweep: 360, centre: pts.length === 1 ? { id: pts[0]! } : null,
      angle: 0, spacing: 'step', distance: defaultDistance(units, 0), along: null, alongPiece: null,
    })
    return true
  }
  /** Applies the patch; false when a value in it was refused (no value, out
   *  of range: the old one is kept) — the panel's Enter then does nothing.
   *  A count rounded or capped at REPEAT_MAX is taken, not refused. */
  /** Applies the patch; false when a value in it was refused (no value, out
   *  of range: the old one is kept) — the panel's Enter then does nothing.
   *  A count rounded, or capped at REPEAT_MAX, is taken. */
  function set(patch: RepeatPatch): boolean {
    const s = state.value
    if (!s) return false
    const next = { ...s, ...patch }
    // a value that is no value ('0', '.', empty, out of range) keeps the old one
    const bad = {
      count: !(Number.isFinite(next.count) && next.count >= 2),
      sweep: !(next.sweep > 0) || next.sweep > 360,
      distance: !(next.distance > 0) || !Number.isFinite(next.distance),
      angle: !Number.isFinite(next.angle),
      mode: !MODES.includes(next.mode),
      spacing: !SPACINGS.includes(next.spacing),
    }
    next.count = bad.count ? s.count : Math.min(REPEAT_MAX, Math.round(next.count))
    if (bad.sweep) next.sweep = s.sweep
    if (bad.distance) next.distance = s.distance
    if (bad.angle) next.angle = s.angle
    if (bad.mode) next.mode = s.mode
    if (bad.spacing) next.spacing = s.spacing
    state.value = withPreview(next)
    return !(Object.keys(bad) as (keyof typeof bad)[]).some(k => k in patch && bad[k])
  }
  function pick(t: RepeatTarget): void {
    const s = state.value
    if (!s) return
    if (s.mode === 'radial') {
      if (t.kind === 'point') state.value = withPreview({ ...s, centre: { id: t.id } })
      else if (t.kind === 'empty') state.value = withPreview({ ...s, centre: { at: t.at } })
      else ctx.status.value = REPEAT_HINT_CENTRE
      return
    }
    if (s.mode !== 'along') return
    if (t.kind !== 'piece') { ctx.status.value = REPEAT_HINT_PATH; return }
    const along = t.ref.kind === 'seg' ? t.ref.pathId : t.ref.id
    const why = pathRefusal(s.units, along, s.count)
    if (why) { ctx.status.value = why; return }
    state.value = withPreview({ ...s, along, alongPiece: t.ref })
  }
  function apply(): boolean {
    const s = state.value
    if (!s) return false
    if (!s.preview.ok) { ctx.status.value = refusal(s); return false }
    const work = raw()
    // every refusal of the copy functions comes before they add anything;
    // what this adds first (the centre, the guide) is taken back on one
    const ne = work.entities.length, nc = work.constraints.length
    let made: EntityId[][] = []
    if (s.mode === 'radial') {
      const c = s.centre!
      const centre = 'id' in c ? c.id : addPoint(work, c.at.x, c.at.y, { fixed: true })
      made = repeatEntities(work, s.units, centre, s.count, s.sweep)
    } else if (s.mode === 'linear') {
      const c = selectionCentre(work, s.units), v = linearVec(s)
      if (c && v) {
        const from = addPoint(work, c.x, c.y, { construction: true })
        const to = addPoint(work, c.x + v.x, c.y + v.y, { construction: true })
        addLine(work, from, to, { construction: true })
        made = translateEntities(work, s.units, from, to, s.count, s.spacing)
      }
    } else {
      made = copyAlongPath(work, s.units, s.along!, s.count)
    }
    if (!made.length) {
      work.entities.length = ne
      work.constraints.length = nc
      ctx.status.value = REPEAT_CANT
      return false
    }
    const added = work.constraints.slice(nc).map(c => c.id)
    state.value = null
    built = null
    ctx.doc.value = { ...work }
    ctx.clearSel()
    if (!rulesHold(work, added)) ctx.runSolve()
    ctx.commitHistory()
    ctx.status.value = `Repeated ×${s.count}`
    return true
  }
  function cancel(say = true): void {
    built = null
    if (!state.value) return
    state.value = null
    if (say) ctx.status.value = 'Repeat cancelled'
  }
  // ←/→/↑/↓ on a focused kind or spacing radio move it (round the ends) and
  // take the focus along, since Space may be the host's pan key
  function radioKey(ev: KeyboardEvent): boolean {
    const step = ARROW_STEP[ev.key]
    const s = state.value
    if (!step || !s || ev.altKey || ev.shiftKey) return false
    const radio = focused(ev, '[data-repeat-mode], [data-repeat-spacing]')
    if (!radio) return false
    const isMode = radio.hasAttribute('data-repeat-mode')
    const list: string[] = isMode ? MODES : SPACINGS
    const i = list.indexOf(isMode ? s.mode : s.spacing)
    const next = list[(Math.max(0, i) + step + list.length) % list.length]!
    set(isMode ? { mode: next as RepeatMode } : { spacing: next as Spacing })
    const sel = isMode ? `[data-repeat-mode="${next}"]` : `[data-repeat-spacing="${next}"]`
    const to = radio.closest('[data-repeat-panel]')?.querySelector(sel) as HTMLElement | null | undefined
    to?.focus?.()
    return true
  }
  // keys while the panel is open (Ruling 12)
  function key(ev: KeyboardEvent): boolean {
    if (ev.metaKey || ev.ctrlKey) {
      const k = ev.key.toLowerCase()
      if (k === 'z' || k === 'y') { cancel(); return true }
      return false
    }
    if (ev.key === 'Enter') { if (focused(ev, '[data-act="repeat-cancel"]')) cancel(); else apply(); return true }
    if (ev.key === 'Escape') { cancel(); return true }
    if (radioKey(ev)) return true
    if (ev.key === 'Tab') return false
    if (ev.key === ' ' && focused(ev, 'button, input, select, textarea, [role="radio"]')) return false
    return !MODIFIERS.has(ev.key)
  }
  const hint = computed(() => {
    const s = state.value
    if (!s) return null
    if (s.mode === 'radial' && !s.centre) return REPEAT_HINT_CENTRE
    if (s.mode === 'along' && !s.along) return REPEAT_HINT_PATH
    return null
  })
  const names = computed(() => {
    const s = state.value
    if (!s) return { centre: '—', path: '—' }
    const needs = (s.centre && 'id' in s.centre) || s.alongPiece
    const n = needs ? (() => { const d = raw(); return pieceNames(d, pieceIndex(d)) })() : null
    const centre = !s.centre ? '—' : 'at' in s.centre ? 'New point' : (n?.get(`point:${s.centre.id}`) ?? '—')
    const path = s.alongPiece ? (n?.get(pieceKey(s.alongPiece)) ?? '—') : '—'
    return { centre, path }
  })
  return { state, open, set, pick, apply, cancel, key, hint, names }
}
