// frontend/tests/unit/prompt-cards.unit.spec.ts
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PromptTakes from '~/components/prompt/PromptTakes.vue'
import PromptChangesCard from '~/components/prompt/PromptChangesCard.vue'
import PromptAnswerCard from '~/components/prompt/PromptAnswerCard.vue'
import { assignRun, CURRENT, ingestTakes, openTakes } from '~/lib/prompt/takesSession'

const t = (id: string) => ({ id, createdAt: 0, promptId: `p${id}`, images: [`u-${id}`] })
const opened = () => ['p1', 'p2', 'p3'].reduce(assignRun, openTakes({ nodeId: 'n1', nodeLabel: 'Rainy shop', request: '', takes: [t('0')], images: ['u-0'] }))
const session = (n: number) => ingestTakes(opened(), [t('0'), ...['1', '2', '3'].slice(0, n).map(t)])

describe('PromptTakes', () => {
  it('names the node, shows the current version then three tiles; pending ones pulse', () => {
    const w = mount(PromptTakes, { props: { session: session(1) } })
    expect(w.get('[data-testid="prompt-takes-target"]').text()).toBe('Rainy shop')
    expect(w.get('[data-testid="prompt-take-current"] img').attributes('src')).toBe('u-0')
    const tiles = w.findAll('[data-testid="prompt-take-tile"]')
    expect(tiles.map(x => x.attributes('data-state'))).toEqual(['ready', 'pending', 'pending'])
    expect(tiles[1]!.find('.animate-pulse').exists()).toBe(true)
    expect(w.text()).toContain('1 of 3 ready')
  })
  it('hover and focus preview; leaving the strip goes back; click chooses; Keep keeps', async () => {
    const w = mount(PromptTakes, { props: { session: session(3) } })
    const first = w.findAll('[data-testid="prompt-take-tile"]')[0]!
    await first.get('button[aria-label="Preview take 1"]').trigger('mouseenter')
    await first.get('button[aria-label="Preview take 1"]').trigger('focus')
    await w.get('[data-testid="prompt-take-current"]').trigger('mouseenter')
    await w.get('[data-testid="prompt-takes"]').trigger('mouseleave')
    await first.get('button[aria-label="Preview take 1"]').trigger('click')
    await first.findAll('button').find(b => b.text() === 'Keep')!.trigger('click')
    expect(w.emitted('hover')).toEqual([['1'], ['1'], [CURRENT], [null]])
    expect(w.emitted('choose')).toEqual([['1']])
    expect(w.emitted('keep')).toEqual([['1']])
  })
  it('while a Keep is saving, every Keep is off', async () => {
    const w = mount(PromptTakes, { props: { session: session(3), saving: true } })
    const keeps = w.findAll('button').filter(b => b.text() === 'Keep')
    expect(keeps).toHaveLength(3)
    for (const k of keeps) expect(k.attributes('disabled')).toBeDefined()
    await keeps[0]!.trigger('click')
    expect(w.emitted('keep')).toBeUndefined()
  })
  it('"Three more" waits until the takes are in; × closes', async () => {
    const busy = mount(PromptTakes, { props: { session: session(1) } })
    expect(busy.findAll('button').find(b => b.text() === 'Three more')!.attributes('disabled')).toBeDefined()
    const done = mount(PromptTakes, { props: { session: session(3) } })
    await done.findAll('button').find(b => b.text() === 'Three more')!.trigger('click')
    await done.get('button[aria-label="Close takes"]').trigger('click')
    expect(done.emitted('more')).toHaveLength(1)
    expect(done.emitted('close')).toHaveLength(1)
    expect(done.text()).toContain('Three takes · hover to preview, Keep one')
  })
  it('tabbing out of the strip goes back to the version at open; moving within it does not', async () => {
    const w = mount(PromptTakes, { props: { session: session(3) }, attachTo: document.body })
    const root = w.get('[data-testid="prompt-takes"]')
    const inside = w.get('[data-testid="prompt-take-current"]').element
    await root.trigger('focusout', { relatedTarget: inside })
    expect(w.emitted('hover')).toBeUndefined()
    await root.trigger('focusout', { relatedTarget: document.body })
    await root.trigger('focusout', { relatedTarget: null })
    expect(w.emitted('hover')).toEqual([[null], [null]])
    w.unmount()
  })
  it('quotes the words that asked for the takes; a menu run says Variations', () => {
    expect(mount(PromptTakes, { props: { session: { ...session(0), request: 'moodier' } } }).text()).toContain('“moodier”')
    expect(mount(PromptTakes, { props: { session: session(0) } }).text()).toContain('Variations')
  })
})

