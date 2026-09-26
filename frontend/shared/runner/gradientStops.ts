/**
 * The colour text of the gradient effects, read as Python reads it
 * (comfy_extras/_gradient_map.py:24-81, and nodes_glsl_unicorn.py:28-38
 * `_hex_to_rgb`): hex colours, the Gradient map's stops and the Duotone's
 * pair. Shared by the runner (step 3, R2.4: the effects' cores take the
 * parsed colours) and, later, the inspector.
 *
 * JSON is read with JSON.parse, which agrees with Python's json.loads except
 * where json.loads also reads NaN / Infinity, keeps an integer apart from a
 * float (`1` against `1.0`, which str() writes differently) and refuses
 * integers of more than 4,300 digits. Text where that could matter is left to
 * the engine (`*TextIsPortable`, checked at eligibility), as the Moodboard
 * reading is (shared/taste/moodboardStyle.ts).
 */
import { pyFloatOf, pyNumStrip, pyStrip } from './pyText'

export type Rgb = readonly [number, number, number]
export type GradientStop = readonly [number, Rgb]

/** DEFAULT_STOPS: a dark-blue to warm-white ramp. */
export const DEFAULT_STOPS: readonly GradientStop[] = [[0, [0.05, 0.05, 0.2]], [1, [1, 0.9, 0.5]]]
/** DEFAULT_DUOTONE: (shadow, highlight). */
export const DEFAULT_DUOTONE: readonly [string, string] = ['#1a1a2e', '#f5f5f5']

/** One hex pair as int(pair, 16) reads it (blanks around, a sign, underscores between digits), or null where int() raises. */
function hexByte(pair: string): number | null {
  const t = pyNumStrip(pair)
  return /^[+-]?[0-9a-f](?:_?[0-9a-f])*$/i.test(t) ? Number.parseInt(t.replace(/_/g, ''), 16) : null
}

/**
 * hex_to_rgb / _hex_to_rgb: '#rrggbb' or 'rgb' (blanks stripped, any
 * leading '#'s dropped) as three floats in [0, 1] (a signed pair such as
 * '-1' gives a negative one, as int() does), or `fallback` when it isn't.
 * Exact for ASCII text; eligibility leaves any other to the engine
 * (hexTextIsPortable), since int() also reads other scripts' digits.
 */
