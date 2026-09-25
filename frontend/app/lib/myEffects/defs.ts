/** My effect records ⇄ ordinary EffectDefs (spec §7.4, plan rulings 7, 8, 15). */
import { assembleSource, type GenTake } from '~~/shared/shadergen/contract'
import { MY_EFFECT_ID_RE, type MyEffectRecord } from '~~/shared/myEffects/record'
import type { EffectDef, EffectParamDef, ParamValue } from '~/lib/shaderfx/types'

const VERSION_SUFFIX = /~v\d+$/
export function myEffectIdOf(effectId: string): string | null {
  const id = effectId.replace(VERSION_SUFFIX, '')
  return MY_EFFECT_ID_RE.test(id) ? id : null
}

export function codeIndexFor(rec: MyEffectRecord, i: number): number {
  for (let k = Math.min(i, rec.versions.length - 1); k >= 0; k--) if (rec.versions[k]!.body !== undefined) return k
  return 0
}
const latestCode = (rec: MyEffectRecord) => codeIndexFor(rec, rec.versions.length - 1)

export function effectIdForVersion(rec: MyEffectRecord, i: number): string {
  const c = codeIndexFor(rec, i)
  return c === latestCode(rec) ? rec.id : `${rec.id}~v${c + 1}`
}

const defaultsOf = (params: { uniform: string; default: unknown }[]) =>
  Object.fromEntries(params.map(p => [p.uniform, p.default])) as Record<string, ParamValue>

export function valuesForVersion(rec: MyEffectRecord, i: number): Record<string, ParamValue> {
  const code = rec.versions[codeIndexFor(rec, i)]!
  return { ...defaultsOf(code.params ?? []), ...(rec.versions[i]?.values ?? {}) }
}

export function expandMyEffect(rec: MyEffectRecord): EffectDef[] {
  const newest = latestCode(rec)
  const chips = rec.versions.map((v, i) => ({ label: v.label, note: v.note, effectId: effectIdForVersion(rec, i), values: valuesForVersion(rec, i) }))
  const out: EffectDef[] = []
  rec.versions.forEach((v, i) => {
    if (v.body === undefined) return
    const main = i === newest
    out.push({
      id: main ? rec.id : `${rec.id}~v${i + 1}`,
      name: main ? rec.name : `${rec.name} · ${v.label}`,
      category: 'mine', animated: rec.animated, generative: rec.generative, passes: 1, centerParam: null, textures: [],
      source: assembleSource(v.body),
      params: (v.params ?? []).map(p => ({ ...p }) as EffectParamDef),
      mine: true, from: rec.from, versions: chips,
      ...(main ? {} : { versionOf: rec.id }),
    })
  })
  return [out.find(d => d.id === rec.id)!, ...out.filter(d => d.id !== rec.id).reverse()]
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
export function activeVersionIndex(rec: MyEffectRecord, effectId: string, values: Record<string, ParamValue>): number | null {
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
