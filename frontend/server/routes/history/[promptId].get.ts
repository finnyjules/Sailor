/**
 * GET /history/{promptId} in ComfyUI's shape, answered by Sailor (step 3,
 * R10.8; see server/native/history.ts). A runner stage comes from the run's
 * record — the caller's own run only. Locally, any other id is an old engine
 * run, read from the disk cache the engine-era history kept (step 4, C5: there
 * is no engine to ask). Hosted never reads the shared cache.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { deployMode } from '../../utils/deployMode'
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

  // Hosted never made engine runs; there is nothing else to read.
  if (hosted) throw createError({ statusCode: 404, message: 'Not found' })

  // An old engine run, from the disk cache.
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
