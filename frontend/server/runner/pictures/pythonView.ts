/**
 * A picture file as a Python loader's tensor holds it (R0, step 3 spec):
 * ImageOps.exif_transpose, first frame, .convert("RGB") — the loaders of
 * LoadImage's IMAGE, 3D Studio's bakes and Text on path. Returned as the PNG
 * `_image_tensor_to_data_url` would send (8-bit RGB), or `png: null` when the
 * file already is exactly that picture (then it is handed on untouched).
 * PIL ignores embedded ICC profiles; so does this. 16-bit, 32-bit and CMYK
 * files are refused, and so are files sharp cannot read (BMP, ICO, TGA, PSD…): PIL's conversion of those is its own, and not ported. So is a GIF
 * whose first frame has a see-through colour or does not fill the picture:
 * PIL fills those pixels with a palette colour, sharp with transparent black.
 */
import sharp, { type Metadata } from 'sharp'
import { MAX_INPUT_PIXELS } from '../compositor/decode'

export const PICTURE_16_BIT = 'This picture is 16-bit. Save it as an 8-bit picture and load it again.'
export const PICTURE_CMYK = 'This picture is CMYK. Save it as RGB and load it again.'
export const PICTURE_GIF_SEE_THROUGH = 'This GIF has see-through parts. Save it as a PNG and load it again.'
export const PICTURE_32_BIT = 'This picture is 32-bit. Save it as an 8-bit picture and load it again.'
export const PICTURE_UNREADABLE = 'This kind of picture file can’t be read here. Save it as a PNG or JPEG and load it again.'
export const PICTURE_ANIMATED = 'This picture is animated, and saving here takes single pictures only. Save it as a PNG and load it again.'

/**
 * Whether Python's loaders would make a batch of several frames of this file
 * (GIF, animated WebP, multi-page TIFF, APNG): Save image saves each (R1.5).
 */
export function pictureHasFrames(meta: Metadata, bytes: Uint8Array): boolean {
  return (meta.pages ?? 1) > 1 || !!pngChunksBeforePixels(bytes)?.includes('acTL')
}

