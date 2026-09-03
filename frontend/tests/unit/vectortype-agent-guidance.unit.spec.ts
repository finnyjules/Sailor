import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, mergeConfig } from '~/lib/vectortype/config'
import {
  VT_MOVE_ADD_KEY,
  VT_MOVE_REMOVE_KEY,
  vtAgentControls,
  vtMoveAddControl,
  vtMoveRemoveControl,
} from '~/lib/vectortype/agentControls'
import { VT_GUIDANCE } from '~/lib/vectortype/controls'
import { makeConfigParams } from '~/lib/agent/configParams'

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
  // ADD/REMOVE are macros — a verb, not a config leaf — so they are NOT part
  // of `vtAgentControls`'s own list, the same posture `scene3d/agentControls
  // .ts`'s `primitive` macro takes relative to `sceneAgentControls`: a caller
  // that knows how to intercept the macro (a future `studioTune.ts` wiring)
  // composes it alongside `vtAgentControls`'s output. See both functions' own
  // doc for why, and `~/lib/agent/configParams.ts`'s `ExtraIdList` for what
  // makes the SET words below real, resolving leaves rather than another verb.
  it('always offers a move-add word, with fade/wave-style options', () => {
    const add = vtMoveAddControl()
    expect(add.key).toBe(VT_MOVE_ADD_KEY)
    expect(add.kind).toBe('select')
    const options = (add as any).options as string[]
    expect(options).toContain('in:fade-in')
    expect(options).toContain('loop:wave')
    expect(options).toContain('loop:blink')
    expect(options).toContain('loop:scatter')
    expect(add.hint).toMatch(/add/i)
    // Never offered as a plain settable key inside vtAgentControls's own list
    // — it would fail "every emitted key resolves" (vectortype-controls spec).
    expect(vtAgentControls(DEFAULT_CONFIG, []).some(c => c.key === VT_MOVE_ADD_KEY)).toBe(false)
  })

  it('offers no move-remove word on a config with no motion', () => {
    expect(vtMoveRemoveControl(DEFAULT_CONFIG)).toBeNull()
  })

  it('a move on the config gets a remove word and id-addressed set words, including duration', () => {
    // The OLD-shape `in` slot `mergeMotion` still converts — the same route
    // `migrateKinetic.ts` uses — so this is one real `kind: 'preset'` move,
    // not a hand-built fixture that could drift from the real shape.
    const config = mergeConfig({ motion: { in: { presetId: 'fade-in', duration: 1.2 } } })
    const moveId = config.motion.moves[0]!.id

    const remove = vtMoveRemoveControl(config)
    expect(remove).toBeTruthy()
    expect(remove!.key).toBe(VT_MOVE_REMOVE_KEY)
    expect((remove as any).options).toContain(moveId)

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
    expect(vtMoveRemoveControl(config)).toBeNull()
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
})
