// frontend/app/lib/shotdirector/compile.ts
// Turns a ShotSheet into a terse, best-practice prompt string (canonical
// Subject→Action→Environment→Camera→Style→References→Dialogue→Constraints
// order) plus the model's Replicate input object, and reports the word budget.
// Deterministic and pure — pinned by golden tests.

import {
  cameraMoveClause, ROLE_PURPOSE, SHOT_TYPE_PHRASE,
  type Beat, type ShotSheet,
} from './types'
import { validateShotSheet, type RefCaps, type ValidationIssue } from './rules'
import type { CastBundle, ModelInput, ModelProfile } from './profiles'
import { castClause } from './cast'

export interface CompileResult {
  prompt: string
  input: ModelInput
  wordCount: number
  issues: ValidationIssue[]
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s
}

/** "Medium shot, slow dolly in, the camera moving physically forward." */
function cameraLine(shotType: ShotSheet['camera']['shotType'], move: ShotSheet['camera']['move'], pacing: string, direction?: ShotSheet['camera']['direction']): string {
  return `${SHOT_TYPE_PHRASE[shotType]}, ${pacing} ${cameraMoveClause(move, direction)}.`
}

/** "[0s] Wide shot, smooth locked-off, a static camera. She walks to the bar." */
function beatLine(sheet: ShotSheet, b: Beat): string {
  const shotType = b.shotType ?? sheet.camera.shotType
  const move = b.move ?? sheet.camera.move
  const pacing = b.pacing ?? sheet.camera.pacing
  // A beat inherits the shot's direction only when it inherits the shot's move;
  // a beat that overrides the move falls back to that move's default direction.
  const direction = b.move ? undefined : sheet.camera.direction
  const cam = `${SHOT_TYPE_PHRASE[shotType]}, ${pacing} ${cameraMoveClause(move, direction)}.`
  const action = b.action.trim().replace(/\.$/, '')
  return `[${b.startS}s] ${cam} ${capitalize(action)}.`
}

/** "Use @Image1 for …; @Video1 for …." — reference mode only. */
function referenceSentence(sheet: ShotSheet, profile: ModelProfile): string {
  if (sheet.mode !== 'reference' || sheet.references.length === 0) return ''
  const KIND_RANK = { image: 0, video: 1, audio: 2 } as const
  const parts = [...sheet.references]
    // Cast-injected refs are already declared by the Characters clause
    // ("Characters: Vera [Image1] …") — a per-ref purpose phrase for each
    // of them is redundant noise that burns the word budget.
    .filter(r => !r.castSlug)
    .sort((a, b) => (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || (a.slot - b.slot))
    .map(r => {
      const purpose = ROLE_PURPOSE[r.role]
      const note = r.note ? ` (${r.note.trim()})` : ''
      return `${profile.refTag(r.kind, r.slot)} for ${purpose}${note}`
    })
  if (!parts.length) return ''
  return `Use ${parts.join('; ')}.`
}

function dialogueSentence(sheet: ShotSheet): string {
  // Blank rows (added in the UI but never filled) must not emit a stray `""`.
  const lines = (sheet.audio.dialogue ?? []).filter(d => d.line.trim())
  if (lines.length === 0) return ''
  return lines
    .map(d => (d.speaker ? `${d.speaker}: "${d.line.trim()}"` : `"${d.line.trim()}"`))
    .join(' ')
}

export function buildPrompt(sheet: ShotSheet, profile: ModelProfile): string {
  const segments: string[] = []

  // Subject + Action + Environment.
  const subject = sheet.subject.trim()
  const action = sheet.action.trim().replace(/\.$/, '')
  const env = sheet.environment.trim()
  let opener = subject
  if (action) opener = opener ? `${opener} ${action}` : capitalize(action)
  if (env) opener = opener ? `${opener}, in ${env}.` : `In ${env}.`
  else if (opener) opener = `${opener}.`
  if (opener) segments.push(opener)

  // Camera — timed beats replace the single camera line when present.
  if (sheet.beats.length > 0) {
    for (const b of sheet.beats) segments.push(beatLine(sheet, b))
  } else {
    segments.push(cameraLine(sheet.camera.shotType, sheet.camera.move, sheet.camera.pacing, sheet.camera.direction))
  }

  // Lighting + Style.
  const look = [sheet.lighting.trim(), sheet.style.trim()].filter(Boolean)
  if (look.length) {
    look[0]! = capitalize(look[0]!)
    segments.push(`${look.join('; ')}.`)
  }

  // References, Dialogue, Constraints.
  const refs = referenceSentence(sheet, profile)
  if (refs) segments.push(refs)
  const dlg = dialogueSentence(sheet)
  if (dlg) segments.push(dlg)
  if (sheet.constraints.length) segments.push(`Avoid ${sheet.constraints.join(', ')}.`)

  return segments.join(' ')
}

export function compileShot(
  sheet: ShotSheet,
  profile: ModelProfile,
  opts?: { castDescriptors?: Record<string, string>, castBundles?: CastBundle[] },
): CompileResult {
  const caps: RefCaps = {
    maxRefImages: profile.maxRefImages,
    maxRefVideos: profile.maxRefVideos,
    maxRefAudios: profile.maxRefAudios,
    supportsFirstLastFrame: profile.supportsFirstLastFrame,
    label: profile.label,
    castMode: profile.castMode,
    requiresFirstFrame: profile.requiresFirstFrame,
    supportsLastFrame: profile.supportsLastFrame,
    refsWithFirstFrame: profile.refsWithFirstFrame,
    referenceAspectRatios: profile.referenceAspectRatios,
  }
  const issues = validateShotSheet(sheet, caps)
  const clause = castClause(sheet, profile, opts?.castDescriptors, opts?.castBundles)
  const base = buildPrompt(sheet, profile)
  const prompt = clause ? `${clause} ${base}` : base
  const wordCount = countWords(prompt)

  if (wordCount > profile.wordBudgetHard) {
    issues.push({ level: 'error', code: 'word-budget-exceeded', message: `Prompt is ${wordCount} words; the limit is ${profile.wordBudgetHard}.` })
  } else if (wordCount > profile.wordBudgetWarn) {
    issues.push({ level: 'warning', code: 'word-budget-warning', message: `Prompt is ${wordCount} words; best practice is under ${profile.wordBudgetWarn}.` })
  }

  // Kling (requiresFirstFrame) always builds its request as firstLastFrame,
  // whatever the stored sheet's mode is — buildInput reads sheet.firstFrame/
  // lastFrame directly and ignores `mode` for elements-mode models, but this
  // keeps the contract explicit without mutating the sheet the caller holds.
  const effectiveSheet = (profile.requiresFirstFrame && sheet.mode !== 'firstLastFrame')
    ? { ...sheet, mode: 'firstLastFrame' as const }
    : sheet
  const input = profile.buildInput(effectiveSheet, prompt, opts?.castBundles)
  return { prompt, input, wordCount, issues }
}
