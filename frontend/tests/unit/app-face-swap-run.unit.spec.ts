/**
 * Step 3, R8.4: Face swap through useAppRun (lib/runner/faceSwapApp.ts, used
 * by components/apps/FaceSwapApp.vue).
 *
 * - Fake runner events: the price shows once both pictures and a gender are
 *   chosen, before the run; the swapped picture lands in a take, by node id;
 *   Stop; a refusal; a decline ("Face swap is switched off right now." in
 *   both places, nothing sent anywhere: there is no engine fallback).
 * - Through the kit (fake fal, ComfyUI off): the app's exact prompt makes
 *   the picture, the quote equals the hold, and Stop mid-call releases it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { FACE_SWAP_GENDER_DEFAULT } from '#shared/runner/faceSwap'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
import { QUOTE_FAILED, useAppRun, type AppQuote, type AppRunDeps } from '~/composables/useAppRun'
import { buildFaceSwapPrompt } from '~/lib/runner/awaitRunnerResult'
import { FACE_SWAP_NODE, FACE_SWAP_WORDS, faceSwapPromptOf, useFaceSwapRun, type FaceSwapChoice } from '~/lib/runner/faceSwapApp'
import type { AppTakeInput } from '~/composables/useAppTakes'
import { mapWsEvent } from '~/lib/graph/wsEventMap'
import { createFakeFal, makeKit, rgbPng1x1 } from './__runner__/kit'

const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'face-swap'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const CHOSEN: FaceSwapChoice = { face: { filename: 'face.png' }, target: { filename: 'target.png' }, gender: 'Female', keepHairFrom: 'The face photo' }
const PROMPT = buildFaceSwapPrompt({ face: 'face.png', target: 'target.png', gender: 'Female', keepHairFrom: 'The face photo' })

function fakeWindow() {
  const handlers = new Set<(e: MessageEvent) => void>()
  return {
    addEventListener: (_: string, h: any) => handlers.add(h),
    removeEventListener: (_: string, h: any) => handlers.delete(h),
    post: (data: Record<string, unknown>) => handlers.forEach(h => h({ data: { type: 'sailor-bridge', ...data } } as MessageEvent)),
    size: () => handlers.size,
  }
}

const file = (filename: string) => ({ filename, subfolder: 'user_1', type: 'output' })

function fakeDeps(o: Partial<AppRunDeps> = {}) {
  return {
    confirm: vi.fn(async () => true),
    postQuote: vi.fn(async (): Promise<AppQuote> => ({ usd: 0.075, credits: 8, upTo: false })),
    start: vi.fn(async () => ({ runId: 'run_1', legId: 'run_1.0', promptIds: ['run_1.0'] })),
    stop: vi.fn(async () => {}),
    ensureEvents: vi.fn(async () => {}),
    ...o,
  }
}

function setup(o: { hosted?: boolean, deps?: Partial<AppRunDeps>, choice?: FaceSwapChoice } = {}) {
  const deps = fakeDeps(o.deps)
  const hosted = o.hosted ?? false
  const w = fakeWindow()
  const choice = ref<FaceSwapChoice>(o.choice ?? { ...CHOSEN })
  const takes: AppTakeInput[] = []
  const app = useAppRun({ hosted, debounceMs: 0, deps })
  const s = useFaceSwapRun({ choice, addTake: t => takes.push(t), hosted, app, wait: { target: w } })
  return { deps, w, choice, takes, s }
}

describe('the prompt', () => {
  it('is the app\'s workflow once both pictures and a gender are chosen; runner-eligible with its families on, in both places', () => {
    expect(faceSwapPromptOf(CHOSEN)).toEqual(PROMPT)
    expect(faceSwapPromptOf({ ...CHOSEN, face: null })).toBeNull()
    expect(faceSwapPromptOf({ ...CHOSEN, target: null })).toBeNull()
    expect(faceSwapPromptOf({ ...CHOSEN, gender: FACE_SWAP_GENDER_DEFAULT })).toBeNull()
    for (const hosted of [true, false]) {
      expect(isRunnerEligible(PROMPT, ON, { hosted })).toBe(true)
      expect(isRunnerEligible(PROMPT, new Set<RunnerFamily>(['cards']), { hosted })).toBe(false)
      expect(isRunnerEligible(PROMPT, new Set<RunnerFamily>(), { hosted })).toBe(false)
    }
  })
})

describe('the app, fed fake runner events', () => {
  it('no price until a gender is chosen; then the price shows before the run, and the picture lands in a take by node id', async () => {
    const { deps, w, choice, takes, s } = setup({ choice: { ...CHOSEN, gender: FACE_SWAP_GENDER_DEFAULT } })
    await s.quote()
    expect(deps.postQuote).not.toHaveBeenCalled()
    expect(s.priceText.value).toBeNull()
    expect(s.canRun.value).toBe(false)

    choice.value = { ...CHOSEN }
    await s.quote()
    expect(deps.postQuote).toHaveBeenCalledWith({ takes: [PROMPT] }, expect.any(AbortSignal))
    expect(s.priceText.value).toBe('$0.07')
    expect(s.canRun.value).toBe(true)

    const done = s.run()
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    // Confirmed on the quote already shown: no second price check.
    expect(deps.postQuote).toHaveBeenCalledTimes(1)
    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ usd: 0.075, approximate: false }))
    expect(s.canStop.value).toBe(true)
    // Another node's picture is not the result.
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: '1', output: { images: [file('face.png')] } })
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: FACE_SWAP_NODE, output: { images: [file('face_swap_1.png')] } })
    await done
    expect(s.status.value).toBe('done')
    expect(takes).toHaveLength(1)
    expect(takes[0]!.promptId).toBe('run_1.0')
    expect(takes[0]!.images![0]).toContain('filename=face_swap_1.png')
    expect(takes[0]!.images![0]).toContain('subfolder=user_1')
    expect(w.size()).toBe(0)
  })

  it('in hosted the price is in credits', async () => {
    const { s } = setup({ hosted: true })
    await s.quote()
    expect(s.priceText.value).toBe('8 cr')
  })

  it('Stop ends this run: no take, back to idle, nothing left listening', async () => {
    const { deps, w, takes, s } = setup()
    await s.quote()
    const done = s.run()
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))
    await s.stop()
    expect(deps.stop).toHaveBeenCalledWith(['run_1'])
    w.post({ event: 'execution_complete', prompt_id: 'run_1.0', stopped: true })
    await done
    expect(s.status.value).toBe('idle')
    expect(s.errorMessage.value).toBeNull()
    expect(takes).toEqual([])
    expect(w.size()).toBe(0)
  })

  it('a refusal shows its words in place of the price, and the button stays off', async () => {
    const { s, deps } = setup({ deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ refused: 'This picture isn’t yours.' })) } })
    await s.quote()
    expect(s.priceText.value).toBeNull()
    expect(s.blocked.value).toBe('This picture isn’t yours.')
    expect(s.canRun.value).toBe(false)
    await s.run()
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('a run\'s error shows the runner\'s words', async () => {
    const { deps, w, takes, s } = setup()
    await s.quote()
    const done = s.run()
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    w.post({ event: 'execution_error', prompt_id: 'run_1.0', exception_message: 'The service couldn’t find a face.' })
    await done
    expect(s.status.value).toBe('error')
    expect(s.errorMessage.value).toBe('The service couldn’t find a face.')
    expect(takes).toEqual([])
  })

  it('"no" at the cost gate starts nothing', async () => {
    const { deps, s, takes } = setup({ deps: { confirm: vi.fn(async () => false) } })
    await s.quote()
    await s.run()
    expect(deps.start).not.toHaveBeenCalled()
    expect(s.status.value).toBe('idle')
    expect(takes).toEqual([])
  })

  for (const hosted of [false, true]) {
    it(`a decline ${hosted ? 'in hosted' : 'on this computer'}: "switched off", the button off, nothing sent (no engine fallback)`, async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const { s, deps } = setup({ hosted, deps: { postQuote: vi.fn(async (): Promise<AppQuote> => ({ declined: true })) } })
      await s.quote()
      expect(s.blocked.value).toBe(FACE_SWAP_WORDS.off)
      expect(s.priceText.value).toBeNull()
      expect(s.canRun.value).toBe(false)
      await s.run()
      expect(deps.start).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      fetchSpy.mockRestore()
    })

    it(`a decline at the start ${hosted ? 'in hosted' : 'on this computer'} says "switched off" too`, async () => {
      const declined = Object.assign(new Error('x'), { data: { data: { reason: RUNNER_NOT_ELIGIBLE } } })
      const { s, takes } = setup({ hosted, deps: { start: vi.fn(async () => { throw declined }) } })
      await s.quote()
      await s.run()
      expect(s.status.value).toBe('error')
      expect(s.errorMessage.value).toBe(FACE_SWAP_WORDS.off)
      expect(s.blocked.value).toBe(FACE_SWAP_WORDS.off)
      expect(s.canRun.value).toBe(false)
      expect(takes).toEqual([])
    })
  }

  it('a failed price check shows its words and leaves the button on; pressing it prices again', async () => {
    let calls = 0
    const postQuote = vi.fn(async (): Promise<AppQuote> => {
      if (calls++ === 0) throw Object.assign(new Error('fetch failed'), { statusCode: 500 })
      return { usd: 0.075, credits: 8, upTo: false }
    })
    const { s, deps, w, takes } = setup({ deps: { postQuote } })
    await s.quote()
    expect(s.blocked.value).toBe(QUOTE_FAILED)
    expect(s.canRun.value).toBe(true)
    const done = s.run()
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled())
    expect(postQuote).toHaveBeenCalledTimes(2)
    w.post({ event: 'executed', prompt_id: 'run_1.0', node_id: FACE_SWAP_NODE, output: { images: [file('f.png')] } })
    await done
    expect(takes).toHaveLength(1)
  })

  it('the app\'s words never name the engine, a port or a model', () => {
    for (const words of Object.values(FACE_SWAP_WORDS)) expect(words).not.toMatch(/comfy|8188|easel|fal|model/i)
  })
})

// ── Through the kit: ComfyUI off ─────────────────────────────────────────────

function kitApp(o: { hold?: boolean } = {}) {
  const fal = createFakeFal()
  if (o.hold) fal.holdNext(1)
  const k = makeKit({ hosted: true, fal, deps: { families: () => ON } })
  mkdirSync(join(k.root, 'input', 'user_1'), { recursive: true })
  for (const [name, bytes] of [['face.png', rgbPng1x1(200, 150, 120)], ['target.png', rgbPng1x1(90, 80, 70)]] as const) {
    writeFileSync(join(k.root, 'input', 'user_1', name), bytes)
    writeFileSync(join(k.root, 'input', name), bytes)
  }
  const w = fakeWindow()
  const started: string[] = []
  // The runner's events, as the browser's event stream hands them to the app.
  k.deps.events.subscribe(k.userId!, (m) => {
    const e = mapWsEvent(m as { type: string, data: any }, 'browser')
    if (e) w.post(e as unknown as Record<string, unknown>)
  })
  const deps: Partial<AppRunDeps> = {
    confirm: vi.fn(async () => true),
    postQuote: async body => k.engine.quoteRun({ userId: k.userId, takes: body.takes, ...START }),
    start: async (body) => {
      const leg = await k.engine.startRun({ userId: k.userId, ...body })
      started.push(leg.runId)
      return leg
    },
    stop: async ids => { await k.engine.stop(k.userId, ids) },
    ensureEvents: async () => {},
  }
  const takes: AppTakeInput[] = []
  const app = useAppRun({ hosted: true, debounceMs: 0, deps })
  const s = useFaceSwapRun({ choice: ref({ ...CHOSEN }), addTake: t => takes.push(t), hosted: true, app, wait: { target: w } })
  return { k, fal, s, takes, started }
}

describe('through the kit (ComfyUI off): the app\'s exact prompt', () => {
  it('quoted, then run: the quote equals the hold; the swapped picture lands in a take; charged no more than held', async () => {
    const { k, fal, s, takes, started } = kitApp()
    await s.quote()
    expect(s.priceText.value).toMatch(/^\d+ cr$/)
    const quoted = Number(/(\d+) cr/.exec(s.priceText.value!)![1])
    await s.run()
    expect(s.errorMessage.value).toBeNull()
    expect(s.status.value).toBe('done')
    expect(fal.submitted().length).toBe(1)
    expect(takes).toHaveLength(1)
    expect(decodeURIComponent(takes[0]!.images![0]!)).toMatch(/filename=.+\.(png|jpg|jpeg|webp)/)
    const runId = started[0]!
    await k.engine.settled(runId)
    const take = (await k.store.get(runId))!.takes[0]!
    for (const id of ['1', '2', '3']) expect(take.nodes[id]!.status, `${id}: ${take.nodes[id]!.error ?? ''}`).toBe('done')
    const holds = [...k.ledger.holds.values()]
    expect(holds.reduce((n, h) => n + h.credits, 0)).toBe(quoted)
    expect(holds.every(h => h.actual !== null && h.actual <= h.credits)).toBe(true)
  }, 60_000)

  it('Stop mid-call: the call cancelled, the hold released, no take', async () => {
    const { k, fal, s, takes } = kitApp({ hold: true })
    await s.quote()
    const done = s.run()
    for (let n = 0; n < 4000 && fal.submitted().length < 1; n++) await new Promise(r => setTimeout(r, 5))
    expect(fal.submitted().length).toBe(1)
    await s.stop()
    await done
    expect(s.status.value).toBe('idle')
    expect(takes).toEqual([])
    expect(fal.submitted()[0]!.cancelled).toBe(true)
    expect([...k.ledger.holds.values()].map(h => (h.state === 'released' ? 0 : h.actual))).toEqual([0])
  }, 60_000)
})
