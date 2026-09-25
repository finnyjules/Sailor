// frontend/tests/unit/run-row-status.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { runRowStatus } from '~/lib/canvas/runRowStatus'

const now = 1_000_000_000
const base = { running: false, hasRun: false, now }

describe('runRowStatus', () => {
  it('running wins', () => expect(runRowStatus({ ...base, running: true, hasRun: true })).toEqual({ tone: 'running', text: 'Running…' }))
  it('an error asks to run again', () => expect(runRowStatus({ ...base, error: true })).toEqual({ tone: 'error', text: 'Failed · run again' }))
  it('live preview nodes say so', () => expect(runRowStatus({ ...base, live: true })).toEqual({ tone: 'live', text: 'Live preview' }))
  it('not run yet shows the cost when known', () => {
    expect(runRowStatus({ ...base, costLabel: '$0.04' })).toEqual({ tone: 'idle', text: 'Not run yet · $0.04' })
    expect(runRowStatus(base)).toEqual({ tone: 'idle', text: 'Not run yet' })
  })
  it('rendered says how long ago', () => {
    expect(runRowStatus({ ...base, hasRun: true, lastRunAt: now - 20_000 }).text).toBe('Rendered just now')
    expect(runRowStatus({ ...base, hasRun: true, lastRunAt: now - 2 * 60_000 }).text).toBe('Rendered 2 min ago')
    expect(runRowStatus({ ...base, hasRun: true, lastRunAt: now - 3 * 3_600_000 }).text).toBe('Rendered 3 h ago')
    expect(runRowStatus({ ...base, hasRun: true, lastRunAt: now - 2 * 86_400_000 }).text).toBe('Rendered 2 d ago')
    expect(runRowStatus({ ...base, hasRun: true })).toEqual({ tone: 'done', text: 'Rendered' })
  })
})
