/**
 * `/object_info` — the node definitions — served by Sailor itself.
 *
 * While ComfyUI answers (within 3 s) its body is passed through and
 * a copy of the full catalog — file lists blanked — is kept at
 * `<storeDir('data')>/object_info.json`. While it does not (a failure is
 * remembered for 3 s), the saved copy is served — or, before one exists, the
 * committed baseline `objectInfo.baseline.json.gz`, blanked the same way —
 * with every file-list combo it knows how to rebuild refreshed from disk, the
 * way ComfyUI builds them on each request:
 *
 *   - the input-derived combos (`UPLOAD_INPUT_LISTS`): each node's own listing
 *     of `input/`, ported from its `INPUT_TYPES` / `define_schema`;
 *   - the model pickers (`MODEL_INPUT_LISTS`): `folder_paths.get_filename_list`
 *     over `models/*` plus `extra_model_paths.yaml`, with the same extensions,
 *     the legacy folder names, the recursive walk and the sort.
 *
 * Every other byte of the served catalog is left as it was saved, except
 * Sailor's model menus, laid over every body served (`withModelOverlay`).
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { resolveEngineRoot } from '../utils/inputUploads'
import { storeDir } from '../utils/dataDir'
import { resolveWorkerTarget } from '../utils/workerRoute'
import { PY_ENCODING_SUFFIXES, PY_MIME_TOP, PY_SUFFIX_MAP } from './pyMimeTypes'
import { isDir, isFile } from './paths'
import { ENGINE_MAIN_PORT, engineHealth } from './engineHealth'
import { applyModelOverlay } from '../../shared/runner/modelMenus'
import { runnerFamilies } from '../runner/config'

type Catalog = Record<string, any>

/** How long ComfyUI gets to answer before the stored copy is served. */
export const OBJECT_INFO_ENGINE_TIMEOUT_MS = 3_000

/** The paths served here (boundary-matched by the router). */
export const OBJECT_INFO_PREFIXES = ['/object_info']

const MAIN_ENGINE_PORT = ENGINE_MAIN_PORT

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

// ------------------------------------------------------ folder_paths port

const SUPPORTED_PT_EXTENSIONS = ['.ckpt', '.pt', '.pt2', '.bin', '.pth', '.safetensors', '.pkl', '.sft']

/** `folder_paths.folder_names_and_paths`: folder name → [search paths, extensions]. */
export type FolderTable = Map<string, { paths: string[], extensions: string[] }>

/** `folder_paths.map_legacy`. */
function mapLegacy(name: string): string {
  return name === 'unet' ? 'diffusion_models' : name === 'clip' ? 'text_encoders' : name
}

/** The default table folder_paths.py builds for `base_path` (custom_nodes left out). */
function defaultFolderTable(root: string): FolderTable {
  const m = (...p: string[]) => p.map(x => path.join(root, 'models', x))
  const t: FolderTable = new Map()
  const pt = SUPPORTED_PT_EXTENSIONS
  t.set('checkpoints', { paths: m('checkpoints'), extensions: pt })
  t.set('configs', { paths: m('configs'), extensions: ['.yaml'] })
  t.set('loras', { paths: m('loras'), extensions: pt })
  t.set('vae', { paths: m('vae'), extensions: pt })
  t.set('text_encoders', { paths: m('text_encoders', 'clip'), extensions: pt })
  t.set('diffusion_models', { paths: m('unet', 'diffusion_models'), extensions: pt })
  t.set('clip_vision', { paths: m('clip_vision'), extensions: pt })
  t.set('style_models', { paths: m('style_models'), extensions: pt })
  t.set('embeddings', { paths: m('embeddings'), extensions: pt })
  t.set('diffusers', { paths: m('diffusers'), extensions: ['folder'] })
  t.set('vae_approx', { paths: m('vae_approx'), extensions: pt })
  t.set('controlnet', { paths: m('controlnet', 't2i_adapter'), extensions: pt })
  t.set('gligen', { paths: m('gligen'), extensions: pt })
  t.set('upscale_models', { paths: m('upscale_models'), extensions: pt })
  t.set('latent_upscale_models', { paths: m('latent_upscale_models'), extensions: pt })
  t.set('hypernetworks', { paths: m('hypernetworks'), extensions: pt })
  t.set('photomaker', { paths: m('photomaker'), extensions: pt })
  t.set('classifiers', { paths: m('classifiers'), extensions: [''] })
  t.set('model_patches', { paths: m('model_patches'), extensions: pt })
  t.set('audio_encoders', { paths: m('audio_encoders'), extensions: pt })
  return t
}

