/**
 * ONE DRAG = ONE UNDO STEP, for inspectors built out of Studio rows.
 *
 * A Studio row IS the slider: it emits `update:modelValue` on every pixel of a drag and on
 * every repeat of a held arrow key. Every Motion inspector edit records an undo step, so a
 * single drag of one dial used to bury the previous state under dozens of them.
 *
 * The row does not announce a gesture, but the DOM does: `pointerdown` / `keydown` on the
 * row start one, `pointerup` / `pointercancel` / `keyup` end it, and a parent can watch all
 * of them as native listeners on the component. This is the state machine between those
 * events and the `record` flag the edit carries — clock-free on purpose, so a slow drag
 * cannot split into two steps and two quick clicks cannot merge into one.
 *
 * Lazy by design: opening a run records nothing, because a press that turns out to be a
 * click (typed entry, the bind menu) must not leave an empty undo step behind. The FIRST
 * value of the run records; the rest ride along.
 */

/** The gesture in flight, if any. `key` names the control it belongs to. */
export interface UndoRun {
  readonly key: string | null
  /** Has a change inside this run already recorded the step? */
  readonly recorded: boolean
}

/** No gesture in flight: the next change records on its own. */
export const NO_RUN: UndoRun = { key: null, recorded: false }

/**
 * Start (or continue) a gesture on `key`. Idempotent for the same key, because a held
 * arrow key fires `keydown` on every repeat and each repeat calls this — re-opening it
 * there would hand every repeat its own undo step, which is the bug this file exists for.
 */
export function openRun(run: UndoRun, key: string): UndoRun {
  return run.key === key ? run : { key, recorded: false }
}

/** End the gesture (pointerup / pointercancel / keyup). */
export function closeRun(): UndoRun {
  return NO_RUN
}

/**
 * Should this change record a new undo step? Returns the answer and the next run.
 *
 * A change whose key does not match the open run ABANDONS that run rather than joining
 * it: a `pointerup` swallowed by a `pointercancel` (touch, or the browser taking the
 * gesture over) would otherwise leave a run open forever and make every later edit on
 * that control invisible to undo.
 */
export function takeRecord(run: UndoRun, key: string): { record: boolean; run: UndoRun } {
  if (run.key !== key) return { record: true, run: NO_RUN }
  if (run.recorded) return { record: false, run }
  return { record: true, run: { key, recorded: true } }
}