const change = (op: string, after: string, o: any = {}) => ({ command: { op }, label: 'Add node', before: '', after, rationale: '', rerollable: false, accepted: true, ...o }) as any

describe('PromptChangesCard', () => {
  it('lists the changes with their marks, and Approve / Reject / Approve and run', async () => {
    const w = mount(PromptChangesCard, { props: { changes: [change('addNode', 'Upscale ×2'), change('connect', 'Rainy shop → Upscale ×2')], busy: false, runnable: true } })
    expect(w.get('[data-testid="prompt-changes"]').text()).toContain('2 changes to the graph · shown on the canvas')
    expect(w.text()).toContain('+Add Upscale ×2')
    expect(w.text()).toContain('↳Rainy shop → Upscale ×2')
    const btn = (label: string) => w.findAll('button').find(b => b.text() === label)!
    await btn('Reject').trigger('click')
    await btn('Approve').trigger('click')
    await btn('Approve and run').trigger('click')
    expect(w.emitted('rejectAll')).toHaveLength(1)
    expect(w.emitted('approve')).toHaveLength(1)
    expect(w.emitted('approveRun')).toHaveLength(1)
  })
  it('a row toggles between included and left out, and hovering it asks the canvas to point at it', async () => {
    const w = mount(PromptChangesCard, { props: { changes: [change('addNode', 'A'), change('addNode', 'B', { accepted: false })], busy: false } })
    const rows = w.findAll('[data-testid="prompt-change-row"]')
    await rows[0]!.get('button[aria-label="Leave this change out"]').trigger('click')
    await rows[1]!.get('button[aria-label="Include this change"]').trigger('click')
    await rows[0]!.trigger('mouseenter'); await rows[0]!.trigger('mouseleave')
    expect(w.emitted('reject')).toEqual([[0]])
    expect(w.emitted('accept')).toEqual([[1]])
    expect(w.emitted('hover')).toEqual([[0], [null]])
    expect(w.findAll('button').some(b => b.text() === 'Approve and run')).toBe(false) // not runnable
  })
})

describe('PromptAnswerCard', () => {
  it('an answer has the ✦ heading, the text and follow-up chips that send', async () => {
    const w = mount(PromptAnswerCard, { props: { card: { kind: 'answer', text: 'It doubles the size.', reasoning: '', followUps: ['Render at 1080'] } } })
    expect(w.get('[data-testid="prompt-answer"]').text()).toContain('Answer')
    expect(w.find('svg [data-part="star"]').exists()).toBe(true) // AiMark kind="star"
    await w.findAll('button').find(b => b.text() === 'Render at 1080')!.trigger('click')
    await w.get('button[aria-label="Close"]').trigger('click')
    expect(w.emitted('followUp')).toEqual([['Render at 1080']])
    expect(w.emitted('close')).toHaveLength(1)
  })
  it('a notice has no heading; an error reads red', () => {
    const n = mount(PromptAnswerCard, { props: { card: { kind: 'notice', text: 'Select a Frame to write its copy.', reasoning: '', followUps: [] } } })
    expect(n.text()).not.toContain('Answer')
    const e = mount(PromptAnswerCard, { props: { card: { kind: 'error', text: 'Nope', reasoning: '', followUps: [] } } })
    expect(e.get('p.text-red-400\\/90').text()).toBe('Nope')
  })
})
