/**
 * Saved Fix faces and Face swap nodes from before the non-commercial face
 * models were replaced (docs/superpowers/specs/2026-09-26-non-commercial-face-models-replacement-design.md).
 * PURE — no Vue, no DOM, no I/O. Runs at `convertFromLiteGraph`, beside the
 * KineticType migration, so every load crosses it.
 *
 * The prompt builder zips `widgets_values` positionally against the node's
 * current widgets (graphToPrompt.ts), so an old node's values would land on
 * the new inputs: an old CodeFormer Fix faces `['CodeFormer', 0.5, true, true, 2]`
 * would run with creativity 0.5 and show strength "CodeFormer"; an old
 * InsightFace Face swap `[face_index, threshold]` would show gender 0.
 * The old values mean nothing to the new models, so they are replaced by the
 * new defaults (Fix faces keeps its upscale factor, which means the same).
 */

const FIX_FACES_STRENGTH = 0.8
const FIX_FACES_CREATIVITY = 0
const FIX_FACES_UPSCALE = 2
const FACE_SWAP_DEFAULTS = ['Not chosen', 'The picture']

/** Rewrites one saved node in place; true when it changed. */
export function migrateFaceNode(node: any): boolean {
  const v = node?.widgets_values
  if (!Array.isArray(v)) return false
  if (node.type === 'FixFacesNode' && v[0] === 'CodeFormer') {
    const up = v[4]
    const upscale = typeof up === 'number' && Number.isInteger(up) && up >= 1 && up <= 4 ? up : FIX_FACES_UPSCALE
    node.widgets_values = [FIX_FACES_STRENGTH, FIX_FACES_CREATIVITY, upscale]
    return true
  }
  if (node.type === 'FaceSwap' && v.length === 2 && v.every(x => typeof x === 'number')) {
    node.widgets_values = [...FACE_SWAP_DEFAULTS]
    return true
  }
  return false
}

/** Rewrites the workflow's (and its subgraphs') old face nodes in place; the count changed. */
export function migrateFaceNodesWorkflow(workflow: any, definitions?: { subgraphs?: any[] }): number {
  let n = 0
  const lists: unknown[] = [workflow?.nodes, ...((definitions?.subgraphs ?? workflow?.definitions?.subgraphs ?? []) as any[]).map(sg => sg?.nodes)]
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const node of list) if (migrateFaceNode(node)) n++
  }
  return n
}
