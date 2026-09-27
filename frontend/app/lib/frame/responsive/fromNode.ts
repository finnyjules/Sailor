import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { FrameMotion } from '~/lib/motion/types'
import { readLayoutGrid } from '~/lib/frame/layoutGrid'
import { formatFor } from '~/lib/frame/formats'
import type { FrameDoc, StackKey } from './types'

type Props = Record<string, unknown> | undefined

/** True only when the Frame was explicitly made responsive. Every existing Frame is fixed. */
export function isResponsiveFrame(props: Props): boolean {
  return (props?.sailor_frame as { responsive?: unknown } | undefined)?.responsive === true
}

/**
 * The resolver's read of a Frame node's `sailor_*` bag. Arrays are passed by
 * REFERENCE (never copied) so the identity fast path can hand them straight back.
 * The grid is the Frame's layout grid at the design size — the same read the editor makes — so
 * layers hold to exactly the grid the overlay draws.
 */
export function frameDocFromProps(props: Props, designW: number, designH: number): FrameDoc {
  const sized = designW > 0 && designH > 0
  const format = sized ? formatFor(props, designW, designH) : null
  return {
    responsive: isResponsiveFrame(props),
    designW, designH,
    layers: (props?.sailor_localLayers as LocalLayer[] | undefined) ?? [],
    stackOrder: (props?.sailor_stackOrder as StackKey[] | undefined) ?? [],
    groups: (props?.sailor_localGroups as LayerGroup[] | undefined) ?? [],
    grid: sized ? readLayoutGrid(props, designW, designH, format) : null,
    format,
    motion: (props?.sailor_motion as FrameMotion | undefined) ?? null,
  }
}
