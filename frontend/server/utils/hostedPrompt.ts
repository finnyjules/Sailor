/**
 * The hosted /prompt gate's normalisation (Task G1 fix round 1, rulings R2
 * and R4): the prompt is put in the form ComfyUI's own validation puts it in
 * (execution.py validate_inputs, the non-link branch) BEFORE anything reads
 * it for money: the file-ownership check, the sizing, the price. The
 * NORMALISED prompt is the one forwarded to ComfyUI, so what is priced is
 * what runs. ComfyUI unwraps `__value__` once per validation, so a wrapper
 * inside a wrapper would be unwrapped again there and run as a value this
 * never saw: after the one unwrap, any value still holding a `__value__` key
 * anywhere (at any depth, in any input, declared or not) is refused (G1 fix
 * round 2). With none left, ComfyUI's own validation of the forwarded
 * prompt changes nothing: the coercions below give values it leaves as they are.
 *
 * For each input the node's class declares (its /object_info entry, read from
 * the stored catalog):
 *  - a list is a link, left as it is (ComfyUI checks it);
 *  - a dict holding `__value__` is unwrapped to that value ("used to pass
 *    list widget values"); an unwrapped list is then a link for a link type
 *    (IMAGE and the like), as ComfyUI's execution treats it;
 *  - then, by the declared type: INT → int(v), FLOAT → float(v), STRING →
 *    str(v), BOOLEAN → bool(v); any other type (a combo, a link type) is left
 *    as it is.
 * Where the result can't be matched exactly, the prompt is refused in
 * hosted mode with a plain message rather than priced on a guess:
 *  - int() or float() of text in a form this doesn't read exactly
 *    (underscores, non-ASCII digits, inf, nan), of a list, a dict or null, or
 *    beyond the exactly representable whole numbers;
 *  - str() of anything but text (Python's str(4096.0) is "4096.0", but the
 *    JSON number arrives here as 4096, so the two can't be told apart);
 *  - bool() of a list or a dict;
 *  - a `__value__` wrapper on an input the class doesn't declare (ComfyUI
 *    would not unwrap it, but a dynamic input might), or one left inside a
 *    value after the unwrap;
 *  - a class the catalog doesn't know (ComfyUI refuses the whole prompt then too).
 * Inputs a class doesn't declare are otherwise left alone: ComfyUI passes
 * only their links on. Each node keeps only `class_type`, `inputs` and
 * `_meta`; any other key (`is_changed` above all) is dropped.
 */
import type { RequestProblem } from '../runner/requestRules'
import { pyFloatOf, pyIntOf } from '../../shared/runner/pyText'

export const SETTING_UNREADABLE = 'One of this step\'s settings has a value Sailor can\'t read. Set it again, then run once more.'
export const STEP_UNKNOWN = 'This step isn\'t one Sailor knows, so it can\'t be priced. Remove it, then run once more.'
export const STEPS_UNAVAILABLE = 'Sailor can\'t check this workflow\'s steps right now. Try again in a moment.'

type Catalog = Readonly<Record<string, any>>
type Prompt = Record<string, any>

const CANT = Symbol('cant')

/** Python's int(v) for a JSON value, or CANT when it would fail or can't be matched exactly. */
export function pyIntCoerce(v: unknown): number | typeof CANT {
  let n: number
  if (typeof v === 'boolean') n = v ? 1 : 0
  else if (typeof v === 'number') n = Math.trunc(v)
  else if (typeof v === 'string') {
    // shared/runner/pyText.ts: Python's int(str) grammar (the runner reads widgets with it too).
    const parsed = pyIntOf(v)
    if (parsed == null) return CANT
    n = parsed
  }
  else return CANT
  return Number.isSafeInteger(n) ? n : CANT
}

/** Python's float(v) for a JSON value, or CANT when it would fail or can't be matched exactly. */
export function pyFloatCoerce(v: unknown): number | typeof CANT {
  let n: number
  if (typeof v === 'boolean') n = v ? 1 : 0
  else if (typeof v === 'number') n = v
  else if (typeof v === 'string') {
    const parsed = pyFloatOf(v)
    if (parsed == null) return CANT
    n = parsed
  }
  else return CANT
  // inf and nan can't be sent back as JSON: refused.
  return Number.isFinite(n) ? n : CANT
}

/** Python's bool(v) for a JSON value, or CANT for a list or a dict. */
function pyBoolCoerce(v: unknown): boolean | typeof CANT {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v.length > 0
  if (v === null) return false
  return CANT
}

