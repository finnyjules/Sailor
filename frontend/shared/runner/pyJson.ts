/**
 * JSON as Python's `json` module reads and writes it (R3.1, step 3), so a
 * value a paid node hands on is byte-identical to the STRING its Python node
 * returns: `json.dumps(json.loads(body))`, and `str()` of a scalar answer.
 *
 * What JSON.parse loses and Python keeps: an integer lexeme stays an int of
 * any size (`{ int }`), a lexeme with '.', 'e' or 'E' is a float even when
 * whole (`1.0` prints back as `1.0`, `1e5` as `100000.0`), NaN / Infinity /
 * -Infinity are read, and a repeated key keeps its first place with its last
 * value (a dict's insertion order). Written with json.dumps's defaults:
 * ensure_ascii (every UTF-16 unit outside ' '…'~' escaped as \uxxxx, so an
 * astral character is a surrogate pair), separators ', ' and ': ', floats by
 * repr. The grammar is CPython's C scanner's (strict=True): ASCII digits and
 * the four JSON blanks only, no control character inside a string, no BOM.
 * Pure: shared by the server and its tests.
 */

export type PyJson = null | boolean | string | { int: string } | { float: number } | PyJson[] | { obj: [string, PyJson][] }

/** What `pyStr` throws on a list or a dict: the answer isn't the text the node expects. */
export const PY_STR_UNREADABLE = 'The model answered in a form Sailor can’t read'

/** CPython's int() refuses a number written with more digits than this (sys.get_int_max_str_digits()). */
const PY_INT_MAX_STR_DIGITS = 4300

class PyJsonError extends Error {
  constructor(what: string, at: number) {
    super(`${what} at character ${at}`)
    this.name = 'PyJsonError'
  }
}

const isBlank = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d
const isDigit = (c: number) => c >= 0x30 && c <= 0x39

