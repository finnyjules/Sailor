/**
 * GET /api/moodboards/images?folder=moodboard_123           → { files } (sorted)
 * GET /api/moodboards/images?folder=moodboard_123&file=x.png → raw image bytes
 *
 * Path-guarded (the training-image.get.ts pattern): folder must be a
 * moodboard_<ms> name — NEVER a lora_dataset_* folder — and file a bare image
 * name with no traversal. Must be allowlisted in comfyui-proxy.ts.
 *
 * Stage 6 (Task 4): hosted read-guards by input-upload ownership (the images
 * were recorded against their owner on upload). List mode hides files the
 * caller doesn't own; serve mode 404s it. LC12 (USER ruling 2026-10-03): every
 * hosted moodboard picture must have an owner, so a file with NO owner row is
 * refused like another person's (no shared "curated" reads). Local: unchanged.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MOODBOARD_FOLDER_RE } from '../../../shared/taste/moodboard'
import { moodboardInputDir, safeImageFile } from '../../utils/moodboardImages'
import { canonicalUploadKey, uploadOwner } from '../../utils/inputUploads'
import { isHosted } from '../../utils/deployMode'

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const folder = String(q.folder || '')
  const file = String(q.file || '')

  if (!MOODBOARD_FOLDER_RE.test(folder)) throw createError({ statusCode: 400, statusMessage: 'invalid folder' })

  const hosted = isHosted()
  const userId = event.context.userId ?? null
  const canRead = async (name: string): Promise<boolean> => {
    if (!hosted) return true
    const owner = await uploadOwner(canonicalUploadKey('input', folder, name))
    return owner !== null && owner === userId
  }

  // List mode: image files in the folder, sorted (filtered to readable in hosted).
  if (!file) {
    let names: string[] = []
    try { names = await fs.readdir(path.join(moodboardInputDir(), folder)) }
    catch { throw createError({ statusCode: 404, statusMessage: 'not found' }) }
    let images = names.filter(safeImageFile).sort()
    if (hosted) {
      const kept: string[] = []
      for (const name of images) if (await canRead(name)) kept.push(name)
      images = kept
    }
    return { files: images }
  }

  // Serve mode: one raw image.
  if (!safeImageFile(file)) throw createError({ statusCode: 400, statusMessage: 'invalid file' })
  if (!(await canRead(file))) throw createError({ statusCode: 404, statusMessage: 'not found' })

  const abs = path.resolve(moodboardInputDir(), folder, file)
  let buf: Buffer
  try { buf = await fs.readFile(abs) }
  catch { throw createError({ statusCode: 404, statusMessage: 'not found' }) }

  const ext = file.split('.').pop()!.toLowerCase()
  setResponseHeader(event, 'Content-Type', MIME[ext] || 'application/octet-stream')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return buf
})
