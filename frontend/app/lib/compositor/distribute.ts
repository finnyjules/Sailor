// Second discrete-palette consumer: one palette color per selected Compositor layer.
// Studio-agnostic — no Vue, no Compositor types — just an id->hex assignment.
import { distribute } from '~/lib/color/project'

export function layerPaletteAssignments(layerIds: string[], hexes: string[]): Record<string, string> {
  const colors = distribute(hexes, layerIds.length, 'cycle')
  const out: Record<string, string> = {}
  layerIds.forEach((id, i) => { out[id] = colors[i]! })
  return out
}
