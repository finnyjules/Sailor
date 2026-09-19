import { describe, it, expect } from 'vitest'
import { dialTrackToMotionx, migrateDialTracks } from '~/lib/motionx/adapter/migrateDialTracks'
import { evaluateDialTrack, applyEffectDialTracks, type EffectDialTrack } from '~/lib/motion/effectTracks'
import { evaluateTrack } from '~/lib/motionx'
import { applyMotionxTracks } from '~/lib/motionx/adapter/frame'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const P = 'layers.L1.effects.fx1.intensity'
const num: EffectDialTrack = { target: P, keyframes: [{ t: 3, v: 10, ease: 'linear' }, { t: 1, v: 0, ease: 'linear' }] }
const g1 = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }]
const g2 = [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }]
const SAMPLES = [-0.5, 0, 1, 1.25, 1.5, 2, 2.75, 3, 9]

describe('dialTrackToMotionx', () => {
  it('number track: path verbatim, sorted keyframes, value + ease carried', () => {
    expect(dialTrackToMotionx(num)).toEqual({
      path: P, type: 'number',
      keyframes: [{ t: 1, value: 0, ease: 'linear' }, { t: 3, value: 10, ease: 'linear' }],
    })
  })
  it('a missing ease becomes easeInOut (the legacy default)', () => {
    const tr = dialTrackToMotionx({ target: P, keyframes: [{ t: 0, v: 0 }, { t: 4, v: 8 }] })!
    expect(tr.keyframes.map((k) => k.ease)).toEqual(['easeInOut', 'easeInOut'])
    expect(evaluateTrack(tr, 1)).toBeCloseTo(1, 9)   // easeInOutQuad(0.25) = 0.125 → 8 · 0.125
  })
  it('colour track keeps its mix space (default oklch)', () => {
    const c = { target: 'layers.L1.effects.fx1.tint', keyframes: [{ t: 0, v: '#ff0000' }, { t: 2, v: '#0000ff' }] }
    expect(dialTrackToMotionx(c)!.type).toBe('color')
    expect(dialTrackToMotionx(c)!.space).toBe('oklch')
    expect(dialTrackToMotionx({ ...c, space: 'srgb' })!.space).toBe('srgb')
  })
  it('gradient track: mode copies, blendSpace becomes space', () => {
    const tr = dialTrackToMotionx({ target: 'layers.L1.fill', keyframes: [{ t: 0, v: g1 }, { t: 2, v: g2 }], mode: 'travel', blendSpace: 'hybrid' })!
    expect(tr).toMatchObject({ type: 'gradient', mode: 'travel', space: 'hybrid' })
  })
  it('refuses what it cannot express', () => {
    expect(dialTrackToMotionx({ target: P, keyframes: [] })).toBeNull()
    expect(dialTrackToMotionx({ target: P, keyframes: [{ t: 0, v: 1 }, { t: 1, v: '#ffffff' }] })).toBeNull()
    expect(dialTrackToMotionx({ target: P, keyframes: [{ t: 0, v: 'rgba(0,0,0,1)' }, { t: 1, v: '#ffffff' }] })).toBeNull()
  })
})

