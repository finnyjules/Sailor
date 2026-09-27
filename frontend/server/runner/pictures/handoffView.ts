/**
 * The picture a paid node hands a provider when it comes from a loader
 * (step 3, R3.H): what `_image_tensor_to_data_url` (nodes_replicate.py:194,
 * the one encoder every paid node the runner takes uses for an IMAGE input)
 * makes of the loader's tensor — a PNG of the first frame, 8-bit, with as
 * many channels as the tensor, and no chunk but IHDR, IDAT and IEND.
 *
 * The tensor is the loader's:
 *  - LoadImage (nodes.py): `ImageOps.exif_transpose`, then `.convert("RGB")`;
 *  - the Image card's own file (comfy_extras/nodes_image.py `_load_from_disk`
 *    and `process`): the same RGB, but when the file has an alpha band (or a
 *    palette with transparency: PIL's rule, ./mask.ts hasAlphaAsPil) and any
 *    pixel's alpha is below 255, the card hands on RGBA: that RGB plus the
 *    alpha, turned with the picture.
 *
 * PIL's conversions are ported where sharp's differ (./pythonView.ts pilRaw,
 * ../pixels/pilPixels.ts): a CMYK JPEG (Pillow's naive cmyk2rgb) and 16-bit
 * grey (clipped to 255), per pixel on the Frame's worker when a worker is
 * given; they are then turned by the EXIF orientation (lossless). Every other
 * 8-bit or 16-bit colour file is sharp's decode (the high byte of a 16-bit
 * sample, as PIL's rawmode keeps it), turned by sharp's autoOrient.
 *
 * The PNG is sharp's with every chunk but IHDR, IDAT and IEND taken out
 * (sharp writes pHYs; PIL writes none). PIL's zlib and filter choices are
 * not ported, so the bytes differ from Python's; the decoded pixels, the
 * size and the colour type (RGB or RGBA, 8-bit) are Python's exactly
 * (fixtures/runner-paid-handoff.json).
 *
 * Refused, in plain words (./pythonView.ts's): 32-bit and signed files, a
 * CMYK file that isn't a JPEG or has alpha, 16-bit grey with alpha, a GIF
 * whose first frame has see-through parts, a file sharp can't read, and (the
 * Image card only) an animated file with alpha, whose RGB-or-RGBA choice
 * Python makes over every frame.
 */
import sharp, { type Metadata } from 'sharp'
import { MAX_INPUT_PIXELS } from '../compositor/decode'
import { pilPixels, type PilRaw } from '../pixels/pilPixels'
import { hasAlphaAsPil } from './mask'
import {
  PICTURE_16_BIT, PICTURE_32_BIT, PICTURE_CMYK, PICTURE_GIF_SEE_THROUGH, PICTURE_UNREADABLE,
  gifFirstFrameSeeThrough, pictureHasFrames, pictureMeta, pilRaw,
} from './pythonView'

export const PICTURE_ANIMATED_SEE_THROUGH = 'This picture is animated and has see-through parts. Save it as a PNG and load it again.'

/** How a loader hands its picture on: the Image card keeps a file's alpha, LoadImage never does. */
export interface LoaderKind { keepsAlpha: boolean }

/** What is handed off: `png` null when the file itself already is that PNG (it is sent untouched). */
export interface HandoffView { png: Uint8Array | null; w: number; h: number; channels: 3 | 4 }

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** Every chunk of a PNG as [type, offset, total length], or null when the bytes are not a well-formed PNG. */
function pngChunks(b: Uint8Array): Array<[string, number, number]> | null {
  if (b.length < 8 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out: Array<[string, number, number]> = []
  for (let o = 8; o < b.length;) {
    if (o + 12 > b.length) return null
    const len = view.getUint32(o)
    if (o + 12 + len > b.length) return null
    out.push([String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!), o, 12 + len])
    o += 12 + len
  }
  return out
}

const PLAIN_CHUNKS = new Set(['IHDR', 'IDAT', 'IEND'])

