/**
 * POST /api/lipsync/speech
 * Body: { text: string, voiceId: string }
 * Generates speech via MiniMax Speech-02 (built-in AND cloned voices are both
 * MiniMax voice_ids) and saves the mp3 into the ComfyUI input dir, returning a
 * '/view?filename=…&type=input' URL that FilmShotNode/LipSyncNode resolve at
 * execute. Must be allowlisted in server/middleware/comfyui-proxy.ts.
 *
 * Stage 6 (Task 6): this writes straight into the shared engine input dir,
 * bypassing /upload — so, like the moodboard writers (Task 4), the write is
 * recorded against the caller in `input_uploads` (hosted only) so the
 * refilled /object_info pickers and the graph-reference validator see it as
 * the caller's own file.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dataPath } from '../../utils/dataRoot'
import { assertRateLimit } from '../../lib/rateLimit'
import { preflightMeter } from '../../utils/requestMeter'
import { canonicalUploadKey, recordUpload } from '../../utils/inputUploads'
import { isHosted } from '../../utils/deployMode'

const SPEECH_MODEL = 'minimax/speech-02-turbo'

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'lipsync-speech', 6)
  const token = requireReplicateToken()
  const body = await readBody(event) as { text?: string, voiceId?: string }
  const text = (body?.text || '').trim()
  const voiceId = (body?.voiceId || '').trim()
  if (!text) throw createError({ statusCode: 400, message: 'text is required' })
  if (!voiceId) throw createError({ statusCode: 400, message: 'voiceId is required' })

  // Paid: creates a Replicate prediction on SPEECH_MODEL. Gate before dispatch;
  // settle only once the prediction has actually reached 'succeeded' below.
  const ticket = await preflightMeter(SPEECH_MODEL)
  try {

    const headers = { Authorization: `Token ${token}`, 'Content-Type': 'application/json' }

    // Official-model predictions endpoint (no version lookup needed).
    const createRes = await fetch(`https://api.replicate.com/v1/models/${SPEECH_MODEL}/predictions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: { text, voice_id: voiceId } }),
    })
    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => '')
      throw createError({ statusCode: createRes.status, message: errText || `speech gen failed: ${createRes.statusText}` })
    }
    let pred = await createRes.json() as { id: string, status: string, output?: string | string[], error?: unknown }

    // Poll until terminal (Speech-02-turbo is short, a handful of seconds).
    const deadline = Date.now() + 60_000
    while (pred.status !== 'succeeded' && pred.status !== 'failed' && pred.status !== 'canceled') {
      if (Date.now() > deadline) {
        throw createError({ statusCode: 504, message: 'Speech generation timed out' })
      }
      await new Promise((r) => setTimeout(r, 1500))
      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, { headers })
      if (!pollRes.ok) continue
      pred = await pollRes.json()
    }
    if (pred.status !== 'succeeded') {
      throw createError({ statusCode: 502, message: `Speech generation ${pred.status}: ${String(pred.error ?? '')}` })
    }
    await ticket?.settle('rep:' + pred.id)

    const url = Array.isArray(pred.output) ? pred.output[0] : pred.output
    if (!url) throw createError({ statusCode: 502, message: 'speech gen returned no audio' })

    // Download the mp3 and drop it into the ComfyUI input dir.
    const audioRes = await fetch(url)
    if (!audioRes.ok) throw createError({ statusCode: 502, message: `could not fetch generated audio: ${audioRes.status}` })
    const buf = Buffer.from(await audioRes.arrayBuffer())
    const inputDir = dataPath('input')
    await fs.mkdir(inputDir, { recursive: true })
    const filename = `lipsync-voice_${Date.now()}.mp3`
    await fs.writeFile(path.join(inputDir, filename), buf)
    if (isHosted() && event.context.userId) {
      await recordUpload(event.context.userId, canonicalUploadKey('input', '', filename))
    }

    return { viewUrl: `/view?${new URLSearchParams({ filename, type: 'input' })}` }
  } catch (e) {
    // Any throw past the preflight means no output shipped — hand the
    // reservation back instead of letting it sit until holdSweep's TTL.
    // (Releasing an already-settled hold is an idempotent no-op.)
    await ticket?.release()
    throw e
  }
})
