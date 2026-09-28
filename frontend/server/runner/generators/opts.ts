/**
 * Python-compatible readers for the per-model `model_options` bag, ported
 * from comfy_api_nodes/image_models.py (_opt_int, _opt_bool, _opt_str,
 * _maybe_set_seed, _ar_or). `adv.get(key, default)` only falls back when the
 * key is MISSING — a present-but-null value goes through the conversion,
 * which is why each reader checks own-property first.
 */
import { pyFloatOf, pyIntOf, pyStrip } from '#shared/runner/pyText'
import { videoOptionText, type VideoOptionTextKey } from '#shared/runner/videoOptionTexts'

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

/**
 * A video option the builder sends as the user's own words: only a key of
 * VIDEO_OPTION_TEXT_KEYS, so moderation reads every such field
 * (#shared/runner/videoOptionTexts). Blank when absent.
 */
export function optText(adv: Record<string, unknown>, key: VideoOptionTextKey): string {
  return videoOptionText(adv, key)
}

export function optStr(adv: Record<string, unknown>, key: string, def: string): string {
  if (!has(adv, key)) return def
  const v = adv[key]
  if (v === null || v === undefined) return def
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

// ── A video request's pictures (final fix F5: one copy for every builder) ──

/** The first frame a video request carries: the linked picture, else `image_url` in the options, else ''. */
export function firstFrame(image: string | null, adv: Record<string, unknown>): string {
  return image || optStr(adv, 'image_url', '')
}

/**
 * True when the options carry reference pictures, videos or sounds (Shot
 * Director's `image_urls`, `video_urls`, `audio_urls`), or, with
 * `lastFrame`, a last frame (`end_image_url`): what a model that starts from
 * one picture at most can't take.
 */
export function hasMediaExtras(adv: Record<string, unknown>, o: { lastFrame: boolean }): boolean {
  if (o.lastFrame && optStr(adv, 'end_image_url', '')) return true
  return ['image_urls', 'video_urls', 'audio_urls'].some(k => Array.isArray(adv[k]) && (adv[k] as unknown[]).length > 0)
}

// ── Schema-bound readers (Task S1b) ──────────────────────────────────────
// The runner's builders follow each provider's published schema (the saved
// copies in tests/unit/fixtures/provider-schemas/), not Python parity: a
// value the schema doesn't allow is never sent. An enum value outside the
// list falls back to the builder's default; a number outside the range is
// clamped to it, the way safety_tolerance and num_outputs always were.

/** optStr, kept only when it is one of `allowed`; otherwise `def`. */
export function optEnum(adv: Record<string, unknown>, key: string, allowed: readonly string[], def: string): string {
  const v = optStr(adv, key, def)
  return allowed.includes(v) ? v : def
}

/** optInt clamped to [lo, hi]. */
export function optIntIn(adv: Record<string, unknown>, key: string, def: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, optInt(adv, key, def)))
}

/** optFloat clamped to [lo, hi]; a value that isn't a finite number is `def`. */
export function optFloatIn(adv: Record<string, unknown>, key: string, def: number, lo: number, hi: number): number {
  const v = optFloat(adv, key, def)
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def
}

/** Replicate's output formats as its schemas spell them; "jpeg" and "jpg" name the same thing. */
export function outputFormatIn(adv: Record<string, unknown>, allowed: readonly string[], def: string): string {
  let v = optStr(adv, 'output_format', def)
  if (v === 'jpg' && !allowed.includes('jpg') && allowed.includes('jpeg')) v = 'jpeg'
  if (v === 'jpeg' && !allowed.includes('jpeg') && allowed.includes('jpg')) v = 'jpg'
  return allowed.includes(v) ? v : def
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
