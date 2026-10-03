// List castable characters. Records self-heal on read: refs whose input-dir
// file vanished are dropped and the healed record is written back.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { dataPath } from '../utils/dataRoot'
import { libraryDir, listLibrary } from '../utils/library'
import { healRefImages, parseCharacterRecord } from '~~/server/utils/characterRegistry'
import { listOwned } from '~~/server/utils/ownedJsonStore'

export default defineEventHandler(async (event) => {
  const dir = libraryDir('characters')
  const inputDir = dataPath('input')
  // Each record with the folder it is in (the library first; library.ts).
  const where = await listLibrary('characters')
  if (!where.size) return { characters: [] }
  const files = [...where.keys()]
  const at = (name: string) => path.join(where.get(name) ?? dir, name)

  // Capture readdir success explicitly. If the input dir listing fails (missing,
  // transient FS error, etc.), `existing` stays null and we must NOT heal: healing
  // against an empty/failed listing would read as "every ref is missing" and wipe
  // refImages on every record, then write that back — an irreversible data loss
  // from one transient error. Skip healing entirely in that case.
  let existing: Set<string> | null = null
  try { existing = new Set(await fs.readdir(inputDir)) } catch { /* input dir unreadable — do not heal */ }

  const characters = []
  for (const f of files.filter(f => f.endsWith('.json'))) {
    const slug = f.slice(0, -5)
    let parsed
    try { parsed = parseCharacterRecord(await fs.readFile(at(f), 'utf8'), slug) }
    catch { continue }
    if (!parsed) continue
    if (existing === null) {
      characters.push(parsed)
      continue
    }
    const { record, dropped } = healRefImages(parsed, name => existing!.has(name))
    if (dropped) {
      record.updatedAt = new Date().toISOString()
      await fs.writeFile(at(f), JSON.stringify(record, null, 2)).catch(() => {})
    }
    characters.push(record)
  }
  // Hosted → caller-owned + curated (unowned) records only; local → everything.
  // Ownership is keyed by slug (the filename stem).
  const visible = await listOwned(
    { kind: 'character', dir },
    event.context?.userId ?? null,
    async () => characters.map(r => ({ id: r.slug, record: r })),
  )
  visible.sort((a, b) => a.name.localeCompare(b.name))
  return { characters: visible }
})
