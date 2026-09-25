// What Frame's prompt chip is told about one layer (spec §1.2; stage 4 Task 9
// review I1). frameSelectionLabel falls back to the layer's kind when it has no
// name, and a kind is an identifier ("deal", "rect", "wired"). So every kind gets
// the word the rest of the Frame editor already shows for it: the add menu's
// labels (TOOLBAR_SHAPES; a deal layer is the Mosaic element), and for a wired
// layer, its source's own name. Pure.
import { TOOLBAR_SHAPES, type ToolbarShapeId } from '~/lib/compositor/toolbarMenus'

/** Internal layer kind → the add menu's row it was stamped from. */
const KIND_TO_SHAPE: Record<string, ToolbarShapeId> = {
  rect: 'rect', ellipse: 'ellipse', line: 'line', polygon: 'polygon', star: 'star', deal: 'mosaic', scatter: 'scatter',
}

export interface FrameChipLayer { kind: string; text: string | null; name: string | null }

/**
 * @param o.wiredName a wired slot's name (0-based slot, as on the layer): the name
 *   the user gave the slot, else the source node's own name; null when neither.
 */
export function frameChipLayer(
  l: { kind: string; text?: string | null; name?: string | null; slot?: number },
  o: { wiredName: (slot: number) => string | null },
): FrameChipLayer {
  const kind = String(l.kind)
  const own = (l.name ?? '').trim()
  const text = l.text ?? null
  if (own) return { kind, text, name: own }
  if (kind === 'wired') {
    const slot = Number(l.slot ?? 0)
    // Same fallback as the layer list's row label (rowLabel): the 1-based slot.
    return { kind, text, name: o.wiredName(slot)?.trim() || `Layer ${slot + 1}` }
  }
  const shape = KIND_TO_SHAPE[kind]
  const label = shape ? TOOLBAR_SHAPES.find(s => s.id === shape)?.label ?? null : null
  return { kind, text, name: label }
}
