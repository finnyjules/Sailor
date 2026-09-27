/**
 * Separate background and foreground as a runner pipeline (step 3, R3.7,
 * family `layers`): SplitPhotoLayersNode (nodes_replicate.py:4556-4653), two
 * Replicate calls built as its Python builds them. No backup: no same-model
 * twin on fal with the same settings is carded.
 *
 *  0. The picture (fix round 1). Behind a loader (a LoadImage or an Image
 *     card, `loaderFileBehind`), Python's picture is the loader's tensor:
 *     `ImageOps.exif_transpose`, then RGB (pythonView.ts rgbTurnedPng, the
 *     file itself when it already is that picture). Both calls are sent that
 *     picture, so the cut-out (and its mask) comes back in the same shape as
 *     the fill picture, EXIF-turned phone photos included. Any other source
 *     (a picture a paid node downloaded: Python's tensor is the file read as
 *     RGBA, not turned) is sent as it is, as every paid node sends it.
 *  1. `cutout` (:4601-4605): 851-labs/background-remover with
 *     `{image, background_type: "rgba", format: "png"}`. Its first answer URL
 *     (`_first_output_url`) is the subject, kept as downloaded (its alpha
 *     kept) and shown under `split_subject`.
 *  2. The mask (:4611-4627): the cut-out's alpha as PIL's `.convert("RGBA")`
 *     reads it (pythonView.ts pilRaw, CMYK and 16-bit grey as PIL reads
 *     them), `round(clamp(a/255)·255)` (each 8-bit value back); grown by
 *     PIL's MaxFilter(2·mask_grow + 1) when mask_grow > 0; an 8-bit greyscale
 *     PNG, handed off. The per-pixel work runs on the Frame's worker with its
 *     Stop checks (../pixels/pilPixels.ts, ../pixels/maxFilter.ts). A cut-out
 *     that doesn't come back the fill picture's size is refused before the
 *     fill is paid for (fix round 1: the mask and the picture always have one
 *     shape; Python would send them and the fill would fail or smear).
 *     Python's other branch, the remover's matte (`background_type: "map"`,
 *     :4613-4620), is for a cut-out with no alpha, and never runs: a
 *     downloaded picture is always read as RGBA (bytesio_to_image_tensor), so
 *     the cut-out always has one (fully opaque when the file has none). The
 *     fixture proves it (`split · a cut-out with no alpha (no matte call)`:
 *     two calls). The runner neither makes that call nor holds for it.
 *  3. `fill` (:4631-4640): the engine `background_fill` names
 *     (`_PHOTO_FILL_SLUGS`) with `{image, mask}`: the picture without its
 *     alpha (`image[..., :3]`): behind a loader, the loader's picture (RGB
 *     already); otherwise the file's RGB as PIL reads it, handed off (the
 *     file itself when it already is an 8-bit RGB PNG, as Python sends the
 *     same tensor again); and the mask. Its first answer URL is the background,
 *     alpha dropped (:4644-4645; rule 3: the RGB PNG of Python's tensor),
 *     shown under `split_background`.
 *
 * Outputs: slot 0 the subject, slot 1 the background; ui `{images: [subject,
 * background], animated: [false]}` in slot order (:4650-4652). Priced per
 * call (R3.5's remover card, the fill engine's card); charged for the calls
 * that finished (ruling (f)): a fill that fails is not charged, the cut-out
 * is. A restarted server replays the cut-out from its record (the cut-out's
 * bytes kept for the run) and goes on at the fill.
 */