/** `folder_paths.add_model_folder_path`. */
function addModelFolderPath(t: FolderTable, folderName: string, fullPath: string, isDefault: boolean): void {
  const name = mapLegacy(folderName)
  const entry = t.get(name)
  if (!entry) {
    t.set(name, { paths: [fullPath], extensions: [] })
    return
  }
  const i = entry.paths.indexOf(fullPath)
  if (i >= 0) {
    if (isDefault && i !== 0) {
      entry.paths.splice(i, 1)
      entry.paths.unshift(fullPath)
    }
  }
  else if (isDefault) entry.paths.unshift(fullPath)
  else entry.paths.push(fullPath)
}

/** `os.path.expanduser` + `os.path.expandvars` (unknown variables stay as written). */
function expandUserAndVars(p: string): string {
  let out = p
  if (out === '~' || out.startsWith('~/')) out = os.homedir() + out.slice(1)
  return out.replace(/\$(\w+|\{[^}]*\})/g, (whole, name: string) => {
    const key = name.startsWith('{') ? name.slice(1, -1) : name
    const v = process.env[key]
    return v === undefined ? whole : v
  })
}

type YamlValue = string | boolean | null

/** A plain YAML 1.1 scalar the way `yaml.safe_load` reads the ones this file uses. */
function yamlScalar(raw: string): YamlValue {
  const s = raw.trim()
  if (s === '' || s === '~' || /^(null|Null|NULL)$/.test(s)) return null
  if (/^(true|True|TRUE|yes|Yes|YES|on|On|ON|y|Y)$/.test(s)) return true
  if (/^(false|False|FALSE|no|No|NO|off|Off|OFF|n|N)$/.test(s)) return false
  if (s.length >= 2 && s.startsWith('\'') && s.endsWith('\'')) return s.slice(1, -1).replace(/''/g, '\'')
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return JSON.parse(s)
  return s
}

function stripComment(line: string): string {
  const m = /(^|\s)#/.exec(line)
  return m ? line.slice(0, m.index) : line
}

/**
 * The subset of YAML `extra_model_paths.yaml` is written in: top-level
 * sections, each a mapping of `key: value` or `key: |` block scalars (whose
 * lines, `#` included, are literal — as in PyYAML). Returns null for anything
 * outside that subset rather than guessing.
 */
