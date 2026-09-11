import type { ColourSite } from './sites'
export interface Slot { hex: string; weight: number; textWeight: number; sites: ColourSite[]; alpha: string | 'mixed' }
/** Group sites by hex; heaviest first. */
export function slotsOf(sites: ColourSite[]): Slot[] {
  const m = new Map<string, Slot>()
  for (const s of sites) {
    const slot = m.get(s.hex) ?? { hex: s.hex, weight: 0, textWeight: 0, sites: [], alpha: 'ff' as const }
    slot.weight += s.weight; if (s.kind === 'text') slot.textWeight += s.weight; slot.sites.push(s); m.set(s.hex, slot)
  }
  for (const slot of m.values()) {
    const alphas = new Set(slot.sites.map(s => (s.alpha ?? 'ff').toLowerCase()))
    slot.alpha = alphas.size === 1 ? [...alphas][0]! : 'mixed'
  }
  return [...m.values()].sort((a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex))
}
export const groundOf = (slots: Slot[]): Slot | undefined => slots[0]
export function inkOf(slots: Slot[]): Slot | undefined {
  const texts = slots.filter(s => s.textWeight > 0).sort((a, b) => b.textWeight - a.textWeight)
  return texts[0] ?? slots[1]
}
