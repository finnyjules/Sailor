// The Layout tab's keys, as one pure decision (unit-tested as a matrix).
//
//   V          → next variation, whenever the Layout tab is showing (the quick way to vary)
//   ← / →      → previous / next variation, but ONLY with nothing selected — with a selection the
//                arrows keep nudging it, as everywhere else in the editor
//
// Never while typing in a field or editing a text layer on the canvas, and never with a modifier
// (⌘/Ctrl/Alt/Shift+key keep their own meanings: undo, zoom, a 10 px nudge…).

export interface LayoutKeyState {
  /** The Layout tab is the one showing (and the panels are visible). */
  tabVisible: boolean
  /** Focus is in an input, textarea, select or contenteditable. */
  inTextField: boolean
  /** A text layer is being edited on the canvas. */
  editingText: boolean
  /** No layer is selected. */
  selectionEmpty: boolean
}

export type LayoutKeyEvent = Pick<KeyboardEvent, 'key' | 'repeat' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/** `next` / `prev`: step the variations. `swallow`: the key is the Layout tab's, but a held-key
 *  repeat — take it without stepping (a held key would flood the undo history). `null`: not ours;
 *  let the editor have it. */
export type LayoutKeyAction = 'next' | 'prev' | 'swallow' | null

export function layoutKeyAction(e: LayoutKeyEvent, s: LayoutKeyState): LayoutKeyAction {
  if (!s.tabVisible || s.inTextField || s.editingText) return null
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null
  let step: 'next' | 'prev' | null = null
  if (e.key === 'v' || e.key === 'V') step = 'next'
  else if (s.selectionEmpty && e.key === 'ArrowRight') step = 'next'
  else if (s.selectionEmpty && e.key === 'ArrowLeft') step = 'prev'
  if (!step) return null
  return e.repeat ? 'swallow' : step
}
