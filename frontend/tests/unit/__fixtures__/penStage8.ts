// tests/unit/__fixtures__/penStage8.ts
// Pen stage 8's speed fixtures (Global Constraints): ONE connected drawing
// and a symmetric grid — never scattered shapes.
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addPath } from '~/lib/sketch/edit'

/** A closed path of `n` straight pieces round a centre, its anchors at
 *  radii 10 and 8 in turn — one connected drawing whose every anchor is a corner. */
export function gear(n = 150): { doc: SketchDoc; path: EntityId; anchors: EntityId[] } {
  const doc: SketchDoc = { entities: [], constraints: [] }
  const anchors: EntityId[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, r = i % 2 ? 8 : 10
    anchors.push(addPoint(doc, r * Math.cos(a), r * Math.sin(a)))
  }
  const path = addPath(doc, anchors, anchors.map(() => ({ kind: 'line' as const })), true)
  return { doc, path, anchors }
}

/** A closed counter-clockwise square path (x0, y0)–(x0 + s, y0 + s). */
export function squarePath(doc: SketchDoc, x0: number, y0: number, s: number): { path: EntityId; pts: EntityId[] } {
  const pts = [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]].map(([x, y]) => addPoint(doc, x!, y!))
  return { path: addPath(doc, pts, pts.map(() => ({ kind: 'line' as const })), true), pts }
}

/** `count` separate closed rectangles (1 × 0.6), 2 apart in rows of 7. */
export function rectGrid(count = 37): { doc: SketchDoc; paths: EntityId[] } {
  const doc: SketchDoc = { entities: [], constraints: [] }
  const paths: EntityId[] = []
  for (let i = 0; i < count; i++) {
    const x0 = (i % 7) * 2, y0 = Math.floor(i / 7) * 2
    const pts = [[x0, y0], [x0 + 1, y0], [x0 + 1, y0 + 0.6], [x0, y0 + 0.6]].map(([x, y]) => addPoint(doc, x!, y!))
    paths.push(addPath(doc, pts, pts.map(() => ({ kind: 'line' as const })), true))
  }
  return { doc, paths }
}
