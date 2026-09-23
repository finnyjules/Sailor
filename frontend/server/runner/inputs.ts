/**
 * Files a workflow reads before it makes anything: moodboard reference
 * pictures (GenerateImageNode.style_refs) and pictures/clips loaded into an
 * unwired Image or Video card. In hosted, every one must be the user's own.
 */
import { isLink, type ApiPrompt } from '#shared/runner/graph'
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

export function collectInputFiles(prompt: ApiPrompt): OutputFile[] {
  const out: OutputFile[] = []
  for (const node of Object.values(prompt)) {
    const inputs = node.inputs ?? {}
    if (node.class_type === 'GenerateImageNode') out.push(...moodboardFiles(inputs.style_refs))
    if (node.class_type === 'Image' && !isLink(inputs.images)) {
      const f = parseInputFileRef(inputs.image)
      if (f) out.push(f)
    }
    if (node.class_type === 'Video' && !isLink(inputs.source)) {
      const f = parseInputFileRef(inputs.file)
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
    if (!ok) throw new MeterRefusalError('This workflow uses a picture that isn’t in your files', 403, { file: f.filename })
  }
}
