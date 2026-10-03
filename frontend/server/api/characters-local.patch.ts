import { promises as fs } from 'node:fs'
import { libraryDir, libraryFile } from '../utils/library'
import {
  faceRefHygiene, parseCharacterRecord, photoHygiene, sanitizeBodyShape, stateHygiene, validRefFilename, voiceHygiene,
  type CharacterRecord, type CharacterState,
} from '~~/server/utils/characterRegistry'
import { applyStatePatch, type StatePatchBody } from '~~/server/utils/characterStatePatch'
import { guardMutation, releaseRecord } from '~~/server/utils/ownedJsonStore'
import type { BodySliderId, Photo } from '#shared/characters/types'

export default defineEventHandler(async (event) => {
  const body = await readBody(event) as {
    slug?: string, name?: string, notes?: string, loraName?: string | null,
    trigger?: string | null,
    bodyShape?: Partial<Record<BodySliderId, number>> | null,
    states?: CharacterState[], statePatch?: StatePatchBody, remove?: true,
    expectedUpdatedAt?: string,
    face?: { filename: string } | null, photos?: unknown[], voice?: unknown, likenessConfirmed?: boolean,
  }
  const slug = (body?.slug || '').trim()
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    throw createError({ statusCode: 400, message: 'Invalid slug' })
  }
  const dir = libraryDir('characters')
  // Read and written in place, in whichever library folder holds it (library.ts).
  const file = await libraryFile('characters', `${slug}.json`)
  let record: CharacterRecord | null
  try { record = parseCharacterRecord(await fs.readFile(file, 'utf8'), slug) }
  catch { throw createError({ statusCode: 404, message: `No character '${slug}'` }) }
  if (!record) throw createError({ statusCode: 404, message: `No character '${slug}'` })

  // Ownership gate (hosted only): the record exists here, so a non-owner (or a
  // curated/unowned record) is refused with a 404 — no existence disclosure.
  await guardMutation({ kind: 'character', dir }, event.context?.userId ?? null, slug, true)

  if (body.remove === true) {
    // Ref files stay in the input dir — other shots may still point at them.
    await fs.unlink(file)
    await releaseRecord({ kind: 'character', dir }, slug)
    return { ok: true }
  }
  if (typeof body.name === 'string' && body.name.trim()) record.name = body.name.trim()
  if (typeof body.notes === 'string') record.notes = body.notes
  if (body.loraName !== undefined) record.loraName = body.loraName || null
  if (body.trigger !== undefined) record.trigger = body.trigger || null
  // Explicit null clears; an object goes through the same clamp/drop hygiene as parse.
  if (body.bodyShape !== undefined) record.bodyShape = body.bodyShape === null ? null : sanitizeBodyShape(body.bodyShape)

  // origin, style and linkedFrom are deliberately not patchable here: where a
  // character came from, its style, and what it was linked from at creation
  // never change after the fact.
  if (body.face !== undefined) {
    if (body.face === null) record.face = null
    else {
      const f = faceRefHygiene({ filename: body.face?.filename, approvedAt: new Date().toISOString() })
      if (!f) throw createError({ statusCode: 400, message: 'Invalid face' })
      record.face = f
    }
  }
  if (Array.isArray(body.photos)) record.photos = body.photos.map(photoHygiene).filter((p): p is Photo => !!p)
  if (body.voice !== undefined) record.voice = body.voice === null ? null : voiceHygiene(body.voice)
  if (typeof body.likenessConfirmed === 'boolean') record.likenessConfirmed = body.likenessConfirmed

  if (body.statePatch) {
    const result = applyStatePatch(record, body.statePatch, new Date().toISOString())
    if (!result.ok) throw createError({ statusCode: result.code, message: result.message })
    record = result.record
    await fs.writeFile(file, JSON.stringify(record, null, 2))
    return { ok: true }
  }

  if (Array.isArray(body.states)) {
    // Record-level staleness guard, mirroring applyStatePatch's per-state
    // check above — full-array replaces (create/delete-variant) otherwise
    // clobber a concurrent edit with no warning. Omitted expectedUpdatedAt
    // keeps legacy callers working unguarded.
    // NOTE: no Nitro test harness for this route (established pattern, see
    // the statePatch branch above) — covered indirectly via
    // characters-composable.unit.spec.ts at the store layer.
    if (typeof body.expectedUpdatedAt === 'string' && body.expectedUpdatedAt !== record.updatedAt) {
      throw createError({ statusCode: 409, message: 'Character was modified by someone else' })
    }
    const states = body.states
    const ids = states.map(v => v?.id)
    if (states.length === 0
      || !states.every(v => v && typeof v.id === 'string' && v.id.trim() && typeof v.label === 'string' && v.label.trim())
      || !states.every(v => Array.isArray(v.refImages) && v.refImages.every(validRefFilename))
    ) {
      throw createError({ statusCode: 400, message: 'Invalid state' })
    }
    if (new Set(ids).size !== ids.length) {
      throw createError({ statusCode: 400, message: 'Duplicate state id' })
    }
    if (ids.filter(id => id === 'default').length !== 1) {
      throw createError({ statusCode: 400, message: 'Exactly one default state is required' })
    }
    // Run each submitted state through the same hygiene used on parse —
    // preserves caller-supplied panels/sheetImage/status/stressResult/
    // updatedAt instead of clobbering them with a hardcoded literal.
    const hygienic = states.map(v => stateHygiene(v as unknown as Record<string, unknown>))
    if (hygienic.some(v => !v)) {
      throw createError({ statusCode: 400, message: 'Invalid state' })
    }
    const candidate: CharacterRecord = {
      ...record,
      states: hygienic as CharacterState[],
    }
    // Round-trip through the same hygiene parse used on read — 400 if a
    // state got dropped or altered rather than silently persisting drift.
    const healed = parseCharacterRecord(JSON.stringify(candidate), slug)
    if (!healed || healed.states.length !== candidate.states.length) {
      throw createError({ statusCode: 400, message: 'Invalid state' })
    }
    record = healed
    record.name = candidate.name
    record.notes = candidate.notes
    record.loraName = candidate.loraName
    record.trigger = candidate.trigger
  }

  // NOTE: the legacy top-level `refImages`/`coverIndex` alias (write-through
  // to the Default state) was removed in Task 9 — every caller now goes
  // through `statePatch` (applyStatePatch, above) or a full `states` replace.
  // `applyStatePatch` is the only remaining per-state mutation path.

  record.updatedAt = new Date().toISOString()
  await fs.writeFile(file, JSON.stringify(record, null, 2))
  return { ok: true }
})
