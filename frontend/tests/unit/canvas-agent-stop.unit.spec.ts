import { describe, it, expect, vi, afterEach } from 'vitest'
import { useCanvasAgent } from '~/composables/useCanvasAgent'

const EMPTY = { nodes: [], edges: [] } as any

afterEach(() => { delete (globalThis as any).$fetch })

describe('useCanvasAgent.stop', () => {
  it('aborts the call, clears busy, and ignores the late reply', async () => {
    let seenSignal: AbortSignal | undefined
    let reply!: (v: unknown) => void
    ;(globalThis as any).$fetch = vi.fn((_url: string, o: any) => {
      seenSignal = o.signal
      return new Promise(r => { reply = r })
    })
    const discard = vi.fn()
    const agent = useCanvasAgent({
      getSnapshot: () => EMPTY, preview: vi.fn(), commit: () => [], discard, apiKey: () => 'k',
    } as any)

    const pending = agent.ask('add an upscale')
    await Promise.resolve()
    expect(agent.busy.value).toBe(true)

    agent.stop()
    expect(agent.busy.value).toBe(false)
    expect(seenSignal?.aborted).toBe(true)
    expect(discard).toHaveBeenCalled()

    reply({ text: JSON.stringify({ reasoning: '', commands: [], message: 'too late' }) })
    await pending
    expect(agent.answer.value).toBe('')
    expect(agent.error.value).toBe('')
    expect(agent.busy.value).toBe(false)
  })

  it('does nothing when idle', () => {
    const discard = vi.fn()
    const agent = useCanvasAgent({ getSnapshot: () => EMPTY, preview: vi.fn(), commit: () => [], discard, apiKey: () => '' } as any)
    agent.stop()
    expect(discard).not.toHaveBeenCalled()
    expect(agent.busy.value).toBe(false)
  })

  it('Stop covers a re-roll: the late reply is ignored and cannot clear a newer run', async () => {
    vi.useFakeTimers()
    try {
      const snap = { nodes: [{ id: '2', nodeType: 'KSampler', title: 'KSampler', widgets: { steps: 20 }, inputs: [], outputs: [] }], edges: [], catalog: [] } as any
      const plan = (steps: number) => ({ text: JSON.stringify({ reasoning: '', message: '', commands: [{ op: 'setWidget', target: '2', args: JSON.stringify({ name: 'steps', value: steps }) }] }) })
      const replies: ((v: unknown) => void)[] = []
      const signals: (AbortSignal | undefined)[] = []
      ;(globalThis as any).$fetch = vi.fn((_url: string, o: any) => { signals.push(o.signal); return new Promise(r => { replies.push(r) }) })
      const agent = useCanvasAgent({ getSnapshot: () => snap, preview: vi.fn(), commit: () => [], discard: vi.fn(), apiKey: () => 'k' } as any)

      // A proposal to re-roll.
      const first = agent.ask('more steps')
      await Promise.resolve()
      replies[0]!(plan(30))
      await vi.advanceTimersByTimeAsync(2000)
      await first
      expect(agent.changes.value).toHaveLength(1)

      // Re-roll, then Stop while it is in flight.
      const rr = agent.reroll(0)
      await Promise.resolve()
      expect(agent.busy.value).toBe(true)
      agent.stop()
      expect(agent.busy.value).toBe(false)
      expect(signals[1]?.aborted).toBe(true)
      expect(agent.changes.value).toHaveLength(0)

      // A new ask starts before the stale re-roll reply lands.
      const second = agent.ask('fewer steps')
      await Promise.resolve()
      expect(agent.busy.value).toBe(true)
      replies[1]!(plan(40))
      await rr
      expect(agent.changes.value).toHaveLength(0) // the stopped re-roll re-inserted nothing
      expect(agent.busy.value).toBe(true) // …and did not clear the new run's busy
      replies[2]!(plan(10))
      await vi.advanceTimersByTimeAsync(2000)
      await second
      expect(agent.busy.value).toBe(false)
      expect(agent.changes.value[0]?.after).toContain('10')
    } finally { vi.useRealTimers() }
  })

  it('Stop cancels a user-started review; background reviews never claim the prompt', async () => {
    let reply!: (v: unknown) => void
    let seenSignal: AbortSignal | undefined
    ;(globalThis as any).$fetch = vi.fn((_url: string, o: any) => { seenSignal = o.signal; return new Promise(r => { reply = r }) })
    const agent = useCanvasAgent({
      getSnapshot: () => EMPTY, preview: vi.fn(), commit: () => [], discard: vi.fn(), apiKey: () => 'k',
      runOutputImage: async () => 'data:image/png;base64,xx',
    } as any)

    const auto = agent.autoReviewNode('n1', 'a fox')
    await vi.waitFor(() => expect(seenSignal).toBeDefined())
    expect(agent.reviewing.value).toBe(true)
    expect(agent.reviewingManual.value).toBe(false)
    reply({ text: JSON.stringify({ assessment: '', issues: [], fixes: [] }) })
    await auto
    expect(agent.reviewing.value).toBe(false)

    seenSignal = undefined
    const manual = agent.reviewNode('n1', 'a fox')
    await vi.waitFor(() => expect(seenSignal).toBeDefined())
    expect(agent.reviewingManual.value).toBe(true)
    agent.stop()
    expect(seenSignal?.aborted).toBe(true)
    expect(agent.reviewing.value).toBe(false)
    expect(agent.reviewingManual.value).toBe(false)
    reply({ text: JSON.stringify({ assessment: 'bad', issues: ['blurry'], fixes: [] }) })
    await manual
    expect(agent.review.value).toBeNull()
    expect(agent.answer.value).toBe('')
  })
})
