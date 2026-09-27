/**
 * Reactive composable for the Shot Director studio.
 * Wraps hydrateShotSheet, compileShot, and reference management with Vue reactivity.
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { hydrateShotSheet, addRef, removeRef } from '~/lib/shotdirector/hydrate'
import { compileShot, type CompileResult } from '~/lib/shotdirector/compile'
import type { ModelProfile } from '~/lib/shotdirector/profiles'
import type { RefKind, ShotSheet } from '~/lib/shotdirector/types'
import { materializeCast, type CastResolved } from '~/lib/shotdirector/cast'
import { applyModelChoice, sheetProfile } from '~/lib/shotdirector/prepare'
import type { ValidationIssue } from '~/lib/shotdirector/rules'
import { useCharacters } from '~/composables/useCharacters'

export interface UseShotDirectorReturn {
  sheet: Ref<ShotSheet>
  result: ComputedRef<CompileResult>
  /** the sheet's chosen model (follows `sheet.model`). */
  profile: ComputedRef<ModelProfile>
  update: (mutator: (s: ShotSheet) => ShotSheet) => void
  addReference: (kind: RefKind, src: string, role: ShotSheet['references'][number]['role']) => void
  removeReference: (kind: RefKind, slot: number) => void
  rerollSeed: () => void
  /** pick the video model — see applyModelChoice (first-frame mode, duration clamp). */
  setModel: (modelId: string) => void
  addCastMember: (slug: string, name: string, via?: 'wire' | 'picker', stateId?: string | null) => void
  removeCastMember: (slug: string) => void
}

/**
 * Creates a reactive Shot Director sheet with compilation and persistence.
 * @param initial - Raw data to hydrate (e.g., node.data.properties.sailor_shotDirector)
 * @param persist - Callback to persist the sheet after mutations
 * @param resolveCast - Optional callback to resolve cast member { slug, stateId } picks to their identity pictures (IdentityRefSet, or a legacy URL list), keyed by slug
 * @param castWarnings - Optional callback producing extra warning issues for the cast (e.g. a deleted variant that silently fell back to Default)
 */
export function useShotDirector(
  initial: unknown,
  persist: (sheet: ShotSheet) => void,
  resolveCast?: (picks: { slug: string; stateId: string | null }[]) => CastResolved,
  castWarnings?: (picks: { slug: string; name: string; stateId: string | null }[]) => ValidationIssue[],
): UseShotDirectorReturn {
  const sheet = ref<ShotSheet>(hydrateShotSheet(initial))
  const profile = computed(() => sheetProfile(sheet.value))
  const store = useCharacters()

  const result = computed(() => {
    const s = sheet.value
    const p = profile.value
    if (!s.cast.length || !resolveCast) {
      return compileShot(s, p)
    }
    const picks = s.cast.map(m => ({ slug: m.slug, name: m.name, stateId: m.stateId }))
    const resolved = resolveCast(picks)
    const warnings = castWarnings?.(picks) ?? []
    const { sheet: materialized, issues: castIssues, bundles } = materializeCast(s, resolved, p)
    const castDescriptors = store.stateDescriptors(s.cast.map(m => ({ slug: m.slug, stateId: m.stateId })))
    const compiled = compileShot(materialized, p, { castDescriptors, castBundles: bundles })
    return { ...compiled, issues: [...warnings, ...castIssues, ...compiled.issues] }
  })

  const update = (mutator: (s: ShotSheet) => ShotSheet) => {
    sheet.value = mutator(sheet.value)
    persist(sheet.value)
  }

  const addReference = (kind: RefKind, src: string, role: ShotSheet['references'][number]['role']) => {
    update(s => addRef(s, kind, src, role))
  }

  const removeReference = (kind: RefKind, slot: number) => {
    update(s => removeRef(s, kind, slot))
  }

  /** New take: a fresh visible seed so the same sheet renders a new variant. */
  const rerollSeed = () => {
    update(s => ({ ...s, format: { ...s.format, seed: Math.floor(Math.random() * 2_147_483_646) + 1 } }))
  }

  const setModel = (modelId: string) => {
    update(s => applyModelChoice(s, modelId))
  }

  const addCastMember = (slug: string, name: string, via: 'wire' | 'picker' = 'picker', stateId: string | null = null) => {
    if (sheet.value.cast.some(m => m.slug === slug)) return
    update(s => ({ ...s, cast: [...s.cast, { slug, name, via, stateId }] }))
  }

  const removeCastMember = (slug: string) => {
    update(s => ({ ...s, cast: s.cast.filter(m => m.slug !== slug) }))
  }

  return {
    sheet,
    result,
    profile,
    update,
    addReference,
    removeReference,
    rerollSeed,
    setModel,
    addCastMember,
    removeCastMember,
  }
}
