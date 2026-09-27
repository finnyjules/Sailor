import { describe, expect, it, vi } from 'vitest'
import { FaceCheckError } from '~~/server/utils/faceCheck/rekognition'
import { readTakeFrames, scoreTake } from '~~/server/utils/faceCheck/take'

const b = (s: string) => Buffer.from(s)

describe('scoreTake', () => {
  it('scores each frame against the face, best is the highest non-null score, verdict from the best', async () => {
    const compare = vi.fn(async (_s: Buffer, t: Buffer) => {
      if (t.toString() === 'f1') return 96
      if (t.toString() === 'f2') throw new FaceCheckError('no-face-either', 'x')
      return 91
    })
    const out = await scoreTake([b('f1'), b('f2'), b('f3')], b('face'), compare)
    expect(out.scores).toEqual([96, null, 91])
    expect(out.best).toBe(96)
    expect(out.verdict).toBe('match')
    expect(compare).toHaveBeenCalledTimes(3)
  })

  it('is no-face when every frame scores null', async () => {
    const compare = vi.fn(async () => { throw new FaceCheckError('no-face-either', 'x') })
    const out = await scoreTake([b('f1'), b('f2')], b('face'), compare)
    expect(out.scores).toEqual([null, null])
    expect(out.best).toBeNull()
    expect(out.verdict).toBe('no-face')
  })

  it('is unsure at 70, between the calibrated thresholds', async () => {
    const compare = vi.fn(async () => 70)
    const out = await scoreTake([b('f1')], b('face'), compare)
    expect(out.best).toBe(70)
    expect(out.verdict).toBe('unsure')
  })

  it('rethrows any error other than no-face-either', async () => {
    const compare = vi.fn(async () => { throw new FaceCheckError('aws', 'boom') })
    await expect(scoreTake([b('f1')], b('face'), compare)).rejects.toMatchObject({ code: 'aws' })
  })

  it('rethrows a plain error too', async () => {
    const compare = vi.fn(async () => { throw new Error('boom') })
    await expect(scoreTake([b('f1')], b('face'), compare)).rejects.toThrow('boom')
  })

  it('vision verdicts: best is null, verdict is the best across frames (match > unsure > different > no-face), note is the winner\'s', async () => {
    const compare = vi.fn(async (_s: Buffer, t: Buffer) => {
      if (t.toString() === 'f1') return { verdict: 'different' as const, note: 'different hair' }
      if (t.toString() === 'f2') return { verdict: 'match' as const, note: 'same character' }
      return { verdict: 'unsure' as const, note: 'unclear angle' }
    })
    const out = await scoreTake([b('f1'), b('f2'), b('f3')], b('face'), compare)
    expect(out.best).toBeNull()
    expect(out.verdict).toBe('match')
    expect(out.note).toBe('same character')
  })

  it('vision verdicts: no-face on every frame gives no-face overall', async () => {
    const compare = vi.fn(async () => ({ verdict: 'no-face' as const }))
    const out = await scoreTake([b('f1'), b('f2')], b('face'), compare)
    expect(out.best).toBeNull()
    expect(out.verdict).toBe('no-face')
    expect(out.note).toBeUndefined()
  })
})

describe('readTakeFrames', () => {
  const url = (bytes: number) => `data:image/jpeg;base64,${Buffer.alloc(bytes, 1).toString('base64')}`

  it('accepts 1 to 3 JPEG data URLs and decodes them', () => {
    const out = readTakeFrames({ frames: [url(10), url(20)] })
    expect(Array.isArray(out)).toBe(true)
    expect((out as Buffer[]).map(b => b.length)).toEqual([10, 20])
  })

  it('rejects zero frames', () => {
    expect(readTakeFrames({ frames: [] })).toBe('Send one to three pictures from the take.')
  })

  it('rejects more than 3 frames', () => {
    expect(readTakeFrames({ frames: [url(1), url(1), url(1), url(1)] })).toBe('Send one to three pictures from the take.')
  })

  it('rejects a non-JPEG data URL', () => {
    const bad = `data:image/png;base64,${Buffer.from('x').toString('base64')}`
    expect(readTakeFrames({ frames: [bad] })).toBe('Send one to three pictures from the take.')
  })

  it('rejects a frame over 2 MB decoded', () => {
    expect(readTakeFrames({ frames: [url(2 * 1024 * 1024 + 1)] })).toBe('Send one to three pictures from the take.')
  })

  it('rejects a missing or malformed body', () => {
    expect(readTakeFrames({})).toBe('Send one to three pictures from the take.')
    expect(readTakeFrames({ frames: 'nope' })).toBe('Send one to three pictures from the take.')
    expect(readTakeFrames({ frames: [123] })).toBe('Send one to three pictures from the take.')
  })
})
