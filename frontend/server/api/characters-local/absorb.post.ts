// POST /api/characters-local/absorb (no body)
//
// Migration bridge: scan the LoRA library's *.json for kind === 'character' sidecars
// and create a registry record (library/characters/<slug>.json) for each one
// that doesn't already have one. Idempotent — re-running only reports what's
// already there, never duplicates or overwrites.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { libraryDir, listLibrary } from '../../utils/library'
import { parseSidecar } from '~~/server/utils/loraPrompt'
import { parseCharacterRecord, slugifyCharacterName, type CharacterRecord } from '~~/server/utils/characterRegistry'
import { claimNew } from '~~/server/utils/ownedJsonStore'
import { emptyState } from '#shared/characters/types'

export default defineEventHandler(async (event) => {
  const charactersDir = libraryDir('characters')

  // Each file name with the folder it is in (the library first; library.ts).
  const loraWhere = await listLibrary('loras')
  if (!loraWhere.size) return { created: [], existing: [] }
  const loraFiles = [...loraWhere.keys()]

  // Mirror loras-local.get.ts's filename derivation: a LoRA is identified by
  // its weights file (<base>.safetensors); a sidecar without one is skipped.
  const weightsBases = new Set<string>()
  for (const f of loraFiles) {
    if (f.endsWith('.safetensors')) weightsBases.add(f.slice(0, -'.safetensors'.length))
  }

  const candidates: Array<{ base: string, weightsFilename: string, name: string, trigger: string | null }> = []
  for (const f of loraFiles) {
    if (!f.endsWith('.json')) continue
    const base = f.slice(0, -'.json'.length)
    if (!weightsBases.has(base)) continue // no weights file — skip
    let meta: Record<string, any> = {}
    try { meta = parseSidecar(await fs.readFile(path.join(loraWhere.get(f)!, f), 'utf8')) } catch { continue }
    if (meta.kind !== 'character') continue
    candidates.push({
      base,
      weightsFilename: `${base}.safetensors`,
      name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : base,
      trigger: typeof meta.trigger === 'string' && meta.trigger ? meta.trigger : null,
    })
  }

  await fs.mkdir(charactersDir, { recursive: true })
  const registryWhere = await listLibrary('characters')
  const registryFiles = [...registryWhere.keys()]

  const existingRecords: CharacterRecord[] = []
  for (const f of registryFiles.filter(f => f.endsWith('.json'))) {
    const slug = f.slice(0, -5)
    let parsed: CharacterRecord | null = null
    try { parsed = parseCharacterRecord(await fs.readFile(path.join(registryWhere.get(f)!, f), 'utf8'), slug) }
    catch { continue }
    if (parsed) existingRecords.push(parsed)
  }

  const created: string[] = []
  const existing: string[] = []

  for (const c of candidates) {
    const bySlug = slugifyCharacterName(c.name)
    const match = existingRecords.find(r => r.loraName === c.weightsFilename || r.slug === bySlug)
    if (match) {
      existing.push(match.slug)
      continue
    }
    if (!bySlug) { existing.push(c.base); continue }

    const now = new Date().toISOString()
    const record: CharacterRecord = {
      name: c.name,
      slug: bySlug,
      face: null, photos: [], voice: null, origin: 'photos', likenessConfirmed: false, style: 'photo', linkedFrom: null,
      loraName: c.weightsFilename,
      trigger: c.trigger,
      bodyShape: null,
      notes: '',
      states: [emptyState('default', 'Default')],
      createdAt: now,
      updatedAt: now,
    }
    await fs.writeFile(path.join(charactersDir, `${bySlug}.json`), JSON.stringify(record, null, 2))
    // Claim ownership (hosted only) for the freshly-materialized character.
    await claimNew({ kind: 'character', dir: charactersDir }, event.context?.userId ?? null, bySlug)
    existingRecords.push(record) // guard duplicate candidates within this same run
    created.push(bySlug)
  }

  return { created, existing }
})
