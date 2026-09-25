import { describe, it, expect } from 'vitest'
import { paidProducerFor } from '~/lib/artifact/nextSteps'
import { parseReviewResponse, buildResultReviewPrompt, RESULT_REVIEW_SYSTEM } from '~/lib/agent/protocol'
import { scopeSnapshotToUpstream, type CanvasSnapshot } from '~/lib/agent/surfaces/canvas'
import { useNextStepsStrip } from '~/composables/useNextStepsStrip'

describe('paidProducerFor', () => {
  const paid = { id: 'g1', data: { priceBadge: { expr: '0.03' } } }
  const free = { id: 'g2', data: {} }
  const artifact = { id: 'a1', data: {} }
  it('true when a direct upstream source carries a price badge', () => {
    expect(paidProducerFor('a1', [paid, artifact], [{ source: 'g1', target: 'a1' }])).toBe(true)
  })
  it('false for a free producer', () => {
    expect(paidProducerFor('a1', [free, artifact], [{ source: 'g2', target: 'a1' }])).toBe(false)
  })
  it('false with no upstream at all (uploaded image)', () => {
    expect(paidProducerFor('a1', [artifact], [])).toBe(false)
  })
  it('true when ANY of several inputs is paid', () => {
    expect(paidProducerFor('a1', [paid, free, artifact], [
      { source: 'g2', target: 'a1' }, { source: 'g1', target: 'a1' },
    ])).toBe(true)
  })
})

describe('parseReviewResponse fixLabels', () => {
  it('extracts a label per fix, aligned with fixes', () => {
    const res = parseReviewResponse(JSON.stringify({
      assessment: 'has defects',
      issues: ['left hand is malformed'],
      fixes: [{ op: 'addNode', args: '{}', rationale: 'repair anatomy', label: 'Fix hands' }],
    }))
    expect(res.fixes).toHaveLength(1)
    expect(res.fixLabels).toEqual(['Fix hands'])
  })
  it('missing label yields empty string (caller falls back to rationale)', () => {
    const res = parseReviewResponse(JSON.stringify({
      assessment: '', issues: [], fixes: [{ op: 'setWidget', args: '{}' }],
    }))
    expect(res.fixLabels).toEqual([''])
  })
})

describe('useNextStepsStrip fixes channel', () => {
  const chip = { id: 0, label: 'Fix hands', hint: '~$0.12', apply: () => {} }
  it('announceFixes publishes; clearFixes(nodeId) clears only that node', () => {
    const s = useNextStepsStrip()
    s.clearFixes()
    s.announceFixes('n1', [chip])
    expect(s.fixesFor('n1')).toEqual([chip])
    s.clearFixes('other') // wrong node — no-op
    expect(s.fixesFor('n1')).toEqual([chip])
    s.clearFixes('n1')
    expect(s.fixesFor('n1')).toEqual([])
  })
  it('a fresh take on the same node clears stale fixes', () => {
    const s = useNextStepsStrip()
    s.clearFixes()
    s.announceFixes('n1', [chip])
    s.announceFreshTake('n1')
    expect(s.fixesFor('n1')).toEqual([])
  })
  it('a fresh take on ANOTHER node leaves fixes alone', () => {
    const s = useNextStepsStrip()
    s.clearFixes()
    s.announceFixes('n1', [chip])
    s.announceFreshTake('n2')
    expect(s.fixesFor('n1')).toEqual([chip])
  })
})

// ── Review-cost optimizations ────────────────────────────────────────────────

const snapNode = (id: string) => ({
  id, nodeType: 'X', title: id, widgets: {}, inputs: [], outputs: [],
}) as unknown as CanvasSnapshot['nodes'][number]

describe('scopeSnapshotToUpstream', () => {
  const snap: CanvasSnapshot = {
    nodes: ['gen', 'artifact', 'other', 'downstream'].map(snapNode),
    edges: [
      { source: 'gen', target: 'artifact' },
      { source: 'artifact', target: 'downstream' },
      { source: 'other', target: 'downstream' },
    ],
    catalog: [{ type: 'EditImageNode' } as never],
  }
  it('keeps the target + upstream, drops siblings and downstream', () => {
    const scoped = scopeSnapshotToUpstream(snap, 'artifact')
    expect(scoped.nodes.map(n => n.id).sort()).toEqual(['artifact', 'gen'])
    expect(scoped.edges).toEqual([{ source: 'gen', target: 'artifact' }])
  })
  it('preserves the catalog so fixes can still add palette nodes', () => {
    expect(scopeSnapshotToUpstream(snap, 'artifact').catalog).toBe(snap.catalog)
  })
  it('unknown target returns the snapshot unchanged', () => {
    expect(scopeSnapshotToUpstream(snap, 'nope')).toBe(snap)
  })
})

describe('review prompt split (prompt caching)', () => {
  it('the static system half contains the instruction and no dynamic content', () => {
    expect(RESULT_REVIEW_SYSTEM).toContain('ATTACHED IMAGE')
    expect(RESULT_REVIEW_SYSTEM).toContain('Return JSON')
    expect(RESULT_REVIEW_SYSTEM).not.toContain('${') // no accidental un-interpolated template
  })
  it('the dynamic half carries intent + nodes and none of the instruction', () => {
    const desc = { objects: [{ id: 'n1', label: 'Gen', type: 'node', current: null }], commands: [{ op: 'setWidget', hint: 'h' }] }
    const p = buildResultReviewPrompt(desc as never, 'a cat on a mat')
    expect(p).toContain('a cat on a mat')
    expect(p).toContain('n1')
    expect(p).not.toContain('ATTACHED IMAGE') // instruction must stay in the cached system half
  })
})
