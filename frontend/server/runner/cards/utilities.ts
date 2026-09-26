/**
 * The picture utilities (step 3, R1.4): small cards that compute from a
 * picture, or make one, here. No provider, no charge.
 *
 *   EmptyImage   — nodes.py EmptyImage.generate: a flat picture of one colour,
 *                  ((color >> 16) & 0xFF) / 0xFF and so on; one kept PNG,
 *                  listed batch_size times
 *   GetImageSize — comfy_extras/nodes_images.py GetImageSize: width, height
 *                  and batch size of the IMAGE tensor, from each file's header
 *                  (Python also sends the size as text to the node; the
 *                  runner shows none)
 *   ImageToMask  — comfy_extras/nodes_mask.py ImageToMask: one channel of the
 *                  tensor as the mask; alpha on a picture with none fails
 *   TextMask     — comfy_extras/nodes_text_mask.py with a source: the render's
 *                  mask resized to the source (bilinear, align_corners=False)
 *                  when the sizes differ; image = source × (1 − mask), every
 *                  channel (alpha too when the source has it)
 *
 * A picture wired in is read as the tensor Python holds: decodeRaw with the
 * wire's source (compositor/plan.ts pictureSourceOf), which decides its
 * channels and whether it is EXIF turned. A batch (several files) gives one
 * result per file, in order; a file listed more than once (Empty image's
 * batch) is worked on once. Pictures made here in float are kept as the 8-bit
 * PNG a hand-off sends (round(255·x), RGB or RGBA as the tensor), or, when
 * only Save image / Preview image read it, as they write it (trunc(255·x),
 * onlySavesRead); masks as the runner keeps them (16-bit, ../pictures/mask.ts).
 *
 * Fix round 1: the pixel work runs on the Frame's worker (../pixels/core.ts
 * through compositor/worker.ts pixelsInWorker: its queue, 2-minute watchdog
 * and Stop), one picture at a time (decode here → worker → encode here →
 * let go), after every file's header is read and the total checked against
 * CARD_MAX_PIXELS.
 */
