import { describe, it, expect } from 'vitest'
import { useSmartSelect } from '~/composables/useSmartSelect'

/** Manually-resolvable segment stub (SAM 3: resolves to ONE mask URL). */
function deferredSegment() {
  const calls: { points: { x: number; y: number; label: 0 | 1 }[]; resolve: (m: string) => void; reject: (e: Error) => void }[] = []
  const segment = (_image: string, points: { x: number; y: number; label: 0 | 1 }[]) =>
    new Promise<string>((resolve, reject) => { calls.push({ points, resolve, reject }) })
  return { calls, segment }
}
const tick = () => new Promise<void>(r => setTimeout(r, 0))

describe('useSmartSelect', () => {
  it('accumulates points and refines with ALL of them → one mask', async () => {
    const { calls, segment } = deferredSegment()
    const s = useSmartSelect({ segment })
    s.addPoints([{ x: 1, y: 2, label: 1 }])
    const p = s.refine('img')
    expect(s.busy.value).toBe(true)
    expect(calls[0]!.points).toEqual([{ x: 1, y: 2, label: 1 }])
    calls[0]!.resolve('data:mask1')
    await p
    expect(s.busy.value).toBe(false)
    expect(s.maskUrl.value).toBe('data:mask1')
    expect(s.failed.value).toBe(false)
  })

  it('collapses refines during flight into ONE trailing re-run that re-queries with the latest points', async () => {
    const { calls, segment } = deferredSegment()
    const s = useSmartSelect({ segment })
    s.addPoints([{ x: 1, y: 1, label: 1 }])
    const p1 = s.refine('img')
    s.addPoints([{ x: 2, y: 2, label: 1 }])
    void s.refine('img')
    s.addPoints([{ x: 3, y: 3, label: 0 }])
    void s.refine('img')
    expect(calls.length).toBe(1)
    calls[0]!.resolve('data:mask1')
    await p1; await tick()
    // SAM 3's output DEPENDS on the points, so the trailing re-run fires a 2nd
    // call — with ALL three accumulated points, not the cache.
    expect(calls.length).toBe(2)
    expect(calls[1]!.points).toEqual([
      { x: 1, y: 1, label: 1 }, { x: 2, y: 2, label: 1 }, { x: 3, y: 3, label: 0 },
    ])
    calls[1]!.resolve('data:mask2')
    await tick()
    expect(s.maskUrl.value).toBe('data:mask2')
  })

  it('re-queries on every refine (no per-image cache)', async () => {
    const { calls, segment } = deferredSegment()
    const s = useSmartSelect({ segment })
    s.addPoints([{ x: 1, y: 1, label: 1 }])
    const p1 = s.refine('img-a')
    calls[0]!.resolve('data:mask-a')
    await p1

    // Same image again — must re-call, because points could carry new intent.
    const p2 = s.refine('img-a')
    expect(calls.length).toBe(2)
    calls[1]!.resolve('data:mask-a2')
    await p2
    expect(s.maskUrl.value).toBe('data:mask-a2')
  })

  it('failure sets failed and clears maskUrl (fallback-to-scribble)', async () => {
    const { calls, segment } = deferredSegment()
    const s = useSmartSelect({ segment })
    s.addPoints([{ x: 1, y: 1, label: 1 }])
    const p = s.refine('img')
    calls[0]!.reject(new Error('boom'))
    await p
    expect(s.failed.value).toBe(true)
    expect(s.maskUrl.value).toBeNull()
    expect(s.busy.value).toBe(false)
  })

  it('reset drops in-flight results (stale response never lands)', async () => {
    const { calls, segment } = deferredSegment()
    const s = useSmartSelect({ segment })
    s.addPoints([{ x: 1, y: 1, label: 1 }])
    const p = s.refine('img')
    s.reset()
    calls[0]!.resolve('data:stale')
    await p
    expect(s.maskUrl.value).toBeNull()
    expect(s.points.value).toEqual([])
    expect(s.busy.value).toBe(false)
  })
})
