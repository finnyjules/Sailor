/**
 * Upload a licensed brand font. Multipart: `font` (file), `family` (string),
 * `weight` (400|700, default 400). Validates type/size, stores the file under
 * the gitignored user dir, and upserts the manifest (single weight mirrors to
 * both 400/700; a real second weight replaces the mirror — see ./fonts).
 *
 * Stage 6 (Task 4): hosted guards the mutation by slug ownership — you can add
 * a new font or re-upload one you own; another user's font (or a curated one)
 * 404s. A brand-new slug is claimed for the caller.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { extname, join } from 'node:path'

import { slugifyFamily, upsertManifest, validateUpload, type FontWeight } from '~~/server/templates/fonts'
import { readManifest, writeManifest, USER_FONTS_DIR } from '~~/server/templates/fonts-store'
import { claimNew, guardMutation } from '../../utils/ownedJsonStore'
import { readUploadForm } from '~~/server/utils/multipart'

const OPTS = { kind: 'template-font', dir: USER_FONTS_DIR }

export default defineEventHandler(async (event) => {
  const form = await readUploadForm(event)
  const filePart = await form.file('font')
  const family = form.text('family')
  const weight: FontWeight = form.text('weight') === '700' ? '700' : '400'

  if (!filePart?.filename) throw createError({ statusCode: 400, statusMessage: 'Missing font file' })
  if (!family) throw createError({ statusCode: 400, statusMessage: 'Missing family name' })

  const ext = extname(filePart.filename).toLowerCase()
  const bytes = new Uint8Array(filePart.data.buffer, filePart.data.byteOffset, filePart.data.byteLength)
  const v = validateUpload({ ext, size: filePart.data.byteLength, bytes })
  if (!v.ok) throw createError({ statusCode: 400, statusMessage: v.reason })

  const slug = slugifyFamily(family)
  const userId = event.context.userId ?? null
  const manifest = await readManifest()
  const exists = manifest.some(f => f.slug === slug)
  await guardMutation(OPTS, userId, slug, exists)

  const file = `${slug}-${weight}${ext}`
  await mkdir(USER_FONTS_DIR, { recursive: true })
  await writeFile(join(USER_FONTS_DIR, file), filePart.data)

  const next = upsertManifest(manifest, { family, slug, weight, file })
  await writeManifest(next)
  if (!exists) await claimNew(OPTS, userId, slug)

  const entry = next.find(f => f.slug === slug)!
  return { ok: true, family: entry.family, slug, weights: entry.weights }
})
