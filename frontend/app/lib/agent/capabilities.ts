/**
 * Agent capability registry — the curated knowledge of WHAT THE APP CAN DO, above
 * the raw ComfyUI node level. The canvas agent's palette is otherwise built only
 * from /object_info, which (a) gives raw nodes no intent vocabulary and (b) can't
 * see the frontend-only STUDIOS at all (they have no /object_info entry). This
 * registry fixes both: it lists the studios + the user-facing generators with rich
 * natural-language intents, so they surface for oblique phrasings and rank ABOVE
 * raw nodes for creative requests.
 *
 * It feeds three things into the existing matcher (lib/nodeMatch + portIntentCatalog):
 *   - capabilityKeywords(): nodeType → intent phrases (matched as keywords)
 *   - capabilityBoosts():   nodeType → small additive rank bonus
 *   - studioNodeTypes():    NodeTypeLite entries for the frontend studios, so
 *                           buildCatalog can include + wire them despite no /object_info
 *
 * See docs/agent-capabilities.md. Tested exhaustively in
 * tests/unit/agent-capability-routing.unit.spec.ts (phrasing → expected capability).
 */
import type { NodeTypeLite } from '~/lib/portIntent'
import type { CatalogEntry } from '~/lib/portIntentCatalog'

export type CapabilityKind = 'studio' | 'generator' | 'effect'

export interface AgentCapability {
  /** The nodeType the agent emits in addNode (a real /object_info class for
   *  generators/effects; a frontend node type for studios). */
  nodeType: string
  kind: CapabilityKind
  /** Human title (display name). */
  title: string
  /** One-line plain description (also fed to the matcher's description field). */
  summary: string
  /** Rich natural-language phrases/synonyms a user might say to request this.
   *  THE most important field — the agent's recall depends on it. */
  intents: string[]
  /** Link ports the agent can wire. `optional` inputs don't read as "required" in
   *  verify (e.g. a generator's img2img image). */
  inputs: { name: string; type: string; optional?: boolean }[]
  outputs: { name: string; type: string }[]
  /** Studios are frontend-only (no /object_info) → synthesize a NodeTypeLite +
   *  catalog entry so buildCatalog can include them. */
  frontendOnly?: boolean
  /** Additive rank bonus (kept small per nodeMatch's contract). Defaults by kind. */
  boost?: number
  /** Raw /object_info node ids this capability REPLACES — hidden from the agent
   *  palette so it never picks a redundant provider node (e.g. WaveSpeed/Magnific
   *  upscalers) over this curated dispatcher. */
  supersedes?: string[]
}

/** Default rank bonus by kind — studios + generators edge out raw nodes on ties
 *  for creative intents (kept small so a genuinely stronger match still wins). */
const DEFAULT_BOOST: Record<CapabilityKind, number> = { studio: 3, generator: 2.5, effect: 2 }

export function capabilityBoost(c: AgentCapability): number {
  return c.boost ?? DEFAULT_BOOST[c.kind]
}

/** The set of nodeTypes that are OUR curated capabilities (vs raw /object_info
 *  nodes) — used to mark + prioritise them in the agent palette. */
export function capabilityNodeTypes(caps: AgentCapability[] = AGENT_CAPABILITIES): Set<string> {
  return new Set(caps.map(c => c.nodeType))
}

/** Actions-panel nodes deliberately NOT agent-plannable, with the reason.
 *  The coverage guard (tests/unit/agent-coverage-guard.unit.spec.ts) forces
 *  every edit/enhance catalog entry to appear here or in AGENT_CAPABILITIES —
 *  an explicit decision either way. */
export const AGENT_EXCLUDED: Record<string, string> = {
  PersonSwap: 'Needs two required images — the scene AND a reference photo of the replacement person — the agent has no way to source a specific person-identity photo from a phrase alone.',
  PoseMannequin: "Its primary workflow poses a 3D mannequin in a dedicated on-canvas editor (baked conditioning image); the agent can't drive that editor from text.",
  SwapProductNode: 'Needs two required images — a finished packshot scene AND the product cutout to place into it — the agent cannot source or pair both from a phrase alone.',
  LipSyncNode: "Driven by the Lip-Sync Studio's staged face/voice inputs (JSON model_options with face_image/face_video/audio URLs, branching between two engines) rather than ports the agent can wire directly.",
}

/** Raw node ids that a capability replaces — excluded from the agent palette so a
 *  redundant provider node can't be picked over the curated dispatcher. */
export function supersededNodeTypes(caps: AgentCapability[] = AGENT_CAPABILITIES): Set<string> {
  const out = new Set<string>()
  for (const c of caps) for (const n of c.supersedes ?? []) out.add(n)
  return out
}

/** nodeType → intent phrases, for searchNodes/buildCatalog `keywords`. */
export function capabilityKeywords(caps: AgentCapability[] = AGENT_CAPABILITIES): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const c of caps) out[c.nodeType] = c.intents
  return out
}

/** nodeType → additive boost, for searchNodes/buildCatalog `boosts`. */
export function capabilityBoosts(caps: AgentCapability[] = AGENT_CAPABILITIES): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of caps) out[c.nodeType] = capabilityBoost(c)
  return out
}

/** NodeTypeLite entries for the frontend-only studios (no /object_info), so the
 *  matcher + buildCatalog can rank and include them. Generators already come from
 *  /object_info, so they're excluded here to avoid duplicate entries. */
export function studioNodeTypes(caps: AgentCapability[] = AGENT_CAPABILITIES): NodeTypeLite[] {
  return caps.filter(c => c.frontendOnly).map(c => ({
    name: c.nodeType,
    displayName: c.title,
    description: c.summary,
    category: c.kind,
    inputs: c.inputs,
    outputs: c.outputs,
  }))
}

/** Catalog entries for frontend studios (buildCatalog can't derive ports from a
 *  missing /object_info entry, so provide them). */
export function studioCatalogEntries(caps: AgentCapability[] = AGENT_CAPABILITIES): CatalogEntry[] {
  return caps.filter(c => c.frontendOnly).map(c => ({
    type: c.nodeType,
    name: c.title,
    description: c.summary,
    inputs: c.inputs,
    outputs: c.outputs,
    widgets: [],
  }))
}