export function parseExtraModelPathsYaml(text: string): Record<string, Record<string, YamlValue> | null> | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: Record<string, Record<string, YamlValue> | null> = {}
  let section: string | null = null
  let i = 0
  const indentOf = (l: string) => l.length - l.trimStart().length
  while (i < lines.length) {
    const line = stripComment(lines[i]!)
    if (line.trim() === '') { i++; continue }
    const indent = indentOf(line)
    const kv = /^(\s*)([^\s:#][^:]*?)\s*:(?:\s+(.*))?\s*$/.exec(line)
    if (!kv) return null
    const key = kv[2]!
    const value = (kv[3] ?? '').trim()
    if (indent === 0) {
      if (value !== '') out[key] = yamlScalar(value) as null
      else out[key] = null
      section = key
      i++
      continue
    }
    if (section === null) return null
    const conf = (out[section] ??= {})
    if (conf === null || typeof conf !== 'object') return null
    const block = /^([|>])([+-]?)$/.exec(value)
    if (!block) {
      conf[key] = yamlScalar(value)
      i++
      continue
    }
    // Block scalar: every following line indented deeper than the key (or blank).
    const body: string[] = []
    i++
    while (i < lines.length && (lines[i]!.trim() === '' || indentOf(lines[i]!) > indent)) body.push(lines[i++]!)
    while (body.length && body[body.length - 1]!.trim() === '') body.pop()
    const first = body.find(l => l.trim() !== '')
    const blockIndent = first ? indentOf(first) : 0
    const content = body.map(l => l.slice(Math.min(blockIndent, indentOf(l))))
    let joined = block[1] === '>' ? content.join(' ') : content.join('\n')
    if (block[2] !== '-' && content.length) joined += '\n'
    conf[key] = joined
  }
  return out
}

/** `utils/extra_config.load_extra_path_config` applied to `t`. */
function loadExtraPathConfig(t: FolderTable, yamlPath: string): void {
  let config: ReturnType<typeof parseExtraModelPathsYaml>
  try { config = parseExtraModelPathsYaml(fs.readFileSync(yamlPath, 'utf8')) }
  catch { return }
  if (!config) {
    console.warn(`[native] object_info: could not read ${yamlPath}; extra model folders are not listed`)
    return
  }
  const yamlDir = path.dirname(path.resolve(yamlPath))
  for (const conf of Object.values(config)) {
    if (!conf || typeof conf !== 'object') continue
    const c = { ...conf }
    let basePath: string | null = null
    if ('base_path' in c) {
      basePath = expandUserAndVars(String(c.base_path ?? ''))
      delete c.base_path
      if (basePath && !path.isAbsolute(basePath)) basePath = path.resolve(yamlDir, basePath)
    }
    let isDefault = false
    if ('is_default' in c) {
      isDefault = Boolean(c.is_default)
      delete c.is_default
    }
    for (const [folder, value] of Object.entries(c)) {
      if (typeof value !== 'string') continue
      for (const y of value.split('\n')) {
        if (y.length === 0) continue
        let full = y
        // os.path.join: an absolute second part replaces the first.
        if (basePath) full = path.isAbsolute(y) ? y : path.join(basePath, y)
        else if (!path.isAbsolute(full)) full = path.resolve(yamlDir, y)
        addModelFolderPath(t, folder, path.normalize(full), isDefault)
      }
    }
  }
}

/** folder_paths' table for the engine at `root`, with `<root>/extra_model_paths.yaml` applied. */
export function modelFolderTable(root: string): FolderTable {
  const t = defaultFolderTable(root)
  const yamlPath = path.join(root, 'extra_model_paths.yaml')
  if (isFile(yamlPath)) loadExtraPathConfig(t, yamlPath)
  return t
}

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

/** `folder_paths.get_filename_list(folder_name)`. */
export function getFilenameList(t: FolderTable, folderName: string): string[] {
  const entry = t.get(mapLegacy(folderName))
  if (!entry) return []
  const out = new Set<string>()
  for (const dir of entry.paths) {
    for (const f of recursiveSearch(dir, ['.git'])) {
      if (entry.extensions.length === 0 || entry.extensions.includes(pySplitext(f)[1].toLowerCase())) out.add(f)
    }
  }
  return pySorted(out)
}

/** `VAELoader.vae_list` (nodes.py). */
function vaeList(t: FolderTable): string[] {
  const videoTaes = ['taehv', 'lighttaew2_2', 'lighttaew2_1', 'lighttaehy1_5', 'taeltx_2']
  const vaes = getFilenameList(t, 'vae')
  const approx = getFilenameList(t, 'vae_approx')
  const seen = { sd1e: false, sd1d: false, sdxle: false, sdxld: false, sd3e: false, sd3d: false, f1e: false, f1d: false }
  for (const v of approx) {
    if (v.startsWith('taesd_decoder.')) seen.sd1d = true
    else if (v.startsWith('taesd_encoder.')) seen.sd1e = true
    else if (v.startsWith('taesdxl_decoder.')) seen.sdxld = true
    else if (v.startsWith('taesdxl_encoder.')) seen.sdxle = true
    else if (v.startsWith('taesd3_decoder.')) seen.sd3d = true
    else if (v.startsWith('taesd3_encoder.')) seen.sd3e = true
    // Crossed on purpose: nodes.py sets f1 "dec" on the encoder file and vice versa.
    else if (v.startsWith('taef1_encoder.')) seen.f1d = true
    else if (v.startsWith('taef1_decoder.')) seen.f1e = true
    else {
      for (const tae of videoTaes) {
        if (v.startsWith(tae)) vaes.push(v)
      }
    }
  }
  if (seen.sd1d && seen.sd1e) vaes.push('taesd')
  if (seen.sdxld && seen.sdxle) vaes.push('taesdxl')
  if (seen.sd3d && seen.sd3e) vaes.push('taesd3')
  if (seen.f1d && seen.f1e) vaes.push('taef1')
  vaes.push('pixel_space')
  return vaes
}

// ------------------------------------------------------- the combo tables

/**
 * Model pickers: `Class.input` → the `get_filename_list` folder behind it
 * (plus the literal entries the node appends). Each row was read off the node's
 * own source; `native-object-info.unit.spec.ts` checks every row against the
 * committed baseline so a renamed node or input shows up as a failure.
 */
export const MODEL_INPUT_LISTS: Record<string, { folder: string, append?: string[] } | 'vae_list'> = {
  // nodes.py
  'CheckpointLoader.config_name': { folder: 'configs' },
  'CheckpointLoader.ckpt_name': { folder: 'checkpoints' },
  'CheckpointLoaderSimple.ckpt_name': { folder: 'checkpoints' },
  'unCLIPCheckpointLoader.ckpt_name': { folder: 'checkpoints' },
  'LoraLoader.lora_name': { folder: 'loras' },
  'LoraLoaderModelOnly.lora_name': { folder: 'loras' },
  'VAELoader.vae_name': 'vae_list',
  'ControlNetLoader.control_net_name': { folder: 'controlnet' },
  'DiffControlNetLoader.control_net_name': { folder: 'controlnet' },
  'UNETLoader.unet_name': { folder: 'diffusion_models' },
  'CLIPLoader.clip_name': { folder: 'text_encoders' },
  'DualCLIPLoader.clip_name1': { folder: 'text_encoders' },
  'DualCLIPLoader.clip_name2': { folder: 'text_encoders' },
  'CLIPVisionLoader.clip_name': { folder: 'clip_vision' },
  'StyleModelLoader.style_model_name': { folder: 'style_models' },
  'GLIGENLoader.gligen_name': { folder: 'gligen' },
  // comfy_extras
  'ImageOnlyCheckpointLoader.ckpt_name': { folder: 'checkpoints' },
  'UpscaleModelLoader.model_name': { folder: 'upscale_models' },
  'LatentUpscaleModelLoader.model_name': { folder: 'latent_upscale_models' },
  'CreateHookLora.lora_name': { folder: 'loras' },
  'CreateHookLoraModelOnly.lora_name': { folder: 'loras' },
  'CreateHookModelAsLora.ckpt_name': { folder: 'checkpoints' },
  'CreateHookModelAsLoraModelOnly.ckpt_name': { folder: 'checkpoints' },
  'TripleCLIPLoader.clip_name1': { folder: 'text_encoders' },
  'TripleCLIPLoader.clip_name2': { folder: 'text_encoders' },
  'TripleCLIPLoader.clip_name3': { folder: 'text_encoders' },
  'QuadrupleCLIPLoader.clip_name1': { folder: 'text_encoders' },
  'QuadrupleCLIPLoader.clip_name2': { folder: 'text_encoders' },
  'QuadrupleCLIPLoader.clip_name3': { folder: 'text_encoders' },
  'QuadrupleCLIPLoader.clip_name4': { folder: 'text_encoders' },
  'AudioEncoderLoader.audio_encoder_name': { folder: 'audio_encoders' },
  'LoraLoaderBypass.lora_name': { folder: 'loras' },
  'LoraLoaderBypassModelOnly.lora_name': { folder: 'loras' },
  'ModelPatchLoader.name': { folder: 'model_patches' },
  'PhotoMakerLoader.photomaker_model_name': { folder: 'photomaker' },
  'HypernetworkLoader.hypernetwork_name': { folder: 'hypernetworks' },
  'TrainLoraNode.existing_lora': { folder: 'loras', append: ['[None]'] },
  'LTXVAudioVAELoader.ckpt_name': { folder: 'checkpoints' },
  'LTXAVTextEncoderLoader.text_encoder': { folder: 'text_encoders' },
  'LTXAVTextEncoderLoader.ckpt_name': { folder: 'checkpoints' },
  // comfy_api_nodes/nodes_replicate.py
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
  /** `Load3D`'s rglob of `input/3d`, relative to input/. */
  load3d: () => string[]
  /** `folder_paths.get_input_subfolders()`. */
  subfolders: () => string[]
}

const EMPTY_INPUT: InputListing = { names: [], files: [], load3d: () => [], subfolders: () => [] }

function listInput(inputDir: string): InputListing {
  const entries = listdir(inputDir)
  if (!entries) return EMPTY_INPUT
  return {
    names: entries.map(e => e.name),
    files: entries.filter(e => direntIsFile(inputDir, e)).map(e => e.name),
    load3d: () => load3dFiles(inputDir),
    subfolders: () => inputSubfolders(inputDir),
  }
}

const LOAD_3D_SUFFIXES = new Set(['.gltf', '.glb', '.obj', '.fbx', '.stl', '.spz', '.splat', '.ply', '.ksplat'])

/** `Path.suffix`. */
function pathSuffix(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 && i < name.length - 1 ? name.slice(i) : ''
}

/** Load3D: `Path(input/3d).rglob("*")` (symlinked folders not descended), relative to input/. */
function load3dFiles(inputDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    const entries = listdir(dir)
    if (!entries) return
    for (const e of entries) {
      const r = `${rel}/${e.name}`
      if (LOAD_3D_SUFFIXES.has(pathSuffix(e.name).toLowerCase())) out.push(r)
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
    }
  }
  walk(path.join(inputDir, '3d'), '3d')
  return pySorted(out)
}

