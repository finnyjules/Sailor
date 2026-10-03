// LC8 B1: the run socket (`/ws`, which the dev proxy pipes to the local engine
// on :8188) must not open before a health poll has said the engine is up, and
// never in hosted. Before this, `engineAvailable` started true, so every page
// load opened `/ws` once at boot and the dev proxy dialled :8188 with the
// engine off.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { engineSocketAllowed } from '~/composables/useDirectExecution'
import { useBackendHealth } from '~/composables/useBackendHealth'

const APP = join(__dirname, '../../app')

describe('engineSocketAllowed', () => {
  it('opens only once Sailor has answered and said the engine is up', () => {
    expect(engineSocketAllowed({ engineKnown: false, engineUp: true, hosted: false })).toBe(false)
    expect(engineSocketAllowed({ engineKnown: true, engineUp: false, hosted: false })).toBe(false)
    expect(engineSocketAllowed({ engineKnown: true, engineUp: true, hosted: false })).toBe(true)
  })
  it('never opens in hosted, whatever the poll says', () => {
    expect(engineSocketAllowed({ engineKnown: true, engineUp: true, hosted: true })).toBe(false)
    expect(engineSocketAllowed({ engineKnown: false, engineUp: true, hosted: true })).toBe(false)
  })
})

describe('useBackendHealth engineKnown', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is false before the first answer (engineUp is still the optimistic true) and true after it', async () => {
    let answer: (r: Response) => void = () => {}
    const fetchFn = vi.fn(() => new Promise<Response>((res) => { answer = res }))
    const h = useBackendHealth('http://x', { fetchFn: fetchFn as unknown as typeof fetch })
    expect(h.engineUp.value).toBe(true)
    expect(h.engineKnown.value).toBe(false)
    h.start()
    await vi.advanceTimersByTimeAsync(0)
    // The poll is out, no answer yet: the socket must still wait.
    expect(engineSocketAllowed({ engineKnown: h.engineKnown.value, engineUp: h.engineUp.value, hosted: false })).toBe(false)
    answer(new Response(JSON.stringify({ sailor: true, engine: 'down' }), { status: 200 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(h.engineKnown.value).toBe(true)
    expect(h.engineUp.value).toBe(false)
    expect(engineSocketAllowed({ engineKnown: h.engineKnown.value, engineUp: h.engineUp.value, hosted: false })).toBe(false)
    h.stop()
  })

  it('an engine that is up opens the socket after the first answer', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ sailor: true, engine: 'up' }), { status: 200 }))
    const h = useBackendHealth('http://x', { fetchFn: fetchFn as unknown as typeof fetch })
    h.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(engineSocketAllowed({ engineKnown: h.engineKnown.value, engineUp: h.engineUp.value, hosted: false })).toBe(true)
    h.stop()
  })

  it('Sailor unreachable leaves the engine unknown', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('network') })
    const h = useBackendHealth('http://x', { fetchFn: fetchFn as unknown as typeof fetch })
    h.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.engineKnown.value).toBe(false)
    h.stop()
  })
})

describe('the wiring', () => {
  it('the socket layer starts with the engine unavailable', () => {
    const src = readFileSync(join(APP, 'composables/useDirectExecution.ts'), 'utf8')
    expect(src).toMatch(/^let engineAvailable = false$/m)
    expect(src).not.toMatch(/^let engineAvailable = true/m)
  })
  it('the layout feeds the socket engineSocketAllowed with the first-answer flag and the hosted flag', () => {
    const src = readFileSync(join(APP, 'layouts/default.vue'), 'utf8')
    expect(src).toMatch(/engineKnown, start: startHealthPoll/)
    expect(src).toMatch(/direct\.setEngineAvailable\(\s*engineSocketAllowed\(\{ engineKnown: known, engineUp: up, hosted: hostedShell \}\)/)
    // No direct `setEngineAvailable(up)` that would trust the optimistic start value.
    expect(src).not.toMatch(/setEngineAvailable\(up\)/)
  })
})
