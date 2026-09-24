/**
 * Graph price book coverage + model-aware pricing (Stage 5 Task 3).
 *
 * The bug this locks down: a provider node class missing from the price table
 * priced a whole graph at 1 credit (base_render) — a real Flux 2 Pro run went
 * out at 1cr because GenerateImageNode wasn't in the table. Every provider
 * node class must now be priced, model-priced, or explicitly exempt, and
 * anything else REFUSES the graph.
 *
 * The guards below read the Python node modules at TEST time (never at
 * runtime) so drift between the Python surface and the price book fails here
 * rather than in production.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  GRAPH_NODE_CREDITS,
  MODEL_PRICED_NODE_CLASSES,
  PROVIDER_NODE_CLASSES,
  PROVIDER_NODE_EXEMPT,
  UnpricedGraphError,
  VIDEO_MODEL_USD,
  creditsForUsdServer,
  priceGraph,
} from '../../server/utils/priceBook'
import { creditsForUsd } from '~/lib/pricing'
import { IMAGE_MODELS } from '~~/app/data/image-models'
import { VIDEO_MODELS } from '~~/app/data/video-models'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const PY = readFileSync(join(REPO, 'comfy_api_nodes/nodes_replicate.py'), 'utf8')
const CLASS_RE = /class ([A-Za-z0-9_]+)\(IO\.ComfyNode\)/g

/**
 * The node_id of every IO.ComfyNode class in a Python module — the name the
 * canvas sends as class_type, and so the name priceGraph must key on. It can
 * differ from the Python class name (PersonSwapNode → "PersonSwap"); keying
 * the price book by class name once priced three nodes at 0 in hosted.
 */
function nodeIdsOf(src: string): string[] {
  const heads = [...src.matchAll(CLASS_RE)]
  return heads.map((m, i) => {
    const body = src.slice(m.index! + m[0].length, heads[i + 1]?.index ?? src.length)
    const id = /node_id\s*=\s*"([^"]+)"/.exec(body)?.[1]
    if (!id) throw new Error(`class ${m[1]} has no node_id`)
    return id
  })
}

const REPLICATE_CLASSES = nodeIdsOf(PY)

/** comfy_extras nodes that dispatch to a provider: the marker is the lazy
 *  `from comfy_api_nodes.nodes_replicate import ...` every one of them uses. */
function comfyExtrasProviderClasses(): string[] {
  const dir = join(REPO, 'comfy_extras')
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.py')) continue
    const src = readFileSync(join(dir, name), 'utf8')
    if (!src.includes('from comfy_api_nodes.nodes_replicate import')) continue
    out.push(...nodeIdsOf(src))
  }
  return out
}
const EXTRAS_CLASSES = comfyExtrasProviderClasses()
const ALL_PROVIDER_CLASSES = [...REPLICATE_CLASSES, ...EXTRAS_CLASSES]

function classify(c: string): 'flat' | 'model' | 'exempt' | 'UNCLASSIFIED' {
  if (c in GRAPH_NODE_CREDITS) return 'flat'
  if (MODEL_PRICED_NODE_CLASSES.includes(c)) return 'model'
  if (c in PROVIDER_NODE_EXEMPT) return 'exempt'
  return 'UNCLASSIFIED'
}