/**
 * `folder_paths.get_input_subfolders()`: every folder `os.walk(input_dir)`
 * visits (symlinked folders are not followed; an unreadable one is skipped),
 * relative, `/`-separated, sorted, the input folder itself left out.
 */
export function inputSubfolders(inputDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string) => {
    const entries = listdir(dir)
    if (!entries) return
    if (rel) out.push(rel)
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
    }
  }
  walk(inputDir, '')
  return pySorted(out)
}

/**
 * Input-derived combos: `Class.input` → the node's own listing of `input/`,
 * and whether its `default` is seeded from that listing. Ported one by one:
 * nodes.py LoadImage / LoadImageMask, nodes_image.py Image, nodes_audio.py
 * LoadAudio / Audio, nodes_load_3d.py Load3D, nodes_video.py LoadVideo /
 * Video, nodes_video_effects.py LoadVideoFrames / SaveVideoFrames,
 * nodes_timeline.py Timeline, nodes_video_pro.py AudioWaveform, and
 * nodes_dataset.py's two folder pickers (`get_input_subfolders`).
 * (LoadImageOutput and Painter carry the upload flag but no inline list.)
 */
export const UPLOAD_INPUT_LISTS: Record<string, { list: (l: InputListing) => string[], seedsDefault?: true }> = {
  'LoadImage.image': { list: l => pySorted(pyFilterFilesContentTypes(l.files, ['image'])) },
  'LoadImageMask.image': { list: l => pySorted(l.files) },
  'Image.image': { list: l => ['', ...pySorted(pyFilterFilesContentTypes(pySorted(l.files), ['image']))] },
  'LoadAudio.audio': { list: l => pySorted(pyFilterFilesContentTypes(l.names, ['audio', 'video'])) },
  'Audio.audio': { list: l => ['', ...pySorted(pyFilterFilesContentTypes(l.names, ['audio', 'video']))] },
  'Load3D.model_file': { list: l => l.load3d() },
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
  'LoadImageDataSetFromFolder.folder': { list: l => l.subfolders() },
  'LoadImageTextDataSetFromFolder.folder': { list: l => l.subfolders() },
}

