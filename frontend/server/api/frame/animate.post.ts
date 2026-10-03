/**
 * Animate a Frame image layer: make a looping, transparent clip from a still.
 *
 *   1. flatten the RGBA still onto a key colour (scripts/clip_key.py flatten)
 *   2. call the video model with the still as first AND last frame
 *   3. key every returned frame back to transparency (scripts/clip_key.py key)
 *   4. write input/sailor_clips/<id>/000000.png … + clip.json
 *
 * The model call goes through runFal so the ledger hold, prompt
 * moderation, polling and release-on-failure are the shared ones. The Python steps
 * are execFile'd from the repo venv, like voice-clone/from-youtube.
 *
 * Hosted has no Python (step 3, R10.10), so there the route refuses first, before
 * the body is read, the rate limit counts or any hold is taken (LC7). The keyer
 * (scripts/clip_key.py: Lab keying, guard matte, erode/soften over every frame)
 * is too large for a cheap Node port; the Animate controls are hidden in hosted.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertRateLimit } from '../../lib/rateLimit'
import { isHosted } from '../../utils/deployMode'
import { runFal, firstFalVideoUrl } from '../../utils/falRun'
import { uploadToFalStorage } from '../../utils/falStorage'
import { dataUrlBytes } from '../../utils/frameAnimate'
import { engineDirForType } from '../../utils/inputUploads'
import { clipModel, clipRequest, clipSeconds } from '~~/app/data/clip-models'

interface Body { image?: string; prompt?: string; model?: string; seconds?: number }

// PYTHON/SCRIPT are REPO files (the venv and scripts/ ship with the checkout), so the
// cwd-relative guess is right for them. The clip folder is ENGINE DATA — it has to land
// in the same `input/` the engine serves `/view` from, which `engineDirForType` resolves
// (SAILOR_ENGINE_ROOT, else a marker walk up from cwd) and which is NOT necessarily
// `<cwd>/../input`: a Nitro process started anywhere but `frontend/` wrote frames into a
// directory nothing ever reads, and every clip came back as a broken folder.
const ROOT = path.resolve(process.cwd(), '..')
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python')
const SCRIPT = path.join(ROOT, 'scripts', 'clip_key.py')
/** Resolved per request — the engine root is env/cwd-derived, not a module constant. */
function clipsDir(): string | null {
  const input = engineDirForType('input')
  return input ? path.join(input, 'sailor_clips') : null
}
/** The hosted refusal, exported so its spec and the client say the same words. */
export const ANIMATE_HOSTED_REFUSAL = 'Animate only works when Sailor runs on your own computer for now. Nothing was charged.'

const PROMPT_SUFFIX = (key: 'green' | 'blue') =>
  `, on a solid ${key} screen background (uniform flat ${key === 'green' ? '#00FF00' : '#0000FF'} chroma key), evenly lit, no shadows, no gradient, camera locked, gentle motion`

function py(args: string[], timeoutMs: number): Promise<string> {
  if (isHosted()) return Promise.reject(new Error(ANIMATE_HOSTED_REFUSAL))
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [SCRIPT, ...args], { timeout: timeoutMs, maxBuffer: 1 << 22 }, (err, out, stderr) => {
      if (err) return reject(new Error((stderr || '').trim().split('\n').pop() || err.message))
      resolve(out || '')
    })
  })
}

