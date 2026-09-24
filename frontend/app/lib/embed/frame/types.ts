/**
 * The shape of a Frame web export: plain JSON, written once at export time.
 *
 * `variants` is a list — not a single snapshot — so art-directed variants or responsive layout
 * can arrive later without a format change. `FrameFit` is a union rather than a boolean so a
 * third mode (`'adapt'`, owned by the responsive-Frames work) can join it without breaking the
 * format.
 */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { Paint } from '~/lib/compositor/paint'
import type { PostEffect } from '~/lib/compositor/postEffects'
import type { FrameMotion } from '~/lib/motion/types'
import type { WiredTreatment } from '~/composables/useWiredTreatments'
import type { EffectDef } from '~/lib/shaderfx/types'
import type { DepthRef } from '~/lib/compositor/depthRegistry'
import type { FrameAssetKind } from '~/lib/compositor/assetScope'
import type { FontWeightSpec } from '../fontFace'
import type { FrameLight } from '~/lib/compositor/frameLight'

export type FrameFit = 'fit' | 'fill'

export interface FrameVariant {
  width: number
  height: number
  layers: LocalLayer[]
  stackOrder: string[]
  groups: LayerGroup[]
  background: Paint | null
  post: PostEffect[]
  motion: FrameMotion | null
  wiredTreatments: Record<string, WiredTreatment>
  /** The Frame's light for Gold foil / Spot UV. Absent in older snapshots ⇒ the default light. */
  light?: FrameLight
}

export type FrameFontOrigin = 'uploaded' | 'google' | 'library' | 'variable'

export interface FrameFontAsset {
  family: string
  weight: FontWeightSpec
  dataUrl: string
  origin: FrameFontOrigin
}

/** A wired slot's pictures. `still`: one picture for every moment. `clip`: an animated studio's
 *  loop pre-rendered at export — `frames[i]` is the source at `i / frames.length` of its own
 *  `duration` (seconds); the adapter wraps the Frame's time on that duration, as the editor's
 *  `slotPhase01` does. `live`: the studio's own embed player plays it — `surface` is its embed
 *  kind, `bundle` the built file carrying it (`bundleNameFor(surface, config)`, checked again at
 *  export), `config` what that player mounts, `width`/`height` the source's size (its aspect) and
 *  `duration` its loop in seconds, wrapped on the Frame's time as clips are. */
export type WiredEntry =
  | { kind: 'still'; dataUrl: string }
  | { kind: 'clip'; frames: string[]; fps: number; duration: number }
  | { kind: 'live'; surface: string; bundle: string; config: unknown; width: number; height: number; duration: number }

export interface FrameAssets {
  urls: Record<string, string>                 // assetKey(kind, key) → data URL
  fonts: FrameFontAsset[]
  shaders: EffectDef[]
  depth: { ref: DepthRef; dataUrl: string }[]
}

export type FrameNoticeGroup = 'fonts' | 'live' | 'still' | 'leftOut' | 'blocked'

export interface FrameNotice {
  group: FrameNoticeGroup
  text: string
  layerId?: string
  bytes?: number
}

export interface FrameSnapshot {
  version: 1
  fit: FrameFit
  duration: number
  still: boolean
  variants: FrameVariant[]
  assets: FrameAssets
  wired: Record<number, WiredEntry>
  notices: FrameNotice[]
  /** Task 10: true when this Frame needs paper.js (F3's `boolean`/`shatter`/`morph` geometry
   *  effects) or fontkit glyph outlines (any font the gatherer marked `outline: true`) to draw
   *  correctly — set by `buildFrameSnapshot`. `bundleNameFor('frame', snap)` (surfaces.ts) reads
   *  it to pick between the full `frame.js` (ships paper.js + fontkit) and the smaller
   *  `frame-lean.js` (ships neither; every text layer draws with `fillText`, and a boolean/
   *  shatter/morph effect — none present when this is false — would throw). Most Frames have no
   *  outlined text and no F3 geometry effect, so most exports take the lean bundle. */
  needsOutlines: boolean
}

export function assetKey(kind: FrameAssetKind, key: string): string {
  return `${kind}|${key}`
}
