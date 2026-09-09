import type { ColorRole } from './types'

export interface ResolvedPalette { field: string; ink: string; accent: string }

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const s = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}
function relLum(hex: string): number {
  const [r, g, b] = toRgb(hex).map(v => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** WCAG contrast ratio (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relLum(a), lb = relLum(b)
  const hi = Math.max(la, lb), lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}
/** Best-contrast ink on `field` from candidates + black/white/paper fallbacks (guarantees a legible pick). */
export function autoInk(field: string, candidates: string[]): { ink: string; ratio: number } {
  const pool = [...candidates, '#ffffff', '#0e0e0e', '#f2f0ef']
  let ink = pool[0]!, ratio = 0
  for (const c of pool) { const r = contrastRatio(field, c); if (r > ratio) { ratio = r; ink = c } }
  return { ink, ratio }
}
export function roleToPaint(role: ColorRole, p: ResolvedPalette): string { return p[role] }

/** Approx OKLCH-free chroma proxy: max-min channel spread (0..1). Good enough to
 *  rank "how colourful" for accent selection without pulling in the OKLCH lib. */
function chroma(hex: string): number {
  const [r, g, b] = toRgb(hex).map(v => v / 255) as [number, number, number]
  return Math.max(r, g, b) - Math.min(r, g, b)
}
/** Project a palette family to poster roles. field = the most ground-like member
 *  (lowest chroma; ties → most extreme lightness); ink = auto-contrast to field
 *  from the members + fallbacks; accent = the most colourful member distinct from
 *  field and ink. */
export function rolesFromFamily(family: { hexes: string[] }): ResolvedPalette {
  const hexes = family.hexes.length ? family.hexes : ['#f2f0ef', '#121212', '#dd2200']
  const field = [...hexes].sort((a, b) => {
    const dc = chroma(a) - chroma(b)
    if (Math.abs(dc) > 0.02) return dc            // lowest chroma first
    return Math.abs(relLum(a) - 0.5) < Math.abs(relLum(b) - 0.5) ? 1 : -1 // then most extreme lightness
  })[0]!
  const { ink } = autoInk(field, hexes)
  const accent = [...hexes]
    .filter(h => h !== field && h !== ink)
    .sort((a, b) => chroma(b) - chroma(a))[0] ?? hexes.find(h => h !== field && h !== ink) ?? '#dd2200'
  return { field, ink, accent }
}
