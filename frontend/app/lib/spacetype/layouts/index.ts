import type { ControlSpec, Params } from '../effect'
import type { TileTransform } from '../ringLayout'
import { ringLayout } from './ring'
import { sphereLayout } from './sphere'
import { tunnelLayout } from './tunnel'
import { gridLayout } from './grid'
import { globeLayout } from './globe'
import { spiralLayout } from './spiral'
import { orbitLayout } from './orbit'
import { coverflowLayout } from './coverflow'
import { filmstripLayout } from './filmstrip'
import { marqueeLayout } from './marquee'
import { totemLayout } from './totem'
import { stackLayout } from './stack'
import { wheelLayout } from './wheel'
import { fanLayout } from './fan'
import { isoLayout } from './iso'
import { cloudLayout } from './cloud'
import { domeLayout } from './dome'
import { bloomLayout } from './bloom'
import { coverringLayout } from './coverring'
import { focusLayout } from './focus'
import { feedLayout } from './feed'
import { cascadeLayout } from './cascade'
import { turntableLayout } from './turntable'
import { parallaxLayout } from './parallax'
import { haloLayout } from './halo'
import { vortexLayout } from './vortex'
import { stageLayout } from './stage'
import { deckLayout } from './deck'
import { slideLayout } from './slide'
import { focusshiftLayout } from './focusshift'
import { trailLayout } from './trail'
import { burstLayout } from './burst'
import { tossLayout } from './toss'
import { danceLayout } from './dance'
import { medleyLayout } from './medley'

export type LayoutFamily = typeof LAYOUT_FAMILIES[number]
/** Picker headings, in display order. */
export const LAYOUT_FAMILIES = ['Rings and globes', 'Carousels', 'Grids and walls', 'Orbits and wheels', 'Stacks and decks', 'Scatter', 'Multiscene'] as const

/** How the whole arrangement sits in front of the camera (radians, applied to the group
 *  in three's default 'XYZ' order). */
export interface ShowcasePose { rotX: number; rotY: number; rotZ: number }

export interface ShowcaseLayout {
  id: string; label: string; controls: ControlSpec[]
  /** Heading this layout sits under in the picker. */
  family: LayoutFamily
  /** `aspects` is every tile's width ÷ height, in tile order — only the row layouts read
   *  it (a strip of mixed-ratio photos must space by real widths). Absent → all square. */
  place(i: number, n: number, p: Params, t01: number, aspects?: readonly number[]): TileTransform
  loopRates?(p: Params): number[]
  /** Pose of the group. Absent → head-on. Nearly always fixed; `t01` is there for the one
   *  layout that morphs between arrangements and must carry the pose along. */
  pose?(p: Params, t01: number): ShowcasePose
  /** The radius cards curve around when Bend is up. Absent → this layout keeps cards flat
   *  (and the host hides the Bend dial). */
  bendRadius?(p: Params): number
  /** Defaults for params this layout reads but does not declare — a layout assembled from
   *  other layouts (Triple scene) reads THEIR dials. */
  paramDefaults?(): Params
  /** Half-depth of the arrangement, for the back fade. Absent → the host measures the
   *  cards' actual depth range each frame. */
  depth?(p: Params): number
}
// Picker order: grouped by family (LAYOUT_FAMILIES order), `ring` first — it is also the
// fallback for an unknown id.
export const SHOWCASE_LAYOUTS: ShowcaseLayout[] = [
  ringLayout, coverringLayout, sphereLayout, globeLayout, cloudLayout, domeLayout, spiralLayout, bloomLayout,
  coverflowLayout, focusLayout, filmstripLayout, totemLayout, feedLayout, cascadeLayout,
  gridLayout, marqueeLayout, isoLayout, turntableLayout, parallaxLayout,
  orbitLayout, haloLayout, wheelLayout, vortexLayout,
  stackLayout, tunnelLayout, deckLayout, slideLayout, fanLayout, stageLayout, focusshiftLayout,
  trailLayout, burstLayout, tossLayout, danceLayout,
  medleyLayout,
]
/** The effect id of a layout's gallery entry. `ring` keeps the id saved scenes already use;
 *  the rest take a `show` prefix, because several layout ids (tunnel, spiral, cascade,
 *  turntable) are also text effects. Ids must stay lowercase letters + digits (backend rule). */
export function showcaseEffectId(layoutId: string): string {
  return layoutId === 'ring' ? 'ring' : `show${layoutId}`
}

export function getLayout(id: string): ShowcaseLayout {
  const lc = String(id).toLowerCase()
  return SHOWCASE_LAYOUTS.find(l => l.id.toLowerCase() === lc) ?? SHOWCASE_LAYOUTS[0]!
}
