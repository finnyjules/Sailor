// frontend/tests/unit/studio-actions.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { REMIX_ACTION, runStudioAction, studioActions } from '~/lib/studio/studioActions'
import StudioActionRows from '~/components/vue-canvas/studio/StudioActionRows.vue'

const ids = (a: { id: string }[]) => a.map(x => x.id)

describe('studioActions', () => {
  it('every studio with a worker can Tune; Vary only where there are takes', () => {
    expect(ids(studioActions({ place: 'gradient', canTakes: true }))).toEqual(['tune', 'vary'])
    expect(ids(studioActions({ place: 'texture', canTakes: false }))).toEqual(['tune'])
  })
  it('Shader adds a new layer from a description (Remix lives in the head)', () => {
    expect(ids(studioActions({ place: 'shader', canTakes: true }))).toEqual(['tune', 'vary', 'new-layer'])
  })
  it('Frame adds Write copy', () => {
    expect(ids(studioActions({ place: 'frame', canTakes: false }))).toEqual(['tune', 'write-copy'])
  })
  it('local rows join their group, after the AI rows of that group', () => {
    const reroll = { id: 'reroll', label: 'Re-roll', group: 'develop' as const, ai: false, lands: null, run: { call: vi.fn() } }
    const out = studioActions({ place: 'shape', canTakes: true, local: [reroll] })
    expect(ids(out)).toEqual(['tune', 'vary', 'reroll'])
  })
  it('the landing hint says 3 takes only where takes exist', () => {
    const [tuneT] = studioActions({ place: 'gradient', canTakes: true })
    const [tuneP] = studioActions({ place: 'texture', canTakes: false })
    expect(tuneT!.lands).toBe('takes')
    expect(tuneP!.lands).toBeNull()
  })
  it('labels are sentence case, with no identifiers', () => {
    for (const a of studioActions({ place: 'shader', canTakes: true })) {
      expect(a.label).toMatch(/^[A-Z]/)
      expect(a.label).not.toMatch(/tweak|new-effect|_/)
    }
  })
  it('runs: a mode chip, a kind, or the surface’s own call', () => {
    const p = { setMode: vi.fn(), runKind: vi.fn() }
    const [tune, vary, newLayer] = studioActions({ place: 'shader', canTakes: true })
    runStudioAction(tune!, p); expect(p.setMode).toHaveBeenCalledWith('Tune')
    runStudioAction(vary!, p); expect(p.runKind).toHaveBeenCalledWith('tweak', { fromMenu: true })
    runStudioAction(newLayer!, p); expect(p.setMode).toHaveBeenLastCalledWith('New effect')
    const call = vi.fn()
    runStudioAction({ id: 'x', label: 'X', group: 'develop', ai: false, lands: null, run: { call } }, null)
    expect(call).toHaveBeenCalled()
  })
})

describe('StudioActionRows', () => {
  it('renders Edit then Develop, light rows with the ✦ and hint on AI rows only', () => {
    const prompt = { setMode: vi.fn(), runKind: vi.fn() } as any
    const local = [{ id: 'reroll', label: 'Re-roll', group: 'develop' as const, ai: false, lands: null, run: { call: vi.fn() } }]
    const w = mount(StudioActionRows, { props: { actions: studioActions({ place: 'shape', canTakes: true, local }), prompt } })
    expect(w.findAll('h4').map(h => h.text())).toEqual(['Edit', 'Develop'])
    const rows = w.findAll('[data-testid="studio-action-row"]')
    expect(rows.map(r => r.attributes('data-action-id'))).toEqual(['tune', 'vary', 'reroll'])
    expect(rows[1]!.text()).toContain('3 takes')
    expect(rows[1]!.findComponent({ name: 'AiMark' }).exists()).toBe(true)
    expect(rows[2]!.findComponent({ name: 'AiMark' }).exists()).toBe(false)
  })
  it('bare: one row, no headings (Remix in Shader’s head)', () => {
    const w = mount(StudioActionRows, { props: { actions: [REMIX_ACTION], bare: true, prompt: { setMode: vi.fn(), runKind: vi.fn() } as any } })
    expect(w.findAll('h4')).toHaveLength(0)
    expect(w.find('[data-action-id="remix"]').text()).toContain('Remix…')
  })
  it('a click runs the action through the prompt', async () => {
    const prompt = { setMode: vi.fn(), runKind: vi.fn() } as any
    const w = mount(StudioActionRows, { props: { actions: studioActions({ place: 'gradient', canTakes: true }), prompt } })
    await w.find('[data-action-id="tune"]').trigger('click')
    expect(prompt.setMode).toHaveBeenCalledWith('Tune')
  })
})
