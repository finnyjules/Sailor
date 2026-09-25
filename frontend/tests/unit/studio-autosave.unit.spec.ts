import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAutosaveController } from '~/lib/studio/autosave'

/**
 * createAutosaveController is the pure debounce/flash state machine behind
 * useStudioAutosave (Task AF-3b). The composable wrapper (watch + onBeforeUnmount)
 * needs a component to run, so it's verified live instead — this covers the
 * timing logic that actually decides when persist() fires and how long
 * "Saved ✓" stays lit.
 */
describe('createAutosaveController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('onEdit flips to saving immediately, without persisting yet', () => {
    const persist = vi.fn()
    const { saving, saved, onEdit } = createAutosaveController(persist)
    onEdit()
    expect(saving.value).toBe(true)
    expect(saved.value).toBe(false)
    expect(persist).not.toHaveBeenCalled()
  })

  it('persists once the debounce window elapses, then shows saved', () => {
    const persist = vi.fn()
    const { saving, saved, onEdit } = createAutosaveController(persist, { debounceMs: 400, flashMs: 1500 })
    onEdit()
    vi.advanceTimersByTime(400)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(saving.value).toBe(false)
    expect(saved.value).toBe(true)
  })

  it('a persist that saved nothing (returns false) ends saving without a "Saved" flash', () => {
    const persist = vi.fn(() => false)
    const { saving, saved, onEdit } = createAutosaveController(persist, { debounceMs: 400, flashMs: 1500 })
    onEdit()
    vi.advanceTimersByTime(400)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(saving.value).toBe(false)
    expect(saved.value).toBe(false)
  })

  it('saved flash clears after flashMs', () => {
    const persist = vi.fn()
    const { saved, onEdit } = createAutosaveController(persist, { debounceMs: 400, flashMs: 1500 })
    onEdit()
    vi.advanceTimersByTime(400)
    expect(saved.value).toBe(true)
    vi.advanceTimersByTime(1500)
    expect(saved.value).toBe(false)
  })

  it('debounces rapid edits: two onEdit calls within the window persist only once', () => {
    const persist = vi.fn()
    const { onEdit } = createAutosaveController(persist, { debounceMs: 400, flashMs: 1500 })
    onEdit()
    vi.advanceTimersByTime(200)
    onEdit()
    vi.advanceTimersByTime(200)
    expect(persist).not.toHaveBeenCalled() // first timer was cancelled by the second edit
    vi.advanceTimersByTime(200)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('dispose() before the debounce fires cancels the pending save', () => {
    const persist = vi.fn()
    const { onEdit, dispose } = createAutosaveController(persist, { debounceMs: 400, flashMs: 1500 })
    onEdit()
    dispose()
    vi.advanceTimersByTime(10_000)
    expect(persist).not.toHaveBeenCalled()
  })
})
