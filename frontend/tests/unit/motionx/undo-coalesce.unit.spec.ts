/**
 * ONE DRAG = ONE UNDO STEP.
 *
 * A Studio row emits `update:modelValue` continuously while it is dragged (and on every
 * repeat of a held arrow key). The Motion inspector records an undo step per edit, so
 * without this a single drag of Stagger buried the previous state under forty steps.
 *
 * The inspector cannot see "a drag" — it sees a pointerdown, a stream of values and a
 * pointerup. This is the state machine that turns that into one step: the FIRST change
 * inside a gesture records, the rest ride along, and anything outside a gesture (a typed
 * value, a picked option, a double-click reset) records on its own.
 *
 * Pure and clock-free on purpose: the boundaries are real events, not a 600ms guess, so a
 * slow drag cannot split into two steps and two quick clicks cannot merge into one.
 */
import { describe, it, expect } from 'vitest'
import { NO_RUN, openRun, closeRun, takeRecord, type UndoRun } from '~/lib/motionx/undoCoalesce'

/** Feed a sequence of changes through a run, collecting the `record` flag of each. */
function records(run: UndoRun, keys: string[]): boolean[] {
  const out: boolean[] = []
  let cur = run
  for (const k of keys) {
    const r = takeRecord(cur, k)
    cur = r.run
    out.push(r.record)
  }
  return out
}

describe('a change with no gesture in flight', () => {
  it('always records its own step', () => {
    expect(records(NO_RUN, ['stagger', 'stagger', 'steps'])).toEqual([true, true, true])
  })
  it('and never leaves a run open behind it', () => {
    expect(takeRecord(NO_RUN, 'stagger').run).toEqual(NO_RUN)
  })
})

describe('a gesture on one control', () => {
  it('records once, however many values it emits', () => {
    expect(records(openRun(NO_RUN, 'stagger'), ['stagger', 'stagger', 'stagger', 'stagger']))
      .toEqual([true, false, false, false])
  })
  it('opens lazily — a press that emits nothing records nothing', () => {
    const run = openRun(NO_RUN, 'stagger')
    expect(run.recorded).toBe(false)
  })
  it('re-opening the same key mid-gesture does not start a second step', () => {
    // A held arrow key fires `keydown` on every repeat; each one calls openRun.
    let run = openRun(NO_RUN, 'steps')
    const out: boolean[] = []
    for (let i = 0; i < 3; i++) {
      run = openRun(run, 'steps')
      const r = takeRecord(run, 'steps')
      run = r.run
      out.push(r.record)
    }
    expect(out).toEqual([true, false, false])
  })
  it('ends when it is closed, so the next change starts a fresh step', () => {
    let run = openRun(NO_RUN, 'stagger')
    run = takeRecord(run, 'stagger').run
    run = closeRun()
    expect(takeRecord(run, 'stagger').record).toBe(true)
  })
})

describe('a gesture cannot swallow another control', () => {
  it('a change on a different key records and abandons the open run', () => {
    let run = openRun(NO_RUN, 'stagger')
    run = takeRecord(run, 'stagger').run
    const other = takeRecord(run, 'steps')
    expect(other.record).toBe(true)
    // The stale run is dropped rather than kept: a pointerup lost to a pointercancel
    // must never make every later edit invisible to undo.
    expect(other.run).toEqual(NO_RUN)
    expect(takeRecord(other.run, 'steps').record).toBe(true)
  })
})

describe('two drags in a row', () => {
  it('are two steps', () => {
    let run = openRun(NO_RUN, 'spin')
    const out: boolean[] = []
    for (const k of ['spin', 'spin']) { const r = takeRecord(run, k); run = r.run; out.push(r.record) }
    run = closeRun()
    run = openRun(run, 'spin')
    for (const k of ['spin', 'spin']) { const r = takeRecord(run, k); run = r.run; out.push(r.record) }
    expect(out).toEqual([true, false, true, false])
  })
})
