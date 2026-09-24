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
  // str(None), str([..]) and str({..}) never read as an int (JS String([1]) would be "1").
  if (typeof v !== 'string') return def
  const s = v.trim()
  // int() allows single underscores between digits ("1_0" is 10), as float() does.
  return PY_INT_RE.test(s) ? Number.parseInt(s.replace(/_/g, ''), 10) : def
}

// Python float()'s string grammar: digits with single underscores between
// them, an optional fraction and exponent, or inf / infinity / nan.
const DIGITS = String.raw`\d(?:_?\d)*`
/** Python int(str)'s grammar (base 10): a sign, then digits with single underscores between them. */
export const PY_INT_RE = new RegExp(String.raw`^[+-]?${DIGITS}$`)
const PY_FLOAT_RE = new RegExp(
  String.raw`^[+-]?(?:(?:${DIGITS}(?:\.(?:${DIGITS})?)?|\.${DIGITS})(?:[eE][+-]?${DIGITS})?|inf|infinity|nan)$`, 'i')

/** Python float(str): the string as float() reads it, or null where float() raises. */
function pyFloatOf(s: string): number | null {
  const t = s.trim()
  if (!PY_FLOAT_RE.test(t)) return null
  const lower = t.toLowerCase()
  const neg = lower.startsWith('-')
  const body = lower.replace(/^[+-]/, '')
  if (body === 'nan') return Number.NaN
  if (body === 'inf' || body === 'infinity') return neg ? -Infinity : Infinity
  return Number(t.replace(/_/g, ''))
}

/** _opt_float: a bool is 1 or 0, a number is itself, anything else float(str(v)) or the default. */
export function optFloat(adv: Record<string, unknown>, key: string, def: number): number {
  if (!has(adv, key)) return def
  const v = adv[key]
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  // str(None), str([..]) and str({..}) never read as a float.
  if (typeof v !== 'string') return def
  // Known gap: "inf"/"nan" read as JS Infinity/NaN, which JSON sends as null where Python sends Infinity/NaN; the UI never writes them.
  return pyFloatOf(v) ?? def
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

/**
 * Python str.strip() with no argument: strips what str.isspace() calls space.
 * JS trim() differs: it also strips U+FEFF, and keeps U+001C–U+001F and U+0085.
 */
export function pyStrip(s: string): string {
  return s.replace(/^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '')
}

/** `int(value or 0)` for widget values that are numbers or numeric strings. */
export function asInt(v: unknown, def: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10)
  return def
}

export { pyTruthy }