/** The declared spec of `input` on a catalog entry (required, then optional), or undefined. */
function declared(entry: any, input: string): unknown[] | undefined {
  const sections = entry?.input
  for (const name of ['required', 'optional']) {
    const section = sections?.[name]
    if (section && typeof section === 'object' && Object.prototype.hasOwnProperty.call(section, input)) {
      const spec = section[input]
      return Array.isArray(spec) ? spec : undefined
    }
  }
  return undefined
}

/** Whether `v` holds a `__value__` key anywhere, at any depth (bounded). */
export function holdsWrapper(v: unknown, depth = 0): boolean {
  if (depth > 64) return true
  if (Array.isArray(v)) return v.some(x => holdsWrapper(x, depth + 1))
  if (v && typeof v === 'object') {
    if (Object.prototype.hasOwnProperty.call(v, '__value__')) return true
    return Object.values(v as Record<string, unknown>).some(x => holdsWrapper(x, depth + 1))
  }
  return false
}

const isDict = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const PRIMITIVE_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN'])

/**
 * The prompt as ComfyUI's validation leaves it, or the problems that stop it
 * being matched exactly (hosted refuses those). `catalog`: the stored node
 * catalog; null refuses every prompt (nothing can be checked).
 */
export function normalizeHostedPrompt(prompt: unknown, catalog: Catalog | null): { prompt: Prompt } | { problems: RequestProblem[] } {
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)) return { prompt: prompt as Prompt }
  const out = structuredClone(prompt) as Prompt
  const problems: RequestProblem[] = []
  for (const [nodeId, raw] of Object.entries(out)) {
    if (!isDict(raw) || typeof raw.class_type !== 'string') continue
    // Only what a node is, what it is given and its title go on (G1 fix
    // round 3): ComfyUI reads a node-level `is_changed` as the node's cache
    // signature (execution.py IsChangedCache), which would let a pinned key
    // serve an old result for a file measured afresh.
    const node: Record<string, unknown> = { class_type: raw.class_type, inputs: raw.inputs }
    if (Object.prototype.hasOwnProperty.call(raw, '_meta')) node._meta = raw._meta
    if (!Object.prototype.hasOwnProperty.call(raw, 'inputs')) delete node.inputs
    out[nodeId] = node
    const ct = raw.class_type
    if (!catalog) { problems.push({ nodeId, classType: ct, input: '', message: STEPS_UNAVAILABLE }); continue }
    const entry = Object.prototype.hasOwnProperty.call(catalog, ct) ? catalog[ct] : undefined
    if (!entry) { problems.push({ nodeId, classType: ct, input: '', message: STEP_UNKNOWN }); continue }
    const inputs = node.inputs
    if (!isDict(inputs)) continue
    for (const [name, raw] of Object.entries(inputs)) {
      // A wrapper inside a list: ComfyUI would take the list as a link and never unwrap it, but refuse anyway.
      if (Array.isArray(raw)) {
        if (holdsWrapper(raw)) problems.push({ nodeId, classType: ct, input: name, message: SETTING_UNREADABLE })
        continue // a link
      }
      const spec = declared(entry, name)
      const wrapped = isDict(raw) && Object.prototype.hasOwnProperty.call(raw, '__value__')
      if (!spec) {
        if (holdsWrapper(raw)) problems.push({ nodeId, classType: ct, input: name, message: SETTING_UNREADABLE })
        continue
      }
      const v = wrapped ? (raw as Record<string, unknown>).__value__ : raw
      const type = spec[0]
      if (typeof type !== 'string' || !PRIMITIVE_TYPES.has(type)) {
        // A combo or a link type: unwrapped once, not coerced (an unwrapped list becomes a link).
        if (holdsWrapper(v)) problems.push({ nodeId, classType: ct, input: name, message: SETTING_UNREADABLE })
        else if (wrapped) inputs[name] = v
        continue
      }
      if (holdsWrapper(v)) {
        problems.push({ nodeId, classType: ct, input: name, message: SETTING_UNREADABLE })
        continue
      }
      let coerced: unknown = CANT
      if (type === 'INT') coerced = pyIntCoerce(v)
      else if (type === 'FLOAT') coerced = pyFloatCoerce(v)
      else if (type === 'STRING') coerced = typeof v === 'string' ? v : CANT
      else coerced = pyBoolCoerce(v)
      if (coerced === CANT) problems.push({ nodeId, classType: ct, input: name, message: SETTING_UNREADABLE })
      else inputs[name] = coerced
    }
  }
  return problems.length ? { problems } : { prompt: out }
}
