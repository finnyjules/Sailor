// The previewing gallery catalog (Slice 4). Data-only: each move maps to a registered
// behaviour kind + params, a group, a small live-preview key, and an optional layer
// capability it needs. The gallery component renders these; clicking one calls
// addBehaviour(kind, params). Pure — zero Vue/compositor coupling.

export type MoveGroup = 'In' | 'Loop' | 'Out' | 'Gradient'
export type PreviewKind =
  | 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right'
  | 'grow' | 'shrink' | 'spin' | 'pulse' | 'sway' | 'float'
  | 'scroll' | 'morph'

export interface GalleryMove {
  id: string
  kind: string                       // a registered behaviour kind
  label: string                      // sentence case
  group: MoveGroup
  preview: PreviewKind
  params?: Record<string, unknown>
  needs?: 'gradient' | 'text'        // layer capability required to offer this move
}

/** Layer capabilities the gallery filters against. */
export interface LayerCaps { gradient: boolean; text: boolean }

export const GALLERY_MOVES: GalleryMove[] = [
  // In
  { id: 'fade-in', kind: 'fade', label: 'Fade in', group: 'In', preview: 'fade', params: { dir: 'in' } },
  { id: 'scale-in', kind: 'scale', label: 'Grow in', group: 'In', preview: 'grow', params: { dir: 'in' } },
  { id: 'slide-up', kind: 'slide', label: 'Slide up', group: 'In', preview: 'slide-up', params: { dir: 'up' } },
  { id: 'slide-down', kind: 'slide', label: 'Slide down', group: 'In', preview: 'slide-down', params: { dir: 'down' } },
  { id: 'slide-left', kind: 'slide', label: 'Slide left', group: 'In', preview: 'slide-left', params: { dir: 'left' } },
  { id: 'slide-right', kind: 'slide', label: 'Slide right', group: 'In', preview: 'slide-right', params: { dir: 'right' } },
  // Loop
  { id: 'spin', kind: 'spin', label: 'Spin', group: 'Loop', preview: 'spin' },
  { id: 'pulse', kind: 'pulse', label: 'Pulse', group: 'Loop', preview: 'pulse' },
  { id: 'sway', kind: 'sway', label: 'Sway', group: 'Loop', preview: 'sway' },
  { id: 'float', kind: 'float', label: 'Float', group: 'Loop', preview: 'float' },
  // Out
  { id: 'fade-out', kind: 'fade', label: 'Fade out', group: 'Out', preview: 'fade', params: { dir: 'out' } },
  { id: 'scale-out', kind: 'scale', label: 'Shrink out', group: 'Out', preview: 'shrink', params: { dir: 'out' } },
  // Gradient
  { id: 'gradient-scroll', kind: 'gradientScroll', label: 'Scroll', group: 'Gradient', preview: 'scroll', needs: 'gradient' },
]

const GROUP_ORDER: MoveGroup[] = ['In', 'Loop', 'Out', 'Gradient']

/** Filter the catalog to what a layer supports (gradient moves need a gradient fill;
 *  text-only moves need a text layer). Transform/opacity moves are always offered. */
export function movesForLayer(caps: LayerCaps): GalleryMove[] {
  return GALLERY_MOVES.filter((m) => {
    if (m.needs === 'gradient') return caps.gradient
    if (m.needs === 'text') return caps.text
    return true
  })
}

/** Bucket moves into groups in canonical order, dropping empty groups. */
export function groupedMoves(moves: GalleryMove[]): Array<{ group: MoveGroup; moves: GalleryMove[] }> {
  return GROUP_ORDER
    .map((group) => ({ group, moves: moves.filter((m) => m.group === group) }))
    .filter((g) => g.moves.length > 0)
}