describe('graph price book coverage', () => {
  it('finds a plausible number of provider classes (the grep is not broken)', () => {
    expect(REPLICATE_CLASSES.length).toBeGreaterThan(40)
    expect(EXTRAS_CLASSES.length).toBeGreaterThan(5)
  })

  it('every provider node class is priced, model-priced, or exempt with a reason', () => {
    const unclassified = ALL_PROVIDER_CLASSES.filter(c => classify(c) === 'UNCLASSIFIED')
    expect(unclassified).toEqual([])
  })

  it('the checked-in provider-class list matches the Python surface (drift guard)', () => {
    expect([...PROVIDER_NODE_CLASSES].sort()).toEqual([...new Set(ALL_PROVIDER_CLASSES)].sort())
  })

  it('the guard reads node_ids, not Python class names', () => {
    expect(EXTRAS_CLASSES).toContain('PersonSwap')
    expect(EXTRAS_CLASSES).not.toContain('PersonSwapNode')
  })

  it('prices the nodes whose node_id differs from their class name, as the canvas sends them', () => {
    const base = priceGraph({ 2: { class_type: 'SaveImage', inputs: {} } }).credits
    expect(priceGraph({ 1: { class_type: 'PersonSwap', inputs: {} } }).credits).toBe(10)
    expect(priceGraph({ 1: { class_type: 'PersonSwap', inputs: {} }, 2: { class_type: 'SaveImage', inputs: {} } }).credits).toBe(10 + base)
    expect(priceGraph({ 1: { class_type: 'LensReframe', inputs: {} } }).credits).toBe(10)
    expect(priceGraph({ 1: { class_type: 'PoseMannequin', inputs: {} } }).credits).toBe(10)
    expect(priceGraph({ 1: { class_type: 'IdeogramV3TurboRemoteNode', inputs: {} } }).credits).toBe(6)
  })

  it('every exempt class carries a non-empty reason', () => {
    for (const [cls, reason] of Object.entries(PROVIDER_NODE_EXEMPT)) {
      expect(reason.length, `${cls} has no exemption reason`).toBeGreaterThan(10)
    }
  })

  it('every flat price is a positive integer', () => {
    for (const [cls, credits] of Object.entries(GRAPH_NODE_CREDITS)) {
      expect(Number.isInteger(credits) && credits >= 1, `${cls} = ${credits}`).toBe(true)
    }
  })

  it('an unknown provider-looking class refuses instead of pricing at base', () => {
    const prompt = {
      1: { class_type: REPLICATE_CLASSES[0]!, inputs: {} },
      2: { class_type: 'SaveImage', inputs: {} },
    }
    // Control: the FIRST provider class must price above base or throw —
    // never fall through silently at base_render.
    let threw = false
    let priced = 0
    try { priced = priceGraph(prompt).credits }
    catch (e) { threw = e instanceof UnpricedGraphError }
    expect(threw || priced > 1).toBe(true)
  })

  it('refuses a provider class that is not in any table', () => {
    // A class that LOOKS like one of ours but is unknown must not slip through.
    expect(() => priceGraph({
      1: { class_type: 'TotallyNewProviderRemoteNode', inputs: {} },
      2: { class_type: 'SaveImage', inputs: {} },
    })).toThrow(UnpricedGraphError)
  })

  it('the refusal carries the offending class type', () => {
    try {
      priceGraph({ 1: { class_type: 'SomethingElseRemoteNode', inputs: {} } })
      throw new Error('expected a refusal')
    }
    catch (e) {
      expect(e).toBeInstanceOf(UnpricedGraphError)
      expect((e as UnpricedGraphError).classType).toBe('SomethingElseRemoteNode')
    }
  })

  it('local (non-provider) classes still price at base render only', () => {
    const p = priceGraph({
      1: { class_type: 'KSampler', inputs: {} },
      2: { class_type: 'CheckpointLoaderSimple', inputs: {} },
      3: { class_type: 'SaveImage', inputs: {} },
    })
    expect(p.credits).toBe(1)
  })

  it('keeps the spike-v3 hand-set prices for the classes that stayed flat', () => {
    expect(GRAPH_NODE_CREDITS.EditImageNode).toBe(23)
    expect(GRAPH_NODE_CREDITS.LipSyncNode).toBe(150)
    expect(GRAPH_NODE_CREDITS.LoraTrainingNode).toBe(600)
    expect(GRAPH_NODE_CREDITS.RestyleWithLoRANode).toBe(18)
    expect(GRAPH_NODE_CREDITS.FluxLoRARemoteNode).toBe(8)
    expect(GRAPH_NODE_CREDITS.FluxMultiLoRARemoteNode).toBe(8)
  })

  // Review fix (Stage 5 Task 3): the original badge sweep grepped for the
  // single-line `price_badge=IO.PriceBadge(expr=...)` form only and missed
  // the multi-line `price_badge=IO.PriceBadge(\n  expr=...,\n)` form these
  // three classes use. Kling is point-priced so its badge stands. Clarity and
  // Seedance2 are RANGE-priced (Clarity's own description quotes $0.05–0.20
  // by scale_factor · Seedance2's video_models.py catalog entry tops out at
  // $0.60/clip) and the SAME slugs are priced at range top via the picker
  // nodes (UpscaleImageNode "Clarity" row · GenerateVideoNode seedance-2.0),
  // so a badge-bottom price on the dedicated node would underprice the exact
  // same call. Review ruling (2026-08-17): price at range top so the
  // expensive setting is never underpriced — badge divergence ($0.10/$0.50
  // vs range-top $0.20/$0.60) flagged for the pre-launch invoice sweep.
  it('prices Clarity/Kling/Seedance2 off their multi-line price_badge USD', () => {
    expect(GRAPH_NODE_CREDITS.ClarityUpscaleRemoteNode).toBe(creditsForUsdServer(0.20))
    expect(GRAPH_NODE_CREDITS.ClarityUpscaleRemoteNode).toBe(30)
    expect(GRAPH_NODE_CREDITS.KlingVideoRemoteNode).toBe(creditsForUsdServer(0.35))
    expect(GRAPH_NODE_CREDITS.KlingVideoRemoteNode).toBe(53)
    expect(GRAPH_NODE_CREDITS.Seedance2RemoteNode).toBe(creditsForUsdServer(0.60))
    expect(GRAPH_NODE_CREDITS.Seedance2RemoteNode).toBe(90)
  })
})

