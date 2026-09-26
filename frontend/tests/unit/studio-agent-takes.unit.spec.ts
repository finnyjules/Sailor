// Four Takes (Task 4) — the composable seam. These specs drive `useStudioAgent`
// itself, with `/api/vibe` stubbed, because that composable is the ONE
// choke-point all four vibe studios (Gradient, Shader, Shape, Vector Type) get
// the strip through — a bug here is a bug in every one of them.
//
// Node env (same reason `takes-spread.unit.spec.ts` gives): `ofetch` is not
// linked into this package, so only the node loader lets `vi.mock` intercept it,
// and the pick log's storage is stubbed explicitly rather than inherited.
//
// Honest about what is NOT proven here: no thumbnail pixel is real (there is no
// `document`, so every adapter resolves `null` through its own catch — which is
// exactly the error-tile path, and is asserted as such), and no pointer is real
// (per the house rule, synthetic events prove nothing about hover). Task 5's
// live pass owns both.
//
// The ONE exception: the "pick log" describe block's visualDiff tests need a
// genuinely comparable pair of thumbnails to prove `logTake` writes a real
// number rather than always omitting the field. Rather than faking `document`
// (which would change what every OTHER test's real, WebGL-less adapter throws
// on), those two takeThumbFor/thumbDistance seams below are patched to notice
// one marker property, `__fakeShade` — present only in that block's own fixture
// — and fall through to the real implementation for everything else, so no
// other test in this file is affected.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const fetchMock = vi.fn()
vi.mock('ofetch', () => ({ $fetch: (...args: unknown[]) => fetchMock(...args) }))
// `useVibeControl` reaches for Nuxt's auto-imported `$fetch` / `useLocalSettings`
// as free identifiers; in a plain vitest module those resolve off globalThis.
;(globalThis as any).$fetch = (...args: unknown[]) => fetchMock(...args)
;(globalThis as any).useLocalSettings = () => ({ getLocalSetting: () => 'test-key' })

vi.mock('~/lib/agent/takeThumbs', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/lib/agent/takeThumbs')>()
  return {
    ...real,
    takeThumbFor: (studioId: string) => {
      const realAdapter = real.takeThumbFor(studioId)
      return async (config: unknown, size?: number, aspect?: number) => {
        const shade = (config as any)?.__fakeShade
        if (typeof shade === 'number') return { __shade: shade } as any
        return realAdapter(config, size, aspect)
      }
    },
  }
})
vi.mock('~/lib/agent/takes', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/lib/agent/takes')>()
  const isFake = (t: unknown): t is { __shade: number } =>
    !!t && typeof t === 'object' && typeof (t as any).__shade === 'number'
  return {
    ...real,
    thumbDistance: (a: unknown, b: unknown) =>
      isFake(a) && isFake(b) ? Math.abs(a.__shade - b.__shade) : real.thumbDistance(a as any, b as any),
  }
})

import { useStudioAgent } from '~/composables/useStudioAgent'
import { makeConfigParams } from '~/lib/agent/configParams'
import { readTakeLog, TAKE_LOG_KEY, type StudioTake } from '~/lib/agent/takes'
import { VARIANTS_UNSUPPORTED } from '~/lib/vibePrompt'
import type { ControlSpec } from '~/lib/spacetype/effect'
// The actual server-side salvage function (live owner report #2), not a
// hand-typed stand-in for it — proves the wire-through end to end: a raw
// model reply too ragged for the old hard-502 path, run through the SAME
// function /api/vibe calls, produces exactly what the client is fed below.
import { shapeTakesResponse } from '../../server/api/vibe.post'

const CONTROLS: ControlSpec[] = [
  { key: 'hue', label: 'Hue', kind: 'slider', min: 0, max: 360, step: 1, default: 0 },
  { key: 'softness', label: 'Softness', kind: 'slider', min: 0, max: 1, step: 0.1, default: 0.5 },
  // Deliberately ABSENT from the starting config — restoring a key the config
  // never had must not leave a fabricated one behind.
  { key: 'grain', label: 'Grain', kind: 'slider', min: 0, max: 1, step: 0.1, default: 0 },
  { key: 'mood', label: 'Mood', kind: 'select', options: ['calm', 'loud'], default: 'calm' },
]

const TAKES = [
  { label: 'warmer', changes: [{ key: 'hue', value: 40 }], rationale: 'pushes amber' },
  { label: 'softer', changes: [{ key: 'softness', value: 0.8 }], rationale: 'softer edges' },
  { label: 'grainy', changes: [{ key: 'grain', value: 0.6 }], rationale: 'adds tooth' },
]

function startConfig() {
  return { hue: 10, softness: 0.2, mood: 'calm' } as Record<string, unknown>
}

function makeAgent(over: Record<string, unknown> = {}) {
  const config = startConfig()
  const params = makeConfigParams(() => config)
  const agent = useStudioAgent({
    controls: () => CONTROLS,
    params,
    label: () => 'Test studio',
    takes: { studio: 'gradient', config: () => config, paramsOf: (c: unknown) => makeConfigParams(() => c) },
    ...over,
  } as any)
  return { agent, config }
}

/** Let the fire-and-forget thumbnail stream settle. */
const settle = () => new Promise(r => setTimeout(r, 0))

// The pick log's only storage, stubbed the way `takes-spread.unit.spec.ts`
// stubs it — a real Map behind the two methods `logTakeEvent` uses.
const store = new Map<string, string>()
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
}
;(globalThis as any).window = { localStorage }
afterAll(() => { delete (globalThis as any).window })

beforeEach(() => {
  fetchMock.mockReset()
  store.clear()
})

