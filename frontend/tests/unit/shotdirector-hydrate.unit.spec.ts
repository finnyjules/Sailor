import { describe, it, expect } from 'vitest'
import { createDefaultShotSheet } from '../../app/lib/shotdirector/types'
import { hydrateShotSheet, nextSlot, addRef, removeRef } from '../../app/lib/shotdirector/hydrate'

describe('hydrateShotSheet', () => {
  it('returns full defaults for empty/garbage input', () => {
    expect(hydrateShotSheet(undefined)).toEqual(createDefaultShotSheet())
    expect(hydrateShotSheet(null)).toEqual(createDefaultShotSheet())
    expect(hydrateShotSheet(42)).toEqual(createDefaultShotSheet())
  })

  it('carries over provided scalar + nested fields and defaults the rest', () => {
    const s = hydrateShotSheet({ subject: 'a cat', camera: { move: 'pan' }, format: { durationS: 10 } })
    expect(s.subject).toBe('a cat')
    expect(s.camera.move).toBe('pan')
    expect(s.camera.shotType).toBe('medium')   // default preserved
    expect(s.format.durationS).toBe(10)
    expect(s.format.resolution).toBe('1080p')   // default preserved
    expect(s.references).toEqual([])
    expect(s.beats).toEqual([])
  })

  it('defaults array fields when they are the wrong type', () => {
    const s = hydrateShotSheet({ references: 'nope', beats: null, constraints: undefined })
    expect(s.references).toEqual([])
    expect(s.beats).toEqual([])
    expect(s.constraints).toEqual([])
  })
})

describe('reference helpers', () => {
  it('nextSlot returns the smallest unused 1-based slot per kind', () => {
    const refs = [
      { kind: 'image', slot: 1, src: 'a', role: 'identity-lock' },
      { kind: 'image', slot: 3, src: 'b', role: 'style-transfer' },
      { kind: 'video', slot: 1, src: 'c', role: 'camera-copy' },
    ] as const
    expect(nextSlot([...refs], 'image')).toBe(2)
    expect(nextSlot([...refs], 'video')).toBe(2)
    expect(nextSlot([], 'audio')).toBe(1)
  })

  it('addRef appends at nextSlot without mutating the input', () => {
    const s0 = createDefaultShotSheet()
    const s1 = addRef(s0, 'image', 'data:x', 'identity-lock')
    expect(s0.references).toEqual([])            // input untouched
    expect(s1.references).toEqual([{ kind: 'image', slot: 1, src: 'data:x', role: 'identity-lock' }])
  })

  it('removeRef drops the matching ref and leaves other slots unrenumbered', () => {
    let s = createDefaultShotSheet()
    s = addRef(s, 'image', 'a', 'identity-lock')   // slot 1
    s = addRef(s, 'image', 'b', 'style-transfer')  // slot 2
    const s2 = removeRef(s, 'image', 1)
    expect(s2.references).toEqual([{ kind: 'image', slot: 2, src: 'b', role: 'style-transfer' }])
  })
})

describe('hydrateShotSheet — model', () => {
  it('defaults the model to Seedance 2.0 when none is stored', () => {
    expect(hydrateShotSheet({}).model).toBe('seedance-2.0')
    expect(createDefaultShotSheet().model).toBe('seedance-2.0')
  })

  it('keeps a known model id', () => {
    expect(hydrateShotSheet({ model: 'kling-v3' }).model).toBe('kling-v3')
    expect(hydrateShotSheet({ model: 'veo-3.1-fast' }).model).toBe('veo-3.1-fast')
  })

  it('falls back to Seedance 2.0 for an unknown or non-string id', () => {
    expect(hydrateShotSheet({ model: 'sora-9' }).model).toBe('seedance-2.0')
    expect(hydrateShotSheet({ model: 42 }).model).toBe('seedance-2.0')
  })
})
