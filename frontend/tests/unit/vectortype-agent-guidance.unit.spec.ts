import { describe, expect, it, vi } from 'vitest'

// studioTune.ts calls ofetch's $fetch (for /api/vibe) at module scope in
// callers this file never exercises — stub it exactly like studio-tune.unit
// .spec.ts does so importing `__vectorTypeAdapterForTest` doesn't need the
// real package resolvable.
vi.mock('ofetch', () => ({ $fetch: vi.fn() }))

import { DEFAULT_CONFIG, mergeConfig } from '~/lib/vectortype/config'
import { DEFAULT_FONT_ID } from '~/data/variable-fonts'
import { vtAgentControls } from '~/lib/vectortype/agentControls'
import { VT_GUIDANCE } from '~/lib/vectortype/controls'
import { makeConfigParams } from '~/lib/agent/configParams'
import { describeControls } from '~/lib/spacetype/controlDescriptor'
import { easeToEngineName } from '~/lib/studio/moves/ease'
import { __vectorTypeAdapterForTest } from '~/lib/agent/studioTune'

describe('smart stretch — agent surface', () => {
  it('the agent sees stretch, height and fit with their hints', () => {
    const keys = vtAgentControls(DEFAULT_CONFIG, []).map(c => c.key)
    expect(keys).toContain('stretch'); expect(keys).toContain('stretchY'); expect(keys).toContain('fit')
  })
  it('guidance teaches the stretch-vs-scale distinction and the single-axis habit', () => {
    expect(VT_GUIDANCE).toMatch(/stretch/i)
    expect(VT_GUIDANCE).toMatch(/scaleX|scale motion|squash/i)
    expect(VT_GUIDANCE).toMatch(/one (dial|axis) at a time|single-axis|one axis/i)
  })
})

