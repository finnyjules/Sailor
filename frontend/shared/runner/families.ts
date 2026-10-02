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
  /** Ideogram 4.5 on fal, no backup: a runner-only image model (text-to-image only). */
  | 'ideogram-4.5'
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
   * Face swap on fal's face swap (Easel's advanced face swap before LC1), no backup. Moves the whole
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
  /**
   * 3D models on Replicate (step 3, R3.9): Generate a 3D model (Hunyuan3D 2)
   * and its hidden twin, and Multi-View → 3D (TRELLIS, Rodin or
   * Hunyuan3D-2mv). Their GLB is saved as the user's own asset and handed on
   * by its Sailor address (a `glb` value) to the 3D model card, 3D Studio or
   * a Text card. Needs `cards`: their pictures come from Image cards and
   * LoadImage. Off: they go to ComfyUI, as before.
   */
  | 'gen-3d'
  /**
   * Film a shot's preset path (step 3, R3.11): the node writes the camera
   * phrase from its preset and overrides (shared/runner/shotPresets.ts) and
   * films it exactly as Generate a video films that model, on every model the
   * runner films for Generate a video (each under its own family too). The
   * shot-directed path is taken without it. Needs `cards`, as the other R3
   * families. Off: a preset shot goes to ComfyUI, as before.
   */
  | 'film-shot'
  /**
   * Text effect, sketch to image and face references on Replicate (step 3,
   * R3.12): Text effect (Ideogram V3 Turbo, or Flux Kontext Pro restyling a
   * wired picture of the word), Sketch to image (Nano Banana) and Generate
   * face references (Ideogram Character). Needs `cards`: their pictures come
   * from Image cards and LoadImage, their prompts take text wires. Off: they
   * go to ComfyUI, as before.
   */
  | 'image-extras'
  /**
   * Flux Dev + LoRA and Flux Dev + LoRAs on Replicate (step 3, R3.13; R3.14
   * adds Restyle with a style LoRA): the user's trained model or
   * flux-dev-lora, and flux-dev-multi-lora with its reload retry. A LoRA
   * picked by name is read from models/loras/ (its sidecar only); hosted
   * takes public LoRA links only (ruling (i)). Needs `cards`: their pictures
   * come from Image cards and LoadImage, their prompts take text wires. Off:
   * they go to ComfyUI, as before.
   */
  | 'lora'
  /**
   * Lens · 3D Reframe and Pose Mannequin on Replicate's Nano Banana 2 at 1K
   * (step 3, R3.15), fal's Nano Banana 2 edit the backup, as the nano
   * actions: Lens reframe re-shoots a picture on another lens; Pose Mannequin
   * re-poses a character from a pose picture, a pose prompt or the pose
   * editor's mannequin, or hands on the editor's saved pose (no call, free).
   * Needs `cards`: their pictures come from Image cards and LoadImage, their
   * prompts take text wires. Off: they go to ComfyUI, as before.
   */
  | 'nano-extras'
  /**
   * Turntable's front-only spin on Replicate's Luma Ray 2 720p (step 3,
   * R3.16), no backup: a product's front picture turned 360° into a seamless
   * loop. With right, back or left views wired (R3.17): one Seedance 2.0 arc
   * per segment on fal, no backup, stitched with Sailor's own video tools, so
   * only while `media-video` is on too (else ComfyUI, as before). Needs
   * `cards`: its pictures come from Image cards and LoadImage, its extra
   * direction takes a text wire. Off: it goes to ComfyUI, as before.
   */
  | 'turntable'
  /**
   * The sound nodes, computed by Sailor's own server (step 3, R5.3): Load
   * audio, Record audio, Save audio (FLAC and MP3), Preview audio, and the
   * Audio card beyond its sync-3 and audio-gen rows (its FLAC preview, and
   * its export in each format). Free; the savers, the preview and the card
   * count as work. Needs `cards`, and the video tools (R5.1a): while they are
   * missing or refused, the server answers as if it were off
   * (server/runner/config.ts). Off: they go to ComfyUI, as before.
   */
  | 'media-sound'
  /**
   * The video nodes, computed by Sailor's own server (step 3, R5.4): Load
   * video, Get video components, Create video, Save video, and the Video
   * card's export and made videos; and (R5.5) Load video frames and Save
   * video frames. Free; Get video components, Save video, the card and both
   * frames nodes count as work. Needs `cards`, and the video tools (R5.1a):
   * while they are missing or refused, the server answers as if it were off
   * (server/runner/config.ts). Off: they go to ComfyUI, and the Video card
   * is exactly as before.
   */
  | 'media-video'
  /**
   * The paid nodes that send a sound (step 3, R3.10): Transcribe audio and
   * its hidden twin (fal's Wizper), Identify speakers, Clone a singing voice
   * and Sync lips to audio and its hidden twin (Replicate). Each sends
   * Python's WAV of its sound (the first 60 s, 16-bit), made with Sailor's
   * own video tools from any runner sound. Needs `cards`, and the video tools
   * (R5.1a): while they are missing or refused, the server answers as if it
   * were off (server/runner/config.ts). Off: they go to ComfyUI, as before.
   */
  | 'sound-in'
  /**
   * The video and sound effects, computed by Sailor's own server (step 3, R6),
   * one family per kind of work (R6 ruling (h), shared/runner/mediaEffects.ts):
   * time (Trim, Reverse, Frame trail…), joining two clips, frame looks,
   * Stabilize, Slow motion by optical flow, made clips, text on video, the
   * sound effects and noise removal. Free; each counts as work. Each needs its
   * media family (the video ones `media-video`, the sound ones `media-sound`),
   * which needs `cards` (FAMILY_REQUIRES), and the video tools: while they are
   * missing or refused, the server answers as if it were off. Off: they go to
   * ComfyUI, as before.
   */
  | 'video-time'
  | 'video-join'
  | 'video-look'
  | 'video-stabilize'
  | 'video-flow'
  | 'video-draw'
  | 'video-text'
  | 'sound-effects'
  | 'sound-denoise'
  /**
   * The nodes that ran an AI model on this computer, moved onto a paid
   * service each (step 3, R7; shared/runner/localModels.ts): one family per
   * node or pair. Each is off by default and needs `cards` (Slow motion (AI)
   * `media-video`; Whisper transcribe and Vocal separator `media-sound`:
   * LOCAL_MODEL_REQUIRES). Lens · Depth of field (`lens-blur`) stays free,
   * in the server. Off: they go to ComfyUI, which runs the local model, free.
   */
  | 'bg-remove'
  | 'upscale-2x'
  | 'object-remove'
  | 'sam-3-masks'
  | 'subject-mask'
  | 'slow-motion-ai'
  | 'whisper-captions'
  | 'vocal-split'
  | 'lens-blur'
  /**
   * The three Recraft SVG models of Generate an image on Replicate (step 3,
   * R11.4; shared/runner/svgImage.ts): the runner saves the SVG and hands on
   * its address, which only Save image and Preview image read. Off by
   * default and needs `cards` (LATE_FAMILY_REQUIRES). Off: they go to
   * ComfyUI, as before (where Python can't decode the SVG).
   */
  | 'recraft-svg'

