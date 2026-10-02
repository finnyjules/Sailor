/**
 * Upscale (R3.5's UpscaleImageNode) on Real-ESRGAN, in tiles (step 3, R11.6
 * fix round 3, the controller's ruling): Replicate's Real-ESRGAN refuses a
 * picture over 2 096 704 pixels ("greater than the max size that fits in GPU
 * memory", measured 2026-10-01), so a larger one is never sent whole. It is
 * cut into the same tiles as Upscale (2×) (shared/runner/upscaleTiles.ts),
 * one call each at a whole scale, each tile's tone matched to the source and
 * faded back (./tiles.ts upscaleInTiles), then, for a scale that isn't whole,
 * resized to the size Real-ESRGAN makes (`int(side × scale)`, its `outscale`)
 * with sharp's Lanczos. A picture at or under the limit keeps R3.5's one call
 * (./repair.ts planRepair).
 *
 * Priced as it runs: each tile at its own size on the card; the hold is the
 * most tiles a picture of the measured size can make (editSettings.ts
 * realEsrganTiles), each at the limit, and the run never sends more. The
 * charge is the delivered tiles' dollars added up and marked up once (as
 * Upscale (2×), engine.ts chargeableCredits). A tile that fails, or Stop,
 * charges none of them (each answered tile marked undelivered: R11.5's
 * pieces ruling). Python's picture is RGB here (Real-ESRGAN's own alpha pass
 * isn't tiled): a see-through picture loses its alpha in tiles.
 */
import sharp from 'sharp'
import { tileCount } from '#shared/runner/upscaleTiles'
import { pricedInputPixels, realEsrganMaxPixels, realEsrganTiles } from '#shared/pricing/editSettings'
import { paidCallUsd } from '#shared/pricing/paidRates'
import { NO_FAMILIES } from '#shared/runner/families'
import { isLink } from '#shared/runner/graph'
import type { Derived, NodePlan, PipelineIO, PlanContext } from '../executors'
import type { OutputFile } from '../types'
import { MediaError } from '../../media/run'
import { png8 } from '../effects/plan'
import { pictureMeta, rgbTurnedPng } from '../pictures/pythonView'
import { loaderSourceOf } from '../pictureHandoff'
import { answerRgb, resizeRgb8 } from './localModels'
import { firstOutputUrl } from './repair'
import { upscaleInTiles } from './tiles'

const SLUG = 'nightmareai/real-esrgan'

/** The largest upscaled picture made in tiles (pixels): four times the largest picture Sailor takes (12288 × 1536). */
export const REAL_ESRGAN_TILED_MAX_OUT = 4 * 12288 * 1536

/** Plain words for what this path refuses. */
export const REAL_ESRGAN_TILE_WORDS = {
  tooBig: 'This picture is too large to upscale this much here. Lower the scale or use a smaller picture.',
  moreThanHeld: 'This picture is larger than was measured before the run, so it was stopped before anything was sent.',
  noAnswer: 'The service sent back no upscaled picture.',
} as const

/** The picture as Python's tensor has it (RGB8): a loader's file turned by its EXIF orientation; any other as stored. */
export async function pictureRgb(ctx: PlanContext, file: OutputFile, link: unknown): Promise<{ rgb: Uint8Array; w: number; h: number } | null> {
  if (!ctx.readFile) return null
  let bytes = await ctx.readFile(file)
  const loader = !!loaderSourceOf(ctx.prompt, link, ctx.families ?? NO_FAMILIES)
  // Its size from the header first: a picture at or under the limit is never decoded here (R3.5's one call).
  const meta = await pictureMeta(bytes)
  if (meta.width && meta.height && meta.width * meta.height <= realEsrganMaxPixels()) return null
  if (loader) bytes = (await rgbTurnedPng(bytes)).png ?? bytes
  return answerRgb(bytes)
}

/**
 * The tiled plan for a picture over the limit (`pic`: its RGB). `scale`:
 * the node's `scale_factor` as it is sent.
 */
