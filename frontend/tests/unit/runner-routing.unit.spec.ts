import { describe, expect, it } from 'vitest'
import { createRunnerEventBuffer, ownerTabForCanvas, runnerEventScope, runnerRunIdsForTab } from '~/lib/runner/routing'
import { isRunnerNotFound } from '~/lib/runner/client'
import { RUNNER_WORKER } from '#shared/runner/messages'

const doc = (active: string, ...others: string[]) => ({
  activeCanvasId: active,
  canvases: [active, ...others].map(id => ({ id, name: id, workflow: {} })),
})

describe('ownerTabForCanvas', () => {
  const tabs = [
    { id: 'home', type: 'home' },
    { id: 'tab-a', type: 'project' },
    { id: 'tab-b', type: 'project' },
  ]
  const docs = { 'tab-a': doc('c1', 'c2'), 'tab-b': doc('c3'), home: doc('c9') }
  it('finds the open project tab whose document owns the canvas', () => {
    expect(ownerTabForCanvas(tabs, docs, 'c1')).toBe('tab-a')
    expect(ownerTabForCanvas(tabs, docs, 'c2')).toBe('tab-a') // not the canvas on screen, still theirs
    expect(ownerTabForCanvas(tabs, docs, 'c3')).toBe('tab-b')
  })
  it('nobody owns an unknown canvas, no canvas, or a canvas of a tab that is not a project', () => {
    expect(ownerTabForCanvas(tabs, docs, 'elsewhere')).toBeNull()
    expect(ownerTabForCanvas(tabs, docs, null)).toBeNull()
    expect(ownerTabForCanvas(tabs, docs, undefined)).toBeNull()
    expect(ownerTabForCanvas(tabs, docs, 'c9')).toBeNull()
    expect(ownerTabForCanvas(tabs, { 'tab-a': { some: 'legacy workflow' } }, 'c1')).toBeNull()
  })
})

describe('runnerEventScope (the canvas)', () => {
  const base = { registered: false, knownCanvasId: null, eventCanvasId: null, displayedCanvasId: 'c1' }
  it('ComfyUI events keep their own routing', () => {
    expect(runnerEventScope({ ...base, promptId: 'comfy-123' })).toBe('comfy')
    expect(runnerEventScope({ ...base, promptId: null })).toBe('comfy')
  })
  it('a registered runner stage uses the per-run routing when its canvas is known', () => {
    expect(runnerEventScope({ ...base, promptId: 'run_a.0.t0', registered: true, knownCanvasId: 'c2' })).toBe('route')
    // never the displayed-canvas fallback
    expect(runnerEventScope({ ...base, promptId: 'run_a.0.t0', registered: true, knownCanvasId: null })).toBe('ignore')
  })
  it('an unregistered runner event lands only on the canvas it names, when that canvas is on screen', () => {
    expect(runnerEventScope({ ...base, promptId: 'run_a.0.t0', eventCanvasId: 'c1' })).toBe('apply')
    expect(runnerEventScope({ ...base, promptId: 'run_a.0', eventCanvasId: 'c1' })).toBe('apply')
    expect(runnerEventScope({ ...base, promptId: 'run_a.0.t0', eventCanvasId: 'c2' })).toBe('ignore')
    expect(runnerEventScope({ ...base, promptId: 'run_a.0.t0', eventCanvasId: null })).toBe('ignore')
    expect(runnerEventScope({ ...base, promptId: 'run_a.0.t0', eventCanvasId: null, displayedCanvasId: null })).toBe('ignore')
  })
})

describe('createRunnerEventBuffer', () => {
  it('holds unregistered runner events only while a runner POST is in flight, per run', () => {
    const b = createRunnerEventBuffer()
    expect(b.hold('run_a.0.t0', { n: 1 })).toBe(false) // nothing in flight: not held
    b.begin()
    expect(b.hold('run_a.0.t0', { n: 1 })).toBe(true)
    expect(b.hold('run_b.0', { n: 2 })).toBe(true)
    expect(b.hold('run_a.0', { n: 3 })).toBe(true) // leg id and stage key share a run
    expect(b.hold('comfy-1', { n: 4 })).toBe(false) // never a ComfyUI event
    expect(b.busy).toBe(true)
    b.end()
    expect(b.busy).toBe(false)
    expect(b.take('run_a')).toEqual([{ n: 1 }, { n: 3 }])
    expect(b.take('run_a')).toEqual([])
    expect(b.takeAll()).toEqual([{ n: 2 }])
    expect(b.takeAll()).toEqual([])
  })
  it('counts overlapping POSTs', () => {
    const b = createRunnerEventBuffer()
    b.begin(); b.begin(); b.end()
    expect(b.busy).toBe(true)
    b.end(); b.end() // an extra end never goes below zero
    expect(b.busy).toBe(false)
    b.begin()
    expect(b.busy).toBe(true)
  })
  it('takeAll hands back each run’s events in the order they arrived, runs in first-seen order', () => {
    const b = createRunnerEventBuffer()
    b.begin()
    b.hold('run_a.0.t0', 1); b.hold('run_b.0.t0', 2); b.hold('run_a.0.t0', 3)
    expect(b.takeAll()).toEqual([1, 3, 2])
  })
})

describe('runnerRunIdsForTab', () => {
  it('lists the runner runs registered to one tab, once each', () => {
    const entries = [
      { promptId: 'run_a.0.t0', tabId: 't1', worker: RUNNER_WORKER },
      { promptId: 'run_a.0.t1', tabId: 't1', worker: RUNNER_WORKER },
      { promptId: 'run_b.1.t0', tabId: 't2', worker: RUNNER_WORKER },
      { promptId: 'comfy-1', tabId: 't1', worker: 0 },
      { promptId: '', tabId: '', worker: RUNNER_WORKER },
    ]
    expect(runnerRunIdsForTab(entries, 't1')).toEqual(['run_a'])
    expect(runnerRunIdsForTab(entries, 't2')).toEqual(['run_b'])
    expect(runnerRunIdsForTab(entries, 't3')).toEqual([])
  })
})

describe('isRunnerNotFound', () => {
  it('is true only for an HTTP 404 (the runner switched off on the server)', () => {
    expect(isRunnerNotFound({ statusCode: 404 })).toBe(true)
    expect(isRunnerNotFound({ status: 404 })).toBe(true)
    expect(isRunnerNotFound({ response: { status: 404 } })).toBe(true)
    expect(isRunnerNotFound({ statusCode: 400 })).toBe(false)
    expect(isRunnerNotFound({ statusCode: 429 })).toBe(false)
    expect(isRunnerNotFound(new TypeError('Failed to fetch'))).toBe(false)
    expect(isRunnerNotFound(null)).toBe(false)
  })
})
