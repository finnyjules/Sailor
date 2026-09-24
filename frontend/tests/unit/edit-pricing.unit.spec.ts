/**
 * Task P4 (model line-up): the image edit tools are priced by the call their
 * settings make — the resolution or size sent, the model picked — at the
 * first service's rate (shared/pricing/editRates.ts × editSettings.ts), and
 * Upscale / Enhance detail at the largest accepted input × the scale chosen.
 * The badge, the run estimate and the charge all read the one calculation.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { planNode } from '~~/server/runner/executors'
import { stageEstimate } from '~~/server/runner/metering'
import { RESTYLE_MODELS } from '~~/server/runner/generators/restyle'
import { REFERENCE_MODEL_IDS } from '~~/server/runner/generators/refEdits'
import { GRAPH_NODE_CREDITS, UnpricedGraphError, priceGraph } from '~~/server/utils/priceBook'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_NODE_RULES } from '#shared/runner/eligibility'
import { EDIT_RATES, editRate, editUsd, type EditCall } from '#shared/pricing/editRates'
import {
  ENHANCE_ENGINE_SLUGS, LARGEST_INPUT_PIXELS, SETTING_PRICED_NODE_CLASSES, UPSCALE_ENGINE_SLUGS, editCalls,
} from '#shared/pricing/editSettings'
import { priceNode } from '#shared/pricing/nodePrice'
import { MODEL_PRICED_BADGE_CLASSES, nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes, widgetValueMap } from '~/lib/costEstimate'
import type { OutputFile } from '~~/server/runner/types'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const PY = readFileSync(`${REPO}comfy_api_nodes/nodes_replicate.py`, 'utf8')
const PY_REFS = readFileSync(`${REPO}comfy_api_nodes/replicate_refs.py`, 'utf8')

const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]

/** What priceGraph charges for one node plus an output node (1 credit base render). */
const charge = (ct: string, inputs: Record<string, unknown>) =>
  priceGraph({ 1: { class_type: ct, inputs }, 2: SINK }).credits

/** The Python option list `name = [...]` in nodes_replicate.py. */
function pyList(name: string, src = PY): string[] {
  const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]+)\\]`).exec(src)
  if (!m) throw new Error(`${name} moved`)
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map(x => x[1]!)
}

const EDIT_MODELS = pyList('_IMAGE_EDIT_MODELS')
const BLEND_MODELS = pyList('_BLEND_SCENE_MODELS')
const UPSCALE_MODELS = pyList('_UPSCALE_MODELS')
const ENHANCE_MODELS = pyList('ENHANCE_ENGINES', PY_REFS)

// ── The settings grid ────────────────────────────────────────────────────

/** Values a resolution / size widget may hold: the good ones and odd ones. */
const TIER_VALUES: unknown[] = ['1K', '2K', '4K', '3K', '0.5K', '', 'foo', 7, null, true, undefined]

/** The pictures each runner class needs linked, and the text it needs to make its call. */
const RUNNER_BASE: Record<string, Record<string, unknown>> = {
  EditImageNode: { input_image: LINK, prompt: 'make it blue' },
  DevelopImageNode: { input_image: LINK },
  RelightNode: { image: LINK },
  BlendSceneNode: { image: LINK },
  RemoveObjectNode: { image: LINK, target: 'the cup' },
  TextEditNode: { image: LINK, find: 'SALE', replace: 'NEW' },
  RecolorObjectNode: { image: LINK, target: 'the cup', color: 'red' },
  SwapBackgroundNode: { product: LINK, scene_prompt: 'a beach' },
  SwapProductNode: { scene_reference: LINK, product: LINK },
  PersonSwap: { scene: LINK, person: LINK },
  GenerateFromReferencesNode: { image_1: LINK, prompt: 'a poster' },
  RotateCameraNode: { image: LINK },
  ProductShotNode: { image: LINK },
  RestyleFromImageNode: { content_image: LINK, style_image: LINK },
}

/** Every widget combination the grid runs for a class: model × its tier widget. */
function settingsGrid(ct: string): Record<string, unknown>[] {
  const withTier = (name: string, base: Record<string, unknown>) =>
    TIER_VALUES.map(v => (v === undefined ? { ...base } : { ...base, [name]: v }))
  switch (ct) {
    case 'EditImageNode': return EDIT_MODELS.flatMap(model => withTier('resolution', { model }))
    case 'DevelopImageNode': return withTier('resolution', {})
    case 'BlendSceneNode': return BLEND_MODELS.map(model => ({ model }))
    case 'GenerateFromReferencesNode': return REFERENCE_MODEL_IDS.flatMap(model => withTier('size', { model }))
    case 'RestyleFromImageNode': return RESTYLE_MODELS.flatMap(model => withTier('resolution', { model }))
    // The classes with no priced widget: resolution is not a widget of theirs, and must not move the price.
    default: return withTier('resolution', {})
  }
}

/** The call the runner makes for this node, as planNode builds it. */
async function runnerCall(ct: string, widgets: Record<string, unknown>) {
  const prompt: ApiPrompt = { n: { class_type: ct, inputs: { ...RUNNER_BASE[ct], ...widgets } } }
  const plan = await planNode({
    prompt, nodeId: 'n', gateOpen: false,
    filesFrom: () => [{ filename: 'a.png', subfolder: '', type: 'output' }],
    toUrl: async (f: OutputFile) => `https://x/${f.filename}`,
  })
  if (plan.kind !== 'provider') throw new Error(`${ct} made no call`)
  return plan
}

