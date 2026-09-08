import { clampHex, isHex, stripAlpha } from '~/lib/color/convert'
import type { EffectDef, EffectParamDef, GradientStop, ParamValue, UniformValue } from './types'

/**
 * A colour a param will accept. Deliberately WIDER than `isHex`, which only takes
 * 3- and 6-digit forms: `StudioColor` — the picker these params render — emits
 * 8-digit `#rrggbbaa` as soon as the user touches its alpha slider, and the
 * opacity track sits right under the hue track. Rejecting those would fall back
 * to the param's default, so picking a colour would silently do nothing.
 * Alpha is dropped rather than honoured: these uniforms are `vec3`.
 */
export function isParamHex(s: string): boolean {
  return isHex(s) || /^#?([0-9a-fA-F]{4}|[0-9a-fA-F]{8})$/.test(String(s).trim())
}

export function parseParams(json: string): Record<string, ParamValue> {
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

/** '#rgb'/'#rrggbb'/'#rrggbbaa' → [r,g,b] in 0..1, alpha dropped.
 *  Mirrors parse_hex() in _shader_effects.py. */
export function hexVec3(hex: string): [number, number, number] {
  const x = clampHex(stripAlpha(hex)).slice(1)
  return [
    parseInt(x.slice(0, 2), 16) / 255,
    parseInt(x.slice(2, 4), 16) / 255,
    parseInt(x.slice(4, 6), 16) / 255,
  ]
}

/** Canonical text form of a ramp — what a `gradientStops` ControlSpec stores,
 *  since `ParamValue` is scalar (see `cleanStops` for why that's not a second
 *  representation). Always produced from an already-normalized list. */
export function serializeStops(stops: GradientStop[]): string {
  return JSON.stringify(stops.map(s => ({ pos: s.pos, color: s.color })))
}

/**
 * The ONE normalizer for a ramp. Both `resolveValues` (which feeds the renderer)
 * and `resolveEffectParams` (which feeds the descriptor cache key) go through
 * here, so the key and the pixels cannot disagree about which stops are live.
 *
 * ACCEPTS AN ARRAY **OR** ITS JSON TEXT. `ControlSpec`'s value type (`ParamValue`
 * = number | string | boolean, shared/spacetype/state.ts) cannot hold a list, so
 * every structured control kind in this codebase — `fillList`, `path`, `curve` —
 * stores JSON text; a `gradientStops` control therefore writes a string while the
 * studio's own picker writes an array. That is not two representations: there is
 * exactly one canonical form, the normalized array this returns, and this is the
 * only place either input shape is interpreted. The alternative — teaching each
 * reader which form to expect — is how the two would drift.
 *
 * SORT THEN SLICE, and `toUniforms` below must do the same. Slicing first takes
 * the first N in author order, which for the same ramp given in a different order
 * is a DIFFERENT subset, so the key and the render would pick different stops.
 */
export function cleanStops(raw: unknown, maxStops: number, fallback: GradientStop[]): GradientStop[] {
  let list = raw
  if (typeof list === 'string') {
    try { list = JSON.parse(list) } catch { return fallback }
  }
  if (!Array.isArray(list) || list.length < 2) return fallback
  const out: GradientStop[] = []
  for (const s of list) {
    if (!s || typeof s !== 'object') return fallback
    const { pos, color } = s as GradientStop
    if (typeof color !== 'string' || !isParamHex(color) || !Number.isFinite(pos)) return fallback
    out.push({ pos: Math.min(Math.max(pos, 0), 1), color })
  }
  return out.sort((a, b) => a.pos - b.pos).slice(0, maxStops)
}

/**
 * Defaults merged with overrides; clamped; unknown keys dropped. Mirrors Python
 * resolve_params. Returns the *values* (hex for colour, stops for gradient) —
 * `toUniforms` turns those into what GL uploads.
 */
export function resolveValues(eff: EffectDef, overrides: Record<string, ParamValue>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  for (const p of eff.params) {
    const raw = overrides[p.uniform]
    if (p.type === 'color') {
      out[p.uniform] = typeof raw === 'string' && isParamHex(raw) ? raw : (p.default as string)
    } else if (p.type === 'gradient') {
      out[p.uniform] = cleanStops(raw, p.maxStops ?? 8, p.default as GradientStop[])
    } else if (p.type === 'enum') {
      const values = (p.options ?? []).map(o => o.value)
      out[p.uniform] = typeof raw === 'number' && values.includes(raw) ? raw : (p.default as number)
    } else {
      const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : (p.default as number)
      out[p.uniform] = Math.min(Math.max(v, p.min ?? -Infinity), p.max ?? Infinity)
    }
  }
  return out
}

/**
 * Resolved values → the uniform dict GL uploads. Floats pass through; a `color`
 * becomes one vec3; a `gradient` expands to `u_x[i]` (vec3), `u_xPos[i]` and
 * `u_xCount`. Indexed names are ordinary uniform locations, so arrays need no
 * extra machinery — the same shape GRADIENT_MAP_FS already uses.
 */
export function toUniforms(eff: EffectDef, values: Record<string, ParamValue>): Record<string, UniformValue> {
  const out: Record<string, UniformValue> = {}
  for (const p of eff.params) {
    const v = values[p.uniform] ?? p.default
    if (p.type === 'color') {
      out[p.uniform] = hexVec3(typeof v === 'string' ? v : (p.default as string))
    } else if (p.type === 'gradient') {
      // Through `cleanStops` rather than a local sort/slice, so the uniforms and
      // the descriptor key are normalized by the same function.
      const stops = cleanStops(v, p.maxStops ?? 8, p.default as GradientStop[])
      out[`${p.uniform}Count`] = stops.length
      stops.forEach((s, i) => {
        out[`${p.uniform}[${i}]`] = hexVec3(s.color)
        out[`${p.uniform}Pos[${i}]`] = s.pos
      })
    } else {
      out[p.uniform] = v as number
    }
  }
  return out
}

/** Defaults merged with overrides, expanded to uniforms. */
export function resolveUniforms(eff: EffectDef, overrides: Record<string, ParamValue>): Record<string, UniformValue> {
  return toUniforms(eff, resolveValues(eff, overrides))
}

function isDefault(p: EffectParamDef, v: ParamValue): boolean {
  if (p.type === 'gradient') {
    // Normalize BOTH sides first: the same ramp can arrive as an array (picker) or
    // as JSON text (a `gradientStops` control), and those stringify differently
    // while meaning the same thing — so a raw compare would persist a "change"
    // that is really just the other spelling of the default.
    const max = p.maxStops ?? 8
    const def = p.default as GradientStop[]
    return serializeStops(cleanStops(v, max, def)) === serializeStops(cleanStops(def, max, def))
  }
  return v === p.default
}

/** Store only non-default values in the widget so workflows stay tidy. */
export function serializeParams(eff: EffectDef, values: Record<string, ParamValue>): string {
  const out: Record<string, ParamValue> = {}
  for (const p of eff.params) {
    const v = values[p.uniform]
    if (v !== undefined && !isDefault(p, v)) out[p.uniform] = v
  }
  return JSON.stringify(out)
}
