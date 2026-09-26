/**
 * Blend scene's keep_subject in the runner (Task F11b): a Frame's
 * protect_mask wired into it keeps that region of the picture exactly as it
 * was, after the provider's blend (BlendSceneNode.execute,
 * comfy_api_nodes/nodes_replicate.py ~:3017–3040). The same for every Blend
 * model the runner takes; the provider request and its price are unchanged
 * (the composite is local and free).
 *
 * The protect_mask travels between the two nodes as a file, like every other
 * output: a 16-bit greyscale PNG (round(x·65535), so 0 and 1 stay exact),
 * saved beside the Frame's composite in the temp folder. The pixel loops run
 * on the Frame's worker (worker.ts); this thread only reads files, (de)compresses
 * (zlib, off the event loop) and encodes the result PNG (sharp).
 */
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { crc32, deflate, inflate } from 'node:zlib'
import sharp from 'sharp'
import { isLink, type ApiLink } from '#shared/runner/graph'
import { HOSTED_MAX_FRAME_ARTBOARD_PIXELS } from '#shared/runner/eligibility'
import { pyFloatOf } from '#shared/runner/pyText'
import type { PlanContext } from '../executors'
import { decodeRaw, type PictureSource } from './decode'
import { core, type RawPicture } from './plane'
import { MAX_CANVAS_PIXELS } from './render'
import { keepSubjectInWorker } from './worker'

const deflateAsync = promisify(deflate)
const inflateAsync = promisify(inflate)

/** keep_feather's default (the node's widget). */
export const KEEP_FEATHER_DEFAULT = 2.0

export const KEEP_MASK_MISSING = 'The kept region from the Frame is missing. Run the Frame again.'
export const KEEP_EDGE_TOO_WIDE = 'The soft edge around the kept subject is too wide for a picture this small. Lower it and run again.'

/** keep_feather as execute() receives it: ComfyUI's float(), the widget's default when absent. */
export function keepFeatherOf(inputs: Record<string, unknown>): number {
  if (!Object.prototype.hasOwnProperty.call(inputs, 'keep_feather')) return KEEP_FEATHER_DEFAULT
  const v = inputs.keep_feather
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') return pyFloatOf(v) ?? KEEP_FEATHER_DEFAULT
  return KEEP_FEATHER_DEFAULT
}

/** The blur's kernel size for a feather (0: no blur), as Python rounds it. */
export const keepKernelSize = (feather: number): number => core.keepKernelSize(feather)

/** Whether torch's reflect padding (kernel // 2 on each side) fits a picture this size: it must be smaller than each side. */
export function keepEdgeFits(feather: number, w: number, h: number): boolean {
  const pad = keepKernelSize(feather) >> 1
  return pad < w && pad < h
}

// ── The mask file: a 16-bit greyscale PNG ──────────────────────────────────

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)) >>> 0)
  return out
}

/** A 16-bit greyscale PNG around scanlines made by the worker (plane.ts mask16Scanlines). */
export async function maskPngFromScanlines(scanlines: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, w)
  v.setUint32(4, h)
  ihdr[8] = 16 // bit depth
  ihdr[9] = 0 // greyscale
  const idat = new Uint8Array(await deflateAsync(scanlines, { level: 1 }))
  const parts = [PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** The mask file's size and inflated scanlines (the worker unfilters them). Only the 16-bit greyscale PNG the runner writes. */
export async function readMaskPng(bytes: Uint8Array): Promise<{ w: number; h: number; scanlines: Uint8Array }> {
  const bad = () => new Error('The kept region from the Frame could not be read')
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) throw bad()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let w = 0
  let h = 0
  const idat: Uint8Array[] = []
  for (let o = 8; o + 12 <= bytes.length;) {
    const len = view.getUint32(o)
    const type = String.fromCharCode(bytes[o + 4]!, bytes[o + 5]!, bytes[o + 6]!, bytes[o + 7]!)
    const data = bytes.subarray(o + 8, o + 8 + len)
    if (type === 'IHDR') {
      w = view.getUint32(o + 8)
      h = view.getUint32(o + 12)
      if (data[8] !== 16 || data[9] !== 0 || data[12] !== 0) throw bad()
    }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    o += 12 + len
  }
  if (!w || !h || !idat.length) throw bad()
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0))
  let o = 0
  for (const d of idat) { joined.set(d, o); o += d.length }
  const scanlines = new Uint8Array(await inflateAsync(joined).catch(() => { throw bad() }))
  if (scanlines.length < (1 + 2 * w) * h) throw bad()
  return { w, h, scanlines }
}