export function planRealEsrganTiles(ctx: PlanContext, pic: { rgb: Uint8Array; w: number; h: number }, scale: number, faceEnhance: boolean): NodePlan {
  const cap = realEsrganMaxPixels()
  // Each tile at a whole scale (Real-ESRGAN takes any; a whole one keeps the tiles' places exact), then resized.
  const k = Math.max(1, Math.ceil(scale - 1e-9))
  const outW = Math.max(1, Math.trunc(pic.w * scale))
  const outH = Math.max(1, Math.trunc(pic.h * scale))
  if (pic.w * pic.h * k * k > REAL_ESRGAN_TILED_MAX_OUT) throw new Error(REAL_ESRGAN_TILE_WORDS.tooBig)
  // Never more tiles than the hold covers: the most a picture of the measured size makes.
  const held = realEsrganTiles(pricedInputPixels(ctx.inputPixels))
  if (tileCount(pic.w, pic.h, cap) > held) throw new Error(REAL_ESRGAN_TILE_WORDS.moreThanHeld)
  const answered: string[] = []
  const tileUrl = (io: PipelineIO, png: Uint8Array, i: number) => {
    const name = `upscale_tile_${i}.png`
    return ctx.bytesToUrl ? ctx.bytesToUrl({ filename: name, subfolder: '', type: 'temp' }, png) : io.handOff(png, name)
  }
  const work = async (io: PipelineIO): Promise<Derived> => {
    let last = ''
    const { rgb } = await upscaleInTiles({
      rgb: pic.rgb, w: pic.w, h: pic.h, scale: k, cap, signal: io.signal,
      stopped: () => new MediaError('stopped'),
      send: async (i, tile, tw, th) => {
        last = `esrgan-tile-${i}`
        const usd = paidCallUsd({ endpoint: SLUG, inputPixels: tw * th })
        if (usd == null) throw new Error('Upscale has no price yet')
        const image = await tileUrl(io, await png8(tile, tw, th, 3, 6), i)
        const got = await io.call({ key: last, provider: 'replicate', endpoint: SLUG, payload: { image, scale: k, face_enhance: faceEnhance }, media: 'image', usd })
        const url = firstOutputUrl(got.result)[0]
        if (!url) {
          await io.undelivered?.(last, 'no-file')
          throw new Error(REAL_ESRGAN_TILE_WORDS.noAnswer)
        }
        answered.push(last)
        const a = await answerRgb((await io.download(url)).bytes)
        return a.w === k * tw && a.h === k * th ? a.rgb : resizeRgb8(a.rgb, a.w, a.h, k * tw, k * th, 'round')
      },
    })
    // Kept once, on the last tile's call (a resumed node keeps no second copy).
    const file = await io.savedOnce(last, 'tiled', async () => {
      const raw = { width: k * pic.w, height: k * pic.h, channels: 3 as const }
      const img = sharp(rgb, { raw, limitInputPixels: false })
      const png = outW === raw.width && outH === raw.height
        ? await img.png({ compressionLevel: 6 }).toBuffer()
        : await img.resize(outW, outH, { fit: 'fill', kernel: 'lanczos3' }).png({ compressionLevel: 6 }).toBuffer()
      if (io.signal.aborted) throw new MediaError('stopped')
      return io.saveAsset(new Uint8Array(png), { prefix: 'upscale', ext: 'png' })
    })
    // Python returns no ui for Upscale.
    return { values: { 0: { kind: 'files', files: [file] } }, ui: null }
  }
  return {
    kind: 'pipeline', prefix: 'upscale',
    run: async (io: PipelineIO) => {
      answered.length = 0
      try {
        return await work(io)
      }
      catch (e) {
        // Delivers only when every tile did: the answered ones charge nothing (Sailor absorbs them).
        for (const key of answered) await io.undelivered?.(key, 'sailor-fault')
        throw e
      }
    },
  }
}

/** Whether R3.5's Upscale goes in tiles: Real-ESRGAN, a wired picture over the service's limit. */
export async function realEsrganTiledPlan(ctx: PlanContext, inputs: Record<string, unknown>, file: OutputFile, scale: number, faceEnhance: boolean): Promise<NodePlan | null> {
  const link = inputs.image
  if (!isLink(link)) return null
  const pic = await pictureRgb(ctx, file, link)
  if (!pic || pic.w * pic.h <= realEsrganMaxPixels()) return null
  return planRealEsrganTiles(ctx, pic, scale, faceEnhance)
}
