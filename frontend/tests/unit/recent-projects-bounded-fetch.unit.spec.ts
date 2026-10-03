// LC8 (B4): Home read every saved project's generation records at once (~1,500 fetches) and Chromium
// failed hundreds with ERR_INSUFFICIENT_RESOURCES. Now at most 6 are in flight, only the most recently
// saved GENERATIONS_EAGER are read before the list shows, and the rest when their card comes into view.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const N = 200

function stubProjects() {
  let inFlight = 0
  let maxInFlight = 0
  const asked: string[] = []
  const saved: { uuid: string; promptId: string }[] = []
  const projects = Array.from({ length: N }, (_, i) => ({ uuid: `p${i}`, name: `Project ${i}`, updatedAt: 1000 + i, cover: [] }))
  vi.stubGlobal('useProjects', () => ({
    listProjects: async () => projects,
    listGenerations: async (uuid: string) => {
      asked.push(uuid)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 2))
      inFlight--
      return [{ promptId: `run-${uuid}`, ts: 5000, outputs: [{ kind: 'image', filename: `${uuid}.png`, subfolder: '', type: 'output' }] }]
    },
    saveGeneration: async (uuid: string, record: { promptId: string }) => { saved.push({ uuid, promptId: record.promptId }) },
  }))
  return { asked, saved, max: () => maxInFlight }
}

describe('useRecentProjects: bounded generation reads', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reads only the most recently saved first, at most 6 at once; the rest are cards from their covers', async () => {
    const s = stubProjects()
    const { useRecentProjects, GENERATIONS_EAGER, GENERATIONS_CONCURRENCY } = await import('~/composables/useRecentProjects')
    expect(GENERATIONS_CONCURRENCY).toBe(6)
    const r = useRecentProjects()
    await r.fetchRecentProjects()
    expect(s.asked).toHaveLength(GENERATIONS_EAGER)
    expect(s.max()).toBeLessThanOrEqual(GENERATIONS_CONCURRENCY)
    // The most recently saved ones (p199 down).
    expect(new Set(s.asked)).toEqual(new Set(Array.from({ length: GENERATIONS_EAGER }, (_, i) => `p${N - 1 - i}`)))
    expect(r.allProjects.value).toHaveLength(N)
    expect(r.recentProjects.value.every(p => !p.generationsPending && p.runCount === 1)).toBe(true)
    const pending = r.allProjects.value.filter(p => p.generationsPending)
    expect(pending).toHaveLength(N - GENERATIONS_EAGER)
  })

  it('a pending card fills in when asked (each once), still at most 6 at once', async () => {
    const s = stubProjects()
    const { useRecentProjects } = await import('~/composables/useRecentProjects')
    const r = useRecentProjects()
    await r.fetchRecentProjects()
    const ids = r.allProjects.value.filter(p => p.generationsPending).map(p => p.workflowId)
    await Promise.all([...ids, ...ids].map(id => r.ensureGenerations(id)))
    expect(s.asked).toHaveLength(N)
    expect(s.max()).toBeLessThanOrEqual(6)
    const p = r.allProjects.value.find(x => x.workflowId === ids[0])!
    expect(p.generationsPending).toBe(false)
    expect(p.runCount).toBe(1)
    expect(p.images.map(i => i.filename)).toEqual([`${ids[0]}.png`])
  })

  it('a pending card is not a blank one for the cover backfill until its records are read', async () => {
    const { isBackfillCandidate } = await import('~/lib/coverBackfill')
    expect(isBackfillCandidate({ workflowId: 'p1', images: [], generationsPending: true })).toBe(false)
    expect(isBackfillCandidate({ workflowId: 'p1', images: [], generationsPending: false })).toBe(true)
  })
})
