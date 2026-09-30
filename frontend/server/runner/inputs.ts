/**
 * Files a workflow reads before it makes anything: moodboard reference
 * pictures (GenerateImageNode.style_refs, RestyleFromImageNode.style_refs), pictures/clips/sounds loaded into an
 * unwired Image, Video or Audio card, a LoadImage's picture, the files the
 * bake-replay cards hand on (3D Studio's passes, Text on path's and Text
 * mask's render), Painter's painter file, the Shader effect's bake, Pose Mannequin's
 * saved pictures (R3.15), and the sound Load audio or Record audio loads
 * (R5.3). In hosted, every one must be the user's own.
 */
import { isLink, type ApiPrompt } from '#shared/runner/graph'
import { parseShaderBaked } from '#shared/runner/shaderBakeKey'
import { POSE_BAKED_INPUTS, POSE_MANNEQUIN_CLASS, bakedNamePresent } from '#shared/runner/nanoExtras'
import { posix } from 'node:path'
import { MeterRefusalError } from '../utils/requestMeter'
import { savedInputKey } from '../utils/graphRuns'
import { userSubfolder } from './results'
import type { OutputFile } from './types'

export const MOODBOARD_MAX_REFS = 3
const MOODBOARD_FOLDER_RE = /^moodboard_\d+$/
const MOODBOARD_IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i

function safeMoodboardFile(name: unknown): name is string {
  if (typeof name !== 'string' || !name) return false
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false
  return MOODBOARD_IMAGE_EXT_RE.test(name)
}

/** Port of nodes_replicate._parse_style_refs — never throws, bad input → null. */
export function parseStyleRefs(raw: unknown): { folder: string; files: string[] } | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let payload: unknown
  try { payload = JSON.parse(raw) } catch { return null }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const { folder, files } = payload as { folder?: unknown; files?: unknown }
  if (typeof folder !== 'string' || !MOODBOARD_FOLDER_RE.test(folder)) return null
  if (!Array.isArray(files)) return null
  const good = files.filter(safeMoodboardFile).slice(0, MOODBOARD_MAX_REFS)
  return good.length ? { folder, files: good } : null
}

export function moodboardFiles(raw: unknown): OutputFile[] {
  const parsed = parseStyleRefs(raw)
  return parsed ? parsed.files.map(f => ({ filename: f, subfolder: parsed.folder, type: 'input' as const })) : []
}

/** 'a.png' | 'sub/a.png' | 'sub/a.png [output]' → a file; anything unsafe → null. */
export function parseInputFileRef(raw: unknown): OutputFile | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let name = raw.trim()
  let type: OutputFile['type'] = 'input'
  const m = /^(.*?)\s*\[(input|output|temp)\]$/.exec(name)
  if (m) { name = m[1]!; type = m[2] as OutputFile['type'] }
  name = name.replace(/\\/g, '/')
  const parts = name.split('/')
  if (parts.some(p => !p || p === '.' || p === '..')) return null
  const filename = parts.pop()!
  return { filename, subfolder: parts.join('/'), type }
}

/**
 * A file name as Python's `folder_paths.get_annotated_filepath` opens it
 * (R3.15 fix round 2, Pose Mannequin's baked files): a trailing `[output]`,
 * `[input]` or `[temp]` picks the folder and cuts exactly 9, 8 or 7
 * characters (so `x.png [input]` is `x.png`, and `x.png[input]` is `x.pn`);
 * else the input folder. `os.path.join` with the name, read lexically:
 * `./x`, `sub//x`, `sub/./x` and `sub/../x` are the files they name.
 * `outside`: an absolute name, or one that climbs above its folder (hosted
 * refuses it: not the user's). Null: blank (Python's `if not filename`), or
 * a name that is a folder, not a file.
 */
export function pythonInputRef(raw: unknown): { file: OutputFile } | { outside: true } | null {
  if (typeof raw !== 'string' || !raw) return null
  let name = raw
  let type: OutputFile['type'] = 'input'
  if (name.endsWith('[output]')) { type = 'output'; name = name.slice(0, -9) }
  else if (name.endsWith('[input]')) name = name.slice(0, -8)
  else if (name.endsWith('[temp]')) { type = 'temp'; name = name.slice(0, -7) }
  if (!name) return null
  if (name.startsWith('/')) return { outside: true }
  const norm = posix.normalize(name)
  if (norm === '..' || norm.startsWith('../')) return { outside: true }
  if (norm === '.' || norm.endsWith('/')) return null
  const parts = norm.split('/')
  const filename = parts.pop()!
  return { file: { filename, subfolder: parts.join('/'), type } }
}

/**
 * A bake card's `params` (Text on path, Text mask) as its Python node reads
 * it: `json.loads(params or "{}")`, and anything but an object is `{}`.
 * (Text Python reads and JSON.parse does not, NaN or Infinity, is left to the
 * engine by eligibility's `bake-params` check.)
 */
export function bakeParams(raw: unknown): Record<string, unknown> {
  const text = typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : String(raw)
  if (!text) return {}
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
  }
  catch { return {} }
}

