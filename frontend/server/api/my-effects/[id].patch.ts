/** Rename a saved effect. */
import { assertId, refuseOversizedBody, renameMyEffect } from '../../utils/myEffectsStore'

export default defineEventHandler(async (event) => {
  const id = assertId(getRouterParam(event, 'id'))
  refuseOversizedBody(event) // review #1: same Content-Length guard as PUT
  const body = await readBody(event)
  return renameMyEffect(id, body?.name, event.context.userId ?? null)
})
