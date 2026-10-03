import { describe, expect, it } from 'vitest'
import { tallyReplicateUsd } from '~/lib/graph/runCost'

const USD_03 = '{"type":"usd","usd":0.03}'

function replicateNode(id: string, usd = 0.03) {
  return {
    id,
    data: {
      nodeType: 'FluxLoRARemoteNode',
      title: 'Nano Banana',
      priceBadge: { expr: `{"type":"usd","usd":${usd}}` },
      category: null,
    },
  }
}

function freeNode(id: string) {
  return {
    id,
    data: {
      nodeType: 'LoadImage',
      title: 'Load Image',
      priceBadge: null,
      category: 'image',
    },
  }
}

describe('tallyReplicateUsd', () => {
  it('sums only the priced Replicate nodes whose id is in executedNodeIds', () => {
    const allNodes = [replicateNode('1'), freeNode('2')]
    const result = tallyReplicateUsd(new Set(['1', '2']), allNodes)
    expect(result).not.toBeNull()
    expect(result!.usd).toBeCloseTo(0.03)
    expect(result!.approximate).toBe(false)
  })

  it('empty executedNodeIds set returns null', () => {
    const allNodes = [replicateNode('1')]
    expect(tallyReplicateUsd(new Set(), allNodes)).toBeNull()
  })

  it('a set with only free (unbilled) nodes returns null', () => {
    const allNodes = [freeNode('1')]
    expect(tallyReplicateUsd(new Set(['1']), allNodes)).toBeNull()
  })

  it('4 identical Replicate nodes are summed once each (4x)', () => {
    const allNodes = [
      replicateNode('1'),
      replicateNode('2'),
      replicateNode('3'),
      replicateNode('4'),
    ]
    const ids = new Set(['1', '2', '3', '4'])
    const result = tallyReplicateUsd(ids, allNodes)
    expect(result).not.toBeNull()
    expect(result!.usd).toBeCloseTo(0.12)
  })

  it('disjoint run sets tally separately: run A priced, run B free', () => {
    const allNodes = [replicateNode('a1'), freeNode('b1')]
    const setA = new Set(['a1'])
    const setB = new Set(['b1'])
    const resultA = tallyReplicateUsd(setA, allNodes)
    const resultB = tallyReplicateUsd(setB, allNodes)
    expect(resultA).not.toBeNull()
    expect(resultA!.usd).toBeCloseTo(0.03)
    expect(resultB).toBeNull()
  })

  // The N^2 concurrency bug: tallying run A's executed-node set must sum ONLY
  // run A's Replicate nodes, even though `allNodes` (the live canvas) also
  // contains run B's Replicate nodes (from a second concurrent run). Before
  // this fix, a single GLOBAL executedNodeIds set unioned both runs' node ids,
  // so a tally at A's completion double-counted B's nodes too.
  it('does not include another concurrent run\'s Replicate nodes (N^2 bug)', () => {
    const allNodes = [replicateNode('a1', 0.03), replicateNode('b1', 0.03), replicateNode('b2', 0.03), replicateNode('b3', 0.03)]
    const setA = new Set(['a1'])
    const resultA = tallyReplicateUsd(setA, allNodes)
    expect(resultA).not.toBeNull()
    expect(resultA!.usd).toBeCloseTo(0.03) // NOT 0.12 (would be if B's 3 nodes leaked in)
  })

  it('excludes credit-billed (non-Replicate) API nodes, unlike the pre-run estimate', () => {
    const klingNode = {
      id: 'k1',
      data: {
        nodeType: 'KlingTextToVideoNode',
        title: 'Kling',
        priceBadge: { expr: USD_03 },
        category: 'api node/video/Kling',
      },
    }
    const result = tallyReplicateUsd(new Set(['k1']), [klingNode])
    expect(result).toBeNull()
  })
})
