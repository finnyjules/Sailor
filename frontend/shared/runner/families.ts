/**
 * Runner families: groups of node classes the runner takes on, each behind
 * its own switch. The switch is a comma list, one per side:
 *   NUXT_RUNNER_FAMILIES=fal-edit,replicate-image          server (the authority)
 *   NUXT_PUBLIC_RUNNER_FAMILIES=fal-edit,replicate-image   browser routing
 * A family works only when the runner itself is switched on. Every family is
 * off by default: with none on, the runner takes exactly what it took before.
 */
export type RunnerFamily =
  | 'fal-edit'
  | 'replicate-image'
  | 'replicate-video'
  | 'nano-actions'
  | 'ref-edits'
  | 'restyle'
  /** The Frame render (Compositor), computed by the runner itself: no provider, no charge. */
  | 'frame'
  /** Wan 3.0 and Wan 3.0 Prime on fal (model line-up F1): runner-only video models. */
  | 'wan-3'
  /** GPT Image 2.5 on fal, Replicate the backup (model line-up F2): runner-only, in Generate an image and Edit an image. */
  | 'gpt-image-2.5'
  /** Hailuo H3 Max Turbo on fal, no backup (model line-up F3): a runner-only video model. */
  | 'h3-max-turbo'
  /** Gemini Omni Flash on fal, no backup (model line-up F4): a runner-only video model. */
  | 'gemini-omni-flash'
  /** Veo 3.1 Lite on fal, no backup (model line-up F5): a runner-only video model. */
  | 'veo-3.1-lite'
  /** Qwen Image 3 on Replicate, no backup (model line-up F6): a runner-only image model. */
  | 'qwen-image-3'
  /** Grok Imagine 2 on Replicate, no backup (model line-up F7): a runner-only image model. */
  | 'grok-imagine-2'
  /** Ideogram 4 on fal, Replicate the backup at 2K (model line-up F8): a runner-only image model. */
  | 'ideogram-4'
  /** Seedream 5 Pro in Edit an image, on Replicate, no backup (model line-up F9): a runner-only edit model. */
  | 'seedream-5-pro-edit'
  /**
   * Rotate camera on Qwen Image Edit 2511 with the multiple-angles LoRA, on fal, no backup
   * (model line-up F10). Switches the whole node class onto the new model: while it is on,
   * Rotate camera runs only in the runner (Ruling 10); off, the ref-edits 2509 call is unchanged.
   */
  | 'qwen-2511-angles'
  /**
   * Nano Banana 2 in Blend scene (model line-up F11): the nano actions' call, google/nano-banana-2
   * on Replicate at 1K with fal's edit the backup. A runner-only option, and the class default while on.
   */
  | 'nano-banana-2-blend'
  /**
   * Product shot on Bria Product Shot, on fal, no backup (model line-up F12). Switches the
   * whole node class onto the new model: while it is on, Product shot runs only in the runner
   * (Ruling 10); off, it runs on ComfyUI as before (its SDXL engine, refused in hosted mode).
   */
  | 'bria-product-shot'
  /** Muse Image (Meta) on fal, no backup (model line-up F13): a runner-only image model. */
  | 'muse-image'
  /** Nano Banana 2 Lite (Google) on Replicate, no backup (model line-up F14): a runner-only image model. */
  | 'nano-banana-2-lite'
  /** Reve 2.1 on fal, no backup (model line-up F15): a runner-only image model. */
  | 'reve-2.1'
  /** Recraft V4.1 on fal, Replicate the backup (model line-up F16): a runner-only image model. */
  | 'recraft-v4.1'
  /**
   * Krea 2 Large and Medium on fal, Replicate the backup (model line-up F17). NOT runner-only:
   * both keep their ComfyUI builders; while this is on, a node the runner can take goes there.
   */
  | 'krea-2'
  /** HappyHorse 1.1 (Alibaba) on fal, Replicate the backup (model line-up F18): a runner-only video model. */
  | 'happyhorse-1.1'
  /** Grok Imagine Video 1.5 (xAI) on fal, Replicate the backup for image-to-video (model line-up F19): a runner-only video model. */
  | 'grok-imagine-video-1.5'
  /** LTX-2.5 Fast (Lightricks) on Replicate only, no backup (model line-up F20; fal at cost would have doubled the price): a runner-only video model. */
  | 'ltx-2.5-fast'
  /** Luma Ray 3.2 on Replicate, fal the backup for image-to-video (model line-up F21): a runner-only video model. */
  | 'luma-ray-3.2'
  /**
   * sync-3 (sync.so) lip-sync on fal, no backup (model line-up F22): the "sync-3" engine of
   * Lip-sync a character, runner-only. The runner hands it the face video and the sound
   * (from the studio's files, or a linked Audio card) and prices the clip it measures.
   */
  | 'sync-3'
  /**
   * Topaz video upscale on fal, no backup (model line-up F23). Switches the whole "Enhance a
   * video" node (EnhanceVideoNode) onto fal's Topaz: while it is on, the node runs only in the
   * runner (Ruling 10), which reads, measures and prices the video it sends; off, it runs on
   * ComfyUI (Replicate's Topaz) at its flat price, as before.
   */
  | 'topaz-video'
  /**
   * Fix faces on fal's Topaz image upscale with face enhancement, no backup.
   * Moves the whole FixFacesNode (Ruling 10). Off, the node goes to ComfyUI,
   * whose definition-only Python node fails plainly: CodeFormer was removed
   * (non-commercial licence), so there is no ComfyUI path any more.
   */
  | 'fix-faces'
  /**
   * Face swap on Easel's advanced face swap, fal, no backup. Moves the whole
   * FaceSwap node (Ruling 10). Off, the node goes to ComfyUI, whose
   * definition-only Python node fails plainly: InsightFace / inswapper was
   * removed (non-commercial licence), so there is no ComfyUI path any more.
   */
  | 'face-swap'
  /**
   * Person swap (video) on fal's Pixverse Swap, no backup. Moves the whole
   * PersonSwapVideo node (Ruling 10), the video half of the retired
   * InsightFace face swap. Off, the node goes to ComfyUI, whose
   * definition-only Python node fails plainly: there is no ComfyUI path.
   */
  | 'person-swap-video'
  /**
   * The text and data cards (step 3, R0/R1): Primitive, Text, Moodboard,
   * Model3D, the bake-replay cards, LoadImage outside the Frame, Empty image,
   * Get image size, Image to mask, Save image, Preview image, Smart Layout.
   * Computed by the runner itself, free. Off: the runner takes exactly what
   * it took before step 3.
   */
  | 'cards'
  /**
   * The still-picture effects (step 3, R2), one family per kind of machinery
   * (shared/runner/effects.ts). Each needs `cards` (FAMILY_REQUIRES): the
   * effects read Image cards and LoadImage and pass masks, all cards
   * machinery. Computed by the runner itself; they count as work.
   */
  | 'effects-tone'
  | 'effects-blur'
  | 'effects-cells'
  | 'effects-warp'
  | 'effects-mask'
  | 'effects-noise'
  /** The Shader effect, replayed from the browser's bake (R2.10). Needs `cards`. */
  | 'shader-bake'
  /** The effects' live previews through the runner (R2.11). Needs `cards`. */
  | 'live-previews'
  /**
   * The seven LLM text nodes on Replicate (step 3, R3.3): Chat with an LLM,
   * Improve a prompt, Summarize, Translate, Rewrite in a tone, Brainstorm
   * ideas, Think step by step. Needs `cards`: their text goes to Text cards
   * and wired prompts, cards machinery. Off: they go to ComfyUI, as before.
   */
  | 'llm-text'
  /**
   * Describe, read and find on Replicate (step 3, R3.4): Describe an image
   * (and its hidden twin), Describe a video, Extract text, Find objects.
   * Needs `cards`: their pictures come from Image cards and LoadImage, and
   * their text and JSON go to Text cards and wired prompts. Off: they go to
   * ComfyUI, as before.
   */
  | 'describe'
  /**
   * Upscale, enhance, restore and remove background on Replicate (step 3,
   * R3.5): Upscale an image, Enhance detail, Restore an old photo and Remove
   * background (and the hidden twins of the last two). Needs `cards`: their
   * pictures come from Image cards and LoadImage. Off: they go to ComfyUI,
   * as before.
   */
  | 'image-repair'
  /**
   * Layers from one call, and outpaint (step 3, R3.6): Separate text from
   * image (Ideogram Layerize), Layerize an image (fal Seedream 5 Pro
   * Layerize, its layers saved to the user's own input folder) and Expand /
   * outpaint (Flux Fill Pro, Bria Expand). R3.7 adds Separate background and
   * foreground. Needs `cards`: their pictures come from Image cards and
   * LoadImage, their layer JSON goes to Text cards. Off: they go to ComfyUI,
   * as before.
   */
  | 'layers'
  /**
   * Music and speech on Replicate (step 3, R3.8): Generate music (MusicGen)
   * and Generate speech (MiniMax Speech-02 HD), and their hidden twins. Their
   * sound is shown by an Audio card wired after them (the provider's own
   * file, ruling (t)), which a Lip-sync on sync-3 may read. Needs `cards`:
   * their prompts take text wires. Off: they go to ComfyUI, as before.
   */
  | 'audio-gen'