describe('moves — agent surface (Task 10)', () => {
  // `moves.add`/`moves.remove` macros were built and unit-tested in an
  // earlier pass but never wired into `studioTune.ts`'s `vectorTypeAdapter`
  // (there is no established "delete a list member" macro anywhere in this
  // codebase, and `PatchAdapter` only supports ONE macro per adapter — see
  // `~/lib/vectortype/agentControls.ts`'s "DELIBERATELY NOT WIRED" doc for
  // the full path-A/path-B reasoning). They were removed as dead code rather
  // than left declared-but-unreachable, so this file no longer tests them.
  it('a move on the config gets id-addressed set words, including duration', () => {
    // The OLD-shape `in` slot `mergeMotion` still converts — the same route
    // `migrateKinetic.ts` uses — so this is one real `kind: 'preset'` move,
    // not a hand-built fixture that could drift from the real shape.
    const config = mergeConfig({ motion: { in: { presetId: 'fade-in', duration: 1.2 } } })
    const moveId = config.motion.moves[0]!.id

    const controls = vtAgentControls(config, [])
    const duration = controls.find(c => c.key === `moves.${moveId}.duration`)
    expect(duration).toBeTruthy()
    expect(duration!.kind).toBe('slider')
    expect((duration as any).default).toBe(1.2)

    const ease = controls.find(c => c.key === `moves.${moveId}.ease`)
    expect(ease).toBeTruthy()
    expect(ease!.kind).toBe('select')
  })

  it('a removed move’s set words are gone — the same degrade-to-ignored posture as a deleted layer', () => {
    const config = mergeConfig({ motion: { in: { presetId: 'fade-in', duration: 1.2 } } })
    const moveId = config.motion.moves[0]!.id
    config.motion.moves = []
    const controls = vtAgentControls(config, [])
    expect(controls.find(c => c.key === `moves.${moveId}.duration`)).toBeUndefined()
  })

  it('moves.<id>.duration actually resolves through the write-through proxy studioTune.ts uses', () => {
    // Not just "the control exists" — proves `~/lib/agent/configParams.ts`'s
    // `extraLists` (Task 10's own addition, wired into `studioTune.ts`'s
    // `vectorTypeAdapter`) really reaches `cfg.motion.moves` by id, the same
    // way `appearance.<id>.*` already reaches the appearance stack.
    const config = mergeConfig({ motion: { in: { presetId: 'fade-in', duration: 1.2 } } })
    const moveId = config.motion.moves[0]!.id
    const params = makeConfigParams(
      () => config, () => 0, 'appearance', 'id', 'layer', [{ key: 'moves', at: 'motion.moves' }],
    )
    expect(params[`moves.${moveId}.duration`]).toBe(1.2)
    params[`moves.${moveId}.duration`] = 2.5
    expect(config.motion.moves[0]!.duration).toBe(2.5)
    // A deleted move's key is dead — read undefined, write a no-op — never the
    // move that slid into its slot.
    config.motion.moves = []
    expect(params[`moves.${moveId}.duration`]).toBeUndefined()
    params[`moves.${moveId}.duration`] = 9
    expect(config.motion.moves).toEqual([])
  })

  // ── FIX 1 (Task 10 review, CRITICAL): the agent write path used to write
  // the bare `MoveEaseName` STRING straight into `cfg.motion.moves[i].ease`,
  // corrupting the stored shape — every reader (`mergeEase`, EasePicker.vue,
  // `easeToEngineName`, `presetMotion.ts`) expects a `MoveEase` OBJECT
  // (`{kind:'named', name} | {kind:'bezier', cps}`). This exercises the SAME
  // `params()` factory `studioTune.ts`'s `vectorTypeAdapter` builds (not a
  // hand-rolled proxy), so it fails before the fix and passes after.
  it('writing a bare ease name through the agent patch path stores a MoveEase object, not a raw string', () => {
    const config = mergeConfig({ motion: { in: { presetId: 'fade-in', duration: 1.2 } } })
    const moveId = config.motion.moves[0]!.id
    const params = __vectorTypeAdapterForTest.params(config)

    // The model always emits the bare name — it's a `kind:'select'` control
    // whose `options` are `MoveEaseName` strings (`vtMoveFieldControls`).
    params[`moves.${moveId}.ease`] = 'bounce'

    const stored = config.motion.moves[0]!.ease
    expect(stored).toEqual({ kind: 'named', name: 'bounce' })
    expect(easeToEngineName(stored)).toBe('bounce.out')
    // Not the silent power2.out fallback a raw string produces (`easeToEngineName`
    // reads `.kind`/`.name` off a plain string as `undefined`, then falls back).
    expect(easeToEngineName(stored)).not.toBe('power2.out')
  })

  // ── FIX 1, display half: `describeControls`'s `current` used to read the
  // raw `MoveEase` object straight off the params proxy, which renders as
  // "[object Object]" once `runParamPatch`/the tune row `String()`s it. The
  // same params proxy now hands back the ease's NAME for this key — mirroring
  // how the control's own `default` is already computed
  // (`vtMoveFieldControls`'s `mv.ease?.kind === 'named' ? mv.ease.name : 'smooth'`).
  it("describeControls's current value for moves.<id>.ease is the ease name, not the raw object", () => {
    const config = mergeConfig({ motion: { in: { presetId: 'fade-in', duration: 1.2 } } })
    const moveId = config.motion.moves[0]!.id
    expect(config.motion.moves[0]!.ease).toEqual({ kind: 'named', name: 'smooth' })

    const params = __vectorTypeAdapterForTest.params(config)
    const controls = vtAgentControls(config, [])
    const described = describeControls(controls, params)
    const ease = described.find(d => d.path === `moves.${moveId}.ease`)
    expect(ease).toBeTruthy()
    expect(ease!.current).toBe('smooth')
    expect(String(ease!.current)).not.toBe('[object Object]')
  })
})

describe('the adapter write is the last gate on config', () => {
  // The params proxy writes whatever the agent names straight onto the live
  // config object, and `fontId` is a `text` control — free-form by kind, but
  // the ONLY strings Vector Type can actually load are the three token shapes.
  // Without a re-merge here, "set the font to Helvetica" persisted `Helvetica`
  // into the saved project, and every later load of that project would fall
  // back to Inter while the row kept reporting a font that does not exist.
  it('re-merges the config, so an unloadable fontId cannot be persisted', () => {
    const node: any = {}
    const config: any = { ...mergeConfig({}), fontId: 'Helvetica' }
    __vectorTypeAdapterForTest.write(node, config)
    expect(node.data.properties.sailor_vectorType.config.fontId).toBe(DEFAULT_FONT_ID)
  })
  it('leaves a real token alone', () => {
    const node: any = {}
    const config: any = { ...mergeConfig({}), fontId: 'google:Inter Tight@700', text: 'HELLO' }
    __vectorTypeAdapterForTest.write(node, config)
    const stored = node.data.properties.sailor_vectorType.config
    expect(stored.fontId).toBe('google:Inter Tight@700')
    expect(stored.text).toBe('HELLO')
  })
})
