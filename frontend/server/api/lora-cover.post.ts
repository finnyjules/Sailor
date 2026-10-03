/**
 * POST /api/lora-cover   Body: { name: <lora filename> }
 *
 * Generates a preview thumbnail for a trained LoRA by running it once on
 * Replicate (the trained model, with its aesthetic + trigger as the prompt),
 * and caches the result to models/loras/<base>.cover.webp. One-time per LoRA
 * (subsequent calls overwrite). Returns { coverUrl }.
 *
 * This costs one generation (~$0.04) — it's only ever triggered by an explicit
 * "Generate preview" click in the gallery, never automatically.
 *
 * Must be allowlisted in server/middleware/comfyui-proxy.ts (NITRO_API_PATHS).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dataPath } from '../utils/dataRoot'
import { assertRateLimit } from '../lib/rateLimit'
import { preflightMeter } from '../utils/requestMeter'
import { guardMutation } from '../utils/ownedJsonStore'

function safeBase(name: string): string | null {
  const base = (name || '').replace(/\.safetensors$/i, '')
  return /^[a-zA-Z0-9_-]+$/.test(base) ? base : null
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'lora-cover', 30)
  const token = requireReplicateToken()

  const body = await readBody(event) as { name?: string }
  const name = String(body?.name ?? '')
  const base = safeBase(name)
  if (!base) throw createError({ statusCode: 400, message: 'Invalid LoRA name' })

  const lorasDir = dataPath('models', 'loras')

  // Read the sidecar for the trained model ref + style.
  let meta: any = {}
  try {
    meta = JSON.parse(await fs.readFile(path.join(lorasDir, `${base}.json`), 'utf8'))
  } catch {
    throw createError({ statusCode: 404, message: 'No sidecar for that LoRA.' })
  }
  const modelRef = String(meta.replicate_model ?? '').split(':')[0] // <owner>/<model>
  if (!modelRef) {
    throw createError({ statusCode: 400, message: 'This LoRA has no trained Replicate model to run.' })
  }

  // Ownership gate (hosted only) BEFORE the paid Replicate run: writing a cover
  // is a mutation of the LoRA, so a non-owner — or a curated/unowned LoRA — is
  // refused with a 404 and never billed a generation.
  await guardMutation({ kind: 'lora', dir: lorasDir }, event.context?.userId ?? null, base, true)

  const profile = sidecarAesthetic(meta)
  const trigger = String(meta.trigger ?? '').trim()
  // Character covers are headshots: a clean studio portrait reads as "this is
  // the person", so the aesthetic (the training set's vibe) is left out — it
  // would fight the studio look. Style covers keep aesthetic-driven portraits.
  const prompt = meta.kind === 'character'
    ? [
        trigger ? `${trigger},` : '',
        'professional studio portrait photograph, head and shoulders, facing the camera,',
        'soft diffused key light, clean seamless light-gray studio background,',
        'sharp focus, high-end studio photography',
      ].filter(Boolean).join(' ')
    : [profile, trigger ? `${trigger},` : '', 'a portrait'].filter(Boolean).join(' ')

  // Paid: runs the trained LoRA model once on Replicate. modelRef is a
  // personal fine-tune slug (owner is the sidecar's trained account, e.g.
  // finnyjules/*), so resolveCredits prices it via the LoRA category rather
  // than a MODEL_COSTS row. Gate before dispatch; settle on confirmed success.
  const ticket = await preflightMeter(modelRef)
  try {

    const headers = { Authorization: `Token ${token}`, 'Content-Type': 'application/json' }

    // Resolve the model's latest version, then run it (private models 404 on the
    // model-aliased predictions endpoint, so go straight to versioned /predictions).
    const mRes = await fetch(`https://api.replicate.com/v1/models/${modelRef}`, { headers })
    if (!mRes.ok) throw createError({ statusCode: 502, message: `Could not look up ${modelRef}` })
    const version = ((await mRes.json()) as any).latest_version?.id
    if (!version) throw createError({ statusCode: 502, message: `${modelRef} has no version` })

    const cRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version,
        input: {
          prompt,
          aspect_ratio: '1:1',
          megapixels: '1',
          num_inference_steps: 22,
          guidance_scale: 3.5,
          num_outputs: 1,
          output_format: 'webp',
          lora_scale: 1,
        },
      }),
    })
    if (!cRes.ok) {
      throw createError({ statusCode: cRes.status, message: `Cover generation failed: ${await cRes.text().catch(() => cRes.statusText)}` })
    }
    let pred = await cRes.json() as { id: string, status: string, output?: unknown, error?: unknown }

    const deadline = Date.now() + 120_000
    while (!['succeeded', 'failed', 'canceled'].includes(pred.status)) {
      if (Date.now() > deadline) throw createError({ statusCode: 504, message: 'Cover generation timed out' })
      await new Promise((r) => setTimeout(r, 1500))
      const pr = await fetch(`https://api.replicate.com/v1/predictions/${pred.id}`, { headers: { Authorization: `Token ${token}` } })
      if (pr.ok) pred = await pr.json()
    }
    if (pred.status !== 'succeeded') {
      throw createError({ statusCode: 502, message: `Cover generation ${pred.status}: ${String(pred.error ?? '')}` })
    }
    await ticket?.settle('rep:' + pred.id)

    const out = pred.output
    const imgUrl = Array.isArray(out) ? out[0] : (typeof out === 'string' ? out : null)
    if (!imgUrl) throw createError({ statusCode: 502, message: 'Cover generation returned no image' })

    const dl = await fetch(imgUrl)
    if (!dl.ok) throw createError({ statusCode: 502, message: `Could not download cover (${dl.status})` })
    await fs.writeFile(path.join(lorasDir, `${base}.cover.webp`), Buffer.from(await dl.arrayBuffer()))

    return { ok: true, coverUrl: `/api/lora-cover?name=${encodeURIComponent(name)}&v=${Date.now()}` }
  } catch (e) {
    // Any throw past the preflight means no output shipped — hand the
    // reservation back instead of letting it sit until holdSweep's TTL.
    // (Releasing an already-settled hold is an idempotent no-op.)
    await ticket?.release()
    throw e
  }
})
