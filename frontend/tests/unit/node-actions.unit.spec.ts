// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { actionHint, actionPrice, actionsFor, landsHint, type NodeActionCtx } from '~/lib/canvas/nodeActions'

const ctx = (type: string, o: Partial<NodeActionCtx> = {}): NodeActionCtx => ({ nodeId: 'n1', type, hasImages: false, hasUpstream: true, ...o })
function capture(run: () => void) {
  const seen: { name: string; detail: any }[] = []
  const names = ['sailor:applyEffect', 'sailor:openInpaint', 'sailor:critiqueNode', 'sailor:runVariations', 'sailor:animateArtifact', 'sailor:openActions', 'sailor:openTextEdit']
  const fns = names.map(name => { const f = (e: Event) => seen.push({ name, detail: (e as CustomEvent).detail }); window.addEventListener(name, f); return [name, f] as const })
  run()
  fns.forEach(([n, f]) => window.removeEventListener(n, f))
  return seen
}
const find = (c: NodeActionCtx, label: string) => [...actionsFor(c).edit, ...actionsFor(c).develop].find(a => a.label === label)!

describe('landsHint', () => {
  it('names where results land', () => {
    expect(landsHint('takes')).toBe('3 takes'); expect(landsHint('step')).toBe('adds a step'); expect(landsHint(null)).toBeNull()
  })
})

describe('image node actions', () => {
  const c = ctx('artifact-image', { hasImages: true })
  it('groups by intent', () => {
    const { edit, develop } = actionsFor(c)
    expect(edit.map(a => a.label)).toEqual(['Fix', 'Remove background', 'Inpaint', 'Remove object', 'Recolor…', 'Edit text…', 'Edit with Nano Banana', 'Enhance detail', 'Upscale', 'Relight'])
    expect(develop.map(a => a.label)).toEqual(['Variations', 'Restyle…', 'Reframe', 'Animate'])
  })
  it('Upscale branches and runs, exactly as before', () => {
    expect(capture(() => find(c, 'Upscale').run(c))).toEqual([{ name: 'sailor:applyEffect', detail: { nodeId: 'n1', nodeType: 'UpscaleImageNode', output: 'IMAGE', widgetOverrides: undefined, run: true, branch: true } }])
  })
  it('Remove background splices in place', () => {
    expect(capture(() => find(c, 'Remove background').run(c))).toEqual([{ name: 'sailor:applyEffect', detail: { nodeId: 'n1', nodeType: 'BackgroundRemove', output: 'IMAGE', widgetOverrides: { output: 'transparent' } } }])
  })
  it('Remove object opens inpaint with the remove intent', () => {
    expect(capture(() => find(c, 'Remove object').run(c))).toEqual([{ name: 'sailor:openInpaint', detail: { nodeId: 'n1', intent: 'remove' } }])
  })
  it('Variations asks for three takes and needs something upstream', () => {
    expect(capture(() => find(c, 'Variations').run(c))).toEqual([{ name: 'sailor:runVariations', detail: { nodeId: 'n1', count: 3 } }])
    expect(find(c, 'Variations').lands).toBe('takes')
    expect(find(ctx('artifact-image', { hasUpstream: false }), 'Variations').enabled!(ctx('artifact-image', { hasUpstream: false }))).toBe(false)
  })
  it('Fix needs a rendered image and fires a critique', () => {
    expect(find(c, 'Fix').enabled!(ctx('artifact-image', { hasImages: false }))).toBe(false)
    expect(capture(() => find(c, 'Fix').run(c))).toEqual([{ name: 'sailor:critiqueNode', detail: { nodeId: 'n1' } }])
  })
  it('every branching or splicing action says it adds a step', () => {
    const { edit, develop } = actionsFor(c)
    for (const a of [...edit, ...develop]) {
      const fired = capture(() => a.run(c))
      if (fired[0]?.name === 'sailor:applyEffect') expect(a.lands).toBe('step')
    }
  })
})

describe('video and audio', () => {
  it('video keeps its three actions and All actions…', () => {
    const c = ctx('artifact-video')
    expect(actionsFor(c).edit.map(a => a.label)).toEqual(['Sync lips', 'Enhance'])
    expect(actionsFor(c).develop.map(a => a.label)).toEqual(['Describe', 'All actions…'])
    expect(capture(() => find(c, 'Sync lips').run(c))).toEqual([{ name: 'sailor:applyEffect', detail: { nodeId: 'n1', nodeType: 'LipsyncNode', output: 'VIDEO', branch: true, focus: true } }])
    expect(capture(() => find(c, 'All actions…').run(c))).toEqual([{ name: 'sailor:openActions', detail: { domain: 'video' } }])
  })
  it('audio gets its chips as Develop actions', () => {
    const c = ctx('artifact-audio')
    expect(actionsFor(c).develop.map(a => a.label)).toEqual(['Transcribe', 'Speakers', 'All actions…'])
    expect(capture(() => find(c, 'Transcribe').run(c))).toEqual([{ name: 'sailor:applyEffect', detail: { nodeId: 'n1', nodeType: 'TranscribeAudioNode', output: 'AUDIO', branch: true, focus: true } }])
  })
})

describe('any other node', () => {
  it('offers Fix only once it has images', () => {
    expect(actionsFor(ctx('KSampler')).edit).toEqual([])
    expect(actionsFor(ctx('KSampler', { hasImages: true })).edit.map(a => a.label)).toEqual(['Fix'])
    expect(actionsFor(ctx('KSampler', { hasImages: true })).develop).toEqual([])
  })
})

describe('price in the grey hint', () => {
  const info = {
    EnhanceVideoNode: { price_badge: { expr: '{"usd": 0.25}' } },
    TranscribeAudioNode: { price_badge: { expr: '{"usd": 0.02, "format": {"approximate": true}}' } },
    UpscaleImageNode: { price_badge: { expr: '{"usd": 9.99}' } },
  }
  const img = ctx('artifact-image', { hasImages: true })
  const hint = (c: NodeActionCtx, label: string, hosted = false) => { const a = find(c, label); return actionHint(a, actionPrice(a, info, hosted)) }

  it('image actions carry the fixed estimate the old menu showed', () => {
    expect(hint(img, 'Upscale')).toBe('adds a step · ~$0.14') // the fixed estimate wins over the badge
    expect(hint(img, 'Edit with Nano Banana')).toBe('adds a step · ~$0.12')
    expect(hint(img, 'Animate')).toBe('adds a step · from $1.60')
  })
  it('video and audio actions are priced from their node’s price_badge', () => {
    expect(hint(ctx('artifact-video'), 'Enhance')).toBe('adds a step · $0.25')
    expect(hint(ctx('artifact-audio'), 'Transcribe')).toBe('adds a step · ~$0.02')
    expect(hint(ctx('artifact-audio'), 'Transcribe', true)).toMatch(/^adds a step · ~\d+ cr$/)
  })
  it('free actions, and paid ones with no known price, show just the landing hint', () => {
    expect(hint(img, 'Remove background')).toBe('adds a step')
    expect(hint(img, 'Variations')).toBe('3 takes')
    expect(hint(img, 'Inpaint')).toBeNull()
    expect(hint(ctx('artifact-video'), 'Sync lips')).toBe('adds a step') // no badge in this catalog
    expect(actionPrice(find(ctx('artifact-video'), 'Enhance'), null, false)).toBeNull() // catalog not loaded yet
  })
})
