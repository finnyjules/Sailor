/** Stop the caller's runner runs (all of them, or the ones listed). */
import { createError, defineEventHandler, readBody } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'
import { isRunId } from '../../runner/store'

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  const body = (await readBody(event).catch(() => null)) as Record<string, unknown> | null
  const runIds = Array.isArray(body?.runIds) ? (body!.runIds as unknown[]).filter(isRunId) : undefined
  return await getEngine().stop(event.context.userId ?? null, runIds)
})
