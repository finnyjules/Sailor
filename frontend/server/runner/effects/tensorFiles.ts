/**
 * The float32 tensors effects hand on (R2.1 fix round 1, controller ruling):
 * Python passes an effect's float tensor straight to the next node, so an
 * effect whose picture an effect or a Frame reads keeps that tensor too, as a
 * kept file beside its 8-bit PNG (effects/core/tensor.ts tensorFileOf: sha-
 * keyed per run, let go with the run). Its value lists them (`tensors`, one per
 * file); effects and Frames reading the picture take the tensor, while
 * providers, Save image and the rest keep reading the PNG.
 *
 * Masks alike (R2.8 fix round 1, controller ruling): a mask an effect reads
 * (floatReadBy) is kept as its float32 tensor too, beside the 16-bit PNG, by
 * every node that makes one (LoadImage's MASK, Image to mask, Text mask, Text
 * on path, the mask effects, Painter); readers prefer it. And the picture
 * utilities that work on the float (Image to mask, Text mask's source) read
 * an effect's tensor too (R2.8 fix round 2). A tensor is kept only for a
 * reader whose family is on: with every effects family off, nothing is kept.
 */
import { GATE_CLASS, isLink, linksOf, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { EFFECT_PICTURE_OUTPUTS, effectFamilyOn } from '#shared/runner/effects'
import { OBJECT_REMOVE_CLASS, localModelOn } from '#shared/runner/localModels'
import type { RunnerFamily } from '#shared/runner/families'
import type { PlanContext } from '../executors'
import type { OutputFile } from '../types'
import { keyOf } from './io'
import { effectCores } from './cores'

/** A mask's float32 as a kept tensor file (core/tensor.ts tensorFileOf, one channel). */
export function maskTensorBytes(m: { w: number; h: number; data: Float32Array }): Uint8Array {
  return effectCores.tk.tensorFileOf({ c: 1, h: m.h, w: m.w, data: m.data })
}

/**
 * Whether this node, reading on this input, takes the float tensor, and runs
 * on the runner with these families on (R2.8 fix round 2: a tensor is kept
 * only for a reader that will read it):
 *   - an effect (its family and `cards` on), on any input;
 *   - a picture: the Frame (`frame` on); Image to mask's `image` and Text
 *     mask's `source` (`cards` on), which work on the float as Python does;
 *   - a mask: not the Frame, which reads only LoadImage's MASK and rebuilds
 *     its exact float from the 16 bits (compositor/plan.ts), as before R2.8;
 *     Object removal's `mask` (R7.3, `object-remove` on), which truncates it.
 */
function readsFloat(classType: string, input: string, families: ReadonlySet<RunnerFamily>, kind: 'picture' | 'mask'): boolean {
  if (Object.prototype.hasOwnProperty.call(EFFECT_PICTURE_OUTPUTS, classType)) return effectFamilyOn(classType, families)
  // R7.3: Object removal truncates the mask's float to 8 bits (`uint8(255·m)`): LoadImage's 1 − a/255
  // sits just below k/255, which its 16-bit PNG can't carry, so it reads the tensor while it is on.
  if (classType === OBJECT_REMOVE_CLASS && input === 'mask') return localModelOn(classType, families)
  if (kind === 'mask') return false
  if (classType === 'Compositor') return families.has('frame')
  if ((classType === 'ImageToMask' && input === 'image') || (classType === 'TextMask' && input === 'source')) return families.has('cards')
  return false
}

/** Whether a node hands a picture wired into it on unchanged: an Image card fed by a wire, or a Gate. */
const passesOn = (classType: string, input: string) => (classType === 'Image' && input === 'images') || (classType === GATE_CLASS && input === 'data_in')

/**
 * Whether a node that reads this output as a float (readsFloat) will run on
 * the runner (followed on through what hands a picture on unchanged): then
 * the node that makes it keeps its float tensor too. `kind`: what the output
 * carries.
 */
export function floatReadBy(prompt: ApiPrompt, id: string, slot: number, families: ReadonlySet<RunnerFamily> | undefined, kind: 'picture' | 'mask' = 'picture', depth = 0): boolean {
  if (depth > 64 || !families) return false
  for (const [rid, node] of Object.entries(prompt)) {
    for (const l of linksOf(node)) {
      if (l.from !== id || l.slot !== slot) continue
      if (readsFloat(node.class_type, l.input, families, kind)) return true
      if (passesOn(node.class_type, l.input) && floatReadBy(prompt, rid, 0, families, kind, depth + 1)) return true
    }
  }
  return false
}

/**
 * The effect (node and slot) whose picture a wire brings, followed back
 * through what hands a picture on unchanged; null when it isn't an effect's.
 */
function effectBehind(prompt: ApiPrompt, link: ApiLink, depth = 0): ApiLink | null {
  const node = prompt[link[0]]
  if (!node || depth > 64) return null
  const inputs = node.inputs ?? {}
  if (Object.prototype.hasOwnProperty.call(EFFECT_PICTURE_OUTPUTS, node.class_type)) {
    return EFFECT_PICTURE_OUTPUTS[node.class_type]!.includes(link[1]) ? link : null
  }
  if (node.class_type === 'Image' && isLink(inputs.images)) return effectBehind(prompt, inputs.images, depth + 1)
  if (node.class_type === GATE_CLASS && isLink(inputs.data_in)) return effectBehind(prompt, inputs.data_in, depth + 1)
  return null
}

/**
 * The float tensor kept for each picture file a wire brings, by the file's
 * key, when an effect made them (null otherwise). A picture file with no
 * tensor beside it is read as its PNG.
 */
export function keptTensorsBehind(ctx: PlanContext, link: ApiLink): Map<string, OutputFile> | null {
  const from = effectBehind(ctx.prompt, link)
  if (!from) return null
  const v = ctx.valueFrom?.(from)
  if (v?.kind !== 'files' || !v.tensors || v.tensors.length !== v.files.length) return null
  return new Map(v.files.map((f, i) => [keyOf(f), v.tensors![i]!]))
}
