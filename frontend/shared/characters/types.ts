/**
 * THE character model. One character = a set of STATES (Higgsfield: one asset
 * per state — Cal-clean / Cal-wet / Cal-bloody), each with its own composite
 * sheet that is the identity asset every generator consumes. Imported by both
 * the Nitro server (registry) and the app (store) — no more hand-copied mirrors.
 */
export type PanelSlot = 'body-front' | 'body-back' | 'portrait' | 'face-neutral' | 'face-smile'

export type CharacterStateStatus = 'draft' | 'testing' | 'locked'

export interface StressResult { passes: number; total: number; at: string }

export type CheckVerdict = 'match' | 'unsure' | 'different' | 'no-face'
/** One character's face score for a video take's frames (spec: Checks, Task 9). */
export interface TakeFaceScore { slug: string; name: string; best: number | null; verdict: CheckVerdict; note?: string }
export interface Check {
  verdict: CheckVerdict
  /** Similarity on the checker's scale (AWS Rekognition: 0–100). Absent for 'no-face'. */
  score?: number
  /** The face filename this check compared against — a different face makes the check stale. */
  against: string
  lookFit?: 'ok' | 'off'
  note?: string
  at: string
}
export interface FaceRef { filename: string; approvedAt: string }
/** Fractions of the image (0..1) — which person, for photos with two people. */
export interface FaceBox { x: number; y: number; w: number; h: number }
export interface Photo { filename: string; check: Check | null; crop?: FaceBox }
export interface Garment { id: string; filename: string; name: string }
export interface MadeFrom { face: string; clothesKey: string; bodyKey: string; model: string }
export interface VoiceRef { kind: 'stock' | 'trained'; id: string; label: string }
export type CharacterOrigin = 'described' | 'photos' | 'canvas'
export type CharacterStyle = 'photo' | 'anime'

export interface CharacterPanel { slot: PanelSlot; filename: string; check?: Check | null; madeFrom?: MadeFrom | null }

export interface CharacterState {
  /** Stable id. 'default' is an ordinary stored id — client-side addressing uses null for "the default". */
  id: string
  label: string
  /** State look descriptor ("soaked navy jacket, wet hair") — feeds sheet prompts AND the shot's cast clause. */
  descriptor: string
  /** Legacy free-form ref pool (uploads, LoRA training fodder, pre-sheet fallback). */
  refImages: string[]
  coverIndex: number
  /** The 5 Higgsfield source shots, kept for per-panel reroll. */
  panels: CharacterPanel[]
  /** Composite sheet filename in the input dir — THE identity asset once generated. */
  sheetImage: string | null
  /** Clothing pieces for this look, their photos kept (sent as their own references). */
  clothes: Garment[]
  /** This look's own face, set when a body change moves the face and the user approves it. Null → the character's face. */
  face: FaceRef | null
  status: CharacterStateStatus
  stressResult: StressResult | null
  updatedAt: string
}

/**
 * Body-shape sliders (0..1 each). Character-level, not per-state — a body
 * doesn't change with wardrobe. `bodyPhrase` (app/lib/characters/bodyPhrase.ts)
 * compiles a set of these into graded prose fed to prompt builders.
 */
export const BODY_SLIDERS = ['frame', 'height', 'build', 'muscle', 'shoulders', 'chest', 'waist', 'hips'] as const
export type BodySliderId = typeof BODY_SLIDERS[number]

export interface CharacterRecord {
  name: string
  slug: string
  /** The approved face — the anchor every picture is checked against. */
  face: FaceRef | null
  /** Photos of who she is, for all looks (was per-look refImages; those stay for old consumers). */
  photos: Photo[]
  voice: VoiceRef | null
  origin: CharacterOrigin
  /** The creator confirmed the right to use this person's likeness (photo/canvas origins). */
  likenessConfirmed: boolean
  /** Set at creation, never changes. Photo is checked by AWS, Anime by a vision model. */
  style: CharacterStyle
  /** Slug of the character this one was made from ("Make an anime version"), else null. */
  linkedFrom: string | null
  states: CharacterState[]
  loraName: string | null
  trigger: string | null
  /** Dense after first save — all sliders present; neutral 0.5 values emit no phrase. null = untouched entirely. */
  bodyShape: Partial<Record<BodySliderId, number>> | null
  notes: string
  createdAt: string
  updatedAt: string
}

/** 'default' | '' | undefined → null. The ONLY place the sentinel is understood. */
export function normalizeStateId(id: string | null | undefined): string | null {
  return id && id !== 'default' ? id : null
}

