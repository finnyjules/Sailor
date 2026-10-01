/**
 * Frame light layers, stage 2: Relight's lights become Frame lights. Pure — no painter, no Vue.
 *
 * - `relightLightsToLayers` converts an old Frame (Relight effects that still carry their own
 *   lights, in fractions of the photo's box) into light layers mapped through each photo's
 *   transform. The painter applies it read-only to an unopened old Frame; the editor persists
 *   it once on open (`convertLegacyRelight`).
 * - `setupToLightLayers` turns a Relight Setup (box-fraction specs, lib/relight/presets) into
 *   the Frame's light layers around one photo.
 * Spec: docs/superpowers/specs/2026-10-01-frame-light-layers-design.md (stage 2).
 */
import type { LocalLayer, LightLayer } from '~/composables/useCompositorLayers'
import { effectStackOf, writeStackToLayer, type EffectInstance } from '~/lib/compositor/effectStack'
import { readLegacyRelightLights } from '~/lib/relight/settings'
import { relightSetup, type RelightSetupName } from '~/lib/relight/presets'
import { MAX_LIGHTS, DEFAULT_LIGHTING, LIGHT_DEFAULTS, newLightLayer, sanitizeLightLayer, sanitizeLighting, type FrameLighting } from './settings'

// ── The photo's box ──────────────────────────────────────────────────────────

/** A layer that carries a Relight effect (only image and wired layers can: they have a depth source). */
export function isRelightPhoto(layer: LocalLayer): boolean {
  return (layer.kind === 'image' || layer.kind === 'wired') && relightEntry(layer) !== undefined
}

function relightEntry(layer: LocalLayer): EffectInstance | undefined {
  return effectStackOf(layer as { effects?: unknown[] }).find(e => e.type === 'relight')
}

/** The photo's box size in Frame WIDTHS (image `w`/`h`; a wired layer's height follows its
 *  content aspect unless a crop pinned `h` — as `wiredBoxPx` in the painter). */
export function relightPhotoBox(layer: LocalLayer): { w: number; h: number } {
  const l = layer as { kind: string; w?: number; h?: number; lastAspect?: number; crop?: unknown }
  const w = typeof l.w === 'number' ? l.w : 0
  if (l.kind === 'wired') {
    if (l.crop && typeof l.h === 'number' && l.h > 0) return { w, h: l.h }
    return { w, h: w * (l.lastAspect || 1) }
  }
  return { w, h: typeof l.h === 'number' ? l.h : 0 }
}

/** A fraction of the photo's box (0,0 = its top left before rotation) → a Frame fraction,
 *  through the layer's centre, size and rotation. Same geometry as the editor's handles. */
export function relightBoxToFrame(layer: LocalLayer, fx: number, fy: number, W: number, H: number): { x: number; y: number } {
  const box = relightPhotoBox(layer)
  const dx = (fx - 0.5) * box.w * W, dy = (fy - 0.5) * box.h * W
  const rad = ((layer.rotation || 0) * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad)
  return { x: layer.x + (dx * c - dy * s) / W, y: layer.y + (dx * s + dy * c) / H }
}

/** The inverse: a Frame fraction → a fraction of the photo's box. */
export function frameToRelightBox(layer: LocalLayer, x: number, y: number, W: number, H: number): { x: number; y: number } {
  const box = relightPhotoBox(layer)
  const mx = (x - layer.x) * W, my = (y - layer.y) * H
  const rad = ((layer.rotation || 0) * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad)
  const lx = mx * c + my * s, ly = -mx * s + my * c
  const bw = box.w * W, bh = box.h * W
  return { x: bw ? lx / bw + 0.5 : 0.5, y: bh ? ly / bh + 0.5 : 0.5 }
}

// ── One light ────────────────────────────────────────────────────────────────

interface BoxLightSpec { x: number; y: number; height: number; color: string; brightness: number; reach: number }

/** A box-fraction light → a lamp layer. Height is clamped to 0..1 (a "behind" rim light → 0).
 *  Colour and brightness carry over; reach was in photo-box heights and becomes Frame widths
 *  (× the box height in Frame widths), so the light falls off over the same part of the photo.
 *  The light layer's own ranges then clamp them (brightness ≤ 3, reach 0.2..2). */
