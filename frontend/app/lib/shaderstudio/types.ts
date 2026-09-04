// frontend/app/lib/shaderstudio/types.ts
// Config for the Shader Studio node — a frontend-only, input-driven studio that
// stacks shader passes over an input image. Persisted at
// node.data.properties.sailor_shaderStudio.

import type { EffectDef, ParamValue } from '~/lib/shaderfx/types'
import { resolveValues } from '~/lib/shaderfx/params'
import type { BlendKind } from '~/lib/studio/blend'

export type EasingKind = 'linear' | 'pingpong' | 'easeinout'

/** Spatial mask shape confining an effect to a region. */
export type MaskShape = 'radius' | 'band' | 'linear'

/**
 * Per-effect spatial mask. When enabled, the effect is mixed with its own input
 * by a region factor so it applies only inside (or, inverted, outside) the shape.
 * Absent/`enabled:false` ⇒ the effect runs full-frame with no extra render pass.
 * All numeric fields are motion-bindable via dotted paths (e.g. effects.0.mask.size).
 */
export interface EffectMask {
  enabled: boolean
  shape: MaskShape
  cx: number       // center x, 0..1 (normalized image space)
  cy: number       // center y, 0..1
  size: number     // 0..1: radius | band half-width | linear half-extent
  aspect: number   // ellipse x/y ratio; 1 = circle. band/linear ignore.
  angle: number    // radians; rotates band/linear (and ellipse) orientation
  feather: number  // 0..1 edge softness (fraction of size)
  invert: boolean  // effect OUTSIDE the region instead of inside
}

/** A centered circle at half size — the resting state when a mask is first enabled. */
export function defaultMask(): EffectMask {
  return { enabled: false, shape: 'radius', cx: 0.5, cy: 0.5, size: 0.4, aspect: 1, angle: 0, feather: 0.3, invert: false }
}

/**
 * Give every effect layer a mask object at its resting state (`enabled:false`),
 * leaving any existing one untouched. The lib-side twin of the surface's own
 * lazy `ensureMask()` — it exists for the AGENT paths, which write config leaves
 * through a dotted-path proxy that CREATES missing intermediates: without a real
 * `mask` to land on, a patch of `effects.0.mask.enabled` would grow a half-built
 * `{enabled:true}` with no shape/cx/cy/size, i.e. a mask the renderer reads as
 * garbage. Callers that intend to OFFER the mask vocabulary must call this first
 * (see `shaderAgentControls`, which offers mask keys only where a mask exists).
 * Resting masks are inert at render — passes.ts gates purely on `mask?.enabled`.
 */
export function ensureEffectMasks(cfg: ShaderStudioConfig): ShaderStudioConfig {
  for (const e of cfg.effects ?? []) if (!e.mask) e.mask = defaultMask()
  return cfg
}

/**
 * The fields an effect SWITCH resets. Everything else on the layer survives,
 * because motion tracks address a layer by array index and the stack row is the
 * same row. Exported so the equivalence pin (tests/unit/shader-agent-vocab)
 * can compare this set against the TWIN implementation in
 * ShaderStudioSurface.vue's `pickEffect`, which resets exactly these three by
 * hand. Adding a field to StudioEffect that a switch must clear means adding it
 * here AND there — the pin fails until both agree.
 *
 * Scope of the pin: the reset FIELD SET, and nothing else. The twins already
 * differ in behaviour — `switchStudioEffect` no-ops on a same-id switch and
 * `pickEffect` does not (see below) — and the pin passing says nothing about
 * that.
 */
export const EFFECT_SWITCH_RESET_FIELDS = ['id', 'params', 'customChars'] as const

