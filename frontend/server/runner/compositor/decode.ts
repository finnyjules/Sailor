/**
 * Picture files ↔ the float tensors the Compositor node sees, with sharp.
 *
 * What the node receives on a layer depends on the node the picture came
 * from, because each Python source decodes differently:
 *   provider — a provider node's download (`bytesio_to_image_tensor`):
 *              always RGBA, no EXIF turn;
 *   card     — an Image card loading its file (`Image.process` /
 *              `_load_from_disk`): EXIF turned; RGB, or RGBA when any pixel
 *              is not fully opaque;
 *   load     — LoadImage (the Frame editor's baked layers): EXIF turned, RGB;
 *   rgb      — another Compositor's result: RGB (the runner saved it as an
 *              8-bit PNG, where Python passes the float on: up to 1/255 apart);
 *   blank    — an Image card with nothing loaded: Python's 1×1 black placeholder.
 * And a mask input from LoadImage's MASK output (`loadMask`): 1 − alpha, or
 * a 64×64 zero mask when the file has no alpha.
 *
 * PIL ignores embedded ICC profiles, so sharp is told to as well. Only the
 * first frame of a multi-frame file is read (Python composites every frame;
 * its preview, which is what the runner saves, is the first).
 */
import sharp from 'sharp'
import { core, type Plane, type RawPicture } from './plane'

/** The largest picture read: 8192 × 8192 pixels, the Frame's own size limit. */
export const MAX_INPUT_PIXELS = 8192 * 8192

/** sharp's refusal of a picture over the limit, as plain words. */
function tooLarge(e: unknown): never {
  if (e instanceof Error && /pixel limit/i.test(e.message)) throw new Error('A picture for the Frame is larger than 8192 × 8192, too large to render')
  throw e
}

export type PictureSource = 'provider' | 'card' | 'load' | 'rgb' | 'blank'

interface Rgba8 { w: number; h: number; data: Uint8Array }

async function rgba8(bytes: Uint8Array, turn: boolean): Promise<Rgba8> {
  let s = sharp(bytes, { ignoreIcc: true, pages: 1, page: 0, autoOrient: turn, failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS })
  s = s.toColourspace('srgb').ensureAlpha(1)
  const { data, info } = await s.raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true }).catch(tooLarge)
  if (info.channels !== 4) throw new Error('A picture could not be read')
  // sharp's buffer is native memory a worker cannot take over; one copy
  // (a memcpy, no per-pixel work) into a plain buffer that can be transferred.
  const own = new Uint8Array(data.byteLength)
  own.set(data)
  return { w: info.width, h: info.height, data: own }
}

/**
 * A picture file as sharp decodes it for this source: RGBA, 8 bits, EXIF
 * turned for the sources whose Python loader turns it (card, load). No pixel
 * is touched here; the worker builds the tensor (`toTensor` in plane.ts).
 */
export async function decodeRaw(bytes: Uint8Array | null, source: PictureSource): Promise<RawPicture> {
  if (source === 'blank') return { raw: true, source, w: 1, h: 1, data: null }
  if (!bytes) throw new Error('A picture for the Frame is missing')
  const p = await rgba8(bytes, source === 'card' || source === 'load')
  return { raw: true, source, w: p.w, h: p.h, data: p.data }
}

/** LoadImage's MASK output, raw: its file's alpha, or (no alpha) the 64×64 zero mask. */
export async function decodeRawMask(bytes: Uint8Array): Promise<RawPicture> {
  const meta = await sharp(bytes, { pages: 1, page: 0, limitInputPixels: MAX_INPUT_PIXELS }).metadata().catch(tooLarge)
  if (!meta.hasAlpha) return { raw: true, source: 'nomask', w: 64, h: 64, data: null }
  const p = await rgba8(bytes, true)
  return { raw: true, source: 'mask', w: p.w, h: p.h, data: p.data }
}

/** The tensor a layer (or the overlay) receives from a picture of this source (in this thread: tests). */
export async function decodePicture(bytes: Uint8Array | null, source: PictureSource): Promise<Plane> {
  return core.toTensor(await decodeRaw(bytes, source))
}

/** LoadImage's MASK output as a tensor (in this thread: tests). */
export async function decodeLoadMask(bytes: Uint8Array): Promise<Plane> {
  return core.toTensor(await decodeRawMask(bytes))
}

/** A PNG from save_live_preview's 8-bit RGB pixels, compress level 1. */
export async function pngFromPreview8(px: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const buf = await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer()
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/** The PNG Python's save_live_preview writes for a composite tensor (in this thread: tests). */
export async function encodePreviewPng(img: Plane): Promise<Uint8Array> {
  return pngFromPreview8(core.toPreview8(img), img.w, img.h)
}
