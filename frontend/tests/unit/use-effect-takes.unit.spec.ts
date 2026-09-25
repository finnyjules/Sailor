// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { useEffectTakes, EFFECT_MESSAGES, type EffectTarget } from '~/composables/useEffectTakes'
import { generateTakes, type TakeRenderer } from '~/lib/shadergen/engine'
import { TAKE_ANGLES } from '~/lib/shadergen/prompt'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'
import { CURRENT } from '~/lib/prompt/takesSession'

;(globalThis as any).useLocalSettings = () => ({ getLocalSetting: () => 'k' })
const renderer: TakeRenderer = { compile: () => null, judge: () => ({ pass: true, flags: [], thumbnail: 'data:thumb' }), sheet: () => '' }
const slotOf = (p: string) => TAKE_ANGLES.findIndex(a => p.includes(a))
/** The spike's takes as canned replies; `release(slot, round)` lets a test release each slot in
 *  turn. Every start gets its own gates (preflight ruling 6): a slot's k-th call waits on round k's
 *  gate, so the takes of a later set don't land the moment it starts. The spike's takes pass every
 *  check, so each slot calls the model exactly once per set. */
function cannedModel() {
  const gate = () => { let open!: () => void; const p = new Promise<void>(r => { open = r }); return { p, open } }
  const rounds: ReturnType<typeof gate>[][] = []
  const gatesFor = (r: number) => (rounds[r] ??= [0, 1, 2].map(gate))
  const seen = [0, 0, 0]
  const callModel = vi.fn(async (prompt: string, _i?: string[], signal?: AbortSignal) => {
    const s = slotOf(prompt)
    const g = gatesFor(seen[s]!++)[s]!
    await Promise.race([g.p, new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))))])
    return { text: JSON.stringify(SPIKE_TAKES.rain![s]) }
  })
  return { callModel, release: (s: number, round = 0) => gatesFor(round)[s]!.open() }
}
function target(over: Partial<EffectTarget> = {}): EffectTarget & { preview: any; apply: any } {
  return { key: 'n1', label: 'Water ripple', base: null, image: () => null, preview: vi.fn(), apply: vi.fn(), ...over } as any
}
function setup(extra: Record<string, any> = {}) {
  const { callModel, release } = cannedModel()
  const library = {
    saveTake: vi.fn(async (take: any) => ({ id: 'mine_aaaaaaaaaaaa', name: take.name, versions: [{ label: 'v1', body: take.body, params: take.params, values: {}, note: '', createdAt: '' }] })),
    addCodeVersion: vi.fn(async (id: string, take: any) => ({ id, name: 'Rain', versions: [{ label: 'v1', body: 'a', params: take.params, values: {} }, { label: 'v2', body: take.body, params: take.params, values: {} }] })),
  }
  const register = vi.fn(), unregister = vi.fn()
  let ctxListener: ((s: 'lost' | 'restored') => void) | null = null
  let api!: ReturnType<typeof useEffectTakes>
  mount(defineComponent({ setup() {
    api = useEffectTakes({
      generate: generateTakes, callModel, renderer: () => renderer,
      input: async (o) => ({ request: o.request, count: 3, signal: o.signal }),
      library: library as any, register, unregister,
      onContextChange: (fn) => { ctxListener = fn; return () => {} },
      ...extra,
    })
    return () => h('div')
  } }))
  return { api, release, callModel, library, register, unregister, lose: () => ctxListener?.('lost') }
}
const tick = () => new Promise(r => setTimeout(r, 0))