describe('useStudioAgent — asking for takes', () => {
  it('asks /api/vibe for three variants and populates the strip', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent } = makeAgent()

    await agent.ask('make it dreamier')

    const [url, opts] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/vibe')
    expect((opts as any).body.variants).toBe(3)
    expect((opts as any).body.phrase).toBe('make it dreamier')
    expect(agent.hasTakes.value).toBe(true)
    expect(agent.takes.value.map((t: StudioTake) => t.label)).toEqual(['warmer', 'softer', 'grainy'])
    // Multi-take REPLACES the single proposal UI.
    expect(agent.hasProposal.value).toBe(false)
    expect(agent.selectedTake.value).toBeNull()
  })

  it('shows the strip before any thumbnail exists, then streams them in', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent } = makeAgent()

    await agent.ask('dreamier')
    // The strip is up with nothing drawn yet: every tile is PENDING (no map
    // entry), which is what lets the strip tell "still drawing" from "failed".
    expect(agent.takes.value).toHaveLength(3)
    expect(agent.takeThumbs.value.size).toBe(0)

    await settle()
    // happy-dom has no WebGL, so each adapter resolves null through its own
    // catch — the entry EXISTS (resolved), and its value is the error tile.
    expect(agent.takeThumbs.value.size).toBe(3)
    for (const t of agent.takes.value) {
      expect(agent.takeThumbs.value.has(t)).toBe(true)
      expect(agent.takeThumbs.value.get(t)).toBeNull()
    }
  })

  it('validates and clamps every take through the existing validatePatch path', async () => {
    fetchMock.mockResolvedValue({
      takes: [
        { label: 'over', changes: [{ key: 'hue', value: 9999 }, { key: 'nope', value: 1 }], rationale: '' },
        { label: 'bad enum', changes: [{ key: 'mood', value: 'purple' }, { key: 'softness', value: 0.83 }], rationale: '' },
      ],
    })
    const { agent } = makeAgent()
    await agent.ask('go wild')

    expect(agent.takes.value[0]!.changes).toEqual([{ key: 'hue', value: 360 }])
    expect(agent.takes.value[1]!.changes).toEqual([{ key: 'softness', value: 0.8 }])
  })
})

describe('useStudioAgent — hover preview is non-destructive', () => {
  it('applies a take on hover and restores a byte-identical config on unhover', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent, config } = makeAgent()
    await agent.ask('dreamier')
    const before = JSON.stringify(config)

    agent.previewTake(agent.takes.value[0])
    expect(config.hue).toBe(40)
    agent.previewTake(null)
    expect(JSON.stringify(config)).toBe(before)

    // …and a take touching a key the config never had must not leave one behind.
    agent.previewTake(agent.takes.value[2])
    expect(config.grain).toBe(0.6)
    agent.previewTake(null)
    expect(JSON.stringify(config)).toBe(before)
    expect(config.grain).toBeUndefined()
  })

  it('captures the original ONCE — hovering three takes in a row still restores it', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent, config } = makeAgent()
    await agent.ask('dreamier')
    const before = JSON.stringify(config)

    for (const t of agent.takes.value) agent.previewTake(t)
    agent.previewTake(null)
    expect(JSON.stringify(config)).toBe(before)
  })

  it('unhovering falls back to the SELECTED take, not the original', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent, config } = makeAgent()
    await agent.ask('dreamier')

    agent.selectTake(agent.takes.value[1])
    expect(config.softness).toBe(0.8)
    agent.previewTake(agent.takes.value[0])
    expect(config.hue).toBe(40)
    agent.previewTake(null)
    expect(config.softness).toBe(0.8)
    expect(config.hue).toBe(10)
  })

  it('dismiss restores byte-identically and closes the strip', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent, config } = makeAgent()
    await agent.ask('dreamier')
    const before = JSON.stringify(config)

    agent.selectTake(agent.takes.value[0])
    agent.dismissTakes()
    expect(JSON.stringify(config)).toBe(before)
    expect(agent.hasTakes.value).toBe(false)
    expect(agent.selectedTake.value).toBeNull()
  })

  it('clicking "yours" reselects the original without closing the strip', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent, config } = makeAgent()
    await agent.ask('dreamier')
    const before = JSON.stringify(config)

    agent.selectTake(agent.takes.value[0])
    agent.selectTake(null)
    expect(JSON.stringify(config)).toBe(before)
    expect(agent.hasTakes.value).toBe(true)
    expect(agent.selectedTake.value).toBeNull()
  })
})

