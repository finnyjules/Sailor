/**
 * Python-compatible readers for the per-model `model_options` bag, ported
 * from comfy_api_nodes/image_models.py (_opt_int, _opt_bool, _opt_str,
 * _maybe_set_seed, _ar_or). `adv.get(key, default)` only falls back when the
 * key is MISSING — a present-but-null value goes through the conversion,
 * which is why each reader checks own-property first.
 */
const has = (adv: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(adv, key)

function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v.length > 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return Boolean(v)
}

export function optInt(adv: Record<string, unknown>, key: string, def: number): number {
  if (!has(adv, key)) return def
  const v = adv[key]
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : def
  if (v === null || v === undefined) return def
  const s = String(v).trim()
  return /^[+-]?\d+$/.test(s) ? Number.parseInt(s, 10) : def
}

export function optBool(adv: Record<string, unknown>, key: string, def: boolean): boolean {
  if (!has(adv, key)) return def
  const v = adv[key]
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return ['true', '1', 'yes', 'on'].includes(v.toLowerCase())
  return pyTruthy(v)
}

export function optStr(adv: Record<string, unknown>, key: string, def: string): string {
  if (!has(adv, key)) return def
  const v = adv[key]
  if (v === null || v === undefined) return def
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

export function maybeSetSeed(inp: Record<string, unknown>, seed: number): void {
  if (seed && seed > 0) inp.seed = seed
}

export function arOr(allowed: ReadonlySet<string>, ar: string, fallback: string): string {
  return allowed.has(ar) ? ar : fallback
}

/** `json.loads(model_options or "{}")`, tolerant like GenerateImageNode. */
export function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

export function asText(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** `int(value or 0)` for widget values that are numbers or numeric strings. */
export function asInt(v: unknown, def: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10)
  return def
}

export { pyTruthy }
