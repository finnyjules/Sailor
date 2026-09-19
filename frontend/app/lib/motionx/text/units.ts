// Letter behaviours — pure text geometry. A CELL is one drawn glyph; a PIECE is what a behaviour
// moves as one unit (a letter, a word or a line). Pixels, layer-local frame (origin = layer
// centre, before the layer's own rotation). No canvas, no Vue.
export interface TextCell { char: string; x: number; y: number; w: number; h: number; angle: number; word: number; line: number }
export type PieceBy = 'letters' | 'words' | 'lines'
export interface Piece { index: number; cells: number[]; cx: number; cy: number; w: number; h: number; angle: number }

export function groupCells(cells: TextCell[], by: PieceBy): Piece[] {
  const groups = new Map<number, number[]>()
  cells.forEach((c, i) => {
    const key = by === 'letters' ? i : by === 'words' ? c.word : c.line
    const g = groups.get(key); if (g) g.push(i); else groups.set(key, [i])
  })
  return [...groups.values()].map((idx, index) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, s = 0, co = 0
    for (const i of idx) {
      const c = cells[i]!
      x0 = Math.min(x0, c.x - c.w / 2); x1 = Math.max(x1, c.x + c.w / 2)
      y0 = Math.min(y0, c.y - c.h / 2); y1 = Math.max(y1, c.y + c.h / 2)
      s += Math.sin(c.angle); co += Math.cos(c.angle)
    }
    return { index, cells: idx, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, angle: Math.atan2(s, co) }
  })
}
