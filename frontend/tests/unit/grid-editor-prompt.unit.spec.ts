import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../app/components/${rel}`, import.meta.url)), 'utf8')
const s = read('templates/GridEditorShell.vue')
const modal = read('vue-canvas/SmartLayoutEditorModal.vue')

describe('template editor prompt', () => {
  it('is the one prompt, in the bottom cluster above the tools', () => {
    expect(s).toContain('<StudioPromptHost')
    expect(s).not.toMatch(/import AgentBar|<AgentBar|<AgentProposal|<AgentProgress|agentPanelActive/)
    const host = s.indexOf('<StudioPromptHost')
    const toolsRow = s.indexOf("@click=\"ctx.editorMode.value = 'layout'\"", host)
    expect(host).toBeGreaterThan(-1)
    expect(toolsRow).toBeGreaterThan(host)
  })
  it('routes as a template (copy and layout go to its agent)', () => {
    expect(s).toContain("place: 'template'")
  })
  it('the chip is Frame’s chip (same quoting and cut)', () => {
    expect(s).toMatch(/frameSelectionLabel\(\[/)
  })
  it('Esc the prompt used (chip cleared, field left) does not close the editor', () => {
    const onKey = modal.slice(modal.indexOf('function onKey('))
    expect(onKey.length).toBeGreaterThan(0)
    const body = onKey.slice(0, onKey.indexOf('\n}'))
    expect(body).toMatch(/if \(e\.defaultPrevented\) return/)
    expect(body.indexOf('defaultPrevented')).toBeLessThan(body.indexOf("emit('close')"))
  })
  it('while the prompt works (or a stopped reply is due) the template can’t be edited', () => {
    // The reply restores the pre-request template (useLayoutAgent), so edits
    // made meanwhile would be lost: canvas, both panels, the tools and undo go inert.
    const inert = s.match(/:inert="templatePrompt\.editLocked\.value"/g) ?? []
    expect(inert.length).toBeGreaterThanOrEqual(5)
    for (const id of ['template-edit-surface', 'template-inspector']) {
      const at = s.indexOf(`data-testid="${id}"`)
      expect(at, id).toBeGreaterThan(-1)
      expect(s.slice(at, s.indexOf('>', at)), id).toContain(':inert="templatePrompt.editLocked.value"')
    }
    expect(s).toContain('templatePrompt.lockedNote.value')
    // the name field is part of the template the snapshot restores
    const name = s.indexOf(':value="template.name"')
    expect(name).toBeGreaterThan(-1)
    expect(s.slice(name, s.indexOf('>', name))).toContain(':disabled="templatePrompt.editLocked.value"')
    // keyboard edits are held too
    expect(s).toMatch(/if \(templatePrompt\.editLocked\.value\) return/)
    // the prompt itself stays live (it holds Stop), so it is not inside an inert box
    const host = s.indexOf('<StudioPromptHost')
    const cluster = s.lastIndexOf('<div', s.lastIndexOf('<div', host) - 1)
    expect(s.slice(cluster, host)).not.toContain(':inert=')
  })
})