export const RUNNER_FAMILIES: readonly RunnerFamily[] = [
  'fal-edit', 'replicate-image', 'replicate-video', 'nano-actions', 'ref-edits', 'restyle', 'frame', 'wan-3', 'gpt-image-2.5', 'h3-max-turbo', 'gemini-omni-flash', 'veo-3.1-lite', 'qwen-image-3', 'grok-imagine-2', 'ideogram-4', 'seedream-5-pro-edit', 'qwen-2511-angles', 'nano-banana-2-blend', 'bria-product-shot', 'muse-image', 'nano-banana-2-lite', 'reve-2.1', 'recraft-v4.1', 'krea-2', 'happyhorse-1.1', 'grok-imagine-video-1.5', 'ltx-2.5-fast', 'luma-ray-3.2', 'sync-3', 'topaz-video', 'fix-faces', 'face-swap', 'person-swap-video', 'cards',
  'effects-tone', 'effects-blur', 'effects-cells', 'effects-warp', 'effects-mask', 'effects-noise', 'shader-bake', 'live-previews',
  'llm-text', 'describe', 'image-repair', 'layers', 'audio-gen', 'gen-3d', 'film-shot', 'image-extras', 'lora', 'nano-extras', 'turntable',
]

/**
 * The families whose work needs the server's video tools (R5.1a, R5.3, R5.4, R3.10): while
 * `mediaTools()` is missing or refused, the server drops them from what it
 * takes (server/runner/config.ts), so their classes go to the engine.
 * Known to parseFamilies, but kept apart from RUNNER_FAMILIES: every
 * "every family on" set written before R5 (the specs' ALL sets, pinned
 * needs-the-engine hashes) stays exactly as it was (R5 rule 8).
 */
