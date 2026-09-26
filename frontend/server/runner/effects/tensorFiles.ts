/**
 * The float32 tensors effects hand on (R2.1 fix round 1, controller ruling):
 * Python passes an effect's float tensor straight to the next node, so an
 * effect whose picture an effect or a Frame reads keeps that tensor too, as a
 * kept file beside its 8-bit PNG (effects/core/tensor.ts tensorFileOf: sha-
 * keyed per run, let go with the run). Its value lists them (`tensors`, one per
 * file); effects and Frames reading the picture take the tensor, while
 * providers, Save image and the rest keep reading the PNG.
 */
import { GATE_CLASS, isLink, linksOf, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { EFFECT_PICTURE_OUTPUTS } from '#shared/runner/effects'
import type { PlanContext } from '../executors'
import type { OutputFile } from '../types'
import { keyOf } from './io'

/** The classes that read an effect's picture as a float tensor: the effects themselves and the Frame. */
const readsFloat = (classType: string) => classType === 'Compositor' || Object.prototype.hasOwnProperty.call(EFFECT_PICTURE_OUTPUTS, classType)

/** Whether a node hands a picture wired into it on unchanged: an Image card fed by a wire, or a Gate. */
const passesOn = (classType: string, input: string) => (classType === 'Image' && input === 'images') || (classType === GATE_CLASS && input === 'data_in')

/**
 * Whether an effect or a Frame reads this output (followed on through what
 * hands a picture on unchanged): then the effect keeps its float tensor too.
 */
export function floatReadBy(prompt: ApiPrompt, id: string, slot: number, depth = 0): boolean {
  if (depth > 64) return false
  for (const [rid, node] of Object.entries(prompt)) {
    for (const l of linksOf(node)) {
      if (l.from !== id || l.slot !== slot) continue
      if (readsFloat(node.class_type)) return true
      if (passesOn(node.class_type, l.input) && floatReadBy(prompt, rid, 0, depth + 1)) return true
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