import { isLink } from '#shared/runner/graph'
import { PY_INT_RE, pyNumStrip } from '#shared/runner/pyText'
import { PHOTO_FILL_SLUGS, SPLIT_CUTOUT_SLUG, SPLIT_MASK_GROW, type PhotoFill } from '#shared/runner/layers'
import { paidCallUsd } from '#shared/pricing/paidRates'
import sharp from 'sharp'
import { answerExt } from '../answerDownload'
import { pixelsInWorker } from '../compositor/worker'
import { answerRgbPng, isPlainRgbPng, pictureMeta, pilRaw, rgbTurnedPng } from '../pictures/pythonView'
import { loaderFileBehind } from '../cards/bakeReplay'
import type { NodePlan, PipelineIO, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { firstOutputUrl } from './repair'

/** The remover answered with no picture (Python: `Replicate returned no output`), after its call. */
export const SPLIT_NO_SUBJECT = 'The service sent back no cut-out of the subject'
/** The fill engine answered with no picture, after its call. */
export const SPLIT_NO_BACKGROUND = 'The service sent back no background picture'
/** The mask or the picture's copy took longer than the worker's limit. */
export const SPLIT_MASK_TIMEOUT = 'Making the subject’s mask took longer than 2 minutes, so it was stopped'
/** The cut-out isn't the picture's size: the fill would get a mask of another shape (fix round 1). */
export const SPLIT_SIZES_DIFFER = 'The cut-out came back a different size from the picture, so the background can’t be filled'

// ── A widget as ComfyUI hands it to execute (missing: the node's default) ──

/** int(val) for an INT widget. */
function intOf(v: unknown, def: number): number {
  if (v === undefined || v === null) return def
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') {
    const t = pyNumStrip(v)
    if (PY_INT_RE.test(t)) return Number.parseInt(t.replace(/_/g, ''), 10)
  }
  throw new Error('This number setting must be a whole number')
}

/** The fill engine as picked (ComfyUI has checked it is one of the options; missing: LaMa, the default). */
export function photoFillOf(v: unknown): PhotoFill {
  if (v === undefined) return 'LaMa (fast)'
  if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(PHOTO_FILL_SLUGS, v)) return v as PhotoFill
  throw new Error('Pick how to fill the background: LaMa or Bria Eraser')
}

// ── What the node sends (its Python, as ported) ──

/** The cut-out call's input (:4603). */
export function cutoutInput(image: string): Record<string, unknown> {
  return { image, background_type: 'rgba', format: 'png' }
}

/** The fill call's input (:4639): the picture without its alpha, and the mask. */
export function fillInput(image: string, mask: string): Record<string, unknown> {
  return { image, mask }
}

/** An 8-bit greyscale PNG of a mask (PIL's `Image.fromarray(alpha, mode="L")` saved as PNG). */
export async function maskPng(l: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const png = await sharp(l, { raw: { width: w, height: h, channels: 1 } }).toColourspace('b-w').png({ compressionLevel: 6 }).toBuffer()
  return new Uint8Array(png)
}

/**
 * The mask Python sends, from the cut-out's bytes: its alpha as PIL reads it,
 * grown by MaxFilter(2·grow + 1) when `grow` > 0 (on the Frame's worker), as
 * an 8-bit greyscale PNG. `want`: the fill picture's size; a cut-out of
 * another size is refused (SPLIT_SIZES_DIFFER).
 */
export async function splitMask(cutout: Uint8Array, grow: number, signal: AbortSignal, want?: { w: number; h: number }): Promise<Uint8Array> {
  const raw = await pilRaw(cutout)
  if (want && (raw.width !== want.w || raw.height !== want.h)) throw new Error(SPLIT_SIZES_DIFFER)
  const l = await pixelsInWorker(signal, worker => worker.splitMask(raw, grow > 0 ? grow * 2 + 1 : 1), SPLIT_MASK_TIMEOUT)
  return maskPng(l, raw.width, raw.height)
}

/**
 * The picture both calls see, and its size (step 0 above): behind a loader,
 * the loader's picture (`picture` and `fill` null: the file itself already
 * is it); otherwise the file as it is (`picture` null), its fill copy the RGB
 * PIL reads (`fill` null: the file itself, an 8-bit RGB PNG already), made on
 * the Frame's worker.
 */
