// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, onMounted } from 'vue'
import SailorPrompt from '~/components/prompt/SailorPrompt.vue'
import AiMark from '~/components/prompt/AiMark.vue'

const stubs = { AgentSweep: true }
const input = (w: any) => w.get('input[aria-label="Ask Sailor"]')

describe('SailorPrompt', () => {
  it('marks itself with the pastel ✦, the same mark as AI menu rows', () => {
    const w = mount(SailorPrompt, { global: { stubs } })
    expect(w.findComponent(AiMark).props('kind')).toBe('star')
  })

  it('shows the selection as a chip and in the placeholder', () => {
    const w = mount(SailorPrompt, { props: { selectionLabel: 'Rainy shop' }, global: { stubs } })
    expect(w.get('[data-testid="prompt-selection-chip"]').text()).toContain('Rainy shop')
    expect(input(w).attributes('placeholder')).toBe('Change or ask about Rainy shop')
  })

  it('shows the mode’s price note in neutral grey, and hides it while working', async () => {
    const w = mount(SailorPrompt, { props: { mode: 'Remix', note: '48–88 credits' }, global: { stubs } })
    const note = w.get('[data-testid="prompt-note"]')
    expect(note.text()).toBe('48–88 credits')
    expect(note.classes()).toContain('text-white/40')
    await w.setProps({ working: true })
    expect(w.find('[data-testid="prompt-note"]').exists()).toBe(false)
    await w.setProps({ working: false, note: null })
    expect(w.find('[data-testid="prompt-note"]').exists()).toBe(false)
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

  it('the sweep is mounted before work starts, so it sees active flip false → true', async () => {
    // AgentSweep's watcher runs immediately at setup, before its canvas exists;
    // if it is first mounted already active, the glimm never starts.
    const mountedWith: boolean[] = []
    const SweepProbe = defineComponent({
      props: { active: Boolean, period: Number, palette: String },
      setup(p) { onMounted(() => mountedWith.push(p.active)); return () => h('canvas', { 'data-probe': String(p.active) }) },
    })
    const w = mount(SailorPrompt, { props: { working: false }, global: { stubs: { AgentSweep: SweepProbe } } })
    await w.setProps({ working: true })
    await flushPromises()
    expect(mountedWith).toEqual([false])
    expect(w.findComponent(SweepProbe).props('active')).toBe(true)
  })
})

describe('SailorPrompt: a reference picture (paste or drop)', () => {
  const png = () => new File([new Uint8Array([1, 2, 3])], 'look.png', { type: 'image/png' })
  /** A clipboard or drag payload: happy-dom's own DataTransfer is incomplete, so a plain stand-in. */
  const transfer = (o: { files?: File[]; text?: string } = {}) => ({
    types: [...(o.text != null ? ['text/plain'] : []), ...(o.files?.length ? ['Files'] : [])],
    items: (o.files ?? []).map(f => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    files: o.files ?? [],
    getData: (t: string) => (t === 'text/plain' ? o.text ?? '' : ''),
  })

  it('shows the picture as a neutral chip whose × asks to remove it', async () => {
    const w = mount(SailorPrompt, { props: { reference: 'data:image/jpeg;base64,AAA' }, global: { stubs } })
    const chip = w.get('[data-testid="prompt-reference-chip"]')
    expect(chip.attributes('aria-label')).toBe('Reference picture')
    expect(chip.get('img').attributes('src')).toBe('data:image/jpeg;base64,AAA')
    expect(chip.classes().join(' ')).toContain('bg-white/[0.08]')
    await chip.get('button[aria-label="Remove reference picture"]').trigger('click')
    expect(w.emitted('clearReference')).toHaveLength(1)
  })

  it('no reference, no chip', () => {
    const w = mount(SailorPrompt, { global: { stubs } })
    expect(w.find('[data-testid="prompt-reference-chip"]').exists()).toBe(false)
  })

  it('pasting an image reports it when the host takes pictures, and keeps it out of the field', async () => {
    const w = mount(SailorPrompt, { props: { acceptsImage: true }, global: { stubs } })
    const f = png()
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: transfer({ files: [f] }) })
    input(w).element.dispatchEvent(ev)
    expect(w.emitted('attachImage')).toEqual([[f]])
    expect(ev.defaultPrevented).toBe(true)
  })

  it('a host that doesn’t take pictures leaves a paste alone', async () => {
    const w = mount(SailorPrompt, { global: { stubs } })
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: transfer({ files: [png()] }) })
    input(w).element.dispatchEvent(ev)
    expect(w.emitted('attachImage')).toBeUndefined()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('a text paste keeps working as today', async () => {
    const w = mount(SailorPrompt, { props: { acceptsImage: true }, global: { stubs } })
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: transfer({ text: 'slow rain' }) })
    input(w).element.dispatchEvent(ev)
    expect(w.emitted('attachImage')).toBeUndefined()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('dropping an image file on the prompt reports it; a drop elsewhere-bound is left alone when not taken', async () => {
    const w = mount(SailorPrompt, { props: { acceptsImage: true }, global: { stubs } })
    const row = w.get('.sp-row')
    const f = png()
    const over = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: transfer({ files: [f] }) })
    row.element.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: transfer({ files: [f] }) })
    row.element.dispatchEvent(drop)
    expect(w.emitted('attachImage')).toEqual([[f]])

    const plain = mount(SailorPrompt, { global: { stubs } })
    const over2 = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over2, 'dataTransfer', { value: transfer({ files: [f] }) })
    plain.get('.sp-row').element.dispatchEvent(over2)
    expect(over2.defaultPrevented).toBe(false)
  })

  it('with a reference, an empty field can be sent (the picture is the request)', async () => {
    const w = mount(SailorPrompt, { props: { reference: 'data:image/jpeg;base64,AAA' }, global: { stubs } })
    expect(w.get('button[aria-label="Send"]').attributes('disabled')).toBeUndefined()
    await input(w).trigger('keydown', { key: 'Enter' })
    expect(w.emitted('submit')).toEqual([['']])
  })
})
