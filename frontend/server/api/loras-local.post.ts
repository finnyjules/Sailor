/**
 * POST /api/loras-local
 *
 * Duplicate a trained LoRA's identity so one training run can carry several
 * taste profiles. Writes a NEW .json sidecar in ../models/loras pointing at the
 * SAME hosted weights — no .safetensors is copied (they're ~350 MB and would be
 * byte-identical). GET /api/loras-local already derives one entry per base name
 * from either the weights or the sidecar, so the copy shows up in the LoRA
 * gallery and the Style Publisher with no further wiring.
 *
 * Body: { filename: "<name>.safetensors", name: "<new display name>" }
 *
 * Note: shares the exact path '/api/loras-local', which is already allowlisted in
 * server/middleware/comfyui-proxy.ts (NITRO_API_PATHS matches the path, not the
 * method). A nested route like /api/loras-local/duplicate would NOT match that
 * exact-path entry and would be proxied to ComfyUI.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dataPath } from '../utils/dataRoot'
import { parseSidecar } from '~~/server/utils/loraPrompt'
import { isSafeLoraFilename, loraBaseName, buildDuplicateSidecar } from '~~/server/utils/loraSidecars'
import { claimNew } from '~~/server/utils/ownedJsonStore'
import { deployMode } from '~~/server/utils/deployMode'
import { ownerOf } from '~~/server/utils/resourceOwners'

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ filename?: string, name?: string }>(event)

  const filename = (body?.filename || '').trim()
  if (!isSafeLoraFilename(filename)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid filename' })
  }
  const newName = (body?.name || '').trim()
  if (!newName) throw createError({ statusCode: 400, statusMessage: 'name required' })

  const newBase = loraBaseName(newName)
  if (!newBase) throw createError({ statusCode: 400, statusMessage: 'name has no usable characters' })

  const lorasDir = dataPath('models', 'loras')
  const sourceBase = filename.slice(0, -'.safetensors'.length)

  // Ownership gate (hosted only, security): without this, anyone who knows
  // another tenant's LoRA base name could duplicate their PRIVATE trained
  // model into a runnable sidecar (replicate_model/replicate_url copied
  // below) and generate with it. Only curated (unowned) or the caller's own
  // source may be duplicated — a 404, not 403, so the response doesn't
  // disclose whether the base name exists at all. Checked BEFORE the source
  // is read; the source file itself is never touched by a refused caller.
  if (deployMode() === 'hosted') {
    const owner = await ownerOf('lora', sourceBase)
    const userId = event.context?.userId ?? null
    if (!(owner === null || owner === userId)) {
      throw createError({ statusCode: 404, statusMessage: 'LoRA sidecar not found' })
    }
  }

  let source: Record<string, any>
  try {
    source = parseSidecar(await fs.readFile(path.join(lorasDir, `${sourceBase}.json`), 'utf8'))
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'LoRA sidecar not found' })
  }

  // Without a hosted model ref the copy has nothing to run — the weights stay
  // under the ORIGINAL filename, and a sidecar alone can't reach them.
  if (!source.replicate_model) {
    throw createError({
      statusCode: 422,
      statusMessage: 'This LoRA has no hosted model ref, so a copy would have nothing to run.',
    })
  }

  // Refuse if anything already occupies the target base — a sidecar (another
  // style) or weights (a real trained LoRA we must never overwrite).
  const taken = await Promise.all(
    ['json', 'safetensors'].map(ext => exists(path.join(lorasDir, `${newBase}.${ext}`))),
  )
  if (taken.some(Boolean)) {
    throw createError({ statusCode: 409, statusMessage: `"${newName}" already exists` })
  }

  const dup = buildDuplicateSidecar(source, newName)
  await fs.writeFile(path.join(lorasDir, `${newBase}.json`), JSON.stringify(dup, null, 2), 'utf8')
  // The duplicate is a brand-new record — claim it (hosted only) for its creator.
  await claimNew({ kind: 'lora', dir: lorasDir }, event.context?.userId ?? null, newBase)

  // The gallery keys entries by "<base>.safetensors" whether or not weights are
  // on disk (see GET), so hand back that identity.
  return {
    ok: true,
    filename: `${newBase}.safetensors`,
    name: newName,
    trigger: dup.trigger ?? null,
    aesthetic: dup.aesthetic ?? null,
    kind: dup.kind ?? null,
  }
})