describe('useStudioAgent — keep commits through the existing path', () => {
  it('⌘Z after a keep puts back what it replaced, in one step, and only once', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent, config } = makeAgent()
    await agent.ask('dreamier')
    const before = JSON.stringify(config)
    agent.previewTake(agent.takes.value[1]) // a hover never becomes the "before"
    agent.selectTake(agent.takes.value[0])
    agent.keepTake()
    expect(config.hue).toBe(40)
    expect(agent.undoKeep()).toBe(true)
    expect(JSON.stringify(config)).toBe(before)
    expect(agent.undoKeep()).toBe(false) // nothing more to undo
  })

  it('an edit made after the keep is never thrown away by ⌘Z', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent, config } = makeAgent()
    await agent.ask('dreamier')
    agent.selectTake(agent.takes.value[0])
    agent.keepTake()
    config.softness = 0.9
    expect(agent.undoKeep()).toBe(false)
    expect(config.hue).toBe(40)
    expect(config.softness).toBe(0.9)
  })

  it('writes the take through the same writer accept used, then commits', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent, config } = makeAgent()
    await agent.ask('dreamier')

    agent.selectTake(agent.takes.value[0])
    agent.keepTake()

    expect(config.hue).toBe(40)
    expect(agent.hasTakes.value).toBe(false)
    // Committed exactly as `keep()` always did: the proposal is gone AND the
    // undo record is cleared, so a later revert() cannot resurrect the old value.
    expect(agent.hasProposal.value).toBe(false)
    agent.revert()
    expect(config.hue).toBe(40)
  })

  it('routes through recompute() + keep(), not a private writer', async () => {
    // Source pin (house convention): the point of "the existing apply path" is
    // that undo/autosave integration follows from it, which a behavioural
    // assertion alone cannot distinguish from an identical private write.
    const fs = await import('node:fs')
    const src = fs.readFileSync(`${process.cwd()}/app/composables/useStudioAgent.ts`, 'utf8')
    const body = src.slice(src.indexOf('function keepTake'))
    expect(body).toMatch(/recompute\(\)/)
    expect(body).toMatch(/\bkeep\(\)/)
  })

  it('keeping a take that changes nothing new is a no-op, not a crash', async () => {
    fetchMock.mockResolvedValue({ takes: [
      { label: 'same', changes: [{ key: 'hue', value: 10 }], rationale: '' },
      { label: 'other', changes: [{ key: 'hue', value: 20 }], rationale: '' },
    ] })
    const { agent, config } = makeAgent()
    await agent.ask('dreamier')
    agent.selectTake(agent.takes.value[0])
    agent.keepTake()
    expect(config.hue).toBe(10)
    expect(agent.hasTakes.value).toBe(false)
  })
})

describe('useStudioAgent — ↻ different directions', () => {
  it('↻ different directions refetches with variants and a different phrase', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent } = makeAgent()
    await agent.ask('dreamier')
    const first = (fetchMock.mock.calls[0]![1] as any).body.phrase

    await agent.moreDirections()

    expect(fetchMock.mock.calls).toHaveLength(2)
    const second = (fetchMock.mock.calls[1]![1] as any).body
    expect(second.variants).toBe(3)
    expect(second.phrase).not.toBe(first)
    expect(second.phrase).toContain('dreamier')
  })

  it('a failed ↻ leaves no tile ringed over a config it is not showing', async () => {
    fetchMock.mockResolvedValueOnce({ takes: TAKES })
    const { agent, config } = makeAgent()
    await agent.ask('dreamier')
    const before = JSON.stringify(config)
    agent.selectTake(agent.takes.value[0])

    fetchMock.mockRejectedValueOnce(new Error('Overloaded'))
    await agent.moreDirections()

    expect(agent.error.value).toContain('Overloaded')
    expect(agent.hasTakes.value).toBe(true) // the old strip is still usable
    expect(agent.selectedTake.value).toBeNull()
    expect(JSON.stringify(config)).toBe(before)
  })

  it('↻ restores the original before refetching, so the next capture is honest', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent, config } = makeAgent()
    await agent.ask('dreamier')
    const before = JSON.stringify(config)

    agent.selectTake(agent.takes.value[0])
    await agent.moreDirections()
    agent.previewTake(null)
    expect(JSON.stringify(config)).toBe(before)
  })
})

describe('useStudioAgent — the pick log', () => {
  it('appends keep, dismiss and switch events', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent } = makeAgent()
    await agent.ask('dreamier')

    agent.selectTake(agent.takes.value[0])
    agent.selectTake(agent.takes.value[1])
    agent.dismissTakes()

    await agent.ask('dreamier')
    agent.selectTake(agent.takes.value[2])
    agent.keepTake()

    const log = readTakeLog()
    expect(log.map(e => e.action)).toEqual(['switch', 'switch', 'dismiss', 'switch', 'keep'])
    expect(log.map(e => e.takeLabel)).toEqual(['warmer', 'softer', 'softer', 'grainy', 'grainy'])
    expect(new Set(log.map(e => e.studio))).toEqual(new Set(['gradient']))
    expect(new Set(log.map(e => e.prompt))).toEqual(new Set(['dreamier']))
    expect(localStorage.getItem(TAKE_LOG_KEY)).toBeTruthy()
  })

  it('logs the yours-click as a switch back to the original', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent } = makeAgent()
    await agent.ask('dreamier')
    agent.selectTake(agent.takes.value[0])
    agent.selectTake(null)
    expect(readTakeLog().at(-1)).toMatchObject({ action: 'switch', takeLabel: 'yours', changes: [] })
  })

  // Migrated from the deleted `take-variations-visual.unit.spec.ts` (its
  // variations/spread coverage went with the feature; these two prove the
  // SHARED, non-spread `visualDiff` logging path, which nothing else here
  // exercises). See the module-header note above for the `__fakeShade` seam.
  it('writes a visualDiff score alongside the decision', async () => {
    const VISUAL_CONTROLS: ControlSpec[] = [
      ...CONTROLS,
      { key: '__fakeShade', label: 'Fake shade', kind: 'slider', min: 0, max: 255, step: 1, default: 0 },
    ]
    // "yours" renders shade 40; the picked take renders shade 200 — visualDiff
    // is the plain difference between the two, the same maths `pixelDistance`
    // does over real pixels (covered for real elsewhere; this test is about
    // `logTake` writing the number at all, not about the pixel maths itself).
    const config = { ...startConfig(), __fakeShade: 40 } as Record<string, unknown>
    const params = makeConfigParams(() => config)
    const agent = useStudioAgent({
      controls: () => VISUAL_CONTROLS,
      params,
      label: () => 'Test studio',
      takes: { studio: 'gradient', config: () => config, paramsOf: (c: unknown) => makeConfigParams(() => c) },
    } as any)
    fetchMock.mockResolvedValue({
      takes: [
        { label: 'warmer', changes: [{ key: 'hue', value: 40 }, { key: '__fakeShade', value: 200 }], rationale: 'pushes amber' },
        { label: 'softer', changes: [{ key: 'softness', value: 0.8 }, { key: '__fakeShade', value: 90 }], rationale: 'softer edges' },
      ],
    })
    await agent.ask('dreamier')
    await settle()

    agent.selectTake(agent.takes.value[0])
    const ev = readTakeLog().at(-1)!
    expect(ev.action).toBe('switch')
    expect(ev.visualDiff).toBe(160) // |200 − 40|
  })

  it('omits the field rather than logging a fake 0 when it cannot be measured', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent } = makeAgent()
    await agent.ask('dreamier')
    // No settle: the thumbnails have not landed, so there is nothing to compare.
    agent.selectTake(agent.takes.value[0])
    expect(readTakeLog().at(-1)!.visualDiff).toBeUndefined()
  })
})

