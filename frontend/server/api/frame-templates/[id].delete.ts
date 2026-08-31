import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { guardMutation, releaseRecord } from '../../utils/ownedJsonStore'
import { storeDir } from '../../utils/dataDir'

const OPTS = { kind: 'frame-template', dir: storeDir('frame-templates') }

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id || !/^[a-z0-9-]+$/i.test(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
  }
  const exists = existsSync(join(OPTS.dir, `${id}.json`))
  await guardMutation(OPTS, event.context.userId ?? null, id, exists)
  await rm(join(OPTS.dir, `${id}.json`), { force: true })
  await releaseRecord(OPTS, id)
  return { ok: true, id }
})
