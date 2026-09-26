/**
 * A picture file as a Python loader's tensor holds it (R0, step 3 spec):
 * ImageOps.exif_transpose, first frame, .convert("RGB") — the loaders of
 * LoadImage's IMAGE, 3D Studio's bakes and Text on path. Returned as the PNG
 * `_image_tensor_to_data_url` would send (8-bit RGB), or `png: null` when the
 * file already is exactly that picture (then it is handed on untouched).
 * PIL ignores embedded ICC profiles; so does this. 16-bit and CMYK files are
 * refused: PIL's conversion of those is its own, and not ported. So is a GIF
 * whose first frame has a see-through colour or does not fill the picture:
 * PIL fills those pixels with a palette colour, sharp with transparent black.
 */
import sharp from 'sharp'
import { MAX_INPUT_PIXELS } from '../compositor/decode'

export const PICTURE_16_BIT = 'This picture is 16-bit. Save it as an 8-bit picture and load it again.'
export const PICTURE_CMYK = 'This picture is CMYK. Save it as RGB and load it again.'
export const PICTURE_GIF_SEE_THROUGH = 'This GIF has see-through parts. Save it as a PNG and load it again.'

/**
 * Whether a GIF's first frame has a transparent colour (its Graphic Control
 * Extension) or covers less than the whole picture. Unreadable → true (refused).
 */
export function gifFirstFrameSeeThrough(b: Uint8Array): boolean {
  if (b.length < 13) return true
  const screenW = b[6]! | (b[7]! << 8)
  const screenH = b[8]! | (b[9]! << 8)
  let o = 13 + (b[10]! & 0x80 ? 3 * (2 << (b[10]! & 7)) : 0)
  let transparent = false
  while (o < b.length) {
    const intro = b[o]!
    if (intro === 0x2C) { // image descriptor: the first frame
      if (o + 9 >= b.length) return true
      const [x, y] = [b[o + 1]! | (b[o + 2]! << 8), b[o + 3]! | (b[o + 4]! << 8)]
      const [w, h] = [b[o + 5]! | (b[o + 6]! << 8), b[o + 7]! | (b[o + 8]! << 8)]
      return transparent || x !== 0 || y !== 0 || w !== screenW || h !== screenH
    }
    if (intro !== 0x21 || o + 2 >= b.length) return true
    if (b[o + 1] === 0xF9 && b[o + 2] === 4) transparent = (b[o + 3]! & 1) === 1
    o += 2 // extension introducer and label, then sub-blocks up to a zero length
    while (o < b.length && b[o] !== 0) o += 1 + b[o]!
    o += 1
  }
  return true
}

export async function rgbTurnedPng(bytes: Uint8Array): Promise<{ png: Uint8Array | null; w: number; h: number }> {
  const meta = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
  if (meta.depth === 'ushort') throw new Error(PICTURE_16_BIT)
  if (meta.space === 'cmyk') throw new Error(PICTURE_CMYK)
  if (meta.format === 'gif' && gifFirstFrameSeeThrough(bytes)) throw new Error(PICTURE_GIF_SEE_THROUGH)
  const turned = (meta.orientation ?? 1) >= 5
  const w = turned ? meta.height! : meta.width!
  const h = turned ? meta.width! : meta.height!
  const already = meta.format === 'png' && meta.channels === 3 && !meta.hasAlpha
    && (meta.orientation ?? 1) === 1 && (meta.pages ?? 1) === 1 && meta.space === 'srgb'
  if (already) return { png: null, w, h }
  const png = await sharp(bytes, { pages: 1, page: 0, autoOrient: true, ignoreIcc: true, limitInputPixels: MAX_INPUT_PIXELS })
    .toColourspace('srgb').removeAlpha().png({ compressionLevel: 6 }).toBuffer()
  return { png: new Uint8Array(png), w, h }
}