// ── the whole-look macro (Gradient's `preset`) ──────────────────────────────
//
// The shipped defect: the studio offered no macro, the guidance taught
// PRESET-FIRST anyway, so the model answered `{"preset":"sunset", …}`,
// validatePatch dropped the preset without a word, the leftover scalar nudges
// landed on the old rainbow ramp, and the rationale described a sunset. Three
// things had to change; these pin the composable's share of them.

/** A toy studio with a base-look macro. Two "presets", each with a different
 *  number of colour stops — the case that makes re-describing mandatory. */
const PRESETS: Record<string, () => Record<string, unknown>> = {
  sunset: () => ({ base: 'sunset', stops: [{ color: '#ff8a3d' }, { color: '#d94f9c' }, { color: '#4b2a7a' }] }),
  duo: () => ({ base: 'duo', stops: [{ color: '#000000' }, { color: '#ffffff' }] }),
}
const stopControls = (cfg: any): ControlSpec[] =>
  (cfg?.stops ?? []).map((_: unknown, i: number) => (
    { key: `stops.${i}.color`, label: `Colour ${i + 1}`, kind: 'color', default: '#ffffff' } as ControlSpec
  ))
const macroControls = (cfg: any): ControlSpec[] => [
  { key: 'preset', label: 'Style preset', kind: 'select', options: Object.keys(PRESETS), default: 'duo' } as ControlSpec,
  { key: 'blur', label: 'Blur', kind: 'slider', min: 0, max: 100, step: 1, default: 0 } as ControlSpec,
  ...stopControls(cfg),
]

function makeMacroAgent() {
  const state = { config: { base: 'duo', blur: 0, stops: [{ color: '#111111' }, { color: '#222222' }] } as any }
  const agent = useStudioAgent({
    // The single-tune vocabulary deliberately has NO macro.
    controls: () => stopControls(state.config),
    params: makeConfigParams(() => state.config),
    label: () => 'Toy studio',
    guidance: () => 'tune-only guidance',
    takes: {
      studio: 'gradient',
      config: () => state.config,
      paramsOf: (c: unknown) => makeConfigParams(() => c),
      controls: () => macroControls(state.config),
      guidance: () => 'macro guidance',
      setConfig: (c: unknown) => { state.config = c },
      macro: {
        key: 'preset',
        apply: (name: string) => PRESETS[name]?.() ?? null,
        recontrol: (c: unknown) => macroControls(c),
      },
    },
  } as any)
  return { agent, state }
}

