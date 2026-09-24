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
})