/** Python's json.loads: an integer lexeme stays an int (any size), one with '.', 'e' or 'E' is a float; a repeated key keeps its first place and its last value. */
export function parsePyJson(text: string): PyJson {
  if (text.charCodeAt(0) === 0xfeff) throw new PyJsonError('Unexpected UTF-8 BOM', 0)
  let i = 0
  const n = text.length
  const skip = () => { while (i < n && isBlank(text.charCodeAt(i))) i++ }

  function str(): string {
    // text[i] is the opening quote.
    i++
    let out = ''
    let start = i
    for (;;) {
      if (i >= n) throw new PyJsonError('Unterminated string', start - 1)
      const c = text.charCodeAt(i)
      if (c === 0x22) {
        out += text.slice(start, i)
        i++
        return out
      }
      if (c < 0x20) throw new PyJsonError('Invalid control character', i)
      if (c !== 0x5c) { i++; continue }
      out += text.slice(start, i)
      const e = text[i + 1]
      if (e === undefined) throw new PyJsonError('Unterminated string', start - 1)
      const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
      if (Object.prototype.hasOwnProperty.call(simple, e)) {
        out += simple[e]
        i += 2
      }
      else if (e === 'u') {
        const hex = text.slice(i + 2, i + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new PyJsonError('Invalid \\uXXXX escape', i)
        // A surrogate pair written as two escapes becomes one character in
        // Python; as UTF-16 code units that is the same two units here.
        out += String.fromCharCode(Number.parseInt(hex, 16))
        i += 6
      }
      else throw new PyJsonError('Invalid \\escape', i)
      start = i
    }
  }

  function num(): PyJson {
    const at = i
    if (text.charCodeAt(i) === 0x2d) i++
    const intStart = i
    if (text.charCodeAt(i) === 0x30) i++
    else if (isDigit(text.charCodeAt(i)) ) { while (isDigit(text.charCodeAt(i))) i++ }
    else throw new PyJsonError('Expecting value', at)
    let float = false
    if (text.charCodeAt(i) === 0x2e && isDigit(text.charCodeAt(i + 1))) {
      float = true
      i++
      while (isDigit(text.charCodeAt(i))) i++
    }
    const ec = text.charCodeAt(i)
    if (ec === 0x65 || ec === 0x45) {
      let j = i + 1
      const sc = text.charCodeAt(j)
      if (sc === 0x2b || sc === 0x2d) j++
      if (isDigit(text.charCodeAt(j))) {
        float = true
        while (isDigit(text.charCodeAt(j))) j++
        i = j
      }
    }
    const lexeme = text.slice(at, i)
    if (float) return { float: Number(lexeme) }
    const digits = text.slice(intStart, i)
    if (digits.length > PY_INT_MAX_STR_DIGITS) throw new PyJsonError('Exceeds the limit for integer string conversion', at)
    // int('-0') is 0.
    return { int: digits === '0' ? '0' : lexeme }
  }

  function value(): PyJson {
    skip()
    if (i >= n) throw new PyJsonError('Expecting value', i)
    const c = text.charCodeAt(i)
    if (c === 0x22) return str()
    if (c === 0x7b) {
      i++
      const entries: [string, PyJson][] = []
      const place = new Map<string, number>()
      skip()
      if (text.charCodeAt(i) === 0x7d) { i++; return { obj: entries } }
      for (;;) {
        skip()
        if (text.charCodeAt(i) !== 0x22) throw new PyJsonError('Expecting property name enclosed in double quotes', i)
        const key = str()
        skip()
        if (text.charCodeAt(i) !== 0x3a) throw new PyJsonError('Expecting \':\' delimiter', i)
        i++
        const v = value()
        const at = place.get(key)
        if (at === undefined) { place.set(key, entries.length); entries.push([key, v]) }
        else entries[at] = [key, v]
        skip()
        const d = text.charCodeAt(i)
        if (d === 0x7d) { i++; return { obj: entries } }
        if (d !== 0x2c) throw new PyJsonError('Expecting \',\' delimiter', i)
        i++
      }
    }
    if (c === 0x5b) {
      i++
      const items: PyJson[] = []
      skip()
      if (text.charCodeAt(i) === 0x5d) { i++; return items }
      for (;;) {
        items.push(value())
        skip()
        const d = text.charCodeAt(i)
        if (d === 0x5d) { i++; return items }
        if (d !== 0x2c) throw new PyJsonError('Expecting \',\' delimiter', i)
        i++
      }
    }
    if (text.startsWith('null', i)) { i += 4; return null }
    if (text.startsWith('true', i)) { i += 4; return true }
    if (text.startsWith('false', i)) { i += 5; return false }
    if (text.startsWith('NaN', i)) { i += 3; return { float: Number.NaN } }
    if (text.startsWith('Infinity', i)) { i += 8; return { float: Number.POSITIVE_INFINITY } }
    if (c === 0x2d || isDigit(c)) {
      // The C scanner tries a number first; '-Infinity' is its fallback for a '-' with no digit after it.
      if (c === 0x2d && !isDigit(text.charCodeAt(i + 1))) {
        if (text.startsWith('-Infinity', i)) { i += 9; return { float: Number.NEGATIVE_INFINITY } }
        throw new PyJsonError('Expecting value', i)
      }
      return num()
    }
    throw new PyJsonError('Expecting value', i)
  }

  const v = value()
  skip()
  if (i !== n) throw new PyJsonError('Extra data', i)
  return v
}

/** Python's repr() of a float: the shortest digits that read back as the same double, laid out as CPython's float_repr_style 'short'. */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (x === Number.POSITIVE_INFINITY) return 'inf'
  if (x === Number.NEGATIVE_INFINITY) return '-inf'
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0'
  const sign = x < 0 ? '-' : ''
  // toExponential() with no argument gives the shortest round-trip digits (closest, then even), as Python's dtoa mode 0.
  const [mant, expText] = Math.abs(x).toExponential().split('e') as [string, string]
  const digits = mant.replace('.', '')
  const exp = Number(expText)
  // CPython: the decimal point sits `decpt` digits in; exponent form when decpt <= -4 or decpt > 16.
  const decpt = exp + 1
  if (decpt <= -4 || decpt > 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits
    const a = Math.abs(exp)
    return `${sign}${m}e${exp < 0 ? '-' : '+'}${a < 10 ? '0' : ''}${a}`
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`
  if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`
}

const SHORT_ESCAPES: Record<number, string> = { 0x22: '\\"', 0x5c: '\\\\', 0x08: '\\b', 0x0c: '\\f', 0x0a: '\\n', 0x0d: '\\r', 0x09: '\\t' }

/** json.dumps of a string with ensure_ascii: every UTF-16 unit outside ' '…'~' as \uxxxx (lower-case hex). */
function dumpString(s: string): string {
  let out = '"'
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const short = SHORT_ESCAPES[c]
    if (short === undefined && c >= 0x20 && c <= 0x7e) continue
    out += s.slice(start, i) + (short ?? `\\u${c.toString(16).padStart(4, '0')}`)
    start = i + 1
  }
  return `${out}${s.slice(start)}"`
}

function dumpFloat(x: number): string {
  if (Number.isNaN(x)) return 'NaN'
  if (x === Number.POSITIVE_INFINITY) return 'Infinity'
  if (x === Number.NEGATIVE_INFINITY) return '-Infinity'
  return pyFloatRepr(x)
}

/** Python's json.dumps defaults: ensure_ascii, separators ', ' and ': ', float repr, NaN / Infinity / -Infinity. */
export function pyJsonDumps(v: PyJson): string {
  if (v === null) return 'null'
  if (v === true) return 'true'
  if (v === false) return 'false'
  if (typeof v === 'string') return dumpString(v)
  if (Array.isArray(v)) return `[${v.map(pyJsonDumps).join(', ')}]`
  if ('int' in v) return v.int
  if ('float' in v) return dumpFloat(v.float)
  return `{${v.obj.map(([k, x]) => `${dumpString(k)}: ${pyJsonDumps(x)}`).join(', ')}}`
}

/** Python's str() of a JSON scalar: strings as they are, int digits, float repr, 'True' / 'False' / 'None'. Throws PY_STR_UNREADABLE on a list or dict. */
export function pyStr(v: PyJson): string {
  if (v === null) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'string') return v
  if (Array.isArray(v) || 'obj' in v) throw new Error(PY_STR_UNREADABLE)
  if ('int' in v) return v.int
  return pyFloatRepr(v.float)
}
