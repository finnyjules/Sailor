// @vitest-environment happy-dom
/**
 * StudioActionsFooter's Cancel button must not slide sideways while an export runs.
 *
 * The status text ("Rendering 1/120", "Rendering 2/120"…) changes width on every frame.
 * When it renders BEFORE the utility buttons in the flex row, each width change shifts
 * the buttons — a Cancel button a user is trying to click moves out from under the
 * pointer. Fix: render the utility buttons first, and give the status text
 * `tabular-nums` so digit-only text doesn't itself wobble.
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import StudioActionsFooter from '~/components/vue-canvas/studio/StudioActionsFooter.vue'

describe('StudioActionsFooter — Cancel button stability', () => {
  it('renders the Cancel button before the status text, in document order', () => {
    const onClick = vi.fn()
    const w = mount(StudioActionsFooter, {
      props: { spec: { status: { notice: 'Rendering 12/120' }, utilities: [{ label: 'Cancel', onClick }] } },
    })
    const button = w.find('button')
    const status = w.find('p')
    expect(button.exists()).toBe(true)
    expect(status.exists()).toBe(true)
    // DOCUMENT_POSITION_FOLLOWING (4) on `status` relative to `button` means button comes first.
    // eslint-disable-next-line no-bitwise
    const position = button.element.compareDocumentPosition(status.element)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('gives the status paragraph tabular-nums so digit changes do not reflow its width', () => {
    const w = mount(StudioActionsFooter, {
      props: { spec: { status: { notice: 'Rendering 12/120' }, utilities: [{ label: 'Cancel', onClick: () => {} }] } },
    })
    const status = w.find('p')
    expect(status.classes()).toContain('tabular-nums')
  })

  it('still fires the utility onClick handler', async () => {
    const onClick = vi.fn()
    const w = mount(StudioActionsFooter, {
      props: { spec: { status: { notice: 'Rendering 12/120' }, utilities: [{ label: 'Cancel', onClick }] } },
    })
    await w.find('button').trigger('click')
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

// `stacked` (the Frame editor's narrow side panel) and `testId`. Without `stacked`, the two
// groups are `display: contents`, so every other studio still gets its one flex row.
describe('StudioActionsFooter — stacked and testId', () => {
  const spec = {
    status: { notice: 'Rendering 3/90' },
    utilities: [{ label: 'Cancel', onClick: () => {}, testId: 'u-cancel' }],
    downloads: [{ label: 'Download PNG', onClick: () => {}, testId: 'd-png' }],
    canvas: [{ label: 'As image', onClick: () => {} }],
  }
  it('without stacked: one row, both groups display: contents, the spacer before Download', () => {
    const w = mount(StudioActionsFooter, { props: { spec } })
    expect(w.classes()).toContain('items-center')
    expect(w.classes()).not.toContain('flex-col')
    const groups = w.findAll(':scope > div')
    expect(groups.map(g => g.classes())).toEqual([['contents'], ['contents']])
    expect(w.find('span.flex-1').exists()).toBe(true)
  })
  it('stacked: status on its own line, menus spread edge to edge, Download opens rightwards', async () => {
    const w = mount(StudioActionsFooter, { props: { spec, stacked: true } })
    expect(w.classes()).toContain('flex-col')
    const [statusRow, menuRow] = w.findAll(':scope > div')
    expect(statusRow!.find('p').text()).toBe('Rendering 3/90')
    expect(menuRow!.classes()).toContain('justify-between')
    expect(w.find('span.flex-1').exists()).toBe(false)
    await menuRow!.findAll('button')[0]!.trigger('click')
    expect(w.find('.bottom-full').classes()).toContain('left-0')
  })
  it('puts testId on a utility button and on a menu row', async () => {
    const w = mount(StudioActionsFooter, { props: { spec } })
    expect(w.find('[data-testid="u-cancel"]').exists()).toBe(true)
    const downloadTrigger = w.findAll('button').find(b => b.text().startsWith('Download'))!
    await downloadTrigger.trigger('click')
    expect(w.find('[data-testid="d-png"]').text()).toContain('Download PNG')
  })
})