/**
 * The input-folder combos that are NOT upload-flagged, so the hosted scrub's
 * flag rule misses them: they list `input/`'s subfolders, which are shared
 * across tenants. Hosted empties them (engineGate.ts scrubObjectInfo).
 */
export const INPUT_FOLDER_INPUTS = ['LoadImageDataSetFromFolder.folder', 'LoadImageTextDataSetFromFolder.folder']

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
 * from `<root>/input`, the model pickers from `<root>/models` (+ extra paths).
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
  let table: FolderTable | undefined
  const lists = new Map<string, string[]>()
  for (const [key, rule] of Object.entries(MODEL_INPUT_LISTS)) {
    const spec = findSpec(catalog, key)
    if (spec === undefined) continue
    table ??= root ? modelFolderTable(root) : new Map()
    const cacheKey = rule === 'vae_list' ? '\0vae_list' : rule.folder
    let files = lists.get(cacheKey)
    if (!files) {
      files = rule === 'vae_list' ? vaeList(table) : getFilenameList(table, rule.folder)
      lists.set(cacheKey, files)
    }
    setComboOptions(spec, rule === 'vae_list' ? [...files] : [...files, ...(rule.append ?? [])], false)
  }
  return catalog
}

/**
 * Every refreshed combo set to what ComfyUI shows for empty folders — the form
 * the baseline is committed in and the saved copy is written in, so neither
 * holds this machine's (or any tenant's) file names.
 */
