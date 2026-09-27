import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { compareFaces, FaceCheckError, prepareForCompare, type CompareClient } from '~~/server/utils/faceCheck/rekognition'

async function png(w: number, h: number) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 10, b: 10 } } }).png().toBuffer()
}

describe('prepareForCompare', () => {
  it('pads 40% of the longer side on every edge and encodes JPEG', async () => {
    const out = await prepareForCompare(await png(100, 50))
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(100 + 2 * 40)
    expect(meta.height).toBe(50 + 2 * 40)
  })
  it('shrinks large images to fit 1600 before padding', async () => {
    const meta = await sharp(await prepareForCompare(await png(4000, 2000))).metadata()
    expect(meta.width).toBe(1600 + 2 * 640)
  })
})

function fakeClient(out: unknown | Error): CompareClient {
  return { send: async () => { if (out instanceof Error) throw out; return out as any } }
}

describe('compareFaces', () => {
  const b = Buffer.from('x')
  it('returns the best match similarity', async () => {
    const c = fakeClient({ FaceMatches: [{ Similarity: 71.2 }, { Similarity: 98.4 }], UnmatchedFaces: [] })
    expect(await compareFaces(c, b, b)).toBe(98.4)
  })
  it('returns 0 when the target has faces but none match', async () => {
    expect(await compareFaces(fakeClient({ FaceMatches: [], UnmatchedFaces: [{}] }), b, b)).toBe(0)
  })
  it('returns null when the target has no face', async () => {
    expect(await compareFaces(fakeClient({ FaceMatches: [], UnmatchedFaces: [] }), b, b)).toBeNull()
  })
  it('turns AWS "no face in source" into a FaceCheckError', async () => {
    const e = Object.assign(new Error('Request has invalid parameters'), { name: 'InvalidParameterException' })
    await expect(compareFaces(fakeClient(e), b, b)).rejects.toMatchObject({ code: 'no-source-face' })
  })
  it('wraps other AWS failures', async () => {
    await expect(compareFaces(fakeClient(new Error('boom')), b, b)).rejects.toBeInstanceOf(FaceCheckError)
  })
})
