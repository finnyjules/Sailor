// Pure: what a start-modal pick puts on the canvas (spec 2026-09-23, "What each
// pick puts on the canvas"). Every project gets a Frame (key 'frame'); the pick
// sits to its left and, where it makes a picture, is wired into layer1.
// VueNodeCanvas.materializeStart executes the plan with createNodeData.
import type { StartPickId } from '~/data/start-modal'

export type PlanKey = string
export interface PlanNode { key: PlanKey; nodeType: string; col: number; widgets?: Record<string, unknown>; starter?: 'shaderPicture' | 'scene3dObject' | 'shaderEffect' }
/** `input` is an input NAME on the target, or '@IMAGE' for its first IMAGE input. */
export interface PlanEdge { from: PlanKey; out: number; to: PlanKey; input: string }
export interface StartPlan { nodes: PlanNode[]; edges: PlanEdge[] }

const SINGLE: Partial<Record<StartPickId, string>> = {
  gen: 'GenerateImageNode',
  style: 'FluxLoRARemoteNode',
  upscale: 'UpscaleImageNode',
  gradient: 'GradientStudio',
  pattern: 'TextureStudio',
  shape: 'ShapeStudio',
  vectortype: 'VectorType',
  expressive: 'SpaceType',
  scene3d: 'Scene3DStudio',
}

const intoFrame = (from: PlanKey): PlanEdge => ({ from, out: 0, to: 'frame', input: 'layer1' })

export function planStart(pick: StartPickId | null): StartPlan {
  if (pick === null) return { nodes: [{ key: 'frame', nodeType: 'Compositor', col: 0 }], edges: [] }

  const single = SINGLE[pick]
  if (single) {
    const a: PlanNode = { key: 'a', nodeType: single, col: 0 }
    if (pick === 'scene3d') a.starter = 'scene3dObject'
    return { nodes: [a, { key: 'frame', nodeType: 'Compositor', col: 1 }], edges: [intoFrame('a')] }
  }

  switch (pick) {
    case 'edit':
      return {
        nodes: [
          { key: 'src', nodeType: 'Image', col: 0 },
          { key: 'a', nodeType: 'EditImageNode', col: 1 },
          { key: 'frame', nodeType: 'Compositor', col: 2 },
        ],
        edges: [{ from: 'src', out: 0, to: 'a', input: '@IMAGE' }, intoFrame('a')],
      }
    case 'shader':
      return {
        nodes: [
          { key: 'src', nodeType: 'Image', col: 0, starter: 'shaderPicture' },
          { key: 'a', nodeType: 'ShaderStudio', col: 1, starter: 'shaderEffect' },
          { key: 'frame', nodeType: 'Compositor', col: 2 },
        ],
        edges: [{ from: 'src', out: 0, to: 'a', input: 'image' }, intoFrame('a')],
      }
    case 'moodboard':
      return {
        nodes: [
          { key: 'src', nodeType: 'Moodboard', col: 0 },
          { key: 'a', nodeType: 'GenerateImageNode', col: 1 },
          { key: 'frame', nodeType: 'Compositor', col: 2 },
        ],
        edges: [{ from: 'src', out: 0, to: 'a', input: 'style_in' }, intoFrame('a')],
      }
    case 'video':
      // The Frame has no video input — the video plays on its own node.
      return {
        nodes: [
          { key: 'a', nodeType: 'GenerateVideoNode', col: 0 },
          { key: 'frame', nodeType: 'Compositor', col: 1 },
        ],
        edges: [],
      }
  }
  return { nodes: [{ key: 'frame', nodeType: 'Compositor', col: 0 }], edges: [] }
}
