/**
 * Cast materialization: turn `sheet.cast` (live registry links) into concrete
 * identity-lock image references, cast-first so [Image1] is always cast
 * member #1. Pure — the caller resolves slugs → ref URLs (useCharacters).
 * Cast-injected refs carry `castSlug`; re-materializing replaces them, so the
 * operation is idempotent and manual refs are preserved and renumbered.
 */
import type { CastBundle, ModelProfile } from '~/lib/shotdirector/profiles'
import type { Ref, ShotSheet } from '~/lib/shotdirector/types'
import type { ValidationIssue } from '~/lib/shotdirector/rules'
import type { IdentityRefSet } from '#shared/characters/types'

export const CAST_MAX = 3
// Identity references sent per cast member: at most two pictures of ONE person
// (portrait + full-body front panel, or the cover alone — see
// videoIdentityRefs). Never the combined sheet grid and never several photos:
// Seedance maps visibly different views/people to distinct subjects, and the
// clause marks the pair as one person. Kept as Seedance's own cap for
// existing importers; `images`-mode materialization now reads
// `profile.castRefCap` instead (Task 1 keeps this exported unchanged).
export const CAST_REF_CAP = 2

/**
 * One cast member's resolved pictures: the current `IdentityRefSet` shape
 * (Task 1's `resolveCastSets`), or a plain already-picked/ordered list of URLs
 * — the shape every caller sent before this task (e.g. VueNodeCanvas's
 * `resolveStateRefs`). Accepting both means those callers keep compiling
 * unchanged until Task 7 rewires them onto `IdentityRefSet`.
 */
export type CastResolved = Record<string, IdentityRefSet | string[]>

function isRefSet(v: IdentityRefSet | string[] | undefined): v is IdentityRefSet {
  return !!v && !Array.isArray(v)
}

/** Ordered pictures for one `images`-mode member: `profile.pickCastRefs` for an
 *  `IdentityRefSet`, or the legacy array as-is (already picked/ordered) — either
 *  way capped to `profile.castRefCap`. */
function imagesModeRefs(value: IdentityRefSet | string[] | undefined, profile: ModelProfile): string[] {
  if (value === undefined) return []
  const picked = isRefSet(value) ? profile.pickCastRefs(value) : value
  return picked.slice(0, profile.castRefCap)
}

/** The front + up to `castRefCap - 1` other pictures for one `elements`-mode member. */
function elementsModeBundle(value: IdentityRefSet | string[] | undefined, profile: ModelProfile): { front: string | null, refs: string[] } {
  if (value === undefined) return { front: null, refs: [] }
  if (isRefSet(value)) {
    const front = value.front ?? null
    const refs = [value.portrait, value.bodyFront, value.bodyBack]
      .filter((r): r is string => !!r && r !== front)
      .slice(0, profile.castRefCap - 1)
    return { front, refs }
  }
  const [front = null, ...rest] = value
  return { front, refs: rest.filter(r => r !== front).slice(0, profile.castRefCap - 1) }
}

/**
 * The pictures of one cast member the model will actually receive, in order:
 * `images` mode → the model's own pick (capped); `elements` mode → the front
 * first, then its other pictures (nothing when there is no front — that
 * member is refused by materializeCast). For showing what a shot sends.
 */
export function castMemberPictures(value: IdentityRefSet | string[] | undefined, profile: ModelProfile): string[] {
  if (profile.castMode === 'elements') {
    const { front, refs } = elementsModeBundle(value, profile)
    return front ? [front, ...refs] : []
  }
  return imagesModeRefs(value, profile)
}

/**
 * True when an `images`-mode model's cast pictures stay out of the request:
 * first/last-frame mode on a model that can't send references beside a first
 * frame (Ruling J). The characters are then named in the prompt without tags.
 */
export function castPicturesLeftOut(sheet: ShotSheet, profile: ModelProfile): boolean {
  return profile.castMode === 'images' && sheet.mode === 'firstLastFrame' && !profile.refsWithFirstFrame
}

/** First/last-frame mode, a cast, no first frame, on a model that can't send references beside one. */
export function castNeedsFirstFrameWords(profile: ModelProfile): string {
  return `${profile.label} films characters here from a first frame. Make one from the cast, upload one, or switch to reference mode.`
}

