import { describe, it, expect, vi, beforeEach } from 'vitest'

// studioTune's tuners call the plan/vibe endpoints via ofetch's $fetch — stub it
// so we can drive deterministic responses and assert the node-state plumbing
// (read config → apply patch/commands → write back → restore reverts).
const fetchMock = vi.fn()
vi.mock('ofetch', () => ({ $fetch: (...args: unknown[]) => fetchMock(...args) }))

import { STUDIO_TUNERS, studioTunerFor, tuneGradientNode, tuneShaderNode, tuneTextureNode, tuneCompositorNode, isNoOpTuneChange } from '~/lib/agent/studioTune'
import { defaultConfig as defaultGradientConfig } from '~/lib/gradientfx/randomize'
import { gradientAgentControls } from '~/lib/gradientfx/agentControls'
import { resolvePost } from '~/lib/gradientfx/types'
import { makeConfigParams } from '~/lib/agent/configParams'
import { describeControls, validatePatch } from '~/lib/spacetype/controlDescriptor'
import { textureDefaults } from '~/lib/texturefx/controls'
import { rolesFor } from '~/lib/texturefx/roles'

const KEY = 'test-key'
beforeEach(() => fetchMock.mockReset())

/** A minimal live-canvas node stub (only the fields the tuners touch). */
function node(nodeType: string, properties: Record<string, unknown> = {}): any {
  return { id: 'n1', data: { nodeType, title: nodeType, properties: { ...properties } } }
}

describe('studioTunerFor registry', () => {
  it('maps every canvas-tunable studio to a tuner', () => {
    for (const t of ['Compositor', 'GradientStudio', 'ShaderStudio', 'TextureStudio', 'SmartLayout', 'ShapeStudio']) {
      expect(typeof studioTunerFor(t)).toBe('function')
      expect(STUDIO_TUNERS[t]).toBeTypeOf('function')
    }
  })
  it('returns undefined for a non-studio node or missing type', () => {
    expect(studioTunerFor('GenerateImageNode')).toBeUndefined()
    expect(studioTunerFor(undefined)).toBeUndefined()
    expect(studioTunerFor(null)).toBeUndefined()
  })
})

