import { afterEach, describe, expect, it, vi } from 'vitest'
import { shouldUseRunner, runIdOfPrompt } from '~/lib/runner/client'
import { ensureRunnerEvents, runnerMessageToPipe, useRunnerEvents } from '~/composables/useRunnerEvents'

const img = { '1': { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'x' } } }
const blur = { '1': { class_type: 'ImageBlur', inputs: {} } }

describe('shouldUseRunner', () => {
  it('needs the switch on and every take eligible', () => {
    expect(shouldUseRunner(false, [img])).toBe(false)
    expect(shouldUseRunner(true, [img, img])).toBe(true)
    expect(shouldUseRunner(true, [img, blur])).toBe(false)
    expect(shouldUseRunner(true, [img, null])).toBe(false)
    expect(shouldUseRunner(true, [])).toBe(false)
  })
})

describe('runIdOfPrompt', () => {
  it('finds the run behind a stage key or leg id', () => {
    expect(runIdOfPrompt('run_abc.1.t2')).toBe('run_abc')
    expect(runIdOfPrompt('run_abc.1')).toBe('run_abc')
    expect(runIdOfPrompt('4f1e-comfy')).toBeNull()
    expect(runIdOfPrompt(undefined)).toBeNull()
  })
})

describe('runnerMessageToPipe', () => {
  it('wraps a runner message in the page’s event envelope', () => {
    expect(runnerMessageToPipe(JSON.stringify({ type: 'execution_start', data: { prompt_id: 'run_a.0.t0' } })))
      .toEqual({ type: 'sailor-bridge', v: 2, direct: true, event: 'execution_start', prompt_id: 'run_a.0.t0' })
  })
  it('drops junk and messages the canvas does not use', () => {
    expect(runnerMessageToPipe('not json')).toBeNull()
    expect(runnerMessageToPipe(JSON.stringify({ type: 'status', data: {} }))).toBeNull()
  })
})

describe('the runner event stream connects lazily', () => {
  class FakeSource {
    static made: FakeSource[] = []
    onopen: (() => void) | null = null
    onmessage: ((m: { data: string }) => void) | null = null
    readyState = 0
    closed = false
    constructor(public url: string) { FakeSource.made.push(this) }
    close() { this.closed = true }
    open() { this.readyState = 1; this.onopen?.() }
  }
  afterEach(() => { useRunnerEvents().disconnect(); FakeSource.made = []; vi.unstubAllGlobals(); vi.useRealTimers() })

  it('opens nothing until asked, then one stream, and waits for it to open', async () => {
    vi.stubGlobal('EventSource', FakeSource)
    useRunnerEvents() // a page using the composable does not connect by itself
    expect(FakeSource.made).toHaveLength(0)
    let ready = false
    const p = ensureRunnerEvents().then(() => { ready = true })
    expect(FakeSource.made).toHaveLength(1)
    expect(FakeSource.made[0]!.url).toBe('/api/runs/events')
    await Promise.resolve()
    expect(ready).toBe(false)
    FakeSource.made[0]!.open()
    await p
    expect(ready).toBe(true)
    // later calls reuse the open stream and return at once
    await ensureRunnerEvents()
    expect(FakeSource.made).toHaveLength(1)
  })

  it('does not wait forever for a stream that never opens', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeSource)
    let ready = false
    const p = ensureRunnerEvents().then(() => { ready = true })
    await vi.advanceTimersByTimeAsync(2999)
    expect(ready).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await p
    expect(ready).toBe(true)
    expect(FakeSource.made).toHaveLength(1)
  })
})
