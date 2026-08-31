/** Upsert a frame template. Body is the full StoredTemplate; URL id must match. */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { claimNew, guardMutation } from '../../utils/ownedJsonStore'
import { storeDir } from '../../utils/dataDir'

const OPTS = { kind: 'frame-template', dir: storeDir('frame-templates') }

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id || !/^[a-z0-9-]+$/i.test(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
  }
  const body = await readBody<Record<string, any>>(event)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'Missing body' })
  }
  if (body.id !== id) {
    throw createError({ statusCode: 400, statusMessage: `Body id '${body.id}' doesn't match URL id '${id}'` })
  }
  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'Template needs a name' })
  }
  if (typeof body.version !== 'number') {
    throw createError({ statusCode: 400, statusMessage: 'Template needs a version' })
  }
  const userId = event.context.userId ?? null
  const exists = existsSync(join(OPTS.dir, `${id}.json`))
  await guardMutation(OPTS, userId, id, exists)
  body.updatedAt = new Date().toISOString()
  await mkdir(OPTS.dir, { recursive: true })
  await writeFile(join(OPTS.dir, `${id}.json`), JSON.stringify(body, null, 2), 'utf8')
  if (!exists) await claimNew(OPTS, userId, id)
  return { ok: true, id }
})
