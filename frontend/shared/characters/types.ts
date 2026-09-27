/**
 * THE character model. One character = a set of STATES (Higgsfield: one asset
 * per state — Cal-clean / Cal-wet / Cal-bloody), each with its own composite
 * sheet that is the identity asset every generator consumes. Imported by both
 * the Nitro server (registry) and the app (store) — no more hand-copied mirrors.
 */
export type PanelSlot = 'body-front' | 'body-back' | 'portrait' | 'face-neutral' | 'face-smile'

export interface CharacterPanel { slot: PanelSlot; filename: string }

export type CharacterStateStatus = 'draft' | 'testing' | 'locked'

export interface StressResult { passes: number; total: number; at: string }

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
 * leads (so CAST_REF_CAP=1 sends the sheet); before that, cover-first refs.
 */
export function identityRefs(state?: CharacterState): string[] {
  if (!state) return []
  const rest = coverFirstRefs(state)
  return state.sheetImage ? [state.sheetImage, ...rest] : rest
}

/**
 * What a VIDEO model gets for one character look: at most two pictures of the
 * same person. The combined sheet grid is never sent — Seedance's own guide
 * warns multi-view images read as several people. Portrait + full-body front
 * come from one generation, so they are one person; without panels, only the
 * cover (two photos could be two different people).
 */
export function videoIdentityRefs(state?: CharacterState): string[] {
  if (!state) return []
  const panels = [panelFilename(state, 'portrait'), panelFilename(state, 'body-front')]
    .filter((f): f is string => !!f)
  if (panels.length) return panels
  const cover = coverFirstRefs(state)[0]
  return cover ? [cover] : []
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
    panels: [], sheetImage: null, status: 'draft', stressResult: null,
    updatedAt: '',
  }
}
