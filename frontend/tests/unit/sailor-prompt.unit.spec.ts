// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SailorPrompt from '~/components/prompt/SailorPrompt.vue'

const stubs = { AgentSweep: true }
const input = (w: any) => w.get('input[aria-label="Ask Sailor"]')

describe('SailorPrompt', () => {
  it('shows the selection as a chip and in the placeholder', () => {
    const w = mount(SailorPrompt, { props: { selectionLabel: 'Rainy shop' }, global: { stubs } })
    expect(w.get('[data-testid="prompt-selection-chip"]').text()).toContain('Rainy shop')
    expect(input(w).attributes('placeholder')).toBe('Change or ask about Rainy shop')
  })

  it('submits trimmed text on Enter and clears the field', async () => {
    const w = mount(SailorPrompt, { global: { stubs } })
    await input(w).setValue('  make it rain  ')
    await input(w).trigger('keydown', { key: 'Enter' })
    expect(w.emitted('submit')).toEqual([['make it rain']])
    expect((input(w).element as HTMLInputElement).value).toBe('')
  })

  it('does not submit an empty field', async () => {
    const w = mount(SailorPrompt, { global: { stubs } })
    await input(w).trigger('keydown', { key: 'Enter' })
    expect(w.emitted('submit')).toBeUndefined()
  })

  it('shows suggestions only while focused, and a click submits one', async () => {
    const w = mount(SailorPrompt, { props: { suggestions: ['What does this do?'] }, global: { stubs } })
    expect(w.find('[data-testid="prompt-suggestions"]').exists()).toBe(false)
    await input(w).trigger('focus')
    const pill = w.get('[data-testid="prompt-suggestions"] button')
    expect(pill.text()).toBe('What does this do?')
    await pill.trigger('mousedown')
    expect(w.emitted('submit')).toEqual([['What does this do?']])
  })

  it('Esc clears the mode on an empty field, then blurs', async () => {
    const w = mount(SailorPrompt, { props: { mode: 'Remix' }, global: { stubs } })
    await input(w).trigger('keydown', { key: 'Escape' })
    expect(w.emitted('clearMode')).toHaveLength(1)
    await w.setProps({ mode: null })
    await input(w).trigger('keydown', { key: 'Escape' })
    expect(w.emitted('blur')?.length ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('while working shows the label and Stop instead of the field', async () => {
    const w = mount(SailorPrompt, { props: { working: true, workingLabel: 'Planning the change…' }, global: { stubs } })
    expect(w.find('input[aria-label="Ask Sailor"]').exists()).toBe(false)
    expect(w.text()).toContain('Planning the change…')
    await w.get('button[data-testid="prompt-stop"]').trigger('click')
    expect(w.emitted('stop')).toHaveLength(1)
  })

  it('hides Stop when the work cannot be stopped', () => {
    const w = mount(SailorPrompt, { props: { working: true, stoppable: false }, global: { stubs } })
    expect(w.find('button[data-testid="prompt-stop"]').exists()).toBe(false)
  })

  it('clearing the chip emits clearSelection', async () => {
    const w = mount(SailorPrompt, { props: { selectionLabel: 'Poster' }, global: { stubs } })
    await w.get('[data-testid="prompt-selection-chip"] button').trigger('click')
    expect(w.emitted('clearSelection')).toHaveLength(1)
  })

  it('renders the above slot in the shared card', () => {
    const w = mount(SailorPrompt, { slots: { above: '<p class="probe">Hello</p>' }, global: { stubs } })
    expect(w.get('[data-testid="prompt-card"] .probe').text()).toBe('Hello')
  })

  it('exposes its text field via inputElement(), and null while working', async () => {
    const w = mount(SailorPrompt, { global: { stubs } })
    expect((w.vm as any).inputElement()).toBe(input(w).element)
    await w.setProps({ working: true })
    expect((w.vm as any).inputElement()).toBeNull()
  })
})
