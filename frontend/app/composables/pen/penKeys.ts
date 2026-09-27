// app/composables/pen/penKeys.ts
// The body of usePen's key handler — see usePen.ts's onKeydown, which calls
// handlePenKey and then does preventDefault/stopPropagation once it returns
// true (see usePen.ts's HOST CONTRACT comment for the pen's overall keyboard
// contract). Split out verbatim: every free variable the inline handler read
// or wrote becomes a field of PenKeyContext, built fresh in usePen.ts's
// onKeydown from its own refs and functions.
//
// NUDGE_PX / NUDGE_PX_SHIFT / screenDeltaToDrawing moved here too — they exist
// only for the arrow-key nudge below — and are re-exported from usePen.ts so
// its module exports are unchanged.
import type { Ref } from 'vue'
import type { EntityId } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import type { PenTool, PendingPath } from './usePen'
import type { PendingOp } from './penCopies'

// Arrow-key nudge, in screen pixels: 0.25 / 2.5 drawing units at the dev
// page's default 34 px/unit, so the default view moves exactly as before.
export const NUDGE_PX = 8.5
export const NUDGE_PX_SHIFT = 85

/** A screen-pixel delta as a drawing delta: solves M·d = s with the view's
 *  linear part (Cramer's rule, no reciprocal, so the y-up 34 px/unit view
 *  gives exactly 0.25 for 8.5 px). Null for a singular view. */
export function screenDeltaToDrawing(m: ViewMatrix, sx: number, sy: number): { x: number; y: number } | null {
  const det = m.a * m.d - m.b * m.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return { x: (m.d * sx - m.c * sy) / det, y: (m.a * sy - m.b * sx) / det }
}

/** ⌥⇧C, Clean up. Matched by the key's position: on a Mac ⌥⇧C types "Ç". */
export function isCleanupKey(ev: KeyboardEvent): boolean {
  return ev.altKey && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && ev.code === 'KeyC'
}

/** X (Make guide), ⇧H / ⇧V (flip) — the pen stage 6 action letters. */
export function isActionKey(ev: KeyboardEvent): boolean {
  if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.key.length !== 1) return false
  const k = ev.key.toLowerCase()
  return (!ev.shiftKey && k === 'x') || (ev.shiftKey && (k === 'h' || k === 'v'))
}

export interface PenKeyContext {
  tool: Ref<PenTool>
  pendingPath: Ref<PendingPath>
  dimBuffer: Ref<string>
  pendingOp: Ref<PendingOp>
  status: Ref<string>
  selection: Ref<EntityId[]>
  selectedSegments: Ref<{ pathId: EntityId; segIndex: number }[]>
  view: Ref<ViewMatrix>
  // the host's own live pointer gesture (the dev page's pan) — Escape offers
  // it the chance to abort first (see the module-level comment on usePen's
  // cancelGesture option)
  cancelGesture?: () => boolean
  cancelPendingOp: () => void
  undo: () => void
  redo: () => void
  cancelPath: () => void
  commitDimension: () => void
  finishPath: (close?: boolean) => void
  removeLastAnchor: () => void
  del: () => void
  nudge: (dx: number, dy: number) => void
  selectTool: (t: PenTool) => void
  isToolAllowed: (t: PenTool) => boolean
  // Escape in Trim: clears the removed pieces' ghosts; true if there were any
  clearTrimGhosts: () => boolean
  // Clean up (pen stage 5): whether the host offers it, and the toggle
  cleanupAllowed: boolean
  toggleCleanup: () => void
  // pen stage 6: X / ⇧H / ⇧V / ⌘C / ⌘V / ⌘A run a registry action when it can
  // act now (penActions.ts ACTIONS; the pen settles its live gestures first);
  // false leaves the key to the host
  runKeyAction: (id: string) => boolean
  // pen stage 8: a live corner / offset preview's own keys — digits, '.',
  // '−', Backspace, Enter, Escape; true when the preview took the key
  previewKey: (ev: KeyboardEvent) => boolean
}

// single-letter tool keys — only with no modifier, and only for a tool the
// host offers (a key for a tool it doesn't offer is left untouched). The
// toolbar's tooltip cards show the same letters (penTips.ts PEN_TIPS[tool].key).
export const TOOL_KEYS: Record<string, PenTool> = {
  v: 'select', p: 'path', b: 'curve', l: 'line', o: 'circle', n: 'point',
  t: 'trim', c: 'cut', d: 'dissolve', g: 'fill',
  f: 'round', h: 'chamfer', e: 'offset',
}