export function hexToRgb<F>(h: string, fallback: F): Rgb | F {
  let s = Array.from(pyStrip(h).replace(/^#+/, ''))
  if (s.length === 3) s = s.flatMap(c => [c, c])
  if (s.length !== 6) return fallback
  const r = hexByte(s[0]! + s[1]!)
  const g = hexByte(s[2]! + s[3]!)
  const b = hexByte(s[4]! + s[5]!)
  if (r === null || g === null || b === null) return fallback
  return [r / 255, g / 255, b / 255]
}

/**
 * str() of a parsed JSON value where hex_to_rgb reads it: text as it is;
 * True / False / None; a list or a dict as a stand-in that, like its repr
 * (which starts with '[' or '{'), is never a colour. A number's str()
 * depends on whether json.loads made it an int or a float, which JSON.parse
 * doesn't keep: eligibility leaves a number colour to the engine.
 */
function pyStrOfJson(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (v === null || v === undefined) return 'None'
  if (Array.isArray(v)) return '['
  if (typeof v === 'object') return '{'
  return String(v)
}

const isDict = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const has = (d: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(d, k)

/** _coerce: text read as JSON (null where it can't be); anything else as it is. */
function coerce(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) }
  catch { return null }
}

/** float(v) for a parsed JSON value, or null where float() raises a TypeError / ValueError. */
function pyFloatOfJson(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') return pyFloatOf(v)
  return null
}

/**
 * parse_stops: the JSON list of {pos, color} as sorted (pos, rgb) pairs.
 * An entry that isn't a dict, lacks `pos` or `color`, has a `pos` float()
 * refuses or a colour that isn't one is skipped; `pos` is held to [0, 1]
 * (`min(1.0, max(0.0, pos))`, so NaN gives 0); the default ramp when the
 * text isn't a non-empty list or nothing is left. The sort is stable, as
 * Python's.
 */
export function parseStops(raw: unknown): GradientStop[] {
  const data = coerce(raw)
  if (!Array.isArray(data) || data.length === 0) return DEFAULT_STOPS.map(s => [s[0], s[1]])
  const out: GradientStop[] = []
  for (const s of data) {
    if (!isDict(s) || !has(s, 'pos')) continue
    const pos = pyFloatOfJson(s.pos)
    if (pos === null || !has(s, 'color')) continue
    const rgb = hexToRgb(pyStrOfJson(s.color), null)
    if (rgb === null) continue
    const low = pos > 0 ? pos : 0
    out.push([low < 1 ? low : 1, rgb])
  }
  if (!out.length) return DEFAULT_STOPS.map(s => [s[0], s[1]])
  return out.sort((a, b) => a[0] - b[0])
}

/** parse_duotone: a JSON dict's `shadow` and `highlight` (str() of each; the default where absent), or the default pair. */
export function parseDuotone(raw: unknown): [string, string] {
  const data = coerce(raw)
  if (!isDict(data)) return [DEFAULT_DUOTONE[0], DEFAULT_DUOTONE[1]]
  return [
    has(data, 'shadow') ? pyStrOfJson(data.shadow) : DEFAULT_DUOTONE[0],
    has(data, 'highlight') ? pyStrOfJson(data.highlight) : DEFAULT_DUOTONE[1],
  ]
}

// ── What the runner reads as Python does (eligibility) ───────────────────────

const ascii = (s: string) => /^[\x00-\x7f]*$/.test(s)

/** A colour widget the runner reads exactly as _hex_to_rgb does: text, ASCII once stripped. */
export function hexTextIsPortable(v: unknown): boolean {
  return typeof v === 'string' && ascii(pyStrip(v))
}

/**
 * JSON text JSON.parse reads as json.loads does, or both refuse: not a
 * refusal that mentions NaN / Infinity (json.loads reads those), and no
 * run of 300 digits (an integer float() overflows on, or json.loads refuses).
 */
function jsonReadsAlike(text: string): { ok: boolean; value: unknown } {
  if (/\d{300}/.test(text)) return { ok: false, value: null }
  try { return { ok: true, value: JSON.parse(text) } }
  catch { return { ok: !/NaN|Infinity/.test(text), value: null } }
}

/** A colour value parse_stops / parse_duotone reads exactly here: not a number, and ASCII text once stripped. */
const colourIsPortable = (v: unknown) => typeof v !== 'number' && (typeof v !== 'string' || ascii(pyStrip(v)))

/**
 * A Gradient map `stops` the runner reads exactly as parse_stops: text JSON
 * reads alike, each entry's `pos` a finite number or ASCII text, and each
 * `color` a portable colour.
 */
export function stopsTextIsPortable(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const { ok, value } = jsonReadsAlike(v)
  if (!ok) return false
  if (!Array.isArray(value)) return true
  return value.every((s) => {
    if (!isDict(s)) return true
    if (has(s, 'pos') && ((typeof s.pos === 'number' && !Number.isFinite(s.pos)) || (typeof s.pos === 'string' && !ascii(s.pos)))) return false
    return !has(s, 'color') || colourIsPortable(s.color)
  })
}

/** A Duotone `duotone` the runner reads exactly as parse_duotone: text JSON reads alike, with portable colours. */
export function duotoneTextIsPortable(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const { ok, value } = jsonReadsAlike(v)
  if (!ok) return false
  if (!isDict(value)) return true
  return (!has(value, 'shadow') || colourIsPortable(value.shadow)) && (!has(value, 'highlight') || colourIsPortable(value.highlight))
}
