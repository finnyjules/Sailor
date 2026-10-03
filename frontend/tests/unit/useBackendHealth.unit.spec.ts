import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useBackendHealth } from '~/composables/useBackendHealth'

// fetchFn that answers /api/health (true) or rejects (false = Sailor
// unreachable) per a scripted list; the last entry repeats for any extra polls.
// Step 4, C5: there is no engine to report on.
type Step = boolean
function makeFetch(results: Step[]) {
  let i = 0
  return vi.fn(async (_url?: unknown, _init?: unknown) => {
    const step = results[Math.min(i, results.length - 1)]
    i++
    if (step === false) throw new Error('network')
    return new Response(JSON.stringify({ sailor: true }), { status: 200 })
  })
}

describe('useBackendHealth', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('flips down only after 2 consecutive failures (debounce)', async () => {
    const fetchFn = makeFetch([true, false, false])
    const h = useBackendHealth('http://x', { fetchFn, healthyMs: 100, downMs: 50, failures: 2 })
    h.start()
    await vi.advanceTimersByTimeAsync(0)     // tick 1: success → up
    expect(h.backendUp.value).toBe(true)
    await vi.advanceTimersByTimeAsync(100)   // tick 2: fail #1 → still up
    expect(h.backendUp.value).toBe(true)
    await vi.advanceTimersByTimeAsync(100)   // tick 3: fail #2 → down
    expect(h.backendUp.value).toBe(false)
    h.stop()
  })

  it('does NOT fire onRecovered on the initial down→up (first boot)', async () => {
    const onRecovered = vi.fn()
    const fetchFn = makeFetch([false, false, true])  // boots while backend down
    const h = useBackendHealth('http://x', { fetchFn, onRecovered, healthyMs: 100, downMs: 50, failures: 2 })
    h.start()
    await vi.advanceTimersByTimeAsync(0)     // tick 1: fail #1 → still up, schedules at healthyMs=100
    await vi.advanceTimersByTimeAsync(100)   // tick 2: fail #2 → down, schedules at downMs=50
    await vi.advanceTimersByTimeAsync(50)    // tick 3: first-ever success → up, NOT recovery
    expect(h.backendUp.value).toBe(true)
    expect(onRecovered).not.toHaveBeenCalled()
    h.stop()
  })

  it('fires onRecovered once when a previously-up backend goes down then up', async () => {
    const onRecovered = vi.fn()
    const fetchFn = makeFetch([true, false, false, true])
    const h = useBackendHealth('http://x', { fetchFn, onRecovered, healthyMs: 100, downMs: 50, failures: 2 })
    h.start()
    await vi.advanceTimersByTimeAsync(0)     // tick 1: up → everUp=true, schedules at healthyMs=100
    await vi.advanceTimersByTimeAsync(100)   // tick 2: fail #1 → still up, schedules at healthyMs=100
    await vi.advanceTimersByTimeAsync(100)   // tick 3: fail #2 → down, schedules at downMs=50
    await vi.advanceTimersByTimeAsync(50)    // tick 4: up → recovery
    expect(onRecovered).toHaveBeenCalledTimes(1)
    h.stop()
  })

  it('suppresses onRecovered when suppressRecovery() is true (e.g. a run is active)', async () => {
    // A heavy run can block the backend's event loop so the probe times out and
    // we read a false down→up "restart". Reloading the canvas mid-run is what
    // caused the flicker, so the recovery callback must be suppressed while a
    // run is active. backendUp must still track reality (it does flip).
    const onRecovered = vi.fn()
    const fetchFn = makeFetch([true, false, false, true])
    const h = useBackendHealth('http://x', {
      fetchFn, onRecovered, suppressRecovery: () => true,
      healthyMs: 100, downMs: 50, failures: 2,
    })
    h.start()
    await vi.advanceTimersByTimeAsync(0)     // up → everUp
    await vi.advanceTimersByTimeAsync(100)   // fail #1 → still up
    await vi.advanceTimersByTimeAsync(100)   // fail #2 → down
    await vi.advanceTimersByTimeAsync(50)    // up → would recover, but suppressed
    expect(onRecovered).not.toHaveBeenCalled()
    expect(h.backendUp.value).toBe(true)     // state still accurate
    h.stop()
  })

  it('still fires onRecovered when suppressRecovery() is false', async () => {
    const onRecovered = vi.fn()
    const fetchFn = makeFetch([true, false, false, true])
    const h = useBackendHealth('http://x', {
      fetchFn, onRecovered, suppressRecovery: () => false,
      healthyMs: 100, downMs: 50, failures: 2,
    })
    h.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(50)
    expect(onRecovered).toHaveBeenCalledTimes(1)
    h.stop()
  })

  it('retries a suppressed recovery on the next poll instead of dropping it forever', async () => {
    // A recovery landing mid-run is suppressed once, engine stays up on the
    // next poll, and suppressRecovery() turns false — onRecovered must still
    // fire then, not be lost because the first attempt was suppressed.
    const onRecovered = vi.fn()
    const fetchFn = makeFetch([true, false, false, true, true])
    let suppressed = true
    const h = useBackendHealth('http://x', {
      fetchFn, onRecovered, suppressRecovery: () => suppressed,
      healthyMs: 100, downMs: 50, failures: 2,
    })
    h.start()
    await vi.advanceTimersByTimeAsync(0)     // up → everUp
    await vi.advanceTimersByTimeAsync(100)   // fail #1 → still up
    await vi.advanceTimersByTimeAsync(100)   // fail #2 → down
    await vi.advanceTimersByTimeAsync(50)    // up → would recover, but suppressed
    expect(onRecovered).not.toHaveBeenCalled()
    suppressed = false
    await vi.advanceTimersByTimeAsync(100)   // still up, suppression lifted → fires now
    expect(onRecovered).toHaveBeenCalledTimes(1)
    h.stop()
  })

  it('resets the failure counter after recovery (one later fail does not flip down)', async () => {
    // up → 2 fails (down) → up (recovered, counter reset) → 1 fail → still up
    const fetchFn = makeFetch([true, false, false, true, false])
    const h = useBackendHealth('http://x', { fetchFn, healthyMs: 100, downMs: 50, failures: 2 })
    h.start()
    await vi.advanceTimersByTimeAsync(0)     // up
    await vi.advanceTimersByTimeAsync(100)   // fail #1
    await vi.advanceTimersByTimeAsync(100)   // fail #2 → down
    await vi.advanceTimersByTimeAsync(50)    // up (counter reset)
    await vi.advanceTimersByTimeAsync(100)   // single fail → still up (counter was reset)
    expect(h.backendUp.value).toBe(true)
    h.stop()
  })

  it('asks Sailor\'s own /api/health', async () => {
    const fetchFn = makeFetch([true])
    const h = useBackendHealth('', { fetchFn, healthyMs: 100 })
    h.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchFn.mock.calls[0]![0]).toBe('/api/health')
    h.stop()
  })

  it('reads any answer as Sailor up, even one it cannot parse', async () => {
    const fetchFn = vi.fn(async () => new Response('not json', { status: 401 }))
    const h = useBackendHealth('', { fetchFn, healthyMs: 100, downMs: 50, failures: 1 })
    h.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.backendUp.value).toBe(true)
    expect(h.everUp.value).toBe(true)
    h.stop()
  })

  it('reports no engine state (C5)', () => {
    const h = useBackendHealth('', { fetchFn: makeFetch([true]) })
    expect(Object.keys(h).sort()).toEqual(['backendUp', 'everUp', 'start', 'stop'])
  })

  it('stop() halts polling', async () => {
    const fetchFn = makeFetch([true])
    const h = useBackendHealth('http://x', { fetchFn, healthyMs: 100 })
    h.start()
    await vi.advanceTimersByTimeAsync(0)
    const calls = fetchFn.mock.calls.length
    h.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchFn.mock.calls.length).toBe(calls)
  })
})
