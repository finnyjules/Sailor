// Which canvas worker runs a routed request (spec §4; plan rulings 6 and 17).
// The canvas has five today: the planner (useCanvasAgent.ask), Variations
// (three takes), the review (Fix), new effects on a shader effect node (three
// effect takes, stage 5), or a plain message when nothing fits the selection.
import type { RouterKind } from '~~/shared/promptRouter/router'

export interface DispatchTarget { nodeId: string; type: string; hasImages: boolean; hasUpstream: boolean; label: string }
export type CanvasDispatch =
  | { worker: 'ask' }
  | { worker: 'variations'; nodeId: string }
  | { worker: 'fix'; nodeId: string }
  | { worker: 'effect'; nodeId: string }
  | { worker: 'message'; message: string }

/** Node types whose text and layout the planner can change in place (tuneNode). */
export const FRAME_TYPES = new Set(['artifact-frame'])
/** Node types that hold one shader effect — where new effects are written (stage 5). */
export const SHADER_NODE_TYPES = new Set(['shader-effect'])

export const DISPATCH_MESSAGES = {
  newEffect: 'New effects are made on a shader effect. Select a shader effect node, or open the Shader studio.',
  copy: 'Select a Frame to write its copy.',
  layout: 'Select a Frame to try other layouts.',
  noImageToVary: 'Select an image made on this canvas to get three takes.',
  nothingToFix: 'Select a node with a result to fix it.',
} as const

const PLAIN_VARY = /^(?:vary(?: it| this)?|variations?|more(?: like this)?|another(?: one| take)?|other versions|(?:some |a few )?options|three more|re-?roll(?: it)?|try again)[.!]?$/i

/** Empty, or a request that only asks for other versions (no specific change). */
export function isPlainVaryRequest(text: string): boolean {
  const t = text.trim()
  return !t || PLAIN_VARY.test(t)
}

export function canvasDispatch(kind: RouterKind, text: string, target: DispatchTarget | null, o: { fromMenu?: boolean } = {}): CanvasDispatch {
  const hasText = !!text.trim()
  switch (kind) {
    case 'tweak': {
      const canVary = !!target && target.type === 'artifact-image' && (target.hasUpstream || !!o.fromMenu)
      if (canVary && isPlainVaryRequest(text)) return { worker: 'variations', nodeId: target!.nodeId }
      return hasText ? { worker: 'ask' } : { worker: 'message', message: DISPATCH_MESSAGES.noImageToVary }
    }
    case 'fix':
      if (target?.hasImages) return { worker: 'fix', nodeId: target.nodeId }
      return hasText ? { worker: 'ask' } : { worker: 'message', message: DISPATCH_MESSAGES.nothingToFix }
    case 'copy':
    case 'layout':
      if (target && FRAME_TYPES.has(target.type)) return { worker: 'ask' }
      return { worker: 'message', message: kind === 'copy' ? DISPATCH_MESSAGES.copy : DISPATCH_MESSAGES.layout }
    case 'new-effect':
      if (target && SHADER_NODE_TYPES.has(target.type)) return { worker: 'effect', nodeId: target.nodeId }
      return { worker: 'message', message: DISPATCH_MESSAGES.newEffect }
    default:
      return { worker: 'ask' }
  }
}
