/**
 * Who owns ⌘Z / ⇧⌘Z / ⌘Y: the canvas's undo history, or something above it.
 *
 * The canvas binds the keys on `window`, so every studio, Frame, template editor and
 * gallery that opens over it sees them too. A surface with its own history handles them
 * (Space type, 3D, Frame, the template editor…); one with nothing to undo lets the key
 * pass. Either way the canvas must not also step back: that silently lost a canvas step
 * behind the Gradient, Shader, Shape and Vector type studios. So the canvas asks ONE
 * guard — is a studio or modal open? — before touching its history, and so does the
 * layout before `/` or ⌘K focuses the canvas prompt.
 */

/** A field that has its own (the browser's) text undo. */
export const TYPING_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'

/** A surface that says it is modal. Studio shells, Moodboard, Character and Body editors, the
 *  sheets inside studios, Settings… carry it; plain `fixed inset-0` overlays do not, which is
 *  why callers pass their own open flags too. */
const MODAL_SELECTOR = '[role="dialog"], [aria-modal="true"]'

export type HistoryKey = 'undo' | 'redo'

/** ⌘Z / Ctrl+Z is undo; ⇧⌘Z and ⌘Y (Ctrl too) are redo. Anything else: null. */
export function historyKeyOf(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): HistoryKey | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null
  const k = e.key.toLowerCase()
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (k === 'y' && !e.shiftKey) return 'redo'
  return null
}

/** True when `el` is (or is inside) a text field, whose ⌘Z is the browser's own. */
export function isTypingIn(el: Element | null | undefined): boolean {
  return !!el && typeof el.closest === 'function' && !!el.closest(TYPING_SELECTOR)
}

/**
 * True when a studio or modal is open above the canvas and owns the keyboard.
 * `flags`: the caller's own "open" state for surfaces that carry no dialog role (the
 * canvas's studio / Frame / Timeline / gallery refs; the layout's Settings and Credits).
 */
export function isStudioOrModalOpen(opts: { flags?: readonly unknown[]; doc?: Pick<Document, 'querySelector'> | null } = {}): boolean {
  if (opts.flags?.some(Boolean)) return true
  const doc = opts.doc === undefined ? (typeof document === 'undefined' ? null : document) : opts.doc
  return !!doc?.querySelector(MODAL_SELECTOR)
}

/**
 * What the canvas should do with this keydown: 'undo', 'redo', or nothing (null).
 * Nothing when it isn't a history key, when a surface already handled it, when the
 * focus is in a text field (the browser's text undo runs), or when a studio or modal is
 * open — then the key is the studio's, and one with nothing to undo simply swallows it.
 */
export function canvasHistoryAction(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'>,
  ctx: { overlayOpen: boolean; focused?: Element | null },
): HistoryKey | null {
  const action = historyKeyOf(e)
  if (!action || e.defaultPrevented) return null
  const focused = ctx.focused === undefined ? (typeof document === 'undefined' ? null : document.activeElement) : ctx.focused
  if (isTypingIn(focused)) return null
  if (ctx.overlayOpen) return null
  return action
}
