import type { NodeTypeLite, PortAnchor } from './portIntent'
import { matchingPort, linkInputPorts, outputPorts } from './portIntent'
import { searchNodes } from './nodeMatch'
import { isRetiredClass } from '#shared/runner/retired'

export interface CatalogWidget {
  name: string
  type: string
  default?: unknown
  min?: number
  max?: number
  options?: string[]
  optionsOmitted?: number
}

export interface CatalogEntry {
  type: string
  name: string
  description: string
  inputs: { name: string; type: string; optional?: boolean }[]
  outputs: { name: string; type: string }[]
  widgets: CatalogWidget[]
  /** True when this is one of OUR curated capabilities (a high-level generator/
   *  studio/effect) rather than a raw provider/ComfyUI node. Set by the caller;
   *  the agent prompt prefers these as a hard rule. */
  capability?: boolean
}

/** Widget definitions derived from an /object_info entry. Enum option lists are
 *  capped at maxEnum (pass Infinity for the full list, used by validation). */
export function widgetDefsFromInfo(info: any, maxEnum = 20): CatalogWidget[] {
  const out: CatalogWidget[] = []
  const all = {
    ...((info?.input?.required ?? {}) as Record<string, any>),
    ...((info?.input?.optional ?? {}) as Record<string, any>),
  }
  for (const [name, spec] of Object.entries(all)) {
    const arr = Array.isArray(spec) ? spec : [spec]
    const t = arr[0]
    const cfg = arr[1] || {}
    if (Array.isArray(t)) {
      const options = t.map(String)
      out.push({
        name,
        type: 'ENUM',
        default: cfg.default ?? options[0],
        options: options.slice(0, maxEnum),
        optionsOmitted: Math.max(0, options.length - Math.min(maxEnum, options.length)),
      })
    }
    else if (['INT', 'FLOAT'].includes(String(t)) && !cfg.forceInput) {
      out.push({ name, type: String(t), default: cfg.default, min: cfg.min, max: cfg.max })
    }
    else if (['STRING', 'BOOLEAN'].includes(String(t)) && !cfg.forceInput) {
      out.push({ name, type: String(t), default: cfg.default })
    }
  }
  return out
}

export interface BuildCatalogOpts {
  maxEnum?: number
  maxNodes?: number
  /** User's free-text intent. When set, intent-matched nodes are added as a
   *  third bucket so an intent-relevant node reaches the model even if it isn't
   *  type-compatible with the anchor (the incompatible-port backstop). */
  intent?: string
  /** Node class name → intent keywords, forwarded to the matcher. */
  keywords?: Record<string, string[]>
  /** Node class name → score boost, forwarded to the matcher. */
  boosts?: Record<string, number>
  /** Cap on the intent bucket. */
  maxIntent?: number
  /** Node types to GUARANTEE in the result (within maxNodes) regardless of intent/
   *  anchor — e.g. the flagship GenerateImage, so a bare descriptive prompt
   *  ("a neon alley, cinematic") can always be turned into a generation. */
  alwaysInclude?: string[]
}

/** Trimmed catalog for the AI request: nodes directly compatible with the anchor
 *  first, then nodes one type-hop away (so chains can bridge, e.g. IMAGE→LATENT→…),
 *  then — if an intent is given — the top intent-matched nodes regardless of type. */
export function buildCatalog(
  nodeTypes: NodeTypeLite[],
  objectInfo: Record<string, any>,
  anchor: Pick<PortAnchor, 'portType' | 'direction'>,
  opts: BuildCatalogOpts = {},
): CatalogEntry[] {
  const { maxEnum = 20, maxNodes = 150, intent, keywords, boosts, maxIntent = 10, alwaysInclude = [] } = opts
  // Retired partner nodes are never offered, pinned or matched (shared/runner/retired.ts).
  nodeTypes = nodeTypes.filter(n => !isRetiredClass(n.name))
  const hop1 = nodeTypes.filter(n => matchingPort(n, anchor))
  const hop1Names = new Set(hop1.map(n => n.name))

  // Far-side types of hop-1 nodes seed the second hop, continuing in the same
  // direction of flow (downstream for output anchors, upstream for input anchors).
  const farTypes = new Set<string>()
  for (const n of hop1) {
    const far = anchor.direction === 'output' ? n.outputs : n.inputs
    for (const p of far) farTypes.add(p.type)
  }
  const hop2 = nodeTypes.filter(n =>
    !hop1Names.has(n.name)
    && (anchor.direction === 'output'
      ? n.inputs.some(p => farTypes.has(p.type))
      : n.outputs.some(p => farTypes.has(p.type))),
  )

  // Intent-matched nodes, ranked over ALL node types, go FIRST so the thing the
  // user actually asked for is never truncated. Crucially this is NOT filtered to
  // exclude hop1/hop2 — a node that is BOTH type-compatible AND intent-relevant
  // (e.g. RemoveBackground for "remove the background" on an IMAGE anchor) would
  // otherwise sit unranked deep in a large hop1 and get sliced off by maxNodes.
  const intentRanked = (intent && intent.trim())
    ? searchNodes(nodeTypes, intent, { keywords, boosts, limit: maxIntent })
    : []
  const ranked = new Set(intentRanked.map(n => n.name))
  const hop1Rest = hop1.filter(n => !ranked.has(n.name))
  const hop2Rest = hop2.filter(n => !ranked.has(n.name))

  // Guarantee pinned flagships are present (within the cap) without displacing the
  // intent-relevant results: take the normal list, then append any missing pins,
  // trimming the tail to stay within maxNodes.
  const base = [...intentRanked, ...hop1Rest, ...hop2Rest]
  const pinSet = new Set(alwaysInclude)
  if (pinSet.size) {
    const present = new Set(base.map(n => n.name))
    const missing = nodeTypes.filter(n => pinSet.has(n.name) && !present.has(n.name))
    if (missing.length) base.splice(Math.max(0, maxNodes - missing.length), base.length, ...missing)
  }

  return base.slice(0, maxNodes).map((n) => {
    const info = objectInfo[n.name]
    return {
      type: n.name,
      name: n.displayName,
      description: (n.description || '').slice(0, 200),
      inputs: info ? linkInputPorts(info) : n.inputs,
      outputs: info ? outputPorts(info) : n.outputs,
      widgets: info ? widgetDefsFromInfo(info, maxEnum) : [],
    }
  })
}
