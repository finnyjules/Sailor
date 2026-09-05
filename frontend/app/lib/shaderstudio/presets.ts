// frontend/app/lib/shaderstudio/presets.ts
import type { StudioAdjust } from './types'
import type { ParamValue } from '~/lib/shaderfx/types'

export interface DuotonePreset { name: string; ink: string; paper: string }
export interface AdjustPreset { name: string; values: Partial<Omit<StudioAdjust, 'enabled'>> }

export const DUOTONE_PRESETS: DuotonePreset[] = [
  { name: 'Mono', ink: '#000000', paper: '#ffffff' },
  { name: 'Indigo', ink: '#1a1a2e', paper: '#e8e8f5' },
  { name: 'Blood', ink: '#3a0a0a', paper: '#f3d9c0' },
  { name: 'Forest', ink: '#0c2a1f', paper: '#dff0e2' },
  { name: 'Sepia', ink: '#2b1a08', paper: '#f0e2c8' },
  { name: 'Ocean', ink: '#06283d', paper: '#dff6ff' },
  { name: 'Berry', ink: '#2d0a2e', paper: '#ffd9f0' },
  { name: 'Ember', ink: '#1a1206', paper: '#ffb347' },
]

export const ADJUST_PRESETS: AdjustPreset[] = [
  { name: 'Neutral', values: { exposure: 0, brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0, tint: 0 } },
  { name: 'Punchy', values: { exposure: -0.15, contrast: 0.25, saturation: 0.2 } },
  { name: 'Faded', values: { contrast: -0.2, saturation: -0.25, brightness: 0.08 } },
  { name: 'Warm', values: { temperature: 0.3, saturation: 0.1 } },
  { name: 'Cool', values: { temperature: -0.3, tint: -0.1 } },
  { name: 'B&W', values: { saturation: -1, contrast: 0.15 } },
]

/**
 * One-click looks for an effect: a named set of its own param values, keyed by
 * effect id. Applied through the same `setParam` path the sliders use, so a look
 * is just a bundle of edits — nothing else is stored. A look names only the
 * params it means to set: most leave inks and colours alone so they never throw
 * away a chosen palette; a duotone look IS its colour pair, so it sets them, and
 * a look that IS a palette (Culture's ordered ink roles) sets the whole stop
 * list — hence `ParamValue`, the same union a param carries everywhere else.
 */
export interface EffectLook { name: string; params: Record<string, ParamValue> }

export const EFFECT_LOOKS: Record<string, EffectLook[]> = {
  // Static's riso duotone pairs (ink on paper), the tool's own set.
  static: [
    { name: 'Wine on Periwinkle', params: { u_ink: '#5C1226', u_bg: '#8286EC' } },
    { name: 'Pink on Straw', params: { u_ink: '#F07BD8', u_bg: '#DCE2AA' } },
    { name: 'Maroon on Orange', params: { u_ink: '#571020', u_bg: '#F0480F' } },
    { name: 'Blue on Cream', params: { u_ink: '#1B3FA8', u_bg: '#F2E9D8' } },
    { name: 'Green on Yellow', params: { u_ink: '#0E4D3C', u_bg: '#F5C21B' } },
    { name: 'Blue on Pink', params: { u_ink: '#2B2BE0', u_bg: '#F0A7D8' } },
    { name: 'Black on Lime', params: { u_ink: '#101010', u_bg: '#C6FF3D' } },
    { name: 'Purple on Gold', params: { u_ink: '#7A1FA0', u_bg: '#FFD84D' } },
  ],
  oddgrid: [
    { name: 'Patchwork', params: { u_scale: 13, u_density: 0.82, u_block: 0.75, u_bsize: 6, u_grain: 0.75, u_variety: 0.55, u_speck: 0.1, u_balance: 0, u_motif: 0, u_motifAmt: 0 } },
    { name: 'Bloom', params: { u_scale: 9, u_density: 0.52, u_block: 0.1, u_bsize: 4, u_grain: 0.28, u_variety: 0.15, u_speck: 0.04, u_balance: 0.1, u_motif: 1, u_motifAmt: 0.9 } },
    { name: 'Quilt', params: { u_scale: 8, u_density: 0.95, u_block: 0.28, u_bsize: 5, u_grain: 0.55, u_variety: 0.2, u_speck: 0.12, u_balance: 0.6, u_motif: 4, u_motifAmt: 0.12 } },
    { name: 'Scatter', params: { u_scale: 12, u_density: 0.32, u_block: 0.05, u_bsize: 4, u_grain: 0.5, u_variety: 0.4, u_speck: 0.1, u_balance: 0, u_motif: 1, u_motifAmt: 0.55 } },
    { name: 'Drift', params: { u_scale: 16, u_density: 0.65, u_block: 0.6, u_bsize: 9, u_grain: 0.18, u_variety: 0.5, u_speck: 0.03, u_balance: 0.2, u_motif: 0, u_motifAmt: 0 } },
  ],
  // Culture's five plates. The inks are ORDERED ROLES, not a smooth ramp: the
  // first is the plate, each one after it a ring further in, so a look is the
  // whole stop list and nothing else — the dials a person set are left alone.
  culture: [
    { name: 'Orange, Red, Periwinkle', params: { u_ramp: [
      { pos: 0, color: '#EF8F14' }, { pos: 0.5, color: '#A81E12' }, { pos: 1, color: '#9FA8DA' }] } },
    { name: 'Cream, Blue, Red, Yellow', params: { u_ramp: [
      { pos: 0, color: '#E9E3D2' }, { pos: 1 / 3, color: '#1F3A93' }, { pos: 2 / 3, color: '#F03E2F' }, { pos: 1, color: '#F5C518' }] } },
    { name: 'Black, Pink, Orange, Cream', params: { u_ramp: [
      { pos: 0, color: '#101010' }, { pos: 1 / 3, color: '#F5003C' }, { pos: 2 / 3, color: '#FF8A3D' }, { pos: 1, color: '#FFE8B0' }] } },
    { name: 'Paper, Pine, Mint, Forest', params: { u_ramp: [
      { pos: 0, color: '#F2EDE3' }, { pos: 1 / 3, color: '#2E6E4F' }, { pos: 2 / 3, color: '#8FCB9B' }, { pos: 1, color: '#12301F' }] } },
    { name: 'Midnight, Violet, Pink, Gold', params: { u_ramp: [
      { pos: 0, color: '#1A1633' }, { pos: 1 / 3, color: '#6E3AC4' }, { pos: 2 / 3, color: '#E45AA8' }, { pos: 1, color: '#FFD166' }] } },
  ],
}

/** Reset to neutral, then apply the preset's overrides. Keeps `enabled` as-is. */
export function applyAdjustPreset(adjust: StudioAdjust, preset: AdjustPreset): void {
  const neutral = ADJUST_PRESETS[0]!.values
  Object.assign(adjust, neutral, preset.values)
}
