import { describe, it, expect } from 'vitest'
import { buildKeyframePrompt, startFrameImages, KEYFRAME_COST_USD } from '../../app/lib/shotdirector/keyframe'
import type { IdentityRefSet } from '#shared/characters/types'
import { createDefaultShotSheet } from '../../app/lib/shotdirector/types'

function sheet() {
  const s = createDefaultShotSheet()
  s.subject = 'A woman in a red coat'
  s.action = 'walks toward camera'
  s.environment = 'a rainy neon street'
  s.lighting = 'neon'
  s.style = 'cinematic, 35mm'
  s.camera = { shotType: 'medium', move: 'push-in', pacing: 'smooth' }
  return s
}

describe('buildKeyframePrompt', () => {
  it('composes person + location when both refs present', () => {
    const p = buildKeyframePrompt(sheet(), { hasPerson: true, hasLocation: true })
    expect(p).toContain('Place the person from the first image into the location in the second image.')
    expect(p).toContain('Medium shot.')
    expect(p).toContain('neon; cinematic, 35mm.')
  })

  it('references the first image for person-only and location-only', () => {
    expect(buildKeyframePrompt(sheet(), { hasPerson: true, hasLocation: false }))
      .toContain('Feature the person from the first image.')
    expect(buildKeyframePrompt(sheet(), { hasPerson: false, hasLocation: true }))
      .toContain('Set in the location from the first image.')
  })

  it('is a still — never emits camera move or pacing words', () => {
    const p = buildKeyframePrompt(sheet(), { hasPerson: true, hasLocation: true })
    expect(p).not.toMatch(/push-in|pull-out|pan|track|orbit|aerial|handheld|locked-off/)
    expect(p).not.toMatch(/smooth|slow|gradual|gentle/)
  })

  it('works with no refs (pure text) and no composition sentence', () => {
    const p = buildKeyframePrompt(sheet(), { hasPerson: false, hasLocation: false })
    expect(p).toContain('Photorealistic cinematic film still.')
    expect(p).not.toContain('image.')
    expect(p).toContain('A woman in a red coat walks toward camera.')
  })

  it('exposes a cost constant', () => {
    expect(KEYFRAME_COST_USD).toBeGreaterThan(0)
  })
})

function set(name: string, p: Partial<IdentityRefSet> = {}): IdentityRefSet {
  return { name, front: `/${name}/front`, portrait: `/${name}/portrait`, bodyFront: `/${name}/body`, bodyBack: `/${name}/back`, ...p }
}

describe('startFrameImages', () => {
  it('numbers one member: front, body front, then clothes', () => {
    const r = startFrameImages([{ name: 'Reva', set: set('reva'), clothes: ['/c1'] }], null)
    expect(r.urls).toEqual(['/reva/front', '/reva/body', '/c1'])
    expect(r.castLine).toBe('Reva is the person in images 1–2, wearing the clothes in image 3.')
  })

  it('numbers two members in order, and skips a missing body front', () => {
    const r = startFrameImages([
      { name: 'Reva', set: set('reva'), clothes: ['/c1'] },
      { name: 'Marcus', set: set('marcus', { bodyFront: null }), clothes: [] },
    ], null)
    expect(r.urls).toEqual(['/reva/front', '/reva/body', '/c1', '/marcus/front'])
    expect(r.castLine).toBe('Reva is the person in images 1–2, wearing the clothes in image 3. Marcus is the person in image 4.')
  })

  it('caps clothes at two per member, with a range', () => {
    const r = startFrameImages([{ name: 'Reva', set: set('reva'), clothes: ['/c1', '/c2', '/c3'] }], null)
    expect(r.urls).toEqual(['/reva/front', '/reva/body', '/c1', '/c2'])
    expect(r.castLine).toBe('Reva is the person in images 1–2, wearing the clothes in images 3–4.')
  })

  it('puts the location last and names it', () => {
    const r = startFrameImages([{ name: 'Reva', set: set('reva'), clothes: [] }], '/loc')
    expect(r.urls).toEqual(['/reva/front', '/reva/body', '/loc'])
    expect(r.castLine).toBe('Reva is the person in images 1–2. The location is in image 3.')
  })

  it('takes at most three members', () => {
    const r = startFrameImages(['A', 'B', 'C', 'D'].map(n => ({ name: n, set: set(n, { bodyFront: null }), clothes: [] })), null)
    expect(r.urls).toEqual(['/A/front', '/B/front', '/C/front'])
    expect(r.castLine).not.toContain('D ')
  })

  it('leaves out a member with no pictures', () => {
    const r = startFrameImages([
      { name: 'Ghost', set: set('ghost', { front: null, bodyFront: null }), clothes: [] },
      { name: 'Reva', set: set('reva', { bodyFront: null }), clothes: [] },
    ], null)
    expect(r.urls).toEqual(['/reva/front'])
    expect(r.castLine).toBe('Reva is the person in image 1.')
  })
})

describe('buildKeyframePrompt with a cast line', () => {
  it('uses the cast line in place of the first-image sentence', () => {
    const line = 'Reva is the person in images 1–2. The location is in image 3.'
    const p = buildKeyframePrompt(sheet(), { hasPerson: true, hasLocation: true, castLine: line })
    expect(p).toContain(line)
    expect(p).not.toContain('first image')
    expect(p.startsWith(`Photorealistic cinematic film still. ${line}`)).toBe(true)
  })
})
