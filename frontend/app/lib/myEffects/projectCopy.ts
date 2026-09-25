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

/** Every My effect the value mentions, with the highest code version it uses (a bare id is v1:
 *  a stored bare id reads as version 1). A doc's own `myEffects` copies are not walked (they are
 *  what is being decided). */
export function myEffectVersionsIn(x: unknown): Map<string, number> {
  const used = new Map<string, number>()
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.includes('mine_')) {
        for (const m of v.matchAll(MY_EFFECT_REF_RE)) {
          const id = m[0].replace(VERSION_SUFFIX, '')
          const n = Number(/~v(\d+)$/.exec(m[0])?.[1] ?? 1)
          used.set(id, Math.max(used.get(id) ?? 0, n))
        }
      }
      return
    }
    if (Array.isArray(v)) { for (const e of v) walk(e); return }
    if (v && typeof v === 'object') for (const [k, e] of Object.entries(v)) { if (k !== 'myEffects') walk(e) }
  }
  walk(x)
  return used
}

/** Every My effect id the value mentions, versions folded into their effect; unique and sorted. */
export function myEffectIdsIn(x: unknown): string[] {
  return [...myEffectVersionsIn(x).keys()].sort()
}

/** True when `rec` still holds code version `n` (1-based) — what a target pinned to `~vN` renders. */
const holds = (rec: MyEffectRecord, n: number): boolean => rec.versions[n - 1]?.body !== undefined

/** Write the records of every My effect the doc's canvases use into `doc.myEffects` (removing
 *  the field when none are). Every target is pinned to one code version (`~vN`), so the copy kept
 *  is one that holds every version the doc actually uses. Between the library's record and the
 *  doc's existing copy, the library's is taken unless the doc's copy has more versions — the same
 *  rule the live catalog renders by (ruling 17), so what is saved is what is shown — or unless
 *  only the doc's copy holds a used version. An effect gone from the library keeps its copy.
 *  `libraryEmpty` with no copies in the doc skips the scan: the common case of no My effects. */
export function attachMyEffects(doc: ProjectDoc, lookup: (id: string) => MyEffectRecord | null, o: { libraryEmpty?: boolean } = {}): void {
  if (o.libraryEmpty && !doc.myEffects?.length) return
  const prior = new Map((doc.myEffects ?? []).map(r => [r.id, r]))
  const used = [...myEffectVersionsIn(doc.canvases)].sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([id, n]) => {
    const lib = lookup(id), old = prior.get(id)
    const libOk = !!lib && holds(lib, n), oldOk = !!old && holds(old, n)
    let pick: MyEffectRecord | null | undefined
    if (libOk && oldOk) pick = lib!.versions.length >= old!.versions.length ? lib : old
    else if (libOk || oldOk) pick = libOk ? lib : old
    else pick = lib && (!old || lib.versions.length >= old.versions.length) ? lib : old
    return pick ? [pick] : []
  })
  if (used.length) doc.myEffects = used
  else delete doc.myEffects
}

/** Hand a loaded doc's copies to `adopt` (a doc without any is ignored). */
export function adoptMyEffects(doc: ProjectDoc | null | undefined, adopt: (recs: MyEffectRecord[]) => void): void {
  if (Array.isArray(doc?.myEffects) && doc.myEffects.length) adopt(doc.myEffects)
}