export function capabilityByType(nodeType: string, caps: AgentCapability[] = AGENT_CAPABILITIES): AgentCapability | undefined {
  return caps.find(c => c.nodeType === nodeType)
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATORS — the user-facing creative nodes (Replicate-backed). nodeType ==
// the registered /object_info node_id. `effect` = an edit/restore/analysis op;
// `generator` = makes new media from a prompt/seed. Image-typed I/O lets the
// agent wire them; prompt-only nodes have no inputs.
// ─────────────────────────────────────────────────────────────────────────────
const IMG = [{ name: 'IMAGE', type: 'IMAGE' }]
const GENERATORS: AgentCapability[] = [
  // ---- Image · generation ----
  { nodeType: 'GenerateImageNode', kind: 'generator', title: 'Generate an image', summary: 'Text-to-image; pick any model (Flux, Ideogram, Reve…) and generate from a prompt.', inputs: [], outputs: IMG,
    intents: ['generate an image', 'make a picture', 'create an image', 'text to image', 'draw me', 'render a photo', 'make art', 'generate a photo of', 'imagine', 'dream up', 'conjure an image', 'produce an image', 'ai image', 'picture of a', 'visualize', 'make me a graphic', 'generate a dog', 'create artwork', 'create a painting of', 'render an illustration', 'wallpaper of a', 'make a wallpaper of', 'background image of'] },
  { nodeType: 'FluxLoRARemoteNode', kind: 'generator', title: 'Generate with your LoRA', summary: 'Generate with a trained LoRA (character/style), or img2img-restyle with it.', inputs: [{ name: 'image', type: 'IMAGE', optional: true }], outputs: IMG,
    intents: ['generate with my lora', 'use my trained model', 'make an image of my character', 'generate my character', 'use my finetune', 'lora generation', 'my model image', 'personalized generation', 'generate using my training', 'generate in my style', 'make this in my style', 'an image in my own style', 'use my trained style', 'my character in a scene'] },
  { nodeType: 'FluxMultiLoRARemoteNode', kind: 'generator', title: 'Generate with multiple LoRAs', summary: 'Stack up to four LoRAs (character + style + accents) in one Flux generation.', inputs: [], outputs: IMG,
    intents: ['combine two loras', 'my character in a style', 'stack loras', 'character plus style', 'use two trained models', 'mix loras', 'apply character and style lora', 'my character in watercolor style'] },
  { nodeType: 'GenerateAnimeNode', kind: 'generator', title: 'Generate an anime image', summary: 'Anime-style image generation (Animagine XL).', inputs: [], outputs: IMG,
    intents: ['make an anime image', 'anime art', 'generate manga style', 'draw anime', 'anime character', 'waifu', 'anime girl', 'manga drawing', 'make it anime', 'anime portrait'] },
  { nodeType: 'GenerateEmojiNode', kind: 'generator', title: 'Generate an emoji', summary: 'Turn a portrait into an iOS-style emoji (Flux Kontext + Emoji LoRA).', inputs: [{ name: 'input_image', type: 'IMAGE' }], outputs: IMG,
    intents: ['make an emoji', 'turn me into an emoji', 'emoji of this face', 'ios emoji style', 'memoji', 'emojify', 'apple emoji of me', 'convert photo to emoji', 'emoji sticker'] },
  { nodeType: 'ConsistentFaceNode', kind: 'generator', title: 'Generate a consistent face', summary: 'Generate the same character across scenes/poses from one reference face.', inputs: [{ name: 'reference_image', type: 'IMAGE' }], outputs: IMG,
    intents: ['same character again', 'keep the same face', 'consistent character', 'this person in a new scene', 'same person different pose', 'character consistency', 'reuse this face', 'same face new outfit', 'generate the same person', 'keep identity consistent'] },
  { nodeType: 'SketchToImageNode', kind: 'generator', title: 'Sketch to image', summary: 'Turn a rough sketch/line drawing into a finished image, keeping composition.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: IMG,
    intents: ['turn my sketch into an image', 'finish my drawing', 'sketch to image', 'make my doodle real', 'render my line art', 'drawing to photo', 'colorize my sketch', 'complete this drawing', 'scribble to image', 'make my sketch realistic'] },
  { nodeType: 'TextEffectNode', kind: 'generator', title: 'Text effect', summary: 'Render a word as typographic art (liquid chrome, holographic, brutalist…).', inputs: [{ name: 'image', type: 'IMAGE', optional: true }], outputs: IMG,
    intents: ['make a text effect', 'stylize this word', 'typographic art', 'chrome text', 'holographic letters', 'make a logo word', 'fancy text', 'word art', '3d text effect', 'liquid metal text', 'title treatment', 'neon text'] },

  // ---- Image · editing & transformation ----
  { nodeType: 'EditImageNode', kind: 'effect', title: 'Edit an image', summary: 'Natural-language image editing (Nano Banana / Flux Kontext / Flux 2 Pro) — change, add, remove anything.', inputs: [{ name: 'input_image', type: 'IMAGE' }], outputs: IMG,
    intents: ['edit this image', 'change her shirt', 'make her hair blue', 'change the background', 'edit the photo', 'modify this picture', 'alter the image', 'change the sky', 'make it nighttime', 'make it look like nighttime', 'tweak this image', 'photoshop this', 'add an object', 'add a hat', 'put glasses on', 'add a logo to the image'] },
    // Removal, recolor and in-image text edits have DEDICATED nodes below
    // (RemoveObjectNode / RecolorObjectNode / TextEditNode) — their verbs
    // moved there; EditImageNode keeps the broad/ambiguous edits.
  { nodeType: 'RemoveObjectNode', kind: 'effect', title: 'Remove an object', summary: 'Erase a described object and seamlessly fill the hole from the scene (Nano Banana 2).', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: IMG,
    intents: ['remove an object', 'remove the person', 'remove the car', 'remove the object', 'erase the object', 'get rid of the object', 'delete the object', 'remove the thing in the background', 'erase him from the picture', 'take out the object', 'photoshop out', 'photoshop out my ex', 'remove the lamppost', 'clean up the distractions', 'erase the tourist',
      // Removal of rendered text/watermarks is still an erase-and-fill-the-hole
      // op (this node), NOT a find/replace op (TextEditNode expects a
      // REPLACEMENT string, not deletion).
      'remove the text', 'remove the watermark', 'get rid of the text', 'erase the writing'] },
  { nodeType: 'TextEditNode', kind: 'effect', title: 'Edit text in an image', summary: 'Find and replace rendered text inside the image, matching the original typography (Nano Banana 2).', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: IMG,
    intents: ['change the text', 'replace the text', 'edit the text in the image', 'make it say', 'fix the typo', 'fix the spelling', 'change the sign to say', 'change the words', 'rewrite the label', 'change the headline text', 'replace the word', 'update the text on the poster', 'the sign should say'] },
  { nodeType: 'RecolorObjectNode', kind: 'effect', title: 'Recolor an object', summary: "Change one object's colour while keeping its material, texture and lighting (Nano Banana 2).", inputs: [{ name: 'image', type: 'IMAGE' }], outputs: IMG,
    // "Background" counts as a recolorable object too (a wall, a backdrop) — a
    // bare colour change on it belongs here, NOT the product-locked scene-swap
    // (SwapBackgroundNode requires a whole new scene/setting, not just a hue).
    intents: ['change the color of', 'recolor the object', 'recolour it', 'make the shirt red', 'change the car to blue', 'make it a different color', 'a different paint color', 'turn the dress green', 'make the sofa green', 'swap the color', 'recolor to the brand color', 'colorway', 'recolour the logo', 'change the background color', 'change the color of the background', 'make the background a different color'] },
  { nodeType: 'RestyleFromImageNode', kind: 'effect', title: 'Restyle from image', summary: 'Apply the style of one reference image onto another content image.', inputs: [{ name: 'content_image', type: 'IMAGE' }, { name: 'style_image', type: 'IMAGE' }], outputs: IMG,
    intents: ['apply this style', 'make it look like this', 'style transfer', 'restyle using this image', 'use this as a style reference', 'match this aesthetic', 'transfer the look', 'paint in this style', 'copy the style of', 'give it this vibe'] },
  { nodeType: 'RestyleWithLoRANode', kind: 'effect', title: 'Restyle with a trained LoRA', summary: 'Restyle a content image with a trained LoRA, keeping structure.', inputs: [{ name: 'content_image', type: 'IMAGE' }], outputs: IMG,
    intents: ['restyle with my lora', 'restyle with my trained model', 'convert this using my lora', 'use my trained style lora', 'my lora on this photo', 'stylize with my finetune'] },
  { nodeType: 'BlendSceneNode', kind: 'effect', title: 'Blend scene', summary: 'Harmonize a flat composite into one cohesive photo — unified lighting + contact shadows.', inputs: [{ name: 'image', type: 'IMAGE' }, { name: 'keep_subject', type: 'MASK' }], outputs: IMG,
    intents: ['blend these together', 'make it look like one photo', 'harmonize the composite', 'match the lighting', 'make the pasted object fit', 'add realistic shadows', 'merge the scene', 'unify this composite', 'integrate the cutout'] },
  { nodeType: 'ProductShotNode', kind: 'effect', title: 'Product shot', summary: 'Product photo + scene → studio-quality product shot, product kept pixel-exact.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: IMG,
    intents: ['make a product shot', 'studio photo of my product', 'put my product in a scene', 'professional product photography', 'ecommerce photo', 'stage my product', 'product on a background', 'marketing shot of this', 'product mockup scene', 'commercial product image', 'advertising photo'] },
  { nodeType: 'RelightNode', kind: 'effect', title: 'Relight a photo', summary: "Re-light an image via a light gimbal/preset — direction, intensity, or match a reference's lighting (Nano Banana 2).", inputs: [{ name: 'image', type: 'IMAGE' }, { name: 'reference', type: 'IMAGE', optional: true }], outputs: IMG,
    intents: ['relight this photo', 'change the lighting', 'add dramatic lighting', 'relight to golden hour', 'light it from the side', 'add a rim light', 'give it studio lighting', 'warm up the lighting', 'add sunset lighting', 'make the lighting more dramatic', 're-light this image', 'change the light direction', 'match the lighting of this reference'] },
  { nodeType: 'SwapBackgroundNode', kind: 'effect', title: 'Swap product background', summary: 'Lock the product, change the scene behind it — from a reference photo or a text description (Nano Banana 2).', inputs: [{ name: 'product', type: 'IMAGE' }, { name: 'background_reference', type: 'IMAGE', optional: true }], outputs: IMG,
    // Kept deliberately product/scene-qualified — bare "background"/"change" are
    // avoided as standalone tokens so a plain colour-change phrase ("change the
    // background color") doesn't saturate on this product-locked scene-swap and
    // out-rank RecolorObjectNode/EditImageNode, which own that simpler edit.
    intents: ['swap the product background', 'put this product on a marble counter', 'new scene behind this product', 'new backdrop for this product', 'move this product to a beach scene', 'put this product on a wood table', 'stage this product on a different surface', 'new setting behind the product', 'replace the scene behind my product', 'put the product in a new environment', 'give this product a new backdrop'] },
  { nodeType: 'RotateCameraNode', kind: 'effect', title: 'Rotate camera', summary: 'Re-render an image from a new viewpoint via a 3-axis gimbal.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: IMG,
    intents: ['rotate the camera', 'show me another angle', 'view from the side', 'turn it around', 'different viewpoint', 'see the back', 'change the angle', 'from above', 'low angle shot', 'spin the view', 'new camera position'] },
  { nodeType: 'OutpaintImageNode', kind: 'effect', title: 'Expand / outpaint', summary: 'Extend an image beyond its borders; model invents new surroundings.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: IMG,
    intents: ['expand the image', 'outpaint', 'extend the canvas', 'zoom out', 'make it wider', 'uncrop', 'add more around', 'fill in the edges', 'extend the background', 'make it landscape', 'widen the photo', 'generative expand', 'add space around the subject'] },

  // ---- Image · restore, enhance, upscale ----
  { nodeType: 'UpscaleImageNode', kind: 'effect', title: 'Upscale an image', summary: 'Upscale with a selectable engine (Clarity, Real-ESRGAN, Topaz…).', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: IMG,
    // This is the curated dispatcher — hide the redundant provider/core upscale
    // nodes from the agent so it never picks a raw one (e.g. WaveSpeed) over us.
    supersedes: ['WavespeedImageUpscaleNode', 'ClarityUpscaleRemoteNode', 'MagnificImageUpscalerCreativeNode', 'MagnificImageUpscalerPreciseV2Node', 'RecraftCrispUpscaleNode', 'RecraftCreativeUpscaleNode', 'StabilityUpscaleConservativeNode', 'StabilityUpscaleCreativeNode', 'StabilityUpscaleFastNode', 'ImageUpscaleWithModel', 'ImageScale', 'ImageScaleBy'],
    intents: ['upscale this', 'make it higher resolution', 'increase resolution', 'enlarge the image', 'make it bigger', '4k upscale', 'improve resolution', 'hd this image', 'super resolution', 'upres', 'make it high res', 'scale up the photo'] },
  { nodeType: 'EnhanceDetailNode', kind: 'effect', title: 'Enhance detail', summary: 'Add realistic fine detail in place (no resize).', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: IMG,
    intents: ['enhance the detail', 'add detail', 'make it sharper', 'sharpen this', 'sharpen up', 'sharpen the image', 'deblur', 'fix blurry photo', 'improve the quality', 'add realism', 'refine this image', 'make it more detailed', 'add fine detail', 'increase clarity', 'make it crisper', 'polish the image'] },
  { nodeType: 'RestorePhotoNode', kind: 'effect', title: 'Restore an old photo', summary: 'Restore old/damaged/faded photos; can colorize black-and-white.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: IMG,
    intents: ['restore this old photo', 'fix my old photograph', 'repair damaged photo', 'colorize this black and white', 'remove scratches', 'fix the fading', 'old photo restoration', 'bring this photo back to life', 'restore a vintage photo', 'modernize an old picture'] },
  { nodeType: 'FixFacesNode', kind: 'effect', title: 'Fix faces', summary: 'Face-specific restoration (CodeFormer) — sharpen/de-blur/reconstruct faces.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: IMG,
    intents: ['fix the faces', 'restore the face', 'sharpen the face', 'deblur the face', 'fix blurry faces', 'reconstruct the face', 'clean up the face', 'fix the eyes', 'repair distorted face', 'enhance faces', 'fix ai face artifacts'] },
  { nodeType: 'RemoveBackgroundNode', kind: 'effect', title: 'Remove background', summary: 'Fast alpha-matte background removal.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: IMG, boost: 3,
    intents: ['remove the background', 'cut out the subject', 'make it transparent', 'make this transparent', 'isolate the person', 'knock out the background', 'remove bg', 'transparent png', 'delete the background', 'extract the subject', 'matte the image', 'clear background', 'background removal', 'cutout', 'remove backdrop', 'take the background out', 'take out the background', 'get rid of the background', 'no background', 'on a transparent backdrop', 'transperent', 'transparant', 'erase the background'] },

  // ---- Image · decompose & analyze ----
  { nodeType: 'SplitPhotoLayersNode', kind: 'effect', title: 'Split photo into layers', summary: 'Decompose into a transparent subject cutout + a clean background plate.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'subject', type: 'IMAGE' }, { name: 'background', type: 'IMAGE' }],
    intents: ['split into layers', 'separate subject and background', 'extract foreground and background', 'remove the subject and fill the hole', 'clean plate', 'decompose this photo', 'subject cutout plus background', 'layer this image', 'pull the subject out'] },
  { nodeType: 'LayerizeGraphicNode', kind: 'effect', title: 'Layerize a graphic', summary: 'Split a flat design into a text-free background + structured text-layer data.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'background', type: 'IMAGE' }, { name: 'layers_json', type: 'STRING' }],
    intents: ['layerize this design', 'split the poster into layers', 'extract the text layers', 'make this editable', 'separate the text from the background', 'decompose this graphic', 'convert to editable design', 'deconstruct the layout', 'edit this poster as layers'] },
  { nodeType: 'SeedreamLayerizeNode', kind: 'effect', title: 'Layerize an image', summary: 'Split a finished image into 2-17 transparent-PNG raster layers, editable in the Compositor.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'preview', type: 'IMAGE' }, { name: 'layers_json', type: 'STRING' }],
    intents: ['layerize this image', 'split the image into layers', 'break this into separate objects', 'extract elements as layers', 'turn this photo into editable layers', 'pull this image apart into layers'] },
  { nodeType: 'DescribeImageNode', kind: 'effect', title: 'Describe an image', summary: 'Vision-language captions, Q&A, counting → text.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'description', type: 'STRING' }],
    intents: ['describe this image', "what's in this picture", 'caption this', 'what do you see', 'tell me about this image', 'explain this photo', 'analyze the image', 'count the people in this', 'ask about the image', 'image caption', 'interpret this picture'] },
  { nodeType: 'ExtractTextNode', kind: 'effect', title: 'Extract text (OCR)', summary: 'OCR — extract text from a photo, screenshot, or document.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'text', type: 'STRING' }],
    intents: ['extract the text', 'ocr this', 'read the text in this image', 'get the text from this screenshot', 'transcribe this document', 'what does the sign say', 'pull the text out', 'read this receipt', 'digitize this document', 'recognize the text'] },
  { nodeType: 'FindObjectsNode', kind: 'effect', title: 'Find objects', summary: 'Open-vocabulary object detection → bounding boxes JSON.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'detections_json', type: 'STRING' }],
    intents: ['find objects in this', 'detect the', 'locate the people', 'where is the', 'bounding boxes for', 'object detection', 'find all the cars', 'identify objects', 'spot the', 'detect items in the image'] },

  // ---- Video ----
  { nodeType: 'GenerateVideoNode', kind: 'generator', title: 'Generate a video', summary: 'Text/image-to-video; gallery of models; optional first frame + audio.', inputs: [{ name: 'image', type: 'IMAGE' }, { name: 'audio', type: 'AUDIO' }], outputs: [{ name: 'VIDEO', type: 'VIDEO' }],
    intents: ['generate a video', 'make a video', 'create a clip', 'make a clip from a picture', 'clip from a photo', 'video from a picture', 'text to video', 'animate this image', 'turn this photo into a video', 'image to video', 'make it move', 'ai video', 'video of', 'bring this to life', 'make a short clip', 'animate'] },
  { nodeType: 'FilmShotNode', kind: 'generator', title: 'Film a shot', summary: 'Cinematic shot generator — named camera-move presets.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'VIDEO', type: 'VIDEO' }],
    intents: ['film a shot', 'cinematic video', 'dolly zoom', 'push in shot', 'make a movie shot', 'camera move video', 'tracking shot', 'pan across', 'crane shot', 'cinematic clip of this', 'slow push in', 'establishing shot'] },
  { nodeType: 'LipsyncNode', kind: 'effect', title: 'Lip sync to audio', summary: 'Drive a face\'s lips to match an audio track (needs a video URL + audio).', inputs: [{ name: 'audio', type: 'AUDIO' }], outputs: [{ name: 'VIDEO', type: 'VIDEO' }],
    intents: ['lip sync this', 'sync the lips to audio', 'make the face talk', 'talking head video', 'dub this video', 'match lips to speech', 'lipsync', 'animate the mouth to audio', 'talking portrait'] },
  { nodeType: 'EnhanceVideoNode', kind: 'effect', title: 'Enhance a video', summary: 'Upscale + denoise + sharpen video (needs a video URL).', inputs: [], outputs: [{ name: 'VIDEO', type: 'VIDEO' }],
    intents: ['enhance the video', 'upscale this video', 'make the video hd', 'improve video quality', '4k the video', 'denoise the video', 'sharpen the video', 'clean up this clip', 'increase video resolution', 'restore this video'] },
  { nodeType: 'DescribeVideoNode', kind: 'effect', title: 'Describe a video', summary: 'Video + question → text (captions, summaries). Needs a video URL.', inputs: [], outputs: [{ name: 'description', type: 'STRING' }],
    intents: ['describe this video', 'what happens in this video', 'summarize the video', 'caption the clip', 'analyze the footage', "what's going on in this video", 'explain the video', 'video summary'] },

  // ---- Audio ----
  { nodeType: 'GenerateMusicNode', kind: 'generator', title: 'Generate music', summary: 'Text-to-music — describe mood/genre/instruments.', inputs: [], outputs: [{ name: 'AUDIO', type: 'AUDIO' }],
    intents: ['generate music', 'make a song', 'create background music', 'text to music', 'compose a track', 'lo-fi beat', 'make some music', 'instrumental for', 'generate a melody', 'background track', 'ai music', 'make a jingle', 'soundtrack for'] },
  { nodeType: 'GenerateSpeechNode', kind: 'generator', title: 'Generate speech', summary: 'Natural text-to-speech with emotion + voice control; supports cloned voices.', inputs: [], outputs: [{ name: 'AUDIO', type: 'AUDIO' }],
    intents: ['generate speech', 'text to speech', 'read this aloud', 'read out loud', 'read it aloud', 'out loud', 'make a voiceover', 'narrate this', 'tts', 'say this', 'voice this text', 'create a narration', 'speak this', 'ai voice', 'make it talk', 'voice over'] },
  { nodeType: 'TranscribeAudioNode', kind: 'effect', title: 'Transcribe audio', summary: 'Audio → text (Whisper) with language detection.', inputs: [{ name: 'audio', type: 'AUDIO' }], outputs: [{ name: 'transcript', type: 'STRING' }],
    intents: ['transcribe this audio', 'speech to text', 'what is said in this', 'get the transcript', 'convert audio to text', 'subtitle this', 'transcribe the recording', 'captions from audio', 'transcribe the podcast'] },
  { nodeType: 'IdentifySpeakersNode', kind: 'effect', title: 'Identify speakers', summary: 'Diarization + transcription — who said what, as JSON.', inputs: [{ name: 'audio', type: 'AUDIO' }], outputs: [{ name: 'segments_json', type: 'STRING' }],
    intents: ['who said what', 'identify the speakers', 'diarize this audio', 'label the speakers', 'separate the speakers', 'speaker diarization', 'tag who is talking', 'transcribe this interview by speaker'] },
  { nodeType: 'CloneSingingVoiceNode', kind: 'effect', title: 'Clone a singing voice', summary: 'Re-sing a song in a different voice (RVC).', inputs: [{ name: 'audio', type: 'AUDIO' }], outputs: [{ name: 'AUDIO', type: 'AUDIO' }],
    intents: ['clone this singing voice', 're-sing this song', 'change the singer', 'ai cover', 'rvc voice', 'voice convert this song', 'cover this in another voice', 'swap the vocals', 'sing in a different voice'] },

  // ---- 3D ----
  { nodeType: 'Generate3DNode', kind: 'generator', title: 'Generate a 3D model', summary: 'Image-to-3D (Hunyuan3D) → textured GLB mesh.', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'glb_url', type: 'STRING' }],
    intents: ['make a 3d model', 'image to 3d', 'turn this into a 3d model', 'generate a mesh', 'create a 3d object', '3d from photo', 'make a glb', 'convert to 3d', 'model this in 3d', '3d asset from image', 'make it 3d'] },
  { nodeType: 'Hunyuan3DMultiViewNode', kind: 'generator', title: 'Multi-view → 3D', summary: 'Reconstruct a 3D model from a front/back/left/right character sheet.', inputs: [{ name: 'front_image', type: 'IMAGE' }, { name: 'back_image', type: 'IMAGE' }, { name: 'left_image', type: 'IMAGE' }, { name: 'right_image', type: 'IMAGE' }], outputs: [{ name: 'glb_url', type: 'STRING' }],
    intents: ['3d from multiple views', 'character sheet to 3d', 'make a 3d model from front and back', 'multi-view 3d', 'turn these views into a model', '3d from turnaround', 'build a 3d character from views'] },

  // ---- Text / LLM utilities ----
  { nodeType: 'ImprovePromptNode', kind: 'effect', title: 'Improve a prompt', summary: 'Rewrite a rough idea into a detailed image/video prompt.', inputs: [], outputs: [{ name: 'improved_prompt', type: 'STRING' }],
    intents: ['improve my prompt', 'make this prompt better', 'expand my prompt', 'enhance the prompt', 'write a better prompt', 'optimize this prompt', 'flesh out my prompt', 'turn my idea into a prompt'] },
  { nodeType: 'ChatLLMNode', kind: 'effect', title: 'Chat with an LLM', summary: 'Send a prompt to a frontier LLM → text.', inputs: [], outputs: [{ name: 'response', type: 'STRING' }],
    intents: ['ask an llm', 'chat with ai', 'ask a question', 'use gpt', 'ask claude', 'talk to an ai', 'get a written answer', 'write me a paragraph', 'query a language model'] },
  { nodeType: 'SummarizeTextNode', kind: 'effect', title: 'Summarize text', summary: 'Compress long text into a short summary.', inputs: [], outputs: [{ name: 'summary', type: 'STRING' }],
    intents: ['summarize this', 'tldr', 'give me a summary', 'condense this text', 'shorten this', 'key points', 'summarize the transcript', 'bullet point summary', 'boil this down', 'recap this'] },
  { nodeType: 'TranslateTextNode', kind: 'effect', title: 'Translate text', summary: 'Translate text between languages, tone-preserving.', inputs: [], outputs: [{ name: 'translation', type: 'STRING' }],
    intents: ['translate this', 'translate to spanish', 'what does this say in english', 'convert to french', 'translate the text', 'say this in german', 'localize this', 'translate into japanese'] },
  { nodeType: 'RewriteToneNode', kind: 'effect', title: 'Rewrite in a tone', summary: 'Rewrite text in a different tone without changing meaning.', inputs: [], outputs: [{ name: 'rewritten', type: 'STRING' }],
    intents: ['rewrite this', 'make it more formal', 'make it casual', 'make it punchier', 'change the tone', 'reword this', 'make it sound friendly', 'rephrase this', 'make it professional', 'polish this copy'] },
  { nodeType: 'BrainstormIdeasNode', kind: 'effect', title: 'Brainstorm ideas', summary: 'Generate N distinct ideas from a topic.', inputs: [], outputs: [{ name: 'ideas', type: 'STRING' }],
    intents: ['brainstorm ideas', 'give me variations', 'list some ideas', 'generate options', 'ideas for', 'come up with concepts', 'suggest some', 'different angles on', 'give me alternatives', 'ideate'] },
]