describe('useStudioAgent — a take may swap the whole base look', () => {
  it('asks with the WIDER vocabulary and its matching guidance', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent } = makeMacroAgent()
    await agent.ask('a dreamy sunset')

    const body = (fetchMock.mock.calls[0]![1] as any).body
    expect(body.controls.map((c: any) => c.path)).toContain('preset')
    expect(body.guidance).toBe('macro guidance')
  })

  it('the single-tune path still gets NEITHER — a swap must not arrive unbidden', async () => {
    fetchMock.mockResolvedValue({ changes: [{ key: 'stops.0.color', value: '#abcdef' }], rationale: '' })
    const { agent } = makeMacroAgent()
    // Force the degrade so requestPatch (the single-tune fetch) is the one used.
    await (agent as any).reroll?.(0)
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ changes: [], rationale: 'nope' })
    const solo = useStudioAgent({
      controls: () => stopControls({ stops: [{ color: '#111111' }] }),
      params: makeConfigParams(() => ({} as any)),
      label: () => 'Toy studio',
      guidance: () => 'tune-only guidance',
    } as any)
    await solo.ask('warmer')
    const body = (fetchMock.mock.calls[0]![1] as any).body
    expect(body.controls.map((c: any) => c.path)).not.toContain('preset')
    expect(body.guidance).toBe('tune-only guidance')
    expect(body.variants).toBeUndefined()
  })

  it('applies the macro FIRST, then the take’s overrides on the new base', async () => {
    fetchMock.mockResolvedValue({ takes: [
      { label: 'sunset', changes: [{ key: 'preset', value: 'sunset' }, { key: 'blur', value: 40 }], rationale: '' },
      { label: 'duo', changes: [{ key: 'blur', value: 10 }], rationale: '' },
    ] })
    const { agent, state } = makeMacroAgent()
    await agent.ask('a dreamy sunset')

    // The macro is at the head of the change list, so one ordered pass is enough.
    expect(agent.takes.value[0]!.changes[0]).toEqual({ key: 'preset', value: 'sunset' })
    agent.previewTake(agent.takes.value[0])
    expect(state.config.base).toBe('sunset')
    expect(state.config.blur).toBe(40)
    expect(state.config.stops).toHaveLength(3)
  })

  it('validates the take’s other changes against the POST-swap stop list', async () => {
    // `stops.2.color` does not exist on the two-stop config the ask was made
    // from — only on the three-stop sunset the take swaps in. Validating before
    // the swap is what dropped it, and dropping it is what left a sunset
    // rationale sitting over the old ramp.
    fetchMock.mockResolvedValue({ takes: [
      { label: 'sunset', changes: [
        { key: 'preset', value: 'sunset' },
        { key: 'stops.2.color', value: '#4b2a7a' },
        { key: 'stops.9.color', value: '#000000' }, // beyond even the new list
      ], rationale: '' },
      { label: 'duo', changes: [{ key: 'blur', value: 10 }], rationale: '' },
    ] })
    const { agent, state } = makeMacroAgent()
    await agent.ask('a dreamy sunset')

    const keys = agent.takes.value[0]!.changes.map(c => c.key)
    expect(keys).toContain('stops.2.color')
    expect(keys).not.toContain('stops.9.color')
    agent.previewTake(agent.takes.value[0])
    expect(state.config.stops[2].color).toBe('#4b2a7a')
  })

  it('restores the WHOLE base config on unhover — a swap cannot be undone key by key', async () => {
    fetchMock.mockResolvedValue({ takes: [
      { label: 'sunset', changes: [{ key: 'preset', value: 'sunset' }, { key: 'blur', value: 40 }], rationale: '' },
      { label: 'duo', changes: [{ key: 'blur', value: 10 }], rationale: '' },
    ] })
    const { agent, state } = makeMacroAgent()
    await agent.ask('a dreamy sunset')
    const before = JSON.stringify(state.config)

    agent.previewTake(agent.takes.value[0])
    expect(JSON.stringify(state.config)).not.toBe(before)
    agent.previewTake(null)
    expect(JSON.stringify(state.config)).toBe(before)

    agent.selectTake(agent.takes.value[0])
    agent.dismissTakes()
    expect(JSON.stringify(state.config)).toBe(before)
  })

  it('⌘Z after a macro keep puts the WHOLE base config back', async () => {
    fetchMock.mockResolvedValue({ takes: [
      { label: 'sunset', changes: [{ key: 'preset', value: 'sunset' }, { key: 'blur', value: 40 }], rationale: '' },
      { label: 'duo', changes: [{ key: 'blur', value: 10 }], rationale: '' },
    ] })
    const { agent, state } = makeMacroAgent()
    await agent.ask('a dreamy sunset')
    const before = JSON.stringify(state.config)
    agent.selectTake(agent.takes.value[0])
    agent.keepTake()
    expect(state.config.base).toBe('sunset')
    expect(agent.undoKeep()).toBe(true)
    expect(JSON.stringify(state.config)).toBe(before)
  })

  it('keeps a macro take: the new base survives the commit', async () => {
    fetchMock.mockResolvedValue({ takes: [
      { label: 'sunset', changes: [{ key: 'preset', value: 'sunset' }, { key: 'blur', value: 40 }], rationale: '' },
      { label: 'duo', changes: [{ key: 'blur', value: 10 }], rationale: '' },
    ] })
    const { agent, state } = makeMacroAgent()
    await agent.ask('a dreamy sunset')
    agent.selectTake(agent.takes.value[0])
    agent.keepTake()

    expect(state.config.base).toBe('sunset')
    expect(state.config.blur).toBe(40)
    expect(agent.hasTakes.value).toBe(false)
    expect(agent.hasProposal.value).toBe(false)
  })

  it('an unknown preset is a dropped key, not a silent no-op', async () => {
    fetchMock.mockResolvedValue({ takes: [
      { label: 'nope', changes: [{ key: 'preset', value: 'marble' }, { key: 'blur', value: 40 }], rationale: '' },
      { label: 'duo', changes: [{ key: 'blur', value: 10 }], rationale: '' },
    ] })
    const { agent } = makeMacroAgent()
    await agent.ask('marble')
    const t = agent.takes.value[0]!
    expect(t.changes.map(c => c.key)).toEqual(['blur'])
    expect(agent.takeDropped.value.get(t)).toContain('preset')
  })
})

// ── the LAYERED toy ────────────────────────────────────────────────────────
//
// The flat toy above let two real bugs through, so this one has the two
// properties the real studio has and the flat one lacked: LAYERS addressed
// through the live `layer.` prefix at a user-chosen index, and a `setConfig`
// that CLAMPS that index the way the surface must when a preset arrives with
// fewer layers. `nonce` stands in for `buildGradientPreset`'s re-seeding —
// every call returns a materially different config.
let presetNonce = 0
const presetCalls: string[] = []
const LAYERED_PRESETS: Record<string, () => any> = {
  // ONE layer, THREE stops — fewer layers AND more stops than the user's.
  sunset: () => ({ base: 'sunset', nonce: ++presetNonce, layers: [
    { color: { stops: [{ color: '#ff8a3d' }, { color: '#d94f9c' }, { color: '#4b2a7a' }] } },
  ] }),
  duo: () => ({ base: 'duo', nonce: ++presetNonce, layers: [
    { color: { stops: [{ color: '#000000' }, { color: '#ffffff' }] } },
    { color: { stops: [{ color: '#111111' }, { color: '#eeeeee' }] } },
  ] }),
}

