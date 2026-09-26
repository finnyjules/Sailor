/**
 * R0.7: masks as the runner keeps them, LoadImage's MASK, and a picture as a
 * Python loader sees it — against scripts/runner_values_fixtures.py.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { decodeMask, encodeMask, loadImageMask, type Mask } from '~~/server/runner/pictures/mask'
import { PICTURE_16_BIT, PICTURE_32_BIT, PICTURE_CMYK, PICTURE_GIF_SEE_THROUGH, PICTURE_UNREADABLE, rgbTurnedPng } from '~~/server/runner/pictures/pythonView'

const FIX = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-values.json'), 'utf8'))
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const u16 = (s: string) => { const b = Buffer.from(s, 'base64'); return new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2) }

describe('encodeMask / decodeMask', () => {
  it('keeps a mask as 16-bit round(v·65535) and reads it back', async () => {
    const m: Mask = { w: 3, h: 2, data: Float32Array.from([0, 0.25, 0.5, 0.75, 1, 1 / 3]) }
    const png = await encodeMask(m)
    const meta = await sharp(png).metadata()
    expect([meta.width, meta.height, meta.channels, meta.depth]).toEqual([3, 2, 1, 'ushort'])
    const back = await decodeMask(png)
    expect(back.w).toBe(3)
    expect([...back.data].map(v => Math.round(v * 65535))).toEqual([0, 16384, 32768, 49151, 65535, 21845])
  })
})

describe('loadImageMask', () => {
  for (const c of FIX.load_mask as { name: string; file: string; w: number; h: number; mask16: string }[]) {
    it(`matches LoadImage's MASK for ${c.name}`, async () => {
      const m = await loadImageMask(b64(c.file))
      expect([m.w, m.h]).toEqual([c.w, c.h])
      expect([...m.data].map(v => Math.round(v * 65535))).toEqual([...u16(c.mask16)])
    })
  }
})

describe('rgbTurnedPng', () => {
  for (const c of FIX.rgb_turned as { name: string; file: string; w: number; h: number; rgb8: string; unchanged: boolean }[]) {
    it(`gives Python's RGB picture for ${c.name}`, async () => {
      const r = await rgbTurnedPng(b64(c.file))
      expect(r.png === null).toBe(c.unchanged)
      const png = r.png ?? b64(c.file)
      const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      expect([info.width, info.height, info.channels]).toEqual([c.w, c.h, 3])
      expect(Buffer.compare(data, Buffer.from(c.rgb8, 'base64'))).toBe(0)
    })
  }
  it('refuses a 16-bit picture and a CMYK picture in plain words', async () => {
    const [sixteen, cmyk] = FIX.refused as { file: string }[]
    await expect(rgbTurnedPng(b64(sixteen!.file))).rejects.toThrow(PICTURE_16_BIT)
    await expect(rgbTurnedPng(b64(cmyk!.file))).rejects.toThrow(PICTURE_CMYK)
  })
  it('refuses a GIF with a see-through colour (PIL fills it with a palette colour, sharp with transparent black)', async () => {
    const gif = (FIX.refused as { name: string; file: string }[]).find(c => c.name === 'a GIF with a transparent colour')
    await expect(rgbTurnedPng(b64(gif!.file))).rejects.toThrow(PICTURE_GIF_SEE_THROUGH)
  })
  it('refuses a file sharp cannot read, and 32-bit integer and float pictures, in plain words', async () => {
    const byName = (n: string) => b64((FIX.refused as { name: string; file: string }[]).find(c => c.name === n)!.file)
    await expect(rgbTurnedPng(byName('a BMP'))).rejects.toThrow(PICTURE_UNREADABLE)
    await expect(loadImageMask(byName('a BMP'))).rejects.toThrow(PICTURE_UNREADABLE)
    await expect(rgbTurnedPng(byName('a 32-bit integer TIFF'))).rejects.toThrow(PICTURE_32_BIT)
    await expect(rgbTurnedPng(byName('a 32-bit float TIFF'))).rejects.toThrow(PICTURE_32_BIT)
  })
})
