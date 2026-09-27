/**
 * Painter (comfy_extras/nodes_painter.py:26-117, step 3 R2.8) as a runner
 * plan: the first picture wired in (`image[:1]`) or a width × height canvas
 * of bg_color, and the painter file named by its `mask` widget painted over
 * it. Outputs: the picture (kept as a hand-off or save reads it, and as its
 * float tensor when an effect or a Frame reads it) and a MASK, the painter
 * file's alpha. Its ui is UI.PreviewImage: the picture saved into temp as
 * `ComfyUI_temp_` + five random letters (R1.5's naming), compress level 1,
 * no metadata (the node passes no cls).
 *
 * The painter file is read as `Image.open(…).convert("RGBA")` holds it: its
 * header first (refused as a card refuses a file: 16-bit, CMYK…; checked at
 * the start of the take too, cards/bakeReplay.ts), decoded here by sharp as
 * RGBA with no EXIF turn; its Lanczos resize (when its size isn't the
 * canvas's) and the composite run on the Frame's worker (core/mask.ts).
 * Hosted, the file must be the user's own (inputs.ts collectInputFiles).
 */
import sharp from 'sharp'
import type { NodePlan, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { isLink } from '#shared/runner/graph'
import { CARD_MAX_PIXELS } from '#shared/runner/eligibility'
import {
  EFFECT_MAX_WORK, EFFECT_PICTURES_TOO_LARGE, EFFECT_TOO_MUCH_WORK, effectPictureCap, effectSchemaOf, painterColourOf,
} from '#shared/runner/effects'
import { maskPngFromScanlines } from '../compositor/keep'
import { EFFECT_TIMEOUT_MESSAGE, pixelsInWorker, type EffectRawIn, type EffectTensorIn } from '../compositor/worker'
import { decodeRaw } from '../compositor/decode'
import type { PixelsPicture } from '../pixels/core'
import { PICTURE_UNREADABLE, pictureRefusalOf } from '../pictures/pythonView'
import { onlySavesRead } from '../cards/utilities'
import { previewImageLetters, saveImagePrefix } from '../cards/saveImage'
import { parseInputFileRef } from '../inputs'
import { PICTURE_UNREAD, keyOf, wired } from './io'
import { EFFECT_IO_WORK_PER_VALUE, effectParams, pictureHeader, plain, png8 } from './plan'
import { painterWork } from './table'
import { floatReadBy, keptTensorsBehind } from './tensorFiles'

export const PAINTER_FILE_MISSING = 'This Painter’s drawing isn’t there any more. Draw on it again.'
export const PAINTER_COLOUR_UNREAD = 'This Painter’s background colour can’t be read here'

/** The painter file a `mask` widget names (`mask and mask.strip()`), or null. */
export function painterFileOf(raw: unknown): OutputFile | null {
  return typeof raw === 'string' && raw.trim() ? parseInputFileRef(raw) : null
}

export function planPainter(ctx: PlanContext): NodePlan {
  const node = ctx.prompt[ctx.nodeId]!
  const inputs = node.inputs ?? {}
  const params = effectParams(effectSchemaOf('Painter')!, inputs)
  const file = painterFileOf(params.mask)
  const link = isLink(inputs.image) ? inputs.image : null
  const image = link ? { wire: wired(ctx, 'image'), tensors: keptTensorsBehind(ctx, link) } : null
  // The canvas colour matters only with no picture wired in (eligibility has checked it reads as Python reads it).
  const bg = image ? [0, 0, 0] : painterColourOf(params.bg_color)
  if (!bg) throw new Error(PAINTER_COLOUR_UNREAD)
  // Kept as the pixels its readers write (Save image / Preview image truncate the float, R1.5); the float tensor too when an effect or a Frame reads it.
  const trunc = onlySavesRead(ctx.prompt, ctx.nodeId, 0)
  const float = floatReadBy(ctx.prompt, ctx.nodeId, 0, ctx.families)
  // The mask, as its float32 tensor too when an effect or a Frame reads it (R2.8 fix round 1).
  const floatMask = floatReadBy(ctx.prompt, ctx.nodeId, 1, ctx.families, 'mask')
  const letters = previewImageLetters()
  return {
    kind: 'derive',
    async derive(io) {
      const stop = () => { if (io.signal.aborted) throw new Error('Stopped') }
      const { max, message: tooLarge } = effectPictureCap('Painter', io.hosted)
      // The base's size from its header (only the first picture is read), before any pixel is decoded.
      let first: OutputFile | null = null
      let firstBytes: Uint8Array | null = null
      let canvas = { w: params.width as number, h: params.height as number }
      if (image) {
        first = image.wire.files[0] ?? null
        if (first) {
          stop()
          firstBytes = await io.read(first)
          const s = await pictureHeader(firstBytes, image.wire.source, max, tooLarge, true)
          canvas = { w: s.w, h: s.h }
        }
        else canvas = { w: 1, h: 1 }
      }
      if (canvas.w * canvas.h > max) throw new Error(tooLarge)
      // The painter file, from its header.
      let painterBytes: Uint8Array | null = null
      let painterSize: { w: number; h: number } | null = null
      if (file) {
        stop()
        try { painterBytes = await io.read(file) }
        catch { throw new Error(PAINTER_FILE_MISSING) }
        const meta = await sharp(painterBytes, { limitInputPixels: false }).metadata().catch(() => { throw new Error(PICTURE_UNREADABLE) })
        if (!meta.width || !meta.height) throw new Error(PICTURE_UNREAD)
        if (meta.width * meta.height > max) throw new Error(tooLarge)
        const why = pictureRefusalOf(meta, painterBytes)
        if (why) throw new Error(why)
        painterSize = { w: meta.width, h: meta.height }
      }
      const px = (s: { w: number; h: number } | null) => (s ? s.w * s.h : 0)
      // Read: the base (a picture wired in) and the file; made: the picture and the mask.
      if ((image ? px(canvas) : 0) + px(painterSize) + 2 * px(canvas) > CARD_MAX_PIXELS) throw new Error(EFFECT_PICTURES_TOO_LARGE)
      const work = painterWork(params, image ? canvas : null, painterSize)
        + EFFECT_IO_WORK_PER_VALUE * 4 * ((image ? px(canvas) : 0) + px(painterSize) + 2 * px(canvas))
      if (work > EFFECT_MAX_WORK) throw new Error(EFFECT_TOO_MUCH_WORK)

      // Decoded here (sharp); worked on the worker.
      const handed: Record<string, PixelsPicture | EffectTensorIn | EffectRawIn> = {}
      if (image) {
        stop()
        const tensor = first ? image.tensors?.get(keyOf(first)) : undefined
        if (tensor) handed.image = { tensorFile: await io.read(tensor) }
        else if (!first) handed.image = await decodeRaw(null, 'blank')
        else {
          try { handed.image = await decodeRaw(firstBytes!, image.wire.source) }
          catch { throw new Error(PICTURE_UNREAD) }
        }
        firstBytes = null
      }
      if (painterBytes) {
        stop()
        let raw
        try { raw = await decodeRaw(painterBytes, 'provider') }
        catch { throw new Error(PICTURE_UNREAD) }
        painterBytes = null
        handed.painter = { rgba8: raw.data!, w: raw.w, h: raw.h }
      }
      const made = await pixelsInWorker(io.signal, async (worker) => {
        const stopped = () => { if (worker.live.aborted || io.signal.aborted) throw new Error('Stopped') }
        try {
          await worker.effectBegin({ cls: 'Painter', fn: 'mask.Painter', params: { width: canvas.w, height: canvas.h, bg }, count: 1 })
          const r = await worker.effectRun({
            index: 0, inputs: handed, first: false, masks: [false, true],
            want: { round: [!trunc, false], trunc: [true, false], f32: [float, floatMask] },
          })
          await worker.effectEnd()
          const [pic, msk] = r.outputs
          if (!pic || !msk || 'mask16' in pic || !('mask16' in msk)) throw new Error('Painter made no picture')
          // The kept picture, its tensor, the mask; then the preview (UI.PreviewImage: the float truncated).
          const kept = await png8((trunc ? pic.trunc8 : pic.round8)!, pic.w, pic.h, pic.channels, 6)
          stopped()
          const picture = await io.keep(kept, 'png')
          let tensor: OutputFile | null = null
          if (pic.tensorFile) {
            stopped()
            tensor = await io.keep(pic.tensorFile, 'bin')
          }
          const maskPng = await maskPngFromScanlines(msk.mask16, msk.w, msk.h)
          stopped()
          const mask = await io.keep(maskPng, 'png')
          let maskTensor: OutputFile | null = null
          if (msk.tensorFile) {
            stopped()
            maskTensor = await io.keep(msk.tensorFile, 'bin')
          }
          const shown = await png8(pic.trunc8!, pic.w, pic.h, pic.channels, 1)
          const { subfolder, filename } = saveImagePrefix(`ComfyUI_temp_${letters}`, pic.w, pic.h, new Date())
          stopped()
          const preview = await io.saveAsset(shown, { prefix: filename, ext: 'png', subfolder, folder: 'temp' })
          return { picture, tensor, mask, maskTensor, preview }
        }
        catch (e) { throw plain(e) }
      }, EFFECT_TIMEOUT_MESSAGE)
      const values: Record<number, RunnerValue> = {
        0: { kind: 'files', files: [made.picture], ...(made.tensor ? { tensors: [made.tensor] } : {}) },
        1: { kind: 'mask', files: [made.mask], ...(made.maskTensor ? { tensors: [made.maskTensor] } : {}) },
      }
      return { values, ui: { images: [{ filename: made.preview.filename, subfolder: made.preview.subfolder, type: made.preview.type }], animated: [false] } }
    },
  }
}
