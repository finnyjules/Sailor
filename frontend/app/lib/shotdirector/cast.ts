/**
 * Cast materialization: turn `sheet.cast` (live registry links) into concrete
 * identity-lock image references, cast-first so [Image1] is always cast
 * member #1. Pure — the caller resolves slugs → ref URLs (useCharacters).
 * Cast-injected refs carry `castSlug`; re-materializing replaces them, so the
 * operation is idempotent and manual refs are preserved and renumbered.
 */
import type { ModelProfile } from '~/lib/shotdirector/profiles'
import type { Ref, ShotSheet } from '~/lib/shotdirector/types'
import type { ValidationIssue } from '~/lib/shotdirector/rules'

export const CAST_MAX = 3
// Identity references sent per cast member: at most two pictures of ONE person
// (portrait + full-body front panel, or the cover alone — see
// videoIdentityRefs). Never the combined sheet grid and never several photos:
// Seedance maps visibly different views/people to distinct subjects, and the
// clause marks the pair as one person.
export const CAST_REF_CAP = 2

export function materializeCast(
  sheet: ShotSheet,
  resolved: Record<string, string[]>,
  profile: ModelProfile,
): { sheet: ShotSheet, issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = []
  const manual = sheet.references.filter(r => !r.castSlug)
  if (!sheet.cast.length) {
    return { sheet: { ...sheet, references: renumber(manual) }, issues }
  }

  const seen = new Set<string>()
  for (const m of sheet.cast) {
    if (seen.has(m.slug)) issues.push({ level: 'error', code: 'cast-duplicate', message: `${m.name} is cast twice.` })
    seen.add(m.slug)
  }
  if (sheet.cast.length > CAST_MAX) {
    issues.push({ level: 'error', code: 'cast-too-many', message: `At most ${CAST_MAX} characters per shot.` })
  }

  const members = sheet.cast.filter((m, i) => sheet.cast.findIndex(x => x.slug === m.slug) === i)
  const manualImages = manual.filter(r => r.kind === 'image').length
  const castImages = members.reduce((n, m) => n + Math.min(CAST_REF_CAP, (resolved[m.slug] ?? []).length), 0)
  if (manualImages + castImages > profile.maxRefImages) {
    issues.push({
      level: 'warning', code: 'cast-refs-squeezed',
      message: `Manual references leave no room in the ${profile.maxRefImages}-image budget for all ${members.length} cast members — remove some manual references.`,
    })
  }

  const castRefs: Ref[] = []
  for (const m of members) {
    // resolved[slug] is videoIdentityRefs order (portrait, body-front) — see useCharacters.
    const srcs = (resolved[m.slug] ?? []).slice(0, CAST_REF_CAP)
    if (!srcs.length) {
      const message = m.stateId
        ? `${m.name} has no reference photos in the selected look — add some to their character sheet.`
        : `${m.name} has no reference photos — add some to their character sheet.`
      issues.push({ level: 'error', code: 'cast-member-no-refs', message })
      continue
    }
    for (const src of srcs) {
      castRefs.push({ kind: 'image', slot: 0, src, role: 'identity-lock', castSlug: m.slug })
    }
  }
  return { sheet: { ...sheet, references: renumber([...castRefs, ...manual]) }, issues }
}

/** Reassign 1-based slots per kind, preserving array order. */
function renumber(refs: Ref[]): Ref[] {
  const counters: Record<string, number> = {}
  return refs.map((r) => {
    counters[r.kind] = (counters[r.kind] ?? 0) + 1
    return { ...r, slot: counters[r.kind]! }
  })
}

/**
 * "Characters: Reva (soaked navy jacket, wet hair) @Image1 @Image2; Marcus @Image3."
 * from cast-tagged refs. `descriptors` (slug → text, from useCharacters().stateDescriptors)
 * is optional — omitted/empty/whitespace-only descriptors fall back to today's plain
 * "Name @ImageN" form, so callers that don't pass it get byte-identical output.
 */
export function castClause(sheet: ShotSheet, profile: ModelProfile, descriptors?: Record<string, string>): string {
  const bySlug = new Map<string, string[]>()
  for (const r of sheet.references) {
    if (r.kind !== 'image' || !r.castSlug) continue
    const tags = bySlug.get(r.castSlug) ?? []
    tags.push(profile.refTag('image', r.slot))
    bySlug.set(r.castSlug, tags)
  }
  if (!bySlug.size) return ''
  // Deliberately follow sheet.cast order (identity source of truth), not reference slot order.
  const parts = sheet.cast
    .filter(m => bySlug.has(m.slug))
    .map((m) => {
      const tagList = bySlug.get(m.slug)!
      const tags = tagList.join(' ') + (tagList.length > 1 ? ' (the same person)' : '')
      const d = descriptors?.[m.slug]?.trim()
      return d ? `${m.name} (${d}) ${tags}` : `${m.name} ${tags}`
    })
  return `Characters: ${parts.join('; ')}.`
}