export function blankFileLists(catalog: Catalog): Catalog {
  return refreshFileLists(catalog, null)
}

// ------------------------------------------------------- stored catalogs

let cacheFileOverride: string | undefined
let baselineFileOverride: string | undefined

/** Tests: redirect the saved copy (never the real `.data/`). */
export function __setObjectInfoCacheFileForTests(file: string | undefined): void { cacheFileOverride = file }
/** Tests: point the committed baseline elsewhere. */
export function __setObjectInfoBaselineFileForTests(file: string | undefined): void { baselineFileOverride = file }

/** Where the live copy is saved. Null inside a test run that has not redirected it. */
export function objectInfoCacheFile(): string | null {
  if (cacheFileOverride !== undefined) return cacheFileOverride
  if (process.env.VITEST) return null
  return path.join(storeDir('data'), 'object_info.json')
}

const BASELINE_REL = path.join('server', 'native', 'objectInfo.baseline.json.gz')
const warnedMissingBaseline = new Set<string>()

/**
 * The committed baseline, first that exists of: `SAILOR_OBJECT_INFO_BASELINE`,
 * `<engine root>/frontend/server/native/…`, `<cwd>/server/native/…`. Null (with
 * one warning per set of candidates) when none does.
 */
export function objectInfoBaselineFile(): string | null {
  if (baselineFileOverride !== undefined) return baselineFileOverride
  const root = resolveEngineRoot()
  const candidates = [
    process.env.SAILOR_OBJECT_INFO_BASELINE || null,
    root ? path.join(root, 'frontend', BASELINE_REL) : null,
    path.join(process.cwd(), BASELINE_REL),
  ].filter((c): c is string => Boolean(c))
  const found = candidates.find(c => isFile(c))
  if (found) return found
  const key = candidates.join('\n')
  if (!warnedMissingBaseline.has(key)) {
    warnedMissingBaseline.add(key)
    console.warn(`[native] object_info: no node-list baseline found (looked in ${candidates.join(', ')}); set SAILOR_OBJECT_INFO_BASELINE`)
  }
  return null
}

