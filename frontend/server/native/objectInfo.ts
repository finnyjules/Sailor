/**
 * `/object_info` — the node definitions — served by Sailor itself, from
 * Sailor's own node catalogue (`server/assets/nodeCatalog.json.gz`). Step 4,
 * C6: there is no engine and no saved engine copy; the catalogue file is the
 * only source. It holds:
 *
 *   - every class the runner takes (shared/runner/eligibility.ts) and the
 *     cards made in their own editor (the Timeline);
 *   - every retired class (shared/runner/retired.ts), so an old project draws
 *     its retired card and is refused by name;
 *   - the few stock classes saved projects hold
 *     (shared/runner/stockClasses.ts `CATALOGUED_STOCK_CLASSES`), so their
 *     cards keep their names and settings and a run is refused naming them.
 *
 * Each entry keeps ComfyUI's `/object_info` shape, so the canvas reads it
 * unchanged. Every file-list combo it knows how to rebuild is refreshed from
 * disk on each request:
 *
 *   - the input-derived combos (`UPLOAD_INPUT_LISTS`): each node's own listing
 *     of `input/`;
 *   - the LoRA pickers (`MODEL_INPUT_LISTS`): the LoRA library
 *     (`library/loras`, server/utils/library.ts), with the same extensions,
 *     the recursive walk and the sort as ComfyUI's picker had.
 *
 * Every other byte of the served catalogue is left as it is in the file,
 * except Sailor's model menus, laid over every body served (`withModelOverlay`).
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { resolveEngineRoot } from '../utils/inputUploads'
import { libraryDirs } from '../utils/library'
import { PY_ENCODING_SUFFIXES, PY_MIME_TOP, PY_SUFFIX_MAP } from './pyMimeTypes'
import { isDir, isFile } from './paths'
import { applyModelOverlay } from '../../shared/runner/modelMenus'
import { runnerFamilies } from '../runner/config'

type Catalog = Record<string, any>

/** The paths served here (boundary-matched by the router). */
export const OBJECT_INFO_PREFIXES = ['/object_info']

// ------------------------------------------------------------ Python helpers

/** Python `sorted()` on str: code point order (JS `<` compares UTF-16 units). */
function pyCompare(a: string, b: string): number {
  if (a === b) return 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x === y) continue
    const xs = x >= 0xD800 && x <= 0xDFFF
    const ys = y >= 0xD800 && y <= 0xDFFF
    if (xs === ys) return x - y
    // A surrogate (astral code point) sorts above every BMP unit.
    return xs ? 1 : -1
  }
  return a.length - b.length
}

export function pySorted(items: Iterable<string>): string[] {
  return [...items].sort(pyCompare)
}

/** `posixpath.splitext`: leading dots of the last component are not an extension. */
export function pySplitext(p: string): [string, string] {
  const sepIndex = p.lastIndexOf('/')
  const dotIndex = p.lastIndexOf('.')
  if (dotIndex > sepIndex) {
    for (let i = sepIndex + 1; i < dotIndex; i++) {
      if (p[i] !== '.') return [p.slice(0, dotIndex), p.slice(dotIndex)]
    }
  }
  return [p, '']
}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/

/**
 * The top-level type of `mimetypes.guess_type(name, strict=False)`, or null.
 * `urlparse` runs first: a name that parses with a scheme longer than one
 * letter is typed by its URL path (so `a:b.png` → `b.png`).
 */
