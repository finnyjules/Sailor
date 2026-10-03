/**
 * Animate a Frame image layer: make a looping, transparent clip from a still.
 *
 *   1. flatten the RGBA still onto a key colour (server/frame/clipKeyRun.ts)
 *   2. call the video model with the still as first AND last frame
 *   3. key every returned frame back to transparency (server/frame/clipKey.ts,
 *      decoded with Sailor's own ffmpeg)
 *   4. write input/sailor_clips/<id>/000000.png … + clip.json
 *
 * Step 3, LC10: the keyer is a port of scripts/clip_key.py in Sailor's own
 * server code, so Animate needs no Python and runs in hosted too (LC7's
 * refusal is gone). The model call goes through runFal, so the ledger hold,
 * prompt moderation, polling and release-on-failure are the shared ones.
 *
 * Everything that could make the attempt fail for a reason knowable in
 * advance is judged BEFORE the paid call: the body, the still (a real PNG
 * that decodes, within the hosted picture cap), the video tools, the clip
 * folder (resolved, its staging folder made), the room the clip may keep
 * (hosted), the rate limit and, in hosted, the sign-in and the clip's name
 * (claimed for the person before anything is on disk). Frames go into a
 * staging folder that becomes the clip folder only once complete.
 *
 * Stop: the client aborts its request; the response's close aborts the
 * model's polling (fal is asked to cancel, the hold is released), the
 * download and the decode (ffmpeg is killed by runMedia), and the staging
 * folder is removed: nothing is left.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MEDIA_CAPS } from '#shared/runner/media'
import { assertRateLimit } from '../../lib/rateLimit'
import { isHosted } from '../../utils/deployMode'
import { runFal, firstFalVideoUrl } from '../../utils/falRun'
import { uploadToFalStorage } from '../../utils/falStorage'
import { animateKeptBound, animateMaxFrames, ANIMATE_VIDEO_MAX_BYTES, dataUrlBytes } from '../../utils/frameAnimate'
import { canonicalUploadKey, engineDirForType, recordUpload } from '../../utils/inputUploads'
import { downloadResult } from '../../runner/falQueue'
import { safeAnswerFetch } from '../../runner/answerDownload'
import { MediaError, mediaTempDir, removeMediaTempDir } from '../../media/run'
import { MEDIA_TOOLS_MISSING, mediaTools } from '../../media/tools'
import { flattenStill, keyClip, readStill, stillSize } from '../../frame/clipKeyRun'
import { clipModel, clipRequest, clipSeconds } from '~~/app/data/clip-models'

interface Body { image?: string; prompt?: string; model?: string; seconds?: number }

/** Resolved per request — the engine root is env/cwd-derived, not a module constant. */
function clipsDir(): string | null {
  const input = engineDirForType('input')
  return input ? path.join(input, 'sailor_clips') : null
}

export const ANIMATE_TOO_LARGE = 'This picture is too large to animate here. Nothing was charged.'
export const ANIMATE_TOO_MUCH = 'This clip would be too large to keep here. Try a shorter length or a smaller picture. Nothing was charged.'

const PROMPT_SUFFIX = (key: 'green' | 'blue') =>
  `, on a solid ${key} screen background (uniform flat ${key === 'green' ? '#00FF00' : '#0000FF'} chroma key), evenly lit, no shadows, no gradient, camera locked, gentle motion`

