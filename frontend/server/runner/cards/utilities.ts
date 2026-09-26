/**
 * The picture utilities (step 3, R1.4): small cards that compute from a
 * picture, or make one, here. No provider, no charge.
 *
 *   EmptyImage   — nodes.py EmptyImage.generate: a flat picture of one colour,
 *                  ((color >> 16) & 0xFF) / 0xFF and so on; one kept PNG,
 *                  listed batch_size times
 *   GetImageSize — comfy_extras/nodes_images.py GetImageSize: width, height
 *                  and batch size of the IMAGE tensor (Python also sends the
 *                  size as text to the node; the runner shows none)
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
 * result per file, in order. Pictures made here in float are kept as the 8-bit
 * PNG a hand-off sends (round(255·x), RGB or RGBA as the tensor); masks as the
 * runner keeps them (16-bit, ../pictures/mask.ts).
 */
import sharp from 'sharp'
import type { DeriveIO, NodePlan, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { isLink, type ApiLink } from '#shared/runner/graph'
import { pyIntOf } from '#shared/runner/pyText'
import { pictureSourceOf } from '../compositor/plan'
import { decodeRaw } from '../compositor/decode'
import { core, type Plane, type RawPicture } from '../compositor/plane'
import { pictureRefusal } from '../pictures/pythonView'
import { encodeMask, type Mask } from '../pictures/mask'
import { bilinearResize } from '../pixels/resize'
import { blankBake, loadTextMask, textMaskRender } from './bakeReplay'

export const IMAGE_NO_ALPHA = 'This picture has no alpha channel to make a mask from'
export const PICTURE_NOT_MADE = 'The picture this card reads was not made'
export const PICTURE_UNREAD = 'The picture this card reads could not be read'
export const BATCH_SIZES_DIFFER = 'The pictures this card reads are of different sizes'

const f = Math.fround

/** How many channels Python's tensor has for a picture of this source (compositor/plane.ts toTensor). */
export function tensorChannels(raw: RawPicture): 3 | 4 {
  if (raw.source === 'provider') return 4
  if (raw.source === 'card' && raw.data) {
    for (let i = 3; i < raw.data.length; i += 4) if (raw.data[i]! < 255) return 4
  }
  return 3
}

/** A widget as ComfyUI's validate_inputs converts an INT (int()); eligibility has already checked it. */
function intWidget(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v)
  if (typeof v === 'boolean') return Number(v)
  const n = typeof v === 'string' ? pyIntOf(v) : null
  if (n === null) throw new Error('A setting of this card is not a whole number')
  return n
}

/**
 * The pictures a wire brings, as Python's tensors would hold them (one per
 * file; an empty Image card is Python's 1×1 black). A file the runner can't
 * read exactly is refused in the words the start of a run uses.
 */
async function rawPictures(ctx: PlanContext, io: DeriveIO, link: ApiLink): Promise<RawPicture[]> {
  const source = pictureSourceOf(ctx.prompt, link)
  if (source === 'blank') return [await decodeRaw(null, 'blank')]
  const files = ctx.filesFrom(link)
  if (!files.length) throw new Error(PICTURE_NOT_MADE)
  const out: RawPicture[] = []
  for (const file of files) {
    const bytes = await io.read(file)
    const why = await pictureRefusal(bytes)
    if (why) throw new Error(why)
    try { out.push(await decodeRaw(bytes, source)) }
    catch (e) {
      if (e instanceof Error && /larger than 8192/.test(e.message)) throw new Error('This picture is larger than 8192 × 8192, too large to read here')
      throw new Error(PICTURE_UNREAD)
    }
  }
  return out
}

function pictureLink(ctx: PlanContext, name: string): ApiLink {
  const v = ctx.prompt[ctx.nodeId]!.inputs?.[name]
  if (!isLink(v)) throw new Error('There is no picture wired in')
  return v
}

/** Torch's round(): halves to the even neighbour. */
function roundHalfEven(x: number): number {
  const r = Math.round(x)
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
}

