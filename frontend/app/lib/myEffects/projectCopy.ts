/** Projects keep a copy of every My effect they use, so a shared project renders without the
 *  owner's library (AI in Sailor spec §7.4; plan rulings 17, 18). Saving writes the copies into
 *  the doc; loading hands them to `useMyEffects().adopt`, which registers them for rendering and
 *  never writes them into anyone's library. Only saved My effects are copied: a draft take's id
 *  (`draft_…`) never matches, and drafts are never in the library. */
import { MY_EFFECT_ID_BODY, type MyEffectRecord } from '~~/shared/myEffects/record'
import type { ProjectDoc } from '~/lib/projectDoc'

/** A My effect reference anywhere in a string — the effect's own id or one of its versions (`~vN`). */
export const MY_EFFECT_REF_RE = new RegExp(`${MY_EFFECT_ID_BODY}(?:~v\\d+)?`, 'g')
const VERSION_SUFFIX = /~v\d+$/

/** Every My effect id the value mentions, versions folded into their effect; unique and sorted.
 *  A doc's own `myEffects` copies are not walked (they are what is being decided). */
export function myEffectIdsIn(x: unknown): string[] {
  const ids = new Set<string>()
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.includes('mine_')) for (const m of v.matchAll(MY_EFFECT_REF_RE)) ids.add(m[0].replace(VERSION_SUFFIX, ''))
      return
    }
    if (Array.isArray(v)) { for (const e of v) walk(e); return }
    if (v && typeof v === 'object') for (const [k, e] of Object.entries(v)) { if (k !== 'myEffects') walk(e) }
  }
  walk(x)
  return [...ids].sort()
}

/** Write the records of every My effect the doc's canvases use into `doc.myEffects` (removing
 *  the field when none are). For each id the library's record is taken unless the doc's existing
 *  copy has more versions — the same rule the live catalog renders by (ruling 17), so what is
 *  saved is what is shown. An effect gone from the library keeps its existing copy.
 *  `libraryEmpty` with no copies in the doc skips the scan: the common case of no My effects. */
export function attachMyEffects(doc: ProjectDoc, lookup: (id: string) => MyEffectRecord | null, o: { libraryEmpty?: boolean } = {}): void {
  if (o.libraryEmpty && !doc.myEffects?.length) return
  const prior = new Map((doc.myEffects ?? []).map(r => [r.id, r]))
  const used = myEffectIdsIn(doc.canvases).flatMap((id) => {
    const lib = lookup(id), old = prior.get(id)
    const pick = lib && (!old || lib.versions.length >= old.versions.length) ? lib : old
    return pick ? [pick] : []
  })
  if (used.length) doc.myEffects = used
  else delete doc.myEffects
}

/** Hand a loaded doc's copies to `adopt` (a doc without any is ignored). */
export function adoptMyEffects(doc: ProjectDoc | null | undefined, adopt: (recs: MyEffectRecord[]) => void): void {
  if (Array.isArray(doc?.myEffects) && doc.myEffects.length) adopt(doc.myEffects)
}
