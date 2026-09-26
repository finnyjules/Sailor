/**
 * The bake-replay cards (step 3, R1.3): each hands on the file its studio
 * already baked into the node's saved settings, loaded as its Python node
 * loads it. No render, no provider, no charge.
 *
 *   Scene3DStudio — comfy_extras/nodes_scene3d.py: beauty, depth and normal,
 *                   each EXIF turned, RGB; a blank name or any failure to
 *                   load is a 1024×1024 flat placeholder
 *   TextOnPath    — comfy_extras/nodes_text_on_path.py: the render EXIF
 *                   turned, RGB, and 1 − its alpha band as the mask (zeros
 *                   without one); no render: a 16×16 black image, a mask of ones
 *   TextMask      — comfy_extras/nodes_text_mask.py, no source wired (R1.4
 *                   takes a source): the render's convert("L"), not turned;
 *                   mask 1 − L/255, image 1 − mask as grey RGB; no render as
 *                   Text on path
 *
 * Pictures go on as the 8-bit PNG a Python loader's tensor would hand a
 * provider (../pictures/pythonView.ts), or the file itself when it already
 * is that picture; masks as the runner keeps them (../pictures/mask.ts).
 */
import sharp from 'sharp'
import type { DeriveIO, NodePlan, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { SCENE3D_BAKES, bakeParams, parseInputFileRef } from '../inputs'
import {
  PICTURE_16_BIT, PICTURE_32_BIT, PICTURE_CMYK, PICTURE_GIF_SEE_THROUGH, PICTURE_UNREADABLE,
  gifFirstFrameSeeThrough, pictureMeta, pngColourType, rgbTurnedPng,
} from '../pictures/pythonView'
import { encodeMask, loadImageMask, type Mask } from '../pictures/mask'
import { MAX_INPUT_PIXELS } from '../compositor/decode'
import { pyTruthy } from '#shared/runner/pyText'

export const TEXT_ON_PATH_UNLOADABLE = 'Text on path couldn’t load its picture. Change a setting to bake it again.'
export const TEXT_MASK_UNLOADABLE = 'Text mask couldn’t load its picture. Change a setting to bake it again.'

/**
 * The refusals of a picture Python reads its own way (16-bit, 32-bit, CMYK,
 * a see-through GIF): the node fails in these words rather than hand on
 * something else. Every other failure to load is Python's own failure.
 */
const PICTURE_REFUSALS: ReadonlySet<string> = new Set([PICTURE_16_BIT, PICTURE_32_BIT, PICTURE_CMYK, PICTURE_GIF_SEE_THROUGH])
const isRefusal = (e: unknown): e is Error => e instanceof Error && PICTURE_REFUSALS.has(e.message)

/** PIL's convert("L") of one RGB pixel: ITU-R 601-2 luma in 16-bit fixed point (L24). */
export function pilLuma(r: number, g: number, b: number): number {
  return (r * 19595 + g * 38470 + b * 7471 + 0x8000) >>> 16
}

// ── Flat pictures and masks ──────────────────────────────────────────────────

const flatPngs = new Map<string, Promise<Uint8Array>>()

/** A flat 8-bit RGB PNG, made once per size and colour. */
function flatPng(w: number, h: number, rgb: readonly [number, number, number]): Promise<Uint8Array> {
  const key = `${w}x${h}:${rgb.join(',')}`
  let p = flatPngs.get(key)
  if (!p) {
    p = sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
      .png({ compressionLevel: 6 }).toBuffer().then(b => new Uint8Array(b))
    flatPngs.set(key, p)
  }
  return p
}

const filesValue = (f: OutputFile): RunnerValue => ({ kind: 'files', files: [f] })
const maskValue = async (io: DeriveIO, m: Mask): Promise<RunnerValue> => ({ kind: 'mask', files: [await io.keep(await encodeMask(m), 'png')] })

/** `_blank()` of the type nodes: a 16×16 black image and a 16×16 mask of ones. */
async function blankBake(io: DeriveIO): Promise<Record<number, RunnerValue>> {
  return {
    0: filesValue(await io.keep(await flatPng(16, 16, [0, 0, 0]), 'png')),
    1: await maskValue(io, { w: 16, h: 16, data: new Float32Array(256).fill(1) }),
  }
}

/** A picture as a Python loader holds it: the file itself when it already is that picture, else the kept PNG. */
async function pythonPicture(io: DeriveIO, file: OutputFile, bytes: Uint8Array): Promise<{ file: OutputFile; w: number; h: number }> {
  const { png, w, h } = await rgbTurnedPng(bytes)
  return { file: png ? await io.keep(png, 'png') : file, w, h }
}

// ── 3D Studio ────────────────────────────────────────────────────────────────

/**
 * `_placeholder`'s flat colours as a provider is sent them (round(255·x)):
 * beauty (0.5, 0.5, 0.5), depth black, normal (0.5, 0.5, 1.0). A Frame reads
 * 128/255, within 1/255 of Python's 0.5.
 */
const SCENE3D_PLACEHOLDERS: readonly (readonly [number, number, number])[] = [[128, 128, 128], [0, 0, 0], [128, 128, 255]]

export function planScene3D(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  return {
    kind: 'derive',
    async derive(io) {
      const values: Record<number, RunnerValue> = {}
      for (const [slot, name] of SCENE3D_BAKES.entries()) {
        // `_load_input_image`: a blank name, or any failure to load, gives None → the placeholder.
        const file = parseInputFileRef(inputs[name])
        let made: OutputFile | null = null
        if (file) {
          try { made = (await pythonPicture(io, file, await io.read(file))).file }
          catch (e) {
            if (isRefusal(e)) throw e
          }
        }
        values[slot] = filesValue(made ?? await io.keep(await flatPng(1024, 1024, SCENE3D_PLACEHOLDERS[slot]!), 'png'))
      }
      return { values, ui: null }
    },
  }
}

// ── Text on path, Text mask ──────────────────────────────────────────────────

/** The render a bake card names (`params.rendered`), or null for none (Python's `if not rendered`). Throws `unloadable` for a name no file can have. */
function renderedFile(params: unknown, unloadable: string): OutputFile | null {
  const rendered = bakeParams(params).rendered
  if (!pyTruthy(rendered)) return null
  const f = typeof rendered === 'string' ? parseInputFileRef(rendered) : null
  if (!f) throw new Error(unloadable)
  return f
}

async function readRendered(io: DeriveIO, file: OutputFile, unloadable: string): Promise<Uint8Array> {
  try { return await io.read(file) }
  catch { throw new Error(unloadable) }
}

/**
 * Whether PIL gives the file an "A" band: a PNG of colour type 4 or 6 (a
 * palette with transparency stays mode P, which has none); a GIF never (P);
 * any other format when sharp sees alpha.
 */
async function hasAlphaBand(bytes: Uint8Array): Promise<boolean> {
  const type = pngColourType(bytes)
  if (type !== null) return type === 4 || type === 6
  const meta = await pictureMeta(bytes)
  return meta.format !== 'gif' && !!meta.hasAlpha
}

export function planTextOnPath(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const file = renderedFile(inputs.params, TEXT_ON_PATH_UNLOADABLE)
  return {
    kind: 'derive',
    async derive(io) {
      if (!file) return { values: await blankBake(io), ui: null }
      const bytes = await readRendered(io, file, TEXT_ON_PATH_UNLOADABLE)
      let picture: Awaited<ReturnType<typeof pythonPicture>>
      let mask: Mask
      try {
        picture = await pythonPicture(io, file, bytes)
        mask = await hasAlphaBand(bytes)
          ? await loadImageMask(bytes)
          : { w: picture.w, h: picture.h, data: new Float32Array(picture.w * picture.h) }
      }
      catch (e) {
        if (isRefusal(e)) throw e
        throw new Error(TEXT_ON_PATH_UNLOADABLE)
      }
      return { values: { 0: filesValue(picture.file), 1: await maskValue(io, mask) }, ui: null }
    },
  }
}

/** PIL's `Image.open(path).convert("L")` (first frame, not EXIF turned), 8-bit. Refuses as rgbTurnedPng does. */
async function pilL(bytes: Uint8Array): Promise<{ w: number; h: number; l: Uint8Array }> {
  const meta = await pictureMeta(bytes)
  if (meta.depth === 'ushort' || meta.depth === 'short') throw new Error(PICTURE_16_BIT)
  if (meta.depth && meta.depth !== 'uchar') throw new Error(meta.depth === 'char' ? PICTURE_UNREADABLE : PICTURE_32_BIT)
  if (meta.space === 'cmyk') throw new Error(PICTURE_CMYK)
  if (meta.format === 'gif' && gifFirstFrameSeeThrough(bytes)) throw new Error(PICTURE_GIF_SEE_THROUGH)
  const { data, info } = await sharp(bytes, { pages: 1, page: 0, ignoreIcc: true, limitInputPixels: MAX_INPUT_PIXELS })
    .toColourspace('srgb').removeAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  if (info.channels !== 3) throw new Error(PICTURE_UNREADABLE)
  const n = info.width * info.height
  const l = new Uint8Array(n)
  for (let i = 0; i < n; i++) l[i] = pilLuma(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!)
  return { w: info.width, h: info.height, l }
}

/** Text mask with no source: the mask, and the mask as a grey picture. */
export function planTextMask(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const file = renderedFile(inputs.params, TEXT_MASK_UNLOADABLE)
  return {
    kind: 'derive',
    async derive(io) {
      if (!file) return { values: await blankBake(io), ui: null }
      const bytes = await readRendered(io, file, TEXT_MASK_UNLOADABLE)
      let grey: Awaited<ReturnType<typeof pilL>>
      try { grey = await pilL(bytes) }
      catch (e) {
        if (isRefusal(e)) throw e
        throw new Error(TEXT_MASK_UNLOADABLE)
      }
      const { w, h, l } = grey
      const f = Math.fround
      const mask = new Float32Array(w * h)
      const rgb = new Uint8Array(w * h * 3)
      for (let i = 0; i < mask.length; i++) {
        // float32 throughout, as torch: mask = 1 − L/255; image = 1 − mask; sent as round(255·x).
        const m = f(1 - f(l[i]! / 255))
        mask[i] = m
        const v = Math.round(f(Math.min(1, Math.max(0, f(1 - m))) * 255))
        rgb[i * 3] = v
        rgb[i * 3 + 1] = v
        rgb[i * 3 + 2] = v
      }
      const png = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer()
      return { values: { 0: filesValue(await io.keep(new Uint8Array(png), 'png')), 1: await maskValue(io, { w, h, data: mask }) }, ui: null }
    },
  }
}
