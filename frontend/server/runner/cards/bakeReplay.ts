/**
 * The bake-replay cards (step 3, R1.3): each hands on the file its studio
 * already baked into the node's saved settings, loaded as its Python node
 * loads it. No render, no provider, no charge.
 *
 *   Scene3DStudio — comfy_extras/nodes_scene3d.py: beauty, depth and normal,
 *                   each EXIF turned, RGB; a blank name or a missing file
 *                   is a 1024×1024 flat placeholder (Python's for any
 *                   failure); a file there but unreadable here is refused
 *   TextOnPath    — comfy_extras/nodes_text_on_path.py: the render EXIF
 *                   turned, RGB, and 1 − its alpha band as the mask (zeros
 *                   without one); no render: a 16×16 black image, a mask of ones
 *   TextMask      — comfy_extras/nodes_text_mask.py, no source wired (with
 *                   one: ./utilities.ts, R1.4): the render's convert("L"), not
 *                   turned; mask 1 − L/255, image 1 − mask as grey RGB; no
 *                   render as Text on path
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
  pictureMeta, pictureRefusalOf, pngColourType, rgbTurnedPng,
} from '../pictures/pythonView'
import { GATE_CLASS, isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { PROVIDER_TYPES } from '#shared/runner/eligibility'
import { actionPassThrough } from '../generators/actions'
import type { RunnerFamily } from '#shared/runner/families'
import { encodeMask, loadImageMask, type Mask } from '../pictures/mask'
import { floatReadBy, maskTensorBytes } from '../effects/tensorFiles'
import { MAX_INPUT_PIXELS } from '../compositor/decode'
import { pyTruthy } from '#shared/runner/pyText'
import { IMAGE_LAYERS } from '#shared/runner/smartLayout'
import { EFFECT_PICTURE_ANIMATED, EFFECT_START_SIZED_CLASSES, effectFamilyOn, effectSchemaOf } from '#shared/runner/effects'

export const TEXT_ON_PATH_UNLOADABLE = 'Text on path couldn’t load its picture. Change a setting to bake it again.'
export const TEXT_MASK_UNLOADABLE = 'Text mask couldn’t load its picture. Change a setting to bake it again.'

/**
 * The refusals of a picture Python reads its own way (16-bit, 32-bit, CMYK,
 * a see-through GIF): the node fails in plain words rather than hand on
 * something else. Every other failure to load is Python's own failure.
 */
const PICTURE_REFUSALS: ReadonlySet<string> = new Set([PICTURE_16_BIT, PICTURE_32_BIT, PICTURE_CMYK, PICTURE_GIF_SEE_THROUGH])
const isRefusal = (e: unknown): e is Error => e instanceof Error && PICTURE_REFUSALS.has(e.message)

/** Each bake card's name on the canvas and how its bake is made again. */
const BAKE_CARDS: Readonly<Record<string, { label: string; again: string }>> = {
  Scene3DStudio: { label: '3D Studio', again: 'Open 3D Studio and bake it again.' },
  TextOnPath: { label: 'Text on path', again: 'Change a setting to bake it again.' },
  TextMask: { label: 'Text mask', again: 'Change a setting to bake it again.' },
}

const WHY_BAKE: Readonly<Record<string, string>> = {
  [PICTURE_16_BIT]: 'is 16-bit, which Sailor can’t read',
  [PICTURE_32_BIT]: 'is 32-bit, which Sailor can’t read',
  [PICTURE_CMYK]: 'is CMYK, which Sailor can’t read',
  [PICTURE_GIF_SEE_THROUGH]: 'is a GIF with see-through parts, which Sailor can’t read',
  [PICTURE_UNREADABLE]: 'is a kind of file Sailor can’t read',
}

/** A bake card's refusal of its saved picture, in plain words (`why`: one of the PICTURE_* words). */
export function bakeRefusalWords(classType: string, why: string): string {
  const card = BAKE_CARDS[classType]
  if (!card) return why
  return `${card.label}’s saved picture ${WHY_BAKE[why] ?? WHY_BAKE[PICTURE_UNREADABLE]}. ${card.again}`
}

