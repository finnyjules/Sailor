/**
 * Smart Layout's settings as comfy_extras/nodes_smart_layout.py reads them
 * (step 3, R1.6): the layout JSON (the starter when blank), the text-layer
 * and brand `key=value` text, the default elements a wired layer gets, the
 * outputs to render and their labels, and the live previews' file names
 * (comfy_extras/_live_preview.py save_live_preview_multi). Pure: the browser
 * (eligibility's pixel cap) and the runner (server/runner/cards/smartLayout.ts)
 * share it. Ported against the real Python functions
 * (scripts/runner_cards_fixtures.py, key `smart_layout`).
 *
 * Python's dict semantics are kept where a layout can reach them: `x or {}`
 * truthiness, a missing key vs a present null, isinstance(v, int) (a float
 * written `12.0` is not an int, true is), and the errors Python raises on a
 * layout of the wrong shape (the node fails either way; the words differ
 * only where Python's are its own internals).
 */
import { pyIntOf, pyStrip, pyTruthy } from './pyText'
import { LAYOUT_MAX_AREA, LAYOUT_MAX_ELEMENTS, LAYOUT_MAX_SIDE } from '../template-grid/limits'

type Dict = Record<string, unknown>

/** Built-in format presets (`_FORMAT_PRESETS`, nodes_smart_layout.py:76). */
export const FORMAT_PRESETS: Readonly<Record<string, Readonly<Dict>>> = {
  '1x1': { w: 1080, h: 1080, label: 'Square' },
  '4x5': { w: 1080, h: 1350, label: 'Feed portrait' },
  '9x16': { w: 1080, h: 1920, label: 'Story', safeArea: { top: 270, bottom: 380 } },
  '16x9': { w: 1920, h: 1080, label: 'Wide' },
  '300x250': { w: 300, h: 250, label: 'MPU' },
  '300x600': { w: 300, h: 600, label: 'Half page' },
  '728x90': { w: 728, h: 90, label: 'Leaderboard' },
  '970x250': { w: 970, h: 250, label: 'Billboard' },
  '320x50': { w: 320, h: 50, label: 'Mobile banner' },
  '160x600': { w: 160, h: 600, label: 'Skyscraper' },
}

/** `_STARTER_LAYOUT` (nodes_smart_layout.py:90): what a blank layout renders. */
export const STARTER_LAYOUT: Readonly<Dict> = {
  version: 2,
  id: 'starter',
  name: 'New Layout',
  master: '1x1',
  formats: FORMAT_PRESETS,
  grid: { gutter: 24, margin: 72, baseline: 12 },
  typeScale: { base: 28, ratio: 1.414 },
  background: { fill: '#0a0a0a' },
  elements: [],
}

/** The layer sockets (`_MAX_TEXT_LAYERS`, `_MAX_IMAGE_LAYERS`). */
export const SMART_LAYOUT_LAYERS = 8
export const TEXT_LAYERS: readonly string[] = Array.from({ length: SMART_LAYOUT_LAYERS }, (_, i) => `text_layer_${i + 1}`)
export const IMAGE_LAYERS: readonly string[] = Array.from({ length: SMART_LAYOUT_LAYERS }, (_, i) => `image_layer_${i + 1}`)

/** A layout the runner can't read as Python does (its first format depends on key order JS doesn't keep). */
export class LayoutOrderUnknown extends Error {}

const isDict = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v)
const has = (d: Dict, k: string) => Object.prototype.hasOwnProperty.call(d, k)
/** dict.get(k): undefined when absent. */
const get = (d: Dict, k: string): unknown => (has(d, k) ? d[k] : undefined)

// ── What JSON.parse loses ────────────────────────────────────────────────────

/** Keys whose number was written as a float (`12.0`, `1e3`): Python's json.loads makes those floats. */
const FLOAT_KEYS = new WeakMap<object, Set<string>>()
/** Objects with an integer-like key, whose key order JS changes (integer keys first). */
const INDEX_ORDER = new WeakSet<object>()

/** isinstance(d[k], int) as Python sees the parsed layout: true is an int, 12.0 is not. */
function pyIsInt(d: Dict, k: string): boolean {
  const v = get(d, k)
  if (typeof v === 'boolean') return true
  return typeof v === 'number' && Number.isInteger(v) && !FLOAT_KEYS.get(d)?.has(k)
}