function makeLayeredAgent() {
  const state = {
    config: { base: 'user', nonce: 0, layers: [
      { color: { stops: [{ color: '#0a0a0a' }, { color: '#0b0b0b' }] } },
      { color: { stops: [{ color: '#1a1a1a' }, { color: '#1b1b1b' }] } },
      { color: { stops: [{ color: '#2a2a2a' }, { color: '#2b2b2b' }] } },
    ] } as any,
    activeLayer: 2,
  }
  /** Configs handed to `paramsOf` — the thumbnail clones, observable. */
  const clones: any[] = []
  const clampIn = (cfg: any) => Math.max(0, Math.min(state.activeLayer, (cfg?.layers?.length ?? 1) - 1))
  const controlsFor = (cfg: any, layerIdx: number): ControlSpec[] => [
    { key: 'preset', label: 'Style preset', kind: 'select', options: Object.keys(LAYERED_PRESETS), default: 'user' } as ControlSpec,
    ...((cfg?.layers?.[layerIdx]?.color?.stops ?? []).map((_: unknown, i: number) => (
      { key: `layer.color.stops.${i}.color`, label: `Colour ${i + 1}`, kind: 'color', default: '#ffffff' } as ControlSpec
    ))),
  ]
  const agent = useStudioAgent({
    controls: () => controlsFor(state.config, state.activeLayer).filter(c => c.key !== 'preset'),
    params: makeConfigParams(() => state.config, () => state.activeLayer),
    label: () => 'Layered toy',
    takes: {
      studio: 'gradient',
      config: () => state.config,
      paramsOf: (c: any) => { clones.push(c); return makeConfigParams(() => c, () => clampIn(c)) },
      controls: () => controlsFor(state.config, state.activeLayer),
      setConfig: (c: any) => {
        state.config = c
        state.activeLayer = Math.min(state.activeLayer, state.config.layers.length - 1)
      },
      captureView: () => state.activeLayer,
      restoreView: (v: unknown) => { state.activeLayer = Number(v) },
      macro: {
        key: 'preset',
        apply: (name: string) => { presetCalls.push(name); return LAYERED_PRESETS[name]?.() ?? null },
        recontrol: (c: any) => controlsFor(c, clampIn(c)),
      },
    },
  } as any)
  return { agent, state, clones }
}

const LAYERED_TAKES = [
  { label: 'sunset', changes: [
    { key: 'preset', value: 'sunset' },
    { key: 'layer.color.stops.0.color', value: '#00ff00' },
    // Stop 2 exists only AFTER the swap — the user's layers have two stops, the
    // sunset preset has three. It is what makes the post-swap re-describe
    // necessary, and what makes a per-key replay on restore actively harmful:
    // the key has no prior value, so replaying it fabricates a third stop.
    { key: 'layer.color.stops.2.color', value: '#4b2a7a' },
  ], rationale: 'warm orange through magenta to deep purple' },
  { label: 'duo', changes: [{ key: 'preset', value: 'duo' }], rationale: 'two-tone' },
]

describe('useStudioAgent — a macro swap must leave nothing behind', () => {
  it('restoring a fewer-layer preset does not write the old layer into a new one', async () => {
    // The whole-config restore is COMPLETE. Replaying the captured keys on top
    // of it re-resolves `layer.` against the CLAMPED index, so layer 2's colours
    // land in layer 0 — and the studio's deep watcher then persists them. A
    // hover must not be able to corrupt a saved document.
    fetchMock.mockResolvedValue({ takes: LAYERED_TAKES })
    const { agent, state } = makeLayeredAgent()
    await agent.ask('a dreamy sunset')
    const before = JSON.stringify(state.config)

    agent.previewTake(agent.takes.value[0])
    agent.previewTake(null)

    expect(state.config.layers[0].color.stops[0].color).toBe('#0a0a0a')
    // No fabricated stop, on any layer: the take reached a third stop that only
    // the preset had, and replaying that key would grow one here.
    for (const l of state.config.layers) expect(l.color.stops).toHaveLength(2)
    expect(JSON.stringify(state.config)).toBe(before)
  })

  it('puts the selected layer back too', async () => {
    fetchMock.mockResolvedValue({ takes: LAYERED_TAKES })
    const { agent, state } = makeLayeredAgent()
    await agent.ask('a dreamy sunset')
    expect(state.activeLayer).toBe(2)

    agent.previewTake(agent.takes.value[0]) // one layer — the surface clamps to 0
    expect(state.activeLayer).toBe(0)
    agent.previewTake(null)
    expect(state.activeLayer).toBe(2)

    agent.selectTake(agent.takes.value[0])
    agent.dismissTakes()
    expect(state.activeLayer).toBe(2)
  })

  it('materializes a preset ONCE — tile, hover and commit are the same config', async () => {
    // `buildGradientPreset` re-rolls its seed on every call, so calling it per
    // consumer means the tile you picked is not the config you keep, and a
    // second hover visibly re-rolls.
    fetchMock.mockResolvedValue({ takes: LAYERED_TAKES })
    presetCalls.length = 0
    const { agent, state } = makeLayeredAgent()
    await agent.ask('a dreamy sunset')

    agent.previewTake(agent.takes.value[0])
    const firstHover = state.config.nonce
    agent.previewTake(null)
    agent.previewTake(agent.takes.value[0])
    const secondHover = state.config.nonce
    agent.previewTake(null)
    agent.selectTake(agent.takes.value[0])
    agent.keepTake()
    const kept = state.config.nonce

    expect(secondHover).toBe(firstHover)
    expect(kept).toBe(firstHover)
    expect(presetCalls.filter(n => n === 'sunset')).toHaveLength(1)
  })

  it('draws the tile from the SAME materialization, with its recolour applied', async () => {
    // The thumbnail clone resolves `layer.` against its own layer count; with a
    // one-layer preset and the user on layer 2 the recolour used to resolve to
    // a layer that does not exist and be dropped, so the tile showed a bare
    // preset while the live preview showed the recolour.
    fetchMock.mockResolvedValue({ takes: LAYERED_TAKES })
    const { agent, clones } = makeLayeredAgent()
    await agent.ask('a dreamy sunset')
    // The thumbnail stream awaits once per tile; drain it properly.
    for (let i = 0; i < 12; i++) await settle()

    const drawn = clones.filter(c => c?.base === 'sunset')
    expect(drawn.length).toBeGreaterThan(0)
    // '#00ff00' appears nowhere in the preset itself — only a correctly
    // resolved write can put it there.
    expect(drawn.some(c => c.layers[0].color.stops[0].color === '#00ff00')).toBe(true)
  })

  it('the sole-take degrade accounts for the macro it cannot carry', async () => {
    // A proposal list is setParam-only, so a lone take's preset is dropped —
    // which is the ORIGINAL bug if it happens silently under a rationale that
    // describes the vanished look.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue({ takes: [
      LAYERED_TAKES[0],
      { label: 'junk', changes: [{ key: 'nope', value: 1 }], rationale: '' },
    ] })
    const { agent } = makeLayeredAgent()
    await agent.ask('a dreamy sunset')

    expect(agent.hasTakes.value).toBe(false)
    expect(agent.hasProposal.value).toBe(true)
    expect(String(warn.mock.calls.flat().join(' '))).toContain('preset')
    // The rationale described the preset. It must not survive the preset.
    for (const ch of agent.changes.value) {
      expect(ch.rationale).not.toContain('warm orange')
    }
    expect(agent.notice.value).toMatch(/part|whole|style/i)
    warn.mockRestore()
  })
})

