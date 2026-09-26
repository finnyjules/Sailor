// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, effectScope, h } from 'vue'
import { mount } from '@vue/test-utils'
import { useEffectTakes, EFFECT_MESSAGES, type EffectTarget } from '~/composables/useEffectTakes'
import { generateTakes, type TakeRenderer } from '~/lib/shadergen/engine'
import { TAKE_ANGLES } from '~/lib/shadergen/prompt'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'
import { CURRENT } from '~/lib/prompt/takesSession'
import { MY_EFFECTS_ERRORS } from '~/lib/myEffects/client'
import { REFERENCE_ONLY_REQUEST } from '~/lib/prompt/referencePicture'

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
    ready: vi.fn(async () => {}),
    has: vi.fn((_id: string) => true),
  }
  const register = vi.fn(), unregister = vi.fn()
  let ctxListener: ((s: 'lost' | 'restored') => void) | null = null
  let api!: ReturnType<typeof useEffectTakes>
  const wrapper = mount(defineComponent({ setup() {
    api = useEffectTakes({
      generate: generateTakes, callModel, renderer: () => renderer,
      input: async (o) => ({ request: o.request, count: 3, signal: o.signal }),
      library: library as any, register, unregister,
      onContextChange: (fn) => { ctxListener = fn; return () => {} },
      ...extra,
    })
    return () => h('div')
  } }))
  return { api, release, callModel, library, register, unregister, wrapper, lose: () => ctxListener?.('lost') }
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

  it('hover previews on the target; leaving goes back', async () => {
    const { api, release } = setup()
    const tg = target()
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    const id = api.session.value!.tiles[1]!.takeId!
    api.preview(id); expect(tg.preview).toHaveBeenLastCalledWith(id)
    api.preview(null); expect(tg.preview).toHaveBeenLastCalledWith(null)
    api.preview(CURRENT); expect(tg.preview).toHaveBeenLastCalledWith(null)
  })

  it('Keep on a new effect saves a My effect, applies it, drops the drafts, and says so', async () => {
    const { api, release, library, unregister } = setup()
    const tg = target({ base: { id: 'water_ripple', name: 'Water ripple' } as any })
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    const id = api.session.value!.tiles[0]!.takeId!
    expect(await api.keep(id)).toBe(true)
    expect(library.saveTake).toHaveBeenCalledWith(expect.objectContaining({ body: expect.any(String) }), { request: 'rain', from: 'Water ripple' })
    expect(tg.apply).toHaveBeenCalledWith('mine_aaaaaaaaaaaa~v1', expect.any(Object))
    expect(unregister).toHaveBeenCalledWith(expect.arrayContaining([id]))
    expect(api.session.value).toBeNull()
    expect(api.notice.value).toBe(EFFECT_MESSAGES.savedNew(SPIKE_TAKES.rain![0]!.name))
  })

  it('⌘Z after Keep runs the target’s own undo once (the My effect stays saved)', async () => {
    const { api, release, library } = setup()
    const undo = vi.fn(() => true)
    const tg = target()
    tg.apply.mockImplementation(() => undo)
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    expect(api.undoKeep()).toBe(false) // nothing kept yet
    expect(await api.keep(api.session.value!.tiles[0]!.takeId!)).toBe(true)
    expect(api.undoKeep()).toBe(true)
    expect(undo).toHaveBeenCalledTimes(1)
    expect(api.undoKeep()).toBe(false)
    expect(library.saveTake).toHaveBeenCalledTimes(1)
  })

  it('Keep on a Remix of a My effect adds a version to it (an old-version def resolves to its effect)', async () => {
    const { api, release, library } = setup()
    const tg = target({ remix: true, base: { id: 'mine_aaaaaaaaaaaa~v1', name: 'Rain · v1', mine: true, versionOf: 'mine_aaaaaaaaaaaa' } as any })
    const run = api.start('heavier', tg); release(0); release(1); release(2); await run
    await api.keep(api.session.value!.tiles[0]!.takeId!)
    expect(library.ready).toHaveBeenCalled()
    expect(library.addCodeVersion).toHaveBeenCalledWith('mine_aaaaaaaaaaaa', expect.any(Object), 'heavier')
    // The target is pinned to the new version's own id.
    expect(tg.apply).toHaveBeenCalledWith('mine_aaaaaaaaaaaa~v2', expect.any(Object))
    expect(api.notice.value).toBe(EFFECT_MESSAGES.savedVersion('v2', 'Rain'))
  })

  it('a routed request (no Remix chip) on a My effect makes a NEW effect from it (Ruling #2)', async () => {
    const { api, release, library } = setup()
    const tg = target({ base: { id: 'mine_aaaaaaaaaaaa~v1', name: 'Ink bloom', mine: true } as any })
    const run = api.start('make it rain', tg); release(0); release(1); release(2); await run
    expect(await api.keep(api.session.value!.tiles[0]!.takeId!)).toBe(true)
    expect(library.addCodeVersion).not.toHaveBeenCalled()
    expect(library.saveTake).toHaveBeenCalledWith(expect.any(Object), { request: 'make it rain', from: 'Ink bloom' })
    expect(api.notice.value).toBe(EFFECT_MESSAGES.savedNew(SPIKE_TAKES.rain![0]!.name))
  })

  it('a new effect made from an older version says it came from the effect’s own name, never “Name · v1”', async () => {
    const { api, release, library } = setup()
    const base = { id: 'mine_aaaaaaaaaaaa~v1', name: 'Ink bloom · v1', mine: true, versionOf: 'mine_aaaaaaaaaaaa',
      versions: [{ label: 'v1', effectId: 'mine_aaaaaaaaaaaa~v1' }, { label: 'v2', effectId: 'mine_aaaaaaaaaaaa~v2' }] }
    for (const [round, b] of [base, { ...base, id: 'mine_aaaaaaaaaaaa' }].entries()) { // the stored bare id's alias is named like v1
      const run = api.start('make it rain', target({ base: b as any })); release(0, round); release(1, round); release(2, round); await run
      await api.keep(api.session.value!.tiles[0]!.takeId!)
      expect(library.saveTake).toHaveBeenLastCalledWith(expect.any(Object), { request: 'make it rain', from: 'Ink bloom' })
    }
  })

  it('a Remix of a My effect the library doesn’t hold (a shared copy, or a library that won’t load) saves a new one (Ruling #1)', async () => {
    const { api, release, library } = setup()
    library.has.mockReturnValue(false)
    const tg = target({ remix: true, base: { id: 'mine_bbbbbbbbbbbb~v1', name: 'Their bloom', mine: true } as any })
    const run = api.start('heavier', tg); release(0); release(1); release(2); await run
    expect(await api.keep(api.session.value!.tiles[0]!.takeId!)).toBe(true)
    expect(library.ready).toHaveBeenCalledBefore(library.has)
    expect(library.has).toHaveBeenCalledWith('mine_bbbbbbbbbbbb')
    expect(library.addCodeVersion).not.toHaveBeenCalled()
    expect(library.saveTake).toHaveBeenCalledWith(expect.any(Object), { request: 'heavier', from: 'Their bloom' })
    expect(tg.apply).toHaveBeenCalledWith('mine_aaaaaaaaaaaa~v1', expect.any(Object))
    expect(api.error.value).toBe('')
  })

  it('Keep stops the other takes when pressed, not when the save lands (final review #11)', async () => {
    const { api, release, library, callModel } = setup()
    let finish!: () => void
    library.saveTake.mockImplementationOnce((take: any) => new Promise(r => { finish = () => r({ id: 'mine_aaaaaaaaaaaa', name: take.name, versions: [{ label: 'v1', body: take.body, params: take.params, values: {} }] }) }))
    const tg = target()
    const run = api.start('rain', tg); release(0); await tick(); await tick()
    const kept = api.keep(api.session.value!.tiles[0]!.takeId!)
    for (const call of callModel.mock.calls) expect((call[2] as AbortSignal).aborted).toBe(true)
    expect(api.working.value).toBe(false)
    expect(api.session.value!.tiles.map(t => t.state)).toEqual(['ready', 'failed', 'failed'])
    finish()
    expect(await kept).toBe(true)
    await run
    expect(tg.apply).toHaveBeenCalledWith('mine_aaaaaaaaaaaa~v1', expect.any(Object))
  })

  it('a failed save keeps the strip open and says so in a plain sentence, never the raw error', async () => {
    const { api, release, library } = setup()
    library.saveTake.mockRejectedValueOnce(new Error('[PUT] "/api/my-effects/mine_aaaaaaaaaaaa": 409 Conflict'))
    const tg = target()
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    expect(await api.keep(api.session.value!.tiles[0]!.takeId!)).toBe(false)
    expect(api.session.value).not.toBeNull()
    expect(api.error.value).toBe('Couldn’t save to My effects. Try again in a moment.')
    expect(api.error.value).not.toMatch(/409|\/api|mine_/)
    expect(tg.apply).not.toHaveBeenCalled()
    // My effects' own plain sentences pass through as they are.
    library.saveTake.mockRejectedValueOnce(new Error(MY_EFFECTS_ERRORS.tooLarge))
    expect(await api.keep(api.session.value!.tiles[0]!.takeId!)).toBe(false)
    expect(api.error.value).toBe(MY_EFFECTS_ERRORS.tooLarge)
  })

  it('a general failure ends the run with a plain sentence, not the raw error', async () => {
    const { api } = setup({ generate: vi.fn(async () => { throw new Error('[POST] "/api/shader-gen": 500 Internal Server Error') }) })
    const tg = target()
    await api.start('rain', tg)
    expect(api.session.value).toBeNull()
    expect(api.error.value).toBe(EFFECT_MESSAGES.failed)
    expect(tg.apply).not.toHaveBeenCalled()
  })

  it('a credits refusal on every call says so plainly; no status code or route reaches the strip', async () => {
    const refusal = Object.assign(new Error('[POST] "/api/shader-gen": 402 Payment Required'), { statusCode: 402 })
    const { api } = setup({ callModel: vi.fn(async () => { throw refusal }) })
    await api.start('rain', target())
    expect(api.error.value).toBe(EFFECT_MESSAGES.noCredits)
    expect(api.session.value!.tiles.every(t => t.state === 'failed')).toBe(true)
    const visible = JSON.stringify({ session: api.session.value, error: api.error.value, notice: api.notice.value })
    expect(visible).not.toMatch(/402|\/api|Payment Required|model error/)
  })

  it('some slots refused for credits (the hold): their tiles say so and the strip gives the credits sentence', async () => {
    const refusal = Object.assign(new Error('[POST] "/api/shader-gen": 402 Payment Required'), { statusCode: 402 })
    // Slot 0 comes back; slots 1 and 2 are refused by the hosted meter.
    const callModel = vi.fn(async (prompt: string) => {
      const s = slotOf(prompt)
      if (s === 0) return { text: JSON.stringify(SPIKE_TAKES.rain![0]) }
      throw refusal
    })
    const { api } = setup({ callModel })
    await api.start('rain', target())
    const tiles = api.session.value!.tiles
    expect(tiles.filter(t => t.state === 'ready')).toHaveLength(1)
    expect(tiles.filter(t => t.state === 'failed').map(t => t.reason)).toEqual(['credits', 'credits'])
    expect(api.error.value).toBe(EFFECT_MESSAGES.noCredits)
  })

  it('takes that fail their checks are not called credits refusals', async () => {
    const judge = vi.fn(() => ({ pass: false, flags: ['blank'], thumbnail: '' }))
    const { api, release } = setup({ renderer: () => ({ ...renderer, judge }) })
    const run = api.start('rain', target())
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) release(s, r)
    await run
    // Each tile says why in its own words (a check's reason), never that credits ran out.
    expect(api.session.value!.tiles.every(t => t.state === 'failed' && t.reason === 'looks')).toBe(true)
    expect(api.error.value).toBe('')
  })

  it('each set\'s take renderer is released: one live at most, none once a set ends', async () => {
    let live = 0, made = 0
    const renderers = () => { made++; live++; let gone = false; return { ...renderer, dispose: () => { if (!gone) { gone = true; live-- } } } }
    const { api, release } = setup({ renderer: renderers })
    const run = api.start('rain', target()); await tick(); await tick()
    expect(live).toBe(1) // in use while the set is written
    release(0); release(1); release(2); await run
    expect(live).toBe(0) // settled
    const again = api.more(); await tick(); await tick()
    expect(live).toBe(1)
    const third = api.more() // not done yet: ignored
    await third
    api.stop(); await again
    expect(live).toBe(0) // stopped
    const tg = target()
    const four = api.start('rain', tg); await tick(); await tick()
    const five = api.start('snow', tg); await tick(); await tick() // replaced mid-set
    expect(live).toBe(1)
    api.close(); await four; await five
    expect(made).toBe(4)
    expect(live).toBe(0)
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
    const { api, release, lose, unregister } = setup()
    const tg = target()
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    const id = api.session.value!.tiles[2]!.takeId!
    api.preview(id)
    lose()
    expect(api.session.value!.tiles[2]!.state).toBe('failed')
    expect(tg.preview).toHaveBeenLastCalledWith(null)
    expect(api.notice.value).toBe(EFFECT_MESSAGES.droppedTake)
    expect(unregister).toHaveBeenCalledWith([id])
    // Only that one: the other drafts stay registered until the strip closes.
    expect(unregister.mock.calls.flat(2)).toEqual([id])
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

  // --- fix round 1 -------------------------------------------------------------

  it('a second Keep while the first is saving is ignored: one save, and `saving` says so', async () => {
    const { api, release, library } = setup()
    let finish!: (r: any) => void
    library.saveTake.mockImplementationOnce((take: any) => new Promise(r => { finish = () => r({ id: 'mine_aaaaaaaaaaaa', name: take.name, versions: [{ label: 'v1', body: take.body, params: take.params, values: {} }] }) }))
    const tg = target()
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    const [a, b] = api.session.value!.tiles.map(t => t.takeId!)
    const first = api.keep(a!)
    expect(api.saving.value).toBe(true)
    expect(await api.keep(a!)).toBe(false) // double-click
    expect(await api.keep(b!)).toBe(false) // Keep on another tile
    finish(null)
    expect(await first).toBe(true)
    expect(library.saveTake).toHaveBeenCalledTimes(1)
    expect(tg.apply).toHaveBeenCalledTimes(1)
    expect(api.saving.value).toBe(false)
  })

  it('a run that ends on an error aborts its other slots, so their model calls stop', async () => {
    const { ContextLostError } = await import('~/lib/shadergen/engine')
    const lostOnFirst: TakeRenderer = { ...renderer, compile: () => { throw new ContextLostError('gone') } }
    const { api, release, callModel } = setup({ renderer: () => lostOnFirst })
    const run = api.start('rain', target()); await tick()
    expect(callModel).toHaveBeenCalledTimes(3)
    release(0); await run
    expect(api.error.value).toBe(EFFECT_MESSAGES.contextLost)
    for (const call of callModel.mock.calls) expect((call[2] as AbortSignal).aborted).toBe(true)
  })

  it('a slot that gives up shows failed at once, not at the end of the set', async () => {
    const { callModel: gated, release } = cannedModel()
    const callModel = vi.fn(async (prompt: string, i?: string[], signal?: AbortSignal) => {
      if (slotOf(prompt) === 1) throw new Error('[POST] "/api/shader-gen": 500 Internal Server Error')
      return gated(prompt, i, signal)
    })
    const { api } = setup({ callModel })
    const run = api.start('rain', target()); await tick(); await tick()
    expect(api.session.value!.tiles.map(t => t.state)).toEqual(['pending', 'pending', 'failed'])
    release(0); await tick(); await tick()
    expect(api.session.value!.tiles.map(t => t.state)).toEqual(['ready', 'pending', 'failed'])
    release(2); await run
    expect(api.session.value!.tiles.map(t => t.state)).toEqual(['ready', 'ready', 'failed'])
    expect(api.error.value).toBe('') // two takes came back: the strip says the rest
  })

  it('a take that lands after Stop is ignored and never registered', async () => {
    // A model call that ignores the abort signal and answers anyway.
    let answer!: () => void
    const late = new Promise<void>(r => { answer = r })
    const callModel = vi.fn(async (prompt: string) => { await late; return { text: JSON.stringify(SPIKE_TAKES.rain![slotOf(prompt)]) } })
    const { api, register } = setup({ callModel })
    const tg = target()
    const run = api.start('rain', tg); await tick()
    api.stop()
    answer(); await run; await tick(); await tick()
    expect(register).not.toHaveBeenCalled()
    expect(api.session.value).toBeNull()
    expect(api.working.value).toBe(false)
  })

  it('Keep before the set finishes saves and applies it, stops the rest, and later takes are ignored', async () => {
    const { api, release, register, callModel, library } = setup()
    const tg = target()
    const run = api.start('rain', tg); release(0); await tick(); await tick()
    const id = api.session.value!.tiles[0]!.takeId!
    expect(await api.keep(id)).toBe(true)
    expect(library.saveTake).toHaveBeenCalledTimes(1)
    expect(tg.apply).toHaveBeenCalledWith('mine_aaaaaaaaaaaa~v1', expect.any(Object))
    expect(api.session.value).toBeNull()
    for (const call of callModel.mock.calls) expect((call[2] as AbortSignal).aborted).toBe(true)
    release(1); release(2); await run; await tick()
    expect(register).toHaveBeenCalledTimes(1)
    expect(api.working.value).toBe(false)
  })

  it('Keep racing ×: the save stands and says so, but the target is left as × restored it', async () => {
    const { api, release, library } = setup()
    let finish!: () => void
    library.saveTake.mockImplementationOnce((take: any) => new Promise(r => { finish = () => r({ id: 'mine_aaaaaaaaaaaa', name: take.name, versions: [{ label: 'v1', body: take.body, params: take.params, values: {} }] }) }))
    const tg = target()
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    const kept = api.keep(api.session.value!.tiles[0]!.takeId!)
    api.close()
    finish()
    expect(await kept).toBe(true)
    expect(tg.apply).not.toHaveBeenCalled()
    expect(tg.preview).toHaveBeenLastCalledWith(null)
    expect(api.notice.value).toBe(EFFECT_MESSAGES.savedNew(SPIKE_TAKES.rain![0]!.name))
  })

  it('a replaced set releases its take renderer before the new one is made', async () => {
    let live = 0
    const renderers = () => { live++; let gone = false; return { ...renderer, dispose: () => { if (!gone) { gone = true; live-- } } } }
    const { api } = setup({ renderer: renderers })
    const tg = target()
    const one = api.start('rain', tg); await tick(); await tick()
    expect(live).toBe(1)
    const two = api.start('snow', tg)
    expect(live).toBe(0) // synchronously, before the new set builds its own
    await tick(); await tick()
    expect(live).toBe(1)
    api.close()
    expect(live).toBe(0)
    await one; await two
  })

  it('the strip quotes the trimmed request', async () => {
    const { api, release } = setup()
    const run = api.start('  rain on a window  ', target()); release(0); release(1); release(2); await run
    expect(api.session.value!.request).toBe('rain on a window')
    expect(api.request.value).toBe('rain on a window')
  })

  it('unmount closes the strip, restores the target and releases the context listener', async () => {
    const { api, release, wrapper, unregister } = setup()
    const tg = target()
    const run = api.start('rain', tg); release(0); release(1); release(2); await run
    wrapper.unmount()
    expect(tg.preview).toHaveBeenLastCalledWith(null)
    expect(unregister).toHaveBeenCalled()
    expect(api.session.value).toBeNull()
  })

  it('outside a component, stopping its effect scope releases the context listener', () => {
    const off = vi.fn()
    const scope = effectScope()
    scope.run(() => useEffectTakes({ onContextChange: () => off, library: {} as any }))
    expect(off).not.toHaveBeenCalled()
    scope.stop()
    expect(off).toHaveBeenCalledTimes(1)
  })
  describe('a reference picture (the look to aim for)', () => {
    it('goes to the request with the target’s own picture, and Three more reuses it', async () => {
      const input = vi.fn(async (o: any) => ({ request: o.request, count: 3, signal: o.signal }))
      const { api, release } = setup({ input })
      const run = api.start('like this, but slower', target(), { reference: 'data:image/jpeg;base64,REF' })
      release(0); release(1); release(2); await run
      expect(input).toHaveBeenLastCalledWith(expect.objectContaining({ request: 'like this, but slower', reference: 'data:image/jpeg;base64,REF' }))
      expect(api.reference.value).toBe('data:image/jpeg;base64,REF')
      const again = api.more(); await tick(); await tick()
      expect(input).toHaveBeenCalledTimes(2)
      expect(input).toHaveBeenLastCalledWith(expect.objectContaining({ reference: 'data:image/jpeg;base64,REF' }))
      release(0, 1); release(1, 1); release(2, 1); await again
    })
    it('a picture with no words asks to match its look', async () => {
      const input = vi.fn(async (o: any) => ({ request: o.request, count: 3, signal: o.signal }))
      const { api, release } = setup({ input })
      const run = api.start('  ', target(), { reference: 'data:image/jpeg;base64,REF' })
      release(0); release(1); release(2); await run
      expect(api.request.value).toBe(REFERENCE_ONLY_REQUEST)
      expect(input).toHaveBeenLastCalledWith(expect.objectContaining({ request: REFERENCE_ONLY_REQUEST }))
    })
    it('no reference: none is sent, and closing the set forgets it', async () => {
      const input = vi.fn(async (o: any) => ({ request: o.request, count: 3, signal: o.signal }))
      const { api, release } = setup({ input })
      let run = api.start('rain', target(), { reference: 'data:image/jpeg;base64,REF' }); release(0); release(1); release(2); await run
      api.close()
      expect(api.reference.value).toBeNull()
      run = api.start('rain', target()); release(0, 1); release(1, 1); release(2, 1); await run
      expect(input.mock.calls.at(-1)![0].reference ?? null).toBeNull()
    })
  })
})

describe('useEffectTakes: what the takes are for (the brief, 2026-09-26)', () => {
  it('tells the request where the takes will live and the shape of the picture they run over', async () => {
    const input = vi.fn(async (o: any) => ({ request: o.request, count: 3, signal: o.signal }))
    const { api, release } = setup({ input })
    const run = api.start('rain', target({ key: 'frame-background', image: () => ({ width: 1080, height: 1350 }) as any }))
    release(0); release(1); release(2); await run
    expect(input.mock.calls.at(-1)![0].target).toEqual({ place: 'frame-background', aspect: 0.8 })
  })
  it('a canvas node with no picture: its place, no aspect', async () => {
    const input = vi.fn(async (o: any) => ({ request: o.request, count: 3, signal: o.signal }))
    const { api, release } = setup({ input })
    const run = api.start('rain', target())
    release(0); release(1); release(2); await run
    expect(input.mock.calls.at(-1)![0].target).toEqual({ place: 'canvas-node' })
  })
})
