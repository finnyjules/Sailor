/**
 * GET /history/{promptId} in ComfyUI's shape, answered by Sailor (step 3,
 * R10.8; see server/native/history.ts). A runner stage comes from the run's
 * record — the caller's own run only. Locally, any other id is a local-only
 * engine run: asked of the engine only while it is up, else read from the
 * disk cache. Hosted never asks the engine or reads the shared cache.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { deployMode } from '../../utils/deployMode'
import { engineHealth, ENGINE_HEALTH_TIMEOUT_MS, ENGINE_MAIN_PORT } from '../../native/engineHealth'
import { runnerHistoryEntry } from '../../native/history'
import { getRunStore, runIdOf } from '../../runner/store'

const CACHE_FILE = join(process.cwd(), '.cache', 'history.json')

export default defineEventHandler(async (event) => {
  const promptId = getRouterParam(event, 'promptId')
  if (!promptId) {
    throw createError({ statusCode: 400, message: 'Missing promptId' })
  }

  const hosted = deployMode() === 'hosted'
  const userId: string | null = hosted ? (event.context.userId ?? null) : null
  if (hosted && !userId) throw createError({ statusCode: 401, message: 'Sign in required' })

  // A runner stage: from its run's record, the caller's own run only.
  if (runIdOf(promptId)) {
    const found = await runnerHistoryEntry(getRunStore(), userId, promptId)
    if (found) return found
    throw createError({ statusCode: 404, message: 'History entry not found' })
  }

  // Hosted makes no engine runs; there is nothing else to read.
  if (hosted) throw createError({ statusCode: 404, message: 'Not found' })

  // A local-only engine run: the engine only while it is up (cached health,
  // bounded by the same timeout as GET /history).
  if (await engineHealth() === 'up') {
    try {
      const res = await fetch(`http://127.0.0.1:${ENGINE_MAIN_PORT}/history/${encodeURIComponent(promptId)}`, { signal: AbortSignal.timeout(ENGINE_HEALTH_TIMEOUT_MS) })
      if (res.ok) {
        const data = await res.json() as Record<string, any>
        // ComfyUI returns {} when the promptId doesn't exist — check it actually has data
        if (data[promptId]) {
          return data
        }
      }
    }
    catch {
      // The engine went away — the cache below answers.
    }
  }

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

  throw createError({ statusCode: 404, message: 'History entry not found' })
})
