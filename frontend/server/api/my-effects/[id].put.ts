/** Save (create or overwrite) a full effect record; the URL id must match the body's. */
import { assertId, refuseOversizedBody, writeMyEffect } from '../../utils/myEffectsStore'

export default defineEventHandler(async (event) => {
  const id = assertId(getRouterParam(event, 'id'))
  refuseOversizedBody(event) // review #1: refuse from Content-Length, before readBody buffers it
  const body = await readBody(event)
  if (!body || body.id !== id) throw createError({ statusCode: 400, statusMessage: 'Body id must match the URL id' })
  return writeMyEffect(body, event.context.userId ?? null)
})