export function defaultState<T extends Pick<CharacterRecord, 'states'>>(record: T): T['states'][number] {
  return record.states.find(s => s.id === 'default') ?? record.states[0]!
}

export function pickState<T extends Pick<CharacterRecord, 'states'>>(
  record: T, stateId: string | null,
): T['states'][number] | undefined {
  const byId = stateId ? record.states.find(s => s.id === stateId) : undefined
  return byId ?? record.states.find(s => s.id === 'default') ?? record.states[0]
}

/** Ref filenames cover-first, so `slice(0, 1)` is the cover the user picked. */
export function coverFirstRefs(state?: Pick<CharacterState, 'refImages' | 'coverIndex'>): string[] {
  const refs = state?.refImages ?? []
  if (refs.length <= 1) return [...refs]
  const ci = Math.min(Math.max(state?.coverIndex ?? 0, 0), refs.length - 1)
  return [refs[ci]!, ...refs.slice(0, ci), ...refs.slice(ci + 1)]
}

export function panelFilename(state: Pick<CharacterState, 'panels'>, slot: PanelSlot): string | null {
  return state.panels.find(p => p.slot === slot)?.filename ?? null
}

/**
 * The consumption list, identity-asset-first: once a composite sheet exists it
 * leads (so it is the first, highest-weighted reference); before that,
 * cover-first refs.
 */
export function identityRefs(state?: CharacterState): string[] {
  if (!state) return []
  const rest = coverFirstRefs(state)
  return state.sheetImage ? [state.sheetImage, ...rest] : rest
}

export interface IdentityRefSet { name: string; front: string | null; portrait: string | null; bodyFront: string | null; bodyBack: string | null }

/** The look's face, else the character's approved face (spec: one face per character). */
export function lookFaceFilename(record: CharacterRecord, state: CharacterState | undefined): string | null {
  return state?.face?.filename ?? record.face?.filename ?? null
}

/** Every clean single-person picture of one look, by role. Never the sheet grid. */
export function identityRefSet(record: CharacterRecord, state: CharacterState | undefined): IdentityRefSet {
  const cover = state ? coverFirstRefs(state)[0] ?? null : null
  const front = (state ? panelFilename(state, 'face-neutral') : null)
    ?? lookFaceFilename(record, state)
    ?? (state ? panelFilename(state, 'portrait') : null)
    ?? cover
  return {
    name: record.name,
    front,
    portrait: state ? panelFilename(state, 'portrait') : null,
    bodyFront: state ? panelFilename(state, 'body-front') : null,
    bodyBack: state ? panelFilename(state, 'body-back') : null,
  }
}

/**
 * What a VIDEO model gets for one character look: at most two pictures of the
 * same person. The combined sheet grid is never sent — Seedance's own guide
 * warns multi-view images read as several people. Portrait + full-body front
 * come from one generation, so they are one person; the face stands in for a
 * missing portrait; without panels, only the front (cover) alone — two photos
 * could be two different people.
 */
export function videoIdentityRefs(record: CharacterRecord, state: CharacterState | undefined): string[] {
  const set = identityRefSet(record, state)
  const refs = [set.portrait ?? lookFaceFilename(record, state), set.bodyFront]
    .filter((f): f is string => !!f)
  if (refs.length) return [...new Set(refs)]
  return set.front ? [set.front] : []
}

/** Visible text for a non-locked state's flag in cast/state pickers — never hidden, just badged. */
export const DRAFT_BADGE_TEXT = 'draft — not stress-tested'

/**
 * Cast/state pickers (CharacterPickerModal, CharacterNode's variant select,
 * the library panel's Looks row) surface a stress-tested look first: a
 * stable sort putting 'locked' states ahead of 'draft'/'testing', otherwise
 * preserving order. Does not mutate the input.
 */
export function sortStatesLockedFirst<T extends { status: CharacterStateStatus }>(states: T[]): T[] {
  return [...states].sort((a, b) => (a.status === 'locked' ? 0 : 1) - (b.status === 'locked' ? 0 : 1))
}

/** Badge text for a state's status — null once locked (nothing to flag), the shared warning otherwise. */
export function draftBadge(status: CharacterStateStatus): string | null {
  return status === 'locked' ? null : DRAFT_BADGE_TEXT
}

export function emptyState(id: string, label: string): CharacterState {
  return {
    id, label, descriptor: '', refImages: [], coverIndex: 0,
    panels: [], sheetImage: null, clothes: [], face: null, status: 'draft', stressResult: null,
    updatedAt: '',
  }
}
