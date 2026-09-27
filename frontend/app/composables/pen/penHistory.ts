// app/composables/pen/penHistory.ts
// usePen's undo/redo history: plain snapshots of `doc`, taken after every
// mutating action settles. `histPtr` points at the entry matching the
// current `doc.value`; undo/redo just move it and restore that snapshot.
// Split out of usePen.ts verbatim (see usePen.ts's HOST CONTRACT comment for
// the pen's overall contract). undo()/redo()/revert() below do only the
// doc/pointer part and report whether they changed anything (undo/redo) —
// usePen.ts's own undo()/redo()/revert() wrap these with the pen's other
// transient-state resets, in the exact order the inline version had, before
// firing onChange. That split exists because those resets (clearSel,
// pendingPath, pathDrag, curve state, dimBuffer, status text…) reach far
// beyond what this module is handed (just `doc` + the two change signals),
// so they can't move here without dragging most of usePen.ts along with them.
import { ref, toRaw, type Ref } from 'vue'
import type { SketchDoc } from '~/lib/sketch/model'
import { cloneDoc } from '~/lib/sketch/clone'

export function createPenHistory(opts: { doc: Ref<SketchDoc>; onChange?: () => void; onLiveChange?: () => void }) {
  const doc = opts.doc
  const history = ref<SketchDoc[]>([])
  const histPtr = ref(-1)
  // the drawing as the pen received it — revert()'s target. Separate from
  // `history`, which is capped at 200 entries and so can lose its first one.
  const opening = cloneDoc(doc.value)
  // bumped whenever the drawing moves to another history entry (a commit, an
  // undo / redo, a fresh start) — a cheap key for readers that work on the
  // raw doc (pen stage 6: the Properties panel's rules list)
  const rev = ref(0)

  function initHistory() { history.value = [cloneDoc(doc.value)]; histPtr.value = 0; rev.value++ }

  function commitHistory() {
    // no-op guard: a settle that left `doc` structurally identical to the
    // current top-of-history entry (dragging a fixed point, Delete with an
    // empty selection, re-pinning a chip to its existing value, …) must not
    // push a duplicate snapshot — that would leave a dead undo step that
    // visibly "does nothing" the first time the user hits ⌘Z.
    const top = history.value[histPtr.value]
    if (top && JSON.stringify(top) === JSON.stringify(doc.value)) return
    // drop any redo tail, push a fresh snapshot
    history.value = history.value.slice(0, histPtr.value + 1)
    history.value.push(cloneDoc(doc.value))
    histPtr.value = history.value.length - 1
    if (history.value.length > 200) { history.value.shift(); histPtr.value-- }
    rev.value++
    opts.onChange?.()
  }

  // the doc/pointer part of undo only — false with nothing to undo. usePen.ts's
  // undo() calls this, then does its own transient resets and status update,
  // then onChange — the same order the inline version had.
  function undo(): boolean {
    if (histPtr.value <= 0) return false
    histPtr.value--
    doc.value = cloneDoc(history.value[histPtr.value]!)
    rev.value++
    return true
  }
  function redo(): boolean {
    if (histPtr.value >= history.value.length - 1) return false
    histPtr.value++
    doc.value = cloneDoc(history.value[histPtr.value]!)
    rev.value++
    return true
  }
  /** The drawing as the last settled step left it (plain, never to be
   *  changed) — what the next step's fills are carried from (pen stage 7). */
  function current(): SketchDoc | null {
    const top = history.value[histPtr.value]
    return top ? toRaw(top) : null
  }
  function canUndo() { return histPtr.value > 0 }
  function canRedo() { return histPtr.value < history.value.length - 1 }

  // the doc/pointer part of revert only — usePen.ts's revert() calls this,
  // then its own clearTransient()/status update, then onChange. clearTransient
  // and status never touch `doc` or `history`, so reordering initHistory ahead
  // of them (vs. the inline version, which ran it last) is behaviourally inert.
  function revert(): void {
    doc.value = cloneDoc(opening)
    initHistory()
  }

  function live(): void { opts.onLiveChange?.() }

  return { initHistory, commitHistory, undo, redo, canUndo, canRedo, revert, live, rev, current }
}
