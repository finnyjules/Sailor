import { promises as fs } from 'node:fs'
import path from 'node:path'
import { findInLibrary, libraryDir } from '../utils/library'
import { slugifyCharacterName, type CharacterRecord } from '~~/server/utils/characterRegistry'
import { claimNew } from '~~/server/utils/ownedJsonStore'
import { emptyState } from '#shared/characters/types'

export default defineEventHandler(async (event) => {
  const body = await readBody(event) as { name?: string, origin?: string, likenessConfirmed?: boolean, style?: string, linkedFrom?: string }
  const name = (body?.name || '').trim()
  const slug = slugifyCharacterName(name)
  if (!name || !slug) throw createError({ statusCode: 400, message: 'A usable character name is required' })

  const dir = libraryDir('characters')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${slug}.json`)
  if (await findInLibrary('characters', `${slug}.json`)) throw createError({ statusCode: 409, message: `Character '${slug}' already exists` })

  // linkedFrom is kept only if it names an existing character's slug.
  const linkedFrom = typeof body?.linkedFrom === 'string' && slugifyCharacterName(body.linkedFrom) === body.linkedFrom
    && Boolean(await findInLibrary('characters', `${body.linkedFrom}.json`)) ? body.linkedFrom : null

  const now = new Date().toISOString()
  const record: CharacterRecord = {
    name, slug,
    face: null, photos: [], voice: null,
    origin: body?.origin === 'described' || body?.origin === 'canvas' ? body.origin : 'photos',
    likenessConfirmed: body?.likenessConfirmed === true,
    style: body?.style === 'anime' ? 'anime' : 'photo',
    linkedFrom,
    states: [emptyState('default', 'Default')],
    loraName: null, trigger: null, bodyShape: null, notes: '', createdAt: now, updatedAt: now,
  }
  await fs.writeFile(file, JSON.stringify(record, null, 2))
  // Claim ownership (hosted only) so this character lists/mutates for its creator.
  await claimNew({ kind: 'character', dir }, event.context?.userId ?? null, slug)
  return record
})