describe('useEffectTakes', () => {
  it('three pending tiles; each take lands on a tile as it passes, registered as a draft', async () => {
    const { api, release, register } = setup()
    const run = api.start('rain on a window', target())
    await tick()
    expect(api.session.value!.tiles.map(t => t.state)).toEqual(['pending', 'pending', 'pending'])
    expect(api.session.value!.nodeLabel).toBe('Water ripple')
    release(1); await tick(); await tick()
    expect(api.session.value!.tiles.map(t => t.state)).toEqual(['ready', 'pending', 'pending'])
    const first = register.mock.calls[0]![0][0]
    expect(first).toMatchObject({ draft: true, name: SPIKE_TAKES.rain![1]!.name })
    expect(api.session.value!.tiles[0]!.takeId).toBe(first.id)
    expect(api.session.value!.tiles[0]!.thumb).toBe('data:thumb')
    release(0); release(2); await run
    expect(api.session.value!.tiles.every(t => t.state === 'ready')).toBe(true)
    expect(api.session.value!.loopDone).toBe(true)
    expect(api.working.value).toBe(false)
  })

  it('hover previews on the target; leaving goes back; choose sticks', async () => {
    const { api, release } = setup()
    const tg = target()
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    const id = api.session.value!.tiles[1]!.takeId!
    api.preview(id); expect(tg.preview).toHaveBeenLastCalledWith(id)
    api.preview(null); expect(tg.preview).toHaveBeenLastCalledWith(null)
    api.choose(id); api.preview(null); expect(tg.preview).toHaveBeenLastCalledWith(id)
    api.preview(CURRENT); expect(tg.preview).toHaveBeenLastCalledWith(null)
  })

  it('Keep on a new effect saves a My effect, applies it, drops the drafts, and says so', async () => {
    const { api, release, library, unregister } = setup()
    const tg = target({ base: { id: 'water_ripple', name: 'Water ripple' } as any })
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    const id = api.session.value!.tiles[0]!.takeId!
    expect(await api.keep(id)).toBe(true)
    expect(library.saveTake).toHaveBeenCalledWith(expect.objectContaining({ body: expect.any(String) }), { request: 'rain', from: 'Water ripple' })
    expect(tg.apply).toHaveBeenCalledWith('mine_aaaaaaaaaaaa', expect.any(Object))
    expect(unregister).toHaveBeenCalledWith(expect.arrayContaining([id]))
    expect(api.session.value).toBeNull()
    expect(api.notice.value).toBe(EFFECT_MESSAGES.savedNew(SPIKE_TAKES.rain![0]!.name))
  })

  it('Keep on a Remix of a My effect adds a version to it (an old-version def resolves to its effect)', async () => {
    const { api, release, library } = setup()
    const tg = target({ base: { id: 'mine_aaaaaaaaaaaa~v1', name: 'Rain · v1', mine: true, versionOf: 'mine_aaaaaaaaaaaa' } as any })
    const run = api.start('heavier', tg); release(0); release(1); release(2); await run
    await api.keep(api.session.value!.tiles[0]!.takeId!)
    expect(library.addCodeVersion).toHaveBeenCalledWith('mine_aaaaaaaaaaaa', expect.any(Object), 'heavier')
    expect(api.notice.value).toBe(EFFECT_MESSAGES.savedVersion('v2', 'Rain'))
  })

  it('a failed save keeps the strip open and shows why', async () => {
    const { api, release, library } = setup()
    library.saveTake.mockRejectedValueOnce(new Error('409'))
    const tg = target()
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    expect(await api.keep(api.session.value!.tiles[0]!.takeId!)).toBe(false)
    expect(api.session.value).not.toBeNull()
    expect(api.error.value).toContain('409')
    expect(tg.apply).not.toHaveBeenCalled()
  })

  it('Stop aborts the request, restores the target and clears partial takes', async () => {
    const { api, release } = setup()
    const tg = target()
    const run = api.start('rain', tg); release(0); await tick(); await tick()
    api.stop(); await run
    expect(api.session.value).toBeNull()
    expect(tg.preview).toHaveBeenLastCalledWith(null)
    expect(api.error.value).toBe('')
  })

  it('× closes: restore, drop drafts', async () => {
    const { api, release, unregister } = setup()
    const tg = target()
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    api.close()
    expect(tg.preview).toHaveBeenLastCalledWith(null)
    expect(unregister).toHaveBeenCalled()
    expect(api.session.value).toBeNull()
  })

  it('context loss while a take is on screen drops THAT take and restores', async () => {
    const { api, release, lose } = setup()
    const tg = target()
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    const id = api.session.value!.tiles[2]!.takeId!
    api.choose(id)
    lose()
    expect(api.session.value!.tiles[2]!.state).toBe('failed')
    expect(tg.preview).toHaveBeenLastCalledWith(null)
    expect(api.notice.value).toBe(EFFECT_MESSAGES.droppedTake)
  })

  it('an engine context loss ends the run with a plain message and nothing changed', async () => {
    const { ContextLostError } = await import('~/lib/shadergen/engine')
    const { api } = setup({ generate: vi.fn(async () => { throw new ContextLostError('gone') }) })
    const tg = target()
    await api.start('rain', tg)
    expect(api.session.value).toBeNull()
    expect(api.error.value).toBe(EFFECT_MESSAGES.contextLost)
    expect(tg.apply).not.toHaveBeenCalled()
  })

  it('Three more only once the set is done; it starts a fresh set', async () => {
    const { api, release, callModel, unregister } = setup()
    const run = api.start('rain', target())
    await tick()
    await api.more() // the set is still going: nothing happens
    expect(callModel.mock.calls.length).toBe(3)
    release(0); release(1); release(2); await run
    const before = api.session.value
    const drafts = before!.tiles.map(t => t.takeId)
    const again = api.more(); await tick()
    expect(callModel.mock.calls.length).toBe(6)
    expect(api.session.value).not.toBe(before)
    expect(api.session.value!.tiles.every(t => t.state === 'pending')).toBe(true)
    expect(unregister).toHaveBeenCalledWith(expect.arrayContaining(drafts))
    release(0, 1); release(1, 1); release(2, 1); await again
    expect(api.session.value!.tiles.every(t => t.state === 'ready')).toBe(true)
    expect(api.session.value!.tiles.some(t => drafts.includes(t.takeId))).toBe(false)
  })
})
