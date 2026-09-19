import { describe, it, expect } from 'vitest'
import { mergeAgentBands } from '~/lib/motionx/adapter/agentBands'

const kf = (t: number, value: number) => ({ t, value, ease: 'linear' as const })
const band = (path: string, v = 1, extra: Record<string, unknown> = {}) => ({ path, type: 'number' as const, keyframes: [kf(0, 0), kf(1, v)], ...extra })
const DIAL = 'layers.L1.effects.e1.amount'

describe('mergeAgentBands — the agent only owns untagged effect-dial bands', () => {
  it('a STALE agent state cannot drop bands or behaviours the user added meanwhile', () => {
    const userBand = band('layers.L1.opacity')
    const behaviourTrack = band('layers.L1.rotation', 360, { behaviourId: 'b1' })
    const current = [userBand, behaviourTrack]
    const staleAgent: ReturnType<typeof band>[] = []          // seeded before the user's edits
    expect(mergeAgentBands(current, staleAgent)).toBe(current) // nothing of the agent's changed → same ref
  })
  it('adds / replaces / removes the agent\'s dial bands and leaves everything else alone', () => {
    const userBand = band('layers.L1.opacity')
    const added = mergeAgentBands([userBand], [band(DIAL, 0.9)])
    expect(added).toEqual([userBand, band(DIAL, 0.9)])
    const replaced = mergeAgentBands(added, [band(DIAL, 0.4)])
    expect(replaced).toEqual([userBand, band(DIAL, 0.4)])
    expect(mergeAgentBands(replaced, [])).toEqual([userBand])  // reject / revert removes it again
  })
  it('ignores non-dial and tagged tracks inside the agent state', () => {
    const current = [band('layers.L1.x', 0.5)]
    const agent = [band('layers.L1.x', 0.1), band(DIAL, 1, { behaviourId: 'bX' })]
    expect(mergeAgentBands(current, agent)).toBe(current)
  })
})
