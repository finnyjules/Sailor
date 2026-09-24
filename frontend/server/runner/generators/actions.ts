/**
 * The Nano Banana actions (family `nano-actions`): Remove Object, Edit Text,
 * Recolor Object, Swap Background, Swap Product and Person Swap. Every one
 * sends `google/nano-banana-2` on Replicate `{prompt, image_input, resolution:
 * '1K', output_format: 'png'}`, as the Python nodes do (decision D6).
 *
 * Ports, verbatim:
 *   comfy_extras/_edit_action_prompts.py     (Remove / Edit Text / Recolor)
 *   comfy_extras/_swap_background_prompts.py
 *   comfy_extras/_swap_product_prompts.py
 *   comfy_extras/_person_swap_prompts.py
 * and the pass-through guards of each node's execute() (nodes_edit_actions.py,
 * nodes_swap_background.py, nodes_swap_product.py, nodes_person_swap.py).
 */
import { isLink } from '#shared/runner/graph'
import { asText, pyStrip } from './opts'

export const NANO_BANANA_2_SLUG = 'google/nano-banana-2'
/** BlendSceneNode's `Nano Banana` mode (nodes_replicate.py BlendSceneNode.execute). */
export const NANO_BANANA_SLUG = 'google/nano-banana'

// ── _edit_action_prompts.py ──────────────────────────────────────────────

function finish(base: string, instructions = ''): string {
  const extra = pyStrip(instructions ?? '')
  return extra ? `${base} Additional direction: ${extra}.` : base
}

export function removeObjectInstruction(target: string, instructions = ''): string {
  const base = (
    `Remove ${pyStrip(target)} from the image completely. Fill the area it `
    + 'occupied by seamlessly continuing the surrounding background — match '
    + 'the scene\'s textures, perspective, lighting and grain so no trace, '
    + 'outline or shadow of the removed object remains. '
    + 'Keep EVERYTHING ELSE in the image exactly as it is: composition, '
    + 'framing, colours, other subjects and overall lighting. '
    + 'Output only the edited image.'
  )
  return finish(base, instructions)
}

export function textEditInstruction(find: string, replace: string, instructions = ''): string {
  const base = (
    `Find the text '${pyStrip(find)}' in the image and replace it with `
    + `'${pyStrip(replace)}'. Match the original typography exactly: the same `
    + 'font, weight, size, colour, letter-spacing, perspective, distortion '
    + 'and lighting, so the new text looks native to the image. '
    + 'Change NOTHING ELSE — every other pixel, object and text element '
    + 'stays exactly as it is. Output only the edited image.'
  )
  return finish(base, instructions)
}

export function recolorInstruction(target: string, color: string, instructions = ''): string {
  const base = (
    `Change the colour of ${pyStrip(target)} to ${pyStrip(color)}. `
    + 'Keep the object\'s material, texture, shading, highlights, reflections '
    + 'and the scene\'s lighting exactly as they are — only the object\'s base '
    + 'colour changes, as if the same object had been manufactured in the '
    + 'new colour. Keep EVERYTHING ELSE in the image untouched. '
    + 'Output only the edited image.'
  )
  return finish(base, instructions)
}

// ── _swap_background_prompts.py ──────────────────────────────────────────

const REF_BASE = (
  'The first image is a background scene. The second image is a product. '
  + 'Place the product from the second image into the first image\'s scene so it '
  + 'looks like it genuinely belongs there. '
)
const promptBase = (scene: string) => (
  'The image is a product on a plain/neutral background. Replace the '
  + `background with a new scene described as: ${scene}. Place the product into `
  + 'that new scene so it looks like it genuinely belongs there. '
)
const BRANDING = (
  'Preserve the product\'s exact shape, proportions and branding — its label, '
  + 'logo, text and artwork must stay accurate, correctly placed and legible. '
)
const RELIGHT_ON = (
  'Re-light the product so it is physically lit by the new scene: match the '
  + 'scene\'s light direction, colour temperature and reflections, while keeping '
  + 'its branding artwork intact. '
)
const RELIGHT_OFF = (
  'Keep the product\'s original lighting exactly as shot — do not change how the '
  + 'product itself is lit; only replace what is behind it. '
)
const SHADOW_ON = (
  'Add a soft, realistic contact shadow and any appropriate reflection where the '
  + 'product meets the surface, so it sits in the scene. '
)
const SHADOW_OFF = 'Add no cast shadow — keep the product cleanly separated from the background. '
const KEEP_PLACEMENT_ON = 'Keep the product at the same size and position in frame as the input. '
const KEEP_PLACEMENT_OFF = (
  'Compose the product naturally within the new scene (it may be re-placed or '
  + 'resized for a pleasing composition). '
)
const TAIL = 'Output only the edited image.'

