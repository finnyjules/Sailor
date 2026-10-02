/**
 * The plain model dropdowns: Sailor's own list for each node's `model` combo
 * (the gallery nodes read app/data/image-models.ts and video-models.ts).
 *
 * The node definitions Sailor serves are adjusted from these on the way out
 * (shared/runner/modelMenus.ts `applyModelOverlay`), whether they came from
 * ComfyUI, the saved copy or the baseline:
 *   - every value here is a valid option, hidden or not, so a saved node
 *     keeps working;
 *   - the flags (shared/runner/families.ts `ModelFlags`) decide which values
 *     the menu leaves out;
 *   - `preference` decides the default: its first value that can run now.
 *
 * `value` is what the node stores and the engine reads, exactly as the Python
 * lists spell it (comfy_api_nodes/nodes_replicate.py). Never change or remove
 * one: saved projects hold them. `label` is what the menu shows.
 *
 * Pure data, relative imports only (Nitro, the app and vitest all load it).
 */
import type { ModelFlags } from '../../shared/runner/families'

export interface EditModelOption extends ModelFlags {
  value: string
  label: string
}

export interface EditModelMenu {
  options: readonly EditModelOption[]
  /** The default is the first of these that can run now. */
  preference: readonly string[]
}

/**
 * Keyed `Class.input`. The options are the Python lists, in their order. H2
 * hid the retired values (Flux Kontext Pro, Restyle's plain Nano Banana and
 * IP-Adapter, Real-ESRGAN): hidden, never removed.
 */
export const EDIT_MODEL_MENUS: Readonly<Record<string, EditModelMenu>> = {
  // _IMAGE_EDIT_MODELS (nodes_replicate.py:2722)
  'EditImageNode.model': {
    options: [
      { value: 'Nano Banana 2', label: 'Nano Banana 2' },
      { value: 'Flux Kontext Pro', label: 'Flux Kontext Pro', hidden: true },
      { value: 'Flux 2 Pro', label: 'Flux 2 Pro' },
      // Runner-only (model line-up F2): no Python builder; offered while its switch is on.
      { value: 'GPT Image 2.5', label: 'GPT Image 2.5', runnerOnly: true, family: 'gpt-image-2.5' },
      // Runner-only (model line-up F9): Seedream 5 Pro on Replicate, offered while its switch is on.
      { value: 'Seedream 5 Pro', label: 'Seedream 5 Pro', runnerOnly: true, family: 'seedream-5-pro-edit' },
    ],
    preference: ['Nano Banana 2'],
  },
  // _BLEND_SCENE_MODELS (nodes_replicate.py:2910)
  'BlendSceneNode.model': {
    options: [
      { value: 'Flux Kontext Pro', label: 'Flux Kontext Pro', hidden: true },
      { value: 'Flux 2 Pro', label: 'Flux 2 Pro' },
      // Retired (model line-up F11): Nano Banana 2 replaces it. Hidden, still runs and prices for saved projects.
      { value: 'Nano Banana', label: 'Nano Banana', hidden: true },
      // Runner-only (model line-up F11): the nano actions' Nano Banana 2 call, offered while its switch is on.
      { value: 'Nano Banana 2', label: 'Nano Banana 2', runnerOnly: true, family: 'nano-banana-2-blend' },
    ],
    // Python's default, Flux Kontext Pro, is hidden (model line-up H2). A new
    // node starts on Nano Banana 2 while its switch is on (F11), else Flux 2 Pro.
    preference: ['Nano Banana 2', 'Flux 2 Pro'],
  },
  // _RESTYLE_MODELS (nodes_replicate.py:3055)
  'RestyleFromImageNode.model': {
    options: [
      { value: 'Nano Banana 2', label: 'Nano Banana 2' },
      { value: 'Nano Banana Pro', label: 'Nano Banana Pro' },
      // Retired (model line-up H2): hidden, still run and priced for saved projects.
      { value: 'Nano Banana', label: 'Nano Banana', hidden: true },
      { value: 'Style Transfer · IP-Adapter', label: 'Style Transfer · IP-Adapter', hidden: true },
    ],
    preference: ['Nano Banana 2'],
  },
  // REFERENCE_MODEL_IDS (comfy_api_nodes/image_edit_models.py:146)
  'GenerateFromReferencesNode.model': {
    options: [
      { value: 'seedream-5-pro', label: 'Seedream 5 Pro' },
      { value: 'seedream-5-lite', label: 'Seedream 5 Lite' },
      { value: 'nano-banana-2', label: 'Nano Banana 2' },
    ],
    preference: ['seedream-5-pro'],
  },
  // _UPSCALE_MODELS (nodes_replicate.py:4163)
  'UpscaleImageNode.model': {
    options: [
      { value: 'Clarity', label: 'Clarity' },
      { value: 'Crystal', label: 'Crystal' },
      { value: 'Real-ESRGAN', label: 'Real-ESRGAN', hidden: true },
      { value: 'Recraft Crisp', label: 'Recraft Crisp' },
      { value: 'Topaz', label: 'Topaz' },
    ],
    preference: ['Clarity'],
  },
  // LipSyncNode `engine` (nodes_replicate.py:4960): "auto" picks Fabric for a
  // picture and Kling's lip-sync for a video. The labels are the Lip-sync
  // studio's own. sync-3 (sync.so) is runner-only (model line-up F22): no
  // Python builder; offered while its switch is on. The node reads
  // `model_options.engine` over this widget: shared/runner/lipSync.ts.
  // _REASON_MODELS: Think step by step. DeepSeek R1 (Python's default) fails at its
  // provider on every call (LC1 fix round 1, shared/runner/llm.ts DEEPSEEK_R1_DOWN):
  // hidden, never removed; a new node defaults to GPT-5.
  'ReasonStepByStepNode.model': {
    options: [
      { value: 'DeepSeek R1', label: 'DeepSeek R1', hidden: true },
      { value: 'GPT-5', label: 'GPT-5' },
      { value: 'Claude 4.5 Sonnet', label: 'Claude 4.5 Sonnet' },
    ],
    preference: ['GPT-5'],
  },
  'LipSyncNode.engine': {
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'fabric', label: 'Fabric' },
      { value: 'sync', label: 'Sync' },
      { value: 'sync-3', label: 'sync-3', runnerOnly: true, family: 'sync-3' },
    ],
    preference: ['auto'],
  },
}
