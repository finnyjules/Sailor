/**
 * The shader-effects catalog, served by Sailor instead of ComfyUI — a port of
 * comfy_extras/nodes_shader_effects.py's two routes and the catalog loader
 * they call (comfy_extras/_shader_effects.py `load_catalog`):
 *
 *   GET /sailor/shader_effects                (:224)  the manifest with each .frag inlined
 *   GET /sailor/shader_effects/assets/{name}  (:231)  a texture file, revalidated every time
 *
 * The catalog is `<engine root>/shader_effects/` (the Python's CATALOG_DIR is
 * the repo root's `shader_effects/`, and the engine root is that repo root).
 * It is re-read on every request, as the Python does, so editing a shader only
 * needs a browser refresh. A manifest the Python would reject is rejected here
 * with the same message, as a 500 `{ error }`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveEngineRoot } from '../utils/inputUploads'
import { isFile } from './paths'

type Json = any

export interface CatalogResult {
  status: number
  body: unknown
  headers?: Record<string, string>
}

/** `CATALOG_DIR` — `<engine root>/shader_effects`. Null when the engine root is unknown. */
export function catalogDir(): string | null {
  const root = resolveEngineRoot()
  return root ? path.join(root, 'shader_effects') : null
}

// --------------------------------------------------------------- Python-isms

const isObj = (v: unknown): v is Record<string, Json> => v !== null && typeof v === 'object' && !Array.isArray(v)

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return 'NoneType'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float'
  if (typeof v === 'string') return 'str'
  if (Array.isArray(v)) return 'list'
  return 'dict'
}

/** `d[k]` on a parsed JSON value: KeyError prints as `'k'`, a non-dict is a TypeError. */
function item(d: unknown, k: string): Json {
  if (Array.isArray(d)) throw new TypeError('list indices must be integers or slices, not str')
  if (typeof d === 'string') throw new TypeError('string indices must be integers, not \'str\'')
  if (!isObj(d)) throw new TypeError(`'${pyTypeName(d)}' object is not subscriptable`)
  if (!(k in d)) throw new Error(`'${k}'`)
  return d[k]
}

/** `d.get(k, default)` — a key that is present (even as null) wins. */
function get(d: Record<string, Json>, k: string, fallback: Json): Json {
  return k in d ? d[k] : fallback
}

/** Python `==` between two JSON values (True == 1 == 1.0, lists and dicts compare structurally). */
function pyEq(a: unknown, b: unknown): boolean {
  const num = (v: unknown) => typeof v === 'number' || typeof v === 'boolean'
  if (num(a) && num(b)) return Number(a) === Number(b)
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]))
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every(k => k in b && pyEq(a[k], b[k]))
  }
  return a === b
}

/** Python `a <= b` for the scalar types a manifest holds. */
function pyLe(a: unknown, b: unknown): boolean {
  const num = (v: unknown) => typeof v === 'number' || typeof v === 'boolean'
  if (num(a) && num(b)) return Number(a) <= Number(b)
  if (typeof a === 'string' && typeof b === 'string') return a <= b
  throw new TypeError(`'<=' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`)
}

/** Python `int(s, 16)` acceptance: whitespace, a sign, an optional 0x prefix, single underscores between digits. */
const PY_HEX_INT = /^\s*[+-]?(?:0[xX]_?)?[0-9a-fA-F]+(?:_[0-9a-fA-F]+)*\s*$/

/** `parse_hex` — only whether it raises matters here (the values are for rendering). */
function parseHex(hexStr: unknown): void {
  if (typeof hexStr !== 'string') throw new TypeError('not a string')
  let h = hexStr.replace(/^#+/, '')
  if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('')
  if (h.length === 8) h = h.slice(0, 6)
  if (h.length !== 6) throw new Error(`not a hex colour: ${hexStr}`)
  if (!PY_HEX_INT.test(h)) throw new Error(`invalid literal for int() with base 16: '${h}'`)
}

/** Python `float(x)` for a JSON value. */
function pyFloat(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const s = v.trim().replace(/(?<=\d)_(?=\d)/g, '')
    if (/^[+-]?(?:inf(?:inity)?|nan)$/i.test(s)) return s.toLowerCase().includes('nan') ? Number.NaN : (s.startsWith('-') ? -Infinity : Infinity)
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return Number(s)
    throw new Error(`could not convert string to float: '${v}'`)
  }
  throw new TypeError(`float() argument must be a string or a real number, not '${pyTypeName(v)}'`)
}

/** Python's text-mode read: universal newlines. */
function readText(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n')
}

/** `os.path.join(a, b)` — an absolute `b` wins, nothing is normalised. */
function pyJoin(a: string, b: string): string {
  if (b.startsWith('/')) return b
  return a.endsWith('/') ? a + b : `${a}/${b}`
}

