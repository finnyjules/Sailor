import { describe, expect, it } from 'vitest'
import { dataUrlBytes, MAX_IMAGE_BYTES, lumaAspect } from '../../server/utils/frameAnimate'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngDataUrl(payloadLength = 16): string {
  const bytes = Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.alloc(payloadLength, 1)])
  return `data:image/png;base64,${bytes.toString('base64')}`
}

describe('dataUrlBytes', () => {
  it('rejects a non-PNG data URL with a 400', () => {
    const url = `data:image/jpeg;base64,${Buffer.from('not a png').toString('base64')}`
    expect(() => dataUrlBytes(url)).toThrow(expect.objectContaining({ statusCode: 400 }))
  })

  it('rejects PNG-typed data that lacks the real PNG magic bytes with a 400', () => {
    const url = `data:image/png;base64,${Buffer.from('totally not a png').toString('base64')}`
    expect(() => dataUrlBytes(url)).toThrow(expect.objectContaining({ statusCode: 400 }))
  })

  it('returns a Buffer for a well-formed PNG data URL', () => {
    const buf = dataUrlBytes(pngDataUrl())
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(Array.from(buf.subarray(0, 8))).toEqual(PNG_MAGIC)
  })

  it('rejects a decoded buffer over the 12 MB cap with a 413', () => {
    const url = pngDataUrl(MAX_IMAGE_BYTES + 1)
    expect(() => dataUrlBytes(url)).toThrow(expect.objectContaining({ statusCode: 413 }))
  })
})

describe('lumaAspect', () => {
  it('picks the closest Luma aspect ratio to the still', () => {
    expect(lumaAspect(1024, 1024)).toBe('1:1')
    expect(lumaAspect(1920, 1080)).toBe('16:9')
    expect(lumaAspect(1080, 1920)).toBe('9:16')
  })
})