describe('server pricing policy', () => {
  it('matches the client helper across a USD sweep (policy mirror)', () => {
    const sweep = [0.0001, 0.001, 0.002, 0.003, 0.005, 0.01, 0.02, 0.025, 0.04,
      0.05, 0.06, 0.067, 0.08, 0.0999, 0.1, 0.1001, 0.15, 0.2, 0.3, 0.34, 0.4,
      0.5, 0.6, 0.75, 0.9, 1, 1.2, 2, 3.2, 6]
    for (const usd of sweep) {
      expect(creditsForUsdServer(usd), `usd=${usd}`).toBe(creditsForUsd(usd))
    }
  })

  it('never returns a fractional or negative credit count', () => {
    for (const usd of [0.0001, 0.03, 0.101, 7.77]) {
      const c = creditsForUsdServer(usd)
      expect(Number.isInteger(c) && c >= 1).toBe(true)
    }
  })
})

describe('model-aware pricing: images', () => {
  const save = { 2: { class_type: 'SaveImage', inputs: {} } }

  it('GenerateImageNode prices by its model widget', () => {
    const cheap = priceGraph({ 1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell' } }, ...save })
    const rich = priceGraph({ 1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-2-max' } }, ...save })
    expect(rich.credits).toBeGreaterThan(cheap.credits)
    expect(cheap.credits).toBeGreaterThanOrEqual(2) // base_render 1 + 1cr floor
  })

  it('prices every catalog model with a listed price', () => {
    for (const m of IMAGE_MODELS) {
      if (m.pricePerImage == null) continue
      const p = priceGraph({ 1: { class_type: 'GenerateImageNode', inputs: { model: m.id } } })
      expect(p.credits, m.id).toBe(creditsForUsdServer(m.pricePerImage))
    }
  })

  it('GenerateImageNode with an unknown model REFUSES', () => {
    expect(() => priceGraph({ 1: { class_type: 'GenerateImageNode', inputs: { model: 'not-a-model' } } }))
      .toThrow(UnpricedGraphError)
  })

  it('GenerateImageNode with no model widget at all REFUSES', () => {
    expect(() => priceGraph({ 1: { class_type: 'GenerateImageNode', inputs: {} } }))
      .toThrow(UnpricedGraphError)
  })

  it('a model with pricePerImage null REFUSES rather than underpricing', () => {
    const nullPriced = IMAGE_MODELS.filter(m => m.pricePerImage == null).map(m => m.id)
    expect(nullPriced.length, 'fixture assumes at least one unpriced catalog model').toBeGreaterThan(0)
    for (const id of nullPriced) {
      expect(() => priceGraph({ 1: { class_type: 'GenerateImageNode', inputs: { model: id } } }), id)
        .toThrow(UnpricedGraphError)
    }
  })
})

describe('model-aware pricing: video', () => {
  it('the server video-price map covers the catalog exactly', () => {
    expect(Object.keys(VIDEO_MODEL_USD).sort()).toEqual(VIDEO_MODELS.map(m => m.id).sort())
  })

  it('each video price is pinned to the catalog price hint (drift guard)', () => {
    for (const m of VIDEO_MODELS) {
      expect(VIDEO_MODEL_USD[m.id]!.hint, `${m.id} price hint drifted — re-derive the USD figure`)
        .toBe(m.priceHint)
    }
  })

  it('GenerateVideoNode prices by its model widget', () => {
    const cheap = priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs: { model: 'ltx-video' } } })
    const rich = priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1' } } })
    expect(cheap.credits).toBe(creditsForUsdServer(VIDEO_MODEL_USD['ltx-video']!.usd))
    expect(rich.credits).toBe(creditsForUsdServer(VIDEO_MODEL_USD['veo-3.1']!.usd))
    expect(rich.credits).toBeGreaterThan(cheap.credits * 10)
  })

  it('honours the legacy model labels the node still remaps', () => {
    expect(priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs: { model: 'Veo 3' } } }).credits)
      .toBe(creditsForUsdServer(VIDEO_MODEL_USD['veo-3.1']!.usd))
    expect(priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs: { model: 'Seedance 2.0' } } }).credits)
      .toBe(creditsForUsdServer(VIDEO_MODEL_USD['seedance-2.0']!.usd))
  })

  it('FilmShotNode prices from the same video registry', () => {
    expect(priceGraph({ 1: { class_type: 'FilmShotNode', inputs: { model: 'kling-v2.5-turbo-pro' } } }).credits)
      .toBe(creditsForUsdServer(VIDEO_MODEL_USD['kling-v2.5-turbo-pro']!.usd))
  })

  it('an unknown video model REFUSES on both video classes', () => {
    for (const ct of ['GenerateVideoNode', 'FilmShotNode']) {
      expect(() => priceGraph({ 1: { class_type: ct, inputs: { model: 'veo-99' } } }), ct)
        .toThrow(UnpricedGraphError)
    }
  })
})