export async function splitPictures(bytes: Uint8Array, fromLoader: boolean, signal: AbortSignal): Promise<{ picture: Uint8Array | null; fill: Uint8Array | null; w: number; h: number }> {
  if (fromLoader) {
    const { png, w, h } = await rgbTurnedPng(bytes)
    return { picture: png, fill: png, w, h }
  }
  const meta = await pictureMeta(bytes)
  if (isPlainRgbPng(meta, bytes)) return { picture: null, fill: null, w: meta.width!, h: meta.height! }
  const raw = await pilRaw(bytes)
  const rgb = await pixelsInWorker(signal, worker => worker.rgbOf(raw), SPLIT_MASK_TIMEOUT)
  const png = await sharp(rgb, { raw: { width: raw.width, height: raw.height, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer()
  return { picture: null, fill: new Uint8Array(png), w: raw.width, h: raw.height }
}

// ── The plan ──

/** A call's price basis from its card (per call, whatever it makes). */
function callUsd(endpoint: string): number {
  const usd = paidCallUsd({ endpoint })
  if (usd == null) throw new Error('Separate background and foreground has no price yet')
  return usd
}

/** The first answer URL of a call (`_first_output_url`), or the node fails plainly. */
function firstUrl(result: unknown, missing: string): string {
  const url = firstOutputUrl(result)[0]
  if (!url) throw new Error(missing)
  return url
}

/** The node's plan: the cut-out, the mask, the fill. */
export async function planSplitLayers(ctx: PlanContext): Promise<NodePlan> {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const link = inputs.image
  const source = isLink(link) ? ctx.filesFrom(link)[0] : undefined
  if (!source) throw new Error('There is no picture to work on')
  const fillSlug = PHOTO_FILL_SLUGS[photoFillOf(inputs.background_fill)]
  const grow = intOf(inputs.mask_grow, SPLIT_MASK_GROW.default)
  const image = await ctx.toUrl(source)
  // Behind a LoadImage or an Image card: Python's picture is the loader's (EXIF turned, RGB).
  const fromLoader = isLink(link) && !!loaderFileBehind(ctx.prompt, link)
  const cutoutUsd = callUsd(SPLIT_CUTOUT_SLUG)
  const fillUsd = callUsd(fillSlug)
  return {
    kind: 'pipeline', prefix: 'split_subject',
    run: async (io: PipelineIO) => {
      // The pictures, read before any call: a file that can't be read fails the node uncharged.
      const pics = await splitPictures(await io.read(source), fromLoader, io.signal)
      const picture = pics.picture ? await io.handOff(pics.picture, 'split_image.png') : image
      const fillImage = pics.fill === pics.picture ? picture : pics.fill ? await io.handOff(pics.fill, 'split_image.png') : image
      const cut = await io.call({ key: 'cutout', provider: 'replicate', endpoint: SPLIT_CUTOUT_SLUG, payload: cutoutInput(picture), media: 'image', usd: cutoutUsd })
      const cutUrl = firstUrl(cut.result, SPLIT_NO_SUBJECT)
      // The cut-out's bytes, kept for the run (not an asset until the node is done), so a
      // resumed node goes on at the fill without downloading it again.
      const fresh: { got?: { bytes: Uint8Array; contentType: string | null } } = {}
      const keptCutout = await io.savedOnce('cutout', 'cutout', async () => {
        fresh.got = await io.download(cutUrl)
        return io.keep(fresh.got.bytes, 'bin')
      })
      const cutBytes = fresh.got?.bytes ?? await io.read(keptCutout)
      const cutType = fresh.got?.contentType ?? null
      const mask = await io.handOff(await splitMask(cutBytes, grow, io.signal, { w: pics.w, h: pics.h }), 'split_mask.png')
      const fill = await io.call({ key: 'fill', provider: 'replicate', endpoint: fillSlug, payload: fillInput(fillImage, mask), media: 'image', usd: fillUsd })
      const bgUrl = firstUrl(fill.result, SPLIT_NO_BACKGROUND)
      // The background as Python's tensor saves it: alpha dropped (rule 3).
      const background = await io.savedOnce('fill', 'background', async () => {
        const bg = await io.download(bgUrl)
        return io.saveAsset(await answerRgbPng(bg.bytes), { prefix: 'split_background', ext: 'png' })
      })
      // The subject as downloaded (its alpha kept), saved once the node has both pictures.
      const subject: OutputFile = await io.savedOnce('cutout', 'subject', async () =>
        io.saveAsset(cutBytes, { prefix: 'split_subject', ext: answerExt('image', cutBytes, cutType, cutUrl) }))
      const values: Record<number, RunnerValue> = { 0: { kind: 'files', files: [subject] }, 1: { kind: 'files', files: [background] } }
      return { values, ui: { images: [subject, background], animated: [false] } }
    },
  }
}