/** The billed tier of a call: what a by-resolution card reads (null for the others). */
function billedTier(endpoint: string, tier: unknown): string | null {
  return editRate(endpoint)?.unit === 'by_resolution' ? (tier as string) : null
}

const only = (ct: string, inputs: Record<string, unknown>): EditCall => {
  const c = editCalls(ct, inputs)
  if ('refused' in c) throw new Error(`${ct} refused: ${c.refused}`)
  expect(c.calls).toHaveLength(1)
  return c.calls[0]!
}

// ── Rate cards ───────────────────────────────────────────────────────────

/** Billed by GPU time: no published per-unit figure. */
const ESTIMATES = ['catacolabs/sdxl-ad-inpaint', 'fermatresearch/magic-image-refiner', 'fofr/style-transfer', 'philz1337x/clarity-upscaler']

describe('edit rate cards', () => {
  it('every card carries a source, the date read and a confidence; only GPU-time models are estimates', () => {
    for (const [endpoint, r] of Object.entries(EDIT_RATES)) {
      expect(r.source, endpoint).toMatch(/^https:\/\/(fal\.ai\/models\/.+\/llms\.txt|replicate\.com\/.+)$/)
      expect(r.source, endpoint).toContain(endpoint)
      expect(r.read, endpoint).toBe('2026-09-24')
      expect(r.service, endpoint).toBe(r.source.includes('fal.ai') ? 'fal' : 'replicate')
    }
    const est = Object.entries(EDIT_RATES).filter(([, r]) => r.confidence === 'estimate').map(([k]) => k).sort()
    expect(est).toEqual(ESTIMATES)
  })

  it('the only estimates a runner family can turn on are the two legacy engines being retired', () => {
    // Product shot (ref-edits) and Restyle's IP-Adapter engine (restyle): decision 7 hides them.
    const reachable = new Set<string>()
    for (const ct of SETTING_PRICED_NODE_CLASSES) {
      if (!(ct in RUNNER_NODE_RULES)) continue
      for (const w of settingsGrid(ct)) {
        const c = editCalls(ct, w)
        if (!('refused' in c)) for (const one of c.calls) reachable.add(one.endpoint)
      }
    }
    const est = [...reachable].filter(e => EDIT_RATES[e]!.confidence === 'estimate').sort()
    expect(est).toEqual(['catacolabs/sdxl-ad-inpaint', 'fofr/style-transfer'])
  })

  it('every call any setting makes has a card, priced above 0', () => {
    for (const ct of [...SETTING_PRICED_NODE_CLASSES, 'UpscaleImageNode', 'EnhanceDetailNode']) {
      const grid = ct === 'UpscaleImageNode' ? UPSCALE_MODELS.map(model => ({ model }))
        : ct === 'EnhanceDetailNode' ? ENHANCE_MODELS.map(model => ({ model }))
          : settingsGrid(ct)
      for (const w of grid) {
        const c = editCalls(ct, w)
        if ('refused' in c) throw new Error(`${ct} ${JSON.stringify(w)} refused: ${c.refused}`)
        for (const one of c.calls) {
          expect(editRate(one.endpoint), `${ct} → ${one.endpoint}`).toBeTruthy()
          expect(editUsd(one), `${ct} → ${one.endpoint}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('a prototype name is not a card', () => {
    expect(editRate('constructor')).toBeUndefined()
    expect(editRate('__proto__')).toBeUndefined()
  })
})

// ── Priced on what is sent ───────────────────────────────────────────────

describe('settings parity: the price reads what each runner builder sends', () => {
  it('control: the grid reaches every endpoint the runner families use', async () => {
    const seen = new Set<string>()
    for (const ct of Object.keys(RUNNER_BASE)) {
      for (const w of settingsGrid(ct)) seen.add((await runnerCall(ct, w)).endpoint)
    }
    expect([...seen].sort()).toEqual([
      'bytedance/seedream-5-lite', 'bytedance/seedream-5-pro', 'catacolabs/sdxl-ad-inpaint',
      'fal-ai/flux-2-pro/edit', 'fal-ai/flux-pro/kontext', 'fal-ai/nano-banana-2/edit', 'fal-ai/nano-banana-pro/edit',
      'fofr/style-transfer', 'google/nano-banana', 'google/nano-banana-2', 'qwen/qwen-image-edit-plus',
    ])
  })

  for (const ct of Object.keys(RUNNER_BASE)) {
    it(`${ct}: endpoint and billed resolution match the request, over every setting`, async () => {
      let n = 0
      for (const w of settingsGrid(ct)) {
        const plan = await runnerCall(ct, w)
        const mine = only(ct, w)
        const label = `${ct} ${JSON.stringify(w)}`
        expect(mine.endpoint, label).toBe(plan.endpoint)
        // A by-resolution card reads the tier the payload carries: Nano Banana's `resolution`, Seedream's `size`.
        const sent = plan.payload.resolution ?? plan.payload.size
        expect(billedTier(mine.endpoint, mine.tier), label).toBe(billedTier(plan.endpoint, sent))
        n++
      }
      expect(n).toBeGreaterThan(0)
    })
  }

  it('FLUX.2 edit is priced at the largest input, in and out (the builder sends the picture as it is)', () => {
    for (const ct of ['EditImageNode', 'BlendSceneNode']) {
      const c = only(ct, { model: 'Flux 2 Pro' })
      expect(c).toEqual({ endpoint: 'fal-ai/flux-2-pro/edit', tier: null, inputPixels: LARGEST_INPUT_PIXELS, outputPixels: LARGEST_INPUT_PIXELS })
    }
  })

  it('Upscale and Enhance detail: the engines and what they send match the Python nodes', () => {
    const slugs = /_UPSCALE_SLUGS\s*=\s*\{([^}]+)\}/.exec(PY)![1]!
    const pySlugs = Object.fromEntries([...slugs.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(m => [m[1]!, m[2]!]))
    expect(UPSCALE_ENGINE_SLUGS).toEqual(pySlugs)
    expect(Object.keys(UPSCALE_ENGINE_SLUGS)).toEqual(UPSCALE_MODELS)
    expect(Object.keys(ENHANCE_ENGINE_SLUGS)).toEqual(ENHANCE_MODELS)
    // build_enhance_input: each engine's slug, all in place.
    const enhance = PY_REFS.slice(PY_REFS.indexOf('def build_enhance_input'))
    expect(enhance).toContain('return "philz1337x/clarity-upscaler", body')
    expect(enhance).toMatch(/"scale_factor": 1\.0/)
    expect(enhance).toContain('return "topazlabs/image-upscale", {')
    expect(enhance).toMatch(/"upscale_factor": "None"/)
    expect(enhance).toContain('return "fermatresearch/magic-image-refiner", body')
    expect(enhance).toMatch(/"resolution": "original"/)
    // UpscaleImageNode: Clarity and Crystal send scale_factor (1–10, default 2); Topaz its own factor.
    expect(PY).toMatch(/IO\.Float\.Input\("scale_factor", default=2\.0, min=1\.0, max=10\.0/)
    expect(PY).toMatch(/IO\.Combo\.Input\("topaz_upscale_factor", options=\["None", "2x", "4x", "6x"\],\s*default="2x"/)
    const upscale = PY.slice(PY.indexOf('class UpscaleImageNode'), PY.indexOf('class EnhanceDetailNode'))
    expect(upscale).toMatch(/"scale_factor": scale_factor/)
    expect(upscale).toMatch(/"scale_factor": float\(scale_factor\)/)
    expect(upscale).toMatch(/"upscale_factor": topaz_upscale_factor/)
  })

  it('Lens reframe makes the Nano Banana actions\' call: google/nano-banana-2 at 1K (ComfyUI path)', () => {
    const src = readFileSync(`${REPO}comfy_extras/nodes_lens_reframe.py`, 'utf8')
    expect(src).toContain('_run_prediction("google/nano-banana-2", {')
    expect(src).toContain('"resolution": "1K"')
    expect(only('LensReframe', {})).toEqual(only('RemoveObjectNode', {}))
  })
})

// ── Worked examples ──────────────────────────────────────────────────────

/** [class, widgets, first-service USD, credits]. */
const EXAMPLES: [string, Record<string, unknown>, number, number][] = [
  ['EditImageNode', { model: 'Nano Banana 2', resolution: '1K' }, 0.08, 16],
  ['EditImageNode', { model: 'Nano Banana 2', resolution: '2K' }, 0.12, 18],
  ['EditImageNode', { model: 'Nano Banana 2', resolution: '4K' }, 0.16, 24],
  ['EditImageNode', { model: 'Flux Kontext Pro', resolution: '4K' }, 0.04, 8],
  // 4 MP in + 4 MP out = 8 MP: $0.03 + 7 × $0.015.
  ['EditImageNode', { model: 'Flux 2 Pro' }, 0.135, 21],
  ['DevelopImageNode', { resolution: '1K' }, 0.08, 16],
  ['DevelopImageNode', { resolution: '2K' }, 0.12, 18],
  ['DevelopImageNode', { resolution: '4K' }, 0.16, 24],
  ['RelightNode', {}, 0.08, 16],
  ['BlendSceneNode', { model: 'Flux 2 Pro' }, 0.135, 21],
  ['BlendSceneNode', { model: 'Flux Kontext Pro' }, 0.04, 8],
  ['BlendSceneNode', { model: 'Nano Banana' }, 0.039, 8],
  ['RemoveObjectNode', {}, 0.067, 14],
  ['PersonSwap', {}, 0.067, 14],
  ['LensReframe', {}, 0.067, 14],
  ['GenerateFromReferencesNode', { model: 'seedream-5-pro', size: '1K' }, 0.045, 9],
  ['GenerateFromReferencesNode', { model: 'seedream-5-pro', size: '2K' }, 0.09, 18],
  ['GenerateFromReferencesNode', { model: 'seedream-5-pro', size: '3K' }, 0.09, 18],
  ['GenerateFromReferencesNode', { model: 'seedream-5-lite', size: '3K' }, 0.035, 7],
  ['GenerateFromReferencesNode', { model: 'nano-banana-2', size: '1K' }, 0.08, 16],
  ['GenerateFromReferencesNode', { model: 'nano-banana-2', size: '3K' }, 0.12, 18],
  ['RotateCameraNode', {}, 0.03, 6],
  ['ProductShotNode', {}, 0.16, 24],
  ['RestyleFromImageNode', { model: 'Nano Banana 2', resolution: '1K' }, 0.08, 16],
  ['RestyleFromImageNode', { model: 'Nano Banana Pro', resolution: '2K' }, 0.15, 23],
  ['RestyleFromImageNode', { model: 'Nano Banana Pro', resolution: '4K' }, 0.30, 45],
  ['RestyleFromImageNode', { model: 'Nano Banana', resolution: '4K' }, 0.039, 8],
  ['RestyleFromImageNode', { model: 'Style Transfer · IP-Adapter' }, 0.05, 10],
  // Upscale: 4 MP in, × scale² out.
  ['UpscaleImageNode', { model: 'Clarity' }, 0.20, 30],
  ['UpscaleImageNode', { model: 'Clarity', scale_factor: 4 }, 0.80, 120],
  ['UpscaleImageNode', { model: 'Crystal', scale_factor: 1 }, 0.05, 10],
  ['UpscaleImageNode', { model: 'Crystal' }, 0.20, 30],
  ['UpscaleImageNode', { model: 'Crystal', scale_factor: 10 }, 3.20, 480],
  ['UpscaleImageNode', { model: 'Real-ESRGAN', scale_factor: 10 }, 0.002, 1],
  ['UpscaleImageNode', { model: 'Recraft Crisp' }, 0.006, 2],
  ['UpscaleImageNode', { model: 'Topaz' }, 0.08, 16],
  ['UpscaleImageNode', { model: 'Topaz', topaz_upscale_factor: '4x' }, 0.32, 48],
  ['UpscaleImageNode', { model: 'Topaz', topaz_upscale_factor: '6x' }, 0.48, 72],
  ['EnhanceDetailNode', { model: 'Creative' }, 0.20, 30],
  ['EnhanceDetailNode', { model: 'Faithful' }, 0.08, 16],
  ['EnhanceDetailNode', { model: 'Diffusion Refine' }, 0.124, 19],
]

describe('worked examples', () => {
  it.each(EXAMPLES)('%s %j: $%s, %s credits; badge = charge = estimate', (ct, w, usd, credits) => {
    const p = priceNode(ct, w)
    expect(p).toEqual({ usd, credits })
    expect(charge(ct, w)).toBe(credits + 1)
    expect(nodeCreditEstimate(ct, w)).toBe(credits + 1)
    const names = Object.keys(w)
    const est = estimateUsdForNodes([{ id: '1', type: ct, widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(k => w[k]) }], { hosted: true })
    expect(est?.hostedCredits).toBe(credits + 1)
  })

  it('a linked setting is priced at its dearest value, a linked or missing model at the dearest model', () => {
    expect(priceNode('DevelopImageNode', { resolution: LINK })).toEqual({ usd: 0.16, credits: 24 })
    expect(priceNode('RestyleFromImageNode', { model: 'Nano Banana Pro', resolution: LINK })).toEqual({ usd: 0.30, credits: 45 })
    expect(priceNode('GenerateFromReferencesNode', { model: 'seedream-5-pro', size: LINK })).toEqual({ usd: 0.09, credits: 18 })
    // Linked model, 1K: the dearest of NB2 1K ($0.08), Kontext ($0.04), FLUX.2 ($0.135).
    expect(priceNode('EditImageNode', { model: LINK, resolution: '1K' })).toEqual({ usd: 0.135, credits: 21 })
    expect(priceNode('EditImageNode', { resolution: '4K' })).toEqual({ usd: 0.16, credits: 24 })
    expect(priceNode('RestyleFromImageNode', { model: LINK, resolution: '4K' })).toEqual({ usd: 0.30, credits: 45 })
    expect(priceNode('UpscaleImageNode', { model: 'Crystal', scale_factor: LINK })).toEqual({ usd: 3.20, credits: 480 })
    expect(priceNode('UpscaleImageNode', { model: 'Topaz', topaz_upscale_factor: LINK })).toEqual({ usd: 0.48, credits: 72 })
  })

  it('a model the node does not offer is refused; so is an Upscale with no engine', () => {
    for (const ct of ['EditImageNode', 'BlendSceneNode', 'GenerateFromReferencesNode', 'RestyleFromImageNode', 'UpscaleImageNode', 'EnhanceDetailNode']) {
      expect(() => charge(ct, { model: 'Magic' }), ct).toThrow(UnpricedGraphError)
      expect(nodeCreditEstimate(ct, { model: 'Magic' }), ct).toBeNull()
    }
    expect(() => charge('UpscaleImageNode', {})).toThrow(UnpricedGraphError)
    expect(() => charge('EditImageNode', { model: 'constructor' })).toThrow(UnpricedGraphError)
  })

  it('the edit classes left the flat table: one price each, from the shared calculation', () => {
    for (const ct of SETTING_PRICED_NODE_CLASSES) {
      expect(GRAPH_NODE_CREDITS[ct], ct).toBeUndefined()
      expect(MODEL_PRICED_BADGE_CLASSES.has(ct), ct).toBe(true)
    }
    // A class with no model widget keeps its bare name in the breakdown.
    expect(priceGraph({ 1: { class_type: 'DevelopImageNode', inputs: {} } }).breakdown).toEqual([{ action: 'DevelopImageNode', credits: 16 }])
  })

  it('the runner holds the same credits for a stage', () => {
    const prompt: ApiPrompt = { 1: { class_type: 'DevelopImageNode', inputs: { input_image: ['0', 0], resolution: '4K' } } }
    expect(stageEstimate(prompt, ['1'], true)).toBe(24 + 1)
  })
})

// ── Badge = charge over every setting ────────────────────────────────────

describe('badge = charge', () => {
  const classes = [...SETTING_PRICED_NODE_CLASSES, 'UpscaleImageNode', 'EnhanceDetailNode']
  const grid = (ct: string): Record<string, unknown>[] => {
    if (ct === 'UpscaleImageNode') {
      return UPSCALE_MODELS.flatMap(model => [1, 1.5, 2, 4, 10, 11, 0, '3', 'x', undefined].flatMap(s =>
        ['None', '2x', '4x', '6x', 'odd', undefined].map(f => ({ model, scale_factor: s, topaz_upscale_factor: f }))))
    }
    if (ct === 'EnhanceDetailNode') return ENHANCE_MODELS.map(model => ({ model, detail_strength: 0.4 }))
    return settingsGrid(ct)
  }
  // The widgets each class could have linked.
  const LINKABLE = ['model', 'resolution', 'size', 'scale_factor', 'topaz_upscale_factor']

  for (const ct of classes) {
    it(`${ct}: the badge (raw and as the canvas maps widgets, linked or not) equals the charge`, () => {
      let n = 0
      for (const w of grid(ct)) {
        for (const linked of [[], ...LINKABLE.filter(k => k in w || k === 'model').map(k => [k])]) {
          const names = Object.keys(w)
          const map = widgetValueMap(names.map(name => ({ name })), names.map(k => w[k]), linked)
          const inputs = { ...w, ...Object.fromEntries(linked.map(k => [k, LINK])) }
          let want: number | null
          try { want = charge(ct, inputs) }
          catch (e) { if (!(e instanceof UnpricedGraphError)) throw e; want = null }
          expect(nodeCreditEstimate(ct, map), `${ct} ${JSON.stringify(inputs)}`).toBe(want)
          expect(nodeCreditEstimate(ct, inputs), `${ct} ${JSON.stringify(inputs)}`).toBe(want)
          n++
        }
      }
      expect(n).toBeGreaterThan(5)
    })
  }
})

// ── The line-up page's loss table ────────────────────────────────────────

/** The edit rows of the line-up page's "Where we lose money today" table: [class, widgets, the service's price]. */
const LOSS_ROWS: [string, string, Record<string, unknown>, number][] = [
  ['Restyle on Nano Banana Pro 4K', 'RestyleFromImageNode', { model: 'Nano Banana Pro', resolution: '4K' }, 0.30],
  ['Product shot (SDXL) one run', 'ProductShotNode', {}, 0.16],
  ['Develop 2K', 'DevelopImageNode', { resolution: '2K' }, 0.12],
  ['Develop 4K', 'DevelopImageNode', { resolution: '4K' }, 0.16],
  ['Upscale: Crystal, large output', 'UpscaleImageNode', { model: 'Crystal', scale_factor: 10 }, 3.20],
  ['Upscale: Topaz, large output', 'UpscaleImageNode', { model: 'Topaz', topaz_upscale_factor: '6x' }, 0.48],
  ['Relight', 'RelightNode', {}, 0.08],
  ['Nano Banana actions', 'SwapBackgroundNode', {}, 0.067],
  ['References at 2K (Seedream 5 Pro)', 'GenerateFromReferencesNode', { model: 'seedream-5-pro', size: '2K' }, 0.09],
  ['References at 2K (Nano Banana 2)', 'GenerateFromReferencesNode', { model: 'nano-banana-2', size: '2K' }, 0.12],
  // The legacy engines, priced above cost until they are hidden.
  ['Restyle, plain Nano Banana', 'RestyleFromImageNode', { model: 'Nano Banana' }, 0.039],
  ['Restyle, Style Transfer · IP-Adapter (typical run)', 'RestyleFromImageNode', { model: 'Style Transfer · IP-Adapter' }, 0.0073],
]

describe('the loss table: no edit row is below cost', () => {
  it.each(LOSS_ROWS)('%s: charged at or above what it costs', (_label, ct, w, cost) => {
    const credits = charge(ct, w) - 1
    expect(credits / 100).toBeGreaterThanOrEqual(cost)
  })
})
