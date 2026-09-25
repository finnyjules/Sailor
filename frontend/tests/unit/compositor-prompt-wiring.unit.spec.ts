// Stage 4 wiring guard for Frame (spec §2.4, §2.5): the one prompt replaces the
// pill, stays in Motion mode, and the agent no longer takes over the right panel.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const s = readFileSync(fileURLToPath(new URL('../../app/components/vue-canvas/CompositorModal.vue', import.meta.url)), 'utf8')

describe('Frame’s prompt', () => {
  it('is the one prompt, not AgentBar, and has no pill', () => {
    expect(s).toContain('<StudioPromptHost')
    expect(s).not.toMatch(/import AgentBar|<AgentBar/)
    expect(s).not.toContain('compositor-prompt-pill')
    expect(s).not.toMatch(/promptExpanded/)
  })
  it('the agent no longer takes over the right panel', () => {
    expect(s).not.toMatch(/caPanelActive|<AgentProposal|<AgentProgress/)
  })
  it('the prompt is outside the motion v-if; only the tool bar is hidden in Motion', () => {
    const dock = s.indexOf('data-testid="compositor-prompt-dock"')
    const toolbar = s.indexOf('data-testid="compositor-toolbar"')
    expect(dock).toBeGreaterThan(-1)
    expect(toolbar).toBeGreaterThan(dock) // prompt first, then the bar
    expect(s.slice(Math.max(0, dock - 300), dock)).not.toContain("inspectorTab !== 'motion'")
    expect(s.slice(Math.max(0, toolbar - 200), toolbar)).toContain("inspectorTab !== 'motion'")
  })
  it('the chip quotes the layer, and the inspector lists actions', () => {
    expect(s).toContain('frameSelectionLabel(')
    expect(s).toContain('<StudioActionRows')
    expect(s).toContain("place: 'frame'")
  })
})
