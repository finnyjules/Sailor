/**
 * Python-compatible readers for the per-model `model_options` bag, ported
 * from comfy_api_nodes/image_models.py (_opt_int, _opt_bool, _opt_str,
 * _maybe_set_seed, _ar_or). `adv.get(key, default)` only falls back when the
 * key is MISSING — a present-but-null value goes through the conversion,
 * which is why each reader checks own-property first.
 */
import { pyFloatOf, pyIntOf, pyStrip } from '#shared/runner/pyText'

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
  // int() strips its own blanks (not trim()'s) and allows single underscores
  // between digits ("1_0" is 10). One grammar, shared with eligibility's optionInt.
  return pyIntOf(v) ?? def
}

// Python float(str) lives in shared/runner/pyText.ts (the Compositor's
// eligibility reads it too); re-exported here for the generators.
export { pyFloatOf }

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
 * It lives in #shared/runner/pyText, so the browser reads text the same way.
 */
export { pyStrip }

/** `int(value or 0)` for widget values that are numbers or numeric strings (read as int() reads them). */
export function asInt(v: unknown, def: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string') return pyIntOf(v) ?? def
  return def
}

/**
 * A text widget: missing is its default, text is itself. Anything else (a
 * number, say) fails the node: the canvas always writes text, and the runner
 * will not guess what anything else meant. `label` names it in the error.
 */
export function textSetting(inputs: Record<string, unknown>, name: string, def: string, label: string): string {
  const v = inputs[name]
  if (v === undefined) return def
  if (typeof v !== 'string') throw new Error(`The ${label} must be text`)
  return v
}

export { pyTruthy }
