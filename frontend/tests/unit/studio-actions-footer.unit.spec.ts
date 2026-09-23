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
