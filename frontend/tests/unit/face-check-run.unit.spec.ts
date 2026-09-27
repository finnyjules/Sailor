import { describe, expect, it, vi } from 'vitest'
import { parseCharacterRecord } from '~~/server/utils/characterRegistry'
import { FaceCheckError } from '~~/server/utils/faceCheck/rekognition'
import { applyOutcome, MAX_COMPARES_PER_CALL, runChecks } from '~~/server/utils/faceCheck/run'

const rec = (photos: string[], face = 'face.png') => parseCharacterRecord(JSON.stringify({
  name: 'R', face: { filename: face, approvedAt: 't' }, photos: photos.map(f => ({ filename: f })),
  states: [{ id: 'default', label: 'D', refImages: [] }],
}), 'r')!

describe('runChecks', () => {
  it('compares each planned picture once against a face prepared once', async () => {
    const readImage = vi.fn(async (f: string) => Buffer.from(f))
    const compare = vi.fn(async (_s: Buffer, t: Buffer) => (t.toString() === 'a.png' ? 96 : 40))
    const { record, compared, skipped } = await runChecks(rec(['face.png', 'a.png', 'b.png']), { readImage, compare, now: () => 'now' })
    expect(compared).toBe(2)
    expect(skipped).toBe(0)
    expect(readImage.mock.calls.filter(c => c[0] === 'face.png')).toHaveLength(1)
    expect(record.photos.map(p => p.check?.verdict)).toEqual(['match', 'match', 'different'])
  })
  it('caps a call and reports what is left', async () => {
    const photos = Array.from({ length: MAX_COMPARES_PER_CALL + 5 }, (_, i) => `p${i}.png`)
    const out = await runChecks(rec(photos), { readImage: async f => Buffer.from(f), compare: async () => 95, now: () => 'n' })
    expect(out.compared).toBe(MAX_COMPARES_PER_CALL)
    expect(out.skipped).toBe(5)
  })
  it('skips missing files quietly', async () => {
    const out = await runChecks(rec(['gone.png']), { readImage: async f => (f === 'gone.png' ? null : Buffer.from(f)), compare: async () => 99, now: () => 'n' })
    expect(out.compared).toBe(0)
    expect(out.record.photos.find(p => p.filename === 'gone.png')!.check).toBeNull()
  })
  it('marks every target no-face when the approved face has no detectable face', async () => {
    const compare = vi.fn(async () => { throw new FaceCheckError('no-source-face', 'x') })
    const out = await runChecks(rec(['a.png', 'b.png']), { readImage: async f => Buffer.from(f), compare, now: () => 'n' })
    expect(compare).toHaveBeenCalledTimes(1)
    expect(out.record.photos.filter(p => p.filename !== 'face.png').every(p => p.check?.verdict === 'no-face' && p.check.note)).toBe(true)
  })
  it('passes a verdict from the checker straight through', async () => {
    const out = await runChecks(rec(['a.png']), { readImage: async f => Buffer.from(f), compare: async () => ({ verdict: 'different', note: 'different hair colour' }), now: () => 'n' })
    expect(out.record.photos.find(p => p.filename === 'a.png')!.check).toEqual({ verdict: 'different', against: 'face.png', at: 'n', note: 'different hair colour' })
  })

  it('applyOutcome applies onto a different record and ignores targets no longer present', async () => {
    const original = rec(['a.png', 'b.png'])
    const { outcome } = await runChecks(original, { readImage: async f => Buffer.from(f), compare: async () => 95, now: () => 'n' })
    // A record that changed meanwhile: 'b.png' removed, an extra look added.
    const fresh = parseCharacterRecord(JSON.stringify({
      name: 'R', face: { filename: 'face.png', approvedAt: 't' },
      photos: [{ filename: 'a.png' }],
      states: [
        { id: 'default', label: 'D', refImages: [] },
        { id: 'second', label: 'Second', refImages: [] },
      ],
    }), 'r')!
    const applied = applyOutcome(fresh, outcome)
    expect(applied.photos.find(p => p.filename === 'a.png')!.check?.verdict).toBe('match')
    expect(applied.states.find(s => s.id === 'second')).toBeTruthy()
    expect(applied.photos.find(p => p.filename === 'b.png')).toBeUndefined()
  })

  it('stops early on a plain error mid-pass, keeps partial results, and does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const compare = vi.fn(async (_s: Buffer, t: Buffer) => {
      if (t.toString() === 'b.png') throw new Error('boom')
      return 95
    })
    const out = await runChecks(rec(['a.png', 'b.png', 'c.png']), { readImage: async f => Buffer.from(f), compare, now: () => 'n' })
    expect(out.failed).toBe(true)
    expect(out.compared).toBe(1)
    expect(out.record.photos.find(p => p.filename === 'a.png')!.check?.verdict).toBe('match')
    expect(out.record.photos.find(p => p.filename === 'b.png')!.check).toBeNull()
    expect(out.record.photos.find(p => p.filename === 'c.png')!.check).toBeNull()
    warn.mockRestore()
  })
})
