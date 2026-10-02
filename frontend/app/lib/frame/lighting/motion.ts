/**
 * Frame light layers, stage 4: light dials, a layer's Lift and the Frame's Darkness on the
 * Motion timeline. Pure and self-contained (settings.ts + the motionx core only) — the motion
 * fold calls `applyLightValue`, the painter calls `applyLightingTracks` once per frame.
 * No light band, no Lift band, no Darkness band ⇒ the same refs back: byte-identical.
 */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { evaluateTracks, type PropertyValue, type Track } from '~/lib/motionx'
import { HEX, effectiveLift, sanitizeLightLayer, type FrameLighting, type LightLayer, DEFAULT_LIGHTING } from './settings'

/** The light dials a band can drive (`layers.<id>.light.<key>`). Type and Edge are not animated. */
export const LIGHT_MOTION_KEYS = ['height', 'color', 'brightness', 'reach', 'aimX', 'aimY', 'cone'] as const
export type LightMotionKey = typeof LIGHT_MOTION_KEYS[number]
const KEYS: ReadonlySet<string> = new Set(LIGHT_MOTION_KEYS)

/** The Frame's Darkness band path. */
export const DARKNESS_PATH = 'frame.darkness'

/** A band this file evaluates: a light dial, a layer's Lift, or the Frame's Darkness. */
export const isLightBandPath = (path: string): boolean =>
  /^layers\.[^.]+\.(light\.[a-zA-Z]+|lift)$|^frame\.darkness$/.test(path)

/** `light.<key>` on a light layer (clamped by the light sanitizer; colour only as `#rrggbb`), or
 *  `lift` on any other layer (clamped 0.005..0.15). Anything else ⇒ the same ref. */
export function applyLightValue(layer: LocalLayer, prop: string, value: PropertyValue): LocalLayer {
  if (prop === 'lift') {
    if (layer.kind === 'light' || typeof value !== 'number' || !Number.isFinite(value)) return layer
    return { ...layer, lift: effectiveLift({ kind: layer.kind, lift: value }) } as LocalLayer
  }
  if (!prop.startsWith('light.') || layer.kind !== 'light') return layer
  const key = prop.slice(6)
  if (!KEYS.has(key)) return layer
  if (key === 'color' ? !(typeof value === 'string' && HEX.test(value)) : !(typeof value === 'number' && Number.isFinite(value))) return layer
  const l = layer as unknown as LightLayer
  // The sanitizer clamps the one changed field exactly as a stored light is clamped.
  const light = sanitizeLightLayer({ ...l, light: { ...l.light, [key]: value } }).light
  return { ...layer, light } as unknown as LocalLayer
}

/** The Frame's lighting at `t`: an unmuted `frame.darkness` band sets Darkness (clamped 0..1).
 *  No band resolving (or the same value) ⇒ the same `lighting` ref; no record ⇒ the defaults. */
export function applyLightingTracks(
  lighting: FrameLighting | undefined, tracks: Track[] | undefined, t: number | undefined,
): FrameLighting | undefined {
  if (!tracks || tracks.length === 0 || t == null) return lighting
  const live = tracks.filter(tr => tr.path === DARKNESS_PATH && !tr.muted)
  if (live.length === 0) return lighting
  const v = evaluateTracks(live, t).get(DARKNESS_PATH)
  if (typeof v !== 'number' || !Number.isFinite(v)) return lighting
  const darkness = Math.min(1, Math.max(0, v))
  const base = lighting ?? DEFAULT_LIGHTING
  return darkness === base.darkness && lighting ? lighting : { ...base, darkness }
}
