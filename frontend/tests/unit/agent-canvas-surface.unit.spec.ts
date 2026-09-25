import { describe, it, expect } from 'vitest'
import { describeCanvas, applyCanvasCommand, verifyCanvas, summarizeCanvasChange, humanizeIdentifier, matchStylesInText, type CanvasSnapshot } from '~/lib/agent/surfaces/canvas'
import type { CatalogEntry } from '~/lib/portIntentCatalog'

const CATALOG: CatalogEntry[] = [
  { type: 'VAEDecode', name: 'VAE Decode', description: '', inputs: [{ name: 'samples', type: 'LATENT' }, { name: 'vae', type: 'VAE' }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }], widgets: [] },
  { type: 'UpscaleImage', name: 'Upscale Image', description: '', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }], widgets: [{ name: 'scale', type: 'FLOAT', default: 2 }] },
]

function graph(): CanvasSnapshot {
  return {
    nodes: [
      { id: '1', nodeType: 'CheckpointLoaderSimple', title: 'Load Checkpoint', widgets: { ckpt_name: 'sd_xl.safetensors' }, inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL' }] },
      { id: '2', nodeType: 'KSampler', title: 'KSampler', widgets: { seed: 0, steps: 20, sampler_name: 'euler' }, inputs: [{ name: 'model', type: 'MODEL' }, { name: 'latent_image', type: 'LATENT' }], outputs: [{ name: 'LATENT', type: 'LATENT' }] },
      { id: '3', nodeType: 'SaveImage', title: 'Save Image', widgets: {}, inputs: [{ name: 'images', type: 'IMAGE' }], outputs: [] },
    ],
    edges: [{ source: '1', sourcePort: 'MODEL', target: '2', targetPort: 'model' }],
    catalog: CATALOG,
  }
}

describe('describeCanvas', () => {
  it('emits one object per node + a graph summary with readable connections', () => {
    const snap = describeCanvas(graph())
    expect(snap.surface).toBe('canvas')
    expect(snap.objects.filter(o => o.type === 'node')).toHaveLength(3)
    const g = snap.objects.find(o => o.type === 'graph')!
    expect((g.current as { connections: string[] }).connections[0]).toContain('→')
  })
  it('exposes settable widget keys and connected-input flags', () => {
    const k = describeCanvas(graph()).objects.find(o => o.id === '2')!
    expect((k.current as { widgets: Record<string, unknown> }).widgets).toMatchObject({ steps: 20, sampler_name: 'euler' })
    const inputs = (k.current as { inputs: { name: string; connected: boolean }[] }).inputs
    expect(inputs.find(i => i.name === 'model')?.connected).toBe(true)
    expect(inputs.find(i => i.name === 'latent_image')?.connected).toBe(false)
  })
  it('every command carries a hint', () => {
    expect(describeCanvas(graph()).commands.every(c => typeof c.hint === 'string' && c.hint!.length > 0)).toBe(true)
  })
  it('exposes the palette of addable node types when a catalog is present', () => {
    const palette = describeCanvas(graph()).objects.find(o => o.type === 'palette')!
    expect(palette).toBeTruthy()
    expect((palette.current as { type: string }[]).map(c => c.type)).toContain('UpscaleImage')
  })
  it('splits the palette into PREFERRED capabilities vs raw nodes', () => {
    const g = graph()
    g.catalog = [
      { type: 'UpscaleImageNode', name: 'Upscale an image', description: '', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }], widgets: [], capability: true },
      { type: 'WavespeedImageUpscaleNode', name: 'WaveSpeed Image Upscale', description: '', inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }], widgets: [] },
    ]
    const objs = describeCanvas(g).objects
    const preferred = objs.find(o => o.id === 'palette')!
    const raw = objs.find(o => o.id === 'palette_raw')!
    expect((preferred.current as { type: string }[]).map(c => c.type)).toEqual(['UpscaleImageNode'])
    expect((raw.current as { type: string }[]).map(c => c.type)).toEqual(['WavespeedImageUpscaleNode'])
    expect(preferred.label).toMatch(/preferred/i)
  })
  it('exposes the user\'s trained styles/characters as a library (name, kind, trigger, file)', () => {
    const g = graph(); g.styles = [
      { name: 'Watercolor', kind: 'style', trigger: 'wtrclr', file: 'watercolor_v2.safetensors' },
      { name: 'Mia', kind: 'character', file: 'mia.safetensors' },
    ]
    const lib = describeCanvas(g).objects.find(o => o.type === 'library')!
    expect(lib).toBeTruthy()
    const items = lib.current as { name: string; kind: string; trigger?: string; file: string }[]
    expect(items.find(i => i.name === 'Watercolor')).toMatchObject({ kind: 'style', trigger: 'wtrclr', file: 'watercolor_v2.safetensors' })
    expect(items.find(i => i.name === 'Mia')).toMatchObject({ kind: 'character', file: 'mia.safetensors' })
  })
  it('omits the library when the user has no trained styles', () => {
    expect(describeCanvas(graph()).objects.find(o => o.type === 'library')).toBeUndefined()
  })
})

