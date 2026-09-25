/** The one shader-effect gallery helper every picker shares (AI in Sailor spec §7.3, §7.4):
 *  My effects first, then the built-in sections. Pure data — no thumbnails, no DOM — so a host
 *  with no thumbnail renderer (the fill editor, Frame's effect stack) uses it as-is. */
import type { CatalogSection } from '~/lib/catalogSections'
import { isPickable } from '~/lib/myEffects/defs'
import { myEffectRecordById, myEffectRecords } from '~/lib/myEffects/library'
import type { EffectDef } from './types'

/** Built-in picker sections: image-transforming families first, generators last as their own
 *  shelf. Items are sorted in this order so keyboard nav follows the visual grouping. */
export const SHADER_SECTIONS: CatalogSection[] = [
  { id: 'distortion', label: 'Distortion' },
  { id: 'material', label: 'Material' },
  { id: 'stylize', label: 'Stylize' },
  { id: 'color', label: 'Color' },
  { id: 'lens', label: 'Lens' },
  { id: 'blur', label: 'Blur' },
  { id: 'glow', label: 'Glow' },
  { id: 'generative', label: 'Generative' },
]

const MINE: CatalogSection = { id: 'mine', label: 'My effects' }
export const SHADER_GALLERY_SECTIONS: CatalogSection[] = [MINE, ...SHADER_SECTIONS]

export function sectionOfEffect(d: EffectDef): string {
  return d.mine ? MINE.id : d.category
}

/** A My effect is listed only while the library holds it: the user's own saved effects. A
 *  shared project's copy (adopted, so the project renders) that isn't in the library is never
 *  listed, and neither is anything before the library loads (the takes kept this session are
 *  in it already). So a picker never lists an effect and then drops it, and a failed list
 *  call never leaves someone else's copies listed. */
const defaultListed = (id: string): boolean => !!myEffectRecordById(id)

type Include = (d: EffectDef) => boolean
type Listed = (id: string) => boolean

function pickable(effects: EffectDef[], include?: Include, listed: Listed = defaultListed): EffectDef[] {
  return effects.filter(d => isPickable(d) && (!d.mine || listed(d.id)) && (!include || include(d)))
}

const titleCase = (s: string): string =>
  s.replace(/(^|[_\s])(\w)/g, (_, sep, c) => (sep ? ' ' : '') + c.toUpperCase()).trim()

function labelOf(section: string): string {
  return SHADER_GALLERY_SECTIONS.find(s => s.id === section)?.label ?? titleCase(section)
}

/** Built-in category order: SHADER_SECTIONS, then any other category. */
function rank(category: string): number {
  const i = SHADER_SECTIONS.findIndex(s => s.id === category)
  return i < 0 ? SHADER_SECTIONS.length : i
}

/** Rank for sorting: My effects (library order, newest first), then SHADER_SECTIONS order,
 *  then any other category. Array.sort is stable, so ties keep the incoming order. */
function rankOf(d: EffectDef): number {
  if (d.mine) {
    const i = myEffectRecords.value.findIndex(r => r.id === d.id)
    return i < 0 ? -1 : -1_000_000 + i // library order first; a project's copy after them
  }
  return rank(d.category)
}

/** Filter chips: All, My effects (always, even at 0), then each category present, in section order. */
export function shaderGalleryFilters(effects: EffectDef[], include?: Include, listed?: Listed): { id: string; label: string; count: number }[] {
  const shown = pickable(effects, include, listed)
  const counts = new Map<string, number>()
  for (const d of shown) counts.set(sectionOfEffect(d), (counts.get(sectionOfEffect(d)) ?? 0) + 1)
  const ids = [...counts.keys()].filter(id => id !== MINE.id)
    .sort((a, b) => rank(a) - rank(b))
  return [
    { id: 'all', label: 'All', count: shown.length },
    { id: MINE.id, label: MINE.label, count: counts.get(MINE.id) ?? 0 },
    ...ids.map(id => ({ id, label: labelOf(id), count: counts.get(id)! })),
  ]
}
/** The effects a picker lists for a chip and a search (name, category or origin; any case).
 *  Call it (and shaderGalleryFilters) inside a `computed`: both read the My effects library
 *  refs, so a rename, a removal or the library landing re-runs the picker with no catalog
 *  change at all. */
export function shaderGalleryItems(
  effects: EffectDef[],
  o: { filter: string; query: string; include?: Include; listed?: Listed },
): EffectDef[] {
  const q = o.query.trim().toLowerCase()
  return pickable(effects, o.include, o.listed)
    .filter(d => o.filter === 'all' || sectionOfEffect(d) === o.filter)
    .filter(d => !q || d.name.toLowerCase().includes(q) || d.category.toLowerCase().includes(q) || (d.from ?? '').toLowerCase().includes(q))
    .sort((a, b) => rankOf(a) - rankOf(b))
}

/** The small line under an effect's name on a picker trigger or a stack row: "My effect" for the
 *  user's own (a previewed take is a "Take"), the category otherwise. Never an id or "mine". */
export function effectKindLabel(d: EffectDef): string {
  if (d.draft) return 'Take'
  if (d.mine || d.versionOf || d.category === MINE.id) return 'My effect'
  return titleCase(d.category)
}

/** A gallery card's subtitle: a My effect says where it came from, quoting that effect's name. */
export function effectCardSubtitle(d: EffectDef): string {
  if (!d.mine) return d.category
  return d.from ? `My effect · from “${d.from}”` : 'My effect'
}