/** A JSON.parse error's line, as json.loads counts it. */
function errorLine(s: string, e: unknown): number {
  const m = /line (\d+)/.exec(String((e as Error)?.message ?? ''))
  if (m) return Number(m[1])
  const p = /position (\d+)/.exec(String((e as Error)?.message ?? ''))
  const upto = p ? s.slice(0, Number(p[1])) : s
  return upto.split('\n').length
}

function parseJson(s: string): unknown {
  return JSON.parse(s, function (this: object, key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === 'number' && context?.source && /[.eE]/.test(context.source)) {
      const set = FLOAT_KEYS.get(this) ?? new Set<string>()
      set.add(key)
      FLOAT_KEYS.set(this, set)
    }
    if (isDict(value) && Object.keys(value).some(k => /^(?:0|[1-9]\d*)$/.test(k))) INDEX_ORDER.add(value)
    return value
  } as (this: unknown, key: string, value: unknown) => unknown)
}

/** str() of a widget value, as validate_inputs converts a STRING. */
function widgetText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  return String(v)
}

/**
 * `_parse_layout`: the layout widget's JSON; blank gives a fresh copy of the
 * starter. Not JSON, or not an object with `aspects` or `formats`: Python's refusal.
 */
export function parseLayout(raw: unknown): Record<string, unknown> {
  const s = pyStrip(widgetText(raw))
  if (!s) return structuredClone(STARTER_LAYOUT) as Dict
  let layout: unknown
  try { layout = parseJson(s) }
  catch (e) {
    throw new Error(`Layout JSON is malformed at line ${errorLine(s, e)}: it is not valid JSON`)
  }
  if (!isDict(layout) || (!has(layout, 'aspects') && !has(layout, 'formats'))) {
    throw new Error('Layout must be a JSON object with an `aspects` (v1) or `formats` (v2) field.')
  }
  return layout
}

// ── key=value text ───────────────────────────────────────────────────────────

/** Python str.splitlines(). */
export function pySplitlines(s: string): string[] {
  const out: string[] = []
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === '\r' && s[i + 1] === '\n') {
      out.push(s.slice(start, i))
      i++
      start = i + 1
    }
    else if ('\n\r\v\f\x1c\x1d\x1e\x85  '.includes(c)) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  if (start < s.length) out.push(s.slice(start))
  return out
}

/**
 * `_parse_text_layers` (also `_parse_kv`, the wired brand): `key=value` per
 * line (`#` lines and lines without `=` skipped); text with no `=` at all is
 * the value of `defaultRole`.
 */
export function parseTextLayers(raw: string, defaultRole: string): Record<string, string> {
  const text = pyStrip(raw ?? '')
  if (!text) return {}
  if (!text.includes('=')) return { [defaultRole]: text }
  const out: Record<string, string> = {}
  for (const line of pySplitlines(text)) {
    const s = pyStrip(line)
    if (!s || s.startsWith('#') || !s.includes('=')) continue
    const i = s.indexOf('=')
    out[pyStrip(s.slice(0, i))] = pyStrip(s.slice(i + 1))
  }
  return out
}

/**
 * The brand the renderer is sent (execute, nodes_smart_layout.py:544): the
 * project kit (`brand_kit`, strict `key=value`, blank keys and values
 * dropped) under the wired `brand` (read as `_parse_kv`).
 */
export function brandOf(brand: unknown, brandKit: unknown): Record<string, string> {
  const kit: Record<string, string> = {}
  for (const line of pySplitlines(widgetText(brandKit))) {
    const s = pyStrip(line)
    if (!s || s.startsWith('#') || !s.includes('=')) continue
    const i = s.indexOf('=')
    const k = pyStrip(s.slice(0, i))
    const v = pyStrip(s.slice(i + 1))
    if (k && v) kit[k] = v
  }
  return { ...kit, ...parseTextLayers(widgetText(brand), 'headline') }
}

// ── The default elements ─────────────────────────────────────────────────────