describe('model-aware pricing: engine-picker nodes', () => {
  it('UpscaleImageNode prices per engine', () => {
    const esrgan = priceGraph({ 1: { class_type: 'UpscaleImageNode', inputs: { model: 'Real-ESRGAN' } } })
    const clarity = priceGraph({ 1: { class_type: 'UpscaleImageNode', inputs: { model: 'Clarity' } } })
    expect(clarity.credits).toBeGreaterThan(esrgan.credits)
  })

  it('EnhanceDetailNode prices per engine', () => {
    const faithful = priceGraph({ 1: { class_type: 'EnhanceDetailNode', inputs: { model: 'Faithful' } } })
    const creative = priceGraph({ 1: { class_type: 'EnhanceDetailNode', inputs: { model: 'Creative' } } })
    expect(creative.credits).toBeGreaterThan(faithful.credits)
  })

  it('an unknown engine REFUSES', () => {
    expect(() => priceGraph({ 1: { class_type: 'UpscaleImageNode', inputs: { model: 'Magic' } } }))
      .toThrow(UnpricedGraphError)
    expect(() => priceGraph({ 1: { class_type: 'EnhanceDetailNode', inputs: {} } }))
      .toThrow(UnpricedGraphError)
  })

  it('the engine labels still match the Python node schemas', () => {
    const upscale = PY.match(/_UPSCALE_MODELS\s*=\s*\[([^\]]+)\]/)
    expect(upscale, '_UPSCALE_MODELS moved — re-check the engine price map').toBeTruthy()
    const labels = [...upscale![1]!.matchAll(/"([^"]+)"/g)].map(m => m[1]!)
    for (const label of labels) {
      expect(() => priceGraph({ 1: { class_type: 'UpscaleImageNode', inputs: { model: label } } }), label)
        .not.toThrow()
    }
  })
})

describe('the regression this task exists for', () => {
  it('a Flux 2 Pro generation never prices at base render', () => {
    const p = priceGraph({
      1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-2-pro' } },
      2: { class_type: 'SaveImage', inputs: {} },
    })
    expect(p.credits).toBeGreaterThan(1)
    expect(p.breakdown.some(b => b.action.startsWith('GenerateImageNode:'))).toBe(true)
  })
})
