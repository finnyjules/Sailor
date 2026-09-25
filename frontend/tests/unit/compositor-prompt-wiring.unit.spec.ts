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
  it('the chip never names a layer by its kind: every layer goes through frameChipLayer', () => {
    expect(s).toMatch(/frameSelectionLabel\(\s*\(selectedLayers\.value \?\? \[\]\)\.map\(\(l: any\) => frameChipLayer\(/)
  })
  it('the layer header names the layer as the chip does, never by its kind', () => {
    expect(s).not.toMatch(/selectedLocal\.kind === 'deal' \? 'Mosaic' : selectedLocal\.kind/)
    const head = s.indexOf('data-testid="frame-layer-head"')
    expect(head).toBeGreaterThan(-1)
    expect(s.slice(head, s.indexOf('</span>', head))).toContain('selectedLayerHead')
    expect(s).toMatch(/const selectedLayerHead = computed\([\s\S]{0,200}frameSelectionLabel\(\[frameChipLayer\(/)
  })
  it('while the prompt works (or a stopped reply is due) the Frame can’t be edited', () => {
    // The reply restores the pre-request Frame (useCompositorAgent), so edits made
    // meanwhile would be lost: both panels, the artboard, the tools go inert.
    const L = ':inert="framePrompt.editLocked.value"'
    for (const id of ['compositor-left-panel', 'compositor-right-panel', 'frame-edit-surface']) {
      const at = s.indexOf(`data-testid="${id}"`)
      expect(at, id).toBeGreaterThan(-1)
      const open = s.lastIndexOf('<div', at)
      expect(s.slice(open, s.indexOf('>', at)), id).toContain(L)
    }
    expect(s).toContain('framePrompt.lockedNote.value')
    expect(s).toMatch(/if \(framePrompt\.editLocked\.value && isViewDragEditKey\(e\)/)
    // the prompt dock (Stop lives there) is never inside an inert box
    const dock = s.indexOf('data-testid="compositor-prompt-dock"')
    const dockTag = s.slice(s.lastIndexOf('<div', dock), s.indexOf('>', dock))
    expect(dockTag).not.toContain(':inert=')
  })
  it('a paste or a dropped file does nothing while the prompt works (or a stopped reply is due)', () => {
    for (const fn of ['async function onModalPaste(', 'async function onCanvasDrop(']) {
      const at = s.indexOf(fn)
      expect(at, fn).toBeGreaterThan(-1)
      const body = s.slice(at, s.indexOf('\n}\n', at))
      const guard = body.search(/if \(framePrompt\.editLocked\.value\)/)
      expect(guard, fn).toBeGreaterThan(-1)
      // before the handler reads the clipboard / the dropped files
      const reads = body.search(/clipboardData|dataTransfer\?\.files/)
      expect(reads, fn).toBeGreaterThan(guard)
    }
  })
})

