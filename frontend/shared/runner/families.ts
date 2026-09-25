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

export const RUNNER_FAMILIES: readonly RunnerFamily[] = [
  'fal-edit', 'replicate-image', 'replicate-video', 'nano-actions', 'ref-edits', 'restyle', 'frame', 'wan-3', 'gpt-image-2.5', 'h3-max-turbo', 'gemini-omni-flash', 'veo-3.1-lite', 'qwen-image-3', 'grok-imagine-2', 'ideogram-4', 'seedream-5-pro-edit', 'qwen-2511-angles', 'nano-banana-2-blend', 'bria-product-shot', 'muse-image', 'nano-banana-2-lite', 'reve-2.1',
]

const KNOWN: ReadonlySet<string> = new Set(RUNNER_FAMILIES)

/** No family switched on. */
export const NO_FAMILIES: ReadonlySet<RunnerFamily> = new Set()

/**
 * A comma list of family names → the set. Unknown names are dropped; anything
 * unreadable (not a string or a list of strings) is no families at all.
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
