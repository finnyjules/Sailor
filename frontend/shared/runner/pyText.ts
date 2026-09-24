/**
 * How Python reads text, for the readers the browser (eligibility) and the
 * server (runner generators) share, so both sides agree on one grammar.
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
