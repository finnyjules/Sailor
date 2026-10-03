/**
 * GET /api/training-image?folder=<lora_dataset_...>&file=<name>   (dev-only)
 *
 * Serves one raw training image from `input/lora_dataset_*` so the Style
 * Publisher can show a style's real training set (and downscale it client-side
 * before sending to Fable). Path-guarded: folder must be a lora_dataset_<ms>
 * name and file a bare image name — no traversal. Must be allowlisted in
 * comfyui-proxy.ts.
 */
import { promises as fs } from 'node:fs'
import { dataPath } from '../utils/dataRoot'

const FOLDER_RE = /^lora_dataset_\d+$/
const IMG_RE = /\.(png|jpe?g|webp)$/i
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  const q = getQuery(event)
  const folder = String(q.folder || '')
  const file = String(q.file || '')

  if (!FOLDER_RE.test(folder)) throw createError({ statusCode: 400, statusMessage: 'invalid folder' })
  if (file.includes('/') || file.includes('\\') || file.includes('..') || !IMG_RE.test(file)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid file' })
  }

  const abs = dataPath('input', folder, file)
  let buf: Buffer
  try { buf = await fs.readFile(abs) }
  catch { throw createError({ statusCode: 404, statusMessage: 'not found' }) }

  const ext = file.split('.').pop()!.toLowerCase()
  setResponseHeader(event, 'Content-Type', MIME[ext] || 'application/octet-stream')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return buf
})