describe('useStudioAgent — dropped keys are visible', () => {
  it('records them, warns once, and logs them with the decision', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue({ takes: [
      { label: 'warmer', changes: [{ key: 'hue', value: 40 }, { key: 'nope', value: 1 }], rationale: '' },
      { label: 'softer', changes: [{ key: 'softness', value: 0.8 }], rationale: '' },
    ] })
    const { agent } = makeAgent()
    await agent.ask('warmer')

    const t = agent.takes.value[0]!
    expect(agent.takeDropped.value.get(t)).toEqual(['nope'])
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]!.join(' '))).toContain('nope')

    agent.selectTake(t)
    expect(readTakeLog().at(-1)!.droppedKeys).toEqual(['nope'])
    warn.mockRestore()
  })

  it('says "(partial)" on a take that lost more than half of what it asked for', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue({ takes: [
      { label: 'ambitious', changes: [
        { key: 'hue', value: 40 }, { key: 'nope', value: 1 }, { key: 'alsoNope', value: 2 },
      ], rationale: '' },
      { label: 'modest', changes: [{ key: 'softness', value: 0.8 }], rationale: '' },
    ] })
    const { agent } = makeAgent()
    await agent.ask('warmer')

    expect(agent.takes.value[0]!.label).toBe('ambitious (partial)')
    expect(agent.takes.value[1]!.label).toBe('modest')
    warn.mockRestore()
  })

  it('keeps the "(partial)" suffix on a long label instead of ellipsizing it off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue({ takes: [
      { label: 'an extremely long angle name', changes: [
        { key: 'hue', value: 40 }, { key: 'nope', value: 1 }, { key: 'alsoNope', value: 2 },
      ], rationale: '' },
      { label: 'modest', changes: [{ key: 'softness', value: 0.8 }], rationale: '' },
    ] })
    const { agent } = makeAgent()
    await agent.ask('warmer')

    const label = agent.takes.value[0]!.label
    expect(label.endsWith('(partial)')).toBe(true)
    expect(label.length).toBeLessThanOrEqual(24)
    expect(label).toContain('an extre')
    warn.mockRestore()
  })

  it('a take that applies cleanly is neither labelled nor logged as lossy', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent } = makeAgent()
    await agent.ask('warmer')
    for (const t of agent.takes.value) {
      expect(t.label).not.toContain('(partial)')
      expect(agent.takeDropped.value.get(t)).toBeUndefined()
    }
    agent.selectTake(agent.takes.value[0])
    expect(readTakeLog().at(-1)!.droppedKeys).toBeUndefined()
  })
})

describe('useStudioAgent — abandoning an open strip', () => {
  it('re-asking restores the original first, and records the rejection', async () => {
    // The trap: retyping while a take is previewing would otherwise make that
    // take the new baseline — unrecoverable (the original is gone) and
    // unrecorded (the pick log never sees it rejected).
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent, config } = makeAgent()
    await agent.ask('dreamier')
    agent.selectTake(agent.takes.value[0])
    expect(config.hue).toBe(40)

    await agent.ask('something else entirely')

    expect(config.hue).toBe(10)
    const abandoned = readTakeLog().find(e => e.action === 'dismiss')
    // Logged against the phrase it was actually rejecting, not the new one.
    expect(abandoned).toMatchObject({ action: 'dismiss', takeLabel: 'warmer', prompt: 'dreamier' })
  })

  it('abandonTakes is a no-op with no strip open', async () => {
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent, config } = makeAgent()
    const before = JSON.stringify(config)
    agent.abandonTakes()
    expect(readTakeLog()).toHaveLength(0)
    expect(JSON.stringify(config)).toBe(before)
  })

  it('closing the studio abandons the strip the same way', async () => {
    // What StudioModalShell calls on ✕ / Escape, before the surface saves.
    fetchMock.mockResolvedValue({ takes: TAKES })
    const { agent, config } = makeAgent()
    await agent.ask('dreamier')
    const before = JSON.stringify(config)
    agent.selectTake(agent.takes.value[1])

    agent.abandonTakes()

    expect(JSON.stringify(config)).toBe(before)
    expect(agent.hasTakes.value).toBe(false)
    expect(readTakeLog().at(-1)).toMatchObject({ action: 'dismiss', takeLabel: 'softer' })
  })
})