export default defineEventHandler(async (event) => {
  // Hosted: no Python to flatten or key with. Refuse before anything else, so no
  // hold is taken and nothing is charged for a clip that could never be keyed.
  if (isHosted()) throw createError({ statusCode: 501, message: ANIMATE_HOSTED_REFUSAL })

  // Validate BEFORE rate-limiting (review fix): assertRateLimit used to run
  // first, so six malformed requests (bad image, unknown model, junk PNG)
  // burned the whole 6-per-10-min budget and locked the user out for real
  // attempts. dataUrlBytes lives in server/utils/frameAnimate.ts —
  // h3-free pure helpers, unit-tested directly in
  // tests/unit/frame-animate-validation.unit.spec.ts — and throw PLAIN Error
  // objects carrying a `statusCode`, so re-wrap via createError here to keep
  // the client-facing status + message (see that file's header comment).
  const body = await readBody<Body>(event)
  if (!body?.image) throw createError({ statusCode: 400, message: 'image is required' })
  const spec = clipModel(body?.model ?? '')
  if (!spec) throw createError({ statusCode: 400, message: 'unknown model' })
  let imageBytes: Buffer
  try {
    imageBytes = dataUrlBytes(body.image)
  } catch (e) {
    const err = e as { statusCode?: number; message?: string }
    throw createError({ statusCode: err.statusCode ?? 400, message: err.message ?? 'invalid image' })
  }

  // Resolve the destination BEFORE spending money: an unresolvable engine root used to
  // surface only after the model had run and been paid for, as a write to a path that
  // did not exist.
  const clipsRoot = clipsDir()
  if (!clipsRoot) throw createError({ statusCode: 500, message: 'Could not find the engine input folder' })

  assertRateLimit(event, 'frame-animate', 6, 600_000)

  const seconds = clipSeconds(spec, body.seconds)
  const prompt = (body.prompt ?? '').trim()

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sailor-clip-'))
  try {
    // 1. flatten onto the key colour
    const stillPath = path.join(tmp, 'still.png')
    const flatPath = path.join(tmp, 'flat.png')
    await writeFile(stillPath, imageBytes)
    const keyLine = (await py(['flatten', stillPath, flatPath], 60_000)).split('\n').find(l => l.startsWith('KEY:'))
    if (!keyLine) throw createError({ statusCode: 500, message: 'Could not prepare the still' })
    const keyHex = keyLine.slice(4).trim()
    const keyName = keyHex === '#0000ff' ? 'blue' : 'green'
    const fullPrompt = (prompt || 'the subject moves gently') + PROMPT_SUFFIX(keyName)

    const flatBytes = await readFile(flatPath)
    // fal needs a URL it can fetch, so the flattened still goes to fal storage.
    const stillUrl = await uploadToFalStorage(new Uint8Array(flatBytes), 'still.png', 'image/png')

    // 2. the model
    //
    // The request is clipRequest's (app/data/clip-models.ts): the same request the
    // Animate button prices. runFal holds and charges it per second of what it asks for
    // (shared/pricing/clipSettings.ts requestPrice), ahead of the endpoint's flat
    // MODEL_COSTS row, so a 12 s clip is held for 12 s, and the hold equals the price
    // the button showed.
    const req = clipRequest(spec.id, seconds, fullPrompt, stillUrl)
    const out = await runFal(req.endpoint, req.input, { pollDeadlineMs: 900_000 })
    const videoUrl = firstFalVideoUrl(out)
    if (!videoUrl) throw createError({ statusCode: 502, message: 'The model returned no video' })

    // 3. key it back to transparency
    const mp4Path = path.join(tmp, 'clip.mp4')
    const res = await fetch(videoUrl)
    if (!res.ok) throw createError({ statusCode: 502, message: `Could not download the clip (${res.status})` })
    await writeFile(mp4Path, Buffer.from(await res.arrayBuffer()))
    const id = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const outDir = path.join(clipsRoot, id)
    const metaLine = (await py(['key', mp4Path, stillPath, keyHex, outDir, '1' /* first == last frame on both models: drop the returning frame */], 300_000))
      .split('\n').map(l => l.trim()).filter(Boolean).pop()
    const meta = JSON.parse(metaLine || '{}') as { frames?: number; fps?: number }
    if (!meta.frames || !meta.fps) throw createError({ statusCode: 500, message: 'Keying produced no frames' })

    // clip_key.py knows the frame geometry, not what made it. Fold the model and prompt
    // into the folder's own clip.json so a clip found on disk (or re-imported into another
    // project) still says where it came from, instead of that only living in the layer.
    const metaPath = path.join(outDir, 'clip.json')
    try {
      const onDisk = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
      await writeFile(metaPath, JSON.stringify({ ...onDisk, model: spec.id, prompt }, null, 2))
    } catch { /* the frames are what matter; a missing/odd clip.json is not worth failing on */ }

    return { dir: `sailor_clips/${id}`, frames: meta.frames, fps: meta.fps, model: spec.id, prompt }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
