import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createError, defineEventHandler } from 'h3'
import { deployMode } from '../../utils/deployMode'
import { ownedPromptIds } from '../../utils/graphRuns'
import { filterHistoryPayload } from '../../utils/engineGate'
import { engineHealth, ENGINE_HEALTH_TIMEOUT_MS } from '../../native/engineHealth'

const COMFY_BACKEND = 'http://127.0.0.1:8188'
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

export default defineEventHandler(async (event) => {
  // Stage 5 Task 5: hosted history is tenant-scoped. The shared disk cache
  // below is cross-tenant by construction (one file, every user's runs) —
  // it must be neither read nor written in hosted mode, so this branch
  // returns before any cache logic runs.
  if (deployMode() === 'hosted') {
    const userId = event.context.userId
    if (!userId) throw createError({ statusCode: 401, message: 'Sign in required' })
    // Cached engine health (server/native/engineHealth.ts) — a known-down
    // engine skips the round trip entirely instead of waiting out a doomed fetch.
    if (await engineHealth() === 'down') return {}
    try {
      const res = await fetch(`${COMFY_BACKEND}/history`, { signal: AbortSignal.timeout(ENGINE_HEALTH_TIMEOUT_MS) })
      if (!res.ok) return {}
      return filterHistoryPayload(await res.json() as Record<string, any>, await ownedPromptIds(userId))
    }
    catch { return {} }
  }

  const cached = await loadCache()

  // Try fetching live history from ComfyUI — skip the fetch when the cached
  // engine-health check already reports it down (server/native/engineHealth.ts).
  let live: Record<string, any> = {}
  if (await engineHealth() === 'up') {
    try {
      const res = await fetch(`${COMFY_BACKEND}/history`, { signal: AbortSignal.timeout(ENGINE_HEALTH_TIMEOUT_MS) })
      if (res.ok) {
        live = await res.json() as Record<string, any>
      }
    }
    catch {
      // ComfyUI might be down — use cache only
    }
  }

  // Merge: live entries take priority, cached fills in the rest
  const merged = { ...cached, ...live }

  // If we got new live entries, persist the merged result
  if (Object.keys(live).length > 0 && Object.keys(merged).length > Object.keys(cached).length) {
    // Fire and forget — don't block the response
    saveCache(merged)
  }

  return merged
})
