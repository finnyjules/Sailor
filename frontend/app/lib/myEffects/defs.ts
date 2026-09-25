/** My effect records ⇄ ordinary EffectDefs (spec §7.4, plan rulings 7, 8, 15). */
import { assembleSource, type GenTake } from '~~/shared/shadergen/contract'
import { MY_EFFECT_ID_RE, type MyEffectRecord } from '~~/shared/myEffects/record'
import type { EffectDef, EffectParamDef, ParamValue } from '~/lib/shaderfx/types'

const VERSION_SUFFIX = /~v\d+$/
export function myEffectIdOf(effectId: string): string | null {
  const id = effectId.replace(VERSION_SUFFIX, '')
  return MY_EFFECT_ID_RE.test(id) ? id : null
}

/** Every code version has its own explicit id, `<id>~vN` — the newest included (final review
 *  #2, Ruling #2): a target stores the version it was given, so adding a version to a My effect
 *  never changes what any other node, layer, background, project copy or export renders. The
 *  bare id is only a picker alias for the newest version (the gallery lists that version's def,
 *  so a pick writes its explicit id); a STORED bare id, from before versions were pinned, reads
 *  as version 1 — `expandMyEffect` registers it as a hidden copy of v1. */
export const versionEffectId = (id: string, codeIndex: number): string => `${id}~v${codeIndex + 1}`

/** The version a stored effect id renders: a bare My effect id is version 1; anything else as is. */
export function storedEffectId(effectId: string): string {
  const id = myEffectIdOf(effectId)
  return id && id === effectId ? versionEffectId(id, 0) : effectId
}

/** The picker's entry for `effectId` among `effects`: for a My effect (any version, or the bare
 *  id) its one pickable def — the newest version — so the gallery's Current badge and initial
 *  focus find the effect whichever version the target is pinned to. Anything else as is. */
export function pickableIdFor(effectId: string, effects: readonly EffectDef[]): string {
  const id = myEffectIdOf(effectId)
  if (!id) return effectId
  return effects.find(d => isPickable(d) && myEffectIdOf(d.id) === id)?.id ?? effectId
}

export function codeIndexFor(rec: MyEffectRecord, i: number): number {
  for (let k = Math.min(i, rec.versions.length - 1); k >= 0; k--) if (rec.versions[k]!.body !== undefined) return k
  return 0
}
const latestCode = (rec: MyEffectRecord) => codeIndexFor(rec, rec.versions.length - 1)

/** The explicit id of the code version that version `i` (a code or a dial version) renders with. */
export function effectIdForVersion(rec: MyEffectRecord, i: number): string {
  return versionEffectId(rec.id, codeIndexFor(rec, i))
}

/** The newest code version's id: what the bare id stands for in a picker. */
export const newestEffectId = (rec: MyEffectRecord): string => versionEffectId(rec.id, latestCode(rec))

const defaultsOf = (params: { uniform: string; default: unknown }[]) =>
  Object.fromEntries(params.map(p => [p.uniform, p.default])) as Record<string, ParamValue>

export function valuesForVersion(rec: MyEffectRecord, i: number): Record<string, ParamValue> {
  const code = rec.versions[codeIndexFor(rec, i)]!
  return { ...defaultsOf(code.params ?? []), ...(rec.versions[i]?.values ?? {}) }
}

/** One EffectDef per code version, each under its own `~vN` id. The newest is the pickable one
 *  (the effect's own name, no `versionOf`); older ones carry `versionOf` and a "· vN" name. Last,
 *  the bare id: a hidden copy of v1, so a target stored before pinning keeps what it showed. */
export function expandMyEffect(rec: MyEffectRecord): EffectDef[] {
  const newest = latestCode(rec)
  const chips = rec.versions.map((v, i) => ({ label: v.label, note: v.note, effectId: effectIdForVersion(rec, i), values: valuesForVersion(rec, i) }))
  const out: EffectDef[] = []
  rec.versions.forEach((v, i) => {
    if (v.body === undefined) return
    const main = i === newest
    out.push({
      id: versionEffectId(rec.id, i),
      name: main ? rec.name : `${rec.name} · ${v.label}`,
      category: 'mine', animated: rec.animated, generative: rec.generative, passes: 1, centerParam: null, textures: [],
      source: assembleSource(v.body),
      params: (v.params ?? []).map(p => ({ ...p }) as EffectParamDef),
      mine: true, from: rec.from, versions: chips,
      ...(main ? {} : { versionOf: rec.id }),
    })
  })
  const main = out.find(d => !d.versionOf)!
  const legacy: EffectDef = { ...out[0]!, id: rec.id, params: out[0]!.params.map(p => ({ ...p })), versionOf: rec.id }
  return [main, ...out.filter(d => d !== main).reverse(), legacy]
}

const same = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (a[k] !== b[k]) return false
  return true
}

/**
 * The newest version whose id is `effectId` and whose full values (defaults
 * filled in from that code version's params, then overlaid with `values`)
 * match that version's own stored values. Filling `values` against the
 * effect's own defaults first (ruling C11) means a caller passing `{}`, or
 * only the dials it changed, only matches a version whose OTHER dials still
 * sit at their defaults — it can't fall through to "newest" by default.
 */
export function activeVersionIndex(rec: MyEffectRecord, stored: string, values: Record<string, ParamValue>): number | null {
  const effectId = storedEffectId(stored)
  let codeIdx = -1
  for (let i = rec.versions.length - 1; i >= 0; i--) {
    if (effectIdForVersion(rec, i) === effectId) { codeIdx = codeIndexFor(rec, i); break }
  }
  if (codeIdx < 0) return null
  const target = { ...defaultsOf(rec.versions[codeIdx]!.params ?? []), ...values }
  for (let i = rec.versions.length - 1; i >= 0; i--) {
    if (effectIdForVersion(rec, i) !== effectId) continue
    if (same(valuesForVersion(rec, i), target)) return i
  }
  return null
}

export function recordFromTake(take: GenTake, o: { id: string; request: string; from: string | null; now: string }): MyEffectRecord {
  return {
    id: o.id, name: take.name.trim().slice(0, 60) || 'My effect', from: o.from, animated: take.animated, generative: take.generative,
    createdAt: o.now, updatedAt: o.now,
    versions: [{ label: 'v1', body: take.body, params: take.params, values: defaultsOf(take.params) as Record<string, string | number>, note: o.request.slice(0, 300), createdAt: o.now }],
  }
}

export function withCodeVersion(rec: MyEffectRecord, take: GenTake, o: { request: string; now: string }): MyEffectRecord {
  const label = `v${rec.versions.length + 1}`
  return {
    ...rec, animated: take.animated, generative: take.generative, updatedAt: o.now,
    versions: [...rec.versions, { label, body: take.body, params: take.params, values: defaultsOf(take.params) as Record<string, string | number>, note: o.request.slice(0, 300), createdAt: o.now }],
  }
}

export function withValuesVersion(rec: MyEffectRecord, values: Record<string, ParamValue>, o: { request: string; now: string }): MyEffectRecord | null {
  const last = rec.versions.length - 1
  const cur = valuesForVersion(rec, last)
  const next = { ...cur, ...values }
  if (same(cur, next)) return null
  const plain = Object.fromEntries(Object.entries(next).filter(([, v]) => typeof v === 'number' || typeof v === 'string')) as Record<string, string | number>
  return { ...rec, updatedAt: o.now, versions: [...rec.versions, { label: `v${rec.versions.length + 1}`, values: plain, note: o.request.slice(0, 300), createdAt: o.now }] }
}

export const isPickable = (def: EffectDef): boolean => !def.draft && !def.versionOf
