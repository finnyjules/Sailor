import { blendHex, crossfadeStops, travelStops } from '~/lib/color/gradientTween'
import { mixHex } from '~/lib/color/mix'
import type { GradientStop } from '~/lib/color/harmony'
import type { PropertyType, PropertyValue } from './types'

export interface InterpOpts { mode?: 'crossfade' | 'travel'; space?: 'oklab' | 'hybrid' | 'oklch' | 'srgb' }

export function interpolateValue(
  type: PropertyType, a: PropertyValue, b: PropertyValue, p: number, opts: InterpOpts = {},
): PropertyValue {
  if (type === 'number') return (a as number) + ((b as number) - (a as number)) * p
  if (type === 'color') {
    // 'oklch' | 'srgb' are the legacy effect-dial mix spaces (mixHex names sRGB 'rgb').
    if (opts.space === 'oklch' || opts.space === 'srgb') return mixHex(a as string, b as string, p, opts.space === 'srgb' ? 'rgb' : 'oklch')
    return blendHex(a as string, b as string, p, opts.space ?? 'oklab')
  }
  const space = opts.space === 'hybrid' ? 'hybrid' : 'oklab'
  const from = a as GradientStop[], to = b as GradientStop[]
  return (opts.mode ?? 'crossfade') === 'travel'
    ? travelStops(from, to, p, space)
    : crossfadeStops(from, to, p, space)
}
