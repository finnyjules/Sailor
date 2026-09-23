/** Paused Gates on one canvas, so a reopened project shows its pictures and buttons again. */
import { createError, defineEventHandler, getQuery } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  const canvasId = getQuery(event).canvasId
  if (typeof canvasId !== 'string' || !canvasId) return { gates: [] }
  return { gates: await getEngine().pausedGates(event.context.userId ?? null, canvasId) }
})