describe('tuneGradientNode (param-patch / vibe)', () => {
  it('applies a clamped patch to a fresh node and restore reverts it', async () => {
    // Derive a REAL slider control off the default config so the test isn't tied to
    // a hardcoded key. Aim at the endpoint farthest from its current value so the
    // change is unambiguous after validatePatch snaps/clamps it.
    const probe = defaultGradientConfig()
    const described = describeControls(gradientAgentControls(probe), makeConfigParams(() => probe, () => 0))
    const slider = described.find(d => d.kind === 'slider')!
    expect(slider).toBeTruthy()
    const cur = Number(slider.current)
    const aim = Math.abs(slider.max! - cur) >= Math.abs(cur - slider.min!) ? slider.max! : slider.min!
    const expected = validatePatch({ [slider.path]: aim }, described)[slider.path]

    fetchMock.mockResolvedValueOnce({ changes: [{ key: slider.path, value: aim }], rationale: 'aim there' })
    const n = node('GradientStudio') // no saved config → seeded from a default
    const res = await tuneGradientNode(n, 'crank it', KEY)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect((fetchMock.mock.calls[0]![0] as string)).toBe('/api/vibe')
    expect(res.ok).toBe(true)
    expect(res.rows).toHaveLength(1)
    const saved = n.data.properties.sailor_gradientStudio
    expect(saved).toBeDefined()
    const readBack = makeConfigParams(() => saved, () => 0)[slider.path]
    expect(readBack).toBe(expected)

    res.restore()
    const reverted = makeConfigParams(() => n.data.properties.sailor_gradientStudio, () => 0)[slider.path]
    expect(reverted).toBe(cur) // back to the default's original value
  })

  it('exposes each colour stop and recolours the gradient from a patch', async () => {
    // The default gradient has multiple ramp stops — each must be an offerable
    // colour control, else the agent can't set "blue, pink, orange".
    const probe = defaultGradientConfig()
    const controls = gradientAgentControls(probe)
    const stopControls = controls.filter(c => /^layer\.color\.stops\.\d+\.color$/.test(c.key))
    expect(stopControls.length).toBe(probe.layers[0]!.color.stops.length)
    expect(stopControls.length).toBeGreaterThanOrEqual(3)

    const [c0, c1, c2] = stopControls
    fetchMock.mockResolvedValueOnce({
      changes: [
        { key: c0!.key, value: '#2b6bff' }, // blue
        { key: c1!.key, value: '#ff6ec7' }, // pink
        { key: c2!.key, value: '#ff8c42' }, // orange
      ],
      rationale: 'blue → pink → orange',
    })
    const n = node('GradientStudio')
    const res = await tuneGradientNode(n, 'blue, pink and orange', KEY)
    expect(res.ok).toBe(true)
    const stops = n.data.properties.sailor_gradientStudio.layers[0].color.stops
    expect(stops[0].color).toBe('#2b6bff')
    expect(stops[1].color).toBe('#ff6ec7')
    expect(stops[2].color).toBe('#ff8c42')
  })

  it('is a no-op (ok:false) when the model returns no changes', async () => {
    fetchMock.mockResolvedValueOnce({ changes: [], rationale: 'nothing to do' })
    const n = node('GradientStudio')
    const res = await tuneGradientNode(n, 'do nothing', KEY)
    expect(res.ok).toBe(false)
    expect(res.rows).toHaveLength(0)
    expect(res.notice).toBeTruthy()
    expect(n.data.properties.sailor_gradientStudio).toBeUndefined() // nothing written
  })

  it('preset macro: swaps to the preset base config, THEN applies overrides', async () => {
    fetchMock.mockResolvedValueOnce({
      changes: [{ key: 'preset', value: 'marble' }, { key: 'focus.blur', value: 40 }],
      rationale: 'marble base, softened',
    })
    const n = node('GradientStudio')
    const res = await tuneGradientNode(n, 'blurry blue marble', KEY)
    expect(res.ok).toBe(true)
    const saved = n.data.properties.sailor_gradientStudio
    expect(saved.canvas.layout).toBe('liquid')   // marble preset applied as the base
    expect(saved.focus.blur).toBe(40)            // override applied on top of the preset
    expect(res.rows.some(r => r.after === 'marble')).toBe(true)
    // and the /api/vibe call carried the gradient guidance + offered the preset control
    const body = fetchMock.mock.calls[0]![1].body
    expect(body.guidance).toBeTruthy()
    expect(body.controls.some((c: any) => c.path === 'preset')).toBe(true)
  })

  it('preset macro: an unknown preset name is dropped (validatePatch), no swap', async () => {
    fetchMock.mockResolvedValueOnce({ changes: [{ key: 'preset', value: 'bogus' }], rationale: '' })
    const n = node('GradientStudio')
    const res = await tuneGradientNode(n, 'x', KEY)
    expect(res.ok).toBe(false)   // 'bogus' not an option → dropped → no change
    expect(n.data.properties.sailor_gradientStudio).toBeUndefined()
  })

  it('a grain write survives a legacy relief.grain on the same doc (the invariant resolvePost documents)', async () => {
    // Task 8 invariant: resolvePost derives post.grain* from a legacy relief.grain
    // field at RENDER time and it wins over any saved post — deliberately, so a
    // document never opened in the studio keeps rendering its grain everywhere
    // (node card, bake, timeline, export). ensureConfigDefaults is the only thing
    // that drops relief.grain from a saved blob. Any writer of
    // sailor_gradientStudio that does not run it first has its post.grain* write
    // silently overridden on the very next render — which is exactly what "less
    // grain" from the agent tuner must not do.
    const legacyDoc = defaultGradientConfig()
    legacyDoc.relief.grain = 0.4 // never opened in the studio → legacy field still present
    // 0.18 is an exact multiple of the grainAmount slider's 0.02 step (manifest.ts),
    // so validatePatch's snap doesn't perturb the value we're asserting on.
    fetchMock.mockResolvedValueOnce({ changes: [{ key: 'post.grainAmount', value: 0.18 }], rationale: 'less grain' })
    const n = node('GradientStudio', { sailor_gradientStudio: JSON.parse(JSON.stringify(legacyDoc)) })
    const res = await tuneGradientNode(n, 'less grain', KEY)
    expect(res.ok).toBe(true)

    const saved = n.data.properties.sailor_gradientStudio
    // Every render path calls resolvePost on the raw saved blob — that is what must
    // reflect the tuner's write, not the in-memory config the tuner happened to hold.
    const rendered = resolvePost(saved)
    expect(rendered.grainAmount).toBe(0.18) // NOT 0.4 (the legacy field re-winning)
  })
})

