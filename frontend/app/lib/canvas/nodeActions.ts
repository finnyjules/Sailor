// The node toolbar's actions (spec §1.4, §2.3): one registry, grouped by intent.
// Edit = the same thing, better. Develop = take it somewhere new. Most actions
// fire exactly the window event the old per-node menus fired, so the canvas
// handlers are unchanged. Variations and Tune… go through the prompt instead,
// so their results land above it (spec §3.1, §1.2). `lands` is the grey hint:
// '3 takes' on this node, or 'adds a step' (a new node after it); null for
// actions that open an editor.
// Actions that spend money add their price to that hint ("adds a step · ~$0.14"):
// `priceHint` is the fixed estimate the old image menu showed (ACTION_HINTS);
// otherwise `priceNodeType`'s own price_badge, the figure the node itself shows.
import { ACTION_HINTS } from '~/lib/artifact/nextSteps'
import { parseBadgeUsd } from '~/lib/costEstimate'
import { formatCostBadge } from '~/lib/pricing'
import { shaderGenEstimateText } from '~/lib/shadergen/estimate'

export type ActionGroup = 'edit' | 'develop'
export type ActionLands = 'takes' | 'step' | null
export interface NodeActionCtx { nodeId: string; type: string; hasImages: boolean; hasUpstream: boolean }
export interface NodeAction {
  id: string; label: string; group: ActionGroup; ai: boolean; lands: ActionLands
  /** Fixed price estimate for a paid action (wins over the badge). */
  priceHint?: string | null
  /** The paid node this action adds — its price_badge prices the action. */
  priceNodeType?: string
  enabled?: (c: NodeActionCtx) => boolean; run: (c: NodeActionCtx) => void
}

export function landsHint(l: ActionLands): string | null {
  return l === 'takes' ? '3 takes' : l === 'step' ? 'adds a step' : null
}

/** An action's price, or null when it doesn't spend money (or has no known price).
 *  `objectInfo` is /object_info; `hosted` shows credits instead of dollars. */
export function actionPrice(a: NodeAction, objectInfo: Record<string, any> | null | undefined, hosted: boolean): string | null {
  if (a.priceHint) return a.priceHint
  if (!a.priceNodeType) return null
  const cost = parseBadgeUsd(objectInfo?.[a.priceNodeType]?.price_badge?.expr)
  return cost ? formatCostBadge(cost.usd, cost.approximate, hosted) : null
}

/** The grey hint on a menu row: where it lands, plus the price when it spends money. */
export function actionHint(a: NodeAction, price: string | null): string | null {
  return [landsHint(a.lands), price].filter(Boolean).join(' · ') || null
}

const fire = (name: string, detail: Record<string, unknown>) => window.dispatchEvent(new CustomEvent(name, { detail }))
const splice = (c: NodeActionCtx, nodeType: string, opts: Record<string, unknown> = {}, widgetOverrides?: Record<string, unknown>) =>
  fire('sailor:applyEffect', { nodeId: c.nodeId, nodeType, output: 'IMAGE', widgetOverrides, ...opts })
const branchAction = (c: NodeActionCtx, nodeType: string, output: string) =>
  fire('sailor:applyEffect', { nodeId: c.nodeId, nodeType, output, branch: true, focus: true })

const FIX: NodeAction = { id: 'fix', label: 'Fix', group: 'edit', ai: true, lands: null, enabled: c => c.hasImages, run: c => fire('sailor:critiqueNode', { nodeId: c.nodeId }) }

const IMAGE: NodeAction[] = [
  FIX,
  { id: 'remove-bg', label: 'Remove background', group: 'edit', ai: false, lands: 'step', run: c => fire('sailor:applyEffect', { nodeId: c.nodeId, nodeType: 'BackgroundRemove', output: 'IMAGE', widgetOverrides: { output: 'transparent' } }) },
  { id: 'inpaint', label: 'Inpaint', group: 'edit', ai: true, lands: null, run: c => fire('sailor:openInpaint', { nodeId: c.nodeId }) },
  { id: 'remove-object', label: 'Remove object', group: 'edit', ai: true, lands: null, run: c => fire('sailor:openInpaint', { nodeId: c.nodeId, intent: 'remove' }) },
  { id: 'recolor', label: 'Recolor…', group: 'edit', ai: true, lands: null, run: c => fire('sailor:openInpaint', { nodeId: c.nodeId, intent: 'recolor' }) },
  { id: 'edit-text', label: 'Edit text…', group: 'edit', ai: true, lands: null, run: c => fire('sailor:openTextEdit', { nodeId: c.nodeId }) },
  { id: 'nano-banana', label: 'Edit with Nano Banana', group: 'edit', ai: true, lands: 'step', priceHint: ACTION_HINTS['nano-banana'], run: c => fire('sailor:applyEffect', { nodeId: c.nodeId, nodeType: 'EditImageNode', output: 'IMAGE', widgetOverrides: { model: 'Nano Banana 2' } }) },
  { id: 'enhance-detail', label: 'Enhance detail', group: 'edit', ai: true, lands: 'step', priceHint: ACTION_HINTS.enhance, run: c => splice(c, 'EnhanceDetailNode', { focus: true, branch: true }) },
  { id: 'upscale', label: 'Upscale', group: 'edit', ai: true, lands: 'step', priceHint: ACTION_HINTS.upscale, run: c => splice(c, 'UpscaleImageNode', { run: true, branch: true }) },
  { id: 'relight', label: 'Relight', group: 'edit', ai: true, lands: 'step', priceHint: ACTION_HINTS.relight, run: c => splice(c, 'RelightNode', { focus: true, branch: true }) },
  { id: 'variations', label: 'Variations', group: 'develop', ai: true, lands: 'takes', enabled: c => c.hasUpstream, run: c => fire('sailor:promptKind', { kind: 'tweak', nodeId: c.nodeId, fromMenu: true }) },
  { id: 'restyle', label: 'Restyle…', group: 'develop', ai: true, lands: 'step', priceNodeType: 'RestyleWithLoRANode', run: c => splice(c, 'RestyleWithLoRANode', { focus: true, branch: true }) },
  { id: 'reframe', label: 'Reframe', group: 'develop', ai: true, lands: 'step', priceHint: ACTION_HINTS.lens, run: c => splice(c, 'LensReframe', { focus: true, branch: true }) },
  { id: 'animate', label: 'Animate', group: 'develop', ai: true, lands: 'step', priceHint: ACTION_HINTS.animate, run: c => fire('sailor:animateArtifact', { nodeId: c.nodeId }) },
]