let savedMemo: { file: string, mtimeMs: number, size: number, value: Catalog } | null = null
let baselineMemo: { file: string, value: Catalog } | null = null
let lastWritten: { file: string, text: string } | null = null
let pendingSave: Promise<void> = Promise.resolve()

function isCatalog(v: unknown): v is Catalog {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function readSaved(): Catalog | null {
  const file = objectInfoCacheFile()
  if (!file) return null
  let st: fs.Stats
  try { st = fs.statSync(file) }
  catch { return null }
  if (savedMemo && savedMemo.file === file && savedMemo.mtimeMs === st.mtimeMs && savedMemo.size === st.size) return savedMemo.value
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!isCatalog(value)) return null
    savedMemo = { file, mtimeMs: st.mtimeMs, size: st.size, value }
    return value
  }
  catch {
    return null
  }
}

function readBaseline(): Catalog | null {
  const file = objectInfoBaselineFile()
  if (!file) return null
  if (baselineMemo?.file === file) return baselineMemo.value
  try {
    const value = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'))
    if (!isCatalog(value)) return null
    baselineMemo = { file, value }
    return value
  }
  catch {
    return null
  }
}

/**
 * Keep the engine's full catalog, lists blanked, for the next time it is down
 * (atomic; skipped when unchanged). Runs after the response, never before it.
 */
async function saveCopy(body: Catalog): Promise<void> {
  const file = objectInfoCacheFile()
  if (!file) return
  const text = JSON.stringify(blankFileLists(structuredClone(body)))
  if (lastWritten && lastWritten.file === file && lastWritten.text === text && fs.existsSync(file)) return
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.promises.writeFile(tmp, text)
    await fs.promises.rename(tmp, file)
    lastWritten = { file, text }
  }
  catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

function saveCopyInBackground(body: Catalog): void {
  pendingSave = pendingSave
    .then(() => saveCopy(body))
    .catch((e) => { console.warn('[native] object_info: could not save a copy', e) })
}

/** Tests: wait for the background save to land. */
export function __objectInfoSaveSettledForTests(): Promise<void> { return pendingSave }

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

export type ObjectInfoBody =
  /** The engine's answer: its exact text, and the parsed catalog when it is plain JSON. */
  | { source: 'engine', text: string, body: Catalog | null }
  | { source: 'saved' | 'baseline', body: Catalog }

/** Ports that just failed to answer, and until when they are taken as down. */
const engineDownUntil = new Map<number, number>()

/** Tests: forget which engines were seen down. */
export function __resetObjectInfoEngineStateForTests(): void { engineDownUntil.clear() }

/**
 * Ask the engine (or pool worker) for the catalog; null when it does not
 * answer in time or answers an error. The main engine is first checked
 * against the shared cached health check (engineHealth.ts) — known down means
 * no fetch. A failure here is also remembered for 3 s per port: that covers
 * the pool workers (which the health check doesn't speak for) and an engine
 * that answers /system_stats but hangs or errors on /object_info, so a hung
 * engine costs one timeout, not one per request.
 */
