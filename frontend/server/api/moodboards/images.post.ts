/**
 * POST /api/moodboards/images — multipart upload of moodboard images.
 *
 * Form fields: `folder` (optional — omitted mints `moodboard_${Date.now()}`),
 * files under `images` (JPEG/PNG/WebP). Saves into `<repo-root>/input/<folder>/`
 * and returns `{ folder, files }`. Uses server/utils/multipart.ts, NOT h3's
 * readMultipartFormData (RangeError over 64 MiB). Must be allowlisted in
 * comfyui-proxy.ts (rides the /api/moodboards prefix).
 *
 * Stage 6 (Task 4): every file written into the engine input dir is recorded
 * against the caller in `input_uploads` (hosted only) so the graph-reference
 * validator + input listing can scope it — the moodboard's images become the
 * caller's owned inputs.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MOODBOARD_FOLDER_RE } from '../../../shared/taste/moodboard'
import { moodboardInputDir, safeImageFile } from '../../utils/moodboardImages'
import { readUploadForm } from '../../utils/multipart'
import { canonicalUploadKey, recordUpload, uploadOwner } from '../../utils/inputUploads'
import { isHosted } from '../../utils/deployMode'

export default defineEventHandler(async (event) => {
  const form = await readUploadForm(event)

  const folder = form.text('folder') || `moodboard_${Date.now()}`
  if (!MOODBOARD_FOLDER_RE.test(folder)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid folder' })
  }

  const parts = await form.files('images')
  const valid = parts
    .map(p => ({ ...p, base: path.basename(p.filename ?? '') }))
    .filter(p => safeImageFile(p.base))
  if (valid.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'no valid image files (png/jpeg/webp under `images`)' })
  }

  const dir = path.join(moodboardInputDir(), folder)

  const hosted = isHosted()
  const userId = event.context.userId ?? null

  // I1 — a caller-supplied EXISTING folder must not be another tenant's. Before
  // creating/writing, gate an already-populated folder by the same
  // caller-owned per-file rule images.get.ts enforces (LC12): if any image already
  // in it is another person's OR has no owner row, refuse (404) before writing, so
  // a folder never ends up mixed. A brand-new or empty folder passes — first writer owns it.
  if (hosted) {
    let existing: string[] = []
    try { existing = await fs.readdir(dir) } catch { /* new folder — nothing to guard */ }
    for (const name of existing.filter(safeImageFile)) {
      const owner = await uploadOwner(canonicalUploadKey('input', folder, name))
      if (owner !== userId) throw createError({ statusCode: 404, statusMessage: 'not found' })
    }
  }

  await fs.mkdir(dir, { recursive: true })

  const files: string[] = []
  for (const [i, part] of valid.entries()) {
    const name = `${String(i).padStart(2, '0')}_${part.base}`
    await fs.writeFile(path.join(dir, name), part.data)
    if (hosted && userId) await recordUpload(userId, canonicalUploadKey('input', folder, name))
    files.push(name)
  }
  return { folder, files }
})
