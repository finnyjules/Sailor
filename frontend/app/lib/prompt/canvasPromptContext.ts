// What the canvas tells the one prompt: a chip label for the selection and 2–3
// suggestions. Labels quote the node's own title (UI-copy rule), never a role.
// "What does this do?" is how Explain is reached now (spec §5).

import { NODE_TITLE_OVERRIDES } from '~/lib/nodeTitleOverrides'
import { capabilityByType } from '~/lib/agent/capabilities'

export interface PromptNode {
  id: string
  title: string
  /** The Vue Flow type ('comfy', 'artifact-image', …) or the node class. */
  type: string
  hasImages: boolean
  /** The backend node class (e.g. 'KSampler'), when it differs from `type`. */
  nodeType?: string
  /** The catalog display name the card header falls back to, if known. */
  defaultTitle?: string
}

// Result cards have no catalog name worth showing — name them by what they hold.
const ARTIFACT_KIND: Record<string, string> = {
  'artifact-image': 'Image', 'artifact-video': 'Video', 'artifact-audio': 'Audio',
  'artifact-frame': 'Frame', 'artifact-text': 'Text', 'artifact-timeline': 'Timeline',
}

/** The name a chip shows for one node — never an identifier. A title the user
 *  gave the node wins; otherwise the same name the node card header shows. */
export function promptNodeLabel(n: PromptNode): string {
  const cls = n.nodeType || n.type
  const idents = new Set([n.type, cls].filter(Boolean))
  const title = n.title.trim()
  const def = n.defaultTitle?.trim() || ''
  if (title && !idents.has(title) && title !== def) return title // the user's own title
  if (NODE_TITLE_OVERRIDES[cls]) return NODE_TITLE_OVERRIDES[cls]!
  if (ARTIFACT_KIND[n.type]) return ARTIFACT_KIND[n.type]!
  if (def && !idents.has(def)) return def
  const cap = capabilityByType(cls)?.title
  if (cap) return cap
  if (title && !idents.has(title)) return title
  return 'Selected node'
}

export function selectionLabel(sel: PromptNode[]): string | null {
  if (!sel.length) return null
  if (sel.length > 1) return `${sel.length} nodes`
  return promptNodeLabel(sel[0]!)
}

export function canvasSuggestions(sel: PromptNode[], graphEmpty: boolean): string[] {
  if (!sel.length) return graphEmpty ? ['A red fox in the snow', 'What can Sailor make?'] : ['What does this graph do?', 'What should I try next?']
  if (sel.length > 1) return ['What do these do?', 'Connect these']
  return sel[0]!.hasImages ? ['What does this do?', 'Make it warmer', 'Upscale it'] : ['What does this do?', 'What can I connect to this?']
}
