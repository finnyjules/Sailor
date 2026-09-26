/**
 * Smart Layout (step 3, R1.6): comfy_extras/nodes_smart_layout.py
 * SmartLayoutNode.execute, here. No provider, no charge; it counts as work.
 *
 * Python saves each wired image layer's first frame to temp
 * (np.clip(255·x, 0, 255).astype(uint8), RGB or RGBA as the tensor), and
 * POSTs one render request per output to the app's /api/render-template,
 * which fetches the frame back over /view. The runner builds the same
 * request bodies (the pure parts are #shared/runner/smartLayout.ts), hands
 * each image layer as a `data:image/png` URL of those same pixels (it has no
 * HTTP origin; inlineTreeImages passes data URLs through) and calls the
 * route's own render function directly (server/templates/renderPng.ts).
 * Each render is decoded to RGB as PIL's convert("RGB") does (the alpha
 * dropped as it is) and kept as an 8-bit PNG: the value, a list
 * (is_output_list), one picture per output, which only Save image and
 * Preview image may read (eligibility's listReaders). Each is also written
 * as a live preview under save_live_preview_multi's name,
 * `live_preview_<node>_<safe label>.png`, overwritten each run (the
 * runner's own temp subfolder locally, the user's hosted).
 *
 * The image layers' pixel work runs on the Frame's worker (queue, watchdog,
 * Stop), one layer at a time, after every layer's header is read and the
 * total checked against CARD_MAX_PIXELS; the outputs' pixels are capped the
 * same way (eligibility, when the layout is known; here again). The render
 * itself is satori and resvg, as the route runs it for the ComfyUI path:
 * one output at a time, in the worker's queue.
 */
import sharp from 'sharp'
import type { DeriveIO, NodePlan, PlanContext } from '../executors'
import type { OutputFile } from '../types'
import type { RenderRequest } from '../../templates/schema'
import { TemplateImageError, renderTemplatePng } from '../../templates/renderPng'
import { isLink, type ApiLink } from '#shared/runner/graph'
import { CARD_MAX_PIXELS } from '#shared/runner/eligibility'
import {
  IMAGE_LAYERS, TEXT_LAYERS, autopopulateForTemplate, brandOf, formatSize, livePreviewName,
  outputLabels, parseLayout, parseTextLayers, pySplitlines, resolveOutputs,
  type SmartLayoutOutput,
} from '#shared/runner/smartLayout'
import { pyStrip } from '#shared/runner/pyText'
import type { PictureSource } from '../compositor/decode'
import { pictureSourceOf } from '../compositor/plan'
import { pixelsInWorker } from '../compositor/worker'
import { filesOf } from '../values'
import { fromTextMask } from './saveImage'
import { PICTURE_NOT_MADE, decoded, sizes } from './utilities'

export {
  autopopulateForTemplate, outputLabels, parseLayout, parseTextLayers, pySplitlines, resolveOutputs,
}

export const LAYOUT_TOO_LARGE = `This layout’s outputs are too large to render here (more than ${Math.floor(CARD_MAX_PIXELS / 1_000_000)} million pixels in all). Render fewer or smaller formats.`
export const LAYERS_TOO_LARGE = `This layout’s pictures are too large to work on together (more than ${Math.floor(CARD_MAX_PIXELS / 1_000_000)} million pixels). Use fewer or smaller pictures.`
export const LAYOUT_IMAGE_FAILED = 'A picture in this layout could not be loaded'

/** The renderer the card calls: the route's own function (a seam for tests). */
export const smartLayoutRenderer = { render: (req: RenderRequest): Promise<Uint8Array> => renderTemplatePng(req) }

