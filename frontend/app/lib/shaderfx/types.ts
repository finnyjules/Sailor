import type { ShowWhen } from './showWhen'

export interface GradientStop { pos: number; color: string }

/**
 * A param's stored value. Floats and enums are numbers; `color` is a hex string;
 * `gradient` is a stop list. This is what gets persisted and what the control
 * schema addresses — NOT what the GL layer uploads (see `UniformValue`).
 */
export type ParamValue = number | string | GradientStop[]

/** What a uniform upload accepts. A 3-tuple is a vec3 (a colour). */
export type UniformValue = number | [number, number, number]

/**
 * Colour-shaped param types. These are NOT animatable — motion targets derive
 * from this same param list, and a hex string has no meaningful interpolation
 * in a float sweep. Anything branching "enum, else slider" must check this too.
 */
export const COLOR_PARAM_TYPES = ['color', 'gradient'] as const

export function isColorParam(p: EffectParamDef): boolean {
  return p.type === 'color' || p.type === 'gradient'
}

export interface EffectParamDef {
  uniform: string
  label: string
  type: 'float' | 'enum' | 'color' | 'gradient'
  min?: number
  max?: number
  /** number for float/enum · hex string for color · GradientStop[] for gradient */
  default: ParamValue
  step?: number
  options?: { label: string; value: number }[]
  /** `gradient` only — hard cap on stops, matching the shader's array size. */
  maxStops?: number
  /** Hide this param unless another uniform's current (rounded) value matches. */
  showWhen?: ShowWhen | ShowWhen[]
}

export interface EffectTextureDef {
  uniform: string
  file: string
  extraUniforms?: Record<string, number>
  /** content version (asset mtime) for cache-busting the asset URL */
  v?: string
}

export interface EffectDef {
  id: string
  name: string
  category: string
  animated: boolean
  passes: number
  centerParam: string[] | null
  textures: EffectTextureDef[]
  params: EffectParamDef[]
  source: string
  generative?: boolean
  /** A lens that takes the Frame layer's silhouette (u_shape + u_hasShape/u_shapeCX/u_shapeCY/u_shapeSize). */
  followsShape?: boolean
}

export interface ShaderFxCatalog {
  version: number
  effects: EffectDef[]
}
