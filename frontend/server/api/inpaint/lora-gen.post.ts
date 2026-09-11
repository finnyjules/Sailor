/**
 * POST /api/inpaint/lora-gen   Body: { name, prompt, aspectRatio?, loraScale?, guidanceScale?, seed? }
 *
 * Generate from a trained LoRA, used by the frame modal's "Generate Object"
 * Style mode when a style is picked. Reads models/loras/<base>.json for the
 * trigger + aesthetic, composes the prompt, runs fal's `fal-ai/flux-lora` with
 * the trained weights, and returns the image as a base64 data URL (CORS-safe) —
 * same response shape as /api/inpaint/text2img.
 *
 * Provider note: TRAINING still happens on Replicate, so the sidecar keeps its
 * `replicate_model` (`<owner>/<model>:<version>`) and `replicate_url` (the
 * trained_model.tar). Inference no longer uses that pinned version hash: the
 * weights are lifted out of the tar once by ensureFalLoraWeights(), cached on
 * the sidecar as `fal_weights_url`, and passed to flux-lora. First generation
 * per LoRA pays a one-off download + upload; later ones are instant.
 *
 * Under /api/inpaint → already allowlisted by NITRO_API_PREFIXES.
 * runFal/fetchAsDataUrl and buildLoraPrompt/promptAesthetic are auto-imported
 * from server/utils; the two new helpers are imported explicitly.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { assertRateLimit } from '../../lib/rateLimit'
import { ensureFalLoraWeights, type LoraSidecar } from '../../utils/loraFalWeights'
import { buildFalLoraGenInput } from '../../utils/loraGenInput'

const FAL_APP = 'fal-ai/flux-lora'

function safeBase(name: string): string | null {
  const base = (name || '').replace(/\.safetensors$/i, '')
  return /^[a-zA-Z0-9_-]+$/.test(base) ? base : null
}

interface Body {
  name?: string
  prompt?: string
  aspectRatio?: string
  loraScale?: number
  guidanceScale?: number
  seed?: number
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'inpaint-lora-gen', 30)
  const body = await readBody<Body>(event)

  const base = safeBase(String(body?.name ?? ''))
  if (!base) throw createError({ statusCode: 400, message: 'Invalid LoRA name' })
  const userPrompt = (body?.prompt ?? '').trim()
  if (!userPrompt) throw createError({ statusCode: 400, message: 'prompt is required' })

  const lorasDir = path.resolve(process.cwd(), '..', 'models', 'loras')
  const sidecarPath = path.join(lorasDir, `${base}.json`)
  let meta: LoraSidecar = {}
  try {
    meta = JSON.parse(await fs.readFile(sidecarPath, 'utf8'))
  } catch {
    throw createError({ statusCode: 404, message: 'No sidecar for that LoRA.' })
  }

  // Weights URL for fal — cached on the sidecar after the first generation.
  let weightsUrl: string
  try {
    weightsUrl = await ensureFalLoraWeights(sidecarPath, meta)
  } catch (e) {
    throw createError({ statusCode: 502, message: (e as Error).message || 'Could not prepare this LoRA for generation.' })
  }

  const prompt = buildLoraPrompt(
    String(meta.trigger ?? ''),
    promptAesthetic(meta),
    userPrompt,
  )

  const out = await runFal<{ images?: Array<{ url?: string }> }>(FAL_APP, buildFalLoraGenInput(prompt, {
    aspectRatio: body?.aspectRatio,
    loraScale: body?.loraScale,
    guidanceScale: body?.guidanceScale,
    seed: body?.seed,
  }, weightsUrl), { pollDeadlineMs: 300_000 })

  const url = out?.images?.[0]?.url
  if (!url) throw createError({ statusCode: 502, message: 'fal returned no image' })
  return { images: [await fetchAsDataUrl(url)], model: FAL_APP, lora: String(meta.name ?? base) }
})
