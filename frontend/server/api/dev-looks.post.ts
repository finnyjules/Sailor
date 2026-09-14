/**
 * DEV-ONLY: save a tuned look for the /dev/looks gallery.
 *
 * Body: { name, bg, layers } — the gallery posts the current frame's layers +
 * background under a look's name. Merges into server/data/looks-tuned.json so
 * the tuned version becomes the default the gallery loads. 404s unless this is a
 * local dev server; on the proxy allowlist (nitroApiPaths).
 */
import { createError, defineEventHandler, readBody } from 'h3'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { deployMode } from '../utils/deployMode'
import { TUNED_LOOKS_PATH } from './dev-looks.get'

export default defineEventHandler(async (event) => {
  if (!import.meta.dev || deployMode() !== 'local') {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  const body = await readBody(event)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const bg = typeof body?.bg === 'string' ? body.bg : '#ffffff'
  const layers = Array.isArray(body?.layers) ? body.layers : null
  if (!name || !layers || !layers.length) {
    throw createError({ statusCode: 400, statusMessage: 'name and a non-empty layers array are required' })
  }
  if (layers.length > 200) {
    throw createError({ statusCode: 400, statusMessage: 'too many layers' })
  }

  let store: Record<string, unknown> = {}
  try { store = JSON.parse(await readFile(TUNED_LOOKS_PATH, 'utf8')) } catch { /* first save */ }
  store[name] = { bg, layers }
  await mkdir(dirname(TUNED_LOOKS_PATH), { recursive: true })
  await writeFile(TUNED_LOOKS_PATH, JSON.stringify(store, null, 2))
  return { ok: true, name, layers: layers.length }
})
