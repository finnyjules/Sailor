/**
 * DELETE /api/loras-local
 *
 * Remove a duplicated style — its .json sidecar plus any generated cover.
 *
 * Two independent guards, both required, so trained styles are unreachable from
 * this route rather than protected by a confirm dialog:
 *   1. no matching .safetensors on disk (never orphan real weights), and
 *   2. the sidecar carries `duplicate_of` (it was created by POST, not training).
 *
 * Guard 2 is what makes this safe on the DEPLOYED server, where no LoRA has
 * weights on disk (inference runs on Replicate) and guard 1 alone would happily
 * delete a real trained style's provenance.
 *
 * Body: { filename: "<name>.safetensors" }
 *
 * Note: shares the exact path '/api/loras-local' already allowlisted in
 * server/middleware/comfyui-proxy.ts (path match is method-agnostic).
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dataPath } from '../utils/dataRoot'
import { parseSidecar } from '~~/server/utils/loraPrompt'
import { isSafeLoraFilename } from '~~/server/utils/loraSidecars'
import { guardMutation, releaseRecord } from '~~/server/utils/ownedJsonStore'

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ filename?: string }>(event)

  const filename = (body?.filename || '').trim()
  if (!isSafeLoraFilename(filename)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid filename' })
  }

  const lorasDir = dataPath('models', 'loras')
  const base = filename.slice(0, -'.safetensors'.length)

  // Ownership gate (hosted only), composed with the two existing guards below.
  // Runs FIRST so another user's duplicate — or a curated/unowned LoRA — 404s
  // before the weights-on-disk / duplicate_of checks can leak a 409. A LoRA the
  // caller owns passes here and is still subject to those rules (own real-weights
  // LoRAs stay unreachable; only own duplicated styles delete).
  const present = (await exists(path.join(lorasDir, filename))) || (await exists(path.join(lorasDir, `${base}.json`)))
  await guardMutation({ kind: 'lora', dir: lorasDir }, event.context?.userId ?? null, base, present)

  if (await exists(path.join(lorasDir, filename))) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This LoRA has trained weights on disk — only duplicated styles can be deleted here.',
    })
  }

  const sidecarPath = path.join(lorasDir, `${base}.json`)
  let meta: Record<string, any>
  try {
    meta = parseSidecar(await fs.readFile(sidecarPath, 'utf8'))
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'LoRA not found' })
  }
  if (!meta.duplicate_of) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Only duplicated styles can be deleted here.',
    })
  }

  await fs.unlink(sidecarPath)
  // Drop the ownership row so the base name can never resurface as an orphan claim.
  await releaseRecord({ kind: 'lora', dir: lorasDir }, base)

  // Covers are optional and named by extension — clear whichever exists.
  for (const ext of ['webp', 'png', 'jpg']) {
    try { await fs.unlink(path.join(lorasDir, `${base}.cover.${ext}`)) } catch { /* none of this ext */ }
  }

  return { ok: true, filename }
})
