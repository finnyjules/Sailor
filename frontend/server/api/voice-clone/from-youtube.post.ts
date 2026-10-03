/**
 * POST /api/voice-clone/from-youtube
 *
 * Body: { url: string, startSec: number, endSec: number }
 *
 * Downloads the [startSec, endSec] audio segment of a YouTube video as mp3
 * (via scripts/youtube_voice_clip.py — yt-dlp + static ffmpeg in the repo venv),
 * uploads it to Replicate's files API, and returns the public URL — the same
 * `voiceFileUrl` shape /api/voice-clone/upload returns, so the trainer's existing
 * clone-start flow consumes it unchanged.
 *
 * The caller must have the rights to clone the voice (their own content, a hired
 * voice actor, or licensed/public-domain audio). Enforced in the UI, not here.
 *
 * Hosted has no Python or yt-dlp (step 3, R10.10), and yt-dlp has no small Node
 * stand-in, so there the route refuses first, before the rate limit or any
 * upload (LC7); the YouTube capture is hidden in hosted. Uploading a file
 * (/api/voice-clone/upload) is the hosted way in.
 *
 * Allowlisted via the '/api/voice-clone' prefix in server/middleware/comfyui-proxy.ts.
 */
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { assertRateLimit } from '../../lib/rateLimit'
import { isHosted } from '../../utils/deployMode'

/** The hosted refusal, exported so its spec says the same words. */
export const YOUTUBE_VOICE_HOSTED_REFUSAL = 'Capturing a voice from YouTube only works when Sailor runs on your own computer. Upload an audio file instead.'

const CLIP_CAP_SEC = 60
const CLIP_MIN_SEC = 10  // MiniMax voice cloning rejects clips shorter than this ("too short")

export default defineEventHandler(async (event) => {
  if (isHosted()) throw createError({ statusCode: 501, message: YOUTUBE_VOICE_HOSTED_REFUSAL })
  assertRateLimit(event, 'voice-clone-youtube', 3, 600_000)
  const body = await readBody(event) as { url?: string, startSec?: number, endSec?: number }
  const url = (body?.url || '').trim()
  const startSec = Number(body?.startSec)
  const endSec = Number(body?.endSec)

  if (!/^https?:\/\//.test(url)) {
    throw createError({ statusCode: 400, message: 'A valid YouTube URL is required' })
  }
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    throw createError({ statusCode: 400, message: 'endSec must be greater than startSec' })
  }
  if (endSec - startSec < CLIP_MIN_SEC) {
    throw createError({ statusCode: 400, message: `Pick at least ${CLIP_MIN_SEC}s of speech — shorter clips fail to clone` })
  }
  if (endSec - startSec > CLIP_CAP_SEC) {
    throw createError({ statusCode: 400, message: `Clip must be ${CLIP_CAP_SEC}s or shorter` })
  }

  // repo root is one level up from the Nitro cwd (frontend/)
  const root = path.resolve(process.cwd(), '..')
  const python = path.join(root, '.venv', 'bin', 'python')
  const script = path.join(root, 'scripts', 'youtube_voice_clip.py')
  const outPath = path.join(os.tmpdir(), `voice-yt_${Date.now()}.mp3`)

  // The helper clips the segment, uploads it to fal storage (a PUBLIC CDN URL —
  // MiniMax voice-cloning proxies the fetch externally and can't read an
  // auth-gated Replicate Files URL), and prints "FALURL:<url>". Errors → stderr.
  const stdout = await new Promise<string>((resolve, reject) => {
    if (isHosted()) return reject(new Error(YOUTUBE_VOICE_HOSTED_REFUSAL))
    execFile(
      python,
      [script, url, String(startSec), String(endSec), outPath],
      { timeout: 120_000, maxBuffer: 1 << 20 },
      (err, out, stderr) => {
        if (err) return reject(new Error((stderr || '').trim().split('\n').pop() || err.message))
        resolve(out || '')
      },
    )
  }).catch((e: Error) => {
    throw createError({ statusCode: 502, message: `Could not capture that segment: ${e.message}` })
  })

  const line = stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('FALURL:'))
  const voiceFileUrl = line?.slice('FALURL:'.length).trim()
  if (!voiceFileUrl) {
    throw createError({ statusCode: 502, message: 'Capture succeeded but produced no audio URL' })
  }
  return { voiceFileUrl, durationSec: Math.round(endSec - startSec) }
})