/**
 * Swap the effect in slot `index`, seeding the new effect's DEFAULT params.
 *
 * The shared form of ShaderStudioSurface's `pickEffect` (its TWIN — see
 * EFFECT_SWITCH_RESET_FIELDS): same preservation contract (layerId / blend /
 * opacity / enabled / mask survive), same reset of `id` / `params` /
 * `customChars`.
 *
 * The one difference is deliberate: `pickEffect` leaves `params` EMPTY and lets
 * `resolveValues(def, {})` fill the defaults at render/inspect time, which is
 * invisible to anything reading the config. The agent needs them written down —
 * a tune patch that switches effect and then overrides two uniforms has to land
 * those overrides on a complete bag, and the proposal rows have to show a real
 * "before". So the seeding runs through that SAME `resolveValues(def, {})`,
 * making the stored bag byte-identical to what the surface would have rendered.
 *
 * SAME-ID IS A NO-OP, deliberately. A switch to the effect that is already
 * selected is not a switch, and resetting on it destroys work: the agent's macro
 * makes a redundant `{"effect": "<current id>"}` the COMMON case (the guidance's
 * worked examples all carry the key), and the swap row would be filtered as a
 * no-op — so the user's hand-tuned uniforms would vanish with nothing in the
 * proposal to show it happened.
 *
 * THE GUARD COVERS THE AGENT MACRO PATH ONLY. `pickEffect` is a parallel TWIN,
 * not a caller of this function, so it does not inherit the guard: re-picking
 * the already-active effect in the picker still resets that layer's params.
 * That is an OPEN ITEM, left alone here because the .vue had foreign WIP.
 * EFFECT_SWITCH_RESET_FIELDS pins the reset FIELD SET across the two — it says
 * nothing about this behavioural difference, so the pin passing is not evidence
 * the twins behave alike on a same-id switch.
 */
export function switchStudioEffect(cfg: ShaderStudioConfig, index: number, def: EffectDef): ShaderStudioConfig {
  const prev = cfg.effects[index]
  if (!prev || prev.id === def.id) return cfg
  cfg.effects[index] = { ...prev, id: def.id, params: resolveValues(def, {}), customChars: '' }
  return cfg
}

/** Max number of effect layers stackable in effects[]. */
export const LAYER_MAX = 6

let _lid = 0
/** Deterministic-safe stable layer id (module counter + timestamp; no Math.random). */
export function newLayerId(): string { return `L${(_lid++).toString(36)}${Date.now().toString(36)}` }

export interface StudioSource {
  kind: 'none' | 'upload' | 'asset'
  /** data: URL for an uploaded image. */
  dataUrl?: string
  /** Asset filename (served via /view) when picked from project Assets. */
  asset?: string
}

export interface StudioEffect {
  /** shaderfx catalog effect id, or '' for none. */
  id: string
  /** non-default uniform overrides for the effect. */
  /** Values, not uniforms: numbers for float/enum, hex for `color`, stops for
   *  `gradient`. `resolveUniforms` expands these for GL at render time. */
  params: Record<string, ParamValue>
  enabled: boolean
  /** ASCII effect, "Custom" shape: characters the user rasterizes into glyphs. */
  customChars?: string
  /** how this layer composites over layers beneath it. */
  blend: BlendKind
  /** [0,1] layer opacity. */
  opacity: number
  /** stable per-layer id (identity for reorder + motion binding); distinct from the catalog `id`. */
  layerId: string
  /** optional spatial mask confining this effect to a region (undefined ⇒ full-frame). */
  mask?: EffectMask
}

export interface StudioDuotone {
  enabled: boolean
  ink: string   // dark color (hex)
  paper: string // light color (hex)
}

/** One color stop on the gradient-map ramp (pos 0..1 = luminance). */
export interface StudioGradientStop { pos: number; color: string }

export interface StudioGradientMap {
  enabled: boolean
  /** Ramp stops (sorted by pos at compose time); max 8 used. */
  stops: StudioGradientStop[]
  mix: number // [0,1] blend of the mapped result over the source
}

export interface StudioAdjust {
  enabled: boolean
  exposure: number     // [-2,2] stops
  brightness: number   // [-1,1]
  contrast: number     // [-1,1]
  saturation: number   // [-1,1]
  hue: number          // [-180,180] degrees
  temperature: number  // [-1,1]
  tint: number         // [-1,1]
}

