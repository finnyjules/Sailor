/**
 * Lens · 3D Reframe and Pose Mannequin (step 3, R3.15, family
 * `nano-extras`): what the runner (server/runner/generators/nanoExtras.ts),
 * the rule rows (./eligibility.ts) and the price module
 * (shared/pricing/paidSettings.ts, editSettings.ts) all read about the two
 * classes of comfy_extras/:
 *
 *  - LensReframe (nodes_lens_reframe.py:30-83): one Replicate call,
 *    `google/nano-banana-2` at 1K, `{prompt, image_input: [image],
 *    resolution, output_format: "png"}`; only an `image`-wired node is taken
 *    (Python's blank 16×16 stays with the engine);
 *  - PoseMannequin (nodes_pose_mannequin.py:54-142): the same call with the
 *    character and a pose picture, or no call at all (a saved pose that
 *    loads, or nothing to pose with). Which, `poseNoCall` says from the
 *    inputs as sent (R3 rule 8, ruling (p): no call is free on both paths).
 *
 * Runner deviation (R3.15 fix round 1, controller ruling): Python's
 * mannequin branch reads `_load_input_image(pose_cond_image) or …`, which
 * asks a picture tensor for its truth value and raises ("Boolean value of
 * Tensor with more than one value is ambiguous") whenever the conditioning
 * render loads, so that render never reached a call. The runner does what
 * the code means: the conditioning render when it loads, else the mannequin
 * render, then the call (priced as a call). The ComfyUI path is unchanged:
 * it fails there, free.
 *
 * Pure; relative imports only.
 */
import { isLink } from './graph'
import { pyStrip } from './pyText'

export const LENS_REFRAME_CLASS = 'LensReframe'
export const POSE_MANNEQUIN_CLASS = 'PoseMannequin'
export const NANO_EXTRAS_CLASSES = [LENS_REFRAME_CLASS, POSE_MANNEQUIN_CLASS] as const
export type NanoExtrasClass = typeof NANO_EXTRAS_CLASSES[number]

/** Both classes' call: Nano Banana 2 on Replicate (`_run_prediction("google/nano-banana-2", …)`). */
export const NANO_EXTRAS_SLUG = 'google/nano-banana-2'

/** `_lenses.CUSTOM`, and `_lenses.NAMES`: the seven lenses in order, then Custom (the node's options). */
export const LENS_CUSTOM = 'Custom'
export const LENS_NAMES = [
  'Ultra-Wide 16mm', 'Wide 24mm Art', 'Classic 35mm Summilux', 'Normal 50mm Planar', 'Portrait 85mm GM', 'Tele 135mm f/2', 'Long 200mm', LENS_CUSTOM,
] as const
/** The node's widget bounds (define_schema). */
export const LENS_STRENGTH = { min: 0, max: 1.5, default: 1 } as const
export const LENS_FOCAL = { min: 10, max: 300, default: 50 } as const

/** Pose Mannequin's `pose_source` options; anything else reads as the mannequin (execute's `else`). */
export const POSE_SOURCES = ['mannequin', 'image', 'prompt'] as const
export type PoseSource = typeof POSE_SOURCES[number]

/** The editor's baked files, in the order execute loads them: the result, the conditioning render, the mannequin render. */
export const POSE_BAKED_INPUTS = ['result_image', 'pose_cond_image', 'mannequin_image'] as const
export type PoseBakedInput = typeof POSE_BAKED_INPUTS[number]

/**
 * Hosted: the saved pose a Pose Mannequin names is gone (or can't be read),
 * so Python would fall through to a call. Priced as a call on both paths
 * (R3.15 fix round 1), and refused by the runner in hosted before the hold.
 */
export const POSE_RESULT_MISSING = 'Pose Mannequin’s saved pose is missing. Open the pose editor and pose it again.'

/** Python's `pose_source` comparisons: "image", "prompt", else the mannequin (a missing one is the default, "mannequin"). */
export function poseSourceOf(inputs: Record<string, unknown>): PoseSource {
  const v = inputs.pose_source
  return v === 'image' ? 'image' : v === 'prompt' ? 'prompt' : 'mannequin'
}

/**
 * A baked file's name as the runner reads it (server/runner/inputs.ts
 * parseInputFileRef: `name`, `sub/name` or `name [input]`), or null for none:
 * blank, not text, or a name no file can have (`..`, an empty part). Python's
 * `_load_input_image` gives None for each of those too (`if not filename`,
 * or a path that can't be opened).
 */
export function bakedFileName(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  let name = v.trim()
  const m = /^(.*?)\s*\[(input|output|temp)\]$/.exec(name)
  if (m) name = m[1]!
  const parts = name.replace(/\\/g, '/').split('/')
  return parts.some(p => !p || p === '.' || p === '..') ? null : v.trim()
}

/**
 * The saved poses a caller must read before a Pose Mannequin's saved pose may
 * be priced as no call (R3.15 fix round 1): node id → the `result_image` value
 * as typed, for each Pose Mannequin whose branch it decides (a typed
 * mannequin-mode source, the character wired, a saved pose named).
 */
export function savedPoseRefs(prompt: Readonly<Record<string, { class_type: string; inputs?: Record<string, unknown> }>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, n] of Object.entries(prompt ?? {})) {
    if (n?.class_type !== POSE_MANNEQUIN_CLASS) continue
    const inputs = n.inputs ?? {}
    if (isLink(inputs.pose_source) || poseSourceOf(inputs) !== 'mannequin' || !isLink(inputs.character)) continue
    const v = inputs.result_image
    if (typeof v === 'string' && bakedFileName(v)) out[id] = v
  }
  return out
}

/** Python's `(pose_prompt or "").strip()` of a typed pose prompt (a missing or non-text one is blank). */
function blankText(v: unknown): boolean {
  return typeof v === 'string' ? !pyStrip(v) : true
}

/** What a caller that read the node's saved pose knows of it (R3.15 fix round 1). */
export interface PoseKnown {
  /** The saved pose `result_image` names was read and loads (a picture): it is the result, no call. */
  savedPoseLoads?: boolean
}

/**
 * Whether Pose Mannequin makes no call, decided from its inputs as sent (R3
 * rule 8, `paidNoCall`): priced at nothing on both paths (ruling (p)) and
 * held at nothing by the runner. An input that decides the branch and is
 * wired (known only at run time) is priced as a call.
 *  - no character wired: the blank passes through;
 *  - image mode: no pose picture wired;
 *  - prompt mode: a typed pose prompt that is blank as Python strips it;
 *  - mannequin mode (and any other source): a saved pose the caller read and
 *    found loading (`known.savedPoseLoads`: the runner's start of the take,
 *    the hosted ComfyUI gate), or neither render named (nothing to pose with).
 * A saved pose named but not read, gone, or unreadable is priced as a call
 * (fix round 1: never free, so no path makes a call it didn't hold for).
 */
export function poseNoCall(inputs: Record<string, unknown>, known: PoseKnown = {}): boolean {
  if (isLink(inputs.pose_source)) return false
  if (!isLink(inputs.character)) return true
  const source = poseSourceOf(inputs)
  if (source === 'image') return !isLink(inputs.pose_image)
  if (source === 'prompt') return !isLink(inputs.pose_prompt) && blankText(inputs.pose_prompt)
  if (POSE_BAKED_INPUTS.some(n => isLink(inputs[n]))) return false
  if (bakedFileName(inputs.result_image) && known.savedPoseLoads === true) return true
  return !bakedFileName(inputs.pose_cond_image) && !bakedFileName(inputs.mannequin_image)
}
