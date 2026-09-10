import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { GradientMapStop } from '~/lib/compositor/postEffects'
import { createEffect, EFFECT_ORDER, effectStackOf, writeStackToLayer } from '~/lib/compositor/effectStack'
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
    let stack = effectStackOf(l)
    const ownedId = owned[l.id]
    const idx = ownedId ? stack.findIndex(e => e.id === ownedId && e.type === 'gradientMap') : -1
    if (idx >= 0) {
      stack[idx] = { ...(stack[idx] as any), stops: stops.map(s => ({ ...s })) } as EffectInstance
      nextOwned[l.id] = ownedId!
    } else {
      // Insert at the canonical pipeline position (after duotone, before bloom), not appended:
      // a pushed map would land AFTER any existing bloom / vignette / grain / torn_edge /
      // feather / layer_blur on this image and render in the wrong order forever, since a
      // new-shape (id-stamped) stack is never re-sorted.
      //
      // NOT `addEffect(stack, 'gradientMap')`: addEffect appends an orderable kind after the
      // LAST entry sharing its region (effectStack.ts:296-304, by design — see
      // compositor-effect-stack.unit.spec.ts:177-186), and gradientMap/bloom/vignette/grain/
      // torn_edge/feather/layer_blur are all the same 'pixel' region. So on a stack that
      // already has a bloom (regionOf('bloom') === regionOf('gradientMap')), addEffect would
      // insert the map AFTER the bloom — reproducing this exact bug. Sort by EFFECT_ORDER
      // directly instead: insert before the first entry that sorts later than 'gradientMap'.
      const fresh = { ...(createEffect('gradientMap') as any), stops: stops.map(s => ({ ...s })), mix: 1, visible: true } as EffectInstance
      const target = EFFECT_ORDER.indexOf('gradientMap')
      const at = stack.findIndex(e => EFFECT_ORDER.indexOf(e.type) > target)
      stack = at === -1 ? [...stack, fresh] : [...stack.slice(0, at), fresh, ...stack.slice(at)]
      nextOwned[l.id] = fresh.id
    }
    Object.assign(l, writeStackToLayer(stack))
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
    Object.assign(l, writeStackToLayer(stack))
  }
  return { layers: next, owned: {} }
}
