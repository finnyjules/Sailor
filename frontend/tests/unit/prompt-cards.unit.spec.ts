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
  it('hover and focus preview; leaving the strip goes back; there is no separate Keep button', async () => {
    const w = mount(PromptTakes, { props: { session: session(3) } })
    const first = w.findAll('[data-testid="prompt-take-tile"]')[0]!
    await first.get('button').trigger('mouseenter')
    await first.get('button').trigger('focus')
    await w.get('[data-testid="prompt-take-current"]').trigger('mouseenter')
    await w.get('[data-testid="prompt-takes"]').trigger('mouseleave')
    expect(w.emitted('hover')).toEqual([['1'], ['1'], [CURRENT], [null]])
    expect(first.findAll('button')).toHaveLength(1)
    expect(w.findAll('button').some(b => b.text() === 'Keep')).toBe(false)
    expect(first.get('button').text()).toBe('Take 1')
  })
  it('a click on a tile keeps it; a click on Current keeps what was there (the strip closes)', async () => {
    const w = mount(PromptTakes, { props: { session: session(3) } })
    await w.findAll('[data-testid="prompt-take-tile"]')[1]!.get('button').trigger('click', { detail: 1 })
    expect(w.emitted('keep')).toEqual([['2']])
    await w.get('[data-testid="prompt-take-current"]').trigger('click', { detail: 1 })
    expect(w.emitted('close')).toHaveLength(1)
    expect(w.emitted('keep')).toHaveLength(1)
  })
  it('Enter or Space on a focused tile keeps it (a keyboard click); focus alone only previews', async () => {
    const w = mount(PromptTakes, { props: { session: session(3) } })
    const b = w.findAll('[data-testid="prompt-take-tile"]')[2]!.get('button')
    await b.trigger('focus')
    expect(w.emitted('keep')).toBeUndefined()
    await b.trigger('click', { detail: 0 }) // what the browser fires for Enter / Space on a button
    expect(w.emitted('hover')).toEqual([['3']])
    expect(w.emitted('keep')).toEqual([['3']])
  })
  it('the header says how: hover to preview, click to keep (once a take is in)', () => {
    expect(mount(PromptTakes, { props: { session: session(1) } }).get('[data-testid="prompt-takes-hint"]').text()).toBe('Hover to preview, click to keep')
    expect(mount(PromptTakes, { props: { session: opened() } }).find('[data-testid="prompt-takes-hint"]').exists()).toBe(false)
  })
  it('touch: the first tap previews a tile, a second tap on the same tile keeps it', async () => {
    const w = mount(PromptTakes, { props: { session: session(3) } })
    const tap = async (el: ReturnType<typeof w.get>) => { await el.trigger('pointerdown', { pointerType: 'touch' }); await el.trigger('click', { detail: 1 }) }
    const [one, two] = w.findAll('[data-testid="prompt-take-tile"]').map(x => x.get('button'))
    await tap(one!)
    expect(w.emitted('keep')).toBeUndefined()
    expect(w.emitted('hover')).toEqual([['1']])
    expect(w.get('[data-testid="prompt-takes-hint"]').text()).toBe('Tap to preview, tap again to keep')
    await tap(two!) // another tile: previews that one instead
    expect(w.emitted('keep')).toBeUndefined()
    expect(w.emitted('hover')!.at(-1)).toEqual(['2'])
    await tap(two!)
    expect(w.emitted('keep')).toEqual([['2']])
    // Current the same way: a first tap previews it, a second keeps what was there.
    await tap(w.get('[data-testid="prompt-take-current"]'))
    expect(w.emitted('close')).toBeUndefined()
    await tap(w.get('[data-testid="prompt-take-current"]'))
    expect(w.emitted('close')).toHaveLength(1)
  })
  it('a device without hover says "tap" from the start', async () => {
    const mm = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: q === '(hover: none)', media: q, addEventListener() {}, removeEventListener() {} })) as any
    try {
      const w = mount(PromptTakes, { props: { session: session(3) } })
      await w.vm.$nextTick()
      expect(w.get('[data-testid="prompt-takes-hint"]').text()).toBe('Tap to preview, tap again to keep')
    } finally { window.matchMedia = mm }
  })
  it('a failed keep shows its sentence on the strip, which stays open', () => {
    const w = mount(PromptTakes, { props: { session: session(3), error: 'Couldn’t save to My effects. Try again in a moment.' } })
    expect(w.find('[data-testid="prompt-takes-error"]').text()).toBe('Couldn’t save to My effects. Try again in a moment.')
    expect(w.find('[data-testid="prompt-takes-error"]').attributes('role')).toBe('alert')
    expect(mount(PromptTakes, { props: { session: session(3) } }).find('[data-testid="prompt-takes-error"]').exists()).toBe(false)
  })
  it('while a keep is saving, a click on another tile keeps nothing', async () => {
    const w = mount(PromptTakes, { props: { session: session(3), saving: true } })
    const tiles = w.findAll('[data-testid="prompt-take-tile"] button')
    expect(tiles).toHaveLength(3)
    for (const k of tiles) expect(k.attributes('aria-disabled')).toBe('true')
    await tiles[0]!.trigger('click', { detail: 1 })
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
    expect(done.text()).toContain('Three takes · Hover to preview, click to keep')
  })
  it('an effect set\'s "Three more" shows its price before the click; a Variations set shows none', () => {
    const paid = mount(PromptTakes, { props: { session: session(3), moreNote: '48–88 credits' } })
    const more = paid.findAll('button').find(b => b.text().startsWith('Three more'))!
    expect(more.text()).toBe('Three more · 48–88 credits')
    expect(more.get('[data-testid="prompt-takes-more-note"]').text()).toBe('48–88 credits')
    const free = mount(PromptTakes, { props: { session: session(3) } })
    expect(free.find('[data-testid="prompt-takes-more-note"]').exists()).toBe(false)
  })
  it('a tile refused for want of credits says so, not "Didn’t come back"', () => {
    const s = session(1)
    const tiles = s.tiles.map((x, i) => (i === 0 ? x : { ...x, state: 'failed' as const }))
    tiles[2] = { ...tiles[2]!, reason: 'credits' as const }
    const w = mount(PromptTakes, { props: { session: { ...s, tiles } } })
    const shown = w.findAll('[data-testid="prompt-take-tile"]').map(x => x.text())
    expect(shown[1]).toContain('Didn’t come back')
    expect(shown[2]).toContain('Not enough credits')
    expect(shown[2]).not.toContain('Didn’t come back')
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
