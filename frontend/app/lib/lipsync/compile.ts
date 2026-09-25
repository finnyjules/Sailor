import { EDIT_MODEL_MENUS } from '~/data/edit-model-options'
import { SYNC_3_ENGINE, SYNC_3_SILENCE_REFUSED } from '#shared/runner/lipSync'
import type { LipSyncSheet, ValidationIssue } from './types'

export function resolveEngine(sheet: LipSyncSheet): 'fabric' | 'sync' | 'sync-3' {
  if (sheet.engine === 'fabric' || sheet.engine === 'sync' || sheet.engine === SYNC_3_ENGINE) return sheet.engine
  return sheet.face.kind === 'video' ? 'sync' : 'fabric'
}

/** An engine's name as the menus show it (app/data/edit-model-options.ts "LipSyncNode.engine"). */
export function engineLabel(engine: string): string {
  return EDIT_MODEL_MENUS['LipSyncNode.engine']?.options.find(o => o.value === engine)?.label ?? engine
}

/** A studio file the runner can send sync-3: one uploaded to Sailor (a `/view?…` link). */
const isSailorFile = (src: string) => src.startsWith('/view?')

/** The resolved audio src: an uploaded/existing clip, empty for a TTS voice
 *  (whose audio is generated at Generate time from voice.text + voiceId). */
function voiceSrc(sheet: LipSyncSheet): string {
  return sheet.voice.src ?? ''
}

/** Whether the sheet has a usable voice: an uploaded/existing clip, OR a TTS
 *  voice with non-empty text (its audio resolves at Generate time). */
function hasVoice(sheet: LipSyncSheet): boolean {
  if (sheet.voice.kind === 'tts') return !!(sheet.voice.text && sheet.voice.text.trim())
  return !!(sheet.voice.src && sheet.voice.src.trim())
}

export function compileLipSync(sheet: LipSyncSheet): {
  modelOptions: Record<string, unknown>; engine: string; resolution: string; issues: ValidationIssue[]
} {
  const issues: ValidationIssue[] = []
  const engine = resolveEngine(sheet)
  const face = sheet.face.src.trim()
  // audio is the resolved clip URL (empty for TTS until Generate fills it); the
  // "has voice" gate uses hasVoice() so a typed TTS line doesn't read as missing.
  const audio = voiceSrc(sheet).trim()

  if (!face) issues.push({ level: 'error', code: 'no-face', message: 'Pick a character, image, or video to drive.' })
  if (!hasVoice(sheet)) issues.push({ level: 'error', code: 'no-voice', message: 'Add a voice — type a line, or upload audio.' })
  if (sheet.face.kind === 'video' && sheet.engine === 'fabric') {
    issues.push({ level: 'warning', code: 'video-needs-sync', message: 'A video face uses the sync engine; Fabric is image-only.' })
  }
  // sync-3 (model line-up F22): a face video and a sound uploaded to Sailor, and a
  // sync mode whose clip the price can read (the runner refuses the same).
  if (engine === SYNC_3_ENGINE) {
    if (face && sheet.face.kind !== 'video') issues.push({ level: 'error', code: 'sync-3-needs-video', message: 'sync-3 needs a video of the face. Upload a video as the face.' })
    else if (face && !isSailorFile(face)) issues.push({ level: 'error', code: 'sync-3-video-link', message: 'sync-3 takes a face video uploaded to Sailor, not a web link. Upload the video as the face.' })
    if (sheet.voice.kind === 'audio' && audio && !isSailorFile(audio)) {
      issues.push({ level: 'error', code: 'sync-3-sound-link', message: 'sync-3 takes a sound uploaded to Sailor, not a web link. Upload the audio, or type a line for a voice.' })
    }
    if (sheet.syncMode === 'silence') issues.push({ level: 'error', code: 'sync-3-silence', message: SYNC_3_SILENCE_REFUSED })
  }

  const modelOptions: Record<string, unknown> = { engine, resolution: sheet.resolution, audio }
  if (engine === 'sync' || engine === SYNC_3_ENGINE) { modelOptions.face_video = face; modelOptions.sync_mode = sheet.syncMode }
  else { modelOptions.face_image = face }

  return { modelOptions, engine, resolution: sheet.resolution, issues }
}
