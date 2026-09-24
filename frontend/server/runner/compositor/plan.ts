/**
 * The Compositor node as a runner plan: find each wired picture's file and
 * how Python would have decoded it (by the node it came from), then render
 * locally. Eligibility (shared/runner/eligibility.ts, family `frame`) has
 * already refused everything this does not do: baked motion, a read
 * protect_mask or video output, a mask not from a LoadImage, invalid widgets.
 */
import { GATE_CLASS, isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { PROVIDER_TYPES } from '#shared/runner/eligibility'
import { actionPassThrough } from '../generators/actions'
import { parseInputFileRef } from '../inputs'
import type { NodePlan, PlanContext } from '../executors'
import type { OutputFile } from '../types'
import { decodeLoadMask, decodePicture, encodePreviewPng, type PictureSource } from './decode'
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
    default:
      if (PROVIDER_TYPES.has(node.class_type)) {
        const pass = actionPassThrough(node.class_type, inputs)
        const v = pass ? inputs[pass] : undefined
        return isLink(v) ? pictureSourceOf(prompt, v, depth + 1) : 'provider'
      }
  }
  throw new Error(`The runner cannot read a Frame picture from a ${node.class_type} node`)
}

interface Wired { source: PictureSource | 'mask'; file: OutputFile | null }

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
    return { source: 'mask', file }
  }
  const layers = Array.from({ length: MAX_LAYERS }, (_, i) => picture(`layer${i + 1}`))
  const masks = Array.from({ length: MAX_LAYERS }, (_, i) => mask(`layer${i + 1}_mask`))
  const overlay = picture('overlay')
  const overlayMask = mask('overlay_mask')

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
            if (w.source === 'mask') return await decodeLoadMask(await read(w.file!))
            return await decodePicture(w.file ? await read(w.file) : null, w.source)
          }
          catch (e) {
            if (e instanceof Error && /Frame/.test(e.message)) throw e
            throw new Error(`A picture for the Frame could not be read (${w.file?.filename ?? 'none'})`)
          }
        }
      }
      const result = await renderFrameInWorker(inputs, {
        layers: layers.map(loader),
        masks: masks.map(loader),
        overlay: loader(overlay),
        overlayMask: loader(overlayMask),
      }, signal)
      return encodePreviewPng(result.image)
    },
    // save_live_preview's ui.
    uiFor: files => ({ images: files, animated: [false] }),
  }
}
