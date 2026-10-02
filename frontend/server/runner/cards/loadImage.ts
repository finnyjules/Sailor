/**
 * LoadImage (nodes.py LoadImage.load_image) feeding anything (step 3, R1.3).
 * Its IMAGE is the file EXIF turned, first frame, RGB, as the PNG a provider
 * would be sent (../pictures/pythonView.ts; the file itself when it already is
 * that picture); its MASK is 1 − alpha, or a 64×64 zero mask
 * (../pictures/mask.ts), kept as the runner keeps masks.
 *
 * With `cards` off, the LoadImage the Frame editor injects is handed to its
 * Frames as a file, exactly as before step 3 (the Frame decodes it itself).
 *
 * R11.9c fix round 3 (B1): an animated GIF or WebP is a batch, as Python's
 * load_image makes it (ImageSequence over every frame; an MPO's first only,
 * which sharp reads as one page anyway): a PNG and a mask each frame, in
 * order. Each frame is the whole composited picture (sharp's, as PIL's). An
 * animated PNG is read as its first frame here (sharp reads no APNG frames):
 * a reader that takes the batch is refused before the hold
 * (bakeReplay.ts cardPictureFiles).
 *
 * Fix round 5:
 *  - I2: the batch is made only when a reader takes it (./loaderBatch.ts
 *    loaderBatchReaders); else frame 0 alone, as before R11.9c (a paid node,
 *    the Frame…). Its frames are decoded in one pass (sharp `pages: -1`,
 *    streamed a frame at a time: never one decode per page, which re-decodes
 *    every frame before it, nor the whole tall picture in memory).
 *  - M1: the mask follows Pillow's mode for the whole file
 *    (hasAlphaAsPil, as a still): an animated WebP with alpha is RGBA on every
 *    frame, so every frame's mask is 1 − alpha at its size (zeros where it is
 *    opaque); a GIF the card takes (no see-through first frame) is RGB on
 *    every frame in Pillow 12 (later frames are pasted onto the first's RGB),
 *    so 64 × 64 zeros each.
 *  - Every frame of a GIF and a WebP is the canvas's size (libvips and Pillow
 *    both), so Python's skip of a frame of another size never applies.
 * The frames are checked against the batch caps and each reader's limits, and
 * counted in the run's kept room, before the hold (engine.ts, loaderBatch.ts).
 */
