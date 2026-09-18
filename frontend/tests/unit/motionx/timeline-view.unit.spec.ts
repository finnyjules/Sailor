import { describe, it, expect } from 'vitest'
import {
  deriveView, clampViewStart, timeToX, xToTime, zoomAboutPivot, computeTicks, formatClock, formatRulerSeconds,
} from '~/lib/motionx/timelineView'

describe('deriveView', () => {
  it('at zoom 1 shows the whole duration', () => {
    const d = deriveView({ zoom: 1, viewStart: 0 }, 4, 800)
    expect(d.visibleDuration).toBe(4)
    expect(d.pxPerSecond).toBe(200)
    expect(d.safeViewStart).toBe(0)
    expect(d.viewEnd).toBe(4)
  })
  it('at zoom 2 shows half, pxPerSecond doubles, viewStart clamps', () => {
    const d = deriveView({ zoom: 2, viewStart: 3.5 }, 4, 800)
    expect(d.visibleDuration).toBe(2)
    expect(d.pxPerSecond).toBe(400)
    expect(d.safeViewStart).toBe(2)   // clamped to duration - visible = 4 - 2
  })
  it('maxZoom is at least 8 and grows with duration/laneWidth', () => {
    expect(deriveView({ zoom: 1, viewStart: 0 }, 0, 0).maxZoom).toBe(8)
    // (140*40)/(0.001*10*800) = 5600/8 = 700
    expect(deriveView({ zoom: 1, viewStart: 0 }, 40, 800).maxZoom).toBeCloseTo(700, 6)
  })
})

describe('clampViewStart', () => {
  it('clamps into [0, duration - shown]', () => {
    expect(clampViewStart(-1, 4, 2)).toBe(0)
    expect(clampViewStart(5, 4, 2)).toBe(2)
    expect(clampViewStart(1, 4, 2)).toBe(1)
  })
})

describe('timeToX / xToTime round-trip', () => {
  it('maps time to px across the visible range and back', () => {
    const d = deriveView({ zoom: 2, viewStart: 1 }, 4, 800)  // visible 2s, pps 400, safeViewStart 1
    expect(timeToX(1, d)).toBe(0)
    expect(timeToX(3, d)).toBe(800)
    expect(xToTime(400, d)).toBeCloseTo(2, 6)
  })
})

describe('zoomAboutPivot', () => {
  it('exponential zoom keeps the anchor time pinned under the cursor', () => {
    const duration = 4, laneWidth = 800
    const before = deriveView({ zoom: 1, viewStart: 0 }, duration, laneWidth)
    const anchorRatio = 0.5
    const anchorTime = before.safeViewStart + anchorRatio * before.visibleDuration  // 2
    const next = zoomAboutPivot({ zoom: 1, viewStart: 0 }, duration, laneWidth, 180, anchorRatio, anchorTime)
    expect(next.zoom).toBeCloseTo(Math.E, 5)   // exp(180/180) = e
    const after = deriveView(next, duration, laneWidth)
    expect(after.safeViewStart + anchorRatio * after.visibleDuration).toBeCloseTo(2, 4)
  })
  it('clamps zoom to [1, maxZoom]', () => {
    const next = zoomAboutPivot({ zoom: 1, viewStart: 0 }, 4, 800, -9999, 0.5, 2)
    expect(next.zoom).toBe(1)
  })
})

describe('computeTicks', () => {
  it('at zoom 1 over 4s (pps 200) majors land on whole seconds', () => {
    const d = deriveView({ zoom: 1, viewStart: 0 }, 4, 800)
    const t = computeTicks(d, 1, 4)
    expect(t.majorStep).toBe(1)          // rawStep 0.7 → adaptive 1 (zoom<1.5 & dur>=1 floors to 1)
    expect(t.major).toEqual([0, 1, 2, 3, 4])
    expect(t.medium).toContain(0.5)      // index 5 (0.5) is medium
    expect(t.fine.length).toBeGreaterThan(0)
  })
})

describe('formatClock / formatRulerSeconds', () => {
  it('formatClock is mm:ss', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(65)).toBe('1:05')
  })
  it('formatRulerSeconds uses clock for integer >=1s steps, else fixed seconds', () => {
    expect(formatRulerSeconds(2, 1)).toBe('0:02')   // 2 seconds = mm:ss 0:02
    expect(formatRulerSeconds(0.5, 0.1)).toBe('0.5s')
    expect(formatRulerSeconds(0.25, 0.05)).toBe('0.25s')
  })
})
