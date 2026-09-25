/** Save (create or overwrite) a full effect record; the URL id must match the body's. */
import { assertId, readBoundedJsonBody, writeMyEffect } from '../../utils/myEffectsStore'

export default defineEventHandler(async (event) => {
  const id = assertId(getRouterParam(event, 'id'))
  const body = await readBoundedJsonBody(event) as any // fix round 2: raw-byte capped before JSON.parse
  if (!body || body.id !== id) throw createError({ statusCode: 400, statusMessage: 'Body id must match the URL id' })
  return writeMyEffect(body, event.context.userId ?? null)
})
