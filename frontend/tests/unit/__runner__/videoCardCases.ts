/**
 * The Video card's configurations for R5.4: every card setup, reader and
 * family set whose answers are pinned from the code before R5.4 (commit
 * fd2f13daa) in fixtures/runner-media-video-card-rows.json, so the current
 * code can be compared with it while media-video is off (the card's runner
 * row must be exactly as it was). Pure: no imports but types, so the scratch
 * copy of the old code can build the same prompts from this file.
 */
import type { ApiPrompt } from '#shared/runner/graph'

export const VIDEO_CARD_SOURCES = ['none', 'LoadVideo', 'CreateVideo', 'GenerateVideoNode', 'Video', 'LipSyncNode'] as const
export const VIDEO_CARD_FILES = ['', 'v.mp4'] as const
export const VIDEO_CARD_EXPORTS = [false, true] as const
export const VIDEO_CARD_READERS = ['none', 'SaveVideo', 'Video', 'GetVideoComponents'] as const
/** The family sets the card meets (media-video off in every one). */
export const VIDEO_CARD_FAMILY_SETS: readonly (readonly string[])[] = [
  [], ['cards'], ['sync-3'], ['cards', 'sync-3'], ['cards', 'media-sound'],
  ['cards', 'sync-3', 'audio-gen', 'media-sound', 'replicate-video', 'topaz-video'],
]

export interface VideoCardCase {
  source: typeof VIDEO_CARD_SOURCES[number]; file: typeof VIDEO_CARD_FILES[number]; export: boolean
  reader: typeof VIDEO_CARD_READERS[number]; families: readonly string[]
}

export function videoCardCases(): VideoCardCase[] {
  const out: VideoCardCase[] = []
  for (const source of VIDEO_CARD_SOURCES) {
    for (const file of VIDEO_CARD_FILES) {
      for (const exp of VIDEO_CARD_EXPORTS) {
        for (const reader of VIDEO_CARD_READERS) {
          for (const families of VIDEO_CARD_FAMILY_SETS) out.push({ source, file, export: exp, reader, families })
        }
      }
    }
  }
  return out
}

/** The prompt of a case: the card is node `c`. */
export function videoCardPrompt(k: VideoCardCase): ApiPrompt {
  const p: ApiPrompt = {}
  if (k.source === 'LoadVideo') p.s = { class_type: 'LoadVideo', inputs: { file: 'b.mp4' } }
  if (k.source === 'CreateVideo') {
    p.l = { class_type: 'LoadVideo', inputs: { file: 'b.mp4' } }
    p.g = { class_type: 'GetVideoComponents', inputs: { video: ['l', 0] } }
    p.s = { class_type: 'CreateVideo', inputs: { images: ['g', 0], fps: ['g', 2], audio: ['g', 1] } }
  }
  if (k.source === 'GenerateVideoNode') p.s = { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'a boat at dawn', aspect_ratio: '16:9', duration: '8', seed: 0 } }
  if (k.source === 'Video') p.s = { class_type: 'Video', inputs: { file: 'b.mp4', export: false, filename_prefix: 'video/ComfyUI' } }
  if (k.source === 'LipSyncNode') {
    p.a = { class_type: 'Audio', inputs: { audio: 'a.wav', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0' } }
    p.s = { class_type: 'LipSyncNode', inputs: { engine: 'sync-3', model_options: '{"engine":"sync-3","face_video":"face.mp4"}', sync_mode: 'cut_off', audio: ['a', 0] } }
  }
  p.c = {
    class_type: 'Video',
    inputs: {
      file: k.file, export: k.export, filename_prefix: 'video/ComfyUI',
      ...(k.source !== 'none' ? { source: ['s', 0] } : {}),
    },
  }
  if (k.reader === 'SaveVideo') p.r = { class_type: 'SaveVideo', inputs: { video: ['c', 0], filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } }
  if (k.reader === 'Video') p.r = { class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: ['c', 0] } }
  if (k.reader === 'GetVideoComponents') {
    p.r = { class_type: 'GetVideoComponents', inputs: { video: ['c', 0] } }
    p.rv = { class_type: 'CreateVideo', inputs: { images: ['r', 0], fps: ['r', 2] } }
    p.rs = { class_type: 'SaveVideo', inputs: { video: ['rv', 0], filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } }
  }
  return p
}

/** A case's key in the fixture. */
export const videoCardCaseKey = (k: VideoCardCase) => [k.source, k.file || '-', k.export ? 'export' : 'show', k.reader, k.families.join('+') || 'none'].join('|')