describe('converted tracks evaluate IDENTICALLY to the legacy evaluator', () => {
  const cases: Record<string, EffectDialTrack> = {
    'number linear': num,
    'number default ease': { target: P, keyframes: [{ t: 1, v: 2 }, { t: 2, v: -4 }, { t: 3, v: 7, ease: 'linear' }] },
    'single keyframe': { target: P, keyframes: [{ t: 2, v: 0.4 }] },
    'colour oklch': { target: P, keyframes: [{ t: 1, v: '#ff0000' }, { t: 3, v: '#00ff88' }] },
    'colour srgb': { target: P, keyframes: [{ t: 1, v: '#ff0000' }, { t: 3, v: '#00ff88' }], space: 'srgb' },
    'gradient crossfade': { target: 'layers.L1.fill', keyframes: [{ t: 1, v: g1 }, { t: 3, v: g2 }] },
    'gradient travel hybrid': { target: 'layers.L1.fill', keyframes: [{ t: 1, v: g1 }, { t: 3, v: g2 }], mode: 'travel', blendSpace: 'hybrid' },
  }
  for (const [name, legacy] of Object.entries(cases)) {
    it(name, () => {
      const conv = dialTrackToMotionx(legacy)!
      for (const t of SAMPLES) expect(evaluateTrack(conv, t), `${name} @ ${t}`).toEqual(evaluateDialTrack(legacy, t))
    })
  }
  it('anchor (not just parity): 0→10 linear over 1..3 is 5 at t=2', () => {
    expect(evaluateTrack(dialTrackToMotionx(num)!, 2)).toBe(5)
  })
  it('the render fold gives the same layer either way', () => {
    const l = { id: 'L1', x: 0.5, y: 0.5, rotation: 0, scale: 1, opacity: 1, effects: [{ id: 'fx1', type: 'bloom', threshold: 0.5, radius: 0.1, intensity: 1 }] } as unknown as LocalLayer
    for (const t of SAMPLES) {
      expect(applyMotionxTracks([l], [dialTrackToMotionx(num)!], t)).toEqual(applyEffectDialTracks([l], [num], t))
    }
  })
})