/** A tensor (channels first) as the PNG `_image_tensor_to_data_url` sends: round(255·clamp(x)), 8-bit RGB or RGBA. */
async function handOffPng(p: Plane): Promise<Uint8Array> {
  const n = p.w * p.h
  const px = new Uint8Array(n * p.c)
  for (let c = 0; c < p.c; c++) {
    for (let i = 0; i < n; i++) {
      const v = p.data[c * n + i]!
      px[i * p.c + c] = roundHalfEven(f((v < 0 ? 0 : v > 1 ? 1 : v) * 255))
    }
  }
  const png = await sharp(px, { raw: { width: p.w, height: p.h, channels: p.c as 3 | 4 } }).png({ compressionLevel: 6 }).toBuffer()
  return new Uint8Array(png)
}

const maskValue = async (io: DeriveIO, masks: Mask[]): Promise<RunnerValue> => {
  const files: OutputFile[] = []
  for (const m of masks) files.push(await io.keep(await encodeMask(m), 'png'))
  return { kind: 'mask', files }
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
      const level = (c: number) => roundHalfEven(f(f(c / 0xFF) * 255))
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
  const link = pictureLink(ctx, 'image')
  return {
    kind: 'derive',
    async derive(io) {
      const raws = await rawPictures(ctx, io, link)
      const n = (value: number): RunnerValue => ({ kind: 'number', value, int: true })
      return { values: { 0: n(raws[0]!.w), 1: n(raws[0]!.h), 2: n(raws.length) }, ui: null }
    },
  }
}

// ── Image to mask ────────────────────────────────────────────────────────────

const CHANNELS = ['red', 'green', 'blue', 'alpha'] as const

export function planImageToMask(ctx: PlanContext): NodePlan {
  const link = pictureLink(ctx, 'image')
  const index = CHANNELS.indexOf(ctx.prompt[ctx.nodeId]!.inputs?.channel as typeof CHANNELS[number])
  if (index < 0) throw new Error('This card’s channel is not red, green, blue or alpha')
  return {
    kind: 'derive',
    async derive(io) {
      const masks: Mask[] = []
      for (const raw of await rawPictures(ctx, io, link)) {
        if (index >= tensorChannels(raw)) throw new Error(IMAGE_NO_ALPHA)
        const t = core.toTensor(raw)
        masks.push({ w: t.w, h: t.h, data: core.channel(t, index).slice() })
      }
      return { values: { 0: await maskValue(io, masks) }, ui: null }
    },
  }
}

// ── Text mask with a source ──────────────────────────────────────────────────

export function planTextMaskWithSource(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const file = textMaskRender(inputs.params)
  const link = pictureLink(ctx, 'source')
  return {
    kind: 'derive',
    async derive(io) {
      // As Python: no render gives the blank whatever the source; a render that won't load fails first.
      if (!file) return { values: await blankBake(io), ui: null }
      const mask = await loadTextMask(io, file)
      const sources = (await rawPictures(ctx, io, link)).map(r => core.toTensor(r))
      const { w, h } = sources[0]!
      if (sources.some(s => s.w !== w || s.h !== h)) throw new Error(BATCH_SIZES_DIFFER)
      const sized: Mask = mask.w === w && mask.h === h ? mask : { w, h, data: bilinearResize(mask.data, mask.w, mask.h, 1, w, h) }
      const n = w * h
      const alpha = new Float32Array(n)
      for (let i = 0; i < n; i++) alpha[i] = f(1 - sized.data[i]!)
      const images: OutputFile[] = []
      for (const s of sources) {
        const out = core.plane(s.c, h, w)
        for (let c = 0; c < s.c; c++) {
          for (let i = 0; i < n; i++) out.data[c * n + i] = f(s.data[c * n + i]! * alpha[i]!)
        }
        images.push(await io.keep(await handOffPng(out), 'png'))
      }
      return { values: { 0: { kind: 'files', files: images }, 1: await maskValue(io, [sized]) }, ui: null }
    },
  }
}
