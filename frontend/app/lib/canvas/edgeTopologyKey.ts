/** A cheap string that identifies the canvas' edge TOPOLOGY — which node/handle
 *  is wired to which — and nothing else.
 *
 *  Watchers that only care about wiring (ShotDirector cast sync, the
 *  Collection-link prune) used to sit on `watch(edges, …, { deep: true })`.
 *  That is expensive far beyond its looks: a Vue Flow edge object carries
 *  `sourceNode`/`targetNode` back-references, so a deep traversal of the edge
 *  list walks every reactive property of every node it touches — the whole
 *  graph, re-tracked on every node position change. During a node drag that
 *  ran once per pointer move (measured ~250 ms per frame with edges present).
 *
 *  Watching this key instead makes those watchers fire on add / remove /
 *  rewire / handle change and stay silent for positions, selection and data.
 */
export interface EdgeTopologyLike {
  id: string | number
  source: string | number
  target: string | number
  sourceHandle?: string | null
  targetHandle?: string | null
}

export function edgeTopologyKey(edges: ReadonlyArray<EdgeTopologyLike>): string {
  // `|` between fields and `\n` between edges: two separators means no field
  // value can slide across a boundary and forge another topology's key.
  let key = ''
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!
    if (i > 0) key += '\n'
    key += `${e.id}|${e.source}|${e.sourceHandle ?? ''}|${e.target}|${e.targetHandle ?? ''}`
  }
  return key
}