/** sharp's metadata, with a file it cannot read (BMP, ICO, TGA, PSD…) refused in plain words. */
export async function pictureMeta(bytes: Uint8Array): Promise<Metadata> {
  try { return await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata() }
  catch { throw new Error(PICTURE_UNREADABLE) }
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** A PNG's chunk types before its pixels (IHDR … up to IDAT), or null when the bytes are not a PNG. */
export function pngChunksBeforePixels(b: Uint8Array): string[] | null {
  if (b.length < 8 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const types: string[] = []
  for (let o = 8; o + 8 <= b.length;) {
    const type = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!)
    if (type === 'IDAT' || type === 'IEND') break
    types.push(type)
    o += 12 + view.getUint32(o)
  }
  return types
}

/** A PNG's IHDR colour type (0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA), or null when the bytes are not a PNG. */
export function pngColourType(b: Uint8Array): number | null {
  const chunks = pngChunksBeforePixels(b)
  return chunks?.[0] === 'IHDR' && b.length > 25 ? b[25]! : null
}

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

/**
 * Why a picture is refused (one of the PICTURE_* words), from its header, or
 * null: the one rule for rgbTurnedPng, the Text mask's convert("L") and the
 * check at the start of a run (R1.3 follow-up).
 */
export function pictureRefusalOf(meta: Metadata, bytes: Uint8Array): string | null {
  if (meta.depth === 'ushort' || meta.depth === 'short') return PICTURE_16_BIT
  // LoadImage divides 32-bit integer pictures by 255 before converting (nodes.py); not ported.
  if (meta.depth && meta.depth !== 'uchar') return meta.depth === 'char' ? PICTURE_UNREADABLE : PICTURE_32_BIT
  if (meta.space === 'cmyk') return PICTURE_CMYK
  if (meta.format === 'gif' && gifFirstFrameSeeThrough(bytes)) return PICTURE_GIF_SEE_THROUGH
  return null
}

/** pictureRefusalOf for a file's bytes; a file sharp cannot read is PICTURE_UNREADABLE. */
export async function pictureRefusal(bytes: Uint8Array): Promise<string | null> {
  try { return pictureRefusalOf(await pictureMeta(bytes), bytes) }
  catch (e) { return e instanceof Error ? e.message : PICTURE_UNREADABLE }
}

export async function rgbTurnedPng(bytes: Uint8Array): Promise<{ png: Uint8Array | null; w: number; h: number }> {
  const meta = await pictureMeta(bytes)
  const refused = pictureRefusalOf(meta, bytes)
  if (refused) throw new Error(refused)
  const turned = (meta.orientation ?? 1) >= 5
  const w = turned ? meta.height! : meta.width!
  const h = turned ? meta.width! : meta.height!
  // Exactly Python's picture: 8-bit RGB, one frame (no APNG acTL), not turned, no ICC profile (the data URL carries none).
  const already = meta.format === 'png' && meta.channels === 3 && !meta.hasAlpha
    && (meta.orientation ?? 1) === 1 && (meta.pages ?? 1) === 1 && meta.space === 'srgb'
    && !meta.hasProfile && !pngChunksBeforePixels(bytes)?.includes('acTL')
  if (already) return { png: null, w, h }
  const png = await sharp(bytes, { pages: 1, page: 0, autoOrient: true, ignoreIcc: true, limitInputPixels: MAX_INPUT_PIXELS })
    .toColourspace('srgb').removeAlpha().png({ compressionLevel: 6 }).toBuffer()
  return { png: new Uint8Array(png), w, h }
}

/**
 * A provider's picture as a Python paid node that drops alpha saves it (R3
 * rule 3): bytesio_to_image_tensor reads it with PIL's .convert("RGBA") (no
 * EXIF turn, no ICC conversion), `/ 255.0` in float32, `tensor[..., :3]`, and
 * save_generation_output writes `np.clip(255.0 * x, 0, 255).astype(np.uint8)`,
 * i.e. trunc(f32(255·f32(v/255))) of each 8-bit value v (R1.5's rule; for
 * every 8-bit v it is v again). The result is that RGB picture as a PNG.
 */
export async function answerRgbPng(bytes: Uint8Array): Promise<Uint8Array> {
  const { data, info } = await sharp(bytes, { pages: 1, page: 0, ignoreIcc: true, limitInputPixels: MAX_INPUT_PIXELS })
    .toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  const n = info.width * info.height
  const rgb = new Uint8Array(n * 3)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const x = Math.fround(data[i * info.channels + c]! / 255)
      rgb[i * 3 + c] = Math.min(255, Math.max(0, Math.trunc(Math.fround(255 * x))))
    }
  }
  const png = await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer()
  return new Uint8Array(png)
}

/**
 * A provider's picture as a Python node that keeps alpha saves it into a
 * file of its own (R3.6: Layerize an image's layers, `save_image_to_input`):
 * PIL's .convert("RGBA") (no EXIF turn, no ICC conversion), `/ 255.0` in
 * float32, then `np.clip(255.0 * x, 0, 255).astype(np.uint8)` — R1.5's
 * truncation, which gives every 8-bit value back — written as an RGBA PNG.
 */
export async function answerRgbaPng(bytes: Uint8Array): Promise<Uint8Array> {
  const { data, info } = await sharp(bytes, { pages: 1, page: 0, ignoreIcc: true, limitInputPixels: MAX_INPUT_PIXELS })
    .toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  const n = info.width * info.height
  const rgba = new Uint8Array(n * 4)
  for (let i = 0; i < n * 4; i++) {
    const x = Math.fround(data[i]! / 255)
    rgba[i] = Math.min(255, Math.max(0, Math.trunc(Math.fround(255 * x))))
  }
  const png = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 6 }).toBuffer()
  return new Uint8Array(png)
}
