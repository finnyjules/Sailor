/**
 * Turntable as a runner plan (step 3, R3.16, family `turntable`), ported
 * line for line from:
 *   comfy_extras/_turntable_prompts.py (_SPIN, _SEG, _append and the two instructions, :5-26)
 *   comfy_extras/_turntable_plan.py    (plan_segments, :10-28: #shared/runner/turntable planSegments)
 *   comfy_extras/nodes_turntable.py    (TurntableNode.execute, :52-93)
 *
 * The runner takes the front-only path (A, :70-78): one call to Luma Ray 2
 * 720p through the video table, `spec.build_input(simple_spin_instruction(
 * direction, instructions), "1:1", 5, 0, image, None, {"loop": True})`,
 * built by Generate a video's own Luma builder (executors.ts
 * planVideoGeneration → video.ts lumaRay2720p, the port of
 * `_b_luma_ray_2_720p`): Replicate `luma/ray-2-720p` `{prompt, aspect_ratio:
 * "1:1", duration: 5, loop: true, start_image_url}`. The first answer URL is
 * the clip (`_first_output_url`); Python returns no ui. No backup (Luma Ray
 * 2 is hidden; RUNNER_ROUTES has none).
 *
 * The picture goes as the loader's view (imageUrl.ts, R3.H); Luma Ray 2's
 * saved schema states no upload cap, so there is no JPEG fallback to pick.
 * Path B (right, back or left views wired: Seedance arcs stitched with PyAV)
 * stays with the engine until R3.17 (the rule row's `mustNotLink`).
 */
import { isLink, type ApiLink } from '#shared/runner/graph'
import { pyStrip } from '#shared/runner/pyText'
import {
  TURNTABLE_ASPECT_RATIO, TURNTABLE_DEFAULT_DIRECTION, TURNTABLE_FRONT_MODEL, TURNTABLE_SECONDS, planSegments, turntableViews,
} from '#shared/runner/turntable'
import type { PlanContext } from '../executors'
import { imageUrlOf } from '../imageUrl'

export { planSegments }

// ── _turntable_prompts.py ────────────────────────────────────────────────────

/** `_SPIN`, verbatim (`{direction}` filled by str.format). */
export const SPIN = (
  'The product makes a smooth, continuous full 360° turntable spin to the '
  + '{direction}; camera fixed; consistent lighting and background; seamless loop.'
)
/** `_SEG`, verbatim. */
export const SEG = (
  'Smooth turntable rotation {degrees}° to the {direction}: the product turns '
  + 'cleanly with no morphing or warping; camera fixed; consistent lighting and '
  + 'background.'
)

/** `str.format` of named fields, each once, with values that are already text. */
const format = (template: string, fields: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_m, k: string) => fields[k]!)

/** `_append(base, instructions)`: `(instructions or "").strip()`, then " Additional direction: …." when not blank. */
function append(base: string, instructions: string | null | undefined): string {
  const extra = pyStrip(instructions ?? '')
  return extra ? `${base} Additional direction: ${extra}.` : base
}

/** `simple_spin_instruction(direction, instructions="")`. */
export function simpleSpinInstruction(direction: string, instructions: string | null = ''): string {
  return append(format(SPIN, { direction }), instructions)
}

/** `segment_instruction(degrees, direction, instructions="")`: `int(degrees)` truncates. */
export function segmentInstruction(degrees: number, direction: string, instructions: string | null = ''): string {
  return append(format(SEG, { degrees: String(Math.trunc(degrees)), direction }), instructions)
}

// ── The plan ─────────────────────────────────────────────────────────────────

/** A STRING input as Python reads it: missing or None is "" (execute's default); text is itself (a wired one arrives as typed, R0). */
function instructionsOf(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new Error('Turntable’s extra direction must be text')
  return v
}

/**
 * What Generate a video's planner is handed for the front-only spin: the
 * inputs `spec.build_input` is called with (the model, the instruction, the
 * ratio, the seconds, seed 0 and `{"loop": True}`), and the front picture's
 * provider link. Throws plainly for a node the runner doesn't take.
 */
export function turntableVideoRequest(ctx: PlanContext): { inputs: Record<string, unknown>; first: () => Promise<string> } {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  // Path B (views wired) is the engine's until R3.17: the rule row never lets one through.
  if (turntableViews(inputs).length) throw new Error('A Turntable with extra views runs on the engine')
  const link = inputs.image
  const file = isLink(link) ? ctx.filesFrom(link as ApiLink)[0] : undefined
  if (!file) throw new Error('Turntable needs a front picture')
  const direction = inputs.direction === undefined ? TURNTABLE_DEFAULT_DIRECTION : String(inputs.direction)
  return {
    inputs: {
      model: TURNTABLE_FRONT_MODEL,
      prompt: simpleSpinInstruction(direction, instructionsOf(inputs.instructions)),
      aspect_ratio: TURNTABLE_ASPECT_RATIO,
      duration: TURNTABLE_SECONDS,
      seed: 0,
      model_options: JSON.stringify({ loop: true }),
    },
    first: () => imageUrlOf(ctx, file, link),
  }
}