/** 3D Studio's baked passes (comfy_extras/nodes_scene3d.py), in output order. */
export const SCENE3D_BAKES = ['beauty_image', 'depth_image', 'normal_image'] as const

export function collectInputFiles(prompt: ApiPrompt): OutputFile[] {
  const out: OutputFile[] = []
  for (const node of Object.values(prompt)) {
    const inputs = node.inputs ?? {}
    // The bake-replay cards (R1.3): the files their studio baked.
    if (node.class_type === 'Scene3DStudio') {
      for (const name of SCENE3D_BAKES) {
        const f = isLink(inputs[name]) ? null : parseInputFileRef(inputs[name])
        if (f) out.push(f)
      }
    }
    if (node.class_type === 'TextOnPath' || node.class_type === 'TextMask') {
      const f = parseInputFileRef(bakeParams(inputs.params).rendered)
      if (f) out.push(f)
    }
    if (node.class_type === 'GenerateImageNode' || node.class_type === 'RestyleFromImageNode') out.push(...moodboardFiles(inputs.style_refs))
    if (node.class_type === 'Image' && !isLink(inputs.images)) {
      const f = parseInputFileRef(inputs.image)
      if (f) out.push(f)
    }
    // Painter's painter file (R2.8), named by its `mask` widget.
    if (node.class_type === 'Painter' && !isLink(inputs.mask)) {
      const f = parseInputFileRef(inputs.mask)
      if (f) out.push(f)
    }
    // The Shader effect's bake (R2.10): every frame the browser uploaded.
    if (node.class_type === 'ShaderEffect') {
      for (const name of parseShaderBaked(inputs.sailor_baked)?.files ?? []) {
        const f = parseInputFileRef(name)
        if (f) out.push(f)
      }
    }
    // Pose Mannequin's saved pictures (R3.15): the result, the conditioning and mannequin renders.
    if (node.class_type === POSE_MANNEQUIN_CLASS) {
      for (const name of POSE_BAKED_INPUTS) {
        // Read as Python opens it (fix round 2); a name outside the folders is refused at the start (poseStartProblem).
        const ref = bakedNamePresent(inputs[name]) ? pythonInputRef(inputs[name]) : null
        if (ref && 'file' in ref) out.push(ref.file)
      }
    }
    // The Frame editor's injected LoadImage (baked layers and masks).
    if (node.class_type === 'LoadImage' && !isLink(inputs.image)) {
      const f = parseInputFileRef(inputs.image)
      if (f) out.push(f)
    }
    if (node.class_type === 'Video' && !isLink(inputs.source)) {
      const f = parseInputFileRef(inputs.file)
      if (f) out.push(f)
    }
    // Load audio and Record audio (R5.3, media-sound): the file each loads.
    if ((node.class_type === 'LoadAudio' || node.class_type === 'RecordAudio') && !isLink(inputs.audio)) {
      const f = parseInputFileRef(inputs.audio)
      if (f) out.push(f)
    }
    // The Audio card a sync-3 lip-sync reads (model line-up F22). The lip-sync's
    // own files (its studio's links) are checked by the engine (sync3Media.ts).
    if (node.class_type === 'Audio' && !isLink(inputs.source)) {
      const f = parseInputFileRef(inputs.audio)
      if (f) out.push(f)
    }
  }
  return out
}

export interface OwnershipCheck {
  ownsInput(userId: string, file: OutputFile): Promise<boolean>
  ownsOutput(userId: string, file: OutputFile): Promise<boolean>
  /**
   * An input file one of the user's runs saved there and recorded as its own
   * (R3.6, ruling (o): Layerize an image's layers, metering.addOutput).
   * Absent: none is.
   */
  ownsSaved?(userId: string, file: OutputFile): Promise<boolean>
}

/**
 * Whether `keys` (the user's graph_runs keys) record this input file as one
 * the runner saved for them (R3.6 fix round 1): the runner's own kind
 * (savedInputKey, never harvested from ComfyUI), and in the user's own
 * input subfolder.
 */
export function savedInputOwned(userId: string, f: OutputFile, keys: ReadonlySet<string>): boolean {
  return f.type === 'input' && f.subfolder === userSubfolder(userId, true) && keys.has(savedInputKey(f))
}

export async function assertFilesOwned(
  files: OutputFile[],
  userId: string | null,
  hosted: boolean,
  check: OwnershipCheck,
): Promise<void> {
  if (!hosted) return
  if (!userId) throw new MeterRefusalError('Sign in to run workflows', 401)
  for (const f of files) {
    // An input file is the user's when they uploaded it, or when one of their
    // runs saved it there (R3.6, ruling (o): Layerize an image's layers).
    const ok = f.type === 'output' ? await check.ownsOutput(userId, f)
      : f.type === 'input' ? (await check.ownsInput(userId, f)) || (!!check.ownsSaved && await check.ownsSaved(userId, f))
        : false
    if (!ok) throw new MeterRefusalError('This workflow uses a file that isn’t one of yours', 403, { file: f.filename })
  }
}
