/**
 * Sketch to image and Generate face references as runner plans (step 3,
 * R3.12, family `image-extras`): SketchToImageNode (nodes_replicate.py:5113-5143,
 * Replicate `google/nano-banana`) and ConsistentFaceNode (:5254-5294,
 * `ideogram-ai/ideogram-character`). Each is one call whose first answer URL
 * is the node's picture (`_first_output_url`: `take: 'first'`), saved as
 * downloaded; Python returns no ui. No backup: no same-model twin with the
 * same settings is carded.
 *
 * The prompt is sent as typed (Python sends it unstripped, blank included);
 * the picture as Python sends the first frame of its batch
 * (`_image_tensor_to_data_url`): the handed-off file of the linked slot
 * (R3.H's loader view). Text effect is ./textEffects.ts.
 */
import { isLink } from '#shared/runner/graph'
import { pyIntOf } from '#shared/runner/pyText'
import { FACE_SLUG, SKETCH_SLUG } from '#shared/runner/imageExtras'
import type { NodePlan, PlanContext } from '../executors'
import { imageUrlOf } from '../imageUrl'
import { firstOutputUrl } from './repair'
import { planTextEffect } from './textEffects'

/** A STRING or COMBO widget's text (the prompt as typed; a wired one arrives as typed, R0). */
function text(inputs: Record<string, unknown>, name: string, def: string): string {
  const v = inputs[name]
  if (v === undefined || v === null) return def
  if (typeof v !== 'string') throw new Error('This setting must be text')
  return v
}

/** int(val) for an INT widget. */
function int(inputs: Record<string, unknown>, name: string, def: number): number {
  const v = inputs[name]
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'boolean') return Number(v)
  if (typeof v === 'string') {
    const n = pyIntOf(v)
    if (n !== null) return n
  }
  if (v === undefined) return def
  throw new Error('This number setting must be a whole number')
}

/** SketchToImageNode.execute (:5135-5142): the prompt as typed, the sketch as a one-picture list. */
export function sketchInput(inputs: Record<string, unknown>, image: string): Record<string, unknown> {
  return { prompt: text(inputs, 'prompt', ''), image_input: [image] }
}

/** ConsistentFaceNode.execute (:5283-5293): the prompt, the face, the ratio, and the seed only above 0. */
export function consistentFaceInput(inputs: Record<string, unknown>, image: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt: text(inputs, 'prompt', ''),
    character_reference_image: image,
    aspect_ratio: text(inputs, 'aspect_ratio', '1:1'),
  }
  const seed = int(inputs, 'seed', 0)
  if (seed > 0) payload.seed = seed
  return payload
}

/** What each class sends its picture as, calls and saves its picture under (Python shows none). */
const SHAPES = {
  SketchToImageNode: { input: 'image', endpoint: SKETCH_SLUG, build: sketchInput, prefix: 'sketch_to_image' },
  ConsistentFaceNode: { input: 'reference_image', endpoint: FACE_SLUG, build: consistentFaceInput, prefix: 'face_reference' },
} as const

/** The node's plan: Text effect's (./textEffects.ts), or one Replicate call whose first answer URL is its picture. */
export async function planImageExtras(ctx: PlanContext): Promise<NodePlan> {
  const node = ctx.prompt[ctx.nodeId]!
  if (node.class_type === 'TextEffectNode') return planTextEffect(ctx)
  const shape = SHAPES[node.class_type as keyof typeof SHAPES]
  if (!shape) throw new Error(`The runner cannot run ${node.class_type}`)
  const inputs = node.inputs ?? {}
  const link = inputs[shape.input]
  const file = isLink(link) ? ctx.filesFrom(link)[0] : undefined
  if (!file) throw new Error('There is no picture to work on')
  const payload = shape.build(inputs, await imageUrlOf(ctx, file, link))
  return {
    kind: 'provider', provider: 'replicate', endpoint: shape.endpoint, payload,
    media: 'image', take: 'first',
    urlsOf: firstOutputUrl,
    prefix: shape.prefix,
    // Python returns no ui (IO.NodeOutput(tensor)).
    uiFor: () => null,
  }
}
