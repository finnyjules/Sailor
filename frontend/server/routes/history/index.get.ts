/**
 * GET /history in ComfyUI's shape, answered by Sailor (step 3, R10.8; see
 * server/native/history.ts): the runner's records, then locally the disk
 * cache the engine-era history kept (old engine runs; step 4, C5: there is no
 * engine to ask).
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createError, defineEventHandler } from 'h3'
import { deployMode } from '../../utils/deployMode'
import { runnerHistory } from '../../native/history'
import { getRunStore } from '../../runner/store'

const CACHE_FILE = join(process.cwd(), '.cache', 'history.json')

async function loadCache(): Promise<Record<string, any>> {
  try {
    if (existsSync(CACHE_FILE)) {
      const raw = await readFile(CACHE_FILE, 'utf-8')
      return JSON.parse(raw)
    }
  }
  catch {}
  return {}
}

/** The runner's entries; a store that can't be read leaves the rest standing. */
async function runnerEntries(userId: string | null): Promise<Record<string, any>> {
  try { return await runnerHistory(getRunStore(), userId) }
  catch (err) {
    console.error('[history] runner records unreadable:', err)
    return {}
  }
}

export default defineEventHandler(async (event) => {
  // Hosted: the caller's own runs only. The shared disk cache below is
  // cross-tenant by construction (one file, every user's runs) — it is
  // neither read nor written.
  if (deployMode() === 'hosted') {
    const userId = event.context.userId
    if (!userId) throw createError({ statusCode: 401, message: 'Sign in required' })
    return await runnerEntries(userId)
  }

  const cached = await loadCache()

  return { ...cached, ...await runnerEntries(null) }
})
