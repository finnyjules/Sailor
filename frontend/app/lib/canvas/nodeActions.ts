// The node toolbar's actions (spec §1.4, §2.3): one registry, grouped by intent.
// Edit = the same thing, better. Develop = take it somewhere new. Each run()
// fires exactly the window event the old per-node menus fired, so the canvas
// handlers are unchanged. `lands` is the grey hint: '3 takes' on this node, or
// 'adds a step' (a new node after it); null for actions that open an editor.

export type ActionGroup = 'edit' | 'develop'
export type ActionLands = 'takes' | 'step' | null
export interface NodeActionCtx { nodeId: string; type: string; hasImages: boolean; hasUpstream: boolean }
export interface NodeAction { id: string; label: string; group: ActionGroup; ai: boolean; lands: ActionLands; enabled?: (c: NodeActionCtx) => boolean; run: (c: NodeActionCtx) => void }

export function landsHint(l: ActionLands): string | null {
  return l === 'takes' ? '3 takes' : l === 'step' ? 'adds a step' : null
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
  { id: 'nano-banana', label: 'Edit with Nano Banana', group: 'edit', ai: true, lands: 'step', run: c => fire('sailor:applyEffect', { nodeId: c.nodeId, nodeType: 'EditImageNode', output: 'IMAGE', widgetOverrides: { model: 'Nano Banana 2' } }) },
  { id: 'enhance-detail', label: 'Enhance detail', group: 'edit', ai: true, lands: 'step', run: c => splice(c, 'EnhanceDetailNode', { focus: true, branch: true }) },
  { id: 'upscale', label: 'Upscale', group: 'edit', ai: true, lands: 'step', run: c => splice(c, 'UpscaleImageNode', { run: true, branch: true }) },
  { id: 'relight', label: 'Relight', group: 'edit', ai: true, lands: 'step', run: c => splice(c, 'RelightNode', { focus: true, branch: true }) },
  { id: 'variations', label: 'Variations', group: 'develop', ai: true, lands: 'takes', enabled: c => c.hasUpstream, run: c => fire('sailor:runVariations', { nodeId: c.nodeId, count: 3 }) },
  { id: 'restyle', label: 'Restyle…', group: 'develop', ai: true, lands: 'step', run: c => splice(c, 'RestyleWithLoRANode', { focus: true, branch: true }) },
  { id: 'reframe', label: 'Reframe', group: 'develop', ai: true, lands: 'step', run: c => splice(c, 'LensReframe', { focus: true, branch: true }) },
  { id: 'animate', label: 'Animate', group: 'develop', ai: true, lands: 'step', run: c => fire('sailor:animateArtifact', { nodeId: c.nodeId }) },
]

const VIDEO: NodeAction[] = [
  { id: 'lipsync', label: 'Sync lips', group: 'edit', ai: true, lands: 'step', run: c => branchAction(c, 'LipsyncNode', 'VIDEO') },
  { id: 'enhance-video', label: 'Enhance', group: 'edit', ai: true, lands: 'step', run: c => branchAction(c, 'EnhanceVideoNode', 'VIDEO') },
  { id: 'describe-video', label: 'Describe', group: 'develop', ai: true, lands: 'step', run: c => branchAction(c, 'DescribeVideoNode', 'VIDEO') },
  { id: 'all-video', label: 'All actions…', group: 'develop', ai: false, lands: null, run: () => fire('sailor:openActions', { domain: 'video' }) },
]

const AUDIO: NodeAction[] = [
  { id: 'transcribe', label: 'Transcribe', group: 'develop', ai: true, lands: 'step', run: c => branchAction(c, 'TranscribeAudioNode', 'AUDIO') },
  { id: 'speakers', label: 'Speakers', group: 'develop', ai: true, lands: 'step', run: c => branchAction(c, 'IdentifySpeakersNode', 'AUDIO') },
  { id: 'all-audio', label: 'All actions…', group: 'develop', ai: false, lands: null, run: () => fire('sailor:openActions', { domain: 'audio' }) },
]

function listFor(type: string): NodeAction[] {
  if (type === 'artifact-image') return IMAGE
  if (type === 'artifact-video') return VIDEO
  if (type === 'artifact-audio') return AUDIO
  return [FIX]
}

/** Actions for one node, split by group. Items whose `enabled` is false stay listed (shown disabled) except Fix on a node with no images, which is hidden. */
export function actionsFor(c: NodeActionCtx): { edit: NodeAction[]; develop: NodeAction[] } {
  const list = listFor(c.type).filter(a => a !== FIX || c.hasImages || c.type === 'artifact-image')
  return { edit: list.filter(a => a.group === 'edit'), develop: list.filter(a => a.group === 'develop') }
}
