import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const s = readFileSync(fileURLToPath(new URL('../../app/components/templates/GridEditorShell.vue', import.meta.url)), 'utf8')

describe('template editor prompt', () => {
  it('is the one prompt, in the bottom cluster above the tools', () => {
    expect(s).toContain('<StudioPromptHost')
    expect(s).not.toMatch(/import AgentBar|<AgentBar|<AgentProposal|<AgentProgress|agentPanelActive/)
    const host = s.indexOf('<StudioPromptHost')
    const toolsRow = s.indexOf('Mode toggle', host)
    expect(toolsRow).toBeGreaterThan(host)
  })
  it('routes as a template (copy and layout go to its agent)', () => {
    expect(s).toContain("place: 'template'")
  })
})