/** Python's error for calling a dict method on something that isn't one. */
function notDict(v: unknown, what: string): Error {
  const t = v === null ? 'NoneType' : Array.isArray(v) ? 'list' : typeof v === 'string' ? 'str' : typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float') : 'dict'
  return new Error(`'${t}' object has no attribute '${what}'`)
}

/** What `list(x)` / `lst.extend(x)` iterates: a list's items, a dict's keys, a string's characters. */
function pyIter(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') return [...v]
  if (isDict(v)) return Object.keys(v)
  throw new Error(`'${typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float') : 'NoneType'}' object is not iterable`)
}

/** `_template_elements`: the top-level elements, then each section's children (v3). */
export function templateElements(template: Dict): unknown[] {
  const els = get(template, 'elements')
  const out = [...(pyTruthy(els) ? pyIter(els) : [])]
  const sections = get(template, 'sections')
  for (const s of pyTruthy(sections) ? pyIter(sections) : []) {
    if (!isDict(s)) throw notDict(s, 'get')
    const kids = get(s, 'children')
    if (pyTruthy(kids)) out.push(...pyIter(kids))
  }
  return out
}

/** Whether `token` is in str(v): in some text of it (repr never splits a token of letters, digits, `.` and `_`). */
function mentions(v: unknown, token: string): boolean {
  if (typeof v === 'string') return v.includes(token)
  if (Array.isArray(v)) return v.some(x => mentions(x, token))
  if (isDict(v)) return Object.entries(v).some(([k, x]) => k.includes(token) || mentions(x, token))
  return false
}

/** `_refs_socket`: some element carries the socket's id or mentions `props.<key>`. */
function refsSocket(template: Dict, key: string): boolean {
  const token = `props.${key}`
  for (const e of templateElements(template)) {
    if (!isDict(e)) throw notDict(e, 'get')
    if (get(e, 'id') === key || mentions(has(e, 'content') ? e.content : '', token)) return true
  }
  return false
}

/** The keys of one socket kind, in socket order (`sorted(..., key=int(last part))`). */
function socketKeys(props: Dict, prefix: string): string[] {
  const keys = Object.keys(props).filter(k => k.startsWith(prefix))
  const n = (k: string) => {
    const v = pyIntOf(k.split('_').pop()!)
    if (v === null) throw new Error(`invalid literal for int() with base 10: '${k.split('_').pop()}'`)
    return v
  }
  const nums = new Map(keys.map(k => [k, n(k)]))
  return keys.sort((a, b) => nums.get(a)! - nums.get(b)!)
}

/** template.setdefault("elements", []): the list to add to (Python fails on anything else when it adds). */
function elementsList(template: Dict, method: 'append' | 'insert'): unknown[] {
  if (!has(template, 'elements')) template.elements = []
  const els = template.elements
  if (!Array.isArray(els)) throw notDict(els, method)
  return els
}

/** `_autopopulate_elements`: v1 anchors. */
function autopopulateV1(template: Dict, props: Dict): void {
  if (!has(template, 'elements')) template.elements = []
  socketKeys(props, 'image_layer_').forEach((key, i) => {
    if (refsSocket(template, key)) return
    const idx = i + 1
    elementsList(template, 'append').push(idx === 1
      ? {
          id: key, type: 'image', role: `IMAGE_LAYER_${idx}`, anchor: 'top-left',
          offset: { x: 0, y: 0 }, size: { w: '100%', h: '100%' },
          style: { fit: 'cover', borderRadius: 0 }, content: `{{ props.${key} }}`,
        }
      : {
          id: key, type: 'image', role: `IMAGE_LAYER_${idx}`, anchor: 'top-right',
          offset: { x: '4%', y: `${4 + (idx - 2) * 14}%` }, size: { w: '20%', h: '12%' },
          style: { fit: 'cover', borderRadius: 12 }, content: `{{ props.${key} }}`,
        })
  })
  socketKeys(props, 'text_layer_').forEach((key, i) => {
    if (refsSocket(template, key)) return
    const idx = i + 1
    elementsList(template, 'append').push({
      id: key, type: 'text', role: `TEXT_LAYER_${idx}`, anchor: 'top-center',
      offset: { x: 0, y: `${58 + (idx - 1) * 12}%` }, size: { w: '84%', h: 'auto' },
      style: {
        fontFamily: 'Inter', fontSize: idx === 1 ? 72 : 44, fontWeight: idx === 1 ? 700 : 400,
        color: '#ffffff', align: 'center', lineHeight: 1.1,
      },
      content: `{{ props.${key} }}`,
    })
  })
}

