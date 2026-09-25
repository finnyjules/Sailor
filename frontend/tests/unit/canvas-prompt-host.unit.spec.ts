// @vitest-environment happy-dom
// CanvasPromptHost's contract with the layout (`/` and ⌘K in default.vue): it
// exposes focus() and isFocusable(), and its root is a single element (a
// leading template comment once made it a fragment in dev, so the layout's
// `$el` was a comment node and `/` never focused the prompt). All behaviour
// lives in useCanvasPrompt (mocked here); the host only wires it to the prompt.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'

;(globalThis as any).useLocalSettings = () => ({ getLocalSetting: () => null })

const aiAvailable = ref(true)
vi.mock('~/composables/useAiStatus', () => ({ useAiStatus: () => ({ aiAvailable }) }))

const { api, stop } = vi.hoisted(() => {
  const { ref } = require('vue')
  const stop = vi.fn()
  const api = {
    agent: { changes: ref([]), issues: ref([]), review: ref(null), reviewing: ref(false), busy: ref(false), hovered: ref(null),
      acceptChange: vi.fn(), rejectChange: vi.fn(), reroll: vi.fn(), keep: vi.fn(), keepAndRun: vi.fn(), dismiss: vi.fn() },
    selection: ref([]), chipLabel: ref(null), suggestions: ref([]), mode: ref(null), modeNote: ref(null), focusTick: ref(0),
    working: ref(false), workingLabel: ref('Looking at the result…'), lastSubmitted: ref(''), card: ref(null), answerCard: ref(null), takes: ref(null), takesSaving: ref(false),
    showSketchInstead: ref(false), searchOpen: ref(false), searchQuery: ref(''), onSearchDone: vi.fn(),
    submit: vi.fn(), stop, clearMode: vi.fn(), clearSelection: vi.fn(), onPromptFocus: vi.fn(), previewTake: vi.fn(), chooseTake: vi.fn(),
    keepTake: vi.fn(), closeTakes: vi.fn(), moreTakes: vi.fn(), dismissAnswer: vi.fn(), runFollowUp: vi.fn(), sketchInstead: vi.fn(),
  }
  return { api, stop }
})
vi.mock('~/composables/useCanvasPrompt', () => ({ useCanvasPrompt: () => api }))

// The picker and the result cards pull in network/Nuxt deps; they are not under test.
vi.mock('~/components/agent/ImageSearchPickerModal.vue', () => ({ default: { name: 'ImageSearchPickerModal', render: () => null } }))
vi.mock('~/components/prompt/PromptTakes.vue', () => ({ default: { name: 'PromptTakes', render: () => null } }))
vi.mock('~/components/prompt/PromptChangesCard.vue', () => ({ default: { name: 'PromptChangesCard', render: () => null } }))
vi.mock('~/components/prompt/PromptAnswerCard.vue', () => ({ default: { name: 'PromptAnswerCard', render: () => null } }))

import CanvasPromptHost from '~/components/prompt/CanvasPromptHost.vue'

const vueCanvas = { agentSnapshot: () => ({}), agentPreview: () => {}, getNodes: () => [], agentSelection: [] }
const stubs = { AgentSweep: true, ImageSearchPickerModal: true }
const mountHost = () => mount(CanvasPromptHost, { props: { vueCanvas }, global: { stubs }, attachTo: document.body })

function sizeInput(input: HTMLInputElement) {
  input.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 40, right: 200, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect
}

describe('CanvasPromptHost', () => {
  afterEach(() => {
    aiAvailable.value = true
    api.working.value = false
    api.focusTick.value = 0
    stop.mockReset()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('renders a single root element (not a fragment) and exposes focus + isFocusable', () => {
    const w = mountHost()
    expect((w.vm.$el as Node).nodeType).toBe(Node.ELEMENT_NODE)
    expect(typeof (w.vm as any).focus).toBe('function')
    expect(typeof (w.vm as any).isFocusable).toBe('function')
    w.unmount()
  })

  it('is focusable when its field is the top element at its centre, and focus() focuses it', () => {
    const w = mountHost()
    const input = w.get('input[aria-label="Ask Sailor"]').element as HTMLInputElement
    sizeInput(input)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(input)
    expect((w.vm as any).isFocusable()).toBe(true)
    ;(w.vm as any).focus()
    expect(document.activeElement).toBe(input)
    w.unmount()
  })

  it('is not focusable when an overlay covers it, it has no size, or AI is not set up', async () => {
    const w = mountHost()
    const input = w.get('input[aria-label="Ask Sailor"]').element as HTMLInputElement
    expect((w.vm as any).isFocusable()).toBe(false) // zero size
    sizeInput(input)
    const overlay = document.createElement('div')
    document.body.appendChild(overlay)
    const spy = vi.spyOn(document, 'elementFromPoint').mockReturnValue(overlay)
    expect((w.vm as any).isFocusable()).toBe(false) // covered
    spy.mockReturnValue(input)
    aiAvailable.value = false
    await w.vm.$nextTick()
    expect(input.disabled).toBe(true)
    expect((w.vm as any).isFocusable()).toBe(false) // disabled
    w.unmount()
  })

  it('while working, the row shows the label and Stop calls stop', async () => {
    const w = mountHost()
    expect(w.find('input[aria-label="Ask Sailor"]').exists()).toBe(true)
    api.working.value = true
    await w.vm.$nextTick()
    expect(w.find('input[aria-label="Ask Sailor"]').exists()).toBe(false)
    expect(w.text()).toContain('Looking at the result…')
    expect(w.find('[data-testid="prompt-card"]').exists()).toBe(false) // progress shows once, in the row
    await w.get('button[data-testid="prompt-stop"]').trigger('click')
    expect(stop).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('a mode set by a menu focuses the prompt (focusTick)', async () => {
    const w = mountHost()
    const input = w.get('input[aria-label="Ask Sailor"]').element as HTMLInputElement
    api.focusTick.value++
    await nextTick(); await nextTick()
    expect(document.activeElement).toBe(input)
    w.unmount()
  })
})
