import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { deployMode } from '../../utils/deployMode'
import { ownsPrompt } from '../../utils/graphRuns'
import { engineHealth, ENGINE_HEALTH_TIMEOUT_MS } from '../../native/engineHealth'

const COMFY_BACKEND = 'http://127.0.0.1:8188'
const CACHE_FILE = join(process.cwd(), '.cache', 'history.json')

export default defineEventHandler(async (event) => {
  const promptId = getRouterParam(event, 'promptId')
  if (!promptId) {
    throw createError({ statusCode: 400, message: 'Missing promptId' })
  }

  if (deployMode() === 'hosted') {
    const userId = event.context.userId
    if (!userId) throw createError({ statusCode: 401, message: 'Sign in required' })
    if (!(await ownsPrompt(userId, promptId))) throw createError({ statusCode: 404, message: 'Not found' })
    // Owned: fall through to the live fetch below. The cache fallback at the
    // bottom is guarded off in hosted mode — it's a shared, cross-tenant file.
  }

  // Try live first — skipped when the cached engine-health check already
  // reports the engine down (server/native/engineHealth.ts), and bounded by
  // the same timeout otherwise, as GET /history does.
  if (await engineHealth() === 'up') {
    try {
      const res = await fetch(`${COMFY_BACKEND}/history/${encodeURIComponent(promptId)}`, { signal: AbortSignal.timeout(ENGINE_HEALTH_TIMEOUT_MS) })
      if (res.ok) {
        const data = await res.json() as Record<string, any>
        // ComfyUI returns {} when the promptId doesn't exist — check it actually has data
        if (data[promptId]) {
          return data
        }
      }
    }
    catch {
      // ComfyUI might be down
    }
  }

  // Fallback to cache — local mode only; the cache file is shared across all
  // tenants in hosted mode, so it must never answer a hosted request.
  if (deployMode() !== 'hosted') {
    try {
      if (existsSync(CACHE_FILE)) {
        const raw = await readFile(CACHE_FILE, 'utf-8')
        const cached = JSON.parse(raw)
        if (cached[promptId]) {
          return { [promptId]: cached[promptId] }
        }
      }
    }
    catch {}
  }

  throw createError({ statusCode: 404, message: 'History entry not found' })
})