const VIDEO: NodeAction[] = [
  { id: 'lipsync', label: 'Sync lips', group: 'edit', ai: true, lands: 'step', priceNodeType: 'LipsyncNode', run: c => branchAction(c, 'LipsyncNode', 'VIDEO') },
  { id: 'enhance-video', label: 'Enhance', group: 'edit', ai: true, lands: 'step', priceNodeType: 'EnhanceVideoNode', run: c => branchAction(c, 'EnhanceVideoNode', 'VIDEO') },
  { id: 'describe-video', label: 'Describe', group: 'develop', ai: true, lands: 'step', priceNodeType: 'DescribeVideoNode', run: c => branchAction(c, 'DescribeVideoNode', 'VIDEO') },
  { id: 'all-video', label: 'All actions…', group: 'develop', ai: false, lands: null, run: () => fire('sailor:openActions', { domain: 'video' }) },
]

const AUDIO: NodeAction[] = [
  { id: 'transcribe', label: 'Transcribe', group: 'develop', ai: true, lands: 'step', priceNodeType: 'TranscribeAudioNode', run: c => branchAction(c, 'TranscribeAudioNode', 'AUDIO') },
  { id: 'speakers', label: 'Speakers', group: 'develop', ai: true, lands: 'step', priceNodeType: 'IdentifySpeakersNode', run: c => branchAction(c, 'IdentifySpeakersNode', 'AUDIO') },
  { id: 'all-audio', label: 'All actions…', group: 'develop', ai: false, lands: null, run: () => fire('sailor:openActions', { domain: 'audio' }) },
]

const TUNE: NodeAction = {
  id: 'tune', label: 'Tune…', group: 'edit', ai: true, lands: null,
  // Needs words: puts a "Tune" chip in the prompt and focuses it (spec §1.2).
  run: c => fire('sailor:promptMode', { label: 'Tune', kind: 'tweak', nodeId: c.nodeId }),
}

/** Remix / New effect cost (spec §7.2 estimate), shown like every other fixed priceHint. */
export const SHADER_GEN_ACTION_HINT = shaderGenEstimateText(false)
// Both need words: each puts a chip in the prompt (the chip decides the kind, so
// no router call) and the three effect takes land above it (spec §7.3).
const effectMode = (c: NodeActionCtx, label: string) => fire('sailor:promptMode', { label, kind: 'new-effect', nodeId: c.nodeId })
const SHADER: NodeAction[] = [
  { id: 'remix-effect', label: 'Remix…', group: 'develop', ai: true, lands: 'takes', priceHint: SHADER_GEN_ACTION_HINT, run: c => effectMode(c, 'Remix') },
  { id: 'new-effect', label: 'New effect…', group: 'develop', ai: true, lands: 'takes', priceHint: SHADER_GEN_ACTION_HINT, run: c => effectMode(c, 'New effect') },
]

/** Studio nodes the planner can change in place (tuneNode) — where Tune… has a worker. */
export const TUNABLE_TYPES = new Set(['artifact-frame', 'gradient-studio', 'shader-studio', 'texture-studio', 'shape-studio', 'vector-type', 'scene3d-studio'])

function listFor(type: string): NodeAction[] {
  if (type === 'artifact-image') return IMAGE
  if (type === 'artifact-video') return VIDEO
  if (type === 'artifact-audio') return AUDIO
  if (type === 'shader-effect') return SHADER
  if (TUNABLE_TYPES.has(type)) return [FIX, TUNE]
  return [FIX]
}

/** Actions for one node, split by group. Items whose `enabled` is false stay listed (shown disabled) except Fix on a node with no images, which is hidden. */
export function actionsFor(c: NodeActionCtx): { edit: NodeAction[]; develop: NodeAction[] } {
  const list = listFor(c.type).filter(a => a !== FIX || c.hasImages || c.type === 'artifact-image')
  return { edit: list.filter(a => a.group === 'edit'), develop: list.filter(a => a.group === 'develop') }
}
