/**
 * Video-generation model catalog — drives the "Generate a video" node's
 * gallery UI. Mirrors comfy_api_nodes/video_models.py (executes the actual
 * Replicate calls). Keep `id` identical between the two — it's the dispatch
 * key.
 *
 * Scope (v1): 15 curated flagships from Replicate's text-to-video collection.
 * Models supporting both T2V and I2V are tagged with `modes: ['t2v', 'i2v']`;
 * the node's optional image input is honored when present and the picked
 * model supports I2V.
 *
 * `supportsSeed` mirrors the Python builders — see _maybe_set_seed call sites.
 *
 * Skipped on purpose: AnimateDiff/CogVideoX-era models (older lineage),
 * SAM/DeOldify/super-res (not text-to-video), VEED Fabric / DreamActor
 * (specialty avatars — better as separate "talking head" node later).
 */

import type { ModelFlags } from '../../shared/runner/families'

export type VideoModelMode = 't2v' | 'i2v'

export type VideoModelTag =
  | 'flagship'      // best-in-class generalist
  | 'fast'          // speed-optimized variant
  | 'cheap'         // budget option in its family
  | 'open-source'   // open weights
  | 'audio'         // generates synced audio
  | 'reference'     // accepts reference images for character consistency
  | 'cinematic'     // film-grade aesthetic
  | 'long'          // supports clips ≥10s
  | '4k'            // native 1080p+
  | 'multi-shot'    // multiple connected shots in one prediction
  | 'lip-sync'      // takes an audio file and lip-syncs a face image to it

export const VIDEO_TAG_LABELS: Record<VideoModelTag, string> = {
  'flagship':    'Flagship',
  'fast':        'Fast',
  'cheap':       'Cheap',
  'open-source': 'Open-source',
  'audio':       'Audio out',
  'reference':   'Reference image',
  'cinematic':   'Cinematic',
  'long':        '10s+',
  '4k':          '1080p+',
  'multi-shot':  'Multi-shot',
  'lip-sync':    'Lip-sync',
}

export type VideoModelBrand =
  | 'Google' | 'OpenAI' | 'Runway' | 'Kling' | 'ByteDance'
  | 'MiniMax' | 'Wan' | 'Alibaba' | 'xAI' | 'Luma' | 'Lightricks' | 'PixVerse' | 'VEED' | 'BFL' | 'Other'

export interface VideoModelAdvancedField {
  name: string
  type: 'integer' | 'float' | 'boolean' | 'select' | 'string'
  label: string
  default: any
  description?: string
  options?: string[]
  min?: number
  max?: number
  step?: number
  /**
   * Not shown: the runner no longer sends it, because the model's published
   * schema has no such input (Task S1b). Kept so a saved node's value still
   * loads (and the ComfyUI path still reads it).
   */
  hidden?: boolean
}

export interface VideoModel extends ModelFlags {
  id: string                       // dispatch key — matches Python side
  label: string                    // 'Veo 3.1'
  brand: VideoModelBrand
  replicateSlug: string            // 'google/veo-3.1'
  pitch: string                    // one-line "best for" hook
  description?: string             // longer body for the detail pane
  tags: VideoModelTag[]
  modes: VideoModelMode[]          // ['t2v'] | ['i2v'] | ['t2v', 'i2v']
  // Whether the model's published schema accepts a seed (the saved copies in
  // tests/unit/fixtures/provider-schemas/, Task S1b; before that it mirrored
  // Python's _maybe_set_seed calls). false ⇒ the node hides its seed widget.
  supportsSeed: boolean
  // Old free-form price note. Not money: no price, badge or label reads it.
  // Prices come from the rate card, shared/pricing/videoRates.ts.
  priceHint: string | null         // e.g. '$0.40 / 5s' or '~$0.10–0.60'
  aspectRatios: string[]
  defaultAspectRatio: string
  durations: number[]              // seconds, e.g. [5, 10]
  defaultDuration: number
  resolutions?: string[]           // optional, e.g. ['720p', '1080p']
  defaultResolution?: string
  advanced: VideoModelAdvancedField[]
}

// ---- Shared field presets --------------------------------------------------

const NEG_PROMPT: VideoModelAdvancedField = {
  name: 'negative_prompt', type: 'string', label: 'Negative prompt',
  default: '', description: 'Concepts to avoid.',
}

const CFG_SCALE: VideoModelAdvancedField = {
  name: 'cfg_scale', type: 'float', label: 'Prompt adherence',
  default: 0.5, min: 0.0, max: 1.0, step: 0.05,
  description: 'Lower = looser & more natural, higher = stricter.',
}