export const MEDIA_TOOL_FAMILIES: readonly RunnerFamily[] = ['media-sound', 'media-video', 'sound-in']

/**
 * R6's nine families (the video and sound effects), which need the video
 * tools too: dropped with MEDIA_TOOL_FAMILIES while the tools are missing or
 * refused (server/runner/config.ts; they also need `media-video` or
 * `media-sound`, FAMILY_REQUIRES). A list of their own, so R5's list (pinned
 * by its specs) stays as it was, and kept apart from RUNNER_FAMILIES, so every
 * "every family on" set written before R6 stays as it was too.
 */
export const MEDIA_EFFECT_TOOL_FAMILIES: readonly RunnerFamily[] = [
  'video-time', 'video-join', 'video-look', 'video-stabilize', 'video-flow', 'video-draw', 'video-text', 'sound-effects', 'sound-denoise',
]

/**
 * R7's nine families (the local-model nodes moved onto paid services, and
 * Lens · Depth of field in the server): known to parseFamilies, but kept
 * apart from RUNNER_FAMILIES, as R6's are, so every pinned "every family on"
 * set stays as it was. Their requirements are LOCAL_MODEL_REQUIRES.
 */
export const LOCAL_MODEL_FAMILIES: readonly RunnerFamily[] = [
  'bg-remove', 'upscale-2x', 'object-remove', 'sam-3-masks', 'subject-mask', 'slow-motion-ai', 'whisper-captions', 'vocal-split', 'lens-blur',
]

/**
 * The R7 families whose work needs the server's video tools: dropped with
 * the media families while the tools are missing or refused
 * (server/runner/config.ts), as their requirement is.
 */
export const LOCAL_MODEL_TOOL_FAMILIES: readonly RunnerFamily[] = ['slow-motion-ai', 'whisper-captions', 'vocal-split']

/**
 * Families added after R7 (R11.4's `recraft-svg`; the runner-only image
 * models added since, which need nothing else on): known to parseFamilies,
 * but kept apart from every pinned list, as R7's are. Their requirements are
 * LATE_FAMILY_REQUIRES.
 */
export const LATE_FAMILIES: readonly RunnerFamily[] = ['recraft-svg', 'ideogram-4.5']

/**
 * Every family before R7: RUNNER_FAMILIES, the media families and R6's (the
 * "every family on" set specs pin). parseFamilies knows R7's too
 * (LOCAL_MODEL_FAMILIES), kept out of this list so those sets stay as they were.
 */
export const ALL_RUNNER_FAMILIES: readonly RunnerFamily[] = [...RUNNER_FAMILIES, ...MEDIA_TOOL_FAMILIES, ...MEDIA_EFFECT_TOOL_FAMILIES]

/**
 * A family that works only while another is on too (R2): with its
 * requirement off, parseFamilies drops it. A requirement may have its own
 * (R6: `video-time` needs `media-video`, which needs `cards`,
 * MEDIA_EFFECT_REQUIRES): the whole chain must be on.
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
  'gen-3d': 'cards',
  'film-shot': 'cards',
  'image-extras': 'cards',
  'lora': 'cards',
  'nano-extras': 'cards',
  'turntable': 'cards',
  'media-sound': 'cards',
  'media-video': 'cards',
  'sound-in': 'cards',
}

/**
 * R6's requirements: each video effect family needs `media-video`, each sound
 * one `media-sound` (both of which need `cards`). A table of its own beside
 * FAMILY_REQUIRES (whose keys R2's specs pin), read with it everywhere
 * (`requirementOf`).
 */
