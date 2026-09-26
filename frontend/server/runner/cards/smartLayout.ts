/**
 * Smart Layout (step 3, R1.6): comfy_extras/nodes_smart_layout.py
 * SmartLayoutNode.execute, here. No provider, no charge; it counts as work.
 *
 * Python saves each wired image layer's first frame to temp
 * (np.clip(255·x, 0, 255).astype(uint8), RGB or RGBA as the tensor), and
 * POSTs one render request per output to the app's /api/render-template,
 * which fetches the frame back over /view. The runner builds the same
 * request bodies (the pure parts are #shared/runner/smartLayout.ts) and
 * calls the route's own render function directly
 * (server/templates/renderPng.ts). Each image layer is handed as an http
 * address under LAYER_ORIGIN that the card's own fetcher answers from memory
 * with those same pixels, so the renderer's http path (where duotone and
 * grain are baked) runs as it does for Python's /view address; anything else
 * the layout names is fetched under the safe policy (safeFetch.ts).
 * Each render is decoded to RGB as PIL's convert("RGB") does (the alpha
 * dropped as it is) and kept as an 8-bit PNG: the value, a list
 * (is_output_list), one picture per output, which only Save image and
 * Preview image may read (eligibility's listReaders). Each is also written
 * as a live preview under save_live_preview_multi's name,
 * `live_preview_<node>_<safe label>.png`, overwritten each run (the
 * runner's own temp subfolder locally, the user's hosted).
 *
 * Before any picture is read (fix rounds 1 and 2): each output at least
 * 1 × 1, each side at most 16384 and at most 8192² pixels, all within
 * CARD_MAX_PIXELS, at most 256 elements, the layout's text within the
 * renderer's limits (template-grid/limits.ts), and every preview name one
 * the store takes. The image layers' pixel work
 * runs on the Frame's worker (queue, watchdog, Stop), one layer at a time,
 * after every layer's header is read and the total checked; satori and resvg
 * run in the render process (templates/renderProcess.ts), one output at a
 * time, killed when the job's turn ends. Nothing is kept or written once
 * the turn is over (the worker job's `live` signal).
 */
import sharp from 'sharp'
import type { DeriveIO, NodePlan, PlanContext } from '../executors'
import type { OutputFile } from '../types'
import type { RenderRequest } from '../../templates/schema'
import { TemplateImageError, renderTemplatePng, type RenderOptions } from '../../templates/renderPng'
import { TEMPLATE_SIZE_REFUSED as TEMPLATE_SIZE_WORDS, TemplateSizeError } from '../../templates/translate'
import { safeImageFetcher } from '../../templates/safeFetch'
import type { ImageFetcher } from '../../templates/inlineImages'
import { PREVIEW_NAME_RE } from '../results'
import { isLink, type ApiLink } from '#shared/runner/graph'
import { CARD_MAX_PIXELS } from '#shared/runner/eligibility'
import {
  IMAGE_LAYERS, SMART_LAYOUT_MAX_ELEMENTS, TEXT_LAYERS,
  autopopulateForTemplate, brandOf, formatSize, layoutElementCount, livePreviewName,
  outputLabels, parseLayout, parseTextLayers, pySplitlines, resolveOutputs,
  type SmartLayoutOutput,
} from '#shared/runner/smartLayout'
import { pyStrip } from '#shared/runner/pyText'
import { LAYOUT_TOO_BIG, layoutTextProblem } from '#shared/template-grid/limits'
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
export const OUTPUT_TOO_LARGE = LAYOUT_TOO_BIG
export const TOO_MANY_ELEMENTS = `This layout has too many elements to render here (more than ${SMART_LAYOUT_MAX_ELEMENTS}).`
export const FORMAT_ODD = 'A format of this layout has a size that isn’t a number of pixels'
export const PREVIEW_NAME_BAD = 'An output’s label is too long to name its preview file. Use a shorter label.'

/** The renderer the card calls: the route's own function (a seam for tests). */
export const smartLayoutRenderer = { render: (req: RenderRequest, opts: RenderOptions = {}): Promise<Uint8Array> => renderTemplatePng(req, opts) }

/**
 * Where the render finds each image layer: an address no network knows
 * (`.invalid`), answered from memory by the card's own fetcher, so the
 * renderer's http path runs (its photo treatments are baked there) exactly
 * as for Python's /view address.
 */
export const LAYER_ORIGIN = 'http://sailor-runner.invalid/layer/'

