/**
 * Image-generation model catalog — single source of truth for the
 * "Generate an image" node's UI side. The Python side mirrors this
 * (see comfy_api_nodes/image_models.py) and is responsible for the
 * actual Replicate calls.
 *
 * Adding a model: append an entry here AND a matching one in image_models.py.
 * Keep `id` identical across the two — it's the dispatch key.
 *
 * Scope: text-to-image models on Replicate that take a standard
 * `aspect_ratio` parameter. Models with `width/height`, `size` enums,
 * or non-standard input names (Wan 2.7, HiDream, SANA, SDXL, Z-Image,
 * Riverflow, etc.) are intentionally excluded for v1 — they need a
 * different node-side aspect-ratio control which we'll add later.
 */

import type { ModelFlags } from '../../shared/runner/families'

export type ImageModelTag =
  | 'flagship'      // best-in-class generalist
  | 'fast'          // optimized for speed
  | 'cheap'         // ≤ $0.01 / image
  | 'typography'    // reliable text rendering
  | 'design'        // posters/layouts/graphic design
  | 'svg'           // vector output
  | 'photoreal'     // photography-grade realism
  | 'cinematic'     // film-like aesthetic
  | 'anime'         // anime/illustration
  | 'open-source'   // SD-family / open weights
  | '4k'            // native high-resolution
  | 'multi-image'   // accepts multiple reference images

export const TAG_LABELS: Record<ImageModelTag, string> = {
  'flagship':    'Flagship',
  'fast':        'Fast',
  'cheap':       'Cheap',
  'typography':  'Typography',
  'design':      'Design',
  'svg':         'Vector / SVG',
  'photoreal':   'Photoreal',
  'cinematic':   'Cinematic',
  'anime':       'Anime',
  'open-source': 'Open-source',
  '4k':          '4K native',
  'multi-image': 'Multi-image',
}

export type ImageModelBrand =
  | 'BFL' | 'Google' | 'OpenAI' | 'ByteDance' | 'Ideogram'
  | 'Recraft' | 'Stability AI' | 'Alibaba' | 'Tencent' | 'xAI'
  | 'Pruna' | 'Meta' | 'Bria' | 'Luma' | 'MiniMax' | 'Reve' | 'Krea' | 'Other'

export interface ImageModelAdvancedField {
  name: string
  type: 'integer' | 'float' | 'boolean' | 'select' | 'string'
  label: string
  default: any
  description?: string
  options?: string[]      // select only
  min?: number            // integer/float
  max?: number
  step?: number
}

export interface ImageModel extends ModelFlags {
  id: string                       // dispatch key — matches Python side
  label: string                    // 'Flux 1.1 Pro'
  brand: ImageModelBrand
  replicateSlug: string            // 'black-forest-labs/flux-1.1-pro'
  pitch: string                    // one-line "best for" hook
  description?: string             // longer body for the detail pane
  tags: ImageModelTag[]
  pricePerImage: number | null     // USD; null = varies / unknown
  aspectRatios: string[]           // model-specific options for the gallery
  defaultAspectRatio: string
  thumb?: string                   // preview image URL (relative or absolute)
  advanced: ImageModelAdvancedField[]
}

// ---- Reusable advanced-field presets shared across families ---------------

const SAFETY_TOLERANCE_FLUX: ImageModelAdvancedField = {
  name: 'safety_tolerance', type: 'integer', label: 'Safety tolerance',
  default: 2, min: 1, max: 6,
  description: '1 is the strictest; 6 is the most permissive.',
}
const PROMPT_UPSAMPLING_FLUX: ImageModelAdvancedField = {
  name: 'prompt_upsampling', type: 'boolean', label: 'Let model rewrite prompt',
  default: false,
  description: 'BFL\'s "magic prompt" — expands your prompt server-side.',
}
const OUTPUT_FORMAT_WPJ: ImageModelAdvancedField = {
  name: 'output_format', type: 'select', label: 'Output format',
  default: 'png', options: ['png', 'jpg', 'webp'],
}
const OUTPUT_QUALITY: ImageModelAdvancedField = {
  name: 'output_quality', type: 'integer', label: 'Output quality',
  default: 90, min: 1, max: 100,
}

const IDEOGRAM_V3_STYLE: ImageModelAdvancedField = {
  name: 'style_type', type: 'select', label: 'Style override',
  default: 'None', options: ['None', 'Auto', 'General', 'Realistic', 'Design'],
  description: '"None" lets the model decide.',
}
const IDEOGRAM_MAGIC_PROMPT: ImageModelAdvancedField = {
  name: 'magic_prompt', type: 'select', label: 'Magic prompt',
  default: 'Auto', options: ['Auto', 'On', 'Off'],
  description: 'Ideogram-side prompt expansion.',
}

const GOOGLE_SAFETY_FILTER: ImageModelAdvancedField = {
  name: 'safety_filter_level', type: 'select', label: 'Safety filter',
  default: 'block_only_high',
  options: ['block_low_and_above', 'block_medium_and_above', 'block_only_high'],
  description: 'Google\'s content-safety threshold.',
}

