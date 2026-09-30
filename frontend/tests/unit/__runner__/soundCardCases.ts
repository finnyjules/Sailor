/**
 * The Audio card's configurations for R5.3 fix round 1 (Minor 3): every card
 * setup, reader and family set whose answers are pinned from the code before
 * R5.3 (commit b56ff8551) in fixtures/runner-media-sound-card-rows.json, so
 * the current code can be compared with it while media-sound is off. Pure: no
 * imports but types, so the scratch copy of the old code can build the same
 * prompts from this file.
 */
import type { ApiPrompt } from '#shared/runner/graph'

export const CARD_SOURCES = ['none', 'LoadAudio', 'RecordAudio', 'GenerateMusicNode', 'GenerateSpeechNode', 'Audio'] as const
export const CARD_FILES = ['', 'a.wav'] as const
export const CARD_EXPORTS = [false, true] as const
export const CARD_FORMATS = ['flac', 'wav'] as const
export const CARD_READERS = ['none', 'LipSyncNode', 'SaveAudio', 'PreviewAudio', 'Audio'] as const
/** Every subset of the families the card's rows name, media-sound off. */
export const CARD_FAMILY_SETS: readonly (readonly string[])[] = [[], ['cards'], ['sync-3'], ['audio-gen'], ['cards', 'sync-3'], ['cards', 'audio-gen'], ['sync-3', 'audio-gen'], ['cards', 'sync-3', 'audio-gen']]

export interface CardCase {
  source: typeof CARD_SOURCES[number]; file: typeof CARD_FILES[number]; export: boolean
  format: typeof CARD_FORMATS[number]; reader: typeof CARD_READERS[number]; families: readonly string[]
}

export function cardCases(): CardCase[] {
  const out: CardCase[] = []
  for (const source of CARD_SOURCES) {
    for (const file of CARD_FILES) {
      for (const exp of CARD_EXPORTS) {
        for (const format of CARD_FORMATS) {
          for (const reader of CARD_READERS) {
            for (const families of CARD_FAMILY_SETS) out.push({ source, file, export: exp, format, reader, families })
          }
        }
      }
    }
  }
  return out
}

/** The prompt of a case: the card is node `c`. */
export function cardPrompt(k: CardCase): ApiPrompt {
  const p: ApiPrompt = {}
  if (k.source === 'LoadAudio') p.s = { class_type: 'LoadAudio', inputs: { audio: 'b.wav' } }
  if (k.source === 'RecordAudio') p.s = { class_type: 'RecordAudio', inputs: { audio: 'rec.webm' } }
  if (k.source === 'GenerateMusicNode') p.s = { class_type: 'GenerateMusicNode', inputs: { model: 'MusicGen', prompt: 'calm piano', duration: 8, model_version: 'stereo-large', temperature: 1, top_p: 0, seed: 0 } }
  if (k.source === 'GenerateSpeechNode') p.s = { class_type: 'GenerateSpeechNode', inputs: { model: 'MiniMax Speech-02 HD', text: 'hello there', voice_id: 'Wise_Woman', emotion: 'auto', speed: 1, volume: 1, pitch: 0, language_boost: 'auto' } }
  if (k.source === 'Audio') p.s = { class_type: 'Audio', inputs: { audio: 'b.wav', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0' } }
  p.c = {
    class_type: 'Audio',
    inputs: {
      audio: k.file, export: k.export, filename_prefix: 'audio/ComfyUI', format: k.format, quality: 'V0',
      ...(k.source !== 'none' ? { source: ['s', 0] } : {}),
    },
  }
  if (k.reader === 'LipSyncNode') p.r = { class_type: 'LipSyncNode', inputs: { engine: 'sync-3', model_options: '{"engine":"sync-3","face_video":"face.mp4"}', sync_mode: 'cut_off', audio: ['c', 0] } }
  if (k.reader === 'SaveAudio') p.r = { class_type: 'SaveAudio', inputs: { audio: ['c', 0], filename_prefix: 'audio/ComfyUI' } }
  if (k.reader === 'PreviewAudio') p.r = { class_type: 'PreviewAudio', inputs: { audio: ['c', 0] } }
  if (k.reader === 'Audio') p.r = { class_type: 'Audio', inputs: { audio: '', export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0', source: ['c', 0] } }
  return p
}

/** A case's key in the fixture. */
export const cardCaseKey = (k: CardCase) => [k.source, k.file || '-', k.export ? 'export' : 'show', k.format, k.reader, k.families.join('+') || 'none'].join('|')
