/**
 * The Moodboard style block, shared by the browser (app/lib/taste/styleBlock.ts
 * re-exports it) and the runner's Moodboard card (step 3, R1.1). It must
 * produce the same string as the Python node (comfy_extras/nodes_moodboard.py
 * `moodboard_style_block` over `MoodboardNode.execute`'s reading), pinned by
 * the shared fixtures in tests-unit/comfy_api_test/fixtures/ and by
 * tests/unit/fixtures/runner-cards.json (`moodboard`).
 */
import { pyStrip } from '../runner/pyText'

export interface MoodboardReading {
  summary: string
  palette: { name: string; hex: string }[]
  avoids: string[]
}

/**
 * Moodboard reading → the spec style block (moodboard spec 2026-08-06):
 * `In the style of: <summary>. Palette: <Name #HEX, …>. Avoid: <a, b>.`
 * Named palette (curated {name, hex}) rather than the wall's bare hexes.
 * Empty parts are omitted entirely — no dangling `Palette:`/`Avoid:` labels.
 * The summary is stripped as Python's str.strip() strips it.
 */
export function moodboardStyleBlock(reading: MoodboardReading): string {
  const parts: string[] = []
  const stripped = pyStrip(reading.summary)
  if (stripped) parts.push(`In the style of: ${stripped.replace(/\.?$/, '.')}`)
  if (reading.palette.length) parts.push(`Palette: ${reading.palette.map(p => `${p.name} ${p.hex}`).join(', ')}.`)
  if (reading.avoids.length) parts.push(`Avoid: ${reading.avoids.join(', ')}.`)
  return parts.join(' ')
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** A string key, absent or a string. */
const absentOrString = (o: Record<string, unknown>, k: string): boolean => !has(o, k) || typeof o[k] === 'string'

/**
 * Whether a Moodboard's `reading_json` is the plain text the moodboard window
 * writes (spec ruling 3): blank, or a JSON object whose `summary` is
 * absent/null/a string, `palette` absent/null or a list of objects whose
 * `name`/`hex` are absent or strings, and `avoids` absent/null or a list of
 * strings. Anything else (text JSON.parse refuses, including the NaN and
 * Infinity Python's json.loads takes; a list; numbers where text belongs) is
 * left to the engine, whose Python reads it its own way.
 */
export function moodboardReadingIsPlain(readingJson: unknown): boolean {
  if (typeof readingJson !== 'string') return false
  if (!pyStrip(readingJson)) return true
  let r: unknown
  try { r = JSON.parse(readingJson) }
  catch { return false }
  if (!isPlainObject(r)) return false
  if (has(r, 'summary') && r.summary !== null && typeof r.summary !== 'string') return false
  const palette = has(r, 'palette') ? r.palette : null
  if (palette !== null) {
    if (!Array.isArray(palette)) return false
    if (!palette.every(p => isPlainObject(p) && absentOrString(p, 'name') && absentOrString(p, 'hex'))) return false
  }
  const avoids = has(r, 'avoids') ? r.avoids : null
  if (avoids !== null) {
    if (!Array.isArray(avoids)) return false
    if (!avoids.every(a => typeof a === 'string')) return false
  }
  return true
}

/**
 * `MoodboardNode.execute(reading_json)`: blank or unreadable text, or JSON
 * that is not an object, is the empty block. Exact for a plain reading
 * (moodboardReadingIsPlain); the runner takes no other.
 */
export function moodboardStyleFromJson(readingJson: string): string {
  if (!pyStrip(readingJson)) return ''
  let r: unknown
  try { r = JSON.parse(readingJson) }
  catch { return '' }
  if (!isPlainObject(r)) return ''
  const palette = Array.isArray(r.palette) ? r.palette as Record<string, unknown>[] : []
  const avoids = Array.isArray(r.avoids) ? r.avoids as unknown[] : []
  return moodboardStyleBlock({
    summary: String(r.summary ?? ''),
    palette: palette.map(p => ({ name: String(p?.name ?? ''), hex: String(p?.hex ?? '') })),
    avoids: avoids.map(a => String(a)),
  })
}