/**
 * The files the taken picture cards of a prompt will load, for the check at
 * the start of a run (engine.ts: a file one would refuse is refused before
 * anything is held): 3D Studio's bakes, Text on path's and Text mask's
 * render, a LoadImage that runs as a card (with `cards` on; off, the
 * Frame reads its file as before), and the Image card file behind a picture
 * utility's picture wire (R1.4) or behind a Smart Layout's image layer (R1.6).
 * A card whose settings name no file names none.
 */
export function cardPictureFiles(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>): CardPictureFile[] {
  if (!families.has('cards')) return []
  const out: CardPictureFile[] = []
  for (const [nodeId, n] of Object.entries(prompt)) {
    const inputs = n.inputs ?? {}
    const add = (raw: unknown) => {
      const file = parseInputFileRef(raw)
      if (file) out.push({ nodeId, classType: n.class_type, file })
    }
    if (n.class_type === 'Scene3DStudio') for (const name of SCENE3D_BAKES) add(inputs[name])
    else if (n.class_type === 'TextOnPath' || n.class_type === 'TextMask') add(bakeParams(inputs.params).rendered)
    else if (n.class_type === 'LoadImage') add(inputs.image)
    // The picture utilities (R1.4) decode what reaches them as Python's tensor:
    // an Image card's own file behind the wire is checked here too. (Text mask
    // reads its source only when it has a render, as Python.)
    const read = Object.prototype.hasOwnProperty.call(PICTURE_READS, n.class_type) ? inputs[PICTURE_READS[n.class_type]!] : undefined
    if (isLink(read) && (n.class_type !== 'TextMask' || pyTruthy(bakeParams(inputs.params).rendered))) {
      const behind = cardFileBehind(prompt, read)
      if (behind) out.push({ ...behind, classType: 'Image' })
    }
    // An effect (R2 rule 9) decodes each picture wired in as Python's tensor:
    // an Image card's own file behind the wire is checked here too; and, as
    // for Save image, a loader's animation is refused (Python's loaders make a
    // batch of every frame, and the effect a result for each; R2.1 fix round 1).
    const fx = effectFamilyOn(n.class_type, families) ? effectSchemaOf(n.class_type) : undefined
    for (const input of fx?.images ?? []) {
      const v = inputs[input.name]
      if (!isLink(v)) continue
      const behind = cardFileBehind(prompt, v)
      if (behind) out.push({ ...behind, classType: 'Image' })
      const loader = loaderFileBehind(prompt, v)
      // An effect that changes the picture's size (R2.7: Resize, Crop), or has a size cap of its own
      // (Kaleidoscope): its output is sized from this file's header too.
      const resized = EFFECT_START_SIZED_CLASSES.includes(n.class_type) ? { nodeId, classType: n.class_type, inputs } : undefined
      // Painter (R2.8) takes image[:1], the first frame alone: an animation is no batch to it.
      const frames = n.class_type === 'Painter' ? {} : { oneFrame: true as const, animated: EFFECT_PICTURE_ANIMATED }
      if (loader) out.push({ ...loader, ...frames, ...(resized ? { resized } : {}) })
    }
    // Painter's painter file (R2.8), read as a card reads its file (16-bit, CMYK… refused before the hold).
    if (fx && n.class_type === 'Painter' && !isLink(inputs.mask)) add(inputs.mask)
    // Smart Layout (R1.6) decodes each image layer's first frame as Python's tensor.
    if (n.class_type === 'SmartLayout') {
      for (const key of IMAGE_LAYERS) {
        const v = inputs[key]
        const behind = isLink(v) ? cardFileBehind(prompt, v) : null
        if (behind) out.push({ ...behind, classType: 'Image' })
      }
    }
    // Save image and Preview image (R1.5) save every frame of the batch a
    // loader makes of an animation; the runner hands on its first frame, so
    // the loader's file must be one frame.
    if ((n.class_type === 'SaveImage' || n.class_type === 'PreviewImage') && isLink(inputs.images)) {
      const behind = loaderFileBehind(prompt, inputs.images)
      if (behind) out.push({ ...behind, oneFrame: true })
    }
  }
  return out
}

/**
 * A file cardPictureFiles names; `oneFrame`: one with several frames is
 * refused too, in `animated`'s words (PICTURE_ANIMATED when absent).
 */
