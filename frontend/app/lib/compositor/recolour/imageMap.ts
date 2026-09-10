import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { GradientMapStop } from '~/lib/compositor/postEffects'
import { createEffect, effectStackOf } from '~/lib/compositor/effectStack'
import type { EffectInstance } from '~/lib/compositor/effectStack'
import { lightnessOf } from './map'

/** layerId → the id of the gradient-map effect the recolour owns on that layer. */
export type OwnedMaps = Record<string, string>

const isTarget = (l: any) => l?.kind === 'image' || l?.kind === 'wired'

/** The family as a tonal map: distinct colours dark → light at even positions. */
export function gradientMapStopsFor(familyHexes: string[]): GradientMapStop[] {
  const fam = [...new Set(familyHexes.map(h => h.toLowerCase()))].sort((a, b) => lightnessOf(a) - lightnessOf(b))
  if (fam.length === 1) return [{ pos: 0.5, color: fam[0]! }]
  return fam.map((color, i) => ({ pos: i / (fam.length - 1), color }))
}

/** Add or refresh a recolour-owned gradient map on every image / wired layer. Pure. */
export function applyImageMaps(layers: LocalLayer[], familyHexes: string[], owned: OwnedMaps): { layers: LocalLayer[]; owned: OwnedMaps } {
  const stops = gradientMapStopsFor(familyHexes)
  const nextOwned: OwnedMaps = {}
  const next: LocalLayer[] = JSON.parse(JSON.stringify(layers))
  for (const l of next as any[]) {
    if (!isTarget(l)) continue
    const stack = effectStackOf(l)
    const ownedId = owned[l.id]
    const idx = ownedId ? stack.findIndex(e => e.id === ownedId && e.type === 'gradientMap') : -1
    if (idx >= 0) {
      stack[idx] = { ...(stack[idx] as any), stops: stops.map(s => ({ ...s })) } as EffectInstance
      nextOwned[l.id] = ownedId!
    } else {
      const fx = { ...(createEffect('gradientMap') as any), stops: stops.map(s => ({ ...s })), mix: 1, visible: true } as EffectInstance
      stack.push(fx)
      nextOwned[l.id] = fx.id
    }
    l.effects = stack
  }
  return { layers: next, owned: nextOwned }
}

/** Strip the recolour-owned maps; user-added effects stay. Pure. */
export function removeImageMaps(layers: LocalLayer[], owned: OwnedMaps): { layers: LocalLayer[]; owned: OwnedMaps } {
  const next: LocalLayer[] = JSON.parse(JSON.stringify(layers))
  for (const l of next as any[]) {
    const ownedId = owned[l.id]
    if (!ownedId) continue
    const stack = effectStackOf(l).filter(e => e.id !== ownedId)
    l.effects = stack
  }
  return { layers: next, owned: {} }
}
