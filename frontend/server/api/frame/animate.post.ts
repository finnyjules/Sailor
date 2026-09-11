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
import { clipModel } from '~~/app/data/clip-models'

interface Body { image?: string; prompt?: string; model?: string; seconds?: number }

const ROOT = path.resolve(process.cwd(), '..')
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python')
const SCRIPT = path.join(ROOT, 'scripts', 'clip_key.py')
const CLIPS_DIR = path.join(ROOT, 'input', 'sailor_clips')
const PROMPT_SUFFIX = (key: 'green' | 'blue') =>
  `, plain flat ${key} background, no shadows, camera locked, gentle motion`
const LUMA_AR = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const

function py(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [SCRIPT, ...args], { timeout: timeoutMs, maxBuffer: 1 << 22 }, (err, out, stderr) => {
      if (err) return reject(new Error((stderr || '').trim().split('\n').pop() || err.message))
      resolve(out || '')
    })
  })
}

function dataUrlBytes(dataUrl: string): Buffer {
  const i = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:image/') || i < 0) throw createError({ statusCode: 400, message: 'image must be a PNG data URL' })
  return Buffer.from(dataUrl.slice(i + 1), 'base64')
}

/** Closest Luma aspect to the still (Luma needs one even for image-to-video). */
function lumaAspect(w: number, h: number): string {
  const r = w / Math.max(1, h)
  let best = LUMA_AR[0] as string, err = Infinity
  for (const ar of LUMA_AR) {
    const [a, b] = ar.split(':').map(Number)
    const e = Math.abs(Math.log(r / (a / b)))
    if (e < err) { err = e; best = ar }
  }
  return best
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'frame-animate', 6, 600_000)
  const body = await readBody<Body>(event)
  const spec = clipModel(body?.model ?? '')
  if (!body?.image) throw createError({ statusCode: 400, message: 'image is required' })
  if (!spec) throw createError({ statusCode: 400, message: 'unknown model' })
  const seconds = spec.durations.includes(Number(body.seconds)) ? Number(body.seconds) : spec.defaultDuration
  const prompt = (body.prompt ?? '').trim()

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sailor-clip-'))
  try {
    // 1. flatten onto the key colour
    const stillPath = path.join(tmp, 'still.png')
    const flatPath = path.join(tmp, 'flat.png')
    await writeFile(stillPath, dataUrlBytes(body.image))
    const keyLine = (await py(['flatten', stillPath, flatPath], 60_000)).split('\n').find(l => l.startsWith('KEY:'))
    if (!keyLine) throw createError({ statusCode: 500, message: 'Could not prepare the still' })
    const keyHex = keyLine.slice(4).trim()
    const keyName = keyHex === '#0000ff' ? 'blue' : 'green'
    const fullPrompt = (prompt || 'the subject moves gently') + PROMPT_SUFFIX(keyName)

    // the flattened still must be a URL for both providers
    const flatBytes = await readFile(flatPath)
    const stillUrl = await uploadToFalStorage(new Uint8Array(flatBytes), 'still.png', 'image/png')

    // 2. the model
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
