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
}

export type FrameFontOrigin = 'uploaded' | 'google' | 'library' | 'variable'

export interface FrameFontAsset {
  family: string
  weight: FontWeightSpec
  dataUrl: string
  origin: FrameFontOrigin
}

export type WiredEntry = { kind: 'still'; dataUrl: string }

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
}

export function assetKey(kind: FrameAssetKind, key: string): string {
  return `${kind}|${key}`
}
