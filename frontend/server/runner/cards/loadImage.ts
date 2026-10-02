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
 * load_image makes it (ImageSequence over every frame, a frame of another
 * size than the first skipped; an MPO's first only, which sharp reads as one
 * page anyway): a PNG and a mask each frame, in order. Each frame is the
 * whole composited picture (sharp's, as PIL's); its mask is 1 − alpha where
 * the frame has see-through pixels (PIL hands such a frame on as RGBA), else
 * Python's 64 × 64 zeros. An animated PNG is read as its first frame here
 * (sharp reads no APNG frames): a reader that takes the batch is refused
 * before the hold (bakeReplay.ts cardPictureFiles). The frames are counted in
 * the run's kept room and the batch caps before the hold (engine.ts).
 */
import { linksOf } from '#shared/runner/graph'
import sharp from 'sharp'
import type { DeriveIO, Derived, NodePlan, PlanContext } from '../executors'
import type { OutputFile } from '../types'
import { parseInputFileRef } from '../inputs'
import { pictureMeta, pictureRefusalOf, rgbTurnedPng } from '../pictures/pythonView'
import { MAX_INPUT_PIXELS } from '../compositor/decode'
import { encodeMask, loadImageMask, type Mask } from '../pictures/mask'
import { floatReadBy, maskTensorBytes } from '../effects/tensorFiles'

export function planLoadImageCard(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const file = parseInputFileRef(inputs.image)
  if (!file) throw new Error('There is no picture to load')
  const onlyFrames = Object.values(ctx.prompt).every(n => n.class_type === 'Compositor' || !linksOf(n).some(l => l.from === ctx.nodeId))
  if (onlyFrames && !ctx.families?.has('cards')) return { kind: 'pass', files: [file], ui: null }
  // Read by an effect or a Frame: the float mask is kept too, and handed on (R2.8 fix round 1).
  const float = floatReadBy(ctx.prompt, ctx.nodeId, 1, ctx.families, 'mask')
  return {
    kind: 'derive',
    async derive(io) {
      const bytes = await io.read(file)
      const meta = await pictureMeta(bytes)
      if ((meta.pages ?? 1) > 1) {
        const refused = pictureRefusalOf(meta, bytes)
        if (refused) throw new Error(refused)
        return animatedFrames(io, bytes, meta.pages!, float)
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

/** R11.9c fix round 3: every frame of an animated GIF or WebP, a PNG and a mask each (see the header). */
async function animatedFrames(io: DeriveIO, bytes: Uint8Array, pages: number, float: boolean): Promise<Derived> {
  const images: OutputFile[] = []
  const masks: OutputFile[] = []
  const tensors: OutputFile[] = []
  let size: { w: number; h: number } | null = null
  for (let page = 0; page < pages; page++) {
    if (io.signal.aborted) throw new Error('Stopped')
    const { data, info } = await sharp(bytes, { page, pages: 1, ignoreIcc: true, limitInputPixels: MAX_INPUT_PIXELS })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    // Python skips a frame whose size isn't the first's.
    if (size && (info.width !== size.w || info.height !== size.h)) continue
    size ??= { w: info.width, h: info.height }
    const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    let seeThrough = false
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { seeThrough = true; break }
    const rgb = new Uint8Array(info.width * info.height * 3)
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]!; rgb[j + 1] = rgba[i + 1]!; rgb[j + 2] = rgba[i + 2]! }
    const png = new Uint8Array(await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer())
    images.push(await io.keep(png, 'png'))
    let m: Mask = { w: 64, h: 64, data: new Float32Array(64 * 64) }
    if (seeThrough) {
      const d = new Float32Array(info.width * info.height)
      for (let i = 0; i < d.length; i++) d[i] = 1 - rgba[i * 4 + 3]! / 255
      m = { w: info.width, h: info.height, data: d }
    }
    masks.push(await io.keep(await encodeMask(m), 'png'))
    if (float) tensors.push(await io.keep(maskTensorBytes(m), 'bin'))
  }
  return { values: { 0: { kind: 'files', files: images }, 1: { kind: 'mask', files: masks, ...(float ? { tensors } : {}) } }, ui: null }
}