/** A PNG with every chunk but IHDR, IDAT and IEND taken out (each chunk carries its own CRC). */
export function plainPngChunks(png: Uint8Array): Uint8Array {
  const chunks = pngChunks(png)
  if (!chunks) throw new Error(PICTURE_UNREADABLE)
  const kept = chunks.filter(([t]) => PLAIN_CHUNKS.has(t))
  const out = new Uint8Array(8 + kept.reduce((n, [, , len]) => n + len, 0))
  out.set(png.subarray(0, 8))
  let o = 8
  for (const [, at, len] of kept) { out.set(png.subarray(at, at + len), o); o += len }
  return out
}

/**
 * Whether the bytes already are the PNG Python would send for this many
 * channels: 8-bit RGB (colour type 2) or RGBA (6), not interlaced, and no
 * chunk but IHDR, IDAT and IEND (so no EXIF turn, no ICC profile, no tRNS, no
 * animation, no text).
 */
function isPlainPng(b: Uint8Array, colourType: 2 | 6): boolean {
  const chunks = pngChunks(b)
  if (!chunks || chunks[0]?.[0] !== 'IHDR' || chunks.at(-1)?.[0] !== 'IEND') return false
  if (!chunks.every(([t]) => PLAIN_CHUNKS.has(t))) return false
  return b[24] === 8 && b[25] === colourType && b[28] === 0
}

/** The raw kinds PIL converts its own way (./pythonView.ts pilRaw), read here as PIL reads them. */
function pilOwnKind(meta: Metadata): 'cmyk' | 'grey16' | null {
  if (meta.space === 'cmyk' && meta.channels === 4) return 'cmyk'
  if (meta.depth === 'ushort' && meta.channels === 1 && !meta.hasAlpha) return 'grey16'
  return null
}

/** Why this file can't be handed off as the loader's tensor (a PICTURE_* sentence), or null. */
export function handoffRefusalOf(meta: Metadata, bytes: Uint8Array, kind: LoaderKind): string | null {
  if (meta.depth && meta.depth !== 'uchar' && meta.depth !== 'ushort') {
    return meta.depth === 'short' || meta.depth === 'char' ? PICTURE_UNREADABLE : PICTURE_32_BIT
  }
  if (meta.space === 'cmyk' && (meta.format !== 'jpeg' || meta.channels !== 4)) return PICTURE_CMYK
  // 16-bit grey with alpha (PIL's LA from I;16 with a band): not ported.
  if (meta.depth === 'ushort' && (meta.channels ?? 0) <= 2 && meta.hasAlpha) return PICTURE_16_BIT
  if (meta.format === 'gif' && gifFirstFrameSeeThrough(bytes)) return PICTURE_GIF_SEE_THROUGH
  if (kind.keepsAlpha && pictureHasFrames(meta, bytes) && hasAlphaAsPil(bytes, meta.hasAlpha, meta.format)) return PICTURE_ANIMATED_SEE_THROUGH
  return null
}

/** handoffRefusalOf for a file's bytes; a file sharp cannot read is PICTURE_UNREADABLE. */
export async function handoffRefusal(bytes: Uint8Array, kind: LoaderKind): Promise<string | null> {
  try { return handoffRefusalOf(await pictureMeta(bytes), bytes, kind) }
  catch (e) { return e instanceof Error ? e.message : PICTURE_UNREADABLE }
}

/**
 * The EXIF orientation as sharp operations on raw pixels: flip / flop first,
 * then the turn (sharp applies them in that order), as PIL's exif_transpose
 * (2 FLIP_LEFT_RIGHT, 3 ROTATE_180, 4 FLIP_TOP_BOTTOM, 5 TRANSPOSE,
 * 6 ROTATE_270, 7 TRANSVERSE, 8 ROTATE_90).
 */