async function fromEngine(rawPath: string, canonicalPath: string): Promise<{ text: string, body: Catalog | null, port: number } | null> {
  const { port, cleanUrl } = resolveWorkerTarget(rawPath)
  if ((engineDownUntil.get(port) ?? 0) > Date.now()) return null
  if (port === MAIN_ENGINE_PORT && await engineHealth() === 'down') return null
  const q = cleanUrl.indexOf('?')
  const query = q === -1 ? '' : cleanUrl.slice(q)
  const target = `http://127.0.0.1:${port}`
  let text: string
  try {
    const res = await fetch(`${target}${canonicalPath}${query}`, {
      headers: { origin: target },
      signal: AbortSignal.timeout(OBJECT_INFO_ENGINE_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`engine answered ${res.status}`)
    text = await res.text()
  }
  catch {
    engineDownUntil.set(port, Date.now() + OBJECT_INFO_ENGINE_TIMEOUT_MS)
    return null
  }
  engineDownUntil.delete(port)
  // Python's json may write NaN/Infinity, which JSON.parse refuses: the engine
  // still answered, so its text is still the answer — just not a parsed one.
  let body: Catalog | null = null
  try {
    const parsed = JSON.parse(text)
    if (isCatalog(parsed)) body = parsed
  }
  catch {}
  return { text, body, port }
}

/**
 * The stored catalog for `node` (all of it when null), refreshed from disk.
 * Null when there is no saved copy and no baseline.
 */
export function storedObjectInfoBody(node: string | null): ObjectInfoBody | null {
  const saved = readSaved()
  const stored = saved ?? readBaseline()
  if (!stored) return null
  let body: Catalog
  if (node === null) body = structuredClone(stored)
  else body = Object.prototype.hasOwnProperty.call(stored, node) ? { [node]: structuredClone(stored[node]) } : {}
  const root = resolveEngineRoot()
  if (root) refreshFileLists(body, root)
  return { source: saved ? 'saved' : 'baseline', body }
}

/**
 * The body for `canonicalPath` (`/object_info` or `/object_info/{node}`):
 * the engine's own while it answers, else the stored catalog refreshed from
 * disk. Null only when there is no engine and no stored catalog at all.
 */
export async function objectInfoBody(rawPath: string, canonicalPath: string, node: string | null): Promise<ObjectInfoBody | null> {
  const live = await fromEngine(rawPath, canonicalPath)
  if (live) {
    // The main instance's full catalog only: a pool worker's node set can differ.
    if (live.body && node === null && live.port === MAIN_ENGINE_PORT) saveCopyInBackground(live.body)
    return { source: 'engine', text: live.text, body: live.body }
  }
  return storedObjectInfoBody(node)
}

export const NO_NODE_DEFINITIONS = {
  status: 503,
  body: { error: 'Sailor can\'t load the node list: the engine is not answering and no saved copy was found.' },
}

/**
 * Sailor's model menus laid over a body about to be served
 * (shared/runner/modelMenus.ts): each covered dropdown's options, hidden list
 * and default, each gallery's default, for the runner families switched on
 * now. Copy on write: the saved copy and the memoised catalogs stay as they were.
 */
export function withModelOverlay(body: Catalog): Catalog {
  return applyModelOverlay(body, runnerFamilies())
}

/**
 * The local route: the engine's catalog (parsed, overlaid, re-serialised),
 * else the stored catalog (overlaid), else 503. An engine answer JSON.parse
 * refuses (Python's NaN/Infinity) can't be overlaid and is passed through as
 * its own bytes, as before.
 */
export async function runObjectInfo(rawPath: string, canonicalPath: string, node: string | null): Promise<{ status: number, body: unknown, headers?: Record<string, string> }> {
  const got = await objectInfoBody(rawPath, canonicalPath, node)
  if (!got) return NO_NODE_DEFINITIONS
  if (got.source === 'engine') {
    const text = got.body ? JSON.stringify(withModelOverlay(got.body)) : got.text
    return { status: 200, body: text, headers: { 'content-type': 'application/json; charset=utf-8' } }
  }
  return { status: 200, body: withModelOverlay(got.body) }
}
