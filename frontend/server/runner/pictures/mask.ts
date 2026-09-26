/**
 * Masks between runner nodes (R0, step 3 spec): ComfyUI's MASK values (float
 * 0..1, row-major), kept as a 16-bit greyscale PNG holding round(v·65535).
 * Also LoadImage's MASK: 1 − alpha of the file's first frame, or a 64×64 zero
 * mask when it has no alpha (nodes.py LoadImage.load_image).
 */
import sharp from 'sharp'
import { maskPngFromScanlines, readMaskPng } from '../compositor/keep'
import { core } from '../compositor/plane'
import { MAX_INPUT_PIXELS } from '../compositor/decode'

export interface Mask { w: number; h: number; data: Float32Array }

export const MASK_UNREADABLE = 'A mask could not be read'

/** The mask as the runner keeps it: the Frame's protect_mask format (keep.ts), round(v·65535) clamped to 0..1. */
export async function encodeMask(m: Mask): Promise<Uint8Array> {
  return maskPngFromScanlines(core.mask16Scanlines({ c: 1, h: m.h, w: m.w, data: m.data }), m.w, m.h)
}

/** A mask kept by the runner (encodeMask, or the Frame's protect_mask), read back as float32 u / 65535. */
export async function decodeMask(bytes: Uint8Array): Promise<Mask> {
  const { w, h, scanlines } = await readMaskPng(bytes).catch(() => { throw new Error(MASK_UNREADABLE) })
  if (w * h > MAX_INPUT_PIXELS) throw new Error(MASK_UNREADABLE)
  let p
  try { p = core.maskFromScanlines(scanlines, w, h) }
  catch { throw new Error(MASK_UNREADABLE) }
  return { w, h, data: p.data }
}

export async function loadImageMask(bytes: Uint8Array): Promise<Mask> {
  const s = sharp(bytes, { pages: 1, page: 0, autoOrient: true, ignoreIcc: true, limitInputPixels: MAX_INPUT_PIXELS })
  const meta = await s.metadata()
  if (!meta.hasAlpha) return { w: 64, h: 64, data: new Float32Array(64 * 64) }
  const { data, info } = await s.extractChannel('alpha').raw().toBuffer({ resolveWithObject: true })
  const out = new Float32Array(info.width * info.height)
  // As Python: float32(a / 255), then 1 − that in float32.
  for (let i = 0; i < out.length; i++) out[i] = 1 - Math.fround(data[i]! / 255)
  return { w: info.width, h: info.height, data: out }
}