/** str() of a value a layer socket brings (text, or a typed literal). */
function layerText(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

/** What execute builds before rendering: one request per output, and the outputs' labels. */
interface Job { requests: RenderRequest[]; outputs: SmartLayoutOutput[]; labels: string[] }

/**
 * execute up to the renders (nodes_smart_layout.py:524-570): the layout,
 * the text layers (blank ones skipped), the image layers' URLs, the brand
 * (kit under the wired brand), the default elements, the outputs and labels.
 */
function smartLayoutJob(inputs: Record<string, unknown>, imageUrls: Readonly<Record<string, string>>): Job {
  const template = parseLayout(inputs.layout)
  const props: Record<string, string> = {}
  for (const key of TEXT_LAYERS) {
    const v = inputs[key]
    if (v === undefined || v === null || isLink(v)) continue
    const text = layerText(v)
    if (pyStrip(text)) props[key] = text
  }
  for (const key of IMAGE_LAYERS) {
    const url = imageUrls[key]
    if (url) props[key] = url
  }
  const brand = brandOf(inputs.brand ?? '', inputs.brand_kit ?? '')
  autopopulateForTemplate(template, props)
  const aspects = typeof inputs.aspects === 'string' ? inputs.aspects : layerText(inputs.aspects ?? '')
  const outputs = resolveOutputs(template, aspects)
  const requests = outputs.map(o => ({
    template, aspect: o.format, outputId: (o.id ?? null) as string | undefined, props, brand,
  }) as unknown as RenderRequest)
  return { requests, outputs, labels: outputLabels(outputs, template) }
}

/**
 * The render request bodies Python POSTs, in output order, for the node's
 * inputs (wired text already substituted) and each wired image layer's URL.
 */
export function smartLayoutRequests(inputs: Record<string, unknown>, imageUrls: Readonly<Record<string, string>>): RenderRequest[] {
  return smartLayoutJob(inputs, imageUrls).requests
}

/** The pixels all the outputs render, from their formats' sizes (a format the template lacks fails the render). */
function outputPixels(job: Job): number {
  let total = 0
  for (const r of job.requests) {
    const s = formatSize(r.template as unknown as Record<string, unknown>, r.aspect)
    if (s === 'odd') throw new Error('This layout’s format size is not a number of pixels')
    if (s) total += s.w * s.h
  }
  return total
}

/** A wired image layer: how its picture decodes (its source), and the file of its first frame (none for the blank). */
interface Layer { key: string; source: PictureSource; file: OutputFile | null }

function layersOf(ctx: PlanContext): Layer[] {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const out: Layer[] = []
  for (const key of IMAGE_LAYERS) {
    const v = inputs[key]
    if (!isLink(v)) continue
    const link: ApiLink = v
    const found = pictureSourceOf(ctx.prompt, link)
    const source: PictureSource = found === 'card' && fromTextMask(ctx.prompt, link) ? 'made' : found
    if (source === 'blank') { out.push({ key, source, file: null }); continue }
    const value = ctx.valueFrom?.(link)
    const files = value ? filesOf(value) : ctx.filesFrom(link)
    // Python saves the tensor's first frame.
    if (!files.length) throw new Error(PICTURE_NOT_MADE)
    out.push({ key, source, file: files[0]! })
  }
  return out
}

async function png(px: Uint8Array, w: number, h: number, channels: 3 | 4): Promise<Uint8Array> {
  return new Uint8Array(await sharp(px, { raw: { width: w, height: h, channels } }).png({ compressionLevel: 1 }).toBuffer())
}

/** PIL's open(...).convert("RGB") of the renderer's PNG, as an 8-bit RGB PNG (compress level 1, as the preview). */
export async function renderedRgbPng(bytes: Uint8Array): Promise<Uint8Array> {
  const { data, info } = await sharp(bytes, { ignoreIcc: true, limitInputPixels: false })
    .toColourspace('srgb').removeAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  if (info.channels !== 3) throw new Error('The layout’s render could not be read')
  return png(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, 3)
}

const stopped = (io: DeriveIO) => { if (io.signal.aborted) throw new Error('Stopped') }

/** One render, its failure in plain words. */
async function renderOne(req: RenderRequest): Promise<Uint8Array> {
  try { return await smartLayoutRenderer.render(req) }
  catch (e) {
    if (e instanceof TemplateImageError) throw new Error(LAYOUT_IMAGE_FAILED)
    throw new Error(`The layout could not be rendered (${String((e as Error)?.message ?? e).slice(0, 200)})`)
  }
}

export function planSmartLayout(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const layers = layersOf(ctx)
  // Checked before any picture is read: Python refuses a bad layout, an
  // unknown format or a label that isn't text whatever the pictures are.
  const planned = smartLayoutJob(inputs, Object.fromEntries(layers.map(l => [l.key, `layer:${l.key}`])))
  if (outputPixels(planned) > CARD_MAX_PIXELS) throw new Error(LAYOUT_TOO_LARGE)
  return {
    kind: 'derive',
    async derive(io) {
      let total = 0
      for (const l of layers) {
        if (!l.file) continue
        const size = [...(await sizes(io, { source: l.source, files: [l.file] }, false)).values()][0]!
        total += size.w * size.h
        if (total > CARD_MAX_PIXELS) throw new Error(LAYERS_TOO_LARGE)
      }
      const { images, kept } = await pixelsInWorker(io.signal, async (worker) => {
        const urls: Record<string, string> = {}
        for (const l of layers) {
          stopped(io)
          const raw = await decoded(io, l.source, l.file)
          const p = await worker.savePixels(raw, raw.w, raw.h, false)
          urls[l.key] = `data:image/png;base64,${Buffer.from(await png(p.px, p.w, p.h, p.channels)).toString('base64')}`
        }
        const job = smartLayoutJob(inputs, urls)
        const kept: OutputFile[] = []
        const images: OutputFile[] = []
        for (let i = 0; i < job.requests.length; i++) {
          stopped(io)
          const rgb = await renderedRgbPng(await renderOne(job.requests[i]!))
          stopped(io)
          kept.push(await io.keep(rgb, 'png'))
          images.push(await io.savePreviewAs(rgb, { filename: livePreviewName(io.nodeId, job.labels[i]!, i) }))
        }
        return { images, kept }
      })
      return {
        values: { 0: { kind: 'files', files: kept, list: true } },
        ui: { images, animated: [false] },
      }
    },
  }
}
