import type { Slot } from './slots'
import { groundOf, inkOf } from './slots'
import { hexToOklch } from '~/lib/color/convert'
import { contrastRatio, autoInk } from '~/lib/frame/patterns/palette'

export const lightnessOf = (hex: string): number => hexToOklch(hex)[0]

/** Family → slots by lightness order (spec: "Mapping a family onto the slots"). */
export function mapFamily(slots: Slot[], familyHexes: string[]): Record<string, string> {
  const fam = [...new Set(familyHexes.map(h => h.toLowerCase()))].sort((a, b) => lightnessOf(a) - lightnessOf(b))
  const out: Record<string, string> = {}
  if (!slots.length || !fam.length) return out
  const bySlotL = [...slots].sort((a, b) => lightnessOf(a.hex) - lightnessOf(b.hex))
  const M = bySlotL.length, N = fam.length
  if (M <= N) {
    // even quantiles of the family's lightness order, always including its extremes
    bySlotL.forEach((s, i) => { const idx = M === 1 ? N - 1 : Math.round(i * (N - 1) / (M - 1)); out[s.hex] = fam[idx]! })
  } else {
    bySlotL.forEach((s, i) => { const idx = Math.round(i * (N - 1) / (M - 1)); out[s.hex] = fam[idx]! })
  }
  // contrast guard: ground vs ink
  const g = groundOf(slots), k = inkOf(slots)
  if (g && k && g.hex !== k.hex) {
    const gh = out[g.hex]!, kh = out[k.hex]!
    if (contrastRatio(gh, kh) < 4.5) out[k.hex] = autoInk(gh, fam).ink
  }
  return out
}
