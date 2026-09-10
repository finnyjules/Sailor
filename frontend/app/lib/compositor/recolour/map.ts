import type { Slot } from './slots'
import { groundOf } from './slots'
import { hexToOklch } from '~/lib/color/convert'
import { contrastRatio } from '~/lib/frame/patterns/palette'

export const lightnessOf = (hex: string): number => hexToOklch(hex)[0]

/** Family → slots by lightness order (spec: "Mapping a family onto the slots"). */
export function mapFamily(slots: Slot[], familyHexes: string[]): Record<string, string> {
  const fam = [...new Set(familyHexes.map(h => h.toLowerCase()))].sort((a, b) => lightnessOf(a) - lightnessOf(b))
  const out: Record<string, string> = {}
  if (!slots.length || !fam.length) return out
  const bySlotL = [...slots].sort((a, b) => lightnessOf(a.hex) - lightnessOf(b.hex))
  const M = bySlotL.length, N = fam.length
  if (M === 1) {
    // A single slot has no quantile position to preserve — pick the family colour whose
    // own lightness is nearest to the slot's, not the family's extreme.
    const l = lightnessOf(bySlotL[0]!.hex)
    out[bySlotL[0]!.hex] = fam.reduce((b, c) => Math.abs(lightnessOf(c) - l) < Math.abs(lightnessOf(b) - l) ? c : b, fam[0]!)
  } else if (M <= N) {
    // even quantiles of the family's lightness order, always including its extremes
    bySlotL.forEach((s, i) => { const idx = Math.round(i * (N - 1) / (M - 1)); out[s.hex] = fam[idx]! })
  } else {
    bySlotL.forEach((s, i) => { const idx = Math.round(i * (N - 1) / (M - 1)); out[s.hex] = fam[idx]! })
  }
  // Contrast guard: only meaningful when the frame actually has text — a purely graphic
  // frame has no reading-contrast requirement, and must keep its plain lightness order.
  // The heaviest TEXT slot (not `inkOf`'s non-text fallback) is the ink the guard protects.
  const texts = slots.filter(s => s.textWeight > 0).sort((a, b) => b.textWeight - a.textWeight)
  const g = groundOf(slots), k = texts[0]
  if (g && k && g.hex !== k.hex) {
    const gh = out[g.hex]!, kh = out[k.hex]!
    if (contrastRatio(gh, kh) < 4.5) {
      // Re-pick from the family itself — never reach outside it (autoInk's white/black/
      // paper pool would jump the ink off-family) — the family colour of highest contrast
      // against the mapped ground.
      out[k.hex] = fam.reduce((b, c) => contrastRatio(gh, c) > contrastRatio(gh, b) ? c : b, fam[0]!)
    }
  }
  return out
}