// ─────────────────────────────────────────────────────────────────────────────
// STUDIOS — the app's creative editors, added as canvas nodes. Gradient/Shader/
// Texture/SpaceType are FRONTEND-ONLY (no /object_info) → frontendOnly:true so we
// synthesize their catalog entry + ports (wildcard output; ShaderStudio takes an
// IMAGE). Compositor + SmartLayout + Scene3DStudio are REAL backend nodes (ports
// come from /object_info — Scene3DStudio's is Scene3DStudioNode, class_type
// "Scene3DStudio", see comfy_extras/nodes_scene3d.py), so frontendOnly is false —
// we only add their intents + boost.
// ─────────────────────────────────────────────────────────────────────────────
const STUDIOS: AgentCapability[] = [
  { nodeType: 'GradientStudio', kind: 'studio', frontendOnly: true, title: 'Gradient Studio', summary: 'Procedural WebGL gradient generator — color fields, mesh, liquid/marble flow, 3D relief, looping video.', inputs: [], outputs: [{ name: 'output', type: '*' }],
    intents: ['make a gradient', 'gradient background', 'add a gradient', 'colour gradient', 'color mesh', 'mesh gradient', 'liquid gradient', 'marble gradient', 'abstract color backdrop', 'soft color wash', 'smooth colour blend', 'smooth color blend', 'blend of colours', 'colour blend behind', 'radial gradient', 'linear gradient', 'rainbow gradient', 'animated gradient', 'ombre background', 'colorful abstract background', 'aurora color field',
      // Mood-framed asks for a colour field — a brief ("something calm for an
      // app splash") rather than a tool name. From the planner A/B eval,
      // docs/superpowers/evals/2026-08-24-plan-model-ab.md.
      'calm colour background', 'calm color background', 'splash screen background'] },
  { nodeType: 'ShaderStudio', kind: 'studio', frontendOnly: true, title: 'Shader Studio', summary: 'Real-time WebGL shader compositor (~70 effects: distortion, stylize, generative, blur, glow, lens, color).', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'output', type: '*' }],
    intents: ['apply a shader', 'stylize this image', 'add an effect to the image', 'halftone effect', 'dither effect', 'ascii art effect', 'pixelate', 'duotone', 'glitch effect', 'rgb glitch', 'chromatic aberration', 'kaleidoscope', 'oil painting effect', 'crosshatch', 'crt scanlines', 'holographic foil', 'posterize', 'vignette', 'bloom glow', 'wave swirl distortion', 'liquify', 'generative background'] },
  { nodeType: 'TextureStudio', kind: 'studio', frontendOnly: true, title: 'Pattern / Texture Studio', summary: 'Tileable seamless-texture generator — procedural motifs, Truchet tiles, 12 geometric shape families, AI text-to-texture.', inputs: [], outputs: [{ name: 'output', type: '*' }],
    intents: ['tileable pattern', 'seamless texture', 'make a pattern', 'repeating pattern', 'geometric pattern', 'truchet tiles', 'herringbone pattern', 'hex tile pattern', 'checkerboard pattern', 'stripes pattern', 'polka dot pattern', 'basketweave', 'fish-scale pattern', 'seamless tile', 'wallpaper pattern', 'fabric texture'] },
  // FLAT 2D VECTOR, not 3D. This entry described the retired shapefx tool
  // ("low-poly primitives and gems … real-time orbit") long after the node
  // became the geologo clone-and-arrange logo generator — its tune adapter is
  // GEO_GUIDANCE (app/lib/geoshape/controls.ts), a 2D vector generator, and the
  // gem primitive + opalescent material moved to Scene3DStudio. The stale
  // vocabulary shipped a live routing bug: "a 3d iridescent diamond" opened
  // this studio and drew a ring of stars. It now claims NO "3d" intent at all —
  // its gem-ish phrasings are qualified as flat logo marks, and the bare 3D
  // ones belong to Scene3DStudio. See tests block 8c.
  { nodeType: 'ShapeStudio', kind: 'studio', frontendOnly: true, title: 'Shape Studio', summary: 'Flat vector logo generator — one base shape (polygon, star, hexagon) cloned and arranged into a ring, grid or row, then folded into a single mark with boolean ops, spot-coloured overlaps and harmony palettes.', inputs: [], outputs: [{ name: 'output', type: '*' }],
    intents: ['logo mark', 'geometric logo', 'gem logo', 'faceted logo mark', 'flat crystal icon', 'vector logo shape', 'abstract geometric mark', 'clone and arrange a shape', 'radial shape arrangement', 'starburst mark', 'polygon mark', 'flat vector emblem', 'faceted flat shape', 'flat shaded shape', 'shape studio', 'geometric symbol'] },
  { nodeType: 'VectorType', kind: 'studio', frontendOnly: true, title: 'Vector Type', summary: 'Variable-font typography as real vector OUTLINES — every axis the font declares is a live, animatable slider, with per-glyph stagger so a weight wave travels across the word.', inputs: [], outputs: [{ name: 'output', type: '*' }],
    intents: ['variable font', 'variable font animation', 'vector type', 'animate the font weight', 'weight axis', 'animate a font axis', 'font axis', 'wght axis', 'wdth axis', 'width axis', 'optical size axis', 'letters cascade in', 'stagger the letters', 'letters animate one by one', 'type that morphs', 'morphing letterforms', 'outline lettering', 'vector lettering', 'condensed to extended', 'thin to black weight', 'variable font wave'] },
  { nodeType: 'ShotDirector', kind: 'studio', frontendOnly: true, title: 'Shot Director', summary: 'Guardrailed shot-sheet UI for directing video models (Seedance 2.0 and others) — fill in a shot sheet, get terse best-practice prompts, drive Seedance per-model profiles.', inputs: [{ name: 'cast_1', type: 'CHARACTER', optional: true }, { name: 'cast_2', type: 'CHARACTER', optional: true }, { name: 'cast_3', type: 'CHARACTER', optional: true }], outputs: [{ name: 'output', type: '*' }],
    intents: ['seedance', 'direct a video', 'shot director', 'film a shot', 'video shot', 'shot sheet', 'camera direction', 'direct a shot', 'video direction', 'seedance prompt', 'shot-director'] },
  { nodeType: 'Character', kind: 'studio', frontendOnly: true, title: 'Character', summary: 'Castable character card — references a saved character for casting into a Shot Director.', inputs: [], outputs: [{ name: 'character', type: 'CHARACTER' }],
    intents: ['character', 'cast a character', 'add a character', 'character card', 'use this character', 'reuse a character', 'pick a saved character'] },
  // CharacterSheet is retired (Task 5) — its sheet-builder flow now lives in
  // the Character Studio, reached from the Character card's picker, not from
  // a standalone creatable node. No STUDIOS entry means it's no longer
  // agent-plannable or toolbox-creatable; it stays in FRONTEND_ONLY_NODE_TYPES
  // below (explicit add, same as LipSyncStudio) so a saved graph's old
  // CharacterSheet node still gets stripped before a backend Run.
  { nodeType: 'SpaceType', kind: 'studio', frontendOnly: true, title: 'Expressive Studio', summary: 'Arrange type, photos, and fills as tiles in looping 3D layouts (ring, and more) — pick a layout, add words/images/gradients, animate + bake. Kinetic typography + card showcases in one.', inputs: [], outputs: [{ name: 'output', type: '*' }],
    intents: ['kinetic typography', 'animated text', 'animate text', 'animate the word', 'animated word', 'animate this text', '3d text', '3d text effect', 'text animation', 'spinning text', 'text on a sphere', 'text tunnel', 'glitchy text', 'melting text', 'spiral text', 'elastic stretchy text', 'ribbon text', 'type studio', 'animated title', 'motion typography', 'extruded text', 'text on a cylinder', 'text intro animation', 'photo carousel', 'card showcase', 'image ring', 'cover flow', 'orbiting cards', 'looping layout'] },
  { nodeType: 'Scene3DStudio', kind: 'studio', frontendOnly: false, title: '3D Studio', summary: 'Compose a 3D scene (primitives, faceted gems and crystals, extruded 3D TEXT, imported GLB models, lights) in a fullscreen editor, with chrome/glass/metal/iridescent-opalescent materials and studio lighting; outputs baked beauty, depth and normal renders for img2img / ControlNet conditioning.', inputs: [{ name: 'glb_url', type: 'STRING', optional: true }], outputs: [{ name: 'beauty', type: 'IMAGE' }, { name: 'depth', type: 'IMAGE' }, { name: 'normal', type: 'IMAGE' }],
    // Deliberately avoids "asset"/"reference"/"photo"/"image"/"from" — that
    // vocabulary is Generate3DNode/Hunyuan3DMultiViewNode's own domain
    // (image/photo → 3D asset); Scene3DStudio composes primitives/GLBs/lights
    // in a scene, a different intent even where both mention "3d".
    //
    // The second group is the studio's flagship LOOK vocabulary — a 3D text
    // primitive wearing a glass/chrome/opalescent material. It was missing, and
    // the planner A/B eval (docs/superpowers/evals/2026-08-24-plan-model-ab.md)
    // caught the cost: "a glassy chrome 3D version of the word BLOOM" routed to
    // VectorType (FLAT vector outlines) on both models. Deliberately excludes
    // "typography"/"kinetic"/"animate" — that is VectorType's and SpaceType's
    // lane, and a bare shared token would steal it outright. Same reason it
    // stays off "gem"/"crystal": Shape Studio is the faceted-gem tool.
    //
    // ^ That last clause was WRONG, and shipped a live bug. Shape Studio is the
    // flat 2D VECTOR logo tool; the gem primitive (app/lib/scene3d/gem.ts — a
    // seeded convex-hull stone) and the opalescent thin-film material
    // (materials.ts) both live HERE. "a 3d iridescent diamond" routed to the
    // flat tool and drew a ring of stars. The border is not the word "gem" —
    // it is 3D/MATERIAL/RENDER phrasing (ours) vs FLAT/LOGO/MARK phrasing
    // (Shape Studio's), so the third group below claims the 3D gem outright.
    intents: ['3d scene', 'stage a 3d scene', 'compose a 3d scene', 'add a 3d scene', '3d studio', 'arrange objects in 3d', 'place primitives in 3d', 'add a sphere to the scene', 'add a torus', 'add a light to the scene', 'stage a glb model in a scene', 'position a 3d model in a scene', 'render a 3d scene', 'depth pass for controlnet', 'normal pass for controlnet', '3d control renders', 'low poly scene', 'studio lighting for a 3d scene', 'orbit a 3d scene',
      'chrome 3d text', 'glassy 3d text', 'glass 3d lettering', 'metallic 3d word', 'shiny metal lettering', 'glossy 3d render of a word', 'chrome logo in 3d', 'extruded 3d letters', 'bevelled 3d letters', 'iridescent 3d object', 'holographic 3d object', 'refractive glass object', 'polished metal object',
      '3d gem', '3d diamond', '3d crystal', 'iridescent diamond', 'crystal render', 'faceted 3d jewel', 'shiny gemstone', 'faceted 3d gem', 'render a gem', 'gemstone in 3d'] },
  { nodeType: 'Compositor', kind: 'studio', frontendOnly: false, title: 'Frame (Compositor)', summary: 'Figma-style layer compositor / artboard — stack image + text/vector/shape layers with transforms, blend, masking, motion, post-processing (grade/bloom/grain/vignette/duotone).', inputs: [{ name: 'layer1', type: 'IMAGE' }], outputs: [{ name: 'image', type: 'IMAGE' }],
    intents: ['compose a frame', 'create a frame', 'add this to a frame', 'put the image in a frame', 'place it on an artboard', 'new artboard', 'layout layers', 'combine these into one image', 'merge images into a composition', 'overlay images', 'stack layers', 'add text over the image', 'add a caption', 'put a logo on this', 'arrange elements on a canvas', 'draw a shape on top', 'add a vector', 'design a composite',
      // Solid/coloured frame background (the backdrop behind the layers) — NOT a
      // gradient. Owns "make the background blue" once it's in a frame.
      'solid background colour', 'solid background color', 'blue background', 'coloured background', 'colored background', 'set the background colour', 'set the background color', 'make the background blue', 'fill the background with a colour', 'put it on a coloured background', 'frame background colour', 'backdrop colour behind the layers',
      // Post-fx on the FRAME (the composited whole) — "the frame"/"the composite"
      // suffix keeps these from colliding with ShaderStudio's bare per-image shader
      // vocabulary ('vignette', 'bloom glow', 'duotone') and GradientStudio's.
      'add film grain to the frame', 'add a vignette to the frame', 'colour grade the frame', 'color grade the frame',
      'add a bloom to the frame', 'duotone the composited frame', 'desaturate the frame', 'warm up the frame\'s colours',
      // Frame Templates (saved, reusable layer groups with fillable slots) —
      // place one, fill its slots, or detach a placed copy. "template" is the
      // anchor token; kept distinct from SwapBackgroundNode's product-scene
      // swap and TextEditNode's generic copy edits by pairing with it.
      'use my template', 'use my saved template', 'apply my template', 'place my template', 'place my template on this frame',
      'drop in my template', 'insert my template', 'use my poster template', 'use my branded template',
      'set the headline to', 'edit the headline on the template', 'update the headline copy on the template', 'edit the template headline',
      'swap the photo in the template', 'swap the template photo', 'replace the photo in that template slot', 'put a different photo in the template slot',
      'freeze this template copy', 'freeze this template', 'detach this from the template', 'unlink this copy from the template', 'stop tracking the template', 'make this template copy a regular layer'] },
  { nodeType: 'SmartLayout', kind: 'studio', frontendOnly: false, title: 'Smart Layout', summary: 'Format-aware Swiss/International-style auto-layout — design once, reflow to many ad aspect ratios; brand-themed.', inputs: [{ name: 'image_layer_1', type: 'IMAGE' }, { name: 'text_layer_1', type: 'STRING' }], outputs: [{ name: 'images', type: 'IMAGE' }],
    intents: ['make a poster layout', 'design a layout', 'auto-layout', 'arrange into a composition', 'create an ad layout', 'social media post layout', 'lay this out nicely', 'arrange text and images', 'make a flyer', 'design a banner', 'multi-format layout', 'resize this design to other formats', 'adapt to story or square', 'swiss design poster', 'grid layout', 'headline and body layout', 'brand-styled layout'] },
  {
    nodeType: 'Collection',
    kind: 'studio',
    frontendOnly: true,
    title: 'Collection',
    summary: 'A data table of named variables. Wire it to a Smart Layout to drive text, images, and brand colors per row — scrub rows to preview, or generate the whole set as a batch.',
    inputs: [],
    outputs: [{ name: 'vars', type: 'VARS' }],
    intents: ['variables', 'dataset', 'data table', 'batch generate', 'data merge', 'spreadsheet'],
  },
  // Moodboard: has a Python twin since Plan B Task B4 (comfy_extras/
  // nodes_moodboard.py registers class_type 'Moodboard'), so frontendOnly is
  // FALSE — it must LEAVE FRONTEND_ONLY_NODE_TYPES (the twin compiles the
  // style block server-side; stripping it would sever the TASTE wire). Like
  // Scene3DStudio/Compositor, its palette entry now rides on /object_info.
  // v1 ships the `style` output only — the image output is deferred to @refs
  // (Task B5; see the plan's decision note).
  {
    nodeType: 'Moodboard',
    kind: 'studio',
    frontendOnly: false,
    title: 'Moodboard',
    summary: 'A pile of inspiration images with an editable taste reading (summary + curated palette + avoids) — apply it to generators as a weightless style, or wire its style output into a generator\'s style_in.',
    inputs: [],
    outputs: [{ name: 'style', type: 'TASTE' }],
    intents: ['moodboard', 'mood board', 'inspiration board', 'style board', 'add a moodboard', 'board of reference images', 'collect inspiration images'],
  },
]

