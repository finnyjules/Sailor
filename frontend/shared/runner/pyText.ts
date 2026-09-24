/**
 * How Python reads text, for the readers the browser (eligibility) and the
 * server (runner generators) share, so both sides agree on one grammar.
 * Also Python's `%`, which the generators' angle buckets need.
 */

// Python str.isspace(): the ASCII blanks, U+001C–U+001F, and the Unicode
// spaces. JS \s differs: it takes U+FEFF and leaves out U+001C–U+001F and U+0085.
const UNICODE_SPACE = String.raw`\x85\xa0  -     　`
const STR_SPACE = String.raw`\t\n\v\f\r\x1c-\x1f ${UNICODE_SPACE}`
// int() and float() strip less than str.strip(): U+001C–U+001F are not blank
// to them (int('\x1c7') raises, while '\x1c7'.strip() is '7').
const NUM_SPACE = String.raw`\t\n\v\f\r ${UNICODE_SPACE}`

const STRIP_RE = new RegExp(`^[${STR_SPACE}]+|[${STR_SPACE}]+$`, 'g')
const NUM_STRIP_RE = new RegExp(`^[${NUM_SPACE}]+|[${NUM_SPACE}]+$`, 'g')

/** Python str.strip() with no argument. */
export function pyStrip(s: string): string {
  return s.replace(STRIP_RE, '')
}

/** The blanks Python's int() and float() ignore around a number. */
export function pyNumStrip(s: string): string {
  return s.replace(NUM_STRIP_RE, '')
}

/** Python int(str)'s grammar (base 10), once stripped: a sign, then digits with single underscores between them. */
export const PY_INT_RE = /^[+-]?\d(?:_?\d)*$/

/** Python int(str) (base 10), or null where int() raises. */
export function pyIntOf(s: string): number | null {
  const t = pyNumStrip(s)
  return PY_INT_RE.test(t) ? Number.parseInt(t.replace(/_/g, ''), 10) : null
}

// Python float()'s string grammar: digits with single underscores between
// them, an optional fraction and exponent, or inf / infinity / nan.
const DIGITS = String.raw`\d(?:_?\d)*`
const PY_FLOAT_RE = new RegExp(
  String.raw`^[+-]?(?:(?:${DIGITS}(?:\.(?:${DIGITS})?)?|\.${DIGITS})(?:[eE][+-]?${DIGITS})?|inf|infinity|nan)$`, 'i')

/** Python float(str): the string as float() reads it, or null where float() raises. */
export function pyFloatOf(s: string): number | null {
  const t = pyNumStrip(s)
  if (!PY_FLOAT_RE.test(t)) return null
  const lower = t.toLowerCase()
  const neg = lower.startsWith('-')
  const body = lower.replace(/^[+-]/, '')
  if (body === 'nan') return Number.NaN
  if (body === 'inf' || body === 'infinity') return neg ? -Infinity : Infinity
  return Number(t.replace(/_/g, ''))
}

/** Python bool(v) for a JSON value: 0, "", [], {} and null are false; NaN is true. */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v.length > 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return Boolean(v)
}

/** Python's float `%`: fmod, then moved to the divisor's sign (`-1 % 360` is 359). */
export function pyMod(a: number, n: number): number {
  const r = a % n
  return r !== 0 && (r < 0) !== (n < 0) ? r + n : r
}
