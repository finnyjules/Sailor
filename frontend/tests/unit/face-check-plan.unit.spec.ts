import { describe, expect, it } from 'vitest'
import { parseCharacterRecord } from '~~/server/utils/characterRegistry'
import { applyChecks, faceFor, FACE_THRESHOLDS, planChecks, verdictFor } from '~~/server/utils/faceCheck/plan'

function rec(extra: Record<string, unknown> = {}) {
  return parseCharacterRecord(JSON.stringify({
    name: 'Jene', face: { filename: 'face.png', approvedAt: 't0' },
    photos: [{ filename: 'face.png' }, { filename: 'blonde.png' }],
    states: [
      { id: 'default', label: 'Everyday', refImages: [], panels: [
        { slot: 'portrait', filename: 'portrait.png' },
        { slot: 'body-front', filename: 'front.png' },
        { slot: 'face-smile', filename: 'smile.png', check: { verdict: 'match', score: 99, against: 'face.png', at: 't' } },
      ] },
      { id: 'heavy', label: 'Heavier', refImages: [], face: { filename: 'heavy-face.png', approvedAt: 't1' },
        panels: [{ slot: 'portrait', filename: 'heavy-portrait.png' }] },
    ],
    ...extra,
  }), 'jene')!
}

describe('faceFor', () => {
  it('uses the look face when set, else the character face', () => {
    expect(faceFor(rec(), 'heavy')).toBe('heavy-face.png')
    expect(faceFor(rec(), 'default')).toBe('face.png')
    expect(faceFor(rec(), null)).toBe('face.png')
  })
})

describe('planChecks', () => {
  it('plans unchecked photos and face panels, skips body panels, the face itself and fresh checks', () => {
    const plan = planChecks(rec())
    expect(plan).toEqual([
      { kind: 'photo', filename: 'blonde.png', against: 'face.png' },
      { kind: 'panel', stateId: 'default', slot: 'portrait', filename: 'portrait.png', against: 'face.png' },
      { kind: 'panel', stateId: 'heavy', slot: 'portrait', filename: 'heavy-portrait.png', against: 'heavy-face.png' },
    ])
  })
  it('re-plans a check made against an older face', () => {
    const r = rec({ face: { filename: 'new-face.png', approvedAt: 't2' } })
    expect(planChecks(r).some(t => t.kind === 'panel' && t.slot === 'face-smile')).toBe(true)
  })
  it('plans nothing without a face', () => {
    const r = rec()
    expect(planChecks({ ...r, face: null, states: r.states.map(s => ({ ...s, face: null })) })).toEqual([])
  })
})

describe('verdictFor', () => {
  it('maps scores through the thresholds', () => {
    expect(verdictFor(null)).toBe('no-face')
    expect(verdictFor(FACE_THRESHOLDS.match)).toBe('match')
    expect(verdictFor(FACE_THRESHOLDS.match - 0.1)).toBe('unsure')
    expect(verdictFor(FACE_THRESHOLDS.unsure)).toBe('unsure')
    expect(verdictFor(FACE_THRESHOLDS.unsure - 0.1)).toBe('different')
  })
})

describe('applyChecks', () => {
  it('writes results, stamps the face itself as a match, and does not mutate', () => {
    const r = rec()
    const before = JSON.stringify(r)
    const plan = planChecks(r)
    const out = applyChecks(r, [
      { target: plan[0]!, score: 41 },
      { target: plan[1]!, score: 97 },
      { target: plan[2]!, score: null },
    ], 'now')
    expect(JSON.stringify(r)).toBe(before)
    expect(out.photos.find(p => p.filename === 'blonde.png')!.check).toEqual({ verdict: 'different', score: 41, against: 'face.png', at: 'now' })
    expect(out.photos.find(p => p.filename === 'face.png')!.check).toEqual({ verdict: 'match', score: 100, against: 'face.png', at: 'now' })
    const def = out.states.find(s => s.id === 'default')!
    expect(def.panels.find(p => p.slot === 'portrait')!.check!.verdict).toBe('match')
    const heavy = out.states.find(s => s.id === 'heavy')!
    expect(heavy.panels[0]!.check).toEqual({ verdict: 'no-face', against: 'heavy-face.png', at: 'now' })
  })
  it('uses a verdict and note given by the checker instead of a score', () => {
    const r = rec()
    const plan = planChecks(r)
    const out = applyChecks(r, [{ target: plan[0]!, score: null, verdict: 'unsure', note: 'hair is shorter' }], 'now')
    expect(out.photos.find(p => p.filename === 'blonde.png')!.check).toEqual({ verdict: 'unsure', against: 'face.png', at: 'now', note: 'hair is shorter' })
  })
  it('does not apply a panel result when the slot now holds a different picture', () => {
    const r = rec()
    const plan = planChecks(r)
    const rerolled = { ...r, states: r.states.map(s => s.id !== 'default' ? s : { ...s, panels: s.panels.map(p => p.slot === 'portrait' ? { ...p, filename: 'portrait-v2.png' } : p) }) }
    const out = applyChecks(rerolled, [{ target: plan[1]!, score: 97 }], 'now')
    expect(out.states.find(s => s.id === 'default')!.panels.find(p => p.slot === 'portrait')!.check).toBeFalsy()
  })
})