describe('useStudioAgent — degrading to today’s single tune', () => {
  it('falls back when an older server answers in the single-patch shape', async () => {
    fetchMock.mockResolvedValue({ changes: [{ key: 'hue', value: 40 }], rationale: 'warmer' })
    const { agent, config } = makeAgent()

    await agent.ask('warmer')

    expect(agent.hasTakes.value).toBe(false)
    expect(agent.hasProposal.value).toBe(true)
    expect(agent.changes.value[0]!.after).toBe('40')
    expect(config.hue).toBe(40)
    // The response was already usable — no second call was paid for.
    expect(fetchMock.mock.calls).toHaveLength(1)
  })

  it('retries once without variants when the server TAGS the 400 as "no takes here"', async () => {
    fetchMock
      .mockRejectedValueOnce(Object.assign(new Error('Bad Request'), {
        statusCode: 400,
        data: { statusMessage: VARIANTS_UNSUPPORTED, data: { code: VARIANTS_UNSUPPORTED } },
      }))
      .mockResolvedValueOnce({ changes: [{ key: 'hue', value: 40 }], rationale: 'warmer' })
    const { agent, config } = makeAgent()

    await agent.ask('warmer')

    expect(fetchMock.mock.calls).toHaveLength(2)
    expect((fetchMock.mock.calls[1]![1] as any).body.variants).toBeUndefined()
    expect(agent.hasProposal.value).toBe(true)
    expect(config.hue).toBe(40)
    expect(agent.error.value).toBe('')
  })

  it('an UNTAGGED 400 is a real error — shown, and never paid for twice', async () => {
    // /api/vibe forwards Anthropic's status verbatim, so a genuine bad request
    // to the model also arrives as a 400. Degrading on that would hide the bug
    // and bill a second metered call that cannot fix it.
    fetchMock.mockRejectedValue(Object.assign(new Error('invalid_request_error'), { statusCode: 400 }))
    const { agent } = makeAgent()

    await agent.ask('warmer')

    expect(fetchMock.mock.calls).toHaveLength(1)
    expect(agent.error.value).toContain('invalid_request_error')
    expect(agent.hasTakes.value).toBe(false)
    expect(agent.hasProposal.value).toBe(false)
  })

  it('does not retry — or strip — on a real failure', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('Overloaded'), { statusCode: 529 }))
    const { agent } = makeAgent()

    await agent.ask('warmer')

    expect(fetchMock.mock.calls).toHaveLength(1)
    expect(agent.error.value).toContain('Overloaded')
    expect(agent.hasTakes.value).toBe(false)
  })

  it('degrades to a single proposal when only one take survives validation', async () => {
    fetchMock.mockResolvedValue({ takes: [
      { label: 'only', changes: [{ key: 'hue', value: 40 }], rationale: 'warmer' },
      { label: 'junk', changes: [{ key: 'nope', value: 1 }], rationale: 'nothing usable' },
    ] })
    const { agent, config } = makeAgent()

    await agent.ask('warmer')

    expect(agent.hasTakes.value).toBe(false)
    expect(agent.hasProposal.value).toBe(true)
    expect(config.hue).toBe(40)
    expect(fetchMock.mock.calls).toHaveLength(1)
  })

  it('wire-through: a ragged model reply salvaged server-side to ONE take renders as a proposal, not a broken strip', async () => {
    // A raw takes reply the old hard-502 path would have refused outright:
    // five takes (over the 4 cap) where four are fully unsalvageable (their
    // `changes` field isn't even an array) and only one has a usable shape.
    // Run it through the REAL server function, then hand the client exactly
    // what /api/vibe would have sent over the wire.
    const shaped = shapeTakesResponse({
      takes: [
        { label: 'only', changes: [{ key: 'hue', value: 40 }], rationale: 'warmer' },
        { label: 'junk1', changes: 'nope', rationale: 'r' },
        { label: 'junk2', changes: null, rationale: 'r' },
        { label: 'junk3', changes: 42, rationale: 'r' },
        { label: 'junk4', changes: {}, rationale: 'r' },
      ],
    })
    expect(shaped).toEqual({ changes: [{ key: 'hue', value: 40 }], rationale: 'warmer' })

    fetchMock.mockResolvedValue(shaped)
    const { agent, config } = makeAgent()

    await agent.ask('warmer')

    expect(agent.hasTakes.value).toBe(false)
    expect(agent.hasProposal.value).toBe(true)
    expect(agent.changes.value[0]!.after).toBe('40')
    expect(config.hue).toBe(40)
    expect(fetchMock.mock.calls).toHaveLength(1) // usable on arrival — no retry paid for
  })

  it('a studio that opted out of takes never sends variants', async () => {
    fetchMock.mockResolvedValue({ changes: [{ key: 'hue', value: 40 }], rationale: 'warmer' })
    const { agent } = makeAgent({ takes: undefined })

    await agent.ask('warmer')

    expect((fetchMock.mock.calls[0]![1] as any).body.variants).toBeUndefined()
    expect(agent.hasProposal.value).toBe(true)
    expect(agent.hasTakes.value).toBe(false)
  })
})
