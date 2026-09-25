// app/composables/pen/penCopies.ts
// Repeat / Mirror / Flip — split out of usePen.ts verbatim (see usePen.ts's
// HOST CONTRACT comment for the pen's overall contract). armRepeat/doMirror
// arm `pendingOp` (the guided center/axis pick); usePen.ts's own doRepeat and
// repeatPrompt (which asks for the count via usePen.ts's inline
// requestValue, not a browser prompt) stay behind and call into this
// module's applyRepeat/armRepeat.
import type { Ref } from 'vue'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { repeatEntities, mirrorEntities, pointClosure } from '~/lib/sketch/edit'

export type PendingOp =
  | null
  | { kind: 'repeat'; units: EntityId[]; count: number }
  | { kind: 'mirror'; units: EntityId[] }

export interface PenCopiesContext {
  doc: Ref<SketchDoc>
  selection: Ref<EntityId[]>
  pendingOp: Ref<PendingOp>
  status: Ref<string>
  clearSel: () => void
  runSolve: () => void
  commitHistory: () => void
}

export function createPenCopies(ctx: PenCopiesContext) {
  // low-level applies — used by both the fast path (center/axis already in the
  // selection) and the guided pick. clearSel first so the center-point click
  // that armed nothing lingers selected.
  function applyRepeat(units: EntityId[], center: EntityId, count: number) {
    if (!units.length || !Number.isFinite(count) || count < 2) return
    repeatEntities(ctx.doc.value, units, center, Math.round(count))
    ctx.clearSel(); ctx.pendingOp.value = null; ctx.runSolve(); ctx.commitHistory()
    ctx.status.value = `Repeated ×${Math.round(count)}`
  }
  function applyMirror(units: EntityId[], axisLine: EntityId) {
    if (!units.length) return
    mirrorEntities(ctx.doc.value, units, axisLine)
    ctx.clearSel(); ctx.pendingOp.value = null; ctx.runSolve(); ctx.commitHistory()
    ctx.status.value = 'Mirrored'
  }
  // arm the guided center-pick for the given units + count (no prompt). Used by
  // repeatPrompt's guided branch and the __sketchDraw.armRepeat test hook.
  function armRepeat(units: EntityId[], count: number) {
    if (!units.length || !Number.isFinite(count) || count < 2) return
    ctx.pendingOp.value = { kind: 'repeat', units: [...units], count }
    ctx.status.value = `Now click the center of the ring (×${count})`
  }
  function doMirror() {
    const lineSel = ctx.selection.value.filter(id => (ctx.doc.value.entities.find(e => e.id === id) as any)?.kind === 'line')
    const entSel = ctx.selection.value.filter(id => !lineSel.includes(id))
    if (entSel.length === 0) { ctx.status.value = 'Select a shape first, then Mirror'; return }
    // fast path: an axis line is already part of the selection
    if (lineSel.length === 1) { applyMirror(entSel, lineSel[0]!); return }
    // guided: arm the axis pick
    ctx.pendingOp.value = { kind: 'mirror', units: entSel }
    ctx.status.value = 'Now click the mirror axis (a line)'
  }
  function flip(axis: 'h' | 'v') {
    const ptIds = pointClosure(ctx.doc.value, ctx.selection.value)
    const pts = ptIds.map(id => ctx.doc.value.entities.find(e => e.id === id)).filter((e: any) => e?.kind === 'point') as any[]
    if (!pts.length) return
    const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x))
    const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y))
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
    for (const p of pts) { if (axis === 'h') p.x = 2 * cx - p.x; else p.y = 2 * cy - p.y }
    ctx.runSolve()
    ctx.commitHistory()
  }

  return { applyRepeat, applyMirror, armRepeat, doMirror, flip }
}
