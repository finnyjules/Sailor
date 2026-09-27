import { describe, it, expect } from 'vitest'
import { createDefaultShotSheet, type ShotSheet, type Ref } from '../../app/lib/shotdirector/types'
import { validateShotSheet, type RefCaps } from '../../app/lib/shotdirector/rules'

const CAPS: RefCaps = {
  maxRefImages: 9, maxRefVideos: 3, maxRefAudios: 3, supportsFirstLastFrame: true,
  label: 'Test Model', castMode: 'images', requiresFirstFrame: false, supportsLastFrame: true, refsWithFirstFrame: false,
}

const img = (slot: number): Ref => ({ kind: 'image', slot, src: 'x', role: 'identity-lock' })
const aud = (slot: number): Ref => ({ kind: 'audio', slot, src: 'x', role: 'mood' })

function codes(sheet: ShotSheet) {
  return validateShotSheet(sheet, CAPS).map(i => i.code)
}

describe('validateShotSheet', () => {
  it('a fresh default sheet has no issues', () => {
    expect(validateShotSheet(createDefaultShotSheet(), CAPS)).toEqual([])
  })

  it('flags reference mode carrying a first frame', () => {
    const s = createDefaultShotSheet()
    s.firstFrame = 'data:...'
    expect(codes(s)).toContain('mode-conflict')
  })

  it('flags firstLastFrame mode carrying references', () => {
    const s = createDefaultShotSheet()
    s.mode = 'firstLastFrame'
    s.references = [img(1)]
    expect(codes(s)).toContain('mode-conflict')
  })

  it('flags audio references with no visual reference', () => {
    const s = createDefaultShotSheet()
    s.references = [aud(1)]
    expect(codes(s)).toContain('audio-needs-visual')
  })

  it('allows audio references when an image reference is present', () => {
    const s = createDefaultShotSheet()
    s.references = [img(1), aud(1)]
    expect(codes(s)).not.toContain('audio-needs-visual')
  })

  it('flags more than three beats', () => {
    const s = createDefaultShotSheet()
    s.beats = [0, 1, 2, 3].map(i => ({ id: `b${i}`, startS: i, endS: i + 1, action: 'x' }))
    expect(codes(s)).toContain('too-many-beats')
  })

  it('flags beats when duration is intelligent (-1)', () => {
    const s = createDefaultShotSheet()
    s.format.durationS = -1
    s.beats = [{ id: 'b0', startS: 0, endS: 2, action: 'x' }]
    expect(codes(s)).toContain('beats-need-duration')
  })

  it('flags a beat that overflows the clip duration', () => {
    const s = createDefaultShotSheet()
    s.format.durationS = 5
    s.beats = [{ id: 'b0', startS: 0, endS: 8, action: 'x' }]
    expect(codes(s)).toContain('beat-overflow')
  })

  it('flags too many image references for the profile', () => {
    const s = createDefaultShotSheet()
    s.references = Array.from({ length: 10 }, (_, i) => img(i + 1))
    expect(codes(s)).toContain('too-many-image-refs')
  })

  it('flags video references when the profile supports none', () => {
    const s = createDefaultShotSheet()
    s.references = [img(1), { kind: 'video', slot: 1, src: 'x', role: 'camera-copy' }]
    const caps: RefCaps = { ...CAPS, maxRefVideos: 0 }
    expect(validateShotSheet(s, caps).map(i => i.code)).toContain('videos-unsupported')
  })

  it('flags a model that requires a first frame when none is set, naming it from the label', () => {
    const s = createDefaultShotSheet()
    const caps: RefCaps = { ...CAPS, requiresFirstFrame: true, label: 'Kling 3' }
    const issues = validateShotSheet(s, caps)
    expect(issues).toContainEqual({
      level: 'error', code: 'first-frame-required',
      message: 'Kling 3 needs a first frame. Make one from the cast or upload one.',
    })
  })

  it('does not flag a first-frame requirement when a first frame is set', () => {
    const s = createDefaultShotSheet()
    s.mode = 'firstLastFrame'
    s.firstFrame = 'FIRST'
    const caps: RefCaps = { ...CAPS, requiresFirstFrame: true, label: 'Kling 3' }
    expect(codesWith(s, caps)).not.toContain('first-frame-required')
  })

  it('flags a last frame on a model that cannot use one', () => {
    const s = createDefaultShotSheet()
    s.mode = 'firstLastFrame'
    s.firstFrame = 'FIRST'
    s.lastFrame = 'LAST'
    const caps: RefCaps = { ...CAPS, supportsLastFrame: false, label: 'Veo 3.1' }
    const issues = validateShotSheet(s, caps)
    expect(issues).toContainEqual({ level: 'error', code: 'last-frame-unsupported', message: "Veo 3.1 can't use a last frame." })
  })

  it('warns (not errors) when a first frame silently drops manual image references', () => {
    const s = createDefaultShotSheet()
    s.mode = 'firstLastFrame'
    s.firstFrame = 'FIRST'
    s.references = [img(1)]
    const caps: RefCaps = { ...CAPS, refsWithFirstFrame: false, label: 'Seedance 2.0' }
    const issues = validateShotSheet(s, caps)
    const warning = issues.find(i => i.code === 'first-frame-drops-refs')
    expect(warning).toEqual({
      level: 'warning', code: 'first-frame-drops-refs',
      message: 'Seedance 2.0 uses either the first frame or reference pictures, not both. Characters are left out while a first frame is set.',
    })
    expect(issues.some(i => i.level === 'error' && i.code === 'first-frame-drops-refs')).toBe(false)
  })

  it('warns when a first frame silently drops cast in images mode, even with no manual references', () => {
    const s = createDefaultShotSheet()
    s.mode = 'firstLastFrame'
    s.firstFrame = 'FIRST'
    s.cast = [{ slug: 'reva', name: 'Reva', via: 'picker', stateId: null }]
    const caps: RefCaps = { ...CAPS, castMode: 'images', refsWithFirstFrame: false }
    expect(codesWith(s, caps)).toContain('first-frame-drops-refs')
  })

  it('does not warn when the model can send references alongside a first frame (Kling)', () => {
    const s = createDefaultShotSheet()
    s.mode = 'firstLastFrame'
    s.firstFrame = 'FIRST'
    s.cast = [{ slug: 'reva', name: 'Reva', via: 'picker', stateId: null }]
    const caps: RefCaps = { ...CAPS, castMode: 'elements', refsWithFirstFrame: true, requiresFirstFrame: true }
    expect(codesWith(s, caps)).not.toContain('first-frame-drops-refs')
  })
})

function codesWith(sheet: ShotSheet, caps: RefCaps) {
  return validateShotSheet(sheet, caps).map(i => i.code)
}