// ── The plan's step after the provider call ────────────────────────────────

/** What a provider plan does with its answer before saving it (Blend scene's keep_subject). */
export interface KeepStep {
  /** Folded into the request's fingerprint: an earlier result is reused only for the same kept region and edge. */
  fingerprint: { mask: string; feather: number }
  /** The provider's answer (the downloaded file) → the PNG the node saves. */
  apply(answer: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>
}

/** A picture's size as its source decodes it (an Image card turns by EXIF; a provider download does not). */
async function pictureSize(bytes: Uint8Array, source: PictureSource): Promise<{ w: number; h: number }> {
  if (source === 'blank') return { w: 1, h: 1 }
  const meta = await sharp(bytes, { pages: 1, page: 0, limitInputPixels: false }).metadata()
    .catch(() => { throw new Error('A picture for the kept subject could not be read') })
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  const turned = (source === 'card' || source === 'load') && (meta.orientation ?? 1) >= 5
  return turned ? { w: h, h: w } : { w, h }
}

function tooLargeWords(max: number): string {
  const side = Math.round(Math.sqrt(max))
  return `This picture is larger than ${side} × ${side}, too large to keep its subject exact`
}

/**
 * The keep_subject step of a Blend scene whose keep_subject is wired (from a
 * Frame's protect_mask: eligibility). Checked before the call, so a picture
 * the step can't finish is refused before anything is sent or charged: the
 * mask file is there, the picture fits the size limit, and the blur's edge
 * padding fits the picture (Python makes the call first and then fails).
 */
export async function planKeepSubject(
  ctx: PlanContext,
  inputs: Record<string, unknown>,
  image: { link: ApiLink; source: PictureSource },
): Promise<KeepStep> {
  const read = ctx.readFile
  if (!read) throw new Error('The runner cannot read pictures here')
  const keepLink = inputs.keep_subject
  if (!isLink(keepLink)) throw new Error(KEEP_MASK_MISSING)
  const maskFile = ctx.filesFrom(keepLink)[0]
  if (!maskFile) throw new Error(KEEP_MASK_MISSING)
  const baseFile = image.source === 'blank' ? null : ctx.filesFrom(image.link)[0] ?? null
  if (!baseFile && image.source !== 'blank') throw new Error('There is no picture to blend')
  const feather = keepFeatherOf(inputs)

  const maskBytes = await read(maskFile).catch(() => { throw new Error(KEEP_MASK_MISSING) })
  await readMaskPng(maskBytes)
  const size = await pictureSize(baseFile ? await read(baseFile) : new Uint8Array(0), image.source)
  const max = ctx.hosted ? HOSTED_MAX_FRAME_ARTBOARD_PIXELS : MAX_CANVAS_PIXELS
  if (size.w * size.h > max) throw new Error(tooLargeWords(max))
  if (!keepEdgeFits(feather, size.w, size.h)) throw new Error(KEEP_EDGE_TOO_WIDE)

  return {
    fingerprint: { mask: createHash('sha256').update(maskBytes).digest('hex'), feather },
    async apply(answer, signal) {
      // Read again now: the plan's reads are let go during the provider wait.
      const [maskNow, baseNow] = await Promise.all([
        read(maskFile).catch(() => { throw new Error(KEEP_MASK_MISSING) }),
        baseFile ? read(baseFile) : Promise.resolve(null),
      ])
      const mask = await readMaskPng(maskNow)
      const pic = async (bytes: Uint8Array | null, source: PictureSource): Promise<RawPicture> => {
        try { return await decodeRaw(bytes, source) }
        catch (e) {
          if (e instanceof Error && /too large/.test(e.message)) throw new Error(tooLargeWords(max))
          throw new Error('A picture for the kept subject could not be read')
        }
      }
      const base = await pic(baseNow, image.source)
      const edited = await pic(answer, 'provider')
      if (base.w * base.h > max || edited.w * edited.h > MAX_CANVAS_PIXELS) throw new Error(tooLargeWords(max))
      let out
      try {
        out = await keepSubjectInWorker({ base, edited, mask: mask.scanlines, mw: mask.w, mh: mask.h, feather }, { signal })
      }
      catch (e) {
        if (e instanceof Error && e.message === 'KEEP_PAD') throw new Error(KEEP_EDGE_TOO_WIDE)
        throw e
      }
      // save_generation_output: an RGB PNG of the clamped result, 255·x truncated.
      const buf = await sharp(out.px, { raw: { width: out.w, height: out.h, channels: 3 } }).png().toBuffer()
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    },
  }
}
