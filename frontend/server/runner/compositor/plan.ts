/**
 * The Compositor node as a runner plan: find each wired picture's file and
 * how Python would have decoded it (by the node it came from), then render
 * locally. Eligibility (shared/runner/eligibility.ts, family `frame`) has
 * already refused everything this does not do: baked motion, the video
 * output read, the protect_mask read by anything but Blend scene's
 * keep_subject, a mask not from a LoadImage, invalid widgets.
 *
 * When a node reads the protect_mask (Task F11b), the render makes it too,
 * as a 16-bit greyscale PNG (keep.ts); the engine saves it beside the
 * composite as the node's second output.
 */
import { GATE_CLASS, isLink, linksOf, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { HOSTED_MAX_FRAME_ARTBOARD_PIXELS, PROVIDER_TYPES } from '#shared/runner/eligibility'
import { actionPassThrough } from '../generators/actions'
import { bakeParams, parseInputFileRef } from '../inputs'
import { pyTruthy } from '#shared/runner/pyText'
import type { NodePlan, PlanContext } from '../executors'
import type { OutputFile } from '../types'
import { decodeRaw, decodeRawMask, pngFromPreview8, type PictureSource } from './decode'
import { maskPngFromScanlines } from './keep'
import { decodeMask, type Mask } from '../pictures/mask'
import type { Picture } from './plane'
import { MAX_LAYERS, type Loader } from './render'
import { renderFrameInWorker } from './worker'

/**
 * How the node at the end of this wire hands its picture to Python, which
 * decides the tensor's channels (see decode.ts). Pass-through nodes (a
 * loaded-from-upstream Image card, a Gate, a nano action with nothing to do)
 * are followed back to the node that made the picture.
 */
export function pictureSourceOf(prompt: ApiPrompt, link: ApiLink, depth = 0): PictureSource {
  if (depth > 64) throw new Error('The Frame’s pictures come round in a loop')
  const [id, slot] = link
  const node = prompt[id]
  if (!node) throw new Error('A picture for the Frame comes from outside the workflow')
  const inputs = node.inputs ?? {}
  switch (node.class_type) {
    case 'Image':
      if (isLink(inputs.images)) return pictureSourceOf(prompt, inputs.images, depth + 1)
      return parseInputFileRef(inputs.image) ? 'card' : 'blank'
    case GATE_CLASS:
      if (isLink(inputs.data_in)) return pictureSourceOf(prompt, inputs.data_in, depth + 1)
      break
    case 'LoadImage':
      if (slot === 0) return 'load'
      break
    case 'Compositor':
      if (slot === 0) return 'rgb'
      break
    // The bake-replay cards (R1.3): each hands on its bake as the PNG Python's loader holds.
    case 'Scene3DStudio':
      return 'load'
    case 'TextOnPath':
      if (slot === 0) return 'load'
      break
    // Text mask's image is a tensor Python builds (1 − mask, grey RGB), no EXIF
    // turn. With a source and a render (R1.4) it is the source × (1 − mask):
    // the source's channels, which its kept PNG keeps (RGB or RGBA).
    case 'TextMask':
      if (slot !== 0) break
      return isLink(inputs.source) && pyTruthy(bakeParams(inputs.params).rendered) ? pictureSourceOf(prompt, inputs.source, depth + 1) : 'rgb'
    // Empty image (R1.4): a flat tensor Python builds, RGB.
    case 'EmptyImage':
      if (slot === 0) return 'rgb'
      break
    // Smart Layout (R1.6): each render as an RGB tensor, exactly its 8-bit PNG (v / 255 round-trips).
    case 'SmartLayout':
      if (slot === 0) return 'rgb'
      break
    default:
      if (PROVIDER_TYPES.has(node.class_type)) {
        const pass = actionPassThrough(node.class_type, inputs)
        const v = pass ? inputs[pass] : undefined
        return isLink(v) ? pictureSourceOf(prompt, v, depth + 1) : 'provider'
      }
  }
  throw new Error(`The runner cannot read a Frame picture from a ${node.class_type} node`)
}

/** 'mask': a LoadImage's file, whose alpha the Frame reads; 'kept-mask': a mask value the runner kept (R1.3: a LoadImage run as a card). */
interface Wired { source: PictureSource | 'mask' | 'kept-mask'; file: OutputFile | null }

export function planCompositor(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const picture = (name: string): Wired | null => {
    const v = inputs[name]
    if (!isLink(v)) return null
    const source = pictureSourceOf(ctx.prompt, v)
    const file = ctx.filesFrom(v)[0] ?? null
    if (!file && source !== 'blank') throw new Error('A picture for the Frame is missing')
    return { source, file }
  }
  const mask = (name: string): Wired | null => {
    const v = inputs[name]
    if (!isLink(v)) return null
    if (ctx.prompt[v[0]]?.class_type !== 'LoadImage' || v[1] !== 1) throw new Error('The runner can only read a Frame mask from a loaded picture')
    const file = ctx.filesFrom(v)[0] ?? null
    if (!file) throw new Error('A mask for the Frame is missing')
    return { source: ctx.valueFrom?.(v)?.kind === 'mask' ? 'kept-mask' : 'mask', file }
  }
  const layers = Array.from({ length: MAX_LAYERS }, (_, i) => picture(`layer${i + 1}`))
  const masks = Array.from({ length: MAX_LAYERS }, (_, i) => mask(`layer${i + 1}_mask`))
  const overlay = picture('overlay')
  const overlayMask = mask('overlay_mask')
  const protect = protectMaskRead(ctx.prompt, ctx.nodeId)

  return {
    kind: 'local',
    async render(signal?: AbortSignal) {
      const read = ctx.readFile
      if (!read) throw new Error('The runner cannot read pictures here')
      // Each picture is read and decoded only when composeFrame reaches it.
      const loader = (w: Wired | null): Loader | null => {
        if (!w) return null
        return async () => {
          try {
            // Raw RGBA8 only: the worker builds the tensor.
            if (w.source === 'mask') return await decodeRawMask(await read(w.file!))
            if (w.source === 'kept-mask') return loadImageMaskPicture(await decodeMask(await read(w.file!)))
            return await decodeRaw(w.file ? await read(w.file) : null, w.source)
          }
          catch (e) {
            if (e instanceof Error && /Frame/.test(e.message)) throw e
            throw new Error(`A picture for the Frame could not be read (${w.file?.filename ?? 'none'})`)
          }
        }
      }
      const out = await renderFrameInWorker(inputs, {
        layers: layers.map(loader),
        masks: masks.map(loader),
        overlay: loader(overlay),
        overlayMask: loader(overlayMask),
      }, { signal, maxCanvasPixels: ctx.hosted ? HOSTED_MAX_FRAME_ARTBOARD_PIXELS : undefined, protect })
      // Only the PNG encodes (sharp, zlib) run on this thread.
      const image = await pngFromPreview8(out.px, out.w, out.h)
      if (!protect) return { image }
      if (!out.mask) throw new Error('The Frame’s kept region was not made')
      return { image, protectMask: await maskPngFromScanlines(out.mask, out.w, out.h) }
    },
    // save_live_preview's ui.
    uiFor: files => ({ images: files, animated: [false] }),
  }
}

/**
 * A LoadImage's MASK kept by the runner (R1.3), as the raw picture its file
 * gives the Frame: every value LoadImage makes is 1 − a/255, kept exactly as
 * (255 − a)·257, so the alpha comes back and the worker builds the very
 * tensor it builds from the file. A value off that grid (not LoadImage's)
 * goes in as the kept float.
 */
function loadImageMaskPicture(m: Mask): Picture {
  const n = m.w * m.h
  const rgba = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const u = Math.round(m.data[i]! * 65535)
    if (u % 257 !== 0) return { c: 1, h: m.h, w: m.w, data: m.data }
    rgba[i * 4 + 3] = 255 - u / 257
  }
  return { raw: true, source: 'mask', w: m.w, h: m.h, data: rgba }
}

/** Whether any node of the prompt reads this Frame's protect_mask (output 1). */
export function protectMaskRead(prompt: ApiPrompt, nodeId: string): boolean {
  return Object.values(prompt).some(n => linksOf(n).some(l => l.from === nodeId && l.slot === 1))
}