export function swapBackgroundInstruction(o: {
  hasReference: boolean
  scenePrompt: string
  relightToScene: boolean
  groundWithShadow: boolean
  keepScaleAndPlacement: boolean
  instructions?: string
}): string {
  const parts = [o.hasReference ? REF_BASE : promptBase(pyStrip(o.scenePrompt ?? ''))]
  parts.push(BRANDING)
  parts.push(o.relightToScene ? RELIGHT_ON : RELIGHT_OFF)
  parts.push(o.groundWithShadow ? SHADOW_ON : SHADOW_OFF)
  parts.push(o.keepScaleAndPlacement ? KEEP_PLACEMENT_ON : KEEP_PLACEMENT_OFF)
  parts.push(TAIL)
  return finish(parts.join(''), o.instructions)
}

// ── _swap_product_prompts.py ─────────────────────────────────────────────

export const SWAP_PRODUCT_PROMPT = (
  'The first image is a finished product photo — a packshot with a fixed '
  + 'background, surface, camera angle and lighting. The second image shows a '
  + 'different product. Replace the product in the first image with the product '
  + 'from the second image, placed in the same position, scale and orientation '
  + 'as the original product. '
  + 'Fully RE-LIGHT the new product so it is physically lit by the first image\'s '
  + 'scene: match the scene\'s lighting direction, colour temperature, contrast '
  + 'and falloff; add the same highlights and reflections; and cast the same '
  + 'soft contact shadow on the surface. Discard the second image\'s original '
  + 'studio lighting and white balance entirely — the product must look lit by '
  + 'this environment, never pasted in. '
  + 'Preserve the new product\'s exact shape, proportions and branding — its '
  + 'label, logo, text and artwork must stay accurate, correctly placed and '
  + 'legible — but let their illumination, shading and colour temperature follow '
  + 'the scene\'s light rather than the second image\'s. '
  + 'Keep EVERYTHING ELSE from the first image identical: the background, '
  + 'surface, framing, camera angle, lens perspective, depth of field and grain. '
  + 'Output only the edited scene.'
)

export function swapProductInstruction(instructions = ''): string {
  return finish(SWAP_PRODUCT_PROMPT, instructions)
}

// ── _person_swap_prompts.py ──────────────────────────────────────────────

export const KEEP_OUTFIT_PROMPT = (
  'The first image is a scene containing a person. The second image shows a '
  + 'different person (their identity/likeness). Replace the person in the first '
  + 'image with the person from the second image — give them the second person\'s '
  + 'face, hair, skin tone and body type — but keep EVERYTHING ELSE from the first '
  + 'image identical: the same clothing/outfit, the same body pose and stance, the '
  + 'same framing, camera angle, background and lighting. Only the person\'s '
  + 'identity changes; the wardrobe and the scene stay exactly as they are. Do not '
  + 'restyle, recolor or redraw the clothing. Output only the edited scene.'
)

export const NEW_LOOK_PROMPT = (
  'The first image is a scene containing a person. The second image shows a '
  + 'different person. Replace the person in the first image with the person from '
  + 'the second image, bringing the second person\'s own appearance AND their '
  + 'clothing/style. Keep the first image\'s body pose and stance, framing, camera '
  + 'angle, background and lighting unchanged — only the person and their wardrobe '
  + 'become the second person. Output only the edited scene.'
)

export function personSwapInstruction(keepOutfit: boolean, instructions = ''): string {
  return finish(keepOutfit ? KEEP_OUTFIT_PROMPT : NEW_LOOK_PROMPT, instructions)
}

// ── Pass-through ─────────────────────────────────────────────────────────

/** `(value or "").strip()` is blank. */
const blank = (v: unknown) => !pyStrip(asText(v))

/**
 * The picture input an action hands on unchanged, with no call and no charge,
 * when its execute() would return early; null when it makes its call (or the
 * class is not an action). The node is only taken with its main picture
 * linked (a missing one makes Python's blank), so that case is not here.
 * Used by both planNode (the plan) and stageEstimate (nothing is held for it),
 * so the two always agree.
 */
export function actionPassThrough(classType: string, inputs: Record<string, unknown>): string | null {
  switch (classType) {
    case 'RemoveObjectNode': return blank(inputs.target) ? 'image' : null
    case 'TextEditNode': return blank(inputs.find) || blank(inputs.replace) ? 'image' : null
    case 'RecolorObjectNode': return blank(inputs.target) || blank(inputs.color) ? 'image' : null
    case 'SwapBackgroundNode': return !isLink(inputs.background_reference) && blank(inputs.scene_prompt) ? 'product' : null
    case 'SwapProductNode': return isLink(inputs.product) ? null : 'scene_reference'
    case 'PersonSwap': return isLink(inputs.person) ? null : 'scene'
    default: return null
  }
}
