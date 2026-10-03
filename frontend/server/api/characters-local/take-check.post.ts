import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dataPath } from '../../utils/dataRoot'
import { parseCharacterRecord } from '~~/server/utils/characterRegistry'
import { guardMutation } from '~~/server/utils/ownedJsonStore'
import { deployMode } from '~~/server/utils/deployMode'
import { assertRateLimit } from '~~/server/lib/rateLimit'
import { compareFaces, prepareForCompare, rekognitionClient } from '~~/server/utils/faceCheck/rekognition'
import { faceFor } from '~~/server/utils/faceCheck/plan'
import { readTakeFrames, scoreTake, type TakeCompareResult } from '~~/server/utils/faceCheck/take'
import { judgeSameCharacter } from '~~/server/utils/faceCheck/vision'
import { resolveAnthropicKey } from '~~/server/lib/agentRequest'
import { meterAssist } from '~~/server/utils/anthropicMeter'

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'character-take-check', 20)
  const body = await readBody(event) as { slug?: string; stateId?: string | null; frames?: unknown }
  const slug = (body?.slug || '').trim()
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    throw createError({ statusCode: 400, message: 'Invalid slug' })
  }
  const dir = dataPath('models', 'characters')
  const inputDir = dataPath('input')
  const file = path.join(dir, `${slug}.json`)
  let record
  try { record = parseCharacterRecord(await fs.readFile(file, 'utf8'), slug) }
  catch { throw createError({ statusCode: 404, message: `No character '${slug}'` }) }
  if (!record) throw createError({ statusCode: 404, message: `No character '${slug}'` })
  await guardMutation({ kind: 'character', dir }, event.context?.userId ?? null, slug, true)

  if (deployMode() === 'hosted' && record.origin !== 'described' && !record.likenessConfirmed) {
    throw createError({ statusCode: 403, message: 'Confirm you have the right to use this person\'s likeness first.' })
  }

  const anime = record.style === 'anime'
  // Ruling N: AWS compares aren't metered yet, so hosted can't offer them.
  if (!anime && deployMode() === 'hosted') throw createError({ statusCode: 501, message: 'Face checks for photo characters are not available yet.' })

  const face = faceFor(record, body?.stateId ?? null)
  if (!face) throw createError({ statusCode: 409, message: 'This character has no approved face yet.' })

  const frames = readTakeFrames(body)
  if (typeof frames === 'string') throw createError({ statusCode: 400, message: frames })

  const cfg = useRuntimeConfig(event)
  let compare: (s: Buffer, t: Buffer) => Promise<TakeCompareResult>
  if (anime) {
    const apiKey = resolveAnthropicKey(cfg.anthropicApiKey as string, undefined)
    compare = async (s, t) => {
      await meterAssist(event)
      return judgeSameCharacter(fetch, apiKey, s, t)
    }
  }
  else {
    const client = rekognitionClient({ region: cfg.awsRegion as string, accessKeyId: cfg.awsAccessKeyId as string, secretAccessKey: cfg.awsSecretAccessKey as string })
    compare = (s, t) => compareFaces(client, s, t)
  }

  const faceImage = await prepareForCompare(await fs.readFile(path.join(inputDir, face)), { pad: !anime })
  const frameImages = await Promise.all(frames.map(f => prepareForCompare(f, { pad: !anime })))

  const { scores, best, verdict, note } = await scoreTake(frameImages, faceImage, compare)
  return note
    ? { slug, name: record.name, scores, best, verdict, note }
    : { slug, name: record.name, scores, best, verdict }
})