import { linksOf } from '#shared/runner/graph'
import { mkdtemp, open as openFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import type { DeriveIO, Derived, NodePlan, PlanContext } from '../executors'
import type { OutputFile } from '../types'
import { parseInputFileRef } from '../inputs'
import { pictureMeta, pictureRefusalOf, rgbTurnedPng } from '../pictures/pythonView'
import { MAX_INPUT_PIXELS } from '../compositor/decode'
import { encodeMask, hasAlphaAsPil, loadImageMask, type Mask } from '../pictures/mask'
import { floatReadBy, maskTensorBytes } from '../effects/tensorFiles'
import { loaderBatchTaken } from './loaderBatch'

export function planLoadImageCard(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const file = parseInputFileRef(inputs.image)
  if (!file) throw new Error('There is no picture to load')
  const onlyFrames = Object.values(ctx.prompt).every(n => n.class_type === 'Compositor' || !linksOf(n).some(l => l.from === ctx.nodeId))
  if (onlyFrames && !ctx.families?.has('cards')) return { kind: 'pass', files: [file], ui: null }
  // Read by an effect or a Frame: the float mask is kept too, and handed on (R2.8 fix round 1).
  const float = floatReadBy(ctx.prompt, ctx.nodeId, 1, ctx.families, 'mask')
  // Fix round 5 (I2): its frames are made only for a reader that takes them.
  const batch = loaderBatchTaken(ctx.prompt, ctx.nodeId, ctx.families)
  return {
    kind: 'derive',
    async derive(io) {
      const bytes = await io.read(file)
      const meta = await pictureMeta(bytes)
      if (batch && (meta.pages ?? 1) > 1) {
        const refused = pictureRefusalOf(meta, bytes)
        if (refused) throw new Error(refused)
        return animatedFrames(io, bytes, meta, float)
      }
      const { png } = await rgbTurnedPng(bytes)
      const image = png ? await io.keep(png, 'png') : file
      const m = await loadImageMask(bytes)
      const mask = await io.keep(await encodeMask(m), 'png')
      const tensors = float ? { tensors: [await io.keep(maskTensorBytes(m), 'bin')] } : {}
      return { values: { 0: { kind: 'files', files: [image] }, 1: { kind: 'mask', files: [mask], ...tensors } }, ui: null }
    },
  }
}

/** The words for a frame too large to decode (as the effects' and cards' readers say it). */
const FRAME_TOO_LARGE = 'This picture is larger than 8192 × 8192, too large to read here'
const FRAME_UNREAD = 'The picture could not be read'

/**
 * R11.9c fix round 3, fix round 5 (I2, M1): every frame of an animated GIF or
 * WebP, a PNG and a mask each (see the header), decoded in ONE pass: one
 * sharp pipeline over every page (`pages: -1`, the frames stacked), written
 * to a scratch file in libvips' own format as it decodes (sequential: memory
 * stays a few rows, never the whole stack; sharp's raw output to a buffer or a
 * stream would hold all of it), then read back a frame at a time. Decoding a
 * page on its own decodes every frame before it (WebP and GIF frames build on
 * the last), so a page each was quadratic. The scratch file is deleted before
 * the card ends, however it ends.
 */
export async function decodeFramesOnce(
  bytes: Uint8Array, meta: { width?: number; height?: number; pageHeight?: number; pages?: number }, channels: 3 | 4,
  onFrame: (px: Uint8Array, w: number, h: number) => Promise<void>, signal?: AbortSignal,
): Promise<number> {
  const w = meta.width ?? 0
  const h = meta.pageHeight ?? meta.height ?? 0
  const pages = meta.pages ?? 1
  if (!w || !h) throw new Error(FRAME_UNREAD)
  // Each frame within the one-picture limit (the stack itself is checked against the batch caps before the hold).
  if (w * h > MAX_INPUT_PIXELS) throw new Error(FRAME_TOO_LARGE)
  const dir = await mkdtemp(join(tmpdir(), 'sailor-frames-'))
  try {
    const path = join(dir, 'stack.v')
    const open = sharp(bytes, { pages: -1, ignoreIcc: true, limitInputPixels: false, sequentialRead: true })
    await (channels === 4 ? open.ensureAlpha() : open.removeAlpha()).toFile(path)
    const fh = await openFile(path, 'r')
    try {
      // libvips' header (64 bytes, little-endian): magic, width, height, bands, bits, band format (0: uchar).
      const head = Buffer.alloc(64)
      await fh.read(head, 0, 64, 0)
      const ok = head.readUInt32LE(0) === 0x08F2A6B6 && head.readInt32LE(4) === w && head.readInt32LE(8) === h * pages
        && head.readInt32LE(12) === channels && head.readInt32LE(16) === 8 && head.readInt32LE(20) === 0
      if (!ok) throw new Error(FRAME_UNREAD)
      const frameBytes = w * h * channels
      for (let k = 0; k < pages; k++) {
        if (signal?.aborted) throw new Error('Stopped')
        const px = new Uint8Array(frameBytes)
        const { bytesRead } = await fh.read(px, 0, frameBytes, 64 + k * frameBytes)
        if (bytesRead !== frameBytes) throw new Error(FRAME_UNREAD)
        await onFrame(px, w, h)
      }
    }
    finally { await fh.close() }
  }
  finally { await rm(dir, { recursive: true, force: true }) }
  return pages
}

async function animatedFrames(io: DeriveIO, bytes: Uint8Array, meta: Awaited<ReturnType<typeof pictureMeta>>, float: boolean): Promise<Derived> {
  // M1: Pillow's mode for the whole file decides every frame's mask.
  const alpha = hasAlphaAsPil(bytes, meta.hasAlpha, meta.format)
  const images: OutputFile[] = []
  const masks: OutputFile[] = []
  const tensors: OutputFile[] = []
  const zero: Mask = { w: 64, h: 64, data: new Float32Array(64 * 64) }
  await decodeFramesOnce(bytes, meta, alpha ? 4 : 3, async (px, w, h) => {
    let rgb = px
    let m = zero
    if (alpha) {
      rgb = new Uint8Array(w * h * 3)
      for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { rgb[j] = px[i]!; rgb[j + 1] = px[i + 1]!; rgb[j + 2] = px[i + 2]! }
      // As Python: float32(a / 255), then 1 − that in float32 (pictures/mask.ts loadImageMask).
      const d = new Float32Array(w * h)
      for (let i = 0; i < d.length; i++) d[i] = 1 - Math.fround(px[i * 4 + 3]! / 255)
      m = { w, h, data: d }
    }
    const png = new Uint8Array(await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer())
    images.push(await io.keep(png, 'png'))
    masks.push(await io.keep(await encodeMask(m), 'png'))
    if (float) tensors.push(await io.keep(maskTensorBytes(m), 'bin'))
  }, io.signal)
  return { values: { 0: { kind: 'files', files: images }, 1: { kind: 'mask', files: masks, ...(float ? { tensors } : {}) } }, ui: null }
}
