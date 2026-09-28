// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import StudioRenderButton from '~/components/vue-canvas/StudioRenderButton.vue'

enableAutoUnmount(afterEach)

describe('StudioRenderButton', () => {
  it('is the white node button, like the generator Run', () => {
    const w = mount(StudioRenderButton, { props: { nodeId: '7' } })
    const main = w.find('[data-studio-render] button')
    expect(main.classes()).toEqual(expect.arrayContaining(['node-btn', 'node-btn--primary']))
    expect(main.text()).toContain('Render')
  })
  it('clicking Render fires a downstream render for this node', async () => {
    const spy = vi.fn()
    window.addEventListener('sailor:studioRender', spy as any)
    const w = mount(StudioRenderButton, { props: { nodeId: '7' } })
    await w.find('.node-btn--primary').trigger('click')
    expect((spy.mock.calls[0]![0] as CustomEvent).detail).toEqual({ sourceNodeId: '7', scope: 'downstream' })
    window.removeEventListener('sailor:studioRender', spy as any)
  })
  it('the caret opens the three scopes', async () => {
    const w = mount(StudioRenderButton, { props: { nodeId: '7' } })
    await w.find('[aria-label="Render scope"]').trigger('click')
    expect(w.text()).toContain('Render this')
    expect(w.text()).toContain('Rebuild from start → here')
    expect(w.text()).toContain('Run from here → end')
  })
  it('busy shows Rendering… and disables both buttons', () => {
    const w = mount(StudioRenderButton, { props: { nodeId: '7', busy: true } })
    expect(w.text()).toContain('Rendering…')
    for (const b of w.findAll('button')) expect(b.attributes('disabled')).toBeDefined()
  })
  it('in ArtifactFrameNode, Render sits at its natural size and Edit fills the row', () => {
    const src = readFileSync(resolve(__dirname, '../../app/components/vue-canvas/ArtifactFrameNode.vue'), 'utf8')
    expect(src).toMatch(/<StudioRenderButton class="shrink-0"/)
  })
})
