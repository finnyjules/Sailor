/** How a runner result was made: the exact workflow, the charge, the prompt. */
import { createError, defineEventHandler, getQuery } from 'h3'
import { runnerEnabled } from '../../runner/config'
import { getEngine } from '../../runner/index'

export default defineEventHandler(async (event) => {
  if (!runnerEnabled()) throw createError({ statusCode: 404, message: 'Not found' })
  const promptId = getQuery(event).promptId
  if (typeof promptId !== 'string') throw createError({ statusCode: 400, message: 'Missing promptId' })
  const rec = await getEngine().record(event.context.userId ?? null, promptId)
  if (!rec) throw createError({ statusCode: 404, message: 'Not found' })
  return rec
})