describe('tuneTextureNode (command-surface)', () => {
  it('applies a planned fill command and restore reverts it', async () => {
    const role = rolesFor(textureDefaults())[0]!
    fetchMock.mockResolvedValueOnce({
      text: JSON.stringify({ commands: [{ op: 'setFillColor', target: role, args: { color: '#ff8800' } }] }),
    })
    const n = node('TextureStudio')
    const res = await tuneTextureNode(n, 'make it orange', KEY)

    expect((fetchMock.mock.calls[0]![0] as string)).toBe('/api/agent-plan')
    expect(res.ok).toBe(true)
    expect(res.rows.length).toBeGreaterThanOrEqual(1)
    const saved = n.data.properties.sailor_textureStudio
    expect(JSON.stringify(saved)).toContain('#ff8800')

    res.restore()
    expect(JSON.stringify(n.data.properties.sailor_textureStudio)).not.toContain('#ff8800')
  })

  // Live-bug regression: a proposal reading "lattice: square → square" — the model
  // reasserted the control's CURRENT value (already 'square', the default) as if it
  // were a change. No-op setParam commands must never surface as a proposal row.
  it('drops a setParam row that reasserts the control\'s current value (no-op)', async () => {
    const defaults = textureDefaults()
    expect(defaults.lattice).toBe('square') // the control this bug was observed on
    fetchMock.mockResolvedValueOnce({
      text: JSON.stringify({ commands: [{ op: 'setParam', target: 'lattice', args: { value: 'square' } }], message: '' }),
    })
    const n = node('TextureStudio')
    const res = await tuneTextureNode(n, 'make it a square lattice', KEY)
    expect(res.rows).toHaveLength(0)
    expect(res.rows.some(r => r.before === r.after)).toBe(false)
    expect(res.ok).toBe(false) // nothing actually changed
  })

  it('still proposes a row for a REAL setParam change alongside a no-op one', async () => {
    fetchMock.mockResolvedValueOnce({
      text: JSON.stringify({
        commands: [
          { op: 'setParam', target: 'lattice', args: { value: 'square' } }, // no-op — dropped
          { op: 'setFillColor', target: rolesFor(textureDefaults())[0]!, args: { color: '#112233' } }, // real change — kept
        ],
      }),
    })
    const n = node('TextureStudio')
    const res = await tuneTextureNode(n, 'square lattice, dark role', KEY)
    expect(res.ok).toBe(true)
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]!.after).toBe('#112233')
  })

  // The honesty clause: when the requested look isn't in the studio's vocabulary,
  // the model must approximate AND say so — never present the approximation as an
  // exact match. This asserts the guidance text actually reaches the model prompt.
  it('sends an honesty-about-approximation clause in the plan prompt', async () => {
    fetchMock.mockResolvedValueOnce({ text: JSON.stringify({ commands: [] }) })
    const n = node('TextureStudio')
    await tuneTextureNode(n, 'make it look like hammered copper', KEY)
    const body = fetchMock.mock.calls[0]![1].body
    expect(String(body.prompt)).toMatch(/approximat/i)
    expect(String(body.prompt)).toMatch(/never present/i)
  })
})

describe('isNoOpTuneChange (pure no-op equality)', () => {
  it('is a no-op when the value is unchanged', () => {
    expect(isNoOpTuneChange('square', 'square')).toBe(true)
  })
  it('is NOT a no-op when the value actually differs', () => {
    expect(isNoOpTuneChange('square', 'hex')).toBe(false)
  })
  // Documented choice: TuneRow.before/after are always display STRINGS (see the
  // `TuneRow` interface) — never raw numbers — so this never receives a JS number.
  // What it does receive is differently-FORMATTED numeric strings for the same
  // value (e.g. a slider's stringified default vs. the model's stringified patch
  // value), which a naive `before === after` would wrongly treat as a real change.
  it('treats numerically-equal strings as a no-op despite differing formatting', () => {
    expect(isNoOpTuneChange('8', '8.0')).toBe(true)
    expect(isNoOpTuneChange('0.50', '.5')).toBe(true)
  })
  it('normalizes surrounding whitespace before comparing', () => {
    expect(isNoOpTuneChange(' square ', 'square')).toBe(true)
  })
  it('two blank values are equal (both "no value") — a no-op', () => {
    expect(isNoOpTuneChange('', '')).toBe(true)
  })
  it('blank vs. a real value is a genuine change, not a no-op', () => {
    expect(isNoOpTuneChange('', 'square')).toBe(false)
  })
})