export const AGENT_CAPABILITIES: AgentCapability[] = [...STUDIOS, ...GENERATORS]

/**
 * All node types that exist ONLY on the Vue canvas — no ComfyUI /object_info
 * entry, no backend class_type. The global Run path (runVueWorkflow in
 * layouts/default.vue) must strip these before handing the workflow to the
 * bridge iframe: the iframe's own graphToPrompt serializes every node it's
 * given, and a class_type-less node aborts the ENTIRE run with "Node 'X' has
 * no class_type" — filtered runs are unaffected because buildFilteredWorkflow
 * only ever keeps an explicit target set.
 *
 * Derived from the `frontendOnly: true` studios above, PLUS `LipSyncStudio` —
 * a frontend-only studio (see VueNodeCanvas.vue's wildcard-output synthesis
 * list) that was never added to AGENT_CAPABILITIES, so it doesn't come
 * through the `.filter(c => c.frontendOnly)` derivation. That's a separate,
 * pre-existing gap in the agent's capability palette (not this file's
 * concern to fix); it's added here explicitly so the Run-time strip stays
 * correct regardless.
 *
 * `CharacterSheet` is the same situation for a different reason: it's
 * retired (Task 5, no longer creatable — see the STUDIOS comment above) so
 * it deliberately has no AGENT_CAPABILITIES entry, but old saved graphs can
 * still contain one and it still has no backend class_type — added
 * explicitly so a Run doesn't try to execute it.
 */
export const FRONTEND_ONLY_NODE_TYPES: Set<string> = new Set([
  ...studioNodeTypes().map(n => n.name),
  'LipSyncStudio',
  'Reference',
  'BatchGrid',
  'CharacterSheet',
])
