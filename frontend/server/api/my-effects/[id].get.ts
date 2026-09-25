/** Read one saved effect, or 404 when it doesn't exist or isn't the caller's. */
import { assertId, readMyEffect } from '../../utils/myEffectsStore'

export default defineEventHandler(async (event) => {
  const id = assertId(getRouterParam(event, 'id'))
  const rec = await readMyEffect(id, event.context.userId ?? null)
  if (!rec) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  return rec
})