export const RUNNER_FAMILIES: readonly RunnerFamily[] = [
  'fal-edit', 'replicate-image', 'replicate-video', 'nano-actions', 'ref-edits', 'restyle', 'frame', 'wan-3', 'gpt-image-2.5', 'h3-max-turbo', 'gemini-omni-flash', 'veo-3.1-lite', 'qwen-image-3', 'grok-imagine-2', 'ideogram-4', 'seedream-5-pro-edit', 'qwen-2511-angles', 'nano-banana-2-blend', 'bria-product-shot', 'muse-image', 'nano-banana-2-lite', 'reve-2.1', 'recraft-v4.1', 'krea-2', 'happyhorse-1.1', 'grok-imagine-video-1.5', 'ltx-2.5-fast', 'luma-ray-3.2', 'sync-3', 'topaz-video', 'fix-faces', 'face-swap', 'person-swap-video', 'cards',
  'effects-tone', 'effects-blur', 'effects-cells', 'effects-warp', 'effects-mask', 'effects-noise', 'shader-bake', 'live-previews',
  'llm-text', 'describe', 'image-repair', 'layers', 'audio-gen',
]

/**
 * A family that works only while another is on too (R2): with its
 * requirement off, parseFamilies drops it.
 */
export const FAMILY_REQUIRES: Partial<Record<RunnerFamily, RunnerFamily>> = {
  'effects-tone': 'cards',
  'effects-blur': 'cards',
  'effects-cells': 'cards',
  'effects-warp': 'cards',
  'effects-mask': 'cards',
  'effects-noise': 'cards',
  'shader-bake': 'cards',
  'live-previews': 'cards',
  'llm-text': 'cards',
  'describe': 'cards',
  'image-repair': 'cards',
  'layers': 'cards',
  'audio-gen': 'cards',
}

