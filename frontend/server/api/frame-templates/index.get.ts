/** List every saved frame template (full entries — templates are tiny). */
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { listOwned } from '../../utils/ownedJsonStore'
import { storeDir } from '../../utils/dataDir'

const OPTS = { kind: 'frame-template', dir: storeDir('frame-templates') }

/** The historical readdir/parse loop, extracted — id = filename stem. */
async function readAllTemplates(): Promise<Array<{ id: string, record: Record<string, any> }>> {
  let files: string[] = []
  try {
    files = (await readdir(OPTS.dir)).filter(f => f.endsWith('.json'))
  } catch {
    return [] // directory missing on fresh checkouts
  }
  const out: Array<{ id: string, record: Record<string, any> }> = []
  for (const f of files) {
    try {
      out.push({ id: basename(f, '.json'), record: JSON.parse(await readFile(join(OPTS.dir, f), 'utf8')) })
    } catch { /* skip corrupt file */ }
  }
  return out
}

export default defineEventHandler(async (event) => {
  const templates = await listOwned(OPTS, event.context.userId ?? null, readAllTemplates)
  templates.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  return { templates }
})
