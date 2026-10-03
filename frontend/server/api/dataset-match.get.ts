/**
 * GET /api/dataset-match  (dev-only)
 *
 * Reconstructs, by timestamp, which local `input/lora_dataset_*` folder trained
 * a given LoRA — the source images the Style Publisher feeds to Fable. Three
 * modes:
 *   ?filename=<name>.safetensors  → best-match folder for that LoRA
 *   ?folder=<lora_dataset_...>    → the image files in that folder (manual override)
 *   ?list=1                       → all dataset folders (name, start, image count)
 *
 * Reads the repo's ../input and ../models/loras trees, so it only works on a dev
 * machine where training was run. Must be allowlisted in comfyui-proxy.ts.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dataPath } from '../utils/dataRoot'

const FOLDER_RE = /^lora_dataset_\d+$/
const IMG_RE = /\.(png|jpe?g|webp)$/i

function inputDir() { return dataPath('input') }

async function imageFiles(folder: string): Promise<string[]> {
  try {
    const names = await fs.readdir(path.join(inputDir(), folder))
    return names.filter(f => IMG_RE.test(f)).sort()
  }
  catch { return [] }
}

async function folderNames(): Promise<string[]> {
  try {
    return (await fs.readdir(inputDir())).filter(n => FOLDER_RE.test(n))
  }
  catch { return [] }
}

export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  const q = getQuery(event)

  // Mode: list every dataset folder (for the manual-override picker). Include a
  // `cover` (first image) so the picker can show a recognizable thumbnail.
  if (q.list) {
    const names = await folderNames()
    const folders = await Promise.all(names.map(async (name) => {
      const files = await imageFiles(name)
      return { name, startMs: parseDatasetStartMs(name) ?? 0, imageCount: files.length, cover: files[0] ?? null }
    }))
    folders.sort((a, b) => b.startMs - a.startMs)
    return { folders }
  }

  // Mode: files in one explicitly-chosen folder.
  if (q.folder) {
    const folder = String(q.folder)
    if (!FOLDER_RE.test(folder)) throw createError({ statusCode: 400, statusMessage: 'invalid folder' })
    const files = await imageFiles(folder)
    return { folder, files, imageCount: files.length }
  }

  // Mode: best-match folder for a LoRA by its sidecar trained_on time.
  const filename = String(q.filename || '')
  if (!filename.endsWith('.safetensors') || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw createError({ statusCode: 400, statusMessage: 'filename (bare .safetensors) required' })
  }
  const base = filename.slice(0, -'.safetensors'.length)

  let trainedOn: string | null = null
  try {
    const meta = parseSidecar(await fs.readFile(dataPath('models', 'loras', `${base}.json`), 'utf8'))
    trainedOn = meta.trained_on ?? null
  }
  catch { /* no sidecar / unreadable — no basis to match */ }

  const names = await folderNames()
  const folders = names.map(name => ({ name, startMs: parseDatasetStartMs(name) ?? 0, imageCount: 0 }))
  const match = matchDatasetFolder(trainedOn, folders)
  if (!match) return { folder: null, trainedOn }

  const files = await imageFiles(match.folder.name)
  return { folder: match.folder.name, gapMinutes: Math.round(match.gapMinutes), files, imageCount: files.length, trainedOn }
})
