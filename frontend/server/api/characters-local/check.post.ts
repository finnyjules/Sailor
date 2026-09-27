import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseCharacterRecord, validRefFilename } from '~~/server/utils/characterRegistry'
import { guardMutation } from '~~/server/utils/ownedJsonStore'
import { deployMode } from '~~/server/utils/deployMode'
import { assertRateLimit } from '~~/server/lib/rateLimit'
import { compareFaces, hasFace, prepareForCompare, rekognitionClient } from '~~/server/utils/faceCheck/rekognition'
import { applyOutcome, runChecks } from '~~/server/utils/faceCheck/run'
import { judgeSameCharacter } from '~~/server/utils/faceCheck/vision'
import { resolveAnthropicKey } from '~~/server/lib/agentRequest'
import { meterAssist } from '~~/server/utils/anthropicMeter'

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'character-face-check', 10)
  const body = await readBody(event) as { slug?: string }
  const slug = (body?.slug || '').trim()
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    throw createError({ statusCode: 400, message: 'Invalid slug' })
  }
  const dir = path.resolve(process.cwd(), '..', 'models', 'characters')
  const inputDir = path.resolve(process.cwd(), '..', 'input')
  const file = path.join(dir, `${slug}.json`)
  let record
  try { record = parseCharacterRecord(await fs.readFile(file, 'utf8'), slug) }
  catch { throw createError({ statusCode: 404, message: `No character '${slug}'` }) }
  if (!record) throw createError({ statusCode: 404, message: `No character '${slug}'` })
  await guardMutation({ kind: 'character', dir }, event.context?.userId ?? null, slug, true)

  if (deployMode() === 'hosted' && record.origin !== 'described' && !record.likenessConfirmed) {
    throw createError({ statusCode: 403, message: 'Confirm you have the right to use this person\'s likeness first.' })
  }

  const cfg = useRuntimeConfig(event)
  // Photo characters: AWS face matching. Anime: face matching doesn't work on
  // drawn faces, so the vision checker (Task 9) judges the design instead.
  let compare: (s: Buffer, t: Buffer) => ReturnType<typeof compareFaces> | ReturnType<typeof judgeSameCharacter>
  let sourceHasFace: (face: Buffer) => Promise<boolean>
  const anime = record.style === 'anime'
  if (anime) {
    const apiKey = resolveAnthropicKey(cfg.anthropicApiKey as string, undefined)
    compare = async (s, t) => { await meterAssist(event); return judgeSameCharacter(fetch, apiKey, s, t) }
    // The vision checker never throws 'no-face-either'.
    sourceHasFace = async () => true
  }
  else {
    // Ruling N: AWS compares aren't metered yet, so hosted can't offer them.
    if (deployMode() === 'hosted') throw createError({ statusCode: 501, message: 'Face checks for photo characters are not available yet.' })
    const client = rekognitionClient({ region: cfg.awsRegion as string, accessKeyId: cfg.awsAccessKeyId as string, secretAccessKey: cfg.awsSecretAccessKey as string })
    compare = (s, t) => compareFaces(client, s, t)
    sourceHasFace = img => hasFace(client, img)
  }
  const result = await runChecks(record, {
    async readImage(filename) {
      if (!validRefFilename(filename)) return null
      // The grey padding helps AWS find edge faces; the vision checker doesn't need it.
      try { return await prepareForCompare(await fs.readFile(path.join(inputDir, filename)), { pad: !anime }) }
      catch { return null }
    },
    compare,
    sourceHasFace,
    now: () => new Date().toISOString(),
  })
  // Nothing to write: return the record as read, updatedAt untouched.
  if (!result.outcome.results.length && !result.outcome.noSource.length) {
    return result.failed
      ? { record, compared: result.compared, skipped: result.skipped, failed: 'The face check stopped early. Try again to check the rest.' }
      : { record, compared: result.compared, skipped: result.skipped }
  }
  // Re-read: the compare pass took a while (up to 40 slow remote calls), so a
  // PATCH may have landed on this record meanwhile. Apply the outcome to the
  // fresh copy instead of overwriting it with the stale one we started from.
  let fresh
  try { fresh = parseCharacterRecord(await fs.readFile(file, 'utf8'), slug) }
  catch { throw createError({ statusCode: 404, message: `No character '${slug}'` }) }
  if (!fresh) throw createError({ statusCode: 404, message: `No character '${slug}'` })
  const next = { ...applyOutcome(fresh, result.outcome), updatedAt: new Date().toISOString() }
  await fs.writeFile(file, JSON.stringify(next, null, 2))
  return result.failed
    ? { record: next, compared: result.compared, skipped: result.skipped, failed: 'The face check stopped early. Try again to check the rest.' }
    : { record: next, compared: result.compared, skipped: result.skipped }
})
