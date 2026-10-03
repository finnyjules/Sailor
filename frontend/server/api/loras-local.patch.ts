/**
 * PATCH /api/loras-local
 *
 * Edit a trained LoRA's metadata after training by updating its .json sidecar
 * in ../models/loras (the same file GET /api/loras-local reads). Supports
 * editing `name`, `trigger`, `aesthetic` and `kind`. The weights file and its
 * filename are never touched — only the provenance sidecar.
 *
 * Body: { filename: "<name>.safetensors", name?, trigger?, aesthetic?, kind? }
 *   kind: 'character' | 'style' | null — tags the LoRA so the Characters panel
 *   can surface identity LoRAs separately from style LoRAs.
 *
 * Note: must be allowlisted in server/middleware/comfyui-proxy.ts
 * (NITRO_API_PATHS) — '/api/loras-local' already is (path match is
 * method-agnostic), so PATCH routes here rather than proxying to ComfyUI.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dataPath } from '../utils/dataRoot'
import { parseSidecar, sidecarAesthetic } from '~~/server/utils/loraPrompt'
import { isSafeLoraFilename } from '~~/server/utils/loraSidecars'
import { guardMutation } from '~~/server/utils/ownedJsonStore'

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    filename?: string
    name?: string
    trigger?: string | null
    aesthetic?: string | null
    kind?: 'character' | 'style' | null
  }>(event)

  const filename = (body?.filename || '').trim()
  // Bare .safetensors filename only — reject anything that could escape the dir.
  if (!isSafeLoraFilename(filename)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid filename' })
  }

  const lorasDir = dataPath('models', 'loras')
  const base = filename.slice(0, -'.safetensors'.length)
  const sidecarPath = path.join(lorasDir, `${base}.json`)

  // Weights OR sidecar must exist — don't write sidecars for phantom LoRAs, but
  // sidecar-only entries are legitimate: duplicated styles never have weights of
  // their own, and on the deployed server no LoRA does (inference runs on
  // Replicate via meta.replicate_model). Requiring weights locked both out.
  const present = await Promise.all(
    [path.join(lorasDir, filename), sidecarPath].map(async (p) => {
      try { await fs.access(p); return true } catch { return false }
    }),
  )
  if (!present.some(Boolean)) {
    throw createError({ statusCode: 404, statusMessage: 'LoRA not found' })
  }

  // Ownership gate (hosted only): the LoRA exists here, so a non-owner — or a
  // curated/unowned LoRA (e.g. the seeded library) — is refused with a 404.
  await guardMutation({ kind: 'lora', dir: lorasDir }, event.context?.userId ?? null, base, true)

  // Merge onto the existing sidecar (or start fresh if there isn't one).
  let meta: Record<string, any> = {}
  try {
    meta = parseSidecar(await fs.readFile(sidecarPath, 'utf8'))
  } catch { /* no/invalid sidecar — create one */ }

  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k)
  // name can't be blanked (it falls back to the filename in GET); trigger and
  // aesthetic can be cleared to null.
  if (has('name')) {
    const n = String(body.name ?? '').trim()
    if (n) meta.name = n
  }
  if (has('trigger')) {
    const t = String(body.trigger ?? '').trim()
    meta.trigger = t || null
  }
  if (has('aesthetic')) {
    const a = String(body.aesthetic ?? '').trim()
    meta.aesthetic = a || null
    // `aesthetic` is the canonical editable key. Newer sidecars hold the style
    // under `taste_profile`; if we left it, a reader preferring it could resurface
    // the old text (and clearing the field wouldn't stick). Drop it on edit.
    if ('taste_profile' in meta) delete meta.taste_profile
  }
  if (has('kind')) {
    // Only 'character' or 'style' are meaningful; anything else clears the tag.
    meta.kind = body.kind === 'character' || body.kind === 'style' ? body.kind : null
  }

  await fs.writeFile(sidecarPath, JSON.stringify(meta, null, 2), 'utf8')

  return {
    ok: true,
    name: meta.name || base,
    trigger: meta.trigger ?? null,
    aesthetic: sidecarAesthetic(meta) || null,
    kind: meta.kind ?? null,
  }
})
