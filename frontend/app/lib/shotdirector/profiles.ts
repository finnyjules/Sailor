// frontend/app/lib/shotdirector/profiles.ts
// Per-model capability declarations. A profile says what a video model can
// honor and how to assemble its Replicate input object from a ShotSheet +
// the compiled prompt string. Seedance, Kling 3 and Veo 3.1 (+ Fast) are
// fully implemented here; `stub-basic` remains a seam-proving test double.

import type { RefKind, ShotSheet } from './types'
import type { IdentityRefSet } from '#shared/characters/types'

export type ModelInput = Record<string, unknown>

/** One cast member's resolved images for `elements`-mode models (Kling). */
export interface CastBundle {
  slug: string
  front: string
  refs: string[]
}

export interface ModelProfile {
  id: string
  label: string
  maxRefImages: number
  maxRefVideos: number
  maxRefAudios: number
  supportsFirstLastFrame: boolean
  supportsGenerateAudio: boolean
  wordBudgetWarn: number
  wordBudgetHard: number
  /** how cast references reach the model: loose pictures, or named elements. */
  castMode: 'images' | 'elements'
  /** pictures per character the model will accept. */
  castRefCap: number
  /** in `images` mode, pick + order a character's pictures for wiring (no nulls, no duplicates). */
  pickCastRefs(set: IdentityRefSet): string[]
  /** can this model take a last/end frame at all. */
  supportsLastFrame: boolean
  /** must a first frame always be supplied (e.g. fal's image-to-video). */
  requiresFirstFrame: boolean
  /** can cast references and a first frame be sent together. */
  refsWithFirstFrame: boolean
  /** in-prompt reference tag, e.g. [Image1] / @Element2 / "image 3". */
  refTag(kind: RefKind, slot: number): string
  /** assemble the model's Replicate/fal input from the sheet + compiled prompt (+ resolved cast bundles for `elements` mode). */
  buildInput(sheet: ShotSheet, prompt: string, cast?: CastBundle[]): ModelInput
}

function bracketTag(kind: RefKind, slot: number): string {
  const label = kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : 'Audio'
  return `[${label}${slot}]`
}

function atTag(kind: RefKind, slot: number): string {
  const label = kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : 'Audio'
  return `@${label}${slot}`
}

function srcsByKind(sheet: ShotSheet, kind: RefKind): string[] {
  return sheet.references
    .filter(r => r.kind === kind)
    .sort((a, b) => a.slot - b.slot)
    .map(r => r.src)
}

