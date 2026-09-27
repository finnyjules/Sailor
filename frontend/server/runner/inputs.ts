/**
 * Files a workflow reads before it makes anything: moodboard reference
 * pictures (GenerateImageNode.style_refs, RestyleFromImageNode.style_refs), pictures/clips/sounds loaded into an
 * unwired Image, Video or Audio card, a LoadImage's picture, the files the
 * bake-replay cards hand on (3D Studio's passes, Text on path's and Text
 * mask's render), Painter's painter file, and the Shader effect's bake. In hosted, every one must be
 * the user's own.
 */
import { isLink, type ApiPrompt } from '#shared/runner/graph'
import { parseShaderBaked } from '#shared/runner/shaderBakeKey'
import { MeterRefusalError } from '../utils/requestMeter'
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
    // The Frame editor's injected LoadImage (baked layers and masks).
    if (node.class_type === 'LoadImage' && !isLink(inputs.image)) {
      const f = parseInputFileRef(inputs.image)
      if (f) out.push(f)
    }
    if (node.class_type === 'Video' && !isLink(inputs.source)) {
      const f = parseInputFileRef(inputs.file)
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
    const ok = f.type === 'output' ? await check.ownsOutput(userId, f)
      : f.type === 'input' ? await check.ownsInput(userId, f)
        : false
    if (!ok) throw new MeterRefusalError('This workflow uses a file that isn’t one of yours', 403, { file: f.filename })
  }
}
