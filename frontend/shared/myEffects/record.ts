/**
 * A My effect as stored (AI in Sailor spec §7.4). Versions keep the shader
 * BODY (no preamble/helpers) so a later contract fix reaches old effects; a
 * version with `body` changed the code, one without only changed the dials.
 * Shared by /api/my-effects (validation) and the app (expansion to EffectDefs).
 *
 * Dial values here use the RAW `u_`-prefixed uniform names (as the model
 * writes them and as `GenParam.uniform` names them) — unlike `ShaderSpec.params`,
 * which drops the prefix. Anything that moves a value between a My effect
 * record and a `ShaderSpec` must map the key through the prefix.
 */
import { LIMITS, type GenParam } from '../shadergen/contract'

export const MY_EFFECT_ID_RE = /^mine_[a-z0-9]{12}$/
export const MY_EFFECT_LIMITS = { maxEffects: 500, maxVersions: 50, maxNameChars: 60, maxNoteChars: 300 } as const

export type MyEffectValue = number | string
export interface MyEffectVersion {
  label: string
  body?: string
  params?: GenParam[]
  values: Record<string, MyEffectValue>
  note: string
  createdAt: string
}
export interface MyEffectRecord {
  id: string
  name: string
  from: string | null
  animated: boolean
  generative: boolean
  createdAt: string
  updatedAt: string
  versions: MyEffectVersion[]
}

export function newMyEffectId(rand: () => number = Math.random): string {
  let s = ''
  for (let i = 0; i < 12; i++) s += Math.floor(rand() * 36).toString(36)
  return `mine_${s}`
}

export const cleanName = (s: string): string => s.replace(/\s+/g, ' ').trim()

const PARAM_TYPES = new Set(['float', 'enum', 'color'])
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x)
const str = (x: unknown, what: string, max: number): string => {
  if (typeof x !== 'string') throw new Error(`${what} must be text`)
  if (x.length > max) throw new Error(`${what} is too long`)
  return x
}

function cleanParams(x: unknown): GenParam[] {
  if (!Array.isArray(x) || x.length < LIMITS.minParams || x.length > LIMITS.maxParams) throw new Error(`a code version needs ${LIMITS.minParams}–${LIMITS.maxParams} dials`)
  return x.map((p) => {
    if (!isObj(p) || typeof p.uniform !== 'string' || typeof p.label !== 'string' || !PARAM_TYPES.has(p.type)) throw new Error('a dial is malformed')
    if (typeof p.default !== 'number' && typeof p.default !== 'string') throw new Error('a dial is malformed')
    const out: GenParam = { uniform: p.uniform, label: p.label, type: p.type, default: p.default }
    for (const k of ['min', 'max', 'step'] as const) if (typeof p[k] === 'number') out[k] = p[k]
    if (Array.isArray(p.options)) out.options = p.options.filter((o: any) => isObj(o) && typeof o.label === 'string' && typeof o.value === 'number').map((o: any) => ({ label: o.label, value: o.value }))
    return out
  })
}

function cleanValues(x: unknown): Record<string, MyEffectValue> {
  if (!isObj(x)) throw new Error('values must be an object')
  const out: Record<string, MyEffectValue> = {}
  for (const [k, v] of Object.entries(x)) {
    if (typeof v !== 'number' && typeof v !== 'string') throw new Error(`value ${k} must be a number or text`)
    out[k] = v
  }
  return out
}

export function validateMyEffect(x: unknown): MyEffectRecord {
  if (!isObj(x)) throw new Error('not an object')
  if (typeof x.id !== 'string' || !MY_EFFECT_ID_RE.test(x.id)) throw new Error('invalid id')
  const name = cleanName(str(x.name, 'name', 1000))
  if (!name || name.length > MY_EFFECT_LIMITS.maxNameChars) throw new Error(`name must be 1–${MY_EFFECT_LIMITS.maxNameChars} characters`)
  if (!Array.isArray(x.versions) || !x.versions.length || x.versions.length > MY_EFFECT_LIMITS.maxVersions) throw new Error(`versions must be 1–${MY_EFFECT_LIMITS.maxVersions}`)
  const versions: MyEffectVersion[] = x.versions.map((v: unknown, i: number) => {
    if (!isObj(v)) throw new Error('a version is malformed')
    const out: MyEffectVersion = {
      label: str(v.label, 'label', 12),
      values: cleanValues(v.values),
      note: str(v.note ?? '', 'note', MY_EFFECT_LIMITS.maxNoteChars),
      createdAt: str(v.createdAt, 'createdAt', 40),
    }
    if (v.body !== undefined) {
      out.body = str(v.body, 'body', LIMITS.maxBodyChars)
      out.params = cleanParams(v.params)
    } else if (i === 0) throw new Error('the first version must carry code')
    return out
  })
  return {
    id: x.id, name,
    from: x.from == null ? null : str(x.from, 'from', 120),
    animated: !!x.animated, generative: !!x.generative,
    createdAt: str(x.createdAt, 'createdAt', 40), updatedAt: str(x.updatedAt, 'updatedAt', 40),
    versions,
  }
}