/** `_autopopulate_elements_v2`: v2/v3 grid regions. */
function autopopulateV2(template: Dict, props: Dict): void {
  if (!has(template, 'elements')) template.elements = []
  socketKeys(props, 'image_layer_').forEach((key, i) => {
    if (refsSocket(template, key)) return
    const idx = i + 1
    if (idx === 1) {
      const gv = get(template, 'grid')
      const g: Dict = pyTruthy(gv) ? (isDict(gv) ? gv : (() => { throw notDict(gv, 'get') })()) : {}
      const positive = (k: string) => pyIsInt(g, k) && Number(g[k]) > 0
      const cols = positive('columns') ? g.columns : 9999
      const rows = positive('rows') ? g.rows : 9999
      elementsList(template, 'insert').unshift({
        id: key, type: 'image', role: `IMAGE_LAYER_${idx}`, priority: 4,
        region: { col: 1, colSpan: cols, row: 1, rowSpan: rows },
        bleed: true, focal: { x: 0.5, y: 0.5 }, style: { fit: 'cover' },
        content: `{{ props.${key} }}`,
      })
      const order = get(template, 'order')
      if (Array.isArray(order) && !order.includes(key)) order.unshift(key)
    }
    else {
      elementsList(template, 'append').push({
        id: key, type: 'image', role: `IMAGE_LAYER_${idx}`, priority: 5 + idx,
        region: { col: 6, colSpan: 1, row: Math.min(6, idx - 1), rowSpan: 1 },
        collapse: 'mark', style: { fit: 'cover' }, content: `{{ props.${key} }}`,
      })
    }
  })
  socketKeys(props, 'text_layer_').forEach((key, i) => {
    if (refsSocket(template, key)) return
    const idx = i + 1
    elementsList(template, 'append').push(idx === 1
      ? {
          id: key, type: 'text', role: `TEXT_LAYER_${idx}`, priority: 1, level: 'display',
          region: { col: 1, colSpan: 6, row: 4, rowSpan: 2 }, overflow: 'shrink-then-truncate',
          style: { fontWeight: 700, color: '#ffffff' }, content: `{{ props.${key} }}`,
        }
      : {
          id: key, type: 'text', role: `TEXT_LAYER_${idx}`, priority: 5, level: 'subhead',
          region: { col: 1, colSpan: 4, row: 6, rowSpan: 1 },
          style: { color: '#ffffff' }, content: `{{ props.${key} }}`,
        })
  })
}

/**
 * `_autopopulate_for_template`: a default element for every wired layer no
 * element references yet (grid regions for v2 and v3, anchors for v1).
 * Changes `template` in place, as Python does.
 */
export function autopopulateForTemplate(template: Record<string, unknown>, props: Record<string, unknown>): void {
  const v = get(template, 'version')
  if (v === 2 || v === 3) autopopulateV2(template, props)
  else autopopulateV1(template, props)
}

// ── The outputs ──────────────────────────────────────────────────────────────

/** One output to render: its format key, and its id (per-output overrides) and label when it has them. */
export interface SmartLayoutOutput { format: string; id?: string; label?: unknown; [k: string]: unknown }

/** Python's repr() of a str. */
function pyRepr(s: string): string {
  const q = s.includes('\'') && !s.includes('"') ? '"' : '\''
  let out = q
  for (const c of s) {
    const n = c.codePointAt(0)!
    if (c === '\\' || c === q) out += `\\${c}`
    else if (c === '\n') out += '\\n'
    else if (c === '\r') out += '\\r'
    else if (c === '\t') out += '\\t'
    else if (n < 0x20 || (n >= 0x7F && n <= 0xA0) || n === 0xAD) out += `\\x${n.toString(16).padStart(2, '0')}`
    else if (n === 0x2028 || n === 0x2029) out += `\\u${n.toString(16)}`
    else out += c
  }
  return out + q
}

