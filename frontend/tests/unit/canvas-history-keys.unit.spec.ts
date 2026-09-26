// @vitest-environment happy-dom
//
// Undo keys and the canvas: while a studio or modal is open, ⌘Z / ⇧⌘Z / ⌘Y never reach the
// canvas's history (they used to fall through behind the Gradient, Shader, Shape and Vector
// type studios and silently undo a canvas step). And an undo that lands while the canvas's
// debounced snapshot is still waiting records that edit first, so a keep is one step.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canvasHistoryAction, historyKeyOf, isStudioOrModalOpen, isTypingIn } from '~/lib/canvas/historyKeys'
import { createSnapshotDebounce, useCanvasHistory } from '~/composables/useCanvasHistory'

const key = (k: string, o: Partial<KeyboardEvent> = {}) =>
  ({ key: k, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...o }) as KeyboardEvent

afterEach(() => { document.body.innerHTML = '' })

describe('historyKeyOf', () => {
  it('⌘Z / Ctrl+Z undo; ⇧⌘Z and ⌘Y redo; others nothing', () => {
    expect(historyKeyOf(key('z'))).toBe('undo')
    expect(historyKeyOf(key('z', { metaKey: false, ctrlKey: true }))).toBe('undo')
    expect(historyKeyOf(key('Z', { shiftKey: true }))).toBe('redo')
    expect(historyKeyOf(key('y'))).toBe('redo')
    expect(historyKeyOf(key('z', { metaKey: false }))).toBeNull()
    expect(historyKeyOf(key('z', { altKey: true }))).toBeNull()
    expect(historyKeyOf(key('c'))).toBeNull()
  })
})

describe('isStudioOrModalOpen', () => {
  it('is open when a flag is set, or anything in the page says it is a dialog', () => {
    expect(isStudioOrModalOpen({ flags: [null, false, ''] })).toBe(false)
    expect(isStudioOrModalOpen({ flags: [null, 'node-7'] })).toBe(true)
    document.body.innerHTML = '<div role="dialog"></div>'
    expect(isStudioOrModalOpen({ flags: [] })).toBe(true)
    document.body.innerHTML = '<div aria-modal="true"></div>'
    expect(isStudioOrModalOpen()).toBe(true)
  })
})

describe('canvasHistoryAction', () => {
  it('the canvas steps back only with nothing open over it and no text field focused', () => {
    expect(canvasHistoryAction(key('z'), { overlayOpen: false, focused: document.body })).toBe('undo')
    expect(canvasHistoryAction(key('z', { shiftKey: true }), { overlayOpen: false, focused: null })).toBe('redo')
  })
  it('a studio with nothing to undo swallows every undo key: the canvas does nothing', () => {
    for (const e of [key('z'), key('z', { shiftKey: true }), key('y')]) {
      expect(canvasHistoryAction(e, { overlayOpen: true, focused: document.body })).toBeNull()
    }
  })
  it('typing in a field (a studio prompt included) keeps the browser’s text undo', () => {
    document.body.innerHTML = '<div role="dialog"><textarea></textarea><div contenteditable="true"><span id="s"></span></div></div>'
    expect(isTypingIn(document.querySelector('textarea'))).toBe(true)
    expect(isTypingIn(document.getElementById('s'))).toBe(true)
    expect(canvasHistoryAction(key('z'), { overlayOpen: false, focused: document.querySelector('textarea') })).toBeNull()
  })
  it('a key a surface already handled is left alone', () => {
    expect(canvasHistoryAction(key('z', { defaultPrevented: true }), { overlayOpen: false, focused: null })).toBeNull()
  })
})

describe('createSnapshotDebounce + useCanvasHistory: a keep is one step, whatever the timing', () => {
  function canvas() {
    vi.useFakeTimers()
    const history = useCanvasHistory()
    const state = { nodes: [{ id: '1', effect: '' }], edges: [] as any[] }
    const record = () => history.snapshot(state)
    const pending = createSnapshotDebounce(record, { delay: 350 })
    const edit = (effect: string) => { state.nodes = [{ id: '1', effect }]; pending.schedule() }
    const undo = () => { pending.flush(); return history.undo()?.nodes[0]?.effect }
    record()
    return { history, pending, edit, undo }
  }
  afterEach(() => { vi.useRealTimers() })

  it('keep, then ⌘Z at once: exactly the pre-keep state; a second ⌘Z the step before that', () => {
    const c = canvas()
    c.edit('water_ripple'); vi.advanceTimersByTime(400) // recorded
    c.edit('mine_take')                                   // the keep: still on its debounce
    vi.advanceTimersByTime(100)
    expect(c.undo()).toBe('water_ripple')
    vi.advanceTimersByTime(1000) // no late snapshot lands on top
    expect(c.history.canRedo.value).toBe(true)
    expect(c.undo()).toBe('')
    expect(c.history.redo()?.nodes[0]?.effect).toBe('water_ripple')
    expect(c.history.redo()?.nodes[0]?.effect).toBe('mine_take')
  })

  it('without the flush the same timing goes one step too far (the bug)', () => {
    const c = canvas()
    c.edit('water_ripple'); vi.advanceTimersByTime(400)
    c.edit('mine_take'); vi.advanceTimersByTime(100)
    expect(c.history.undo()?.nodes[0]?.effect).toBe('')
  })

  it('flush with nothing waiting records nothing; a paused recorder drops the wait', () => {
    const c = canvas()
    expect(c.pending.flush()).toBe(false)
    expect(c.history.stack.value).toHaveLength(1)
    let paused = true
    const rec = vi.fn()
    const p = createSnapshotDebounce(rec, { paused: () => paused })
    p.schedule()
    expect(p.flush()).toBe(false)
    p.schedule(); vi.advanceTimersByTime(400)
    expect(rec).not.toHaveBeenCalled()
    paused = false
    p.schedule(); expect(p.pending()).toBe(true)
    expect(p.flush()).toBe(true)
    expect(rec).toHaveBeenCalledTimes(1)
  })
})