// Common aspect-ratio sets — kept here so models that share a list don't
// drift apart as the catalog grows.
const FLUX_PRO_AR     = ['1:1', '16:9', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3', '9:16']
const FLUX_DEV_AR     = ['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3', '9:16', '9:21']
const FLUX_2_AR       = ['1:1', '16:9', '3:2', '2:3', '4:5', '5:4', '9:16', '3:4', '4:3']
const IDEOGRAM_V2_AR  = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '16:10', '10:16', '3:1', '1:3']
const IDEOGRAM_V3_AR  = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '16:10', '10:16', '1:3', '3:1', '1:2', '2:1', '4:5', '5:4']
const GOOGLE_AR       = ['1:1', '16:9', '9:16', '4:3', '3:4']
const NANO_BANANA_AR  = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const SEEDREAM_AR     = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9']
const RECRAFT_AR      = ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '4:5', '5:4', '1:2', '2:1']
const SD35_AR         = ['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '9:16', '9:21']
const PHOTON_AR       = ['1:1', '3:4', '4:3', '9:16', '16:9', '9:21', '21:9']
const BRIA_AR         = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9']
const MINIMAX_AR      = ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9']
const QWEN_AR         = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']
const OPENAI_AR       = ['1:1', '3:2', '2:3']
const HUNYUAN_AR      = ['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3', '9:16', '9:21']
const GROK_AR         = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2']
const FLUX_FAST_AR    = ['1:1', '16:9', '21:9', '3:2', '2:3', '4:5', '5:4', '3:4', '4:3', '9:16', '9:21']
const REVE_AR         = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']
const KREA_AR         = ['1:1', '4:3', '3:2', '16:9', '2.35:1', '4:5', '2:3', '9:16']

// ---- Catalog -------------------------------------------------------------

export const IMAGE_MODELS: ImageModel[] = [
  // ===== BFL ================================================================
  {
    id: 'flux-1.1-pro',
    hidden: true,
    label: 'Flux 1.1 Pro',
    brand: 'BFL',
    replicateSlug: 'black-forest-labs/flux-1.1-pro',
    pitch: 'Top general-purpose quality. The reliable default.',
    description:
      'BFL\'s workhorse Pro tier — strong photoreal output, good prompt adherence, '
      + 'sane defaults. Use it when you don\'t know what else to pick.',
    tags: ['flagship', 'photoreal'],
    pricePerImage: 0.08,
    aspectRatios: FLUX_PRO_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      SAFETY_TOLERANCE_FLUX,
      PROMPT_UPSAMPLING_FLUX,
      OUTPUT_FORMAT_WPJ,
    ],
  },
  {
    id: 'flux-1.1-pro-ultra',
    hidden: true,
    label: 'Flux 1.1 Pro Ultra',
    brand: 'BFL',
    replicateSlug: 'black-forest-labs/flux-1.1-pro-ultra',
    pitch: '4-megapixel Flux Pro with a "raw" mode for less-stylized photography.',
    description:
      'Same Flux Pro lineage cranked up to 4 MP. "Raw" mode produces more naturalistic, '
      + 'less-processed images — good when you want a photo, not a render.',
    tags: ['4k', 'photoreal', 'flagship'],
    pricePerImage: 0.06,
    aspectRatios: ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '9:21'],
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'raw', type: 'boolean', label: 'Raw mode', default: false,
        description: 'Less processed, more natural look.' },
      SAFETY_TOLERANCE_FLUX,
      { name: 'output_format', type: 'select', label: 'Output format', default: 'jpg', options: ['jpg', 'png'] },
    ],
  },
  {
    id: 'flux-pro',
    hidden: true,
    label: 'Flux Pro',
    brand: 'BFL',
    replicateSlug: 'black-forest-labs/flux-pro',
    pitch: 'The original Flux Pro — proven workhorse predating the 1.1 / 2 lineage.',
    tags: ['photoreal'],
    pricePerImage: 0.055,
    aspectRatios: FLUX_PRO_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'guidance', type: 'float', label: 'Guidance', default: 3, min: 2, max: 5, step: 0.1 },
      SAFETY_TOLERANCE_FLUX,
      PROMPT_UPSAMPLING_FLUX,
      OUTPUT_FORMAT_WPJ,
    ],
  },
  {
    id: 'flux-dev',
    label: 'Flux Dev',
    brand: 'BFL',
    replicateSlug: 'black-forest-labs/flux-dev',
    pitch: 'Open-weights 12B Flux — the community baseline behind every Flux fine-tune.',
    tags: ['open-source'],
    pricePerImage: 0.025,
    aspectRatios: FLUX_DEV_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'num_inference_steps', type: 'integer', label: 'Inference steps', default: 28, min: 1, max: 50,
        description: '28-50 recommended for Dev.' },
      { name: 'guidance', type: 'float', label: 'Guidance', default: 3.5, min: 0, max: 10, step: 0.1 },
      { name: 'megapixels', type: 'select', label: 'Megapixels', default: '1', options: ['1', '0.25'] },
      { name: 'go_fast', type: 'boolean', label: 'Go fast', default: true },
      OUTPUT_FORMAT_WPJ,
    ],
  },
  {
    id: 'flux-schnell',
    label: 'Flux Schnell',
    brand: 'BFL',
    replicateSlug: 'black-forest-labs/flux-schnell',
    pitch: '4-step Flux for rapid iteration — 333 images per dollar.',
    tags: ['fast', 'cheap', 'open-source'],
    pricePerImage: 0.006,
    aspectRatios: FLUX_DEV_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'num_inference_steps', type: 'integer', label: 'Inference steps', default: 4, min: 1, max: 4 },
      { name: 'megapixels', type: 'select', label: 'Megapixels', default: '1', options: ['1', '0.25'] },
      { name: 'go_fast', type: 'boolean', label: 'Go fast', default: true },
      OUTPUT_FORMAT_WPJ,
    ],
  },
  {
    id: 'flux-2-max',
    label: 'Flux 2 Max',
    brand: 'BFL',
    replicateSlug: 'black-forest-labs/flux-2-max',
    pitch: 'BFL\'s highest-fidelity model — product photography and character consistency.',
    tags: ['flagship', 'photoreal'],
    pricePerImage: 0.10,
    aspectRatios: FLUX_2_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'resolution', type: 'select', label: 'Resolution', default: '1 MP',
        options: ['0.5 MP', '1 MP', '2 MP', '4 MP'] },
      { name: 'safety_tolerance', type: 'integer', label: 'Safety tolerance', default: 2, min: 1, max: 5 },
      { ...OUTPUT_FORMAT_WPJ, default: 'webp' },
    ],
  },
  {
    id: 'flux-2-pro',
    label: 'Flux 2 Pro',
    brand: 'BFL',
    replicateSlug: 'black-forest-labs/flux-2-pro',
    pitch: 'Most of Flux 2 Max\'s quality at half the price — supports JSON prompts.',
    tags: ['flagship'],
    pricePerImage: 0.045,
    aspectRatios: FLUX_2_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'resolution', type: 'select', label: 'Resolution', default: '1 MP',
        options: ['0.5 MP', '1 MP', '2 MP', '4 MP'] },
      { name: 'safety_tolerance', type: 'integer', label: 'Safety tolerance', default: 2, min: 1, max: 5 },
      { ...OUTPUT_FORMAT_WPJ, default: 'webp' },
    ],
  },
  {
    id: 'flux-2-flex',
    label: 'Flux 2 Flex',
    brand: 'BFL',
    replicateSlug: 'black-forest-labs/flux-2-flex',
    pitch: 'Tunable Flux 2 — exposes steps and guidance to trade speed for fidelity.',
    tags: ['flagship', 'typography'],
    pricePerImage: 0.12,
    aspectRatios: FLUX_2_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'resolution', type: 'select', label: 'Resolution', default: '1 MP',
        options: ['0.5 MP', '1 MP', '2 MP', '4 MP'] },
      { name: 'steps', type: 'integer', label: 'Steps', default: 30, min: 1, max: 50 },
      { name: 'guidance', type: 'float', label: 'Guidance', default: 4.5, min: 1.5, max: 10, step: 0.1 },
      { name: 'safety_tolerance', type: 'integer', label: 'Safety tolerance', default: 2, min: 1, max: 5 },
      { name: 'prompt_upsampling', type: 'boolean', label: 'Let model rewrite prompt', default: true },
      { ...OUTPUT_FORMAT_WPJ, default: 'webp' },
    ],
  },
  {
    id: 'flux-2-klein-4b',
    label: 'Flux 2 Klein 4B',
    brand: 'BFL',
    replicateSlug: 'black-forest-labs/flux-2-klein-4b',
    pitch: 'Sub-second 4B-parameter Flux 2 — cheapest, fastest in the family.',
    tags: ['fast', 'cheap'],
    pricePerImage: 0.002,
    aspectRatios: ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '21:9', '9:21'],
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'output_megapixels', type: 'select', label: 'Megapixels', default: '1',
        options: ['0.25', '0.5', '1', '2', '4'] },
      { name: 'go_fast', type: 'boolean', label: 'Extra optimizations', default: false },
      { ...OUTPUT_FORMAT_WPJ, default: 'jpg' },
    ],
  },
  {
    id: 'flux-2-dev',
    label: 'Flux 2 Dev',
    brand: 'BFL',
    replicateSlug: 'black-forest-labs/flux-2-dev',
    pitch: 'Open-weight Flux 2 — tunable steps and guidance, self-hostable lineage.',
    tags: ['flagship', 'typography'],
    pricePerImage: 0.024,
    aspectRatios: FLUX_2_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'resolution', type: 'select', label: 'Resolution', default: '1 MP',
        options: ['0.5 MP', '1 MP', '2 MP', '4 MP'] },
      { name: 'steps', type: 'integer', label: 'Steps', default: 28, min: 1, max: 50 },
      { name: 'guidance', type: 'float', label: 'Guidance', default: 3.5, min: 1.5, max: 10, step: 0.1 },
      { name: 'safety_tolerance', type: 'integer', label: 'Safety tolerance', default: 2, min: 1, max: 5 },
      { ...OUTPUT_FORMAT_WPJ, default: 'webp' },
    ],
  },

  // ===== Krea ===============================================================
  {
    id: 'krea-2-large',
    label: 'Krea 2 Large',
    brand: 'Krea',
    replicateSlug: 'krea/krea-2-large',
    pitch: 'Krea\'s foundation model — photoreal, raw aesthetics, strong style transfer.',
    tags: ['flagship', 'photoreal'],
    pricePerImage: 0.06,
    aspectRatios: KREA_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'creativity', type: 'select', label: 'Creativity', default: 'medium',
        options: ['raw', 'low', 'medium', 'high'],
        description: '"raw" renders only what you describe; "high" takes creative liberty.' },
    ],
  },
  {
    id: 'krea-2-medium',
    label: 'Krea 2 Medium',
    brand: 'Krea',
    replicateSlug: 'krea/krea-2-medium',
    pitch: 'Smaller, faster Krea 2 — strong for illustration, anime, and painterly styles.',
    tags: ['fast'],
    pricePerImage: 0.03,
    aspectRatios: KREA_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'creativity', type: 'select', label: 'Creativity', default: 'medium',
        options: ['raw', 'low', 'medium', 'high'] },
    ],
  },

  // ===== Google =============================================================
  {
    id: 'nano-banana-pro',
    label: 'Nano Banana Pro',
    brand: 'Google',
    replicateSlug: 'google/nano-banana-pro',
    pitch: 'Gemini 3 Pro reasoning plus 4K output — Google\'s premium tier.',
    description:
      'Nano Banana on Gemini 3 Pro reasoning with native 4K output. Best for prompts '
      + 'where the model needs to think about the scene before rendering it.',
    tags: ['4k', 'flagship', 'typography', 'multi-image'],
    pricePerImage: 0.15,
    aspectRatios: NANO_BANANA_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'resolution', type: 'select', label: 'Resolution', default: '2K', options: ['1K', '2K', '4K'] },
      { name: 'output_format', type: 'select', label: 'Output format', default: 'jpg', options: ['jpg', 'png'] },
      GOOGLE_SAFETY_FILTER,
    ],
  },
  {
    id: 'nano-banana-2',
    label: 'Nano Banana 2',
    brand: 'Google',
    replicateSlug: 'google/nano-banana-2',
    pitch: 'Multilingual text rendering plus 14-image fusion and search grounding.',
    tags: ['typography', 'multi-image'],
    pricePerImage: 0.08,
    aspectRatios: ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'],
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'resolution', type: 'select', label: 'Resolution', default: '1K', options: ['1K', '2K', '4K'] },
      { name: 'google_search', type: 'boolean', label: 'Google search grounding', default: false,
        description: 'Pull real-time facts via Google Web Search.' },
      { name: 'image_search', type: 'boolean', label: 'Google image search grounding', default: false },
      { name: 'output_format', type: 'select', label: 'Output format', default: 'jpg', options: ['jpg', 'png'] },
    ],
  },
  {
    id: 'imagen-4-ultra',
    label: 'Imagen 4 Ultra',
    brand: 'Google',
    replicateSlug: 'google/imagen-4-ultra',
    pitch: 'Maximum fine-detail rendering at 2K — quality over speed.',
    tags: ['flagship', 'photoreal'],
    pricePerImage: 0.06,
    aspectRatios: GOOGLE_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'output_format', type: 'select', label: 'Output format', default: 'jpg', options: ['jpg', 'png'] },
      GOOGLE_SAFETY_FILTER,
    ],
  },
  {
    id: 'imagen-4',
    label: 'Imagen 4',
    brand: 'Google',
    replicateSlug: 'google/imagen-4',
    pitch: 'Google\'s flagship general-purpose model — balanced quality and speed.',
    tags: ['flagship'],
    pricePerImage: 0.04,
    aspectRatios: GOOGLE_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'output_format', type: 'select', label: 'Output format', default: 'jpg', options: ['jpg', 'png'] },
      GOOGLE_SAFETY_FILTER,
    ],
  },
  {
    id: 'imagen-4-fast',
    label: 'Imagen 4 Fast',
    brand: 'Google',
    replicateSlug: 'google/imagen-4-fast',
    pitch: 'Cheapest Imagen 4 tier — 50 images per dollar with the same aspect set.',
    tags: ['fast', 'cheap'],
    pricePerImage: 0.02,
    aspectRatios: GOOGLE_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'output_format', type: 'select', label: 'Output format', default: 'jpg', options: ['jpg', 'png'] },
      GOOGLE_SAFETY_FILTER,
    ],
  },
  {
    id: 'imagen-3',
    hidden: true,
    label: 'Imagen 3',
    brand: 'Google',
    replicateSlug: 'google/imagen-3',
    pitch: 'Previous-gen Imagen — strong photoreal detail and rich textures.',
    tags: ['photoreal'],
    pricePerImage: 0.05,
    aspectRatios: GOOGLE_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'output_format', type: 'select', label: 'Output format', default: 'jpg', options: ['jpg', 'png'] },
      GOOGLE_SAFETY_FILTER,
    ],
  },
  {
    id: 'imagen-3-fast',
    hidden: true,
    label: 'Imagen 3 Fast',
    brand: 'Google',
    replicateSlug: 'google/imagen-3-fast',
    pitch: 'Half-price Imagen 3 for quick iteration.',
    tags: ['fast', 'cheap'],
    pricePerImage: 0.025,
    aspectRatios: GOOGLE_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'output_format', type: 'select', label: 'Output format', default: 'jpg', options: ['jpg', 'png'] },
      GOOGLE_SAFETY_FILTER,
    ],
  },

  // ===== Ideogram ===========================================================
  {
    id: 'ideogram-v3-quality',
    label: 'Ideogram V3 Quality',
    brand: 'Ideogram',
    replicateSlug: 'ideogram-ai/ideogram-v3-quality',
    pitch: 'Top Ideogram tier — best V3 prompt comprehension and text rendering.',
    tags: ['flagship', 'typography', 'design'],
    pricePerImage: 0.09,
    aspectRatios: IDEOGRAM_V3_AR,
    defaultAspectRatio: '1:1',
    advanced: [IDEOGRAM_V3_STYLE, IDEOGRAM_MAGIC_PROMPT],
  },
  {
    id: 'ideogram-v3-balanced',
    label: 'Ideogram V3 Balanced',
    brand: 'Ideogram',
    replicateSlug: 'ideogram-ai/ideogram-v3-balanced',
    pitch: 'Mid-tier V3 — quality and cost in balance for design work.',
    tags: ['design', 'typography'],
    pricePerImage: 0.06,
    aspectRatios: IDEOGRAM_V3_AR,
    defaultAspectRatio: '1:1',
    advanced: [IDEOGRAM_V3_STYLE, IDEOGRAM_MAGIC_PROMPT],
  },
  {
    id: 'ideogram-v3-turbo',
    label: 'Ideogram V3 Turbo',
    brand: 'Ideogram',
    replicateSlug: 'ideogram-ai/ideogram-v3-turbo',
    pitch: 'Fast V3 — keeps the typography wins for cheap iteration.',
    tags: ['fast', 'typography'],
    pricePerImage: 0.03,
    aspectRatios: IDEOGRAM_V3_AR,
    defaultAspectRatio: '1:1',
    advanced: [IDEOGRAM_V3_STYLE, IDEOGRAM_MAGIC_PROMPT],
  },
  {
    id: 'ideogram-v2',
    hidden: true,
    label: 'Ideogram V2',
    brand: 'Ideogram',
    replicateSlug: 'ideogram-ai/ideogram-v2',
    pitch: 'Original Ideogram — state-of-the-art text rendering and inpainting.',
    tags: ['typography', 'design'],
    pricePerImage: 0.08,
    aspectRatios: IDEOGRAM_V2_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'style_type', type: 'select', label: 'Style',
        default: 'Auto', options: ['Auto', 'General', 'Realistic', 'Design', 'Render 3D', 'Anime'] },
      IDEOGRAM_MAGIC_PROMPT,
    ],
  },
  {
    id: 'ideogram-v2a-turbo',
    hidden: true,
    label: 'Ideogram V2A Turbo',
    brand: 'Ideogram',
    replicateSlug: 'ideogram-ai/ideogram-v2a-turbo',
    pitch: 'Faster V2A — Ideogram\'s typography at 40 images per dollar.',
    tags: ['fast', 'cheap', 'typography'],
    pricePerImage: 0.025,
    aspectRatios: IDEOGRAM_V2_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'style_type', type: 'select', label: 'Style',
        default: 'Auto', options: ['Auto', 'General', 'Realistic', 'Design', 'Render 3D', 'Anime'] },
      IDEOGRAM_MAGIC_PROMPT,
    ],
  },

  // ===== ByteDance ==========================================================
  {
    id: 'seedream-4.5',
    label: 'Seedream 4.5',
    brand: 'ByteDance',
    replicateSlug: 'bytedance/seedream-4.5',
    pitch: 'Film-grade lighting and cinematic composition with strong spatial reasoning.',
    tags: ['cinematic', 'photoreal'],
    pricePerImage: 0.04,
    aspectRatios: SEEDREAM_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      // Live Replicate schema (verified via a 422, 2026-08-06): 2K | 4K | custom — no 1K.
      { name: 'size', type: 'select', label: 'Size preset', default: '2K', options: ['2K', '4K'] },
    ],
  },
  {
    id: 'seedream-5-pro',
    label: 'Seedream 5 Pro',
    brand: 'ByteDance',
    replicateSlug: 'bytedance/seedream-5-pro',
    pitch: 'ByteDance flagship — sharp 1K/2K, design-aware reasoning, reference editing.',
    tags: ['cinematic', 'photoreal', 'multi-image'],
    pricePerImage: null, // varies by size: $0.045 (1K) / $0.09 (2K)
    aspectRatios: SEEDREAM_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'size', type: 'select', label: 'Size preset', default: '2K', options: ['1K', '2K'] },
    ],
  },
  {
    id: 'seedream-5-lite',
    label: 'Seedream 5 Lite',
    brand: 'ByteDance',
    replicateSlug: 'bytedance/seedream-5-lite',
    pitch: 'Reasoning-driven generation with example-based editing. Batches related images.',
    tags: ['cinematic', 'multi-image'],
    pricePerImage: 0.035,
    aspectRatios: SEEDREAM_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'size', type: 'select', label: 'Size preset', default: '2K', options: ['2K', '3K'] },
      { name: 'sequential_image_generation', type: 'select', label: 'Batch mode',
        default: 'disabled', options: ['disabled', 'auto'],
        description: '"auto" lets the model produce a set of related images.' },
      { name: 'max_images', type: 'integer', label: 'Max images', default: 1, min: 1, max: 15,
        description: 'Only used when Batch mode is "auto".' },
    ],
  },
  {
    id: 'seedream-4',
    hidden: true,
    label: 'Seedream 4',
    brand: 'ByteDance',
    replicateSlug: 'bytedance/seedream-4',
    pitch: 'Unified text-to-image and single-sentence edit model.',
    tags: ['multi-image'],
    pricePerImage: 0.03,
    aspectRatios: SEEDREAM_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'size', type: 'select', label: 'Size preset', default: '2K', options: ['1K', '2K'] },
      { name: 'enhance_prompt', type: 'boolean', label: 'Enhance prompt', default: false },
    ],
  },
  {
    id: 'seedream-3',
    hidden: true,
    label: 'Seedream 3',
    brand: 'ByteDance',
    replicateSlug: 'bytedance/seedream-3',
    pitch: 'First native-2K Seedream — high-resolution outputs at low cost.',
    tags: ['cheap'],
    pricePerImage: 0.03,
    aspectRatios: SEEDREAM_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'guidance_scale', type: 'float', label: 'Guidance scale', default: 2.5, min: 1, max: 10, step: 0.1 },
    ],
  },

  // ===== Recraft ============================================================
  {
    id: 'recraft-v4-pro',
    label: 'Recraft V4 Pro',
    brand: 'Recraft',
    replicateSlug: 'recraft-ai/recraft-v4-pro',
    pitch: 'Print-ready Recraft V4 at 2048-3072px on the long side.',
    tags: ['flagship', 'design'],
    pricePerImage: 0.25,
    aspectRatios: RECRAFT_AR,
    defaultAspectRatio: '1:1',
    advanced: [],
  },
  {
    id: 'recraft-v4-pro-svg',
    label: 'Recraft V4 Pro SVG',
    brand: 'Recraft',
    replicateSlug: 'recraft-ai/recraft-v4-pro-svg',
    pitch: 'Print-ready editable SVG vectors from Recraft V4 Pro.',
    tags: ['svg', 'design', 'flagship'],
    pricePerImage: 0.30,
    aspectRatios: RECRAFT_AR,
    defaultAspectRatio: '1:1',
    advanced: [],
  },
  {
    id: 'recraft-v4',
    label: 'Recraft V4',
    brand: 'Recraft',
    replicateSlug: 'recraft-ai/recraft-v4',
    pitch: 'Design-first raster — art-directed composition that doesn\'t look generative.',
    tags: ['design', 'typography'],
    pricePerImage: 0.04,
    aspectRatios: RECRAFT_AR,
    defaultAspectRatio: '1:1',
    advanced: [],
  },
  {
    id: 'recraft-v4-svg',
    label: 'Recraft V4 SVG',
    brand: 'Recraft',
    replicateSlug: 'recraft-ai/recraft-v4-svg',
    pitch: 'Editable SVG vectors — not traced rasters.',
    tags: ['svg', 'design'],
    pricePerImage: 0.08,
    aspectRatios: RECRAFT_AR,
    defaultAspectRatio: '1:1',
    advanced: [],
  },
  {
    id: 'recraft-v3',
    hidden: true,
    label: 'Recraft V3',
    brand: 'Recraft',
    replicateSlug: 'recraft-ai/recraft-v3',
    pitch: 'Previous flagship with the richest curated style enum for design work.',
    tags: ['design', 'typography'],
    pricePerImage: 0.04,
    aspectRatios: RECRAFT_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'style', type: 'select', label: 'Style preset', default: 'any',
        options: ['any', 'realistic_image', 'digital_illustration',
                  'realistic_image/b_and_w', 'realistic_image/hard_flash', 'realistic_image/hdr',
                  'realistic_image/natural_light', 'realistic_image/studio_portrait',
                  'realistic_image/enterprise', 'realistic_image/motion_blur',
                  'digital_illustration/pixel_art', 'digital_illustration/hand_drawn',
                  'digital_illustration/grain', 'digital_illustration/infantile_sketch',
                  'digital_illustration/2d_art_poster', 'digital_illustration/handmade_3d',
                  'digital_illustration/hand_drawn_outline', 'digital_illustration/engraving_color',
                  'digital_illustration/2d_art_poster_2'] },
    ],
  },
  {
    id: 'recraft-v3-svg',
    hidden: true,
    label: 'Recraft V3 SVG',
    brand: 'Recraft',
    replicateSlug: 'recraft-ai/recraft-v3-svg',
    pitch: 'V3 in native SVG — logos, icons, illustrations as real vectors.',
    tags: ['svg', 'design'],
    pricePerImage: 0.08,
    aspectRatios: RECRAFT_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'style', type: 'select', label: 'Style preset', default: 'any',
        options: ['any', 'engraving', 'line_art', 'line_circuit', 'linocut'] },
    ],
  },

  // ===== Stability AI =======================================================
  {
    id: 'stable-diffusion-3.5-large',
    hidden: true,
    label: 'Stable Diffusion 3.5 Large',
    brand: 'Stability AI',
    replicateSlug: 'stability-ai/stable-diffusion-3.5-large',
    pitch: 'Stability\'s latest open-weights flagship — high-fidelity outputs.',
    tags: ['open-source', 'flagship'],
    pricePerImage: 0.065,
    aspectRatios: SD35_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'cfg', type: 'float', label: 'CFG', default: 5, min: 1, max: 10, step: 0.1 },
      { name: 'negative_prompt', type: 'string', label: 'Negative prompt', default: '' },
      { ...OUTPUT_FORMAT_WPJ, default: 'webp' },
    ],
  },
  {
    id: 'stable-diffusion-3.5-large-turbo',
    hidden: true,
    label: 'Stable Diffusion 3.5 Large Turbo',
    brand: 'Stability AI',
    replicateSlug: 'stability-ai/stable-diffusion-3.5-large-turbo',
    pitch: 'Distilled SD 3.5 Large — 25 images per dollar.',
    tags: ['open-source', 'fast'],
    pricePerImage: 0.04,
    aspectRatios: SD35_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'cfg', type: 'float', label: 'CFG', default: 1, min: 1, max: 10, step: 0.1,
        description: 'Turbo runs with low CFG.' },
      { name: 'negative_prompt', type: 'string', label: 'Negative prompt', default: '' },
      { ...OUTPUT_FORMAT_WPJ, default: 'webp' },
    ],
  },
  {
    id: 'stable-diffusion-3.5-medium',
    hidden: true,
    label: 'Stable Diffusion 3.5 Medium',
    brand: 'Stability AI',
    replicateSlug: 'stability-ai/stable-diffusion-3.5-medium',
    pitch: '2.5B-parameter SD 3.5 — open-weights MMDiT-X architecture.',
    tags: ['open-source', 'cheap'],
    pricePerImage: 0.035,
    aspectRatios: SD35_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'cfg', type: 'float', label: 'CFG', default: 5, min: 1, max: 10, step: 0.1 },
      { name: 'negative_prompt', type: 'string', label: 'Negative prompt', default: '' },
      { ...OUTPUT_FORMAT_WPJ, default: 'webp' },
    ],
  },

  // ===== OpenAI =============================================================
  {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    brand: 'OpenAI',
    replicateSlug: 'openai/gpt-image-2',
    pitch: 'OpenAI\'s newest — best-in-class sharp text and complex instructions.',
    tags: ['flagship', 'typography'],
    pricePerImage: 0.128,
    aspectRatios: OPENAI_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'quality', type: 'select', label: 'Quality', default: 'auto',
        options: ['low', 'medium', 'high', 'auto'],
        description: 'low ≈ $0.012, medium ≈ $0.047, high ≈ $0.128.' },
      { name: 'background', type: 'select', label: 'Background', default: 'auto',
        options: ['auto', 'transparent', 'opaque'] },
      { name: 'output_format', type: 'select', label: 'Output format', default: 'webp',
        options: ['png', 'jpeg', 'webp'] },
    ],
  },
  {
    id: 'gpt-image-1.5',
    hidden: true,
    label: 'GPT Image 1.5',
    brand: 'OpenAI',
    replicateSlug: 'openai/gpt-image-1.5',
    pitch: 'Strong instruction following for complex multi-step prompts.',
    tags: ['typography'],
    pricePerImage: 0.136,
    aspectRatios: OPENAI_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'quality', type: 'select', label: 'Quality', default: 'auto',
        options: ['low', 'medium', 'high', 'auto'] },
      { name: 'background', type: 'select', label: 'Background', default: 'auto',
        options: ['auto', 'transparent', 'opaque'] },
      { name: 'input_fidelity', type: 'select', label: 'Input fidelity', default: 'low',
        options: ['low', 'high'] },
      { name: 'output_format', type: 'select', label: 'Output format', default: 'webp',
        options: ['png', 'jpeg', 'webp'] },
    ],
  },

  // ===== Alibaba ============================================================
  {
    id: 'qwen-image',
    label: 'Qwen Image',
    brand: 'Alibaba',
    replicateSlug: 'qwen/qwen-image',
    pitch: 'Strong complex-text rendering with built-in LoRA loading.',
    tags: ['typography', 'open-source'],
    pricePerImage: 0.025,
    aspectRatios: QWEN_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'guidance', type: 'float', label: 'Guidance', default: 3, min: 0, max: 10, step: 0.1 },
      { name: 'num_inference_steps', type: 'integer', label: 'Inference steps', default: 30, min: 1, max: 50 },
      { name: 'enhance_prompt', type: 'boolean', label: 'Enhance prompt', default: false },
      { name: 'negative_prompt', type: 'string', label: 'Negative prompt', default: '' },
      { name: 'output_format', type: 'select', label: 'Output format', default: 'webp',
        options: ['webp', 'jpg', 'png'] },
    ],
  },

  // ===== Tencent ============================================================
  {
    id: 'hunyuan-image-3',
    hidden: true,
    label: 'Hunyuan Image 3',
    brand: 'Tencent',
    replicateSlug: 'tencent/hunyuan-image-3',
    pitch: 'Tencent\'s native multimodal image model — strong on Chinese-language prompts.',
    tags: ['open-source'],
    pricePerImage: 0.08,
    aspectRatios: HUNYUAN_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'go_fast', type: 'boolean', label: 'Go fast', default: true },
      { name: 'output_format', type: 'select', label: 'Output format', default: 'webp',
        options: ['webp', 'jpg', 'png'] },
    ],
  },

  // ===== xAI ================================================================
  {
    id: 'grok-imagine',
    label: 'Grok Imagine',
    brand: 'xAI',
    replicateSlug: 'xai/grok-imagine-image',
    pitch: 'Distinctive moody, cinematic aesthetic with phone-screen aspect ratios.',
    tags: ['cinematic'],
    pricePerImage: 0.02,
    aspectRatios: GROK_AR,
    defaultAspectRatio: '1:1',
    advanced: [],
  },

  // ===== Pruna ==============================================================
  {
    id: 'flux-fast',
    label: 'Flux Fast (Pruna)',
    brand: 'Pruna',
    replicateSlug: 'prunaai/flux-fast',
    pitch: 'Pruna\'s heavily-optimized Flux endpoint — 200 images per dollar.',
    tags: ['fast', 'cheap'],
    pricePerImage: 0.005,
    aspectRatios: FLUX_FAST_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'guidance', type: 'float', label: 'Guidance', default: 3.5, min: 0, max: 10, step: 0.1 },
      { name: 'num_inference_steps', type: 'integer', label: 'Inference steps', default: 28, min: 1, max: 50 },
      { name: 'speed_mode', type: 'select', label: 'Speed mode', default: 'Extra Juiced',
        options: ['Lightly Juiced', 'Juiced', 'Extra Juiced', 'Blink of an eye'] },
      { ...OUTPUT_FORMAT_WPJ, default: 'jpg' },
    ],
  },
  {
    id: 'p-image',
    label: 'P-Image',
    brand: 'Pruna',
    replicateSlug: 'prunaai/p-image',
    pitch: 'Sub-1-second production model with LoRA loading.',
    tags: ['fast', 'cheap'],
    pricePerImage: 0.005,
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'prompt_upsampling', type: 'boolean', label: 'Let model rewrite prompt', default: false },
    ],
  },
  {
    id: 'wan-2.2-image-pruna',
    hidden: true,
    label: 'Wan 2.2 Image (Pruna)',
    brand: 'Pruna',
    replicateSlug: 'prunaai/wan-2.2-image',
    pitch: 'Cinematic 2 MP images in 3-4 seconds via Pruna optimization.',
    tags: ['cinematic', 'fast'],
    pricePerImage: 0.02,
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'],
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'megapixels', type: 'select', label: 'Megapixels', default: '2', options: ['1', '2'] },
      { name: 'juiced', type: 'boolean', label: 'Juiced (faster)', default: false },
      { ...OUTPUT_FORMAT_WPJ, default: 'jpg' },
    ],
  },

  // ===== Bria ===============================================================
  {
    id: 'bria-fibo',
    label: 'Bria Fibo',
    brand: 'Bria',
    replicateSlug: 'bria/fibo',
    pitch: 'Open-source flagship trained 100% on licensed data — commercial-safe.',
    tags: ['open-source', 'photoreal'],
    pricePerImage: 0.04,
    aspectRatios: BRIA_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'negative_prompt', type: 'string', label: 'Negative prompt', default: '' },
      { name: 'guidance_scale', type: 'integer', label: 'Guidance scale', default: 4, min: 3, max: 5 },
    ],
  },
  {
    id: 'bria-image-3.2',
    label: 'Bria Image 3.2',
    brand: 'Bria',
    replicateSlug: 'bria/image-3.2',
    pitch: '4B commercial-ready model — copyright-safe for client deliverables.',
    tags: ['photoreal'],
    pricePerImage: 0.04,
    aspectRatios: BRIA_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'negative_prompt', type: 'string', label: 'Negative prompt', default: '' },
      { name: 'guidance_scale', type: 'float', label: 'Guidance scale', default: 4, min: 3, max: 5, step: 0.1 },
      { name: 'prompt_enhancement', type: 'boolean', label: 'Prompt enhancement', default: false },
      { name: 'enhance_image', type: 'boolean', label: 'Enhance image details', default: false },
    ],
  },

  // ===== Luma ===============================================================
  {
    id: 'photon',
    hidden: true,
    label: 'Photon',
    brand: 'Luma',
    replicateSlug: 'luma/photon',
    pitch: 'Strong character and style consistency via reference images.',
    tags: ['cinematic'],
    pricePerImage: 0.03,
    aspectRatios: PHOTON_AR,
    defaultAspectRatio: '1:1',
    advanced: [],
  },
  {
    id: 'photon-flash',
    hidden: true,
    label: 'Photon Flash',
    brand: 'Luma',
    replicateSlug: 'luma/photon-flash',
    pitch: 'Photon\'s speed tier — 100 images per dollar with the same reference API.',
    tags: ['fast', 'cheap'],
    pricePerImage: 0.01,
    aspectRatios: PHOTON_AR,
    defaultAspectRatio: '1:1',
    advanced: [],
  },

  // ===== MiniMax ============================================================
  {
    id: 'minimax-image-01',
    hidden: true,
    label: 'MiniMax Image 01',
    brand: 'MiniMax',
    replicateSlug: 'minimax/image-01',
    pitch: 'Cheap MiniMax debut with built-in face-reference support.',
    tags: ['cheap'],
    pricePerImage: 0.01,
    aspectRatios: MINIMAX_AR,
    defaultAspectRatio: '1:1',
    advanced: [
      { name: 'prompt_optimizer', type: 'boolean', label: 'Prompt optimizer', default: true },
    ],
  },

  // ===== Reve ===============================================================
  {
    id: 'reve-create',
    label: 'Reve Create',
    brand: 'Reve',
    replicateSlug: 'reve/create',
    pitch: 'Reve\'s lean text-to-image — prompt + ratio, no knobs to fiddle with.',
    description:
      'Reve\'s straightforward text-to-image endpoint. The schema is intentionally '
      + 'minimal — just prompt, aspect ratio, and an optional pinned version.',
    tags: [],
    pricePerImage: null,
    aspectRatios: REVE_AR,
    defaultAspectRatio: '3:2',
    advanced: [
      {
        name: 'version', type: 'select', label: 'Model version',
        default: 'latest', options: ['latest', 'reve-create@20250915'],
        description: 'Pin to a specific weights revision for reproducibility.',
      },
    ],
  },
]