export interface CardPictureFile {
  nodeId: string; classType: string; file: OutputFile; oneFrame?: true; animated?: string
  /** The effect reading this file that changes its size (R2.7): its output is checked against the caps from the file's header (effects/plan.ts effectOutRefusal). */
  resized?: { nodeId: string; classType: string; inputs: Record<string, unknown> }
}

/** The picture input of each picture utility (R1.4). */
const PICTURE_READS: Readonly<Record<string, string>> = { GetImageSize: 'image', ImageToMask: 'image', TextMask: 'source' }

/**
 * The Image card whose own file a picture wire brings, followed back through
 * what hands a picture on unchanged (an Image card fed by a wire, a Gate, an
 * action with nothing to do), as compositor/plan.ts pictureSourceOf follows it.
 */
function cardFileBehind(prompt: ApiPrompt, link: ApiLink, depth = 0): { nodeId: string; file: OutputFile } | null {
  const node = prompt[link[0]]
  if (!node || depth > 64) return null
  const inputs = node.inputs ?? {}
  let next: unknown
  if (node.class_type === 'Image') {
    if (!isLink(inputs.images)) {
      const file = parseInputFileRef(inputs.image)
      return file ? { nodeId: link[0], file } : null
    }
    next = inputs.images
  }
  else if (node.class_type === GATE_CLASS) next = inputs.data_in
  else {
    const pass = PROVIDER_TYPES.has(node.class_type) ? actionPassThrough(node.class_type, inputs) : null
    next = pass ? inputs[pass] : undefined
  }
  return isLink(next) ? cardFileBehind(prompt, next, depth + 1) : null
}

/**
 * The loader whose own file a picture wire brings, a LoadImage's or an Image
 * card's (Python loads every frame of either as a batch), followed back as
 * cardFileBehind follows it; null when the picture is made in the run.
 */
export function loaderFileBehind(prompt: ApiPrompt, link: ApiLink, depth = 0): { nodeId: string; classType: string; file: OutputFile } | null {
  const node = prompt[link[0]]
  if (!node || depth > 64) return null
  const inputs = node.inputs ?? {}
  let next: unknown
  if (node.class_type === 'LoadImage') {
    const file = link[1] === 0 ? parseInputFileRef(inputs.image) : null
    return file ? { nodeId: link[0], classType: 'LoadImage', file } : null
  }
  if (node.class_type === 'Image') {
    if (!isLink(inputs.images)) {
      const file = parseInputFileRef(inputs.image)
      return file ? { nodeId: link[0], classType: 'Image', file } : null
    }
    next = inputs.images
  }
  else if (node.class_type === GATE_CLASS) next = inputs.data_in
  else {
    const pass = PROVIDER_TYPES.has(node.class_type) ? actionPassThrough(node.class_type, inputs) : null
    next = pass ? inputs[pass] : undefined
  }
  return isLink(next) ? loaderFileBehind(prompt, next, depth + 1) : null
}

/** What the start of a run says of a card's file that would be refused (`why`: one of the PICTURE_* words). */
export function cardPictureRefusal(classType: string, why: string): string {
  return BAKE_CARDS[classType] ? bakeRefusalWords(classType, why) : why
}

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
/** A mask value: the 16-bit PNG, and with `float` (an effect or a Frame reads it) the float32 tensor too (R2.8 fix round 1). */
const maskValue = async (io: DeriveIO, m: Mask, float = false): Promise<RunnerValue> => ({
  kind: 'mask',
  files: [await io.keep(await encodeMask(m), 'png')],
  ...(float ? { tensors: [await io.keep(maskTensorBytes(m), 'bin')] } : {}),
})

