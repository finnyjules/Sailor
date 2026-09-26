// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { useBrushPaint } from '~/composables/useBrushPaint'
import { STEADY_DEFAULTS } from '~/lib/brushTips/steady'
import { encodePts } from '~/lib/brushTips/record'

const STORE_KEY = 'sailor.brushTips.v1'
beforeEach(() => localStorage.clear())

describe('steady defaults + persistence', () => {
  it('defaults to STEADY_DEFAULTS', () => {
    const b = useBrushPaint()
    expect(b.steady).toEqual(STEADY_DEFAULTS)
  })

  it('saves a changed field to localStorage after the debounce flushes', async () => {
    vi.useFakeTimers()
    try {
      const b = useBrushPaint()
      b.steady.streamline = 0.7
      await nextTick()
      vi.advanceTimersByTime(200)
      const stored = JSON.parse(localStorage.getItem(STORE_KEY)!)
      expect(stored.steady.streamline).toBe(0.7)
    } finally {
      vi.useRealTimers()
    }
  })

  it('loads a stored steady, sanitised, defaults for the rest', () => {
    localStorage.setItem(STORE_KEY, JSON.stringify({ steady: { streamline: 'x', hold: 0.8 } }))
    const b = useBrushPaint()
    expect(b.steady).toEqual({ ...STEADY_DEFAULTS, hold: 0.8 })
  })

  it('resetSteady restores the defaults', () => {
    const b = useBrushPaint()
    b.steady.streamline = 0.9
    b.steady.snap = false
    b.resetSteady()
    expect(b.steady).toEqual(STEADY_DEFAULTS)
  })
})

describe('replaceTipSamples', () => {
  it('replaces the live stroke samples and pts in place, keeping the same object', () => {
    const b = useBrushPaint()
    b.beginTipStroke(0.1, 0.1, 1000)
    b.extendTipStroke(0.15, 0.15, 1020)
    b.extendTipStroke(0.2, 0.18, 1040)
    const s = b.liveTipStroke()!
    b.replaceTipSamples([{ x: 0.2, y: 0.2, t: 0 }, { x: 0.3, y: 0.2, t: 50 }])
    expect(s.pts).toEqual(encodePts([{ x: 0.2, y: 0.2, t: 0 }, { x: 0.3, y: 0.2, t: 50 }]))
  })

  it('is a no-op without a live stroke', () => {
    const b = useBrushPaint()
    expect(() => b.replaceTipSamples([{ x: 0.1, y: 0.1, t: 0 }])).not.toThrow()
    expect(b.liveTipStroke()).toBeNull()
  })

  it('continues to append relative to the same t0 after a replace', () => {
    const b = useBrushPaint()
    b.beginTipStroke(0.1, 0.1, 1000)
    b.extendTipStroke(0.15, 0.15, 1020)
    b.extendTipStroke(0.2, 0.18, 1040)
    const s = b.liveTipStroke()!
    b.replaceTipSamples([{ x: 0.2, y: 0.2, t: 0 }, { x: 0.3, y: 0.2, t: 50 }])
    b.extendTipStroke(0.35, 0.2, 1100) // t0 = 1000, so this is t = 100 >= 50
    expect(s.pts.slice(-3)).toEqual([0.35, 0.2, 100])
    const finished = b.endTipStroke()!
    expect(finished.pts).toEqual([
      ...encodePts([{ x: 0.2, y: 0.2, t: 0 }, { x: 0.3, y: 0.2, t: 50 }]),
      0.35, 0.2, 100,
    ])
  })
})