export function pyGuessTopType(name: string): string | null {
  let url = name
  const colon = url.indexOf(':')
  if (colon > 1 && /^[A-Za-z]/.test(url) && SCHEME_CHARS.test(url.slice(0, colon))) {
    const scheme = url.slice(0, colon).toLowerCase()
    let rest = url.slice(colon + 1)
    if (scheme === 'data') {
      const comma = rest.indexOf(',')
      if (comma < 0) return null
      const semi = rest.slice(0, comma).indexOf(';')
      let type = semi >= 0 ? rest.slice(0, semi) : rest.slice(0, comma)
      if (type.includes('=') || !type.includes('/')) type = 'text/plain'
      return type.split('/')[0]!
    }
    if (rest.startsWith('//')) {
      const end = rest.slice(2).search(/[/?#]/)
      rest = end < 0 ? '' : rest.slice(2 + end)
    }
    const hash = rest.indexOf('#')
    if (hash >= 0) rest = rest.slice(0, hash)
    const q = rest.indexOf('?')
    if (q >= 0) rest = rest.slice(0, q)
    url = rest
  }
  let [base, ext] = pySplitext(url)
  while (PY_SUFFIX_MAP[ext.toLowerCase()] !== undefined) {
    ;[base, ext] = pySplitext(base + PY_SUFFIX_MAP[ext.toLowerCase()])
  }
  if (PY_ENCODING_SUFFIXES.has(ext)) [base, ext] = pySplitext(base)
  return PY_MIME_TOP.get(ext.toLowerCase()) ?? null
}

/**
 * `folder_paths.extension_mimetypes_cache`: process-wide, keyed by the text
 * after the last dot (case sensitive), seeded as the Python seeds it.
 */
const extensionTypeCache = new Map<string, string>([['webp', 'image'], ['fbx', 'model']])

/** `folder_paths.filter_files_content_types`, cache and all. */
export function pyFilterFilesContentTypes(files: string[], contentTypes: string[]): string[] {
  const out: string[] = []
  for (const file of files) {
    const extension = file.split('.').pop()!
    let type = extensionTypeCache.get(extension)
    if (type === undefined) {
      const guessed = pyGuessTopType(file)
      if (!guessed) continue
      type = guessed
      extensionTypeCache.set(extension, type)
    }
    if (contentTypes.includes(type)) out.push(file)
  }
  return out
}

/**
 * `os.listdir` (every entry name), or null when the folder can't be read.
 * Not paths.ts `listdirEntries`: this one is sorted (fs.readdirSync) and
 * never throws, which the recursive walk below relies on.
 */
function listdir(dir: string): fs.Dirent[] | null {
  try { return fs.readdirSync(dir, { withFileTypes: true }) }
  catch { return null }
}

/** `os.path.isfile(join(dir, entry))` without a stat for plain entries. */
function direntIsFile(dir: string, e: fs.Dirent): boolean {
  if (e.isFile()) return true
  return e.isSymbolicLink() && isFile(path.join(dir, e.name))
}

// ------------------------------------------------------ the LoRA library

/** The extensions the LoRA pickers list (ComfyUI's `supported_pt_extensions`). */
export const LORA_EXTENSIONS = ['.ckpt', '.pt', '.pt2', '.bin', '.pth', '.safetensors', '.pkl', '.sft']

/**
 * `folder_paths.recursive_search(directory, excluded_dir_names)`'s file list:
 * `os.walk(followlinks=True)` relative paths. A symlink loop is walked once.
 */
function recursiveSearch(directory: string, excluded: string[]): string[] {
  if (!isDir(directory)) return []
  const result: string[] = []
  const seen = new Set<string>()
  const walk = (dir: string, rel: string) => {
    let real: string
    try { real = fs.realpathSync.native(dir) }
    catch { return }
    if (seen.has(real)) return
    seen.add(real)
    const entries = listdir(dir)
    if (!entries) return
    const subdirs: string[] = []
    for (const e of entries) {
      const full = path.join(dir, e.name)
      const dirLike = e.isDirectory() || (e.isSymbolicLink() && isDir(full))
      if (dirLike) subdirs.push(e.name)
      else result.push(rel ? `${rel}/${e.name}` : e.name)
    }
    for (const d of subdirs) {
      if (excluded.includes(d)) continue
      walk(path.join(dir, d), rel ? `${rel}/${d}` : d)
    }
  }
  walk(directory, '')
  return result
}

/**
 * The LoRA pickers' file list (step 4, C6b): every LoRA file in the library
 * (`<root>/library/loras`, server/utils/library.ts, plus the old folder while
 * it still exists beside it), walked recursively and sorted as ComfyUI's
 * `get_filename_list("loras")` did. None when the root is unknown.
 */
export function listLoraFiles(root: string | null): string[] {
  if (!root) return []
  const out = new Set<string>()
  for (const dir of libraryDirs('loras', root)) {
    for (const f of recursiveSearch(dir, ['.git'])) {
      if (LORA_EXTENSIONS.includes(pySplitext(f)[1].toLowerCase())) out.add(f)
    }
  }
  return pySorted(out)
}

// ------------------------------------------------------- the combo tables

/**
 * LoRA pickers: `Class.input` → the library kind behind it (only `loras`; plus
 * the literal entries the node appends). Each row was read off the node's own
 * source (comfy_api_nodes/nodes_replicate.py); `native-object-info.unit.spec.ts`
 * checks every row against the catalogue so a renamed node or input shows up
 * as a failure.
 */
export const MODEL_INPUT_LISTS: Record<string, { folder: 'loras', append?: string[] }> = {
  'FluxLoRARemoteNode.lora_name': { folder: 'loras', append: ['[None]'] },
  'FluxMultiLoRARemoteNode.lora_a': { folder: 'loras', append: ['[None]'] },
  'FluxMultiLoRARemoteNode.lora_b': { folder: 'loras', append: ['[None]'] },
  'FluxMultiLoRARemoteNode.lora_c': { folder: 'loras', append: ['[None]'] },
  'FluxMultiLoRARemoteNode.lora_d': { folder: 'loras', append: ['[None]'] },
  'RestyleWithLoRANode.lora_name': { folder: 'loras', append: ['[None]'] },
}

/** One listing of `input/`, shared by every input-derived combo in a request. */
interface InputListing {
  /** `os.listdir(input_dir)`, in directory order. */
  names: string[]
  /** The same names filtered by `os.path.isfile`. */
  files: string[]
}

const EMPTY_INPUT: InputListing = { names: [], files: [] }

function listInput(inputDir: string): InputListing {
  const entries = listdir(inputDir)
  if (!entries) return EMPTY_INPUT
  return {
    names: entries.map(e => e.name),
    files: entries.filter(e => direntIsFile(inputDir, e)).map(e => e.name),
  }
}

/**
 * Input-derived combos: `Class.input` → the node's own listing of `input/`,
 * and whether its `default` is seeded from that listing. Ported one by one:
 * nodes.py LoadImage, nodes_image.py Image, nodes_audio.py LoadAudio / Audio,
 * nodes_video.py LoadVideo / Video, nodes_video_effects.py LoadVideoFrames /
 * SaveVideoFrames, nodes_timeline.py Timeline, nodes_video_pro.py
 * AudioWaveform. (LoadImageOutput and Painter carry the upload flag but no
 * inline list.)
 */
export const UPLOAD_INPUT_LISTS: Record<string, { list: (l: InputListing) => string[], seedsDefault?: true }> = {
  'LoadImage.image': { list: l => pySorted(pyFilterFilesContentTypes(l.files, ['image'])) },
  'Image.image': { list: l => ['', ...pySorted(pyFilterFilesContentTypes(pySorted(l.files), ['image']))] },
  'LoadAudio.audio': { list: l => pySorted(pyFilterFilesContentTypes(l.names, ['audio', 'video'])) },
  'Audio.audio': { list: l => ['', ...pySorted(pyFilterFilesContentTypes(l.names, ['audio', 'video']))] },
  'LoadVideo.file': { list: l => pySorted(pyFilterFilesContentTypes(l.files, ['video'])) },
  'Video.file': { list: l => ['', ...pySorted(pyFilterFilesContentTypes(l.files, ['video']))] },
  'LoadVideoFrames.file': { list: l => pySorted(pyFilterFilesContentTypes(l.files, ['video'])) },
  'SaveVideoFrames.audio_file': { list: l => ['(none)', ...pySorted(pyFilterFilesContentTypes(l.files, ['audio']))] },
  'Timeline.audio_file': { list: l => ['(none)', ...pySorted(pyFilterFilesContentTypes(l.files, ['audio']))] },
  'AudioWaveform.audio_file': {
    list: (l) => {
      const files = pySorted(pyFilterFilesContentTypes(l.files, ['audio']))
      return files.length ? files : ['(no audio found)']
    },
    seedsDefault: true,
  },
}

/** Replace a combo's option list in place — legacy `[[...], opts]` or v2 `["COMBO", {options}]`. */
export function setComboOptions(spec: unknown, options: string[], seedsDefault: boolean): void {
  if (!Array.isArray(spec)) return
  const opts = spec[1] && typeof spec[1] === 'object' && !Array.isArray(spec[1]) ? spec[1] as Record<string, unknown> : null
  if (Array.isArray(spec[0])) spec[0] = options
  else if (opts && Array.isArray(opts.options)) opts.options = options
  else return
  if (seedsDefault && opts && 'default' in opts) opts.default = options[0]
}

/** The input spec `Class.input` names in `catalog` (any section), or undefined. */
export function findSpec(catalog: Catalog, key: string): unknown {
  const dot = key.indexOf('.')
  const node = catalog[key.slice(0, dot)]
  const input = key.slice(dot + 1)
  const sections = node?.input
  if (!sections || typeof sections !== 'object') return undefined
  for (const section of Object.values(sections)) {
    if (section && typeof section === 'object' && !Array.isArray(section) && input in section) {
      return (section as Record<string, unknown>)[input]
    }
  }
  return undefined
}

/**
 * Rebuild, in place, every file-list combo in `catalog` that ComfyUI lists
 * from disk and that this module knows how to list: the input-derived ones
 * from `<root>/input`, the LoRA pickers from the library (`listLoraFiles`).
 * A null root lists nothing — exactly what ComfyUI shows for empty folders.
 */
export function refreshFileLists(catalog: Catalog, root: string | null): Catalog {
  let input: InputListing | undefined
  for (const [key, { list, seedsDefault }] of Object.entries(UPLOAD_INPUT_LISTS)) {
    const spec = findSpec(catalog, key)
    if (spec === undefined) continue
    input ??= root ? listInput(path.join(root, 'input')) : EMPTY_INPUT
    setComboOptions(spec, list(input), Boolean(seedsDefault))
  }
  let loras: string[] | undefined
  for (const [key, rule] of Object.entries(MODEL_INPUT_LISTS)) {
    const spec = findSpec(catalog, key)
    if (spec === undefined) continue
    loras ??= listLoraFiles(root)
    setComboOptions(spec, [...loras, ...(rule.append ?? [])], false)
  }
  return catalog
}

/**
 * Every refreshed combo set to what ComfyUI shows for empty folders — the form
 * the catalogue is committed in, so it holds no machine's (or tenant's) file
 * names.
 */
export function blankFileLists(catalog: Catalog): Catalog {
  return refreshFileLists(catalog, null)
}

// ------------------------------------------------------- the node catalogue

let catalogFileOverride: string | undefined

/** Tests: point the node catalogue elsewhere. */
export function __setNodeCatalogFileForTests(file: string | undefined): void { catalogFileOverride = file }

/** The catalogue file, relative to the frontend folder. */
export const NODE_CATALOG_REL = path.join('server', 'assets', 'nodeCatalog.json.gz')
const warnedMissingCatalog = new Set<string>()

/**
 * The node catalogue file, first that exists of: `SAILOR_NODE_CATALOG`,
 * `<data root>/frontend/server/assets/…`, `<cwd>/server/assets/…`. Null (with
 * one warning per set of candidates) when none does.
 */
export function nodeCatalogFile(): string | null {
  if (catalogFileOverride !== undefined) return catalogFileOverride
  const root = resolveEngineRoot()
  const candidates = [
    process.env.SAILOR_NODE_CATALOG || null,
    root ? path.join(root, 'frontend', NODE_CATALOG_REL) : null,
    path.join(process.cwd(), NODE_CATALOG_REL),
  ].filter((c): c is string => Boolean(c))
  const found = candidates.find(c => isFile(c))
  if (found) return found
  const key = candidates.join('\n')
  if (!warnedMissingCatalog.has(key)) {
    warnedMissingCatalog.add(key)
    console.warn(`[native] object_info: no node catalogue found (looked in ${candidates.join(', ')}); set SAILOR_NODE_CATALOG`)
  }
  return null
}

let catalogMemo: { file: string, value: Catalog } | null = null

function isCatalog(v: unknown): v is Catalog {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function readCatalog(): Catalog | null {
  const file = nodeCatalogFile()
  if (!file) return null
  if (catalogMemo?.file === file) return catalogMemo.value
  try {
    const value = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'))
    if (!isCatalog(value)) return null
    catalogMemo = { file, value }
    return value
  }
  catch {
    return null
  }
}

/**
 * R11.9a fix round 1 (m5): a node class's display name, as the canvas shows it
 * (from the node catalogue), for naming a node in a refusal when the person
 * gave it no title. Null when unknown.
 */
export function objectInfoDisplayName(classType: string): string | null {
  const catalog = readCatalog()
  const entry = catalog && Object.prototype.hasOwnProperty.call(catalog, classType) ? (catalog as Record<string, { display_name?: unknown }>)[classType] : undefined
  const name = typeof entry?.display_name === 'string' ? entry.display_name.trim() : ''
  return name || null
}

// ------------------------------------------------------------ the route

export type ObjectInfoMatch =
  | { kind: 'route', node: string | null }
  | { kind: 'notFound' }
  | { kind: 'badMethod' }

/** aiohttp's two routes: GET /object_info and GET /object_info/{node_class}. */
export function matchObjectInfoRoute(p: string, method: string, decode: (seg: string) => string): ObjectInfoMatch {
  const verb = method === 'HEAD' ? 'GET' : method
  let node: string | null
  if (p === '/object_info') node = null
  else if (p.startsWith('/object_info/') && /^[^/{}]+$/.test(p.slice('/object_info/'.length))) node = decode(p.slice('/object_info/'.length))
  else return { kind: 'notFound' }
  return verb === 'GET' ? { kind: 'route', node } : { kind: 'badMethod' }
}

/**
 * The catalogue's entry for `node` (all of it when null), file lists
 * refreshed from disk. Null when the catalogue file can't be read.
 */
export function storedObjectInfoBody(node: string | null): { body: Catalog } | null {
  const stored = readCatalog()
  if (!stored) return null
  let body: Catalog
  if (node === null) body = structuredClone(stored)
  else body = Object.prototype.hasOwnProperty.call(stored, node) ? { [node]: structuredClone(stored[node]) } : {}
  const root = resolveEngineRoot()
  if (root) refreshFileLists(body, root)
  return { body }
}

/**
 * The node catalogue as committed, file lists not refreshed; null when it
 * can't be read. Read-only: the run checks read each class's outputs from it
 * (server/utils/blockedModels.ts). Memoised by readCatalog.
 */
export function storedNodeCatalog(): Readonly<Catalog> | null {
  return readCatalog()
}

export const NO_NODE_DEFINITIONS = {
  status: 503,
  body: { error: 'Sailor can’t load the node list right now.' },
}

/**
 * Sailor's model menus laid over a body about to be served
 * (shared/runner/modelMenus.ts): each covered dropdown's options, hidden list
 * and default, each gallery's default, for the runner families switched on
 * now. Copy on write: the memoised catalogue stays as it was.
 */
export function withModelOverlay(body: Catalog): Catalog {
  return applyModelOverlay(body, runnerFamilies())
}

/** The local route: the catalogue, refreshed from disk and overlaid, else 503. */
export async function runObjectInfo(_rawPath: string, _canonicalPath: string, node: string | null): Promise<{ status: number, body: unknown, headers?: Record<string, string> }> {
  const got = storedObjectInfoBody(node)
  if (!got) return NO_NODE_DEFINITIONS
  return { status: 200, body: withModelOverlay(got.body) }
}
