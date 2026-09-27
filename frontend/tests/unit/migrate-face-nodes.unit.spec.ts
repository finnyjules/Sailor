/**
 * Old saved Fix faces (CodeFormer) and Face swap (InsightFace) nodes are
 * rewritten on load, so their positional widgets_values never land on the new
 * inputs (app/lib/graph/migrateFaceNodes.ts, called from useVueNodes' load).
 */
import { describe, expect, it } from 'vitest'
import { migrateFaceNode, migrateFaceNodesWorkflow } from '~/lib/graph/migrateFaceNodes'

describe('old Fix faces nodes', () => {
  it('a CodeFormer node gets the Topaz defaults and keeps its upscale', () => {
    const n = { type: 'FixFacesNode', widgets_values: ['CodeFormer', 0.5, true, true, 3] }
    expect(migrateFaceNode(n)).toBe(true)
    expect(n.widgets_values).toEqual([0.8, 0, 3])
  })

  it('an upscale that is not 1–4 falls back to 2', () => {
    for (const up of [0, 5, 2.5, 'x', undefined]) {
      const n = { type: 'FixFacesNode', widgets_values: ['CodeFormer', 0.5, true, true, up] }
      migrateFaceNode(n)
      expect(n.widgets_values).toEqual([0.8, 0, 2])
    }
  })

  it('a new node is left alone', () => {
    const n = { type: 'FixFacesNode', widgets_values: [0.6, 0.2, 4] }
    expect(migrateFaceNode(n)).toBe(false)
    expect(n.widgets_values).toEqual([0.6, 0.2, 4])
  })
})

describe('old Face swap nodes', () => {
  it('two numbers (face index, threshold) become the new choices', () => {
    const n = { type: 'FaceSwap', widgets_values: [0, 0.5] }
    expect(migrateFaceNode(n)).toBe(true)
    expect(n.widgets_values).toEqual(['Not chosen', 'The picture'])
  })

  it('a new node is left alone', () => {
    const n = { type: 'FaceSwap', widgets_values: ['Female', 'The face photo'] }
    expect(migrateFaceNode(n)).toBe(false)
    expect(n.widgets_values).toEqual(['Female', 'The face photo'])
  })
})

describe('the workflow', () => {
  it('rewrites top-level and subgraph nodes, counting them, and touches nothing else', () => {
    const other = { type: 'KSampler', widgets_values: [0, 0.5] }
    const wf = {
      nodes: [
        { type: 'FixFacesNode', widgets_values: ['CodeFormer', 0.5, true, true, 2] },
        other,
        { type: 'FixFacesNode' },
      ],
    }
    const defs = { subgraphs: [{ nodes: [{ type: 'FaceSwap', widgets_values: [1, 0.7] }] }] }
    expect(migrateFaceNodesWorkflow(wf, defs)).toBe(2)
    expect(wf.nodes[0]!.widgets_values).toEqual([0.8, 0, 2])
    expect(defs.subgraphs[0]!.nodes[0]!.widgets_values).toEqual(['Not chosen', 'The picture'])
    expect(other.widgets_values).toEqual([0, 0.5])
    expect(migrateFaceNodesWorkflow(wf, defs)).toBe(0)
  })
})