export function materializeCast(
  sheet: ShotSheet,
  resolved: CastResolved,
  profile: ModelProfile,
): { sheet: ShotSheet, issues: ValidationIssue[], bundles: CastBundle[] } {
  const issues: ValidationIssue[] = []
  const manual = sheet.references.filter(r => !r.castSlug)
  if (!sheet.cast.length) {
    return { sheet: { ...sheet, references: renumber(manual) }, issues, bundles: [] }
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
  const noRefsIssue = (m: (typeof members)[number]) => {
    const message = m.stateId
      ? `${m.name} has no reference photos in the selected look — add some to their character sheet.`
      : `${m.name} has no reference photos — add some to their character sheet.`
    issues.push({ level: 'error', code: 'cast-member-no-refs', message })
  }

  if (profile.castMode === 'elements') {
    // Cast refs are not added to sheet.references at all in `elements` mode —
    // they travel as named elements (bundles) that buildInput wires directly.
    const bundles: CastBundle[] = []
    for (const m of members) {
      const { front, refs } = elementsModeBundle(resolved[m.slug], profile)
      if (!front) { noRefsIssue(m); continue }
      bundles.push({ slug: m.slug, front, refs })
    }
    return { sheet: { ...sheet, references: renumber(manual) }, issues, bundles }
  }

  // Ruling J (stage 3 final fix): a model that can't send references beside a
  // first frame gets NO cast pictures in first/last-frame mode — the made
  // first frame already holds the characters, and castClause names them
  // without picture tags. The rules' first-frame-drops-refs warning says so.
  // With no first frame set, the characters would reach the model as names
  // alone, so that is refused in words instead.
  if (castPicturesLeftOut(sheet, profile)) {
    if (!sheet.firstFrame) {
      issues.push({ level: 'error', code: 'cast-needs-first-frame', message: castNeedsFirstFrameWords(profile) })
    }
    for (const m of members) {
      if (!imagesModeRefs(resolved[m.slug], profile).length) noRefsIssue(m)
    }
    return { sheet: { ...sheet, references: renumber(manual) }, issues, bundles: [] }
  }

  const manualImages = manual.filter(r => r.kind === 'image').length
  const castImages = members.reduce((n, m) => n + imagesModeRefs(resolved[m.slug], profile).length, 0)
  if (manualImages + castImages > profile.maxRefImages) {
    issues.push({
      level: 'warning', code: 'cast-refs-squeezed',
      message: `Manual references leave no room in the ${profile.maxRefImages}-image budget for all ${members.length} cast members — remove some manual references.`,
    })
  }

  const castRefs: Ref[] = []
  for (const m of members) {
    const srcs = imagesModeRefs(resolved[m.slug], profile)
    if (!srcs.length) { noRefsIssue(m); continue }
    for (const src of srcs) {
      castRefs.push({ kind: 'image', slot: 0, src, role: 'identity-lock', castSlug: m.slug })
    }
  }
  return { sheet: { ...sheet, references: renumber([...castRefs, ...manual]) }, issues, bundles: [] }
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
 * from cast-tagged refs (`images` mode), or "Reva (desc) @Element1; Marcus
 * @Element2." from `bundles` in cast order (`elements` mode — cast refs never
 * reach sheet.references there, so `bundles` is the only source of truth).
 * `descriptors` (slug → text, from useCharacters().stateDescriptors) is
 * optional — omitted/empty/whitespace-only descriptors fall back to today's
 * plain "Name @TagN" form, so callers that don't pass it get byte-identical
 * output.
 */
export function castClause(
  sheet: ShotSheet,
  profile: ModelProfile,
  descriptors?: Record<string, string>,
  bundles?: CastBundle[],
): string {
  if (profile.castMode === 'elements') {
    if (!bundles?.length) return ''
    const parts = bundles.map((b, i) => {
      const member = sheet.cast.find(m => m.slug === b.slug)
      const name = member?.name ?? b.slug
      const tag = profile.refTag('image', i + 1)
      const d = descriptors?.[b.slug]?.trim()
      return d ? `${name} (${d}) ${tag}` : `${name} ${tag}`
    })
    return `Characters: ${parts.join('; ')}.`
  }

  // Ruling J: no cast pictures are sent (castPicturesLeftOut), so the cast is
  // named without picture tags — the first frame already shows them.
  if (castPicturesLeftOut(sheet, profile)) {
    if (!sheet.cast.length) return ''
    const seen = new Set<string>()
    const parts = sheet.cast
      .filter(m => !seen.has(m.slug) && seen.add(m.slug))
      .map((m) => {
        const d = descriptors?.[m.slug]?.trim()
        return d ? `${m.name} (${d})` : m.name
      })
    return `Characters: ${parts.join('; ')}.`
  }

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
