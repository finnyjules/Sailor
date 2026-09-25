/** Rename a saved effect. */
import { assertId, readBoundedJsonBody, renameMyEffect } from '../../utils/myEffectsStore'

export default defineEventHandler(async (event) => {
  const id = assertId(getRouterParam(event, 'id'))
  const body = await readBoundedJsonBody(event) as any // fix round 2: raw-byte capped before JSON.parse
  return renameMyEffect(id, body?.name, event.context.userId ?? null)
})
