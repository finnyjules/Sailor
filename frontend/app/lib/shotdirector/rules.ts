// frontend/app/lib/shotdirector/rules.ts
// Pure invariant checks for a ShotSheet. Returns a flat list of issues;
// never throws. The UI blocks Render when any 'error' issue is present.

import type { RefKind, ShotSheet } from './types'

export type IssueLevel = 'error' | 'warning'

export interface ValidationIssue {
  level: IssueLevel
  code: string
  message: string
}

// Minimal capability shape rules need — a structural subset of ModelProfile,
// declared here to keep rules.ts free of a profiles.ts import cycle.
export interface RefCaps {
  maxRefImages: number
  maxRefVideos: number
  maxRefAudios: number
  supportsFirstLastFrame: boolean
  /** the model's display name, for plain-words issue copy (never an id). */
  label: string
  /** how cast references reach the model — needed to tell whether a first frame silently drops the cast. */
  castMode: 'images' | 'elements'
  /** must a first frame always be supplied. */
  requiresFirstFrame: boolean
  /** can this model take a last/end frame at all. */
  supportsLastFrame: boolean
  /** can cast references and a first frame be sent together. */
  refsWithFirstFrame: boolean
}

function countKind(sheet: ShotSheet, kind: RefKind): number {
  return sheet.references.filter(r => r.kind === kind).length
}

export function validateShotSheet(sheet: ShotSheet, caps: RefCaps): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const err = (code: string, message: string) => issues.push({ level: 'error', code, message })

  const images = countKind(sheet, 'image')
  const videos = countKind(sheet, 'video')
  const audios = countKind(sheet, 'audio')

  // Mode exclusivity (mirrors the Replicate schema).
  if (sheet.mode === 'reference' && (sheet.firstFrame || sheet.lastFrame)) {
    err('mode-conflict', 'Reference mode cannot use a first/last frame — switch modes or clear the frames.')
  }
  if (sheet.mode === 'firstLastFrame' && sheet.references.length > 0) {
    err('mode-conflict', 'First/last-frame mode cannot use reference images — switch modes or clear the references.')
  }
  if (sheet.mode === 'firstLastFrame' && !caps.supportsFirstLastFrame) {
    err('firstlast-unsupported', 'This model does not support first/last-frame input.')
  }
  if (caps.requiresFirstFrame && !sheet.firstFrame) {
    err('first-frame-required', `${caps.label} needs a first frame. Make one from the cast or upload one.`)
  }
  if (sheet.lastFrame && !caps.supportsLastFrame) {
    err('last-frame-unsupported', `${caps.label} can't use a last frame.`)
  }
  if (sheet.firstFrame && !caps.refsWithFirstFrame) {
    const hasImageRefs = sheet.references.some(r => r.kind === 'image')
    const hasCastInImagesMode = sheet.cast.length > 0 && caps.castMode === 'images'
    if (hasImageRefs || hasCastInImagesMode) {
      issues.push({
        level: 'warning', code: 'first-frame-drops-refs',
        message: `${caps.label} uses either the first frame or reference pictures, not both. Characters are left out while a first frame is set.`,
      })
    }
  }

  // Audio references need at least one visual reference.
  if (audios > 0 && images === 0 && videos === 0) {
    err('audio-needs-visual', 'Audio references require at least one image or video reference.')
  }

  // Reference capacity vs the model profile.
  if (images > caps.maxRefImages) err('too-many-image-refs', `At most ${caps.maxRefImages} image references.`)
  if (videos > caps.maxRefVideos) {
    err(caps.maxRefVideos === 0 ? 'videos-unsupported' : 'too-many-video-refs',
      caps.maxRefVideos === 0 ? 'This model does not support reference videos.' : `At most ${caps.maxRefVideos} video references.`)
  }
  if (audios > caps.maxRefAudios) {
    err(caps.maxRefAudios === 0 ? 'audios-unsupported' : 'too-many-audio-refs',
      caps.maxRefAudios === 0 ? 'This model does not support reference audios.' : `At most ${caps.maxRefAudios} audio references.`)
  }

  // Beats.
  if (sheet.beats.length > 3) err('too-many-beats', 'A shot can have at most 3 beats.')
  if (sheet.beats.length > 0 && sheet.format.durationS === -1) {
    err('beats-need-duration', 'Set a concrete duration to use beats (intelligent duration has no timeline).')
  }
  for (const b of sheet.beats) {
    if (b.endS <= b.startS) err('beat-order', `Beat "${b.id}" ends before it starts.`)
    if (sheet.format.durationS > 0 && b.endS > sheet.format.durationS) {
      err('beat-overflow', `Beat "${b.id}" runs past the ${sheet.format.durationS}s clip.`)
    }
  }

  return issues
}
