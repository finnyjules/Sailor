// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import StudioPromptHost from '~/components/prompt/StudioPromptHost.vue'

function api(over: Record<string, unknown> = {}) {
  return {
    chipLabel: ref('Water ripple'), suggestions: ref(['Warmer']), mode: ref(null), modeNote: ref(null), working: ref(false),
    workingLabel: ref('Working on “x”'), disabled: ref(false), focusTick: ref(0),
    reference: ref(null), acceptsReference: ref(false), attachReference: vi.fn(), clearReference: vi.fn(),
    card: ref(null), takes: ref(null), takesSaving: ref(false), takesError: ref(null), answerCard: ref(null),
    worker: () => ({ changes: ref([]), busy: ref(false), issues: ref([]), review: ref(null), reviewing: ref(false), hovered: ref(null), acceptChange: vi.fn(), rejectChange: vi.fn(), reroll: vi.fn() }),
    submit: vi.fn(), runKind: vi.fn(), setMode: vi.fn(), clearMode: vi.fn(), stop: vi.fn(), requestFocus: vi.fn(),
    previewTake: vi.fn(), keepTake: vi.fn(), moreTakes: vi.fn(), closeTakes: vi.fn(),
    approve: vi.fn(), rejectAll: vi.fn(), dismissAnswer: vi.fn(), runFollowUp: vi.fn(),
    ...over,
  } as any
}

describe('StudioPromptHost', () => {
  it('shows the api’s reference picture as a chip, takes pictures only where the api does, and × clears it', async () => {
    const p = api({ reference: ref('data:image/jpeg;base64,AAA'), acceptsReference: ref(true) })
    const w = mount(StudioPromptHost, { props: { prompt: p } })
    const sp = w.findComponent({ name: 'SailorPrompt' })
    expect(sp.props('reference')).toBe('data:image/jpeg;base64,AAA')
    expect(sp.props('acceptsImage')).toBe(true)
    await w.get('[data-testid="prompt-reference-chip"] button').trigger('click')
    expect(p.clearReference).toHaveBeenCalled()
    expect(mount(StudioPromptHost, { props: { prompt: api() } }).findComponent({ name: 'SailorPrompt' }).props('acceptsImage')).toBe(false)
  })

  it('renders the one prompt with the thing’s own name as the chip', () => {
    const w = mount(StudioPromptHost, { props: { prompt: api() } })
    expect(w.find('[data-testid="prompt-selection-chip"]').text()).toContain('Water ripple')
    expect(w.find('input[aria-label="Ask Sailor"]').attributes('placeholder')).toBe('Change or ask about Water ripple')
  })

  it('shows exactly one card, chosen by the api', () => {
    const takes = { nodeId: 'studio', nodeLabel: 'Water ripple', request: 'warmer', currentThumb: null, known: [], hovered: null, chosen: '__current__',
      tiles: [0, 1, 2].map(i => ({ state: 'ready', takeId: `take-${i}`, promptId: null, thumb: 'data:x' })) }
    const w = mount(StudioPromptHost, { props: { prompt: api({ card: ref('takes'), takes: ref(takes) }) } })
    expect(w.find('[data-testid="prompt-takes"]').exists()).toBe(true)
    expect(w.find('[data-testid="prompt-changes"]').exists()).toBe(false)
    const w2 = mount(StudioPromptHost, { props: { prompt: api({ card: ref('answer'), answerCard: ref({ kind: 'notice', text: 'Hi', reasoning: '', followUps: [] }) }) } })
    expect(w2.find('[data-testid="prompt-answer"]').text()).toContain('Hi')
  })

  it('a new-effect chip shows its price, and while an effect keep is saving the tiles keep nothing', () => {
    const takes = { nodeId: 'shader-studio', nodeLabel: 'Water ripple', request: 'rain', currentThumb: null, known: [], hovered: null, chosen: null,
      tiles: [0, 1, 2].map(i => ({ state: 'ready', takeId: `draft_1_${i}`, promptId: null, thumb: 'data:x' })) }
    const w = mount(StudioPromptHost, { props: { prompt: api({ mode: ref({ label: 'Remix', kind: 'new-effect' }), modeNote: ref('48–88 credits') }) } })
    expect(w.find('[data-testid="prompt-note"]').text()).toBe('48–88 credits')
    const saving = mount(StudioPromptHost, { props: { prompt: api({ card: ref('takes'), takes: ref(takes), takesSaving: ref(true) }) } })
    const tiles = saving.findAll('[data-testid="prompt-take-tile"] button')
    expect(tiles).toHaveLength(3)
    expect(tiles.every(b => b.attributes('aria-disabled') === 'true')).toBe(true)
    const failed = mount(StudioPromptHost, { props: { prompt: api({ card: ref('takes'), takes: ref(takes), takesError: ref('Couldn’t save to My effects. Try again in a moment.') }) } })
    expect(failed.find('[data-testid="prompt-takes-error"]').text()).toContain('Couldn’t save')
  })

  it('sends on Enter and stops on Stop', async () => {
    const p = api()
    const w = mount(StudioPromptHost, { props: { prompt: p } })
    await w.find('input').setValue('warmer')
    await w.find('input').trigger('keydown', { key: 'Enter' })
    expect(p.submit).toHaveBeenCalledWith('warmer')
    const busyApi = api({ working: ref(true) })
    const busy = mount(StudioPromptHost, { props: { prompt: busyApi } })
    await busy.find('[data-testid="prompt-stop"]').trigger('click')
    expect(busyApi.stop).toHaveBeenCalled()
  })

  it('/ focuses it and the key does not reach the canvas below', async () => {
    const w = mount(StudioPromptHost, { props: { prompt: api() }, attachTo: document.body })
    const below = vi.fn()
    window.addEventListener('keydown', below)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))
    await w.vm.$nextTick()
    expect(document.activeElement).toBe(w.find('input').element)
    expect(below).not.toHaveBeenCalled()
    window.removeEventListener('keydown', below)
    w.unmount()
  })

  it('a hidden prompt (v-show / display:none) leaves / and ⌘K to whoever is on screen', async () => {
    const w = mount(StudioPromptHost, { props: { prompt: api() }, attachTo: document.body })
    const input = w.find('input').element as HTMLInputElement
    // What a display:none ancestor gives a real browser: no boxes.
    input.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as any
    const below = vi.fn()
    window.addEventListener('keydown', below)
    for (const init of [{ key: '/' }, { key: 'k', metaKey: true }]) {
      const e = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
      window.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false)
    }
    expect(below).toHaveBeenCalledTimes(2)
    expect(document.activeElement).not.toBe(input)
    window.removeEventListener('keydown', below)
    w.unmount()
  })
})
