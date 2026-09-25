// frontend/app/lib/artifact/nextSteps.ts
// Pure helpers for the artifact Edit-menu escalator actions and the
// post-render next-steps chip strip. Credit hints are static estimates from
// docs/superpowers/specs/2026-07-01-costs-and-pricing-model.md (1cr = $0.01);
// the billing spec's price_book replaces them when metering lands.

export const ARTIFACT_ACTION_IDS = [
  'remove-bg', 'inpaint', 'nano-banana', 'fix',
  'enhance', 'upscale', 'relight', 'lens',
  'variations', 'animate',
] as const
export type ArtifactActionId = typeof ARTIFACT_ACTION_IDS[number]

// Dollar amounts until the credits system ships (billing spec's price_book
// will replace these constants; credits = $ × 100 when that lands).
export const ACTION_HINTS: Record<ArtifactActionId, string | null> = {
  'remove-bg': null,
  'inpaint': null,
  'nano-banana': '~$0.12',
  'fix': null,
  'enhance': '$0.14–0.28',
  'upscale': '~$0.14',
  'relight': '~$0.12',
  'lens': '~$0.12',
  'variations': '3 runs',
  'animate': 'from $1.60',
}

interface MinimalNode { id: string; data?: { nodeType?: string; images?: unknown[]; audios?: unknown[] } }
interface MinimalEdge { source: string; target: string }

/** True when this node is an artifact card already holding a loadable result —
 *  the same criteria getFilteredWorkflow's auto-freeze uses, so the seed scope
 *  and the freeze set stay in agreement. */
function isFrozenArtifact(n: MinimalNode | undefined): boolean {
  const nt = n?.data?.nodeType
  const ref = nt === 'Audio' ? n?.data?.audios?.[0] : n?.data?.images?.[0]
  return (nt === 'Image' || nt === 'Video' || nt === 'Audio')
    && typeof ref === 'string' && ref.includes('filename=')
}

/** True when any DIRECT upstream source of this node is a paid generator
 *  (carries a price_badge from /object_info). Drives the auto-review gate:
 *  only renders that cost money get a free-of-charge critique pass. */
export function paidProducerFor(
  nodeId: string,
  nodes: { id: string; data?: { priceBadge?: unknown } }[],
  edges: MinimalEdge[],
): boolean {
  const byId = new Map(nodes.map(n => [String(n.id), n]))
  for (const e of edges) {
    if (String(e.target) !== String(nodeId)) continue
    if (byId.get(String(e.source))?.data?.priceBadge) return true
  }
  return false
}

/** Seed scope for a 'variation' re-run: the targets plus every transitive
 *  upstream node, stopping at (and excluding) artifacts that already hold a
 *  result — those get auto-frozen by the run, so rerolling above them would
 *  churn live seeds on nodes that won't execute. */
export function upstreamSeedScope(
  targetIds: string[],
  nodes: MinimalNode[],
  edges: MinimalEdge[],
): Set<string> {
  const byId = new Map(nodes.map(n => [String(n.id), n]))
  const scope = new Set(targetIds.map(String))
  const stack = [...scope]
  while (stack.length) {
    const id = stack.pop()!
    for (const e of edges) {
      if (String(e.target) !== id) continue
      const s = String(e.source)
      if (scope.has(s)) continue
      if (isFrozenArtifact(byId.get(s))) continue
      scope.add(s)
      stack.push(s)
    }
  }
  return scope
}