export function orientOps(orientation: number): { flop: boolean; flip: boolean; rotate: 0 | 90 | 180 | 270 } {
  switch (orientation) {
    case 2: return { flop: true, flip: false, rotate: 0 }
    case 3: return { flop: false, flip: false, rotate: 180 }
    case 4: return { flop: false, flip: true, rotate: 0 }
    case 5: return { flop: true, flip: false, rotate: 270 }
    case 6: return { flop: false, flip: false, rotate: 90 }
    case 7: return { flop: true, flip: false, rotate: 90 }
    case 8: return { flop: false, flip: false, rotate: 270 }
    default: return { flop: false, flip: false, rotate: 0 }
  }
}

/** Raw 8-bit pixels (w × h, `channels` a pixel) as the PNG Python sends, turned by `orientation`. */
async function encodePlain(px: Uint8Array, w: number, h: number, channels: 3 | 4, orientation = 1): Promise<Uint8Array> {
  const o = orientOps(orientation)
  let s = sharp(px, { raw: { width: w, height: h, channels } })
  if (o.flop) s = s.flop()
  if (o.flip) s = s.flip()
  if (o.rotate) s = s.rotate(o.rotate)
  const png = await s.png({ compressionLevel: 6 }).toBuffer()
  return plainPngChunks(new Uint8Array(png.buffer, png.byteOffset, png.byteLength))
}

/**
 * The PNG `_image_tensor_to_data_url` would send for a loader's tensor of
 * `bytes` (see the head of this file). `rgbOf`: PIL's per-pixel conversion of
 * a CMYK or 16-bit grey file, on the Frame's worker (absent: in this thread).
 */
export async function handoffView(
  bytes: Uint8Array,
  kind: LoaderKind,
  rgbOf?: (raw: PilRaw) => Promise<Uint8Array>,
): Promise<HandoffView> {
  const meta = await pictureMeta(bytes)
  const refused = handoffRefusalOf(meta, bytes, kind)
  if (refused) throw new Error(refused)
  const orientation = meta.orientation ?? 1
  const turned = orientation >= 5
  const w = turned ? meta.height! : meta.width!
  const h = turned ? meta.width! : meta.height!
  if (pilOwnKind(meta)) {
    const raw = await pilRaw(bytes)
    const rgb = rgbOf ? await rgbOf(raw) : pilPixels.rgbOf(raw)
    return { png: await encodePlain(rgb, raw.width, raw.height, 3, orientation), w, h, channels: 3 }
  }
  const open = () => sharp(bytes, { pages: 1, page: 0, autoOrient: true, ignoreIcc: true, limitInputPixels: MAX_INPUT_PIXELS })
  // The Image card's RGBA: an alpha band as PIL sees one, with some pixel below 255.
  if (kind.keepsAlpha && hasAlphaAsPil(bytes, meta.hasAlpha, meta.format)) {
    if (isPlainPng(bytes, 6) && await alphaBelowFull(bytes)) return { png: null, w, h, channels: 4 }
    const { data, info } = await open().toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
    if (info.channels !== 4) throw new Error(PICTURE_UNREADABLE)
    const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const raw = { raw: { width: info.width, height: info.height, channels: 4 as const } }
    // (sharp's statistics of the 8-bit samples: native, not a loop here.)
    const min = (await sharp(rgba, raw).stats()).channels[3]!.min
    if (min < 255) return { png: await encodePlain(rgba, info.width, info.height, 4), w: info.width, h: info.height, channels: 4 }
    const rgb = await sharp(rgba, raw).removeAlpha().raw().toBuffer()
    return { png: await encodePlain(new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.byteLength), info.width, info.height, 3), w: info.width, h: info.height, channels: 3 }
  }
  if (isPlainPng(bytes, 2)) return { png: null, w, h, channels: 3 }
  const { data, info } = await open().toColourspace('srgb').removeAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  if (info.channels !== 3) throw new Error(PICTURE_UNREADABLE)
  const png = await encodePlain(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, 3)
  return { png, w: info.width, h: info.height, channels: 3 }
}

/** Whether a plain 8-bit RGBA PNG has a pixel whose alpha is below 255. */
async function alphaBelowFull(png: Uint8Array): Promise<boolean> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  return info.channels === 4 && (await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).stats()).channels[3]!.min < 255
}
