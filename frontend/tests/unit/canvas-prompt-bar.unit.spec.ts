// @vitest-environment happy-dom
// CanvasPromptBar's contract with the layout (`/` and ⌘K in default.vue): it
// exposes focus() and isFocusable(), and its root is a single element (a
// leading template comment once made it a fragment in dev, so the layout's
// `$el` was a comment node and `/` never focused the prompt).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

;(globalThis as any).useLocalSettings = () => ({ getLocalSetting: () => null })

const aiAvailable = ref(true)
const reviewing = ref(false)
const reviewingManual = ref(false)
const stop = vi.fn()
vi.mock('~/composables/useAiStatus', () => ({ useAiStatus: () => ({ aiAvailable }) }))
vi.mock('~/composables/useCanvasAgent', () => ({
  useCanvasAgent: () => ({
    busy: ref(false), error: ref(''), reasoning: ref(''), answer: ref(''), changes: ref([]), issues: ref([]),
    review: ref(null), reviewing, reviewingManual, hasProposal: ref(false), hovered: ref(null),
    ask: vi.fn(), stop, acceptChange: vi.fn(), rejectChange: vi.fn(), reroll: vi.fn(), keep: vi.fn(),
    keepAndRun: vi.fn(), reviewLastRun: vi.fn(), reviewNode: vi.fn(), autoReviewNode: vi.fn(), dismiss: vi.fn(),
  }),
}))

// The picker and the proposal pull in network/Nuxt deps; they are not under test.
vi.mock('~/components/agent/ImageSearchPickerModal.vue', () => ({ default: { name: 'ImageSearchPickerModal', render: () => null } }))
vi.mock('~/components/agent/AgentProposal.vue', () => ({ default: { name: 'AgentProposal', render: () => null } }))

import CanvasPromptBar from '~/components/agent/CanvasPromptBar.vue'

const vueCanvas = { agentSnapshot: () => ({}), agentPreview: () => {}, getNodes: () => [], agentSelection: [] }
const stubs = { AgentSweep: true, AgentProposal: true, ImageSearchPickerModal: true }
const mountBar = () => mount(CanvasPromptBar, { props: { vueCanvas }, global: { stubs }, attachTo: document.body })

function sizeInput(input: HTMLInputElement) {
  input.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 40, right: 200, bottom: 40, x: 0, y: 0, toJSON() {} }) as DOMRect
}

describe('CanvasPromptBar', () => {
  afterEach(() => { aiAvailable.value = true; reviewing.value = false; reviewingManual.value = false; stop.mockReset(); vi.restoreAllMocks(); document.body.innerHTML = '' })

  it('renders a single root element (not a fragment) and exposes focus + isFocusable', () => {
    const w = mountBar()
    expect((w.vm.$el as Node).nodeType).toBe(Node.ELEMENT_NODE)
    expect(typeof (w.vm as any).focus).toBe('function')
    expect(typeof (w.vm as any).isFocusable).toBe('function')
    w.unmount()
  })

  it('is focusable when its field is the top element at its centre, and focus() focuses it', () => {
    const w = mountBar()
    const input = w.get('input[aria-label="Ask Sailor"]').element as HTMLInputElement
    sizeInput(input)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(input)
    expect((w.vm as any).isFocusable()).toBe(true)
    ;(w.vm as any).focus()
    expect(document.activeElement).toBe(input)
    w.unmount()
  })

  it('is not focusable when an overlay covers it, it has no size, or AI is not set up', async () => {
    const w = mountBar()
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

  it('a background review leaves the prompt usable; a user-started one takes the row and can be stopped', async () => {
    const w = mountBar()
    reviewing.value = true // auto-review after a paid render
    await w.vm.$nextTick()
    expect(w.find('input[aria-label="Ask Sailor"]').exists()).toBe(true)
    expect(w.find('[data-testid="prompt-card"]').exists()).toBe(false)
    reviewingManual.value = true // the Fix action / a manual critique
    await w.vm.$nextTick()
    expect(w.find('input[aria-label="Ask Sailor"]').exists()).toBe(false)
    expect(w.text()).toContain('Looking at the result…')
    expect(w.text()).not.toContain('Analyzing the result') // progress shows once, in the row
    await w.get('button[data-testid="prompt-stop"]').trigger('click')
    expect(stop).toHaveBeenCalledTimes(1)
    w.unmount()
  })
})