export const MEDIA_EFFECT_REQUIRES: Partial<Record<RunnerFamily, RunnerFamily>> = {
  'video-time': 'media-video',
  'video-join': 'media-video',
  'video-look': 'media-video',
  'video-stabilize': 'media-video',
  'video-flow': 'media-video',
  'video-draw': 'media-video',
  'video-text': 'media-video',
  'sound-effects': 'media-sound',
  'sound-denoise': 'media-sound',
}

/**
 * R7's requirements (the table in the plan): every local-model family needs
 * `cards`, but Slow motion (AI) `media-video` and Whisper transcribe and
 * Vocal separator `media-sound` (which need `cards`). A table of its own,
 * read with the others (`requirementOf`).
 */
export const LOCAL_MODEL_REQUIRES: Partial<Record<RunnerFamily, RunnerFamily>> = {
  'bg-remove': 'cards',
  'upscale-2x': 'cards',
  'object-remove': 'cards',
  'sam-3-masks': 'cards',
  'subject-mask': 'cards',
  'slow-motion-ai': 'media-video',
  'whisper-captions': 'media-sound',
  'vocal-split': 'media-sound',
  'lens-blur': 'cards',
}

/** The late families' requirements (R11.4: Recraft SVG's value is read by Save image and Preview image, cards machinery). */
export const LATE_FAMILY_REQUIRES: Partial<Record<RunnerFamily, RunnerFamily>> = {
  'recraft-svg': 'cards',
}

/** The family a family needs on too (FAMILY_REQUIRES, then MEDIA_EFFECT_REQUIRES, LOCAL_MODEL_REQUIRES and LATE_FAMILY_REQUIRES), or undefined. */
export function requirementOf(family: RunnerFamily): RunnerFamily | undefined {
  return FAMILY_REQUIRES[family] ?? MEDIA_EFFECT_REQUIRES[family] ?? LOCAL_MODEL_REQUIRES[family] ?? LATE_FAMILY_REQUIRES[family]
}

/** R11.9a: every family parseFamilies knows (R7's and the late ones too): "would the runner take it with everything on". */
export const EVERY_KNOWN_FAMILY: ReadonlySet<RunnerFamily> = new Set([...ALL_RUNNER_FAMILIES, ...LOCAL_MODEL_FAMILIES, ...LATE_FAMILIES])
const KNOWN: ReadonlySet<string> = EVERY_KNOWN_FAMILY

/** No family switched on. */
export const NO_FAMILIES: ReadonlySet<RunnerFamily> = new Set()

/** Whether a family is on: switched on, and its requirement (FAMILY_REQUIRES) with it, down the whole chain (R6). */
export function familyOn(family: RunnerFamily, families: ReadonlySet<RunnerFamily>): boolean {
  let f: RunnerFamily | undefined = family
  // A chain is short (at most three today); the bound only guards against a loop in the table.
  for (let depth = 0; f && depth < 16; depth++) {
    if (!families.has(f)) return false
    f = requirementOf(f)
  }
  return !f
}

/**
 * A comma list of family names → the set. Unknown names are dropped; anything
 * unreadable (not a string or a list of strings) is no families at all. A
 * family whose requirement (FAMILY_REQUIRES) is off is dropped too, again
 * until nothing changes (R6.1: one pass could keep a family whose
 * requirement is dropped later in the same pass).
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
  let changed = true
  while (changed) {
    changed = false
    for (const f of [...out]) {
      const need = requirementOf(f)
      if (need && !out.has(need)) { out.delete(f); changed = true }
    }
  }
  return out
}

/**
 * How a model sits in Sailor's menus (the image and video catalogues and the
 * plain model dropdowns, app/data/edit-model-options.ts). Pure data; the
 * rules that read it are in ./modelMenus.ts and ./blockedModels.ts.
 *   hidden        left out of the menus; still runs, prices and remaps
 *   discontinued  the ISO date its service stopped it: hidden, and a run using it is refused
 *   unpriced      no verified price yet: hidden, and a run using it is refused, until priced
 *   runnerOnly    no engine (ComfyUI) builder: runs only in Sailor's runner
 *   family        the runner switch that turns a runner-only model on
 */
export interface ModelFlags {
  hidden?: true
  discontinued?: string
  /** No verified price yet (R11.4, ruling (p)): hidden, and a run using it is refused before any hold, on every path. */
  unpriced?: true
  runnerOnly?: true
  family?: RunnerFamily
}