function lampFrom(spec: BoxLightSpec, photo: LocalLayer, W: number, H: number, id: string, visible = true): LightLayer {
  const at = relightBoxToFrame(photo, spec.x, spec.y, W, H)
  const layer = sanitizeLightLayer({
    id, kind: 'light', x: at.x, y: at.y,
    light: { ...LIGHT_DEFAULTS.lamp, height: Math.min(1, Math.max(0, spec.height)), color: spec.color, brightness: spec.brightness, reach: spec.reach * relightPhotoBox(photo).h },
  })
  if (!visible) layer.visible = false
  return layer
}

// ── Old Frames ───────────────────────────────────────────────────────────────

/** True when any image/wired layer's Relight effect still carries its own lights. */
export function hasLegacyRelightLights(layers: readonly LocalLayer[]): boolean {
  return layers.some(l => (l.kind === 'image' || l.kind === 'wired') && readLegacyRelightLights(rawRelight(l)).length > 0)
}

/** The stored (unsanitized) Relight entry — `effectStackOf` keeps extra fields such as `lights`. */
function rawRelight(layer: LocalLayer): unknown {
  return relightEntry(layer)
}

export interface RelightConversion {
  layers: LocalLayer[]
  lighting: FrameLighting
  /** Old lights left out because the Frame holds at most MAX_LIGHTS. */
  dropped: number
  /** false ⇒ `layers` is the input array itself (nothing to convert). */
  changed: boolean
}

/**
 * Old Relight lights → Frame light layers. Pure; the input is never mutated.
 *
 * Unchanged (same `layers` array, `changed: false`) when the Frame already has a light layer or
 * no Relight effect carries lights. Otherwise: every old light becomes a lamp mapped from its
 * photo's box to the Frame (stack order, at most MAX_LIGHTS — the rest are counted in
 * `dropped`; an off light becomes a hidden light; an effect or photo that is hidden gives hidden
 * lights), appended at the top of the stack; the Relight effects lose their `lights`; every
 * non-photo layer gets `lit: false` and `castsShadow: false` so the layout looks as before;
 * Darkness is 0.45 unless the Frame already has a lighting record (`lighting`).
 *
 * Light ids are derived from the photo and the old light, so a read-only conversion (the
 * painter's) produces the same lights on every paint.
 */
export function relightLightsToLayers(
  layers: readonly LocalLayer[],
  lighting: FrameLighting | null | undefined,
  W: number,
  H: number,
): RelightConversion {
  const record = lighting ? sanitizeLighting(lighting) : null
  const unchanged = (): RelightConversion => ({ layers: layers as LocalLayer[], lighting: record ?? { ...DEFAULT_LIGHTING }, dropped: 0, changed: false })
  if (layers.some(l => l.kind === 'light') || !hasLegacyRelightLights(layers)) return unchanged()

  const lights: LightLayer[] = []
  let dropped = 0
  const out: LocalLayer[] = layers.map((l) => {
    if (l.kind === 'light') return l
    if (!isRelightPhoto(l)) return { ...l, lit: false, castsShadow: false } as LocalLayer
    const stack = effectStackOf(l as { effects?: unknown[] })
    const entry = stack.find(e => e.type === 'relight')!
    const old = readLegacyRelightLights(entry)
    const shown = l.visible !== false && entry.visible !== false
    for (const o of old) {
      if (lights.length >= MAX_LIGHTS) { dropped++; continue }
      lights.push(lampFrom(o, l, W, H, `ll-rl-${l.id}-${o.id}`, shown && o.on))
    }
    if (!('lights' in (entry as object))) return l
    const { lights: _gone, ...kept } = entry as EffectInstance & { lights?: unknown }
    return { ...l, ...writeStackToLayer(stack.map(e => (e === entry ? kept as EffectInstance : e))) } as LocalLayer
  })
  return {
    layers: [...out, ...lights],
    lighting: record ?? { ...DEFAULT_LIGHTING, darkness: 0.45 },
    dropped,
    changed: true,
  }
}

// ── Setups ───────────────────────────────────────────────────────────────────

/** A Relight Setup as the Frame's light layers around `photo` (fresh ids, lamps, in the
 *  setup's order). The setup's Original light (`keep`) is the caller's to apply. */
export function setupToLightLayers(setup: RelightSetupName, photo: LocalLayer, W: number, H: number): LightLayer[] {
  return relightSetup(setup).lights.map(spec => lampFrom(spec, photo, W, H, newLightLayer('lamp').id))
}