describe('matchStylesInText (lora_name backstop)', () => {
  const styles = [
    { name: 'Grand Theft Auto', kind: 'style' as const, trigger: 'grand_theft_auto', file: 'gta.safetensors' },
    { name: 'Mia', kind: 'character' as const, file: 'mia.safetensors' },
  ]
  it('recovers the LoRA from the trigger word in the prompt (the GTA case)', () => {
    const m = matchStylesInText('grand_theft_auto a dog, GTA art style, cel-shaded', styles)
    expect(m[0]?.file).toBe('gta.safetensors')
  })
  it('falls back to the display name when no trigger word is present', () => {
    expect(matchStylesInText('a portrait of mia on a beach', styles)[0]?.file).toBe('mia.safetensors')
  })
  it('returns nothing when no style is referenced', () => {
    expect(matchStylesInText('a generic golden retriever', styles)).toEqual([])
  })
})

describe('applyCanvasCommand', () => {
  it('setWidget sets a known widget and is invertible', () => {
    const before = graph()
    const r = applyCanvasCommand(before, { op: 'setWidget', target: '2', args: { name: 'steps', value: 30 } })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.template.nodes.find(n => n.id === '2')!.widgets.steps).toBe(30)
    const undo = applyCanvasCommand(r.template, r.inverse)
    if (!undo.ok) throw new Error('fail')
    expect(undo.template.nodes).toEqual(before.nodes)
  })
  it('setWidget rejects an unknown widget name and a missing value', () => {
    expect(applyCanvasCommand(graph(), { op: 'setWidget', target: '2', args: { name: 'nope', value: 1 } }).ok).toBe(false)
    expect(applyCanvasCommand(graph(), { op: 'setWidget', target: '2', args: { name: 'steps' } }).ok).toBe(false)
  })
  it('setMode maps mute/bypass/normal to 2/4/0; rejects garbage', () => {
    expect((applyCanvasCommand(graph(), { op: 'setMode', target: '2', args: { mode: 'mute' } }) as any).template.nodes.find((n: any) => n.id === '2').mode).toBe(2)
    expect((applyCanvasCommand(graph(), { op: 'setMode', target: '2', args: { mode: 'bypass' } }) as any).template.nodes.find((n: any) => n.id === '2').mode).toBe(4)
    expect(applyCanvasCommand(graph(), { op: 'setMode', target: '2', args: { mode: 'wat' } }).ok).toBe(false)
  })
  it('deleteNode removes the node + its edges', () => {
    const r = applyCanvasCommand(graph(), { op: 'deleteNode', target: '2' })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.template.nodes.some(n => n.id === '2')).toBe(false)
    expect(r.template.edges.length).toBe(0) // the 1→2 edge is gone
  })
  it('addNode adds a palette node with a placeholder id + default/overridden widgets', () => {
    const r = applyCanvasCommand(graph(), { op: 'addNode', args: { nodeType: 'UpscaleImage', id: '$new1', widgetOverrides: { scale: 4 } } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const n = r.template.nodes.find(x => x.id === '$new1')!
    expect(n.nodeType).toBe('UpscaleImage')
    expect(n.widgets.scale).toBe(4) // override applied (default was 2)
    expect(n.outputs[0]!.type).toBe('IMAGE')
  })
  it('addNode rejects a type not in the palette', () => {
    expect(applyCanvasCommand(graph(), { op: 'addNode', args: { nodeType: 'NotReal', id: '$x' } }).ok).toBe(false)
  })
  it('connect auto-resolves a type-compatible port pair', () => {
    // KSampler LATENT out → VAEDecode samples (LATENT). Add the decode, then connect.
    const added = applyCanvasCommand(graph(), { op: 'addNode', args: { nodeType: 'VAEDecode', id: '$dec' } })
    if (!added.ok) throw new Error('fail')
    const r = applyCanvasCommand(added.template, { op: 'connect', args: { from: '2', to: '$dec' } })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.template.edges.some(e => e.source === '2' && e.target === '$dec' && e.sourcePort === 'LATENT' && e.targetPort === 'samples')).toBe(true)
  })
  it('connect rejects an incompatible pair and a bad port name', () => {
    // Checkpoint(MODEL) → SaveImage(IMAGE) has no compatible pair.
    expect(applyCanvasCommand(graph(), { op: 'connect', args: { from: '1', to: '3' } }).ok).toBe(false)
    expect(applyCanvasCommand(graph(), { op: 'connect', args: { from: '2', to: '3', fromPort: 'NOPE' } }).ok).toBe(false)
  })
  it('connect replaces an existing edge into the same input slot', () => {
    // model input on KSampler already wired from node 1; rewire from a clone is n/a,
    // so assert single-link: connecting again into the same input keeps one edge.
    const r = applyCanvasCommand(graph(), { op: 'connect', args: { from: '1', to: '2', fromPort: 'MODEL', toPort: 'model' } })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.template.edges.filter(e => e.target === '2' && e.targetPort === 'model').length).toBe(1)
  })

  it('rejects an unknown node and an out-of-vocabulary op', () => {
    expect(applyCanvasCommand(graph(), { op: 'setWidget', target: 'zzz', args: { name: 'steps', value: 1 } }).ok).toBe(false)
    expect(applyCanvasCommand(graph(), { op: 'frobnicate' }).ok).toBe(false)
  })
  it('does not mutate the input', () => {
    const before = graph()
    applyCanvasCommand(before, { op: 'setWidget', target: '2', args: { name: 'steps', value: 99 } })
    expect(before.nodes.find(n => n.id === '2')!.widgets.steps).toBe(20)
  })
})

