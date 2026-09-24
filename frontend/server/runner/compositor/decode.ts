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
import { plane, type Plane } from './plane'

export type PictureSource = 'provider' | 'card' | 'load' | 'rgb' | 'blank'

interface Rgba8 { w: number; h: number; data: Uint8Array }

async function rgba8(bytes: Uint8Array, turn: boolean): Promise<Rgba8> {
  let s = sharp(bytes, { ignoreIcc: true, pages: 1, page: 0, autoOrient: turn, failOn: 'none' })
  s = s.toColourspace('srgb').ensureAlpha(1)
  const { data, info } = await s.raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  if (info.channels !== 4) throw new Error('A picture could not be read')
  return { w: info.width, h: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
}

/** uint8 → float32 as numpy does it: float32(v) / 255. */
const unit = (v: number) => Math.fround(v / 255)

function toPlane(p: Rgba8, withAlpha: boolean): Plane {
  const n = p.w * p.h
  const out = plane(withAlpha ? 4 : 3, p.h, p.w)
  const d = out.data
  for (let i = 0; i < n; i++) {
    d[i] = unit(p.data[i * 4]!)
    d[n + i] = unit(p.data[i * 4 + 1]!)
    d[2 * n + i] = unit(p.data[i * 4 + 2]!)
  }
  if (withAlpha) {
    for (let i = 0; i < n; i++) {
      // Image.process rebuilds alpha as (1 − mask) from mask = 1 − a/255.
      d[3 * n + i] = Math.fround(1 - Math.fround(1 - unit(p.data[i * 4 + 3]!)))
    }
  }
  return out
}

/** The tensor a layer (or the overlay) receives from a picture of this source. */
export async function decodePicture(bytes: Uint8Array | null, source: PictureSource): Promise<Plane> {
  if (source === 'blank') return plane(3, 1, 1)
  if (!bytes) throw new Error('A picture for the Frame is missing')
  switch (source) {
    case 'provider': {
      const p = await rgba8(bytes, false)
      const out = toPlane(p, false)
      // bytesio_to_image_tensor keeps alpha as a plain 4th channel: a/255.
      const n = p.w * p.h
      const four = plane(4, p.h, p.w)
      four.data.set(out.data, 0)
      for (let i = 0; i < n; i++) four.data[3 * n + i] = unit(p.data[i * 4 + 3]!)
      return four
    }
    case 'card': {
      const p = await rgba8(bytes, true)
      // mask.max() > 1e-3 ⇔ some alpha ≤ 254.
      let transparent = false
      for (let i = 3; i < p.data.length; i += 4) {
        if (p.data[i]! < 255) { transparent = true; break }
      }
      return toPlane(p, transparent)
    }
    case 'load':
      return toPlane(await rgba8(bytes, true), false)
    case 'rgb':
      return toPlane(await rgba8(bytes, false), false)
  }
}

/** LoadImage's MASK output: 1 − alpha, or a 64×64 zero mask for a file with no alpha. */
export async function decodeLoadMask(bytes: Uint8Array): Promise<Plane> {
  const meta = await sharp(bytes, { pages: 1, page: 0 }).metadata()
  if (!meta.hasAlpha) return plane(1, 64, 64)
  const p = await rgba8(bytes, true)
  const n = p.w * p.h
  const out = plane(1, p.h, p.w)
  for (let i = 0; i < n; i++) out.data[i] = Math.fround(1 - unit(p.data[i * 4 + 3]!))
  return out
}

/**
 * The PNG Python's save_live_preview writes for the composite:
 * clip(255·x, 0, 255) truncated to uint8, compress level 1. Always 3
 * channels: the composite is RGB.
 */
export async function encodePreviewPng(img: Plane): Promise<Uint8Array> {
  const n = img.h * img.w
  const px = new Uint8Array(n * 3)
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < n; i++) {
      // 255.0 · x is a float32 product in numpy.
      const v = Math.fround(255 * img.data[k * n + i]!)
      px[i * 3 + k] = v <= 0 ? 0 : v >= 255 ? 255 : Math.trunc(v)
    }
  }
  const buf = await sharp(px, { raw: { width: img.w, height: img.h, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer()
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}
