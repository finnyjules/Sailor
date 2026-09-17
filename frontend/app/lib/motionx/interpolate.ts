import { blendHex, crossfadeStops, travelStops } from '~/lib/color/gradientTween'
import type { GradientStop } from '~/lib/color/harmony'
import type { PropertyType, PropertyValue } from './types'

export interface InterpOpts { mode?: 'crossfade' | 'travel'; space?: 'oklab' | 'hybrid' }

export function interpolateValue(
  type: PropertyType, a: PropertyValue, b: PropertyValue, p: number, opts: InterpOpts = {},
): PropertyValue {
  const space = opts.space ?? 'oklab'
  if (type === 'number') return (a as number) + ((b as number) - (a as number)) * p
  if (type === 'color') return blendHex(a as string, b as string, p, space)
  const from = a as GradientStop[], to = b as GradientStop[]
  return (opts.mode ?? 'crossfade') === 'travel'
    ? travelStops(from, to, p, space)
    : crossfadeStops(from, to, p, space)
}