describe('verifyCanvas', () => {
  it('flags required inputs with nothing connected', () => {
    const issues = verifyCanvas(graph())
    expect(issues.some(i => /latent_image/.test(i.message))).toBe(true)
    expect(issues.some(i => /images/.test(i.message))).toBe(true)
  })
  it('skips checks on muted nodes', () => {
    const g = graph(); g.nodes[2]!.mode = 2
    expect(verifyCanvas(g).some(i => /images/.test(i.message))).toBe(false)
  })
  it('does not flag MASK inputs or numbered-series layers as required (no flood)', () => {
    const g: CanvasSnapshot = { nodes: [
      { id: 'c', nodeType: 'Compositor', title: 'Frame', widgets: {},
        inputs: [{ name: 'layer1', type: 'IMAGE' }, { name: 'layer2', type: 'IMAGE' }, { name: 'layer1_mask', type: 'MASK' }, { name: 'keep_subject', type: 'MASK' }],
        outputs: [{ name: 'image', type: 'IMAGE' }] },
    ], edges: [] }
    const msgs = verifyCanvas(g).map(i => i.message).join(' ')
    expect(msgs).not.toMatch(/layer2|layer1_mask|keep_subject/) // optional in practice
    expect(msgs).toMatch(/layer1/) // the first layer IS required
  })
  it('does not flag a text-to-image generator whose only input is OPTIONAL (img2img image)', () => {
    // The scenario from "generate a dog in the style of GTA": FluxLoRA added for
    // text-to-image — its `image` input is optional, so no required/isolation warns.
    const g: CanvasSnapshot = { nodes: [
      { id: 'img', nodeType: 'Image', title: 'Image', widgets: {}, inputs: [], outputs: [{ name: 'image', type: 'IMAGE' }] },
      { id: 'lora', nodeType: 'FluxLoRARemoteNode', title: 'Flux Dev + LoRA', widgets: { prompt: 'grand_theft_auto a dog', lora_name: 'gta.safetensors' },
        inputs: [{ name: 'image', type: 'IMAGE', optional: true }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }] },
    ], edges: [] }
    const msgs = verifyCanvas(g).map(i => i.message).join(' ')
    expect(msgs).not.toMatch(/image.*required|not connected/)
  })
  it('addNode preserves a catalog input\'s optional flag (so verify is correct)', () => {
    const s: CanvasSnapshot = { nodes: [], edges: [], catalog: [
      { type: 'FluxLoRARemoteNode', name: 'Flux + LoRA', description: '', inputs: [{ name: 'image', type: 'IMAGE', optional: true }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }], widgets: [{ name: 'prompt', type: 'STRING' }] },
    ] }
    const r = applyCanvasCommand(s, { op: 'addNode', args: { nodeType: 'FluxLoRARemoteNode', id: '$n1' } })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.template.nodes[0]!.inputs[0]).toMatchObject({ name: 'image', optional: true })
  })
  it('does not flag a pure-source node (no inputs) as "not connected"', () => {
    const g: CanvasSnapshot = { nodes: [
      { id: 'gen', nodeType: 'GenerateImageNode', title: 'Generate', widgets: {}, inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE' }] },
      { id: 'up', nodeType: 'Upscale', title: 'Upscale', widgets: {}, inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }] },
    ], edges: [] }
    expect(verifyCanvas(g).some(i => /Generate.*not connected/.test(i.message))).toBe(false)
  })
  it('issue messages name a node by its own title, never its internal type (shown to the user)', () => {
    const g: CanvasSnapshot = { nodes: [
      { id: 'grad', nodeType: 'GradientStudio', title: 'Gradient Studio', widgets: {}, inputs: [], outputs: [{ name: 'image', type: 'IMAGE' }] },
      { id: 'sh', nodeType: 'ShaderStudio', title: 'Shader Studio', widgets: {}, inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'image', type: 'IMAGE' }] },
    ], edges: [] }
    const msgs = verifyCanvas(g).map(i => i.message)
    expect(msgs.length).toBeGreaterThan(0)
    for (const m of msgs) {
      expect(m).toContain('Shader Studio')
      expect(m).not.toContain('(ShaderStudio)')
    }
  })
})

