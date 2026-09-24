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
 * fraction) reads back as the JS number 2 and is written as `2`. Integers above
 * 2^53 lose precision the same way. Neither occurs in Sailor's own records.
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

function pyString(s: string): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    const code = s.charCodeAt(i)
    const short = SHORT_ESCAPES[ch]
    if (short) out += short
    else if (code < 0x20 || code > 0x7E) out += `\\u${code.toString(16).padStart(4, '0')}`
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
  if (Object.is(n, -0)) return '0'
  return pyFloat(n)
}

function encode(value: unknown, indent: number | undefined, level: number): string | undefined {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') return pyNumber(value)
  if (typeof value === 'string') return pyString(value)
  if (typeof value === 'bigint') return value.toString()
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  const toJSON = (value as { toJSON?: () => unknown }).toJSON
  if (typeof toJSON === 'function') return encode(toJSON.call(value), indent, level)

  const inner = indent === undefined ? '' : `\n${' '.repeat(indent * (level + 1))}`
  const outer = indent === undefined ? '' : `\n${' '.repeat(indent * level)}`
  const itemSep = indent === undefined ? ', ' : ','

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map(v => encode(v, indent, level + 1) ?? 'null')
    return `[${inner}${items.join(itemSep + inner)}${outer}]`
  }
  const parts: string[] = []
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const text = encode(v, indent, level + 1)
    if (text !== undefined) parts.push(`${pyString(k)}: ${text}`)
  }
  if (parts.length === 0) return '{}'
  return `{${inner}${parts.join(itemSep + inner)}${outer}}`
}

/** `json.dumps(value)` (no indent) or `json.dumps(value, indent=n)`. */
export function pyDumps(value: unknown, indent?: number): string {
  return encode(value, indent, 0) ?? 'null'
}
