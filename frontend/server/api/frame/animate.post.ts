/**
 * Animate a Frame image layer: make a looping, transparent clip from a still.
 *
 *   1. flatten the RGBA still onto a key colour (scripts/clip_key.py flatten)
 *   2. call the video model with the still as first AND last frame (Luma: loop flag)
 *   3. key every returned frame back to transparency (scripts/clip_key.py key)
 *   4. write input/sailor_clips/<id>/000000.png … + clip.json
 *
 * The model call goes through runFal / runReplicate so the ledger hold, prompt
 * moderation, polling and release-on-failure are the shared ones. The Python steps
 * are execFile'd from the repo venv, like voice-clone/from-youtube.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertRateLimit } from '../../lib/rateLimit'
import { runFal, firstFalVideoUrl } from '../../utils/falRun'
import { uploadToFalStorage } from '../../utils/falStorage'
import { dataUrlBytes, lumaAspect } from '../../utils/frameAnimate'
import { clipModel } from '~~/app/data/clip-models'

interface Body { image?: string; prompt?: string; model?: string; seconds?: number }

const ROOT = path.resolve(process.cwd(), '..')
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python')
const SCRIPT = path.join(ROOT, 'scripts', 'clip_key.py')
const CLIPS_DIR = path.join(ROOT, 'input', 'sailor_clips')
const PROMPT_SUFFIX = (key: 'green' | 'blue') =>
  `, plain flat ${key} background, no shadows, camera locked, gentle motion`

function py(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [SCRIPT, ...args], { timeout: timeoutMs, maxBuffer: 1 << 22 }, (err, out, stderr) => {
      if (err) return reject(new Error((stderr || '').trim().split('\n').pop() || err.message))
      resolve(out || '')
    })
  })
}

export default defineEventHandler(async (event) => {
  // Validate BEFORE rate-limiting (review fix): assertRateLimit used to run
  // first, so six malformed requests (bad image, unknown model, junk PNG)
  // burned the whole 6-per-10-min budget and locked the user out for real
  // attempts. dataUrlBytes/lumaAspect live in server/utils/frameAnimate.ts —
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

  assertRateLimit(event, 'frame-animate', 6, 600_000)

  const seconds = spec.durations.includes(Number(body.seconds)) ? Number(body.seconds) : spec.defaultDuration
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

    // the flattened still must be a URL for both providers
    const flatBytes = await readFile(flatPath)
    const stillUrl = await uploadToFalStorage(new Uint8Array(flatBytes), 'still.png', 'image/png')

    // 2. the model
    //
    // Metering (review fix, finding 1): server/utils/priceBook.ts's
    // MODEL_COSTS now carries a flat row for each of the three exact slugs
    // dispatched below, priced from the 5s row in app/data/video-prices.ts —
    // without those rows preflightMeter (inside runFal/runReplicate) refused
    // every call with "unpriced model refused" before any request could ever
    // resolve credits, let alone reach the model. A duration-aware hold
    // (credits scaled by `seconds` via clipPriceUsd + setMeterPriceHint) was
    // investigated but NOT wired: requestMeter's resolveCredits() checks
    // costForModel(model) FIRST and only consults priceHintCredits when the
    // model is UNPRICED, so once a flat MODEL_COSTS row exists for a slug any
    // hint set here is silently ignored — flipping that precedence would
    // change a shared chokepoint every metered route relies on, which is out
    // of scope for this fix. The hold is therefore flat per model regardless
    // of `seconds`: a 12s Seedance clip costs the same hold as a 4s one.
    let videoUrl: string | null = null
    if (spec.id === 'seedance-2.0') {
      const out = await runFal('bytedance/seedance-2.0/image-to-video', {
        prompt: fullPrompt, duration: String(seconds), resolution: '720p',
        image_url: stillUrl, end_image_url: stillUrl,
      }, { pollDeadlineMs: 900_000 })
      videoUrl = firstFalVideoUrl(out)
    } else if (spec.id === 'hailuo-h3') {
      const out = await runFal('minimax/h3/image-to-video', {
        prompt: fullPrompt, duration: seconds, resolution: '768P', prompt_expansion_mode: 'balanced',
        image_url: stillUrl, end_image_url: stillUrl,
      }, { pollDeadlineMs: 900_000 })
      videoUrl = firstFalVideoUrl(out)
    } else {
      const token = requireReplicateToken()
      const { width, height } = await pngSize(flatBytes)
      const out = await runReplicate('luma/ray-2-720p', {
        prompt: fullPrompt, aspect_ratio: lumaAspect(width, height), duration: seconds, loop: true,
        start_image_url: stillUrl,
      }, token, { timeoutMs: 900_000 })
      videoUrl = firstOutputUrl(out)
    }
    if (!videoUrl) throw createError({ statusCode: 502, message: 'The model returned no video' })

    // 3. key it back to transparency
    const mp4Path = path.join(tmp, 'clip.mp4')
    const res = await fetch(videoUrl)
    if (!res.ok) throw createError({ statusCode: 502, message: `Could not download the clip (${res.status})` })
    await writeFile(mp4Path, Buffer.from(await res.arrayBuffer()))
    const id = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const outDir = path.join(CLIPS_DIR, id)
    const metaLine = (await py(['key', mp4Path, stillPath, keyHex, outDir, spec.loopsItself ? '0' : '1'], 300_000))
      .split('\n').map(l => l.trim()).filter(Boolean).pop()
    const meta = JSON.parse(metaLine || '{}') as { frames?: number; fps?: number }
    if (!meta.frames || !meta.fps) throw createError({ statusCode: 500, message: 'Keying produced no frames' })

    return { dir: `sailor_clips/${id}`, frames: meta.frames, fps: meta.fps, model: spec.id, prompt }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})

/** PNG header width/height (IHDR is always the first chunk). */
async function pngSize(bytes: Buffer): Promise<{ width: number; height: number }> {
  if (bytes.length < 24) return { width: 1, height: 1 }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}
