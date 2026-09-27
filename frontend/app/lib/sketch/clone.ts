import type { SketchDoc, SketchEntity, SketchConstraint } from './model'

// Structural deep clone of a SketchDoc — used for undo/redo history snapshots.
// Every entity/constraint is a fresh object; a path's `anchors`/`segments`
// arrays (and each segment object) are fresh too, so mutating a clone never
// reaches back into the original doc (or a previously-pushed history entry).
// Pure — no reactivity assumptions, safe to call on a plain object or on
// something pulled out of a Vue ref.
export function cloneDoc(doc: SketchDoc): SketchDoc {
  const out: SketchDoc = {
    entities: doc.entities.map(e => {
      if (e.kind === 'path') return { ...e, anchors: [...e.anchors], segments: e.segments.map(s => ({ ...s })) }
      return { ...e }
    }) as SketchEntity[],
    constraints: doc.constraints.map(c => ({ ...c, refs: [...c.refs] })) as SketchConstraint[],
  }
  // pen stage 7: fills, only when there are any (a drawing without them clones exactly as before)
  if (doc.fills) out.fills = doc.fills.map(f => ({ id: f.id, seed: { ...f.seed } }))
  if (doc.fillGap != null) out.fillGap = doc.fillGap
  return out
}