describe('migrateDialTracks', () => {
  it('no legacy tracks → the very same object (byte-identity)', () => {
    const m = { fps: 30, duration: 4, motionx: [] }
    expect(migrateDialTracks(m).motion).toBe(m)
    const m2 = { fps: 30, duration: 4, tracks: [] as EffectDialTrack[] }
    expect(migrateDialTracks(m2).motion).toBe(m2)
  })
  it('moves convertible tracks into motionx and removes the tracks key', () => {
    const out = migrateDialTracks({ fps: 30, duration: 4, tracks: [num] })
    expect(out.converted).toBe(1)
    expect('tracks' in out.motion).toBe(false)
    expect(out.motion.motionx).toEqual([dialTrackToMotionx(num)])
  })
  it('appends after existing bands and never touches them', () => {
    const band = { path: 'layers.L1.opacity', type: 'number' as const, keyframes: [{ t: 0, value: 1, ease: 'linear' as const }] }
    expect(migrateDialTracks({ motionx: [band], tracks: [num] }).motion.motionx).toEqual([band, dialTrackToMotionx(num)])
  })
  it('drops a legacy track whose path a band already drives (it was already overridden)', () => {
    const band = { path: P, type: 'number' as const, keyframes: [{ t: 0, value: 3, ease: 'linear' as const }] }
    const out = migrateDialTracks({ motionx: [band], tracks: [num] })
    expect(out).toMatchObject({ converted: 0, dropped: 1 })
    expect(out.motion.motionx).toEqual([band])
    expect('tracks' in out.motion).toBe(false)
  })
  it('leaves unconvertible tracks where they are', () => {
    const odd: EffectDialTrack = { target: 'layers.L1.effects.fx1.mode', keyframes: [{ t: 0, v: 'soft' }, { t: 1, v: 'hard' }] }
    const out = migrateDialTracks({ tracks: [num, odd] })
    expect(out.motion.tracks).toEqual([odd])
    expect(out.converted).toBe(1)
  })
  it('is idempotent', () => {
    const once = migrateDialTracks({ tracks: [num] }).motion
    expect(migrateDialTracks(once).motion).toBe(once)
  })
  it('any ease other than linear converts to easeInOut, exactly as the old evaluator treated it', () => {
    const odd = { target: P, keyframes: [{ t: 0, v: 0, ease: 'easeIn' as never }, { t: 1, v: 10, ease: 'garbage' as never }, { t: 2, v: 0, ease: 'linear' }] }
    const tr = dialTrackToMotionx(odd)!
    expect(tr.keyframes.map((k) => k.ease)).toEqual(['easeInOut', 'easeInOut', 'linear'])
    for (const t of [0.25, 0.5, 1.5]) expect(evaluateTrack(tr, t)).toEqual(evaluateDialTrack(odd, t))
  })
  it('keeps only the last legacy track when there are duplicates (matching old fold behaviour)', () => {
    const first = { target: P, keyframes: [{ t: 0, v: 0 }, { t: 1, v: 10 }] }
    const second = { target: P, keyframes: [{ t: 0, v: 5 }, { t: 1, v: 15 }] }
    const out = migrateDialTracks({ tracks: [first, second] })
    expect(out.converted).toBe(1)
    expect(out.dropped).toBe(1)
    expect(out.motion.motionx).toEqual([dialTrackToMotionx(second)])

    // Verify parity: the fold applies the second (later) track
    const l = { id: 'L1', x: 0.5, y: 0.5, rotation: 0, scale: 1, opacity: 1, effects: [{ id: 'fx1', type: 'bloom', threshold: 0.5, radius: 0.1, intensity: 1 }] } as unknown as LocalLayer
    for (const t of SAMPLES) {
      expect(applyMotionxTracks([l], out.motion.motionx, t)).toEqual(applyEffectDialTracks([l], [second], t))
    }
  })

  // A dial the bloom fixture below really has (`intensity`), driven with non-hex string
  // values so `evaluateDialTrack` STEPs — mixed/non-hex-string keyframes are unconvertible
  // (`dialTrackToMotionx` returns null), matching `typeOf`'s "mixed types / non-hex strings
  // STEP in the legacy evaluator" comment.
  const unconv: EffectDialTrack = { target: P, keyframes: [{ t: 0, v: 'soft' }, { t: 1, v: 'hard' }] }
  const bloomLayer = { id: 'L1', x: 0.5, y: 0.5, rotation: 0, scale: 1, opacity: 1, effects: [{ id: 'fx1', type: 'bloom', threshold: 0.5, radius: 0.1, intensity: 1 }] } as unknown as LocalLayer

  it('keeps the literal last duplicate on a target even when it is unconvertible: drops the earlier convertible one, creates no band', () => {
    const out = migrateDialTracks({ tracks: [num, unconv] })
    expect(out.motion.tracks).toEqual([unconv])
    expect((out.motion.motionx ?? []).some((tr) => tr.path === P)).toBe(false)
    expect(out.converted).toBe(0)
    expect(out.dropped).toBe(1)

    for (const t of SAMPLES) {
      expect(applyMotionxTracks(applyEffectDialTracks([bloomLayer], out.motion.tracks, t), out.motion.motionx, t))
        .toEqual(applyEffectDialTracks([bloomLayer], [num, unconv], t))
    }
  })

  it('converts the literal last duplicate on a target even when an earlier duplicate was unconvertible', () => {
    const out = migrateDialTracks({ tracks: [unconv, num] })
    expect('tracks' in out.motion).toBe(false)
    expect(out.motion.motionx).toEqual([dialTrackToMotionx(num)])
    expect(out.converted).toBe(1)
    expect(out.dropped).toBe(1)

    for (const t of SAMPLES) {
      expect(applyMotionxTracks(applyEffectDialTracks([bloomLayer], out.motion.tracks, t), out.motion.motionx, t))
        .toEqual(applyEffectDialTracks([bloomLayer], [unconv, num], t))
    }
  })

  it('when both duplicates convert, the band is built from the literal last one (a keyframe value differs from the first)', () => {
    const first = { target: P, keyframes: [{ t: 0, v: 0 }, { t: 1, v: 10 }] }
    const second = { target: P, keyframes: [{ t: 0, v: 5 }, { t: 1, v: 15 }] }
    const out = migrateDialTracks({ tracks: [first, second] })
    expect(out.motion.motionx).toEqual([dialTrackToMotionx(second)])
    expect((out.motion.motionx ?? []).filter((tr) => tr.path === P)).toHaveLength(1)
    // second's t=0 keyframe value (5) differs from first's (0) — confirms it's built from second.
    expect(out.motion.motionx![0]!.keyframes[0]!.value).toBe(5)

    for (const t of SAMPLES) {
      expect(applyMotionxTracks(applyEffectDialTracks([bloomLayer], out.motion.tracks, t), out.motion.motionx, t))
        .toEqual(applyEffectDialTracks([bloomLayer], [first, second], t))
    }
  })
})