describe('tuneShaderNode (param-patch)', () => {
  it('handles an empty patch without touching state', async () => {
    fetchMock.mockResolvedValueOnce({ changes: [], rationale: '' })
    const n = node('ShaderStudio')
    const res = await tuneShaderNode(n, 'noop', KEY)
    expect(res.ok).toBe(false)
    expect(n.data.properties.sailor_shaderStudio).toBeUndefined()
  })

  // This file NEVER stubs the ambient global `$fetch` that shaderfx/catalog.ts
  // uses, so it runs the tuner exactly as a node/unit environment gets it: the
  // catalog fetch throws SYNCHRONOUSLY (there is no `$fetch` global), and the
  // shader vocabulary has to degrade in the open rather than emit an empty effect
  // list. The catalog-present behaviour is in shader-tune-macro.unit.spec.ts.
  it('degrades EXPLICITLY when the effect catalog cannot be reached', async () => {
    fetchMock.mockResolvedValueOnce({ changes: [], rationale: '' })
    await tuneShaderNode(node('ShaderStudio'), 'make it glitchy', KEY)
    const body = fetchMock.mock.calls[0]![1].body
    const paths = (body.controls as { path: string }[]).map(c => c.path)
    // No `effect` control the model has no names for…
    expect(paths).not.toContain('effect')
    // …but the stage vocabulary is still fully there, and the model is TOLD why.
    expect(paths).toContain('post.bloom.enabled')
    expect(paths).toContain('adjust.temperature')
    expect(String(body.guidance)).toContain('EFFECT LIST UNAVAILABLE')
    expect(String(body.guidance)).not.toContain('EFFECTS YOU MAY PICK')
  })
})

describe('tuneShapeNode', () => {
  it('is registered for the ShapeStudio node type', async () => {
    const { studioTunerFor } = await import('~/lib/agent/studioTune')
    expect(studioTunerFor('ShapeStudio')).toBeTypeOf('function')
  })

  it('migrates a legacy {config} blob to a doc and preserves the wrapper', async () => {
    // sailor_shapeStudio is now { doc, canvasW, canvasH, aspectKey } — the tuner
    // edits the base layer's mark. A legacy { config } blob must migrate (not be
    // read as defaults or written back as a dead `config` key), and the canvas
    // size must survive the write.
    const { __shapeAdapterForTest } = await import('~/lib/agent/studioTune')
    const node: any = { data: { properties: { sailor_shapeStudio: {
      config: { shape: 'star', sides: 7 }, canvasW: 1920, canvasH: 1080, aspectKey: '16:9',
      orbit: { yaw: 1, pitch: 2, zoom: 3 },
    } } } }
    const a = __shapeAdapterForTest
    const cfg = await a.read(node)
    // read migrated the legacy config into the base layer's mark (not defaults).
    expect(cfg.config.shape).toBe('star')
    expect(cfg.config.sides).toBe(7)
    a.write(node, cfg.config)
    const saved = node.data.properties.sailor_shapeStudio
    expect(saved.canvasW).toBe(1920)
    expect(saved.canvasH).toBe(1080)
    expect(saved.aspectKey).toBe('16:9')
    expect(saved.orbit).toEqual({ yaw: 1, pitch: 2, zoom: 3 })
    // Persists the layered doc; the stale legacy `config` key is dropped.
    expect(saved.doc?.layers?.[0]?.mark?.shape).toBe('star')
    expect(saved.config).toBeUndefined()
  })

  it('tunes the base layer of an existing doc (round-trips through doc)', async () => {
    const { __shapeAdapterForTest } = await import('~/lib/agent/studioTune')
    const { defaultDoc } = await import('~/lib/geoshape/studio')
    const doc0 = defaultDoc()
    doc0.layers.push({ ...doc0.layers[0]!, layerId: 'second' }) // a 2nd layer that must survive
    const node: any = { data: { properties: { sailor_shapeStudio: { doc: doc0, canvasW: 800, canvasH: 800 } } } }
    const a = __shapeAdapterForTest
    const cfg = await a.read(node)
    cfg.config.sides = 11
    a.write(node, cfg.config)
    const saved = node.data.properties.sailor_shapeStudio
    expect(saved.doc.layers).toHaveLength(2)                 // 2nd layer preserved
    expect(saved.doc.layers[0].mark.sides).toBe(11)          // base tuned
    expect(saved.doc.layers[1].layerId).toBe('second')
  })

  it('falls back to defaults when the node has never been opened', async () => {
    const { __shapeAdapterForTest } = await import('~/lib/agent/studioTune')
    const node: any = { data: { properties: {} } }
    const { config, controls } = await __shapeAdapterForTest.read(node)
    expect(config.fillMode).toBeDefined()
    expect(controls.length).toBeGreaterThan(0)
  })
})

