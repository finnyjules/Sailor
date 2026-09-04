// frontend/app/lib/frame/gridConfig.ts
// Read and write helpers for the sailor_localGrid frame property

import type { FrameGrid } from '~/lib/frame/grid'
import { defaultGrid } from '~/lib/frame/grid'

/**
 * Recursively fill any keys missing from a (possibly partial) saved grid config.
 * Guards non-objects and arrays (treats them as leaf values).
 */
function deepMerge<T>(base: T, over: any): T {
  if (over == null || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T
  const out: any = { ...(base as any) }
  for (const k of Object.keys(over)) out[k] = deepMerge((base as any)?.[k], over[k])
  return out
}

/**
 * Read the sailor_localGrid property from node props, deep-defaulting any missing key
 * from defaultGrid(). Returns the default (mode:'off') when absent.
 */
export function readGrid(props: Record<string, unknown> | undefined): FrameGrid {
  const raw = props?.sailor_localGrid
  if (raw == null) return defaultGrid()
  return deepMerge(defaultGrid(), raw)
}

/**
 * Wrap a FrameGrid for writing to node.data.properties.
 */
export function gridProperty(grid: FrameGrid): { sailor_localGrid: FrameGrid } {
  return { sailor_localGrid: grid }
}
