import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { FrameMotion } from '~/lib/motion/types'
import { readGrid } from '~/lib/frame/gridConfig'
import type { FrameDoc, StackKey } from './types'

type Props = Record<string, unknown> | undefined

/** True only when the Frame was explicitly made responsive. Every existing Frame is fixed. */
export function isResponsiveFrame(props: Props): boolean {
  return (props?.sailor_frame as { responsive?: unknown } | undefined)?.responsive === true
}

/**
 * The resolver's read of a Frame node's `sailor_*` bag. Arrays are passed by
 * REFERENCE (never copied) so the identity fast path can hand them straight back.
 */
export function frameDocFromProps(props: Props, designW: number, designH: number): FrameDoc {
  const grid = readGrid(props)
  return {
    responsive: isResponsiveFrame(props),
    designW, designH,
    layers: (props?.sailor_localLayers as LocalLayer[] | undefined) ?? [],
    stackOrder: (props?.sailor_stackOrder as StackKey[] | undefined) ?? [],
    groups: (props?.sailor_localGroups as LayerGroup[] | undefined) ?? [],
    grid: grid.mode === 'off' ? null : grid,
    motion: (props?.sailor_motion as FrameMotion | undefined) ?? null,
  }
}
