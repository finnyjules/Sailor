/**
 * GET /history in ComfyUI's shape, answered by Sailor (step 3, R10.8; see
 * server/native/history.ts): the runner's records, then locally the disk
 * cache and, only while the engine is up, its own history — the local-only
 * runs (decision 4). With nothing on the engine's port it still answers.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createError, defineEventHandler } from 'h3'
import { deployMode } from '../../utils/deployMode'
import { engineHealth, ENGINE_HEALTH_TIMEOUT_MS, ENGINE_MAIN_PORT } from '../../native/engineHealth'
import { runnerHistory } from '../../native/history'
import { getRunStore } from '../../runner/store'

const CACHE_DIR = join(process.cwd(), '.cache')
const CACHE_FILE = join(CACHE_DIR, 'history.json')

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

async function saveCache(data: Record<string, any>) {
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(CACHE_FILE, JSON.stringify(data))
  }
  catch (err) {
    console.error('[history cache] Failed to save:', err)
  }
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
  // neither read nor written, and the engine is never asked.
  if (deployMode() === 'hosted') {
    const userId = event.context.userId
    if (!userId) throw createError({ statusCode: 401, message: 'Sign in required' })
    return await runnerEntries(userId)
  }

  const cached = await loadCache()

  // The engine's own history — its local-only runs — only while it is up
  // (cached health, server/native/engineHealth.ts), bounded by the same timeout.
  let live: Record<string, any> = {}
  if (await engineHealth() === 'up') {
    try {
      const res = await fetch(`http://127.0.0.1:${ENGINE_MAIN_PORT}/history`, { signal: AbortSignal.timeout(ENGINE_HEALTH_TIMEOUT_MS) })
      if (res.ok) {
        live = await res.json() as Record<string, any>
      }
    }
    catch {
      // The engine went away — the cache and the runner stand.
    }
  }

  // Merge: live entries take priority, cached fills in the rest
  const merged = { ...cached, ...live }

  // If we got new live entries, persist the merged result (engine entries only:
  // the runner's are read from its own records every time).
  if (Object.keys(live).length > 0 && Object.keys(merged).length > Object.keys(cached).length) {
    // Fire and forget — don't block the response
    saveCache(merged)
  }

  return { ...merged, ...await runnerEntries(null) }
})