const KNOWN: ReadonlySet<string> = new Set(RUNNER_FAMILIES)

/** No family switched on. */
export const NO_FAMILIES: ReadonlySet<RunnerFamily> = new Set()

/** Whether a family is on: switched on, and its requirement (FAMILY_REQUIRES) with it. */
export function familyOn(family: RunnerFamily, families: ReadonlySet<RunnerFamily>): boolean {
  const need = FAMILY_REQUIRES[family]
  return families.has(family) && (!need || families.has(need))
}

/**
 * A comma list of family names → the set. Unknown names are dropped; anything
 * unreadable (not a string or a list of strings) is no families at all. A
 * family whose requirement (FAMILY_REQUIRES) is off is dropped too.
 */
export function parseFamilies(raw: unknown): ReadonlySet<RunnerFamily> {
  let parts: unknown[]
  if (typeof raw === 'string') parts = raw.split(',')
  else if (Array.isArray(raw)) parts = raw
  else return NO_FAMILIES
  const out = new Set<RunnerFamily>()
  for (const p of parts) {
    if (typeof p !== 'string') continue
    const name = p.trim().toLowerCase()
    if (KNOWN.has(name)) out.add(name as RunnerFamily)
  }
  for (const f of [...out]) {
    const need = FAMILY_REQUIRES[f]
    if (need && !out.has(need)) out.delete(f)
  }
  return out
}

/**
 * How a model sits in Sailor's menus (the image and video catalogues and the
 * plain model dropdowns, app/data/edit-model-options.ts). Pure data; the
 * rules that read it are in ./modelMenus.ts and ./blockedModels.ts.
 *   hidden        left out of the menus; still runs, prices and remaps
 *   discontinued  the ISO date its service stopped it: hidden, and a run using it is refused
 *   runnerOnly    no engine (ComfyUI) builder: runs only in Sailor's runner
 *   family        the runner switch that turns a runner-only model on
 */
export interface ModelFlags {
  hidden?: true
  discontinued?: string
  runnerOnly?: true
  family?: RunnerFamily
}