describe('numeric sanity on widget writes', () => {
  it('rejects absurd numeric magnitudes on setWidget', () => {
    const r = applyCanvasCommand(graph(), { op: 'setWidget', target: '2', args: { name: 'steps', value: 1e16 } })
    expect(r.ok).toBe(false)
  })
  it('rejects non-finite numbers on setWidget', () => {
    const r = applyCanvasCommand(graph(), { op: 'setWidget', target: '2', args: { name: 'steps', value: Number.POSITIVE_INFINITY } })
    expect(r.ok).toBe(false)
  })
  it('drops absurd numeric overrides on addNode instead of writing them', () => {
    const r = applyCanvasCommand(graph(), { op: 'addNode', args: { nodeType: 'UpscaleImage', widgetOverrides: { scale: 1e16 } } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const added = r.template.nodes[r.template.nodes.length - 1]!
      expect(added.widgets.scale).not.toBe(1e16) // kept the catalog default
    }
  })
})

describe('setWidget choice validation', () => {
  const g = (): CanvasSnapshot => ({ nodes: [
    { id: 'k', nodeType: 'KSampler', title: 'KSampler', widgets: { sampler_name: 'euler', steps: 20 },
      widgetOptions: { sampler_name: ['euler', 'euler_ancestral', 'dpmpp_2m'] },
      inputs: [], outputs: [] },
  ], edges: [] })
  it('accepts a valid option', () => {
    expect(applyCanvasCommand(g(), { op: 'setWidget', target: 'k', args: { name: 'sampler_name', value: 'dpmpp_2m' } }).ok).toBe(true)
  })
  it('rejects an invalid option (would break the run) and lists the choices', () => {
    const r = applyCanvasCommand(g(), { op: 'setWidget', target: 'k', args: { name: 'sampler_name', value: 'euler2' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toMatch(/euler_ancestral/)
  })
  it('a free (non-choice) widget still accepts any value', () => {
    expect(applyCanvasCommand(g(), { op: 'setWidget', target: 'k', args: { name: 'steps', value: 35 } }).ok).toBe(true)
  })
  it('describeCanvas surfaces the choices for a combo widget', () => {
    const cur = describeCanvas(g()).objects.find(o => o.id === 'k')!.current as { choices?: Record<string, string[]> }
    expect(cur.choices?.sampler_name).toContain('dpmpp_2m')
  })
})

describe('summarizeCanvasChange', () => {
  it('summarizes setWidget with a before/after', () => {
    const s = summarizeCanvasChange(graph(), { op: 'setWidget', target: '2', args: { name: 'steps', value: 30 } })
    expect(s?.before).toBe('20'); expect(s?.after).toBe('30')
  })

  // What the user reads names nodes by their own title and says widgets and
  // modes in plain words; the model-facing label keeps the identifiers.
  const untitled = (): CanvasSnapshot => ({
    nodes: [
      { id: 'g', nodeType: 'GradientStudio', title: 'GradientStudio', widgets: {}, inputs: [], outputs: [{ name: 'image', type: 'IMAGE' }] },
      { id: 'k', nodeType: 'KSampler', title: 'My sampler', widgets: { sampler_name: 'euler' }, inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [] },
      { id: 'x', nodeType: 'SomeCustomNode', title: '', widgets: {}, inputs: [], outputs: [] },
    ],
    edges: [],
  })
  const shown = (r: ReturnType<typeof summarizeCanvasChange>) => [r?.label, r?.before, r?.after].join(' | ')

  it('a node with no title of its own shows its card name, never its type', () => {
    expect(summarizeCanvasChange(untitled(), { op: 'deleteNode', target: 'g' })).toMatchObject({ label: 'Delete', before: 'Gradient Studio', after: 'removed' })
    expect(summarizeCanvasChange(untitled(), { op: 'deleteNode', target: 'x' })?.before).toBe('Some custom node')
    expect(summarizeCanvasChange(untitled(), { op: 'connect', args: { from: 'g', to: 'k' } })?.after).toBe('Gradient Studio → My sampler')
  })

  it('a widget reads in plain words; the model label keeps its name', () => {
    const r = summarizeCanvasChange(untitled(), { op: 'setWidget', target: 'k', args: { name: 'sampler_name', value: 'dpmpp_2m' } })
    expect(r).toMatchObject({ label: 'My sampler · Sampler name', before: 'euler', after: 'dpmpp_2m', modelLabel: 'My sampler (KSampler) · sampler_name' })
  })

  it('a mode change says muted / bypassed / normal', () => {
    expect(summarizeCanvasChange(untitled(), { op: 'setMode', target: 'k', args: { mode: 'bypass' } })?.after).toBe('bypassed')
    expect(summarizeCanvasChange(untitled(), { op: 'setMode', target: 'k', args: { mode: 'mute' } })?.after).toBe('muted')
    expect(summarizeCanvasChange(untitled(), { op: 'setMode', target: 'k', args: { mode: 'normal' } })?.after).toBe('normal')
  })

  it('an added type with no catalog entry, and an unknown op, never show identifiers or JSON', () => {
    expect(summarizeCanvasChange(untitled(), { op: 'addNode', args: { nodeType: 'TextureStudio', id: '$new1' } })?.after).toBe('Texture studio')
    const other = summarizeCanvasChange(untitled(), { op: 'tuneNode', target: 'g', args: { request: 'bluer' } })
    expect(shown(other)).not.toMatch(/[{}]|tuneNode/)
    expect(other?.modelLabel).toBe('tuneNode')
  })

  it('humanizes identifiers', () => {
    expect(humanizeIdentifier('sampler_name')).toBe('Sampler name')
    expect(humanizeIdentifier('GradientStudio')).toBe('Gradient studio')
    expect(humanizeIdentifier('denoiseStrength')).toBe('Denoise strength')
  })
})
