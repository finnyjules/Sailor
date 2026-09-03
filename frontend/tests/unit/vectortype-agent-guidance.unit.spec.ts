import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '~/lib/vectortype/config'
import { vtAgentControls } from '~/lib/vectortype/agentControls'
import { VT_GUIDANCE } from '~/lib/vectortype/controls'

describe('smart stretch — agent surface', () => {
  it('the agent sees stretch, height and fit with their hints', () => {
    const keys = vtAgentControls(DEFAULT_CONFIG, []).map(c => c.key)
    expect(keys).toContain('stretch'); expect(keys).toContain('stretchY'); expect(keys).toContain('fit')
  })
  it('guidance teaches the stretch-vs-scale distinction and the single-axis habit', () => {
    expect(VT_GUIDANCE).toMatch(/stretch/i)
    expect(VT_GUIDANCE).toMatch(/scaleX|scale motion|squash/i)
    expect(VT_GUIDANCE).toMatch(/one (dial|axis) at a time|single-axis|one axis/i)
  })
})