export interface StudioBlur {
  enabled: boolean
  focusX: number   // [0,1]
  focusY: number   // [0,1]
  range: number    // [0,1] sharp radius (uv distance)
  aperture: number // [0,1] falloff softness
  maxBlur: number  // px at full blur
}

export interface StudioChromatic {
  enabled: boolean
  amount: number // [0,1]
}

export interface StudioBloom {
  enabled: boolean
  threshold: number // [0,1] brightness cutoff that glows
  intensity: number // [0,3] glow strength added back
  radius: number    // px spread of the glow
}

export interface StudioPost {
  blur: StudioBlur
  chromatic: StudioChromatic
  bloom: StudioBloom
}

export interface MotionTrack {
  /** dotted config path to a numeric leaf, e.g. 'adjust.exposure', 'effects.0.params.u_size'. */
  path: string
  from: number
  to: number
  easing: EasingKind
  loops: number
  delay: number
  hold: number
  cycleOffset: number
}

export interface StudioMotion {
  duration: number // seconds
  fps: number
  tracks: MotionTrack[]
}

export interface ShaderStudioConfig {
  version: number
  source: StudioSource
  /** long-edge cap (px) for preview/export sizing. */
  resolution: number
  /** varies the generative field / tears / grain; 42 is the historical default so old docs are unchanged. */
  seed: number
  /** stacked effect layers (max LAYER_MAX). */
  effects: StudioEffect[]
  duotone: StudioDuotone
  gradientMap: StudioGradientMap
  adjust: StudioAdjust
  post: StudioPost
  motion: StudioMotion
}

export function defaultConfig(): ShaderStudioConfig {
  return {
    version: 5,
    source: { kind: 'none' },
    resolution: 1536,
    seed: 42,
    effects: [{ layerId: newLayerId(), id: '', params: {}, enabled: true, customChars: '', blend: 'normal', opacity: 1 }],
    duotone: { enabled: false, ink: '#1a1a2e', paper: '#f5f5f5' },
    gradientMap: {
      enabled: false, mix: 1,
      stops: [
        { pos: 0, color: '#06283d' },
        { pos: 0.5, color: '#256d85' },
        { pos: 1, color: '#47b5ff' },
      ],
    },
    adjust: {
      enabled: false, exposure: 0, brightness: 0, contrast: 0,
      saturation: 0, hue: 0, temperature: 0, tint: 0,
    },
    post: {
      blur: { enabled: false, focusX: 0.5, focusY: 0.5, range: 0.2, aperture: 0.25, maxBlur: 8 },
      chromatic: { enabled: false, amount: 0.3 },
      bloom: { enabled: false, threshold: 0.5, intensity: 1.5, radius: 64 },
    },
    motion: { duration: 4, fps: 30, tracks: [] },
  }
}

export function cloneConfig(c: ShaderStudioConfig): ShaderStudioConfig {
  return JSON.parse(JSON.stringify(c))
}

/** Recursively fill any keys missing from a (possibly older) saved config. */
function deepMerge<T>(base: T, over: any): T {
  if (over == null || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T
  const out: any = { ...(base as any) }
  for (const k of Object.keys(over)) out[k] = deepMerge((base as any)?.[k], over[k])
  return out
}

/** Merge a saved config over current defaults so new fields (e.g. post.bloom) exist. */
export function hydrateConfig(raw: any): ShaderStudioConfig {
  return deepMerge(defaultConfig(), raw)
}

/** Fit (w,h) inside a long-edge cap, preserving aspect, returning even integers. */
export function outputDims(
  srcW: number,
  srcH: number,
  cap: number,
  opts: { upscale?: boolean } = {},
): { w: number; h: number } {
  const long = Math.max(srcW, srcH)
  // Default: `cap` is a downscale ceiling (used by the preview). With upscale,
  // it's a true target long edge — scale smaller sources up to match it.
  const scale = opts.upscale || long > cap ? cap / long : 1
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  return { w: even(srcW * scale), h: even(srcH * scale) }
}