/** Python's repr() of a float (str() is the same): shortest digits, exponent past 1e16 or under 1e-4. */
export function pyFloatStr(v: number): string {
  if (Number.isNaN(v)) return 'nan'
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf'
  const [mant, expText] = v.toExponential().split('e') as [string, string]
  const exp = Number(expText)
  const neg = mant.startsWith('-')
  const digits = mant.replace('-', '').replace('.', '')
  let out: string
  if (exp >= 16 || exp < -4) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits
    out = `${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
  }
  else if (exp < 0) out = `0.${'0'.repeat(-exp - 1)}${digits}`
  else {
    const int = digits.slice(0, exp + 1).padEnd(exp + 1, '0')
    const frac = digits.slice(exp + 1)
    out = `${int}.${frac || '0'}`
  }
  return neg ? `-${out}` : out
}

/**
 * str() of a value a layer socket brings (text, or a typed literal). The
 * prompt is JSON: a whole number there reads as a Python int, anything else
 * as a float (1.5, 1e-05, 1e+21).
 */
export function layerText(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 1e21 ? String(v) : pyFloatStr(v)
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

/**
 * The checks made before any picture is read or render run: each output's
 * size (a number, at least one pixel, at most SMART_LAYOUT_MAX_OUTPUT_PIXELS),
 * all of them within CARD_MAX_PIXELS, the elements within
 * SMART_LAYOUT_MAX_ELEMENTS, and each preview's file name one the store takes.
 */
function checkJob(job: Job, nodeId: string): void {
  let total = 0
  const template = job.requests[0]?.template as unknown as Record<string, unknown> | undefined
  if (template && layoutElementCount(template) > SMART_LAYOUT_MAX_ELEMENTS) throw new Error(TOO_MANY_ELEMENTS)
  for (const r of job.requests) {
    const s = formatSize(r.template as unknown as Record<string, unknown>, r.aspect)
    if (s === 'odd') throw new Error(FORMAT_ODD)
    if (s === 'tiny') throw new Error(TEMPLATE_SIZE_WORDS)
    if (s === 'huge') throw new Error(OUTPUT_TOO_LARGE)
    if (!s) continue
    total += s.w * s.h
  }
  // The text the layout shows, its wired text filled in (round 2): the translation's limits.
  const first = job.requests[0]
  if (first) {
    const brand = { ...((first.template as { brand?: Record<string, unknown> }).brand ?? {}), ...(first.brand as Record<string, unknown>) }
    const why = layoutTextProblem(first.template, first.props as Record<string, unknown>, brand)
    if (why) throw new Error(why)
  }
  if (total > CARD_MAX_PIXELS) throw new Error(LAYOUT_TOO_LARGE)
  job.labels.forEach((label, i) => {
    const name = livePreviewName(nodeId, label, i)
    if (!PREVIEW_NAME_RE.test(name)) throw new Error(PREVIEW_NAME_BAD)
  })
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

/** Throws once the job's turn is over (Stop, the watchdog): nothing is written after it. */
const stopped = (live: AbortSignal) => { if (live.aborted) throw new Error('Stopped') }

/** One render, its failure in plain words. */
async function renderOne(req: RenderRequest, opts: RenderOptions): Promise<Uint8Array> {
  try { return await smartLayoutRenderer.render(req, opts) }
  catch (e) {
    if (opts.signal?.aborted) throw new Error('Stopped')
    if (e instanceof TemplateImageError) throw new Error(/private network|larger than 30 MB|longer than 20 seconds|photo treatment/.test(e.message) ? e.message : LAYOUT_IMAGE_FAILED)
    if (e instanceof TemplateSizeError) throw new Error(e.message)
    throw new Error(`The layout could not be rendered (${String((e as Error)?.message ?? e).slice(0, 200)})`)
  }
}

/** The card's fetcher: its own layers from memory, anything else the layout names under the safe policy. */
function layerFetcher(layers: ReadonlyMap<string, Uint8Array>, hosted: boolean): ImageFetcher {
  const safe = safeImageFetcher({ hosted })
  return async (url, o) => {
    if (url.startsWith(LAYER_ORIGIN)) {
      const bytes = layers.get(url.slice(LAYER_ORIGIN.length))
      if (!bytes) throw new Error('A picture in this layout was not made')
      return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, contentType: 'image/png' }
    }
    return safe(url, o)
  }
}

export function planSmartLayout(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const layers = layersOf(ctx)
  // Checked before any picture is read: Python refuses a bad layout, an
  // unknown format or a label that isn't text whatever the pictures are.
  const urls = Object.fromEntries(layers.map(l => [l.key, `${LAYER_ORIGIN}${l.key}`]))
  const job = smartLayoutJob(inputs, urls)
  checkJob(job, ctx.nodeId)
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
        const live = worker.live
        const bytes = new Map<string, Uint8Array>()
        for (const l of layers) {
          stopped(live)
          const raw = await decoded(io, l.source, l.file)
          const p = await worker.savePixels(raw, raw.w, raw.h, false)
          bytes.set(l.key, await png(p.px, p.w, p.h, p.channels))
        }
        const opts: RenderOptions = { fetcher: layerFetcher(bytes, io.hosted), signal: live }
        const kept: OutputFile[] = []
        const images: OutputFile[] = []
        for (let i = 0; i < job.requests.length; i++) {
          stopped(live)
          const rgb = await renderedRgbPng(await renderOne(job.requests[i]!, opts))
          stopped(live)
          kept.push(await io.keep(rgb, 'png'))
          stopped(live)
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
