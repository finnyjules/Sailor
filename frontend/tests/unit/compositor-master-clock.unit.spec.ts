// frontend/tests/unit/compositor-master-clock.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { deriveMasterClock, slotPhase01 } from '~/lib/compositor/masterClock'
import { clipClocks, createImageLayer, type ImageLayer } from '~/composables/useCompositorLayers'

describe('deriveMasterClock', () => {
  it('is null with no animated slots and no override', () => {
    expect(deriveMasterClock([{ duration: 0, fps: 0 }, { duration: 0, fps: 30 }])).toBeNull()
  })

  it('reconciles animated slots into the LCM master loop (max fps)', () => {
    // animated: 4s@30 and 6s@24 → frame base 30; frames 120 & 180; lcm 360 → 12s.
    expect(deriveMasterClock([{ duration: 4, fps: 30 }, { duration: 6, fps: 24 }, { duration: 0, fps: 60 }]))
      .toEqual({ duration: 12, fps: 30 })
  })

  it('ignores still slots (duration <= 0) in the derivation', () => {
    expect(deriveMasterClock([{ duration: 0, fps: 999 }, { duration: 3, fps: 25 }]))
      .toEqual({ duration: 3, fps: 25 })
  })

  it('override wins over the derived clock', () => {
    expect(deriveMasterClock([{ duration: 6, fps: 24 }], { duration: 10, fps: 60 }))
      .toEqual({ duration: 10, fps: 60 })
  })

  it('override applies even with no animated slots', () => {
    expect(deriveMasterClock([{ duration: 0, fps: 0 }], { duration: 8, fps: 30 }))
      .toEqual({ duration: 8, fps: 30 })
  })

  it('ignores a null override', () => {
    expect(deriveMasterClock([{ duration: 5, fps: 30 }], null)).toEqual({ duration: 5, fps: 30 })
  })
})

describe('slotPhase01', () => {
  it('maps native-speed loop: master time modulo slot duration, normalized', () => {
    expect(slotPhase01(0, 4)).toBeCloseTo(0)
    expect(slotPhase01(1, 4)).toBeCloseTo(0.25)
    expect(slotPhase01(4, 4)).toBeCloseTo(0)      // wraps at its own duration
    expect(slotPhase01(5, 4)).toBeCloseTo(0.25)   // second loop
  })

  it('a slot longer than master has not yet wrapped', () => {
    expect(slotPhase01(3, 8)).toBeCloseTo(0.375)
  })

  it('guards a zero/negative slot duration as phase 0', () => {
    expect(slotPhase01(2, 0)).toBe(0)
    expect(slotPhase01(2, -1)).toBe(0)
  })
})

describe('deriveMasterClock with a living image beside a studio slot', () => {
  it('reconciles the clip period with the slot period', () => {
    const rose: ImageLayer = {
      ...createImageLayer('rose.png', 1),
      clip: { dir: 'sailor_clips/c', frames: 48, fps: 24, speed: 1, prompt: '', model: 'luma-ray-2-720p' }, // 2 s
    }
    const mc = deriveMasterClock([{ duration: 3, fps: 24 }, ...clipClocks([rose])])
    expect(mc).toEqual({ duration: 6, fps: 24 })
  })
  it('a clip alone gives the Frame a clock', () => {
    const rose: ImageLayer = {
      ...createImageLayer('rose.png', 1),
      clip: { dir: 'sailor_clips/c', frames: 120, fps: 24, speed: 2, prompt: '', model: 'seedance-2.0' }, // 2.5 s played
    }
    expect(deriveMasterClock(clipClocks([rose]))).toEqual({ duration: 2.5, fps: 24 })
  })
})