// Returns true when the key did something. usePen.ts's onKeydown reads that
// for Escape / Enter: with nothing to cancel or finish, the key belongs to
// the host ('cancel' / 'commit'). The "typing in a field" guard is the
// caller's (PenOverlay's window listener runs isTypingInField once).
// `local.cancelGesture` is the caller's own live gesture (the overlay's
// marquee); it is offered Escape before the host's ctx.cancelGesture.
// A key the pen acts on is the pen's: onKeydown preventDefaults (so a host
// checking `defaultPrevented` — e.g. a modal that closes on Escape or deletes
// its selection on Delete — leaves it alone) and stopPropagates. A key it
// does not act on is left untouched.
export function handlePenKey(ev: KeyboardEvent, ctx: PenKeyContext, local?: { cancelGesture?: () => boolean }): boolean {
  const meta = ev.metaKey || ev.ctrlKey
  if (meta) {
    const key = ev.key.toLowerCase()
    if (key === 'z' && !ev.shiftKey) { ctx.undo(); return true }
    if ((key === 'z' && ev.shiftKey) || key === 'y') { ctx.redo(); return true }
    // pen stage 6: ⌘C copies a selection, ⌘V pastes the pen's own clipboard,
    // ⌘A selects every piece — each only when it can act
    if (!ev.shiftKey && !ev.altKey && (key === 'c' || key === 'v' || key === 'a')) {
      return ctx.runKeyAction(key === 'c' ? 'copy' : key === 'v' ? 'paste' : 'select-all')
    }
    return false
  }
  // ⌥⇧C: Clean up — only in a host that offers it
  if (isCleanupKey(ev)) {
    if (!ctx.cleanupAllowed) return false
    ctx.toggleCleanup()
    return true
  }
  // pen stage 8: a live Round corner / Chamfer / Offset preview takes its
  // digits, Backspace, Enter and Escape first (tool letters still switch —
  // selectTool drops the preview)
  if (ctx.previewKey(ev)) return true
  // (viewport keys — ⌘0 fit, Space pan — are the host's; it handles them
  // before delegating here)

  // type-a-dimension: a draw gesture is "active" whenever pendingPath is set
  // — that covers both a pending line placement (rubber band to the next
  // anchor) and a live arc bow (pathDrag.bowed), see pathDown/pathMove/pathUp.
  // Digits + one decimal point accumulate into dimBuffer instead of doing
  // anything else; meta-combos already returned above, so this never steals
  // a Cmd/Ctrl+digit shortcut.
  const gestureActive = ctx.tool.value === 'path' && !!ctx.pendingPath.value
  if (gestureActive && /^[0-9]$/.test(ev.key)) { ctx.dimBuffer.value += ev.key; return true }
  if (gestureActive && ev.key === '.' && !ctx.dimBuffer.value.includes('.')) { ctx.dimBuffer.value += '.'; return true }

  // pen stage 6: X makes the selection a guide, ⇧H / ⇧V flip it
  if (isActionKey(ev)) {
    const k = ev.key.toLowerCase()
    return ctx.runKeyAction(k === 'x' ? 'construction' : k === 'h' ? 'flip-h' : 'flip-v')
  }

  if (!ev.shiftKey && !ev.altKey && ev.key.length === 1) {
    const t = TOOL_KEYS[ev.key.toLowerCase()]
    if (t && ctx.isToolAllowed(t)) { ctx.selectTool(t); return true }
  }

  if (ev.key === 'Escape') {
    if (ctx.pendingOp.value) { ctx.cancelPendingOp(); ctx.status.value = 'cancelled'; return true }
    // clearing a live dimension buffer takes priority over everything else —
    // a first Escape just clears the typed value, a second (now-empty-buffer)
    // Escape falls through to the normal marquee/pan/path-cancel handling.
    if (ctx.dimBuffer.value) { ctx.dimBuffer.value = ''; return true }
    // Trim: a first Escape clears the removed pieces' ghosts
    if (ctx.tool.value === 'trim' && ctx.clearTrimGhosts()) return true
    // a live marquee drag or pan takes priority over path-cancel — abort
    // just that gesture (clear its state, no selection change, no doc
    // mutation) rather than falling through to cancelPath's path cleanup.
    if (local?.cancelGesture?.()) return true
    if (ctx.cancelGesture?.()) return true
    if (!ctx.pendingPath.value) return false
    ctx.cancelPath()
    return true
  }
  if (ev.key === 'Enter') {
    if (gestureActive && ctx.dimBuffer.value) { ctx.commitDimension(); return true }
    if (ctx.pendingPath.value && ctx.pendingPath.value.anchors.length >= 2) { ctx.finishPath(false); return true }
    return false
  }
  if (ev.key === 'Backspace' || ev.key === 'Delete') {
    if (gestureActive && ctx.dimBuffer.value) {
      ctx.dimBuffer.value = ctx.dimBuffer.value.slice(0, -1)
      return true
    }
    // preventDefault only when the key acts (onKeydown does it): with
    // nothing to delete, Delete/Backspace belong to the host
    if (ctx.pendingPath.value) { ctx.removeLastAnchor(); return true }
    if (ctx.selection.value.length || ctx.selectedSegments.value.length) { ctx.del(); return true }
    return false
  }
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
    if (!ctx.selection.value.length) return false   // nothing selected: no-op, let the browser handle the key normally
    // the step is in SCREEN pixels, so ↑ is screen-up under any view
    const step = ev.shiftKey ? NUDGE_PX_SHIFT : NUDGE_PX
    const sx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0
    const sy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0   // screen y grows downward
    const d = screenDeltaToDrawing(ctx.view.value, sx, sy)
    if (d) ctx.nudge(d.x, d.y)
    return true
  }
  return false
}

/** An Apple platform (a Mac ctrl-click is a right press there). Case-blind:
 *  Chrome's `navigator.userAgentData.platform` reads "macOS", while the older
 *  `navigator.platform` reads "MacIntel". */
export function isApplePlatform(platform: string | undefined | null): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform || '')
}

/** This browser runs on an Apple platform — the ONE check every pen part uses
 *  (the Mac ctrl-click right press, ⌘ glyphs in the cards and the menu).
 *  Read when called, not at import, so it follows the page it runs in. */
export function isApple(): boolean {
  if (typeof navigator === 'undefined') return false
  return isApplePlatform((navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform)
}