/** ordered, no nulls, no duplicates. */
function dedupeRefs(picks: (string | null)[]): string[] {
  const out: string[] = []
  for (const p of picks) {
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

export const SEEDANCE_PROFILE: ModelProfile = {
  id: 'seedance-2.0',
  label: 'Seedance 2.0',
  maxRefImages: 9,
  maxRefVideos: 3,
  maxRefAudios: 3,
  supportsFirstLastFrame: true,
  supportsGenerateAudio: true,
  wordBudgetWarn: 100,
  wordBudgetHard: 600,
  castMode: 'images',
  castRefCap: 2,
  pickCastRefs(set) {
    return dedupeRefs([set.portrait ?? set.front, set.bodyFront])
  },
  supportsLastFrame: true,
  requiresFirstFrame: false,
  refsWithFirstFrame: false,
  refTag: atTag,
  buildInput(sheet, prompt) {
    const input: ModelInput = {
      prompt,
      duration: sheet.format.durationS,
      resolution: sheet.format.resolution,
    }
    if (sheet.mode === 'reference') {
      input.aspect_ratio = sheet.format.aspectRatio
      const images = srcsByKind(sheet, 'image')
      const videos = srcsByKind(sheet, 'video')
      const audios = srcsByKind(sheet, 'audio')
      if (images.length) input.image_urls = images
      if (videos.length) input.video_urls = videos
      if (audios.length) input.audio_urls = audios
    } else {
      if (sheet.firstFrame) input.image_url = sheet.firstFrame
      if (sheet.lastFrame) input.end_image_url = sheet.lastFrame
    }
    input.generate_audio = sheet.audio.generate
    // fal Seedance has no seed input — omit it.
    return input
  },
}

export const KLING_V3_PROFILE: ModelProfile = {
  id: 'kling-v3',
  label: 'Kling 3',
  maxRefImages: 0,
  maxRefVideos: 0,
  maxRefAudios: 0,
  supportsFirstLastFrame: true,
  supportsGenerateAudio: true,
  wordBudgetWarn: 400,
  wordBudgetHard: 2500,
  castMode: 'elements',
  castRefCap: 4,
  pickCastRefs() {
    // elements mode wires cast as `elements`, not loose pictures.
    return []
  },
  supportsLastFrame: true,
  requiresFirstFrame: true,
  refsWithFirstFrame: true,
  refTag: (_kind, slot) => `@Element${slot}`,
  buildInput(sheet, prompt, cast) {
    const input: ModelInput = {
      prompt,
      duration: sheet.format.durationS,
      generate_audio: sheet.audio.generate,
      image_url: sheet.firstFrame,
    }
    if (sheet.lastFrame) input.end_image_url = sheet.lastFrame
    if (cast?.length) {
      input.elements = cast.map(c => ({ frontal_image_url: c.front, reference_image_urls: c.refs }))
    }
    return input
  },
}

function veoProfile(id: string, label: string): ModelProfile {
  return {
    id,
    label,
    maxRefImages: 3,
    maxRefVideos: 0,
    maxRefAudios: 0,
    supportsFirstLastFrame: true,
    supportsGenerateAudio: true,
    wordBudgetWarn: 150,
    wordBudgetHard: 1000,
    castMode: 'images',
    castRefCap: 3,
    pickCastRefs(set) {
      return dedupeRefs([set.front, set.portrait, set.bodyFront])
    },
    supportsLastFrame: false,
    requiresFirstFrame: false,
    refsWithFirstFrame: false,
    refTag: (_kind, slot) => `image ${slot}`,
    buildInput(sheet, prompt) {
      const input: ModelInput = {
        prompt,
        resolution: sheet.format.resolution,
        generate_audio: sheet.audio.generate,
      }
      if (sheet.mode === 'reference') {
        input.aspect_ratio = sheet.format.aspectRatio
        input.image_urls = srcsByKind(sheet, 'image')
      } else if (sheet.firstFrame) {
        input.image_url = sheet.firstFrame
      }
      return input
    },
  }
}

export const VEO_31_PROFILE: ModelProfile = veoProfile('veo-3.1', 'Veo 3.1')
export const VEO_31_FAST_PROFILE: ModelProfile = veoProfile('veo-3.1-fast', 'Veo 3.1 Fast')

// Seam-proving stub: a hypothetical model with a smaller reference surface and
// no video/audio refs. Kept for tests exercising the compiler + rules across
// differing capabilities.
export const SEEDANCE_STUB_OTHER: ModelProfile = {
  id: 'stub-basic',
  label: 'Basic (stub)',
  maxRefImages: 3,
  maxRefVideos: 0,
  maxRefAudios: 0,
  supportsFirstLastFrame: false,
  supportsGenerateAudio: false,
  wordBudgetWarn: 100,
  wordBudgetHard: 600,
  castMode: 'images',
  castRefCap: 2,
  pickCastRefs(set) {
    return dedupeRefs([set.portrait ?? set.front, set.bodyFront])
  },
  supportsLastFrame: false,
  requiresFirstFrame: false,
  refsWithFirstFrame: false,
  refTag: bracketTag,
  buildInput(sheet, prompt) {
    return {
      prompt,
      aspect_ratio: sheet.format.aspectRatio,
      duration: sheet.format.durationS,
    }
  },
}

export const SHOT_PROFILES_BY_ID: Record<string, ModelProfile> = {
  [SEEDANCE_PROFILE.id]: SEEDANCE_PROFILE,
  [KLING_V3_PROFILE.id]: KLING_V3_PROFILE,
  [VEO_31_PROFILE.id]: VEO_31_PROFILE,
  [VEO_31_FAST_PROFILE.id]: VEO_31_FAST_PROFILE,
  [SEEDANCE_STUB_OTHER.id]: SEEDANCE_STUB_OTHER,
}

/** Selectable models for the Shot Director model picker (sentence-case labels). Leaves out the test-only stub. */
export const SHOT_MODEL_CHOICES: { id: string; label: string }[] = [
  { id: SEEDANCE_PROFILE.id, label: SEEDANCE_PROFILE.label },
  { id: KLING_V3_PROFILE.id, label: KLING_V3_PROFILE.label },
  { id: VEO_31_PROFILE.id, label: VEO_31_PROFILE.label },
  { id: VEO_31_FAST_PROFILE.id, label: VEO_31_FAST_PROFILE.label },
]

export function getProfile(id: string): ModelProfile {
  return SHOT_PROFILES_BY_ID[id] ?? SEEDANCE_PROFILE
}
