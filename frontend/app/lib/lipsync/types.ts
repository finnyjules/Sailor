export interface ValidationIssue { level: 'error' | 'warning'; code: string; message: string }

export type FaceKind = 'character' | 'image' | 'video'
export type VoiceKind = 'tts' | 'audio'

export interface LipSyncSheet {
  face: { kind: FaceKind; src: string; characterSlug?: string }
  voice: { kind: VoiceKind; text?: string; voiceId?: string; src?: string }
  /** 'sync-3' runs only in Sailor's runner, while its switch is on (model line-up F22). */
  engine: 'auto' | 'fabric' | 'sync' | 'sync-3'
  resolution: '480p' | '720p' | '1080p'
  syncMode: 'cut_off' | 'loop' | 'bounce' | 'silence' | 'remap'
}