import sharp from 'sharp'
import type { DeriveIO, NodePlan, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { GATE_CLASS, isLink, linksOf, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { pyIntOf } from '#shared/runner/pyText'
import { CARD_MAX_PIXELS } from '#shared/runner/eligibility'
import { pictureSourceOf } from '../compositor/plan'
import { decodeRaw, type PictureSource } from '../compositor/decode'
import type { RawPicture } from '../compositor/plane'
import { maskPngFromScanlines } from '../compositor/keep'
import { pixelsInWorker, type HandOff8 } from '../compositor/worker'
import { pictureMeta, pictureRefusalOf } from '../pictures/pythonView'
import { pixels } from '../pixels/core'
import { blankBake, loadTextMaskLuma, textMaskRender } from './bakeReplay'

export const IMAGE_NO_ALPHA = 'This picture has no alpha channel to make a mask from'
export const PICTURE_NOT_MADE = 'The picture this card reads was not made'
export const PICTURE_UNREAD = 'The picture this card reads could not be read'
export const BATCH_SIZES_DIFFER = 'The pictures this card reads are of different sizes'
export const PICTURES_TOO_LARGE = 'The pictures this card reads are too large to work on together (more than 268 million pixels). Use fewer or smaller pictures.'

/** How many channels Python's tensor has for a picture of this source (compositor/plane.ts toTensor). */
export function tensorChannels(raw: RawPicture): 3 | 4 {
  return pixels.tensorChannels(raw)
}

/** A widget as ComfyUI's validate_inputs converts an INT (int()); eligibility has already checked it. */
function intWidget(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v)
  if (typeof v === 'boolean') return Number(v)
  const n = typeof v === 'string' ? pyIntOf(v) : null
  if (n === null) throw new Error('A setting of this card is not a whole number')
  return n
}

const keyOf = (f: OutputFile) => `${f.type}:${f.subfolder}:${f.filename}`

/** What a picture wire brings: its source kind, and its files (none for Python's 1×1 blank). */
export interface Wired { source: PictureSource; files: OutputFile[] }

function wired(ctx: PlanContext, name: string): Wired {
  const v = ctx.prompt[ctx.nodeId]!.inputs?.[name]
  if (!isLink(v)) throw new Error('There is no picture wired in')
  const link: ApiLink = v
  const source = pictureSourceOf(ctx.prompt, link)
  if (source === 'blank') return { source, files: [] }
  const files = ctx.filesFrom(link)
  if (!files.length) throw new Error(PICTURE_NOT_MADE)
  return { source, files }
}

const stopped = (io: DeriveIO) => { if (io.signal.aborted) throw new Error('Stopped') }

/**
 * Each distinct file's size as the tensor holds it (EXIF turned for an Image
 * card and LoadImage), from its header only. A file the runner can't read
 * exactly is refused in the words the start of a run uses; with `cap`, more
 * than CARD_MAX_PIXELS in all is refused before any pixel is decoded.
 */
export async function sizes(io: DeriveIO, w: Wired, cap: boolean): Promise<Map<string, { w: number; h: number }>> {
  const out = new Map<string, { w: number; h: number }>()
  let total = 0
  for (const file of w.files) {
    const key = keyOf(file)
    if (out.has(key)) continue
    stopped(io)
    const bytes = await io.read(file)
    const meta = await pictureMeta(bytes)
    const why = pictureRefusalOf(meta, bytes)
    if (why) throw new Error(why)
    if (!meta.width || !meta.height) throw new Error(PICTURE_UNREAD)
    const turned = (w.source === 'card' || w.source === 'load') && (meta.orientation ?? 1) >= 5
    const size = turned ? { w: meta.height, h: meta.width } : { w: meta.width, h: meta.height }
    total += size.w * size.h
    if (cap && total > CARD_MAX_PIXELS) throw new Error(PICTURES_TOO_LARGE)
    out.set(key, size)
  }
  return out
}

/** One file as sharp decodes it for its source (RGBA8), or Python's blank. */
export async function decoded(io: DeriveIO, source: PictureSource, file: OutputFile | null): Promise<RawPicture> {
  if (!file) return decodeRaw(null, 'blank')
  try { return await decodeRaw(await io.read(file), source) }
  catch (e) {
    if (e instanceof Error && /larger than 8192/.test(e.message)) throw new Error('This picture is larger than 8192 × 8192, too large to read here')
    throw new Error(PICTURE_UNREAD)
  }
}

/** The 8-bit pixels a hand-off sends, as a PNG. */
async function handOffPng(p: HandOff8): Promise<Uint8Array> {
  const png = await sharp(p.px, { raw: { width: p.w, height: p.h, channels: p.channels } }).png({ compressionLevel: 6 }).toBuffer()
  return new Uint8Array(png)
}

/**
 * Works through a wire's pictures one distinct file at a time (Python's blank
 * as one picture): `each` makes that file's result; the results come back in
 * the batch's order.
 */
async function perFile(io: DeriveIO, w: Wired, each: (file: OutputFile | null) => Promise<OutputFile>): Promise<OutputFile[]> {
  if (!w.files.length) return [await each(null)]
  const made = new Map<string, OutputFile>()
  for (const file of w.files) {
    const key = keyOf(file)
    if (made.has(key)) continue
    stopped(io)
    made.set(key, await each(file))
  }
  return w.files.map(f => made.get(keyOf(f))!)
}

// ── Empty image ──────────────────────────────────────────────────────────────

export function planEmptyImage(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const w = intWidget(inputs.width)
  const h = intWidget(inputs.height)
  const batch = intWidget(inputs.batch_size)
  const color = intWidget(inputs.color)
  return {
    kind: 'derive',
    async derive(io) {
      // torch.full of c / 0xFF (a double) in float32; sent as round(255·x).
      const level = (c: number) => pixels.roundHalfEven(Math.fround(Math.fround(c / 0xFF) * 255))
      const png = await sharp({
        create: { width: w, height: h, channels: 3, background: { r: level((color >> 16) & 0xFF), g: level((color >> 8) & 0xFF), b: level(color & 0xFF) } },
      }).png({ compressionLevel: 6 }).toBuffer()
      const file = await io.keep(new Uint8Array(png), 'png')
      return { values: { 0: { kind: 'files', files: Array.from({ length: batch }, () => file) } }, ui: null }
    },
  }
}

// ── Get image size ───────────────────────────────────────────────────────────

export function planGetImageSize(ctx: PlanContext): NodePlan {
  const w = wired(ctx, 'image')
  return {
    kind: 'derive',
    async derive(io) {
      const n = (value: number): RunnerValue => ({ kind: 'number', value, int: true })
      if (!w.files.length) return { values: { 0: n(1), 1: n(1), 2: n(1) }, ui: null }
      const first = (await sizes(io, w, false)).get(keyOf(w.files[0]!))!
      return { values: { 0: n(first.w), 1: n(first.h), 2: n(w.files.length) }, ui: null }
    },
  }
}

// ── Image to mask ────────────────────────────────────────────────────────────

const CHANNELS = ['red', 'green', 'blue', 'alpha'] as const

export function planImageToMask(ctx: PlanContext): NodePlan {
  const w = wired(ctx, 'image')
  const index = CHANNELS.indexOf(ctx.prompt[ctx.nodeId]!.inputs?.channel as typeof CHANNELS[number])
  if (index < 0) throw new Error('This card’s channel is not red, green, blue or alpha')
  return {
    kind: 'derive',
    async derive(io) {
      await sizes(io, w, true)
      const files = await pixelsInWorker(io.signal, worker => perFile(io, w, async (file) => {
        const m = await worker.channelMask(await decoded(io, w.source, file), index)
        return io.keep(await maskPngFromScanlines(m.scanlines, m.w, m.h), 'png')
      }))
      return { values: { 0: { kind: 'mask', files } }, ui: null }
    },
  }
}

// ── Text mask with a source ──────────────────────────────────────────────────

/** The classes that write a picture as save_images does: trunc(f32(255·x)), not a hand-off's round (R1.5 follow-up). */
const TRUNC_READERS: ReadonlySet<string> = new Set(['SaveImage', 'PreviewImage'])

/**
 * Whether everything that reads this output reads it the way save_images
 * does: Save image and Preview image, followed on through what hands a
 * picture on unchanged (an Image card fed by a wire, a Gate). A provider, a
 * Frame or a utility among the readers (or no reader at all) keeps the
 * hand-off's rounding.
 */
export function onlySavesRead(prompt: ApiPrompt, id: string, slot: number, depth = 0): boolean {
  if (depth > 64) return false
  let readers = 0
  for (const [rid, node] of Object.entries(prompt)) {
    for (const l of linksOf(node)) {
      if (l.from !== id || l.slot !== slot) continue
      readers++
      if (TRUNC_READERS.has(node.class_type)) continue
      const passes = (node.class_type === 'Image' && l.input === 'images') || (node.class_type === GATE_CLASS && l.input === 'data_in')
      if (!passes || !onlySavesRead(prompt, rid, 0, depth + 1)) return false
    }
  }
  return readers > 0
}

export function planTextMaskWithSource(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const render = textMaskRender(inputs.params)
  const w = wired(ctx, 'source')
  // Kept as the pixels its readers write: Python's Save image truncates the float (R1.5 follow-up).
  const trunc = onlySavesRead(ctx.prompt, ctx.nodeId, 0)
  return {
    kind: 'derive',
    async derive(io) {
      // As Python: no render gives the blank whatever the source; a render that won't load fails first.
      if (!render) return { values: await blankBake(io), ui: null }
      const luma = await loadTextMaskLuma(io, render)
      const all = [...(await sizes(io, w, true)).values()]
      const size = all[0] ?? { w: 1, h: 1 }
      if (all.some(s => s.w !== size.w || s.h !== size.h)) throw new Error(BATCH_SIZES_DIFFER)
      return await pixelsInWorker(io.signal, async (worker) => {
        const scanlines = await worker.clipBegin(luma.l, luma.w, luma.h, size.w, size.h)
        const mask = await io.keep(await maskPngFromScanlines(scanlines, size.w, size.h), 'png')
        const images = await perFile(io, w, async (file) => {
          const out = await worker.clip(await decoded(io, w.source, file), trunc)
          return io.keep(await handOffPng(out), 'png')
        })
        return { values: { 0: { kind: 'files', files: images }, 1: { kind: 'mask', files: [mask] } }, ui: null }
      })
    },
  }
}
