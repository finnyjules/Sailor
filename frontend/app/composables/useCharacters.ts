/**
 * THE client character store — module-level cached list (one fetch feeds
 * every consumer: surface, picker, panel, canvas nodes) plus identity-first
 * ref resolution and every mutation. Every mutator awaits its PATCH then
 * refreshes internally — there is no changed-event to dispatch or listen for.
 */
import { ref } from 'vue'
import type { BodySliderId, CharacterRecord, CharacterState } from '#shared/characters/types'
import { coverFirstRefs, identityRefs, panelFilename, pickState } from '#shared/characters/types'
import { viewRefUrl } from '~/lib/shotdirector/refUpload'
import { bodyPhrase } from '~/lib/characters/bodyPhrase'

export { coverFirstRefs } from '#shared/characters/types'

/**
 * Client-side mirror of the server's `StatePatchBody` (server/utils/characterStatePatch.ts).
 * App code must not import from server/, so this is re-declared verbatim here.
 */
export interface StatePatchBody {
  stateId: string
  expectedUpdatedAt?: string
  patch: Partial<Pick<CharacterState, 'label' | 'descriptor' | 'refImages' | 'coverIndex' | 'panels' | 'sheetImage' | 'status' | 'stressResult'>>
}

const characters = ref<CharacterRecord[]>([])
const loading = ref(false)
const error = ref('')
let fetchedOnce = false

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await fetch('/api/characters-local')
    if (res.ok) {
      const data = await res.json() as { characters?: CharacterRecord[] }
      characters.value = data.characters ?? []
    } else {
      error.value = `Could not load characters (HTTP ${res.status})`
    }
  } catch (err: any) {
    // Offline / server restarting — keep the last known list, surface the miss.
    error.value = err?.message || 'Could not load characters'
  }
  finally { fetchedOnce = true; loading.value = false }
}

/**
 * Warning issues for cast picks whose state no longer exists (deleted from
 * the character) — resolution silently falls back to the Default look, so the
 * shot renders differently than the sheet says; surface that. Unknown SLUGS
 * are not warned here: they already produce the zero-refs error downstream.
 * Pure over the given catalog so it unit-tests without module state.
 */
export function missingStateIssues(
  picks: { slug: string; name: string; stateId: string | null }[],
  catalog: { slug: string; states: { id: string }[] }[],
): { level: 'warning'; code: 'cast-state-missing'; message: string }[] {
  const bySlug = new Map(catalog.map(c => [c.slug, c]))
  const issues: { level: 'warning'; code: 'cast-state-missing'; message: string }[] = []
  for (const p of picks) {
    if (!p.stateId) continue
    const c = bySlug.get(p.slug)
    if (c && !c.states.some(s => s.id === p.stateId)) {
      issues.push({
        level: 'warning',
        code: 'cast-state-missing',
        message: `${p.name}'s selected look no longer exists — using their Default look.`,
      })
    }
  }
  return issues
}

