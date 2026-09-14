/**
 * DEV-ONLY: read the tuned look overrides for the /dev/looks gallery.
 *
 * Returns a map of look name → { bg, layers } that the gallery merges over the
 * extracted spike defaults, so Julien's hand-tuning survives a reload. The
 * companion POST writes it. 404s unless this is a local dev server; on the
 * proxy allowlist (nitroApiPaths) because the reachability guard requires every
 * route file to be — the gate is the handler, not the routing table.
 */
import { createError, defineEventHandler } from 'h3'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { deployMode } from '../utils/deployMode'

export const TUNED_LOOKS_PATH = resolve(process.cwd(), 'server/data/looks-tuned.json')

export default defineEventHandler(async () => {
  if (!import.meta.dev || deployMode() !== 'local') {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  try {
    const raw = await readFile(TUNED_LOOKS_PATH, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
})