const CAMERA_FIXED: VideoModelAdvancedField = {
  name: 'camera_fixed', type: 'boolean', label: 'Lock camera',
  default: false,
  description: 'Prevent the model from inventing camera moves.',
}

const AUDIO_GENERATION: VideoModelAdvancedField = {
  name: 'generate_audio', type: 'boolean', label: 'Generate audio',
  default: true,
  description: 'Off = silent video, often faster / cheaper.',
}

/** Wan 3.0's two settings (its schema's `audio` and `enable_prompt_expansion`; wan3.ts). */
const WAN_3_ADVANCED: VideoModelAdvancedField[] = [
  { name: 'generate_audio', type: 'boolean', label: 'Generate audio', default: true,
    description: 'Off makes a silent clip. The price is the same.' },
  { name: 'enhance_prompt', type: 'boolean', label: 'Enhance prompt', default: true,
    description: 'Lets Wan rewrite the prompt. Off is faster but usually looks worse.' },
]

// Common aspect-ratio sets.
const WIDE_AR     = ['16:9', '9:16', '1:1']
const STANDARD_AR = ['16:9', '9:16', '1:1', '4:3', '3:4']
const FULL_AR     = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']

// ---- Catalog ---------------------------------------------------------------

export const VIDEO_MODELS: VideoModel[] = [
  // ===== Google ===========================================================
  {
    id: 'veo-3.1',
    label: 'Veo 3.1',
    brand: 'Google',
    replicateSlug: 'google/veo-3.1',
    pitch: 'Google\'s flagship — strong physics, native synced audio.',
    description:
      'Veo 3.1 produces high-fidelity 8-second clips with native audio generation '
      + '(dialogue, ambient, foley). Excellent prompt adherence and scene coherence; '
      + 'expensive but consistent.',
    tags: ['flagship', 'audio', '4k', 'cinematic'],
    modes: ['t2v', 'i2v'],
    supportsSeed: true,
    priceHint: '~$3.20 / 8s · ~$1.60 silent',
    aspectRatios: ['16:9', '9:16'],
    defaultAspectRatio: '16:9',
    durations: [4, 6, 8],
    defaultDuration: 8,
    advanced: [
      AUDIO_GENERATION,
      NEG_PROMPT,
      { name: 'enhance_prompt', type: 'boolean', label: 'Enhance prompt',
        default: true, description: 'Google\'s server-side prompt rewriter.' },
    ],
  },
  {
    id: 'veo-3.1-fast',
    label: 'Veo 3.1 Fast',
    brand: 'Google',
    replicateSlug: 'google/veo-3.1-fast',
    pitch: 'Same Veo lineage at ~3× speed; quality slightly compressed.',
    tags: ['fast', 'audio'],
    modes: ['t2v', 'i2v'],
    supportsSeed: true,
    priceHint: '~$1.20 / 8s · ~$0.80 silent',
    aspectRatios: ['16:9', '9:16'],
    defaultAspectRatio: '16:9',
    durations: [4, 6, 8],
    defaultDuration: 8,
    advanced: [
      AUDIO_GENERATION,
      NEG_PROMPT,
    ],
  },
  // Veo 3.1 Lite runs only in Sailor's runner (family veo-3.1-lite), on fal
  // (server/runner/generators/veo31Lite.ts). Its schemas (fal-ai/veo3.1/lite
  // and /image-to-video, read 2026-09-24) are Veo 3.1's without 4k, so its
  // settings are Veo 3.1's, at 720p or 1080p.
  {
    id: 'veo-3.1-lite',
    runnerOnly: true,
    family: 'veo-3.1-lite',
    label: 'Veo 3.1 Lite',
    brand: 'Google',
    // The gallery's cover art only (Replicate's google/veo-3.1-lite is not a backup).
    replicateSlug: 'google/veo-3.1-lite',
    pitch: 'Veo at its lowest price, with sound, at 720p or 1080p.',
    description:
      'Veo 3.1 Lite makes 4, 6 or 8 second clips with sound, at 720p or 1080p, in ' +
      'landscape or portrait. Describe the clip, or link a picture to start from it. ' +
      'Turn sound off for a cheaper silent clip.',
    tags: ['cheap', 'audio'],
    modes: ['t2v', 'i2v'],
    supportsSeed: true,
    priceHint: null,
    aspectRatios: ['16:9', '9:16'],
    defaultAspectRatio: '16:9',
    durations: [4, 6, 8],
    defaultDuration: 8,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    advanced: [
      AUDIO_GENERATION,
      NEG_PROMPT,
      { name: 'enhance_prompt', type: 'boolean', label: 'Fix refused prompts',
        default: true, description: 'Lets Veo rewrite a prompt it would otherwise refuse.' },
    ],
  },
  // Gemini Omni Flash runs only in Sailor's runner (family gemini-omni-flash),
  // on fal (server/runner/generators/geminiOmniFlash.ts). Its schemas
  // (google/gemini-omni-flash and /image-to-video, read 2026-09-24) take a
  // prompt, 16:9 or 9:16, and 3–10 s; no resolution (720p), seed, negative
  // prompt or sound switch (sound is always on). Its video-editing endpoint
  // needs a video input on Generate a video: a later task.
  {
    id: 'gemini-omni-flash',
    runnerOnly: true,
    family: 'gemini-omni-flash',
    label: 'Gemini Omni Flash',
    brand: 'Google',
    // The gallery's cover art only (Replicate has no Gemini Omni Flash; google/gemini-omni-1.1 is the nearest page).
    replicateSlug: 'google/gemini-omni-1.1',
    pitch: 'Quick clips with sound from Google, from a prompt or a starting picture.',
    description:
      'Gemini Omni Flash makes 4 to 10 second clips with sound, at 720p, in landscape ' +
      'or portrait. Describe the clip, or link a picture to start from it. Say what ' +
      'to leave out in the prompt itself, for example "no dialogue".',
    tags: ['fast', 'audio'],
    modes: ['t2v', 'i2v'],
    supportsSeed: false,
    priceHint: null,
    aspectRatios: ['16:9', '9:16'],
    defaultAspectRatio: '16:9',
    durations: [4, 6, 8, 10],
    defaultDuration: 8,
    resolutions: ['720p'],
    defaultResolution: '720p',
    advanced: [],
  },

  // ===== OpenAI ===========================================================
  {
    id: 'sora-2',
    discontinued: '2026-09-24',
    label: 'Sora 2',
    brand: 'OpenAI',
    replicateSlug: 'openai/sora-2',
    pitch: 'OpenAI flagship — synced audio, exceptional shot composition.',
    description:
      'Sora 2 produces highly coherent narrative clips with synchronized audio. '
      + 'Strong on dynamic camera work and naturalistic motion. T2V only on Replicate.',
    tags: ['flagship', 'audio', 'cinematic'],
    modes: ['t2v'],
    supportsSeed: false,  // the model's schema has no seed (Task S1b)
    priceHint: '~$0.30 / 5s',
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultAspectRatio: '16:9',
    durations: [5, 10],
    defaultDuration: 5,
    advanced: [],
  },
  {
    id: 'sora-2-pro',
    discontinued: '2026-09-24',
    label: 'Sora 2 Pro',
    brand: 'OpenAI',
    replicateSlug: 'openai/sora-2-pro',
    pitch: 'Pro tier of Sora 2 — better motion, longer reach, premium price.',
    tags: ['flagship', 'audio', 'cinematic', '4k'],
    modes: ['t2v'],
    supportsSeed: false,  // the model's schema has no seed (Task S1b)
    priceHint: '~$0.90 / 5s',
    aspectRatios: ['16:9', '9:16'],
    defaultAspectRatio: '16:9',
    durations: [5, 10],
    defaultDuration: 5,
    advanced: [],
  },

  // ===== BFL ===============================================================
  {
    id: 'flux-3',
    label: 'FLUX 3',
    brand: 'BFL',
    replicateSlug: 'black-forest-labs/flux-3',
    pitch: 'BFL\'s multimodal model — up to 20s video with native synchronized audio.',
    tags: ['flagship', 'audio'],
    modes: ['t2v', 'i2v'],
    supportsSeed: false,  // the model's schema has no seed (Task S1b)
    priceHint: '~$0.20–0.40 / s',
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultAspectRatio: '16:9',
    durations: [5, 10, 15, 20],
    defaultDuration: 10,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    advanced: [
      { name: 'generate_audio', type: 'boolean', label: 'Generate audio', default: true,
        description: 'Native synchronized audio. Off is cheaper and silent.' },
    ],
  },

  // ===== Runway ===========================================================
  {
    id: 'runway-gen-4.5',
    label: 'Runway Gen-4.5',
    brand: 'Runway',
    replicateSlug: 'runwayml/gen-4.5',
    pitch: '#1 on the Artificial Analysis benchmark — best raw quality.',
    description:
      'Runway\'s newest, currently the top-ranked text-to-video on Artificial '
      + 'Analysis. Strong physical realism and fine detail coherence; no audio yet.',
    tags: ['flagship', 'cinematic', 'photoreal'],
    modes: ['t2v', 'i2v'],
    supportsSeed: true,
    priceHint: '~$0.80 / 5s',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    defaultAspectRatio: '16:9',
    durations: [5, 10],
    defaultDuration: 5,
    advanced: [
      { name: 'motion', type: 'integer', label: 'Motion intensity', hidden: true,
        default: 5, min: 1, max: 10,
        description: '1 = static, 10 = chaotic.' },
    ],
  },

  // ===== Kling (kwaivgi) ==================================================
  {
    id: 'kling-v3',
    label: 'Kling Video 3.0',
    brand: 'Kling',
    replicateSlug: 'kwaivgi/kling-v3-video',
    pitch: 'Up to 15s cinematic clips, native audio, multi-shot mode.',
    description:
      'Kling 3 supports the longest clip-lengths in the catalog (15s) and can '
      + 'string up to 6 connected shots in a single prediction. Native audio.',
    tags: ['flagship', 'audio', 'long', 'multi-shot', 'cinematic'],
    modes: ['t2v', 'i2v'],
    supportsSeed: false,  // the model's schema has no seed (Task S1b)
    priceHint: '~$0.60 / 10s',
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultAspectRatio: '16:9',
    durations: [5, 10, 15],
    defaultDuration: 5,
    advanced: [
      AUDIO_GENERATION,
      NEG_PROMPT,
      { ...CFG_SCALE, hidden: true },
    ],
  },
  {
    id: 'kling-v2.5-turbo-pro',
    hidden: true,
    label: 'Kling v2.5 Turbo Pro',
    brand: 'Kling',
    replicateSlug: 'kwaivgi/kling-v2.5-turbo-pro',
    pitch: 'Pro-tier Kling tuned for cinematic depth and reliability.',
    tags: ['cinematic', '4k', 'reference'],
    modes: ['t2v', 'i2v'],
    supportsSeed: false,  // Replicate 422s on seed (2026-06-10)
    priceHint: '~$0.50 / 5s',
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultAspectRatio: '16:9',
    durations: [5, 10],
    defaultDuration: 5,
    // kwaivgi/kling-v2.5-turbo-pro's guidance_scale is deprecated ("This
    // parameter is not used"), so Prompt adherence has nothing to map to.
    advanced: [
      NEG_PROMPT,
      { ...CFG_SCALE, hidden: true },
    ],
  },

  // ===== ByteDance (Seedance) =============================================
  {
    id: 'seedance-2.0',
    label: 'Seedance 2.0',
    brand: 'ByteDance',
    replicateSlug: 'bytedance/seedance-2.0',
    pitch: 'Multimodal flagship — reference images, audio, character consistency.',
    description:
      'Seedance 2.0 accepts up to 9 reference images, 3 videos, and 3 audio '
      + 'tracks for consistency / continuation / motion transfer. Strong general '
      + 'quality; deepest control surface in the catalog.',
    tags: ['flagship', 'reference', 'audio', '4k'],
    modes: ['t2v', 'i2v'],
    supportsSeed: false,
    priceHint: '~$0.60 / 5s',
    aspectRatios: FULL_AR,
    defaultAspectRatio: '16:9',
    durations: [5, 10, 15],
    defaultDuration: 5,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    // Live schema has no camera_fixed / fps (verified 2026-06-30).
    advanced: [],
  },
  {
    id: 'seedance-2.0-fast',
    label: 'Seedance 2.0 Fast',
    brand: 'ByteDance',
    replicateSlug: 'bytedance/seedance-2.0-fast',
    pitch: 'Speed-optimized Seedance 2.0 with native audio.',
    tags: ['fast', 'audio'],
    modes: ['t2v', 'i2v'],
    supportsSeed: true,
    priceHint: '~$0.30 / 5s',
    aspectRatios: STANDARD_AR,
    defaultAspectRatio: '16:9',
    durations: [3, 5, 10],
    defaultDuration: 5,
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    advanced: [
      { ...CAMERA_FIXED, hidden: true },
    ],
  },

  // ===== MiniMax (Hailuo) =================================================
  {
    id: 'hailuo-2.3',
    hidden: true,
    label: 'Hailuo 2.3',
    brand: 'MiniMax',
    replicateSlug: 'minimax/hailuo-2.3',
    pitch: 'Reliable mid-tier — good motion, predictable cost.',
    tags: ['cinematic'],
    modes: ['t2v', 'i2v'],
    supportsSeed: false,  // the model's schema has no seed (Task S1b)
    priceHint: '~$0.35 / 6s',
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultAspectRatio: '16:9',
    durations: [6, 10],
    defaultDuration: 6,
    resolutions: ['768p', '1080p'],
    defaultResolution: '768p',
    advanced: [
      { name: 'prompt_optimizer', type: 'boolean', label: 'Prompt optimizer',
        default: true, description: 'MiniMax\'s server-side prompt rewriter.' },
    ],
  },
  {
    id: 'hailuo-h3',
    label: 'Hailuo H3',
    brand: 'MiniMax',
    replicateSlug: 'minimax/h3',
    pitch: 'MiniMax\'s frontier model — top-ranked open-weights video, native audio.',
    description:
      'Hailuo H3 generates video with native stereo audio, ranking among the ' +
      'top text-to-video and image-to-video models on the Artificial Analysis ' +
      'arena. Rendered at 768p; audio is always on.',
    tags: ['cinematic', 'flagship'],
    modes: ['t2v', 'i2v'],
    supportsSeed: true,
    priceHint: '~$0.30 / 5s',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    defaultAspectRatio: '16:9',
    durations: [5, 6, 10],
    defaultDuration: 5,
    resolutions: ['768p'],
    defaultResolution: '768p',
    advanced: [],
  },
  {
    id: 'hailuo-h3-max',
    label: 'Hailuo H3 Max',
    brand: 'MiniMax',
    replicateSlug: 'minimax/h3-max',
    pitch: 'fal\'s post-trained H3 — #1 image-to-video, faster renders.',
    description:
      'H3 Max is fal\'s post-trained variant of Hailuo H3, tuned for prompt ' +
      'adherence and aesthetics and ranked #1 for image-to-video with audio. ' +
      'Rendered at 768p; audio is always on.',
    tags: ['cinematic', 'flagship'],
    modes: ['t2v', 'i2v'],
    supportsSeed: true,
    priceHint: '~$0.40 / 5s',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    defaultAspectRatio: '16:9',
    durations: [5, 6, 10],
    defaultDuration: 5,
    resolutions: ['768p'],
    defaultResolution: '768p',
    advanced: [],
  },
  // Hailuo H3 Max Turbo runs only in Sailor's runner (family h3-max-turbo), on
  // fal (server/runner/generators/h3MaxTurbo.ts). Its schemas
  // (minimax/h3-max-turbo/*, read 2026-09-24) match H3 Max's field for field,
  // so its settings are H3 Max's.
  {
    id: 'hailuo-h3-max-turbo',
    runnerOnly: true,
    family: 'h3-max-turbo',
    label: 'Hailuo H3 Max Turbo',
    brand: 'MiniMax',
    // The gallery's cover art only (Replicate has no H3 Max Turbo, nor H3 Max; minimax/h3 has a page).
    replicateSlug: 'minimax/h3',
    pitch: 'A faster H3 Max at half the price, with sound.',
    description:
      'Hailuo H3 Max Turbo is fal\'s faster build of H3 Max: the same kind of clip, ' +
      'with sound, for half the price. Describe the clip, or link a picture to start ' +
      'from it. Rendered at 768p; sound is always on.',
    tags: ['fast', 'audio'],
    modes: ['t2v', 'i2v'],
    supportsSeed: true,
    priceHint: null,
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    defaultAspectRatio: '16:9',
    durations: [5, 6, 10],
    defaultDuration: 5,
    resolutions: ['768p'],
    defaultResolution: '768p',
    advanced: [],
  },

  // ===== Wan (open-source) ================================================
  // Wan 3.0 runs only in Sailor's runner (family wan-3), on fal
  // (server/runner/generators/wan3.ts). Settings from its saved schemas
  // (alibaba/wan-3.0/*, read 2026-09-24): 2–30 s, 480p/720p/1080p, sound on.
  // The duration list is a pick of the schema's whole seconds.
  {
    id: 'wan-3.0',
    runnerOnly: true,
    family: 'wan-3',
    label: 'Wan 3.0',
    brand: 'Wan',
    // The gallery's cover art only: the runner sends it to fal (Replicate's alibaba/wan-3 is no backup, wan3.ts).
    replicateSlug: 'alibaba/wan-3',
    // The runner also takes a last frame and reference pictures (wan3.ts), but
    // no control sets them yet, so the text doesn't offer them (F1 fix round 1).
    pitch: 'Up to 30 s with native sound, from a prompt or a starting picture.',
    description:
      'Wan 3.0 makes clips of up to 30 seconds with sound, at 480p, 720p or 1080p. '
      + 'Describe the clip, or link a picture to start from it.',
    tags: ['flagship', 'audio', 'long', '4k'],
    modes: ['t2v', 'i2v'],
    supportsSeed: true,
    priceHint: null,
    aspectRatios: STANDARD_AR,
    defaultAspectRatio: '16:9',
    durations: [3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30],
    defaultDuration: 5,
    resolutions: ['480p', '720p', '1080p'],
    defaultResolution: '720p',
    advanced: WAN_3_ADVANCED,
  },
  {
    id: 'wan-3.0-prime',
    runnerOnly: true,
    family: 'wan-3',
    label: 'Wan 3.0 Prime',
    brand: 'Wan',
    replicateSlug: 'alibaba/wan-3',
    pitch: 'The faster Wan 3.0 tier for animating a picture, with sound.',
    description:
      'Wan 3.0 Prime turns a linked picture into a clip of up to 30 seconds with '
      + 'sound, faster than Wan 3.0. It needs a picture linked to start from.',
    tags: ['fast', 'audio', 'long', '4k'],
    modes: ['i2v'],
    supportsSeed: true,
    priceHint: null,
    aspectRatios: STANDARD_AR,
    defaultAspectRatio: '16:9',
    durations: [3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30],
    defaultDuration: 5,
    resolutions: ['480p', '720p', '1080p'],
    defaultResolution: '720p',
    advanced: WAN_3_ADVANCED,
  },
  {
    id: 'wan-2.7-t2v',
    hidden: true,
    label: 'Wan 2.7 T2V',
    brand: 'Wan',
    replicateSlug: 'wan-video/wan-2.7-t2v',
    pitch: 'Open-source flagship — 27B MoE, the best open T2V right now.',
    tags: ['open-source', 'flagship'],
    modes: ['t2v'],
    supportsSeed: true,
    priceHint: '~$0.15 / 5s',
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultAspectRatio: '16:9',
    durations: [5],
    defaultDuration: 5,
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    advanced: [
      NEG_PROMPT,
      { name: 'num_frames', type: 'integer', label: 'Frame count', hidden: true,
        default: 81, min: 17, max: 121, step: 4,
        description: 'Total frames at 16 fps.' },
    ],
  },
  {
    id: 'wan-2.5-i2v-fast',
    hidden: true,
    label: 'Wan 2.5 I2V Fast',
    brand: 'Wan',
    replicateSlug: 'wan-video/wan-2.5-i2v-fast',
    pitch: 'Cheap, fast open-source image-to-video.',
    tags: ['open-source', 'fast', 'cheap'],
    modes: ['i2v'],
    supportsSeed: true,
    priceHint: '~$0.06 / 5s',
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultAspectRatio: '16:9',
    durations: [5],
    defaultDuration: 5,
    resolutions: ['480p', '720p'],
    // wan-video/wan-2.5-i2v-fast renders 720p or 1080p; 480p is sent as 720p.
    defaultResolution: '720p',
    advanced: [
      NEG_PROMPT,
    ],
  },

  // ===== Alibaba ==========================================================
  // HappyHorse 1.1 runs only in Sailor's runner (family happyhorse-1.1), on fal
  // with Replicate the backup (server/runner/generators/happyHorse11.ts). Its
  // schemas (alibaba/happy-horse/v1.1/text-to-video and /image-to-video,
  // alibaba/happyhorse-1.1, read 2026-09-25) take 3–15 s, 720p or 1080p, and a
  // seed; the clip always has sound, speech lip-synced, made from the prompt.
  // No sound switch, no negative prompt, no sound input. The duration list is
  // a pick of the schema's whole seconds; fal's 9:21, 5:4 and 4:5 are left out
  // because the node's ratio list lacks them.
  {
    id: 'happyhorse-1.1',
    runnerOnly: true,
    family: 'happyhorse-1.1',
    label: 'HappyHorse 1.1',
    brand: 'Alibaba',
    // The gallery's cover art, and the backup service's model (twins.ts).
    replicateSlug: 'alibaba/happyhorse-1.1',
    pitch: 'Clips where people talk: dialogue and lip-sync from the prompt.',
    description:
      'HappyHorse 1.1 makes 3 to 15 second clips with sound, at 720p or 1080p. '
      + 'Write what the characters say in the prompt and they speak it, lip-synced. '
      + 'Describe the clip, or link a picture to start from it. It makes its own '
      + 'sound, so it doesn\'t take a sound file.',
    tags: ['audio', 'long', '4k'],
    modes: ['t2v', 'i2v'],
    supportsSeed: true,
    priceHint: null,
    aspectRatios: FULL_AR,
    defaultAspectRatio: '16:9',
    durations: [3, 4, 5, 6, 8, 10, 12, 15],
    defaultDuration: 5,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    advanced: [],
  },

  // ===== xAI ==============================================================
  // Grok Imagine Video 1.5 runs only in Sailor's runner (family
  // grok-imagine-video-1.5), on fal, with Replicate the backup for
  // image-to-video at 480p or 720p (server/runner/generators/grokImagineVideo15.ts).
  // Its schemas (xai/grok-imagine-video/v1.5/text-to-video and /image-to-video,
  // xai/grok-imagine-video-1.5, read 2026-09-25) take 1–15 s and 480p, 720p or
  // 1080p; no seed. The clip always has sound, made from the prompt: no sound
  // switch, no negative prompt, no sound input. The duration list is a pick of
  // the schema's whole seconds; fal's 3:2 and 2:3 are left out because the
  // node's ratio list lacks them, and fal has no 21:9.
  {
    id: 'grok-imagine-video-1.5',
    runnerOnly: true,
    family: 'grok-imagine-video-1.5',
    label: 'Grok Imagine Video 1.5',
    brand: 'xAI',
    // The gallery's cover art, and the backup service's model (twins.ts).
    replicateSlug: 'xai/grok-imagine-video-1.5',
    pitch: 'Short clips with sound, from a prompt or a picture, down to one second.',
    description:
      'Grok Imagine Video 1.5 makes 1 to 15 second clips with sound, at 480p, 720p or 1080p. '
      + 'Describe the clip, or link a picture and say how it should move. It makes its own '
      + 'music, effects and speech from the prompt, so it doesn\'t take a sound file.',
    tags: ['audio', 'long', '4k'],
    modes: ['t2v', 'i2v'],
    supportsSeed: false,
    priceHint: null,
    aspectRatios: STANDARD_AR,
    defaultAspectRatio: '16:9',
    durations: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15],
    defaultDuration: 6,
    resolutions: ['480p', '720p', '1080p'],
    defaultResolution: '720p',
    advanced: [],
  },

  // ===== Luma =============================================================
  {
    id: 'luma-ray-2-720p',
    hidden: true,
    label: 'Luma Ray 2 (720p)',
    brand: 'Luma',
    replicateSlug: 'luma/ray-2-720p',
    pitch: 'Luma\'s flagship at 720p — smooth motion, clean aesthetics.',
    tags: ['cinematic'],
    modes: ['t2v', 'i2v'],
    supportsSeed: false,  // the model's schema has no seed (Task S1b)
    priceHint: '~$0.40 / 5s',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    defaultAspectRatio: '16:9',
    durations: [5, 9],
    defaultDuration: 5,
    advanced: [
      { name: 'loop', type: 'boolean', label: 'Seamless loop',
        default: false, description: 'Match the last frame to the first.' },
    ],
  },

  // ===== Lightricks =======================================================
  {
    id: 'ltx-video',
    hidden: true,
    label: 'LTX-Video',
    brand: 'Lightricks',
    replicateSlug: 'lightricks/ltx-video',
    pitch: 'DiT model that renders 24 fps faster than real-time playback.',
    tags: ['fast', 'cheap', 'open-source'],
    modes: ['t2v', 'i2v'],
    supportsSeed: true,
    priceHint: '~$0.04 / 5s',
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultAspectRatio: '16:9',
    durations: [5],
    defaultDuration: 5,
    advanced: [
      NEG_PROMPT,
      { name: 'guidance_scale', type: 'float', label: 'Guidance scale',
        default: 3.0, min: 1.0, max: 10.0, step: 0.1 },
      { name: 'num_inference_steps', type: 'integer', label: 'Inference steps',
        default: 30, min: 10, max: 50 },
    ],
  },
  // LTX-2.5 Fast replaces the hidden LTX-Video above in the gallery. It runs
  // only in Sailor's runner (family ltx-2.5-fast), on Replicate, with no
  // backup (server/runner/generators/ltx25Fast.ts). Its schema
  // (lightricks/ltx-2.5-fast, read 2026-09-25) takes 2–6, 8, …, 20 s, 16:9 or
  // 9:16, and 720p to 4k (over 10 s only at 720p or 1080p); no seed. 2k is
  // left out: its pixel size isn't stated.
  {
    id: 'ltx-2.5-fast',
    runnerOnly: true,
    family: 'ltx-2.5-fast',
    label: 'LTX-2.5 Fast',
    brand: 'Lightricks',
    // The gallery's cover art, and the first service's model (ltx25Fast.ts).
    replicateSlug: 'lightricks/ltx-2.5-fast',
    pitch: 'Quick, low-cost clips with sound, from 2 to 20 seconds, up to 4K.',
    description:
      'LTX-2.5 Fast makes 2 to 20 second clips with sound, at 720p, 1080p or 4K, in landscape '
      + 'or portrait. Describe the clip, or link a picture to start from it. Clips over 10 seconds '
      + 'are made at 720p or 1080p only.',
    tags: ['fast', 'cheap', 'audio', 'long', '4k'],
    modes: ['t2v', 'i2v'],
    supportsSeed: false,
    priceHint: null,
    aspectRatios: ['16:9', '9:16'],
    defaultAspectRatio: '16:9',
    durations: [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20],
    defaultDuration: 6,
    resolutions: ['720p', '1080p', '4k'],
    defaultResolution: '1080p',
    advanced: [
      { name: 'generate_audio', type: 'boolean', label: 'Generate audio', default: true,
        description: 'Off makes a silent clip. The price is the same.' },
    ],
  },

  // ===== PixVerse =========================================================
  {
    id: 'pixverse-v6',
    label: 'PixVerse v6',
    brand: 'PixVerse',
    replicateSlug: 'pixverse/pixverse-v6',
    pitch: 'Synced audio + multi-shot at a friendly price.',
    tags: ['audio', 'multi-shot', 'cheap'],
    modes: ['t2v', 'i2v'],
    supportsSeed: true,
    priceHint: '~$0.20 / 5s',
    aspectRatios: ['16:9', '9:16', '1:1'],
    defaultAspectRatio: '16:9',
    durations: [5, 8],
    defaultDuration: 5,
    resolutions: ['540p', '720p', '1080p'],
    defaultResolution: '720p',
    advanced: [
      AUDIO_GENERATION,
      { name: 'style', type: 'select', label: 'Style preset', hidden: true,
        default: 'none', options: ['none', 'anime', 'cinematic', '3d_animation', 'comic'] },
      NEG_PROMPT,
    ],
  },

  // ===== VEED (talking head) ==============================================
  {
    id: 'fabric-1.0',
    label: 'VEED Fabric 1.0',
    brand: 'VEED',
    replicateSlug: 'veed/fabric-1.0',
    pitch: 'Lip-sync a face image to any audio track (up to 60s).',
    description:
      'Specialty talking-head model: feed it a portrait image and an audio '
      + 'clip, get a lip-synced video back. Ignores prompt / aspect ratio / '
      + 'duration — output framing matches the input image, length matches '
      + 'the audio. Connect a LoadAudio node to the "audio" input.',
    tags: ['lip-sync', 'reference'],
    // Drives an image AND requires audio; we still list 'i2v' since the image
    // is the primary visual input. The lip-sync tag is the cue that audio is
    // also required — modal surfaces it via a dedicated chip.
    modes: ['i2v'],
    supportsSeed: false,  // lip-sync model, no seed input
    priceHint: '~$0.20 / 30s',
    // Output framing matches the input image, but we need _something_ in the
    // array for the modal's "supported aspect ratios" panel; document that
    // the model ignores this widget.
    aspectRatios: ['matches image'],
    defaultAspectRatio: 'matches image',
    durations: [60],  // hard cap from upstream; actual length = audio length
    defaultDuration: 60,
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    advanced: [],
  },
]

