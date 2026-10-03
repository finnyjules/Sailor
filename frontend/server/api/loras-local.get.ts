/**
 * GET /api/loras-local
 *
 * Lists the LoRAs in ../models/loras (where cloud training drops the trained
 * .safetensors + a .json provenance sidecar). Returns name, base model,
 * provider, the public CDN url (if any), size and date so the LoRA panel can
 * show a "Your LoRAs" section alongside the curated library.
 *
 * Note: must be allowlisted in server/middleware/comfyui-proxy.ts
 * (NITRO_API_PATHS) — otherwise /api/* is proxied to ComfyUI and 404s here.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dataPath } from '../utils/dataRoot'
import { parseSidecar, sidecarAesthetic } from '../utils/loraPrompt'
import { listOwned } from '../utils/ownedJsonStore'

export default defineEventHandler(async (event) => {
  const lorasDir = dataPath('models', 'loras')

  let files: string[] = []
  try {
    files = await fs.readdir(lorasDir)
  } catch {
    return { loras: [] }
  }

  const out: Array<{
    filename: string
    name: string
    baseModel: string | null
    provider: string
    trigger: string | null
    aesthetic: string | null
    kind: 'character' | 'style' | null
    duplicateOf: string | null
    model: string | null
    url: string | null
    coverUrl: string | null
    canGenerateCover: boolean
    trainedOn: string | null
    sizeBytes: number | null
  }> = []

  // Derive one entry per LoRA from either the weights (.safetensors) or the
  // provenance sidecar (.json). On the deployed server the heavy .safetensors
  // are intentionally absent (inference runs on Replicate via meta.replicate_model),
  // so the sidecar alone is enough to populate the "Your LoRAs" library.
  const bases = new Set<string>()
  for (const f of files) {
    if (f.endsWith('.safetensors')) bases.add(f.slice(0, -'.safetensors'.length))
    else if (f.endsWith('.json')) bases.add(f.slice(0, -'.json'.length))
  }

  for (const base of bases) {
    const f = `${base}.safetensors`

    let meta: Record<string, any> = {}
    try {
      meta = parseSidecar(await fs.readFile(path.join(lorasDir, `${base}.json`), 'utf8'))
    } catch { /* no sidecar */ }

    let trainedOn: string | null = meta.trained_on ?? null
    let sizeBytes: number | null = null
    try {
      const st = await fs.stat(path.join(lorasDir, f))
      sizeBytes = st.size
      if (!trainedOn) trainedOn = st.mtime.toISOString()
    } catch { /* weights absent (e.g. on the deployed server) — sidecar only */ }

    // Cover thumbnail, if one's been generated (POST /api/lora-cover). Cache-bust
    // by mtime so a regenerated cover refreshes in the gallery.
    let coverUrl: string | null = null
    for (const ext of ['webp', 'png', 'jpg']) {
      try {
        const st = await fs.stat(path.join(lorasDir, `${base}.cover.${ext}`))
        coverUrl = `/api/lora-cover?name=${encodeURIComponent(f)}&v=${Math.floor(st.mtimeMs)}`
        break
      } catch { /* no cover of this ext */ }
    }

    out.push({
      filename: f,
      name: meta.name || base,
      baseModel: meta.base_model ?? null,
      provider: meta.provider || (meta.replicate_url ? 'replicate' : 'local'),
      trigger: meta.trigger ?? null,
      aesthetic: sidecarAesthetic(meta) || null,
      // 'character' = usable as an identity LoRA in the Characters panel;
      // anything else (incl. legacy untagged) is treated as a style.
      kind: meta.kind === 'character' ? 'character' : (meta.kind === 'style' ? 'style' : null),
      // Name of the style this was duplicated from — the gallery gates its
      // Delete affordance on it (only duplicates are removable).
      duplicateOf: meta.duplicate_of ?? null,
      // The runnable trained Replicate model ref (<owner>/<model>[:<version>]) — the
      // robust way to run this LoRA (the agent sets it as lora_url, which the backend
      // resolves directly, bypassing fragile filename→sidecar lookup).
      model: meta.replicate_model ?? null,
      url: meta.replicate_url ?? null,
      coverUrl,
      canGenerateCover: !!meta.replicate_model,
      trainedOn,
      sizeBytes,
    })
  }

  // Hosted → caller-owned + curated (unowned, incl. the operator-seeded library
  // whose real weights sit on disk with no owner row) only; local → everything.
  // Ownership is keyed by the LoRA base name (the filename stem).
  const loras = await listOwned(
    { kind: 'lora', dir: lorasDir },
    event.context?.userId ?? null,
    async () => out.map(o => ({ id: o.filename.slice(0, -'.safetensors'.length), record: o })),
  )
  loras.sort((a, b) => String(b.trainedOn || '').localeCompare(String(a.trainedOn || '')))
  return { loras }
})