/** repr() of a list of plain values. */
function pyListRepr(items: unknown[]): string {
  return `[${items.map(v => typeof v === 'string' ? pyRepr(v) : v === null ? 'None' : typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v)).join(', ')}]`
}

/** Python's sort of strings: by code point. */
function byCodePoint(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!
    if (d) return d
  }
  return x.length - y.length
}

/** `k in defined` for a dict, list or string. */
function pyIn(k: string, defined: unknown): boolean {
  if (isDict(defined)) return has(defined, k)
  if (Array.isArray(defined)) return defined.some(v => v === k)
  if (typeof defined === 'string') return defined.includes(k)
  throw new Error(`argument of type '${typeof defined === 'boolean' ? 'bool' : typeof defined === 'number' ? 'int' : 'NoneType'}' is not iterable`)
}

/** `_parse_aspects`: the comma-separated format keys; none gives the template's default. */
function parseAspects(aspects: string, template: Dict): unknown[] {
  const f = get(template, 'formats')
  const a = get(template, 'aspects')
  const defined: unknown = pyTruthy(f) ? f : pyTruthy(a) ? a : {}
  const keys = aspects.split(',').map(pyStrip).filter(Boolean)
  if (!keys.length) {
    let first: unknown
    const master = get(template, 'master')
    const fallback = get(template, 'defaultAspect')
    if (pyTruthy(master)) first = master
    else if (pyTruthy(fallback)) first = fallback
    else {
      if (isDict(defined) && INDEX_ORDER.has(defined)) throw new LayoutOrderUnknown('The runner can’t tell which format this layout lists first')
      first = pyIter(defined)[0] ?? null
    }
    if (!pyTruthy(first)) throw new Error('Template has no formats defined.')
    return [first]
  }
  const bad = keys.filter(k => !pyIn(k, defined))
  if (bad.length) {
    const names = pyIter(defined)
    if (names.some(n => typeof n !== 'string')) throw new Error('\'<\' not supported between instances')
    throw new Error(`Unknown format(s) ${pyListRepr(bad)}. Template defines: ${pyListRepr((names as string[]).slice().sort(byCodePoint))}`)
  }
  return keys
}

/** dict.get(k) with Python's key equality: a JSON dict's keys are text, so only text finds one. */
function pyGet(d: Dict, k: unknown): unknown {
  if (k !== null && typeof k === 'object') throw new Error('unhashable type')
  return typeof k === 'string' ? get(d, k) : undefined
}

/** `(x or {})` for a dict lookup: {} when falsy, Python's failure when not a dict. */
function orDict(v: unknown, method = 'get'): Dict {
  if (!pyTruthy(v)) return {}
  if (!isDict(v)) throw notDict(v, method)
  return v
}

/**
 * `_resolve_outputs`: the template's own `outputs` (objects with a format,
 * repeatable for variations), else one per `aspects` key (id = format, the
 * format's label, null when it has none).
 */
export function resolveOutputs(template: Record<string, unknown>, aspects: string): SmartLayoutOutput[] {
  const outs = get(template, 'outputs')
  if (Array.isArray(outs)) {
    const clean = outs.filter(o => isDict(o) && pyTruthy(get(o, 'format')))
    if (clean.length) return clean as SmartLayoutOutput[]
  }
  const fv = get(template, 'formats')
  const formats: unknown = pyTruthy(fv) ? fv : {}
  return parseAspects(aspects, template).map((k) => {
    if (!isDict(formats)) throw notDict(formats, 'get')
    return { id: k, format: k, label: orDict(pyGet(formats, k)).label ?? null } as SmartLayoutOutput
  })
}

/**
 * `_output_labels`: each output's label (its own, its format's, or the
 * format key), a repeat numbered (`Square 2`). A label that isn't text fails
 * the node, as Python's preview save does with it.
 */