/**
 * The default for a new "Generate an image" node: the first of these that can
 * run now (not hidden or discontinued; a runner-only one only while its family
 * is on). Served as the model input's `default` (shared/runner/modelMenus.ts).
 */
export const IMAGE_MODEL_PREFERENCE: readonly string[] = ['nano-banana-2', 'flux-2-pro']

export const IMAGE_MODELS_BY_ID: Record<string, ImageModel> = Object.fromEntries(
  IMAGE_MODELS.map(m => [m.id, m]),
)

/** Set of every aspect ratio across all models — used by the shared aspect
 *  ratio combo on the node so any model's preferred ratio is available. The
 *  backend remaps incompatible ratios to a sensible per-model fallback. */
export const ALL_ASPECT_RATIOS: string[] = Array.from(
  new Set(IMAGE_MODELS.flatMap(m => m.aspectRatios)),
).sort((a, b) => {
  // 1:1 always first, then by descending first number.
  if (a === '1:1') return -1
  if (b === '1:1') return 1
  return a.localeCompare(b, undefined, { numeric: true })
})

/** Tags that have at least one model — drives the filter chip row in the
 *  gallery so we don't show empty filter buckets. */
export function activeTagsInCatalog(): ImageModelTag[] {
  const seen = new Set<ImageModelTag>()
  for (const m of IMAGE_MODELS) for (const t of m.tags) seen.add(t)
  return (Object.keys(TAG_LABELS) as ImageModelTag[]).filter(t => seen.has(t))
}
