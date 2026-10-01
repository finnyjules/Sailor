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
import { promisify } from 'node:util'
import { crc32, deflate, inflate } from 'node:zlib'
import sharp from 'sharp'
import { isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { HOSTED_MAX_FRAME_ARTBOARD_PIXELS } from '#shared/runner/eligibility'
import { pyFloatOf } from '#shared/runner/pyText'
import type { PlanContext } from '../executors'
import type { OutputFile } from '../types'
import { parseInputFileRef } from '../inputs'
import { linkPictureBound, pictureSize as pictureSizeOf } from '../../utils/graphInputPixels'
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
  /**
   * The sha256 of the picture sent (null: an empty Image card's blank) and of
   * the mask, as kept in the runner's held store: recorded on the node, so a
   * resumed node composites from the same bytes.
   */
  held: KeepHeld
  /** The provider's answer (the downloaded file) → the PNG the node saves. */
  apply(answer: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>
}

export interface KeepHeld { base: string | null; mask: string }

/** The node's own place for bytes kept between its send and its result (server/runner/heldBytes.ts). */
export interface KeepHold {
  put(bytes: Uint8Array): Promise<string>
  get(sha: string): Promise<Uint8Array | null>
}

export const KEEP_HELD_MISSING = 'The pictures kept for this blend are gone, so its kept subject can’t be laid back. Run it again.'

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

/** The largest picture, answer or mask the keep step works on: the Frame's artboard cap in hosted, the canvas cap here. */
export function keepMaxPixels(hosted: boolean): number {
  return hosted ? HOSTED_MAX_FRAME_ARTBOARD_PIXELS : MAX_CANVAS_PIXELS
}

export function tooLargeWords(max: number): string {
  const side = Math.round(Math.sqrt(max))
  return `This picture is larger than ${side} × ${side}, too large to keep its subject exact`
}

/**
 * The keep_subject step of a Blend scene whose keep_subject is wired (from a
 * Frame's protect_mask: eligibility). Checked before the call, so a picture
 * the step can't finish is refused before anything is sent or charged: the
 * mask file is there, the picture fits the size limit, and the blur's edge
 * padding fits the picture (Python makes the call first and then fails).
 *
 * The picture and the mask are read once here, through the node's one read
 * of each file (the very bytes the hand-off uploads), and kept in the
 * runner's held store (fix round 1): ComfyUI empties its temp folder on every
 * start and exit, so after the provider wait the composite is made from the
 * kept bytes, never from temp. A resumed node (`held` recorded at the send)
 * plans from the kept bytes too.
 */
export async function planKeepSubject(
  ctx: PlanContext,
  inputs: Record<string, unknown>,
  image: { link: ApiLink; source: PictureSource },
  held?: KeepHeld,
): Promise<KeepStep> {
  const hold = ctx.hold
  if (!hold) throw new Error('The runner cannot keep pictures here')
  const keepLink = inputs.keep_subject
  if (!isLink(keepLink)) throw new Error(KEEP_MASK_MISSING)
  const feather = keepFeatherOf(inputs)

  let maskBytes: Uint8Array
  let baseBytes: Uint8Array | null
  let kept: KeepHeld | null = null
  if (held) {
    // Resuming: the bytes kept at the send.
    const m = await hold.get(held.mask)
    const b = held.base ? await hold.get(held.base) : null
    if (!m || (held.base && !b)) throw new Error(KEEP_HELD_MISSING)
    maskBytes = m
    baseBytes = b
    kept = held
  }
  else {
    const read = ctx.readFile
    if (!read) throw new Error('The runner cannot read pictures here')
    const maskFile = ctx.filesFrom(keepLink)[0]
    if (!maskFile) throw new Error(KEEP_MASK_MISSING)
    const baseFile = image.source === 'blank' ? null : ctx.filesFrom(image.link)[0] ?? null
    if (!baseFile && image.source !== 'blank') throw new Error('There is no picture to blend')
    maskBytes = await read(maskFile).catch(() => { throw new Error(KEEP_MASK_MISSING) })
    baseBytes = baseFile ? await read(baseFile) : null
    const m = await readMaskPng(maskBytes)
    // R8.1: a mask from Image to mask can be any size (it is brought to the picture's): within the same cap, before the call.
    if (m.w * m.h > keepMaxPixels(!!ctx.hosted)) throw new Error(tooLargeWords(keepMaxPixels(!!ctx.hosted)))
  }

  const size = await pictureSize(baseBytes ?? new Uint8Array(0), image.source)
  const max = keepMaxPixels(!!ctx.hosted)
  if (size.w * size.h > max) throw new Error(tooLargeWords(max))
  if (!keepEdgeFits(feather, size.w, size.h)) throw new Error(KEEP_EDGE_TOO_WIDE)
  kept ??= { mask: await hold.put(maskBytes), base: baseBytes ? await hold.put(baseBytes) : null }
  const k = kept

  return {
    fingerprint: { mask: k.mask, feather },
    held: k,
    async apply(answer, signal) {
      // The kept bytes (never ComfyUI's temp folder, which a restart empties).
      const maskNow = await hold.get(k.mask)
      const baseNow = k.base ? await hold.get(k.base) : null
      if (!maskNow || (k.base && !baseNow)) throw new Error(KEEP_HELD_MISSING)
      const mask = await readMaskPng(maskNow)
      if (mask.w * mask.h > max) throw new Error(tooLargeWords(max))
      const pic = async (bytes: Uint8Array | null, source: PictureSource): Promise<RawPicture> => {
        try { return await decodeRaw(bytes, source) }
        catch (e) {
          if (e instanceof Error && /too large/.test(e.message)) throw new Error(tooLargeWords(max))
          throw new Error('A picture for the kept subject could not be read')
        }
      }
      const base = await pic(baseNow, image.source)
      const edited = await pic(answer, 'provider')
      // The same cap for the answer as for the picture (hosted 4096²): no Blend
      // model answers larger, and this bounds the worker's memory.
      if (base.w * base.h > max || edited.w * edited.h > max) throw new Error(tooLargeWords(max))
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

// ── The start pass (R8.1) ──────────────────────────────────────────────────

/**
 * Blend scene's kept subject from Image to mask (Product shot's "keep the
 * product exact"), at the start of the run, before the hold: the mask's
 * picture and the picture blended, each bounded from its Load image header
 * (linkPictureBound), must fit the keep step's cap. A size that can't be
 * known yet is left to the node's own check, which still comes before the
 * call. The Frame's protect_mask path (F11b) is unchanged: the Frame's own
 * caps bound it.
 */
export async function keepStartRefusal(
  prompt: ApiPrompt,
  o: { hosted: boolean; read?: (f: OutputFile) => Promise<Uint8Array> },
): Promise<{ message: string; nodeId: string; classType: string } | null> {
  const readFile = async (value: string) => {
    const f = o.read ? parseInputFileRef(value) : null
    return f && o.read ? pictureSizeOf(await o.read(f)) : null
  }
  const max = keepMaxPixels(o.hosted)
  for (const [nodeId, n] of Object.entries(prompt)) {
    if (n.class_type !== 'BlendSceneNode') continue
    const inputs = n.inputs ?? {}
    const keep = inputs.keep_subject
    if (!isLink(keep)) continue
    const from = prompt[keep[0]]
    if (from?.class_type !== 'ImageToMask' || !isLink(from.inputs?.image)) continue
    for (const link of [from.inputs.image, inputs.image]) {
      if (!isLink(link)) continue
      const px = await linkPictureBound(prompt, link, readFile)
      if (px !== null && Number.isFinite(px) && px > max) return { message: tooLargeWords(max), nodeId, classType: 'BlendSceneNode' }
    }
  }
  return null
}