/** `_blank()` of the type nodes: a 16×16 black image and a 16×16 mask of ones (Text mask gives it with a source too). */
export async function blankBake(io: DeriveIO, float = false): Promise<Record<number, RunnerValue>> {
  return {
    0: filesValue(await io.keep(await flatPng(16, 16, [0, 0, 0]), 'png')),
    1: await maskValue(io, { w: 16, h: 16, data: new Float32Array(256).fill(1) }, float),
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
        // `_load_input_image`: a blank name, or a file that isn't there, gives None → the placeholder.
        // A file there is but can't be read is refused, never the grey placeholder
        // (the start of the run already refused it; this is the backstop).
        const file = parseInputFileRef(inputs[name])
        let made: OutputFile | null = null
        let bytes: Uint8Array | null = null
        if (file) {
          try { bytes = await io.read(file) }
          catch { bytes = null }
        }
        if (file && bytes) {
          try { made = (await pythonPicture(io, file, bytes)).file }
          catch (e) {
            throw new Error(bakeRefusalWords('Scene3DStudio', isRefusal(e) ? e.message : PICTURE_UNREADABLE))
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
  const float = floatReadBy(ctx.prompt, ctx.nodeId, 1)
  return {
    kind: 'derive',
    async derive(io) {
      if (!file) return { values: await blankBake(io, float), ui: null }
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
        if (isRefusal(e)) throw new Error(bakeRefusalWords('TextOnPath', e.message))
        throw new Error(TEXT_ON_PATH_UNLOADABLE)
      }
      return { values: { 0: filesValue(picture.file), 1: await maskValue(io, mask, float) }, ui: null }
    },
  }
}

/** PIL's `Image.open(path).convert("L")` (first frame, not EXIF turned), 8-bit. Refuses as rgbTurnedPng does. */
async function pilL(bytes: Uint8Array): Promise<{ w: number; h: number; l: Uint8Array }> {
  const meta = await pictureMeta(bytes)
  const refused = pictureRefusalOf(meta, bytes)
  if (refused) throw new Error(refused)
  const { data, info } = await sharp(bytes, { pages: 1, page: 0, ignoreIcc: true, limitInputPixels: MAX_INPUT_PIXELS })
    .toColourspace('srgb').removeAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
  if (info.channels !== 3) throw new Error(PICTURE_UNREADABLE)
  const n = info.width * info.height
  const l = new Uint8Array(n)
  for (let i = 0; i < n; i++) l[i] = pilLuma(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!)
  return { w: info.width, h: info.height, l }
}

/**
 * Text mask's render (`params.rendered`), or null for none (Python's blank);
 * throws for a name no file can have. With or without a source (R1.4).
 */
export function textMaskRender(params: unknown): OutputFile | null {
  return renderedFile(params, TEXT_MASK_UNLOADABLE)
}

/** `_load_mask`'s picture: the render's convert("L"), 8-bit. */
export async function loadTextMaskLuma(io: DeriveIO, file: OutputFile): Promise<{ w: number; h: number; l: Uint8Array }> {
  const bytes = await readRendered(io, file, TEXT_MASK_UNLOADABLE)
  try { return await pilL(bytes) }
  catch (e) {
    if (isRefusal(e)) throw new Error(bakeRefusalWords('TextMask', e.message))
    throw new Error(TEXT_MASK_UNLOADABLE)
  }
}

/** `_load_mask`: the render's convert("L") as the mask 1 − L/255 (float32, as torch). */
export async function loadTextMask(io: DeriveIO, file: OutputFile): Promise<Mask> {
  const { w, h, l } = await loadTextMaskLuma(io, file)
  const f = Math.fround
  const data = new Float32Array(w * h)
  for (let i = 0; i < data.length; i++) data[i] = f(1 - f(l[i]! / 255))
  return { w, h, data }
}

/** Text mask with no source: the mask, and the mask as a grey picture. */
export function planTextMask(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const file = textMaskRender(inputs.params)
  const float = floatReadBy(ctx.prompt, ctx.nodeId, 1)
  return {
    kind: 'derive',
    async derive(io) {
      if (!file) return { values: await blankBake(io, float), ui: null }
      const mask = await loadTextMask(io, file)
      const { w, h } = mask
      const f = Math.fround
      const rgb = new Uint8Array(w * h * 3)
      for (let i = 0; i < mask.data.length; i++) {
        // float32 throughout, as torch: image = 1 − mask; sent as round(255·x).
        const v = Math.round(f(Math.min(1, Math.max(0, f(1 - mask.data[i]!))) * 255))
        rgb[i * 3] = v
        rgb[i * 3 + 1] = v
        rgb[i * 3 + 2] = v
      }
      const png = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer()
      return { values: { 0: filesValue(await io.keep(new Uint8Array(png), 'png')), 1: await maskValue(io, mask, float) }, ui: null }
    },
  }
}