/**
 * The defaults for a new "Generate a video" and "Film a shot" node: the first
 * of each list that can run now (not hidden or discontinued; a runner-only
 * one only while its family is on, and never on Film a shot, which the
 * runner doesn't take). Served as the model input's `default`
 * (shared/runner/modelMenus.ts).
 */
export const VIDEO_MODEL_PREFERENCE: readonly string[] = ['hailuo-h3-max', 'veo-3.1']
// Kling 2.5 Turbo, Python's own Film a shot default, is hidden (model line-up H2).
export const FILM_SHOT_MODEL_PREFERENCE: readonly string[] = ['hailuo-h3-max', 'kling-v3']

export const VIDEO_MODELS_BY_ID: Record<string, VideoModel> = Object.fromEntries(
  VIDEO_MODELS.map(m => [m.id, m]),
)

/** Set of every aspect ratio across all video models. */
export const ALL_VIDEO_ASPECT_RATIOS: string[] = Array.from(
  new Set(VIDEO_MODELS.flatMap(m => m.aspectRatios)),
).sort((a, b) => {
  if (a === '1:1') return -1
  if (b === '1:1') return 1
  return a.localeCompare(b, undefined, { numeric: true })
})

/** Set of every duration option across all video models (deduped, sorted). */
export const ALL_VIDEO_DURATIONS: number[] = Array.from(
  new Set(VIDEO_MODELS.flatMap(m => m.durations)),
).sort((a, b) => a - b)

/** Tags that have at least one model — drives the filter chip row. */
export function activeVideoTagsInCatalog(): VideoModelTag[] {
  const seen = new Set<VideoModelTag>()
  for (const m of VIDEO_MODELS) for (const t of m.tags) seen.add(t)
  return (Object.keys(VIDEO_TAG_LABELS) as VideoModelTag[]).filter(t => seen.has(t))
}
