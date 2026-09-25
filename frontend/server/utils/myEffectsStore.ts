/**
 * My effects (AI in Sailor spec §7.4, plan ruling 6): one JSON file per effect
 * under storeDir('my-effects'), owner-scoped with the Stage 6 registry. Local:
 * everything, no owner rows. Hosted: STRICTLY the caller's own — unlike the
 * curated stores, an unowned record is never shown to anyone.
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createError } from 'h3'
import { cleanName, MY_EFFECT_ID_RE, MY_EFFECT_LIMITS, MY_EFFECT_MAX_BYTES, recordByteSize, validateMyEffect, type MyEffectRecord } from '../../shared/myEffects/record'
import { deployMode } from './deployMode'
import { storeDir } from './dataDir'
import { claimNew, guardMutation, releaseRecord, type OwnedStoreOpts } from './ownedJsonStore'
import { ownedIds, ownerOf } from './resourceOwners'

export const myEffectsOpts = (): OwnedStoreOpts => ({ kind: 'my-effect', dir: storeDir('my-effects') })
const fileOf = (id: string) => join(myEffectsOpts().dir, `${id}.json`)
const notFound = () => createError({ statusCode: 404, statusMessage: 'Not found' })
export function assertId(id: unknown): string {
  if (typeof id !== 'string' || !MY_EFFECT_ID_RE.test(id)) throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
  return id
}

/**
 * review #1: refuse an over-cap PUT/PATCH body from its declared Content-Length,
 * BEFORE readBody buffers it — the same pattern as engineGate.ts's upload gate.
 * Reads event.node.req.headers directly (the same place h3's own
 * getRequestHeader reads from) rather than importing h3's helper, which
 * requires a real H3Event shape this module's callers (and its unit tests)
 * don't always construct. A lying (or absent) Content-Length is still caught
 * by the byte-size re-check in writeMyEffect once the body is parsed.
 */
export function refuseOversizedBody(event: { node?: { req?: { headers?: Record<string, unknown> } } }): void {
  const raw = event?.node?.req?.headers?.['content-length']
  const declared = Number(raw)
  if (raw !== undefined && Number.isFinite(declared) && declared > MY_EFFECT_MAX_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'That effect is too large to save' })
  }
}

async function readAll(): Promise<MyEffectRecord[]> {
  let files: string[] = []
  try { files = (await readdir(myEffectsOpts().dir)).filter(f => f.endsWith('.json')) } catch { return [] }
  const out: MyEffectRecord[] = []
  for (const f of files) {
    try {
      const r = validateMyEffect(JSON.parse(await readFile(join(myEffectsOpts().dir, f), 'utf8')))
      if (r.id === basename(f, '.json')) out.push(r)
    } catch { /* skip a corrupt file; never 500 the list */ }
  }
  return out
}

export async function listMyEffects(userId: string | null): Promise<MyEffectRecord[]> {
  let all = await readAll()
  if (deployMode() === 'hosted') {
    if (!userId) return []
    const mine = await ownedIds('my-effect', userId)
    all = all.filter(r => mine.has(r.id))
  }
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function readMyEffect(id: string, userId: string | null): Promise<MyEffectRecord | null> {
  if (deployMode() === 'hosted' && (!userId || (await ownerOf('my-effect', id)) !== userId)) return null
  try {
    const rec = validateMyEffect(JSON.parse(await readFile(fileOf(id), 'utf8')))
    return rec.id === id ? rec : null // review #5: a hand-edited file whose body id drifted from its name is not this id
  } catch { return null }
}

export async function writeMyEffect(input: unknown, userId: string | null): Promise<MyEffectRecord> {
  let rec: MyEffectRecord
  try { rec = validateMyEffect(input) } catch (e) { throw createError({ statusCode: 400, statusMessage: (e as Error).message }) }
  // review #1: re-check the validated record's serialized size — every field is
  // now individually bounded, but this is the backstop against the aggregate.
  if (recordByteSize(rec) > MY_EFFECT_MAX_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'That effect is too large to save' })
  }
  const exists = existsSync(fileOf(rec.id))
  await guardMutation(myEffectsOpts(), userId, rec.id, exists)
  if (!exists && (await listMyEffects(userId)).length >= MY_EFFECT_LIMITS.maxEffects) {
    throw createError({ statusCode: 409, statusMessage: `My effects holds ${MY_EFFECT_LIMITS.maxEffects} effects. Remove one to keep another.` })
  }
  // review #8: the server owns createdAt — an overwrite keeps the original.
  if (exists) {
    try {
      const prior = validateMyEffect(JSON.parse(await readFile(fileOf(rec.id), 'utf8')))
      rec.createdAt = prior.createdAt
    } catch { /* a corrupt prior file — fall through with the client's createdAt */ }
  }
  rec.updatedAt = new Date().toISOString()
  await mkdir(myEffectsOpts().dir, { recursive: true })
  await writeFile(fileOf(rec.id), JSON.stringify(rec, null, 2), 'utf8')
  if (!exists) await claimNew(myEffectsOpts(), userId, rec.id)
  return rec
}

export async function renameMyEffect(id: string, name: unknown, userId: string | null): Promise<MyEffectRecord> {
  if (typeof name !== 'string') throw createError({ statusCode: 400, statusMessage: 'name must be text' }) // review #6
  const cur = await readMyEffect(id, userId)
  if (!cur) throw notFound()
  return writeMyEffect({ ...cur, name: cleanName(name) }, userId)
}

export async function deleteMyEffect(id: string, userId: string | null): Promise<void> {
  const exists = existsSync(fileOf(id))
  if (!exists) throw notFound()
  await guardMutation(myEffectsOpts(), userId, id, true)
  await rm(fileOf(id), { force: true })
  await releaseRecord(myEffectsOpts(), id)
}
