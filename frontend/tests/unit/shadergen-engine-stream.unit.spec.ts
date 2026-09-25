import { describe, it, expect, vi } from 'vitest'
import { generateTakes, isAbortError, type EngineDeps, type TakeRenderer } from '~/lib/shadergen/engine'
import { TAKE_ANGLES } from '~/lib/shadergen/prompt'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'

const renderer: TakeRenderer = { compile: () => null, judge: () => ({ pass: true, flags: [], thumbnail: 'data:thumb' }), sheet: () => 'data:sheet' }
const slotOf = (prompt: string) => TAKE_ANGLES.findIndex(a => prompt.includes(a))
/** The spike's hand-written takes as canned model replies; slot i answers after delays[i] ms. */
function canned(delays: number[]): EngineDeps['callModel'] {
  return vi.fn(async (prompt: string, _images?: string[], signal?: AbortSignal) => {
    const slot = slotOf(prompt)
    await new Promise<void>((res, rej) => {
      const t = setTimeout(res, delays[slot] ?? 0)
      signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')) })
    })
    return { text: JSON.stringify(SPIKE_TAKES.rain![slot]), usage: { input_tokens: 5000, output_tokens: 3000 } }
  })
}

describe('generateTakes streams takes as they pass', () => {
  it('calls onTake in arrival order with each take’s slot', async () => {
    const seen: number[] = []
    const r = await generateTakes({ request: 'rain on a window', count: 3 }, {
      callModel: canned([30, 5, 15]), renderer, onTake: (_t, slot) => seen.push(slot),
    })
    expect(seen).toEqual([1, 2, 0])
    expect(r.takes).toHaveLength(3)
  })

  it('a slot that gives up reports onFailure', async () => {
    const fails: number[] = []
    const callModel = vi.fn(async (prompt: string) => (slotOf(prompt) === 2
      ? { text: 'not json' }
      : { text: JSON.stringify(SPIKE_TAKES.rain![slotOf(prompt)]) }))
    const r = await generateTakes({ request: 'x', count: 3 }, { callModel, renderer, onFailure: s => fails.push(s) })
    expect(fails).toEqual([2])
    expect(r.takes).toHaveLength(2)
  })

  it('an aborted request rejects with AbortError and stops calling the model', async () => {
    const ctrl = new AbortController()
    const callModel = canned([50, 50, 50])
    const p = generateTakes({ request: 'x', count: 3, signal: ctrl.signal }, { callModel, renderer })
    setTimeout(() => ctrl.abort(), 10)
    const err = await p.catch(e => e)
    expect(isAbortError(err)).toBe(true)
    expect((callModel as any).mock.calls.length).toBe(3) // no repair calls after the abort
  })

  it('an already-aborted signal never calls the model', async () => {
    const ctrl = new AbortController(); ctrl.abort()
    const callModel = canned([0, 0, 0])
    await expect(generateTakes({ request: 'x', count: 3, signal: ctrl.signal }, { callModel, renderer })).rejects.toSatisfy(isAbortError)
    expect(callModel).not.toHaveBeenCalled()
  })

  it('passes the signal to callModel', async () => {
    const ctrl = new AbortController()
    const callModel = canned([0, 0, 0])
    await generateTakes({ request: 'x', count: 3, signal: ctrl.signal }, { callModel, renderer })
    expect((callModel as any).mock.calls[0][2]).toBe(ctrl.signal)
  })
})

describe('take angles', () => {
  it('don’t say "of 4" (the product asks for three)', () => {
    for (const a of TAKE_ANGLES) expect(a).not.toMatch(/of \d/)
  })
})