export default defineEventHandler(async (event) => {
  const hosted = isHosted()
  const userId = typeof event.context?.userId === 'string' && event.context.userId ? event.context.userId as string : null
  if (hosted && !userId) throw createError({ statusCode: 401, message: 'Sign in required' })

  // Validate BEFORE rate-limiting (review fix): six malformed requests must not
  // burn the 6-per-10-min budget. dataUrlBytes (server/utils/frameAnimate.ts)
  // throws plain Errors carrying a `statusCode`, re-wrapped here.
  const body = await readBody<Body>(event)
  if (!body?.image) throw createError({ statusCode: 400, message: 'image is required' })
  const spec = clipModel(body?.model ?? '')
  if (!spec) throw createError({ statusCode: 400, message: 'unknown model' })
  let imageBytes: Buffer
  try {
    imageBytes = dataUrlBytes(body.image)
  }
  catch (e) {
    const err = e as { statusCode?: number; message?: string }
    throw createError({ statusCode: err.statusCode ?? 400, message: err.message ?? 'invalid image' })
  }
  const seconds = clipSeconds(spec, body.seconds)
  const prompt = (body.prompt ?? '').trim()

  // The still: its size from the header first (a huge picture is refused before it is decoded).
  const size = await stillSize(imageBytes)
  if (!size) throw createError({ statusCode: 400, message: 'image must be a PNG data URL' })
  const caps = hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
  if (size.w * size.h > caps.framePixels) throw createError({ statusCode: 413, message: ANIMATE_TOO_LARGE })
  // What the clip may keep, planned from the model's size and the length asked for.
  if (animateKeptBound(spec.resolution, seconds, size) > caps.keptBytesPerRun) throw createError({ statusCode: 413, message: ANIMATE_TOO_MUCH })

  // Resolve the destination and the tools BEFORE spending money.
  const clipsRoot = clipsDir()
  if (!clipsRoot) throw createError({ statusCode: 500, message: 'Could not find the engine input folder' })
  if (!(await mediaTools())) throw createError({ statusCode: 503, message: `${MEDIA_TOOLS_MISSING}. Nothing was charged.` })

  assertRateLimit(event, 'frame-animate', 6, 600_000)

  // Stop: the client going away aborts everything below.
  const gone = new AbortController()
  const res = event.node?.res
  const onClose = () => { if (!res?.writableEnded) gone.abort() }
  res?.once?.('close', onClose)
  const signal = gone.signal

  // The clip's name, decided (and in hosted claimed for this person) before anything is on disk.
  const id = `clip_${Date.now()}_${randomBytes(6).toString('hex')}`
  const outDir = path.join(clipsRoot, id)
  const staging = path.join(clipsRoot, `.${id}.partial`)
  let tmp: string | null = null
  try {
    if (hosted) await recordUpload(userId!, canonicalUploadKey('input', `sailor_clips/${id}`, 'clip.json'))
    await mkdir(staging, { recursive: true })
    tmp = await mediaTempDir()

    // 1. the still, flattened onto the key colour
    let still: Awaited<ReturnType<typeof readStill>>
    let keyHex: string
    let flat: Buffer
    try {
      still = await readStill(imageBytes)
      ;({ keyHex, flat } = await flattenStill(still))
    }
    catch {
      throw createError({ statusCode: 400, message: 'Could not read the picture. Nothing was charged.' })
    }
    const keyName = keyHex === '#0000ff' ? 'blue' : 'green'
    const fullPrompt = (prompt || 'the subject moves gently') + PROMPT_SUFFIX(keyName)
    if (signal.aborted) throw new MediaError('stopped')
    // fal needs a URL it can fetch, so the flattened still goes to fal storage.
    const stillUrl = await uploadToFalStorage(new Uint8Array(flat), 'still.png', 'image/png')

    // 2. the model — clipRequest's request, the one the Animate button prices; runFal
    // holds and charges it per second of what it asks for.
    const req = clipRequest(spec.id, seconds, fullPrompt, stillUrl)
    const out = await runFal(req.endpoint, req.input, { pollDeadlineMs: 900_000, signal })
    const videoUrl = firstFalVideoUrl(out)
    if (!videoUrl) throw createError({ statusCode: 502, message: 'The model returned no video' })

    // 3. key it back to transparency
    const { bytes } = await downloadResult(videoUrl, {
      fetchOnce: safeAnswerFetch({ hosted, kind: 'video' }), maxBytes: ANIMATE_VIDEO_MAX_BYTES, signal,
    })
    const mp4Path = path.join(tmp, 'clip.mp4')
    await writeFile(mp4Path, bytes)
    const meta = await keyClip({
      video: mp4Path, roots: [tmp], still, key: keyHex, outDir: staging,
      trimLast: true, /* first == last frame on every model: drop the returning frame */
      userId, signal, maxFrames: animateMaxFrames(seconds), maxBytes: caps.keptBytesPerRun,
    })
    if (!meta.frames || !meta.fps) throw createError({ statusCode: 500, message: 'Keying produced no frames' })

    // The keyer knows the frame geometry, not what made it: fold the model and prompt
    // into the folder's own clip.json so a clip found on disk still says where it came from.
    const metaPath = path.join(staging, 'clip.json')
    const onDisk = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    await writeFile(metaPath, JSON.stringify({ ...onDisk, model: spec.id, prompt }, null, 2))

    if (signal.aborted) throw new MediaError('stopped')
    await rename(staging, outDir)
    return { dir: `sailor_clips/${id}`, frames: meta.frames, fps: meta.fps, model: spec.id, prompt }
  }
  catch (e) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    if (signal.aborted) throw createError({ statusCode: 499, message: 'Stopped' })
    if (e instanceof MediaError) throw createError({ statusCode: e.word === 'toolsMissing' ? 503 : 502, message: e.message })
    throw e
  }
  finally {
    res?.off?.('close', onClose)
    if (tmp) await removeMediaTempDir(tmp).catch(() => {})
  }
})
