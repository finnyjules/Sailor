/**
 * JSON text written the way Python's `json.dumps(value)` and
 * `json.dump(value, f, indent=2)` write it, so the files Sailor writes natively
 * are byte-identical to the ones ComfyUI's Python wrote into the same folders:
 *
 * - ensure_ascii: every character outside printable ASCII is a lowercase
 *   `\uXXXX` escape (astral characters as a surrogate pair, DEL included);
 * - separators: `", "` and `": "` compact, `","` and `": "` with an indent;
 * - floats in Python's repr: `1e-05`, `1e+16`, shortest round-trip digits.
 *
 * One thing JSON.parse cannot keep: Python's `2.0` (a float with no
 * fraction) reads back as the JS number 2 and is written as `2`. The same
 * ambiguity holds for every integer-valued number beyond 2^53 (every double
 * that large IS integer-valued — IEEE754 has no fractional bits left up
 * there): JS can't tell a huge Python int from a huge Python float with no
 * fraction, so up to 1e21 (where JS itself would switch to exponential) this
 * module assumes int, matching Sailor's own records (ids, timestamps — never
 * huge floats). Only >=1e21 falls through to float notation.
 */

const SHORT_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
}

function pyString(s: string, ensureAscii: boolean): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    const code = s.charCodeAt(i)
    const short = SHORT_ESCAPES[ch]
    if (short) out += short
    else if (code < 0x20 || (ensureAscii && code > 0x7E)) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `${out}"`
}

/** Python's float repr: shortest digits, exponent form outside 1e-4 <= |x| < 1e16. */
function pyFloat(n: number): string {
  if (Number.isNaN(n)) return 'NaN'
  if (n === Infinity) return 'Infinity'
  if (n === -Infinity) return '-Infinity'
  const [mantissa, expText] = n.toExponential().split('e') as [string, string]
  const exp = Number(expText)
  if (exp < -4 || exp >= 16) {
    const sign = exp < 0 ? '-' : '+'
    return `${mantissa}e${sign}${String(Math.abs(exp)).padStart(2, '0')}`
  }
  const neg = mantissa.startsWith('-')
  const digits = mantissa.replace('-', '').replace('.', '')
  let fixed: string
  if (exp >= 0) {
    const intPart = digits.slice(0, exp + 1).padEnd(exp + 1, '0')
    const frac = digits.slice(exp + 1)
    fixed = `${intPart}.${frac || '0'}`
  }
  else {
    fixed = `0.${'0'.repeat(-exp - 1)}${digits}`
  }
  return neg ? `-${fixed}` : fixed
}

function pyNumber(n: number): string {
  // JSON.parse cannot tell Python's int from float; a safe integer was an int.
  if (Number.isSafeInteger(n)) return String(n)
  // Beyond 2^53 a double can still hold an exact integer value (up to 1e21,
  // where JS itself switches to exponential notation). Python's json.dumps
  // prints such an int with its full decimal digits, not float notation
  // (`9007199254740994`, not `9007199254740994.0`). `String(n)` already gives
  // exactly that: JS's own number-to-string conversion is the shortest
  // decimal that round-trips back to the same double, written in plain
  // (non-exponential) form for |n| < 1e21 — the same digits Python's own
  // json.loads(file).__repr__ would have produced from that double, and (for
  // the common case of a value that survived a Python int -> JS double ->
  // JS int round trip, e.g. 12345678901234567000) the same digits the
  // original Python int was. `BigInt(n).toString()` looks tempting here but
  // is wrong: it prints the double's exact binary value, which for a value
  // like 12345678901234567000 is 12345678901234567168 — more digits of
  // spurious precision, not fewer, and not what Python wrote. (The old
  // `Object.is(n, -0)` branch here was dead: Number.isSafeInteger(-0) is
  // true, and String(-0) === '0', so the branch above already returns '0'
  // for -0 — removing this one changes nothing.)
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n)
  return pyFloat(n)
}

/** Python's `json.dumps(..., separators=...)` pair: `(item separator, key separator)`. */
export interface PyDumpsOptions {
  /** `ensure_ascii` (default true): escape every character outside printable ASCII. */
  ensureAscii?: boolean
  /** Non-indented item/key separators. Python's own default is `(', ', ': ')`, same as this module's. */
  separators?: [string, string]
}

function encode(value: unknown, indent: number | undefined, level: number, opts: Required<PyDumpsOptions>): string | undefined {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') return pyNumber(value)
  if (typeof value === 'string') return pyString(value, opts.ensureAscii)
  if (typeof value === 'bigint') return value.toString()
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  const toJSON = (value as { toJSON?: () => unknown }).toJSON
  if (typeof toJSON === 'function') return encode(toJSON.call(value), indent, level, opts)

  const inner = indent === undefined ? '' : `\n${' '.repeat(indent * (level + 1))}`
  const outer = indent === undefined ? '' : `\n${' '.repeat(indent * level)}`
  // Python: when `indent` is given and `separators` is NOT explicitly passed,
  // the item separator defaults to ',' instead of ', ' (no need for the
  // trailing space once each item starts its own line). This module's two
  // callers never combine an explicit `separators` with an `indent`, so
  // deriving it from the no-indent default here (rather than threading a
  // third "was separators explicit" flag through) matches both of them.
  const [rawItemSep, kvSep] = opts.separators
  const itemSep = indent === undefined ? rawItemSep : rawItemSep.trimEnd()

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map(v => encode(v, indent, level + 1, opts) ?? 'null')
    return `[${inner}${items.join(itemSep + inner)}${outer}]`
  }
  const parts: string[] = []
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const text = encode(v, indent, level + 1, opts)
    if (text !== undefined) parts.push(`${pyString(k, opts.ensureAscii)}${kvSep}${text}`)
  }
  if (parts.length === 0) return '{}'
  return `{${inner}${parts.join(itemSep + inner)}${outer}}`
}

/** `json.dumps(value)` (no indent) or `json.dumps(value, indent=n)`. */
export function pyDumps(value: unknown, indent?: number, options: PyDumpsOptions = {}): string {
  const opts: Required<PyDumpsOptions> = { ensureAscii: options.ensureAscii ?? true, separators: options.separators ?? [', ', ': '] }
  return encode(value, indent, 0, opts) ?? 'null'
}