describe('every registered studio tuner is discoverable by the model', () => {
  it('names each STUDIO_TUNERS key in the canvas tuneNode hint', async () => {
    // Registering a tuner is only half the job: the canvas agent picks tuneNode
    // targets from the prose hint, so a studio absent from that sentence is
    // wired but unreachable — the model never learns it can be tuned.
    const { STUDIO_TUNERS } = await import('~/lib/agent/studioTune')
    const { describeCanvas } = await import('~/lib/agent/surfaces/canvas')
    // Read the hint from what the model is actually handed, not from a module const.
    const surface = describeCanvas({ nodes: [], edges: [] })
    const hint = surface.commands.find((c) => c.op === 'tuneNode')?.hint ?? ''
    expect(hint, 'tuneNode op not found in the canvas surface').not.toBe('')
    for (const nodeType of Object.keys(STUDIO_TUNERS)) {
      expect(hint, `${nodeType} is registered but not named in the tuneNode hint`).toContain(`"${nodeType}"`)
    }
  })
})

// Frame light layers stage 4: the canvas Frame tuner reads and writes the Frame's lighting, so
// a lighting change it shows is a lighting change that lands; lighting animation stays in the Frame.
describe('tuneCompositorNode — lights', () => {
  const frame = (props: Record<string, unknown> = {}) => node('Compositor', { sailor_localLayers: [], ...props })
  const plan = (commands: unknown[]) => fetchMock.mockResolvedValueOnce({ text: JSON.stringify({ commands }) })
  const sentPrompt = () => JSON.stringify((fetchMock.mock.calls[0]![1] as { body: unknown }).body)

  it('setLighting lands on the node, and restore leaves an untouched Frame without the key', async () => {
    plan([{ op: 'setLighting', args: { darkness: 0.85 } }])
    const n = frame()
    const res = await tuneCompositorNode(n, 'make it night', KEY)
    expect(res.ok).toBe(true)
    expect(res.rows[0]).toMatchObject({ label: 'Frame lighting', before: 'Darkness 45%', after: 'Darkness 85%' })
    expect(n.data.properties.sailor_localLighting).toEqual({ darkness: 0.85, backgroundLit: true })
    res.restore()
    expect('sailor_localLighting' in n.data.properties).toBe(false)
  })

  it('a tune that does not touch lighting writes no lighting key', async () => {
    plan([{ op: 'setBackground', args: { paint: '#112233' } }])
    const n = frame()
    expect((await tuneCompositorNode(n, 'navy background', KEY)).ok).toBe(true)
    expect('sailor_localLighting' in n.data.properties).toBe(false)
  })

  it('addLight and setLight land in the layers', async () => {
    plan([{ op: 'addLight', args: { type: 'lamp', x: 0.2, y: 0.2, id: 'L' } }, { op: 'setLight', target: 'L', args: { brightness: 2.5 } }])
    const n = frame()
    const res = await tuneCompositorNode(n, 'add a warm lamp', KEY)
    expect(res.rows.map(r => r.label)).toEqual(['Added a lamp', 'Changed the light'])
    const layers = n.data.properties.sailor_localLayers as { id: string; kind: string; light: { brightness: number } }[]
    expect(layers).toHaveLength(1)
    expect(layers[0]).toMatchObject({ id: 'L', kind: 'light', light: { brightness: 2.5 } })
  })

  it('does not offer animateLight, and drops one if the model sends it', async () => {
    plan([{ op: 'animateLight', target: 'frame', args: { key: 'darkness', from: 0, to: 1 } }])
    const n = frame()
    const res = await tuneCompositorNode(n, 'fade to night', KEY)
    expect(sentPrompt()).not.toContain('animateLight')
    expect(sentPrompt()).toContain('setLighting')
    expect(res.ok).toBe(false)
    expect(n.data.properties.sailor_motion).toBeUndefined()
  })

  it('describes the Frame\'s real Darkness', async () => {
    plan([])
    await tuneCompositorNode(frame({ sailor_localLighting: { darkness: 0.7, backgroundLit: false } }), 'darker', KEY)
    expect(sentPrompt()).toContain('\\"lighting\\":{\\"darkness\\":0.7,\\"backgroundLit\\":false}')
  })
})