export function outputLabels(outputs: readonly SmartLayoutOutput[], template: Record<string, unknown>): string[] {
  const fv = get(template, 'formats')
  const labels: string[] = []
  const seen = new Map<string, number>()
  for (const o of outputs) {
    let base: unknown = get(o, 'label')
    if (!pyTruthy(base)) {
      const formats = orDict(fv)
      base = orDict(pyGet(formats, o.format)).label
    }
    if (!pyTruthy(base)) base = o.format
    if (typeof base !== 'string') throw new Error('An output’s label is not text')
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    labels.push(n === 1 ? base : `${base} ${n}`)
  }
  return labels
}

/** Python str.isalnum() for one character: a letter or a number. */
const ALNUM = /^[\p{L}\p{N}]$/u

/** save_live_preview_multi's file name for one output: `live_preview_<node>_<safe label>.png`. */
export function livePreviewName(nodeId: string, label: string, index: number): string {
  const safe = [...label].map(c => (ALNUM.test(c) || c === '_' || c === '-' || c === '.' ? c : '_')).join('') || String(index)
  return `live_preview_${nodeId}_${safe}.png`
}

/** The largest one Smart Layout output (fix round 1): the renderer's own limit since round 2 (template-grid/limits.ts). */
export const SMART_LAYOUT_MAX_OUTPUT_PIXELS = LAYOUT_MAX_AREA
/** The most elements (top-level and section children) a layout the runner renders may have. */
export const SMART_LAYOUT_MAX_ELEMENTS = LAYOUT_MAX_ELEMENTS

/**
 * The render size of an output's format as the renderer reads it
 * (server/templates/translate.ts: v2/v3 `formats[key]`, else `aspects[key]`):
 * null when the template has no such format (the render fails), 'odd' when
 * its size is not a plain number of pixels, 'tiny' when it is under one
 * pixel either way (the renderer refuses it: its text fit would never end),
 * 'huge' when a side is over 16384 or it is over 8192² pixels (the renderer
 * refuses it too, round 2: resvg would panic or run out of memory).
 */
export function formatSize(template: Record<string, unknown>, format: unknown): { w: number; h: number } | null | 'odd' | 'tiny' | 'huge' {
  const v = template.version
  const table = v === 2 || v === 3 ? template.formats : template.aspects
  if (!isDict(table) || (typeof format !== 'string' && typeof format !== 'number')) return null
  const f = get(table, String(format))
  if (!isDict(f)) return null
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  if (!ok(f.w) || !ok(f.h)) return 'odd'
  if (f.w < 1 || f.h < 1) return 'tiny'
  if (f.w > LAYOUT_MAX_SIDE || f.h > LAYOUT_MAX_SIDE || Math.ceil(f.w) * Math.ceil(f.h) > LAYOUT_MAX_AREA) return 'huge'
  return { w: Math.ceil(f.w), h: Math.ceil(f.h) }
}

/** How many elements a layout has, top-level and in sections (0 when Python would fail on its shape). */
export function layoutElementCount(template: Record<string, unknown>): number {
  try { return templateElements(template).length }
  catch { return 0 }
}

/**
 * What a Smart Layout's settings would render, before anything runs: the
 * pixels in all and the largest one output, or null when the runner leaves
 * it to the engine: a layout JSON.parse can't read as json.loads does, a
 * first format hidden by key order, a size that isn't a number, or more than
 * SMART_LAYOUT_MAX_ELEMENTS elements. A layout Python refuses, or a format
 * under one pixel or over the renderer's size limits (which the route
 * refuses too), counts 0: the node fails plainly wherever it runs.
 */
export function smartLayoutPixels(inputs: Record<string, unknown>): number | null {
  let template: Dict
  try { template = parseLayout(inputs.layout) }
  catch { return /NaN|Infinity/.test(widgetText(inputs.layout)) ? null : 0 }
  if (layoutElementCount(template) > SMART_LAYOUT_MAX_ELEMENTS) return null
  let outputs: SmartLayoutOutput[]
  try { outputs = resolveOutputs(template, widgetText(inputs.aspects)) }
  catch (e) { return e instanceof LayoutOrderUnknown ? null : 0 }
  let total = 0
  for (const o of outputs) {
    const s = formatSize(template, o.format)
    if (s === 'odd') return null
    // The renderer refuses these wherever the node runs: the runner refuses plainly.
    if (s === 'tiny' || s === 'huge') return 0
    if (s) total += s.w * s.h
  }
  return total
}