export function useCharacters() {
  if (!fetchedOnce && typeof window !== 'undefined') void refresh()

  /**
   * Resolve a list of { slug, stateId } picks to /view URLs, keyed by slug.
   * Identity-first: once a state has a composite sheet it leads, then
   * cover-first refs. Unknown state ids (or null) fall back to the
   * character's default state. Unknown slugs map to an empty array.
   */
  function resolveStateRefs(picks: { slug: string; stateId: string | null }[]): Record<string, string[]> {
    const bySlug = new Map(characters.value.map(c => [c.slug, c]))
    const out: Record<string, string[]> = {}
    for (const { slug, stateId } of picks) {
      const c = bySlug.get(slug)
      const state = c ? pickState(c, stateId) : undefined
      out[slug] = identityRefs(state).map(viewRefUrl)
    }
    return out
  }

  /** Thin wrapper over resolveStateRefs for callers that don't care about states. */
  function resolveRefs(slugs: string[]): Record<string, string[]> {
    return resolveStateRefs(slugs.map(slug => ({ slug, stateId: null })))
  }

  function coverUrl(c: CharacterRecord, stateId?: string | null): string | null {
    const state = pickState(c, stateId ?? null)
    if (!state) return null
    const f = coverFirstRefs(state)[0]
    return f ? viewRefUrl(f) : null
  }

  /** Portrait panel first (the dedicated close-up shot), else the state's cover. */
  function portraitUrl(c: CharacterRecord, stateId?: string | null): string | null {
    const state = pickState(c, stateId ?? null)
    if (!state) return null
    const f = panelFilename(state, 'portrait') ?? coverFirstRefs(state)[0] ?? null
    return f ? viewRefUrl(f) : null
  }

  /**
   * slug → descriptor for each pick's resolved state, joined with the
   * character's graded body phrase (empty/null bodyShape contributes
   * nothing, so this collapses to the bare state descriptor — unchanged
   * from before the body phrase existed). Inner join is ', ' — this whole
   * result gets folded into a cast clause list that's already delimited by
   * '; ', so reusing '; ' here would read ambiguously against that outer
   * delimiter.
   */
  function stateDescriptors(picks: { slug: string; stateId: string | null }[]): Record<string, string> {
    const bySlug = new Map(characters.value.map(c => [c.slug, c]))
    const out: Record<string, string> = {}
    for (const { slug, stateId } of picks) {
      const c = bySlug.get(slug)
      const state = c ? pickState(c, stateId) : undefined
      const joined = [state?.descriptor?.trim(), bodyPhrase(c?.bodyShape)].filter(Boolean).join(', ')
      if (joined) out[slug] = joined
    }
    return out
  }

  async function patchCharacter(
    slug: string,
    fields: {
      name?: string; notes?: string; loraName?: string | null; trigger?: string | null
      bodyShape?: Partial<Record<BodySliderId, number>> | null
    },
  ): Promise<boolean> {
    try {
      const res = await fetch('/api/characters-local', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, ...fields }),
      })
      return res.ok
    } catch { return false }
    finally { await refresh() } // even on failure — pull the truth
  }

  async function patchState(slug: string, statePatch: StatePatchBody): Promise<'ok' | 'stale' | 'error'> {
    try {
      const res = await fetch('/api/characters-local', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, statePatch }),
      })
      return res.ok ? 'ok' : res.status === 409 ? 'stale' : 'error'
    } catch { return 'error' }
    finally { await refresh() } // even on stale/error — pull the truth
  }

  /**
   * Full-array structural replace (create/delete-variant). `expectedUpdatedAt`
   * mirrors patchState's record-level staleness guard: pass the character's
   * current `updatedAt` and a concurrent edit landing first 409s instead of
   * being silently clobbered by this replace.
   */
  async function replaceStates(slug: string, states: CharacterState[], expectedUpdatedAt?: string): Promise<'ok' | 'stale' | 'error'> {
    try {
      const res = await fetch('/api/characters-local', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, states, ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}) }),
      })
      return res.ok ? 'ok' : res.status === 409 ? 'stale' : 'error'
    } catch { return 'error' }
    finally { await refresh() } // even on stale/error — pull the truth
  }

  async function removeCharacter(slug: string): Promise<boolean> {
    try {
      const res = await fetch('/api/characters-local', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, remove: true }),
      })
      return res.ok
    } catch { return false }
    finally { await refresh() } // even on failure — pull the truth
  }

  return {
    characters, loading, error, refresh,
    resolveStateRefs, resolveRefs, coverUrl, portraitUrl, stateDescriptors,
    patchCharacter, patchState, replaceStates, removeCharacter,
  }
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

export type CharacterStatus = 'draft' | 'training' | 'ready'

/** Minimal shape of a training-queue job needed to derive character status. */
export interface TrainingJobLike {
  status: string
  loraKind?: string
  displayName?: string
  outputName?: string
  progressPct?: number
}

export const IN_FLIGHT_STATUSES = new Set(['queued', 'starting', 'processing'])

/** Loosely normalize a name for outputName comparison (lowercase, alnum-only). */
export function slugish(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Pure status derivation: ready if the character already has a linked LoRA;
 * training if a matching in-flight character-kind job exists in the queue;
 * else draft.
 */
export function characterStatus(c: Pick<CharacterRecord, 'name' | 'loraName'>, jobs: TrainingJobLike[]): CharacterStatus {
  if (c.loraName) return 'ready'
  const nameSlug = slugish(c.name)
  const training = jobs.some(job =>
    IN_FLIGHT_STATUSES.has(job.status)
    && job.loraKind === 'character'
    && (
      (job.displayName ?? '').toLowerCase() === c.name.toLowerCase()
      || slugish(job.outputName ?? '') === nameSlug
    ))
  return training ? 'training' : 'draft'
}

// ---------------------------------------------------------------------------
// Training jobs poll
// ---------------------------------------------------------------------------

const jobs = ref<TrainingJobLike[]>([])
const pollingEnabled = ref(false)
let pollHandle: ReturnType<typeof setInterval> | null = null
let jobsFetchedOnce = false

async function refreshJobs(): Promise<void> {
  try {
    const res = await fetch('/api/training-queue')
    if (res.ok) {
      const data = await res.json() as { jobs?: TrainingJobLike[] }
      jobs.value = data.jobs ?? []
    }
  } catch { /* offline — keep last known list */ }
}

function startPolling(): void {
  if (pollHandle || typeof window === 'undefined') return
  pollHandle = setInterval(() => { void refreshJobs() }, 15_000)
}

function stopPolling(): void {
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null }
}

/**
 * Mini-composable over the training-queue registry. Module-level `jobs` so
 * every consumer shares one poll. Polling only runs while some consumer has
 * set `pollingEnabled.value = true` (e.g. the character panel while open).
 */
export function useTrainingJobs() {
  // Guard set before the fetch: callers invoke this per-render (sheetCostLabel),
  // and an unguarded eager fetch loops render → jobs.value → render.
  if (!jobsFetchedOnce && typeof window !== 'undefined') {
    jobsFetchedOnce = true
    void refreshJobs()
  }

  function setPolling(enabled: boolean): void {
    pollingEnabled.value = enabled
    if (enabled) startPolling()
    else stopPolling()
  }

  return { jobs, pollingEnabled, refreshJobs, setPolling }
}
