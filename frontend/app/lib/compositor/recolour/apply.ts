/**
 * Apply a slot→hex mapping through every colour site (apply.ts is the last stage of Frame
 * recolour: sites.ts reads, slots.ts/map.ts group and choose, this writes). Pure — walks
 * `colourSites` on deep clones and writes only sites whose `hex` appears in `mapping`, so
 * callers get new `layers`/`background` back with the originals untouched.
 */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { Paint } from '~/lib/compositor/paint'
import { colourSites } from './sites'

/** Write a slot→hex mapping through every colour site, onto clones. Pure. */
export function recolourFrame(layers: LocalLayer[], background: Paint | undefined, mapping: Record<string, string>, frameAspect: number): { layers: LocalLayer[]; background: Paint | undefined } {
  const nextLayers: LocalLayer[] = JSON.parse(JSON.stringify(layers))
  const bgRoot = { background: background == null ? undefined : JSON.parse(JSON.stringify(background)) as Paint }
  const byId = new Map(nextLayers.map(l => [l.id, l as any]))
  for (const site of colourSites(nextLayers, bgRoot.background, frameAspect)) {
    const to = mapping[site.hex]
    if (!to) continue
    if (site.owner === 'bg') site.set(bgRoot, to)
    else { const root = byId.get(site.owner); if (root) site.set(root, to) }
  }
  return { layers: nextLayers, background: bgRoot.background }
}

/** Rewrite one slot everywhere it appears; an `alpha` override is written onto every site's use
 *  (no override leaves each use's own captured alpha in place, matching `recolourFrame`). */
export function recolourSlot(layers: LocalLayer[], background: Paint | undefined, slotHex: string, toHex: string, frameAspect: number, alpha?: string) {
  const from = slotHex.toLowerCase(), to = toHex.toLowerCase()
  const nextLayers: LocalLayer[] = JSON.parse(JSON.stringify(layers))
  const bgRoot = { background: background == null ? undefined : JSON.parse(JSON.stringify(background)) as Paint }
  const byId = new Map(nextLayers.map(l => [l.id, l as any]))
  for (const site of colourSites(nextLayers, bgRoot.background, frameAspect)) {
    if (site.hex !== from) continue
    const root = site.owner === 'bg' ? bgRoot : byId.get(site.owner)
    if (root) site.set(root, to, alpha)
  }
  return { layers: nextLayers, background: bgRoot.background }
}