// ------------------------------------------------------------------- loader

/** `EffectParam` field order, with the manifest's camelCase names (`_param_payload`). */
const PARAM_FIELDS = ['uniform', 'label', 'type', 'default', 'min', 'max', 'step', 'options', 'maxStops', 'showWhen'] as const
const PARAM_REQUIRED = ['uniform', 'label', 'type', 'default']
const PARAM_DEFAULTS: Record<string, Json> = { min: 0.0, max: 0.0, step: 0.0, options: null, maxStops: 8, showWhen: null }
/** `_PARAM_KEY_ALIASES` (manifest key → dataclass field). A snake_case field name is accepted as is. */
const PARAM_KEY_ALIASES: Record<string, string> = { maxStops: 'max_stops', showWhen: 'show_when' }
const SNAKE_FIELDS = new Set(['uniform', 'label', 'type', 'default', 'min', 'max', 'step', 'options', 'max_stops', 'show_when'])
/** Dataclass field → the payload's camelCase name (`_PARAM_KEY_TO_MANIFEST`). */
const FIELD_TO_MANIFEST: Record<string, string> = { max_stops: 'maxStops', show_when: 'showWhen' }

/** `EffectParam(**{...})`, returned as the payload dict (`_param_payload`). */
function effectParam(raw: unknown): Record<string, Json> {
  if (!isObj(raw)) throw new TypeError('argument after ** must be a mapping')
  const given: Record<string, Json> = {}
  for (const [k, v] of Object.entries(raw)) {
    const field = PARAM_KEY_ALIASES[k] ?? k
    if (!SNAKE_FIELDS.has(field)) throw new TypeError(`EffectParam.__init__() got an unexpected keyword argument '${field}'`)
    given[FIELD_TO_MANIFEST[field] ?? field] = v
  }
  const missing = PARAM_REQUIRED.filter(f => !(f in given))
  if (missing.length) {
    const names = missing.map(n => `'${n}'`)
    const list = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`
    throw new TypeError(`EffectParam.__init__() missing ${missing.length} required positional argument${missing.length === 1 ? '' : 's'}: ${list}`)
  }
  const out: Record<string, Json> = {}
  for (const f of PARAM_FIELDS) out[f] = f in given ? given[f] : PARAM_DEFAULTS[f]
  return out
}

function validateParam(eid: string, p: Record<string, Json>): void {
  const u = p.uniform
  if (p.type === 'enum') {
    // `[o["value"] for o in (p.options or [])]` — iterating a dict walks its keys.
    const options = p.options
    const iterable = !options || (typeof options === 'object' && !Object.keys(options).length) ? [] : isObj(options) ? Object.keys(options) : [...options]
    const values = iterable.map((o: Json) => item(o, 'value'))
    if (!values.length) throw new Error(`shader_effects '${eid}': enum ${u} has no options`)
    if (!values.some((v: Json) => pyEq(v, p.default))) throw new Error(`shader_effects '${eid}': enum default for ${u} not an option`)
  }
  else if (p.type === 'color') {
    try { parseHex(p.default) }
    catch { throw new Error(`shader_effects '${eid}': color default for ${u} is not a hex colour`) }
  }
  else if (p.type === 'gradient') {
    const stops = p.default
    if (!Array.isArray(stops) || stops.length < 2) throw new Error(`shader_effects '${eid}': gradient ${u} needs at least 2 stops`)
    if (!pyLe(stops.length, p.maxStops)) throw new Error(`shader_effects '${eid}': gradient ${u} has more than maxStops=${p.maxStops} stops`)
    for (const s of stops) {
      try { parseHex(item(s, 'color')) }
      catch { throw new Error(`shader_effects '${eid}': gradient ${u} has a bad stop colour`) }
      const pos = pyFloat(item(s, 'pos'))
      if (!(pos >= 0.0 && pos <= 1.0)) throw new Error(`shader_effects '${eid}': gradient ${u} stop pos outside [0, 1]`)
    }
  }
  else if (!(pyLe(p.min, p.default) && pyLe(p.default, p.max))) {
    throw new Error(`shader_effects '${eid}': default for ${u} outside [min, max]`)
  }
}

/** `_texture_version` — the asset's whole-second mtime, "0" when it can't be read. */
function textureVersion(dir: string, fname: string): string {
  try {
    const st = fs.statSync(pyJoin(path.join(dir, 'assets'), fname), { bigint: true })
    return String(st.mtimeNs / 1_000_000_000n)
  }
  catch {
    return '0'
  }
}

/**
 * `catalog_payload()` — `load_catalog(refresh=True)` plus the payload
 * mapping. Throws, with the Python's message, where the Python raises.
 */
export function catalogPayload(dir: string): { version: Json, effects: Json[] } {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const effects = new Map<string, Json>()
  for (const entry of item(manifest, 'effects')) {
    const eid = item(entry, 'id')
    if (effects.has(eid)) throw new Error(`shader_effects manifest: duplicate effect id '${eid}'`)
    const fragPath = path.join(dir, `${eid}.frag`)
    if (!isFile(fragPath)) throw new Error(`shader_effects manifest: missing shader file for '${eid}'`)
    const source = readText(fragPath)
    const params = [...item(entry, 'params')].map(effectParam)
    for (const p of params) validateParam(eid, p)
    effects.set(eid, {
      id: eid,
      name: item(entry, 'name'),
      category: item(entry, 'category'),
      animated: item(entry, 'animated'),
      passes: get(entry, 'passes', 1),
      generative: get(entry, 'generative', false),
      followsShape: get(entry, 'followsShape', false),
      centerParam: get(entry, 'centerParam', null),
      textures: get(entry, 'textures', []),
      params,
      source,
    })
  }
  const version = item(manifest, 'version')
  const out: Json[] = []
  for (const eff of effects.values()) {
    out.push({
      id: eff.id,
      name: eff.name,
      category: eff.category,
      animated: eff.animated,
      passes: eff.passes,
      generative: eff.generative,
      followsShape: eff.followsShape,
      centerParam: eff.centerParam,
      textures: [...eff.textures].map((t: Json) => ({ ...t, v: textureVersion(dir, item(t, 'file')) })),
      params: eff.params,
      source: eff.source,
    })
  }
  return { version, effects: out }
}

/** `_get_shader_effects`. */
export function shaderEffectsRoute(dir: string): CatalogResult {
  try {
    return { status: 200, body: catalogPayload(dir) }
  }
  catch (e) {
    return { status: 500, body: { error: e instanceof Error ? e.message : String(e) } }
  }
}

// ------------------------------------------------------------------- assets

/** `mimetypes.guess_type` for the kinds of file the assets folder holds; aiohttp's fallback otherwise. */
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.py': 'text/x-python',
  '.bin': 'application/octet-stream',
}

/** RFC 7231 IMF-fixdate, as aiohttp writes Last-Modified. */
function httpDate(ms: number): string {
  return new Date(ms).toUTCString()
}

/** aiohttp's `ETag` for a FileResponse: `"<mtime_ns hex>-<size hex>"`. */
export function fileEtag(st: fs.BigIntStats): string {
  return `"${st.mtimeNs.toString(16)}-${st.size.toString(16)}"`
}

/**
 * `_get_shader_asset`: `web.FileResponse(path, headers={"Cache-Control": "no-cache"})`.
 * The name is reduced to its last path segment first (`os.path.basename`).
 * FileResponse's conditional GET is honoured (If-None-Match, else
 * If-Modified-Since → 304), so the browser's revalidation works as before.
 */
export function shaderAssetRoute(dir: string, rawName: string, requestHeader: (name: string) => string | undefined): CatalogResult {
  const name = rawName.slice(rawName.lastIndexOf('/') + 1)
  const assets = path.join(dir, 'assets')
  const file = pyJoin(assets, name)
  let st: fs.BigIntStats | null = null
  try { st = fs.statSync(file, { bigint: true }) }
  catch {}
  if (!st || !st.isFile()) return { status: 404, body: { error: 'not found' } }

  const etag = fileEtag(st)
  const mtimeMs = Number(st.mtimeNs) / 1e6
  const headers: Record<string, string> = {
    'cache-control': 'no-cache',
    'etag': etag,
    // aiohttp writes `time.gmtime(math.ceil(st_mtime))`: whole seconds, rounded up.
    'last-modified': httpDate(Math.ceil(mtimeMs / 1000) * 1000),
    'accept-ranges': 'bytes',
  }
  const inm = requestHeader('if-none-match')
  if (inm !== undefined) {
    const tags = inm.split(',').map(t => t.trim().replace(/^W\//, ''))
    if (tags.includes('*') || tags.includes(etag)) return { status: 304, body: Buffer.alloc(0), headers }
  }
  else {
    const ims = Date.parse(requestHeader('if-modified-since') ?? '')
    if (Number.isFinite(ims) && mtimeMs <= ims) return { status: 304, body: Buffer.alloc(0), headers }
  }
  const dot = name.lastIndexOf('.')
  headers['content-type'] = (dot > 0 ? MIME[name.slice(dot).toLowerCase()] : undefined) ?? 'application/octet-stream'
  return { status: 200, body: fs.readFileSync(file), headers }
}
