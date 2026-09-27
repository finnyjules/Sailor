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
  REMOTE_VIDEO_NODE_CLASSES,
  SETTING_PRICED_NODE_CLASSES,
  PROVIDER_NODE_EXEMPT,
  UnpricedGraphError,
  VIDEO_RATES,
  creditsForUsdServer,
  priceGraph,
} from '../../server/utils/priceBook'
import { creditsForUsd } from '~/lib/pricing'
import { PAID_NODE_CLASSES } from '#shared/pricing/paidSettings'
import { IMAGE_MODELS } from '~~/app/data/image-models'
import { VIDEO_MODELS } from '~~/app/data/video-models'
import { videoUsd } from '#shared/pricing/videoRates'
import { IMAGE_BACKUP_RATES, imagePriceUsd } from '#shared/pricing/imageRates'
import { effectiveImageSettings } from '#shared/pricing/imageSettings'
import { effectiveVideoSettings } from '#shared/pricing/videoSettings'

/** Credits for a video node that sets only its model: the builder's default clip. */
const defaultClipCredits = (id: string) =>
  creditsForUsdServer(videoUsd(id, effectiveVideoSettings(id, undefined, undefined, {})!)!)

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

function classify(c: string): 'flat' | 'model' | 'settings' | 'per-second' | 'paid' | 'exempt' | 'UNCLASSIFIED' {
  if (c in GRAPH_NODE_CREDITS) return 'flat'
  // Step 3, R3: priced by the calls its settings make (shared/pricing/paidSettings.ts).
  if (PAID_NODE_CLASSES.includes(c)) return 'paid'
  if (MODEL_PRICED_NODE_CLASSES.includes(c)) return 'model'
  if (SETTING_PRICED_NODE_CLASSES.includes(c)) return 'settings'
  if (REMOTE_VIDEO_NODE_CLASSES.includes(c)) return 'per-second'
  if (c in PROVIDER_NODE_EXEMPT) return 'exempt'
  return 'UNCLASSIFIED'
}

describe('graph price book coverage', () => {
  it('finds a plausible number of provider classes (the grep is not broken)', () => {
    expect(REPLICATE_CLASSES.length).toBeGreaterThan(40)
    expect(EXTRAS_CLASSES.length).toBeGreaterThan(5)
  })

  it('every provider node class is priced, model-priced, setting-priced, or exempt with a reason', () => {
    const unclassified = ALL_PROVIDER_CLASSES.filter(c => classify(c) === 'UNCLASSIFIED')
    expect(unclassified).toEqual([])
    // One price per class: no class sits in two tables.
    const doubled = ALL_PROVIDER_CLASSES.filter(c => [c in GRAPH_NODE_CREDITS, MODEL_PRICED_NODE_CLASSES.includes(c), SETTING_PRICED_NODE_CLASSES.includes(c), REMOTE_VIDEO_NODE_CLASSES.includes(c), PAID_NODE_CLASSES.includes(c)].filter(Boolean).length > 1)
    expect(doubled).toEqual([])
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
    // PersonSwap and LensReframe: google/nano-banana-2 at 1K, $0.067 → 14 (Task P4).
    expect(priceGraph({ 1: { class_type: 'PersonSwap', inputs: {} } }).credits).toBe(14)
    expect(priceGraph({ 1: { class_type: 'PersonSwap', inputs: {} }, 2: { class_type: 'SaveImage', inputs: {} } }).credits).toBe(14 + base)
    expect(priceGraph({ 1: { class_type: 'LensReframe', inputs: {} } }).credits).toBe(14)
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
    // EditImageNode (23 flat) is priced by its settings since Task P4 (edit-pricing.unit.spec.ts).
    expect(GRAPH_NODE_CREDITS.EditImageNode).toBeUndefined()
    // LipSyncNode (150 flat) is priced per second since Task P5 (clip-pricing.unit.spec.ts).
    expect(GRAPH_NODE_CREDITS.LipSyncNode).toBeUndefined()
    expect(GRAPH_NODE_CREDITS.LoraTrainingNode).toBe(600)
    // RestyleWithLoRANode (18 flat) is priced by its calls since P4 fix round 2.
    expect(GRAPH_NODE_CREDITS.RestyleWithLoRANode).toBeUndefined()
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
    // Kling 2.1 and Seedance 2.0 are priced per second of what they send since
    // Task P5 (clip-pricing.unit.spec.ts).
    expect(GRAPH_NODE_CREDITS.KlingVideoRemoteNode).toBeUndefined()
    expect(GRAPH_NODE_CREDITS.Seedance2RemoteNode).toBeUndefined()
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
      // pricePerImage is the first service's, and the charge is exactly it, except where a backup
      // rate is the basis: its cost, covered at cost, can set the charge above it (Task S3).
      if (IMAGE_BACKUP_RATES[m.id]) {
        const basis = imagePriceUsd(m.id, effectiveImageSettings(m.id, m.defaultAspectRatio, {})!)!
        expect(basis, m.id).toBeGreaterThanOrEqual(m.pricePerImage)
        expect(p.credits, m.id).toBe(creditsForUsdServer(basis))
      }
      else {
        expect(p.credits, m.id).toBe(creditsForUsdServer(m.pricePerImage))
      }
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
  it('the video rate card covers the catalog exactly', () => {
    expect(Object.keys(VIDEO_RATES).sort()).toEqual(VIDEO_MODELS.map(m => m.id).sort())
  })

  it('GenerateVideoNode prices by its model widget', () => {
    const cheap = priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs: { model: 'ltx-video' } } })
    const rich = priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1' } } })
    expect(cheap.credits).toBe(defaultClipCredits('ltx-video'))
    expect(rich.credits).toBe(defaultClipCredits('veo-3.1'))
    expect(rich.credits).toBeGreaterThan(cheap.credits * 10)
  })

  it('honours the legacy model labels the node still remaps', () => {
    expect(priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs: { model: 'Veo 3' } } }).credits)
      .toBe(defaultClipCredits('veo-3.1'))
    expect(priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs: { model: 'Seedance 2.0' } } }).credits)
      .toBe(defaultClipCredits('seedance-2.0'))
  })

  it('FilmShotNode prices from the same rate card', () => {
    expect(priceGraph({ 1: { class_type: 'FilmShotNode', inputs: { model: 'kling-v2.5-turbo-pro' } } }).credits)
      .toBe(defaultClipCredits('kling-v2.5-turbo-pro'))
  })

  it('an unknown video model REFUSES on both video classes', () => {
    for (const ct of ['GenerateVideoNode', 'FilmShotNode']) {
      expect(() => priceGraph({ 1: { class_type: ct, inputs: { model: 'veo-99' } } }), ct)
        .toThrow(UnpricedGraphError)
    }
  })
})

describe('model-aware pricing: engine-picker nodes', () => {
  // Task P4: each engine is priced at the largest accepted input × the scale
  // chosen (edit-pricing.unit.spec.ts pins the figures).
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

// ───────────────────────────────────────────────────────────────────────────
// Task P1 (model line-up): one price calculation for badge, estimate and
// charge. Moving the calculation into shared/pricing must not change a single
// price, so the credits priceGraph gave for every model id × model-priced
// class, and for every flat class, were recorded BEFORE the move
// (fixtures/pricing/price-graph-golden.json) and must come out identical.
// ───────────────────────────────────────────────────────────────────────────
describe('golden price table (no price changed by the shared pricing move)', () => {
  const golden = JSON.parse(readFileSync(
    fileURLToPath(new URL('./fixtures/pricing/price-graph-golden.json', import.meta.url)), 'utf8',
  )) as {
    modelPriced: Record<string, Record<string, number | 'refused'>>
    flat: Record<string, number>
  }

  function priceOrRefused(ct: string, inputs: Record<string, unknown>): number | 'refused' {
    try { return priceGraph({ 1: { class_type: ct, inputs } }).credits }
    catch (e) { if (e instanceof UnpricedGraphError) return 'refused'; throw e }
  }

  it('covers every model-priced class and every flat class (the table is not empty)', () => {
    expect(Object.keys(golden.modelPriced).sort()).toEqual([...MODEL_PRICED_NODE_CLASSES].sort())
    // Task P4 moved the edit classes from the flat table to their settings.
    // Task P5 moved the older video and lip-sync nodes to a per-second price.
    // Step 3, R3 moved the paid classes to their calls (shared/pricing/paidSettings.ts).
    expect(Object.keys(golden.flat).sort()).toEqual([...Object.keys(GRAPH_NODE_CREDITS), ...SETTING_PRICED_NODE_CLASSES, ...REMOTE_VIDEO_NODE_CLASSES, ...PAID_NODE_CLASSES].sort())
    // Both outcomes are present, so a pricer that refused (or priced) everything would fail.
    const cells = Object.values(golden.modelPriced).flatMap(row => Object.values(row))
    expect(cells.filter(c => c === 'refused').length).toBeGreaterThan(50)
    expect(cells.filter(c => typeof c === 'number').length).toBeGreaterThan(50)
  })

  // Task P2 re-priced video per second (shared/pricing/videoRates.ts), and
  // Task P3 re-priced images by size and quality (shared/pricing/imageRates.ts),
  // so those classes keep only their shape from the table: a model that
  // refused still refuses and a model that priced still prices. Their figures
  // are pinned by tests/unit/video-pricing.unit.spec.ts and
  // tests/unit/image-pricing.unit.spec.ts. Task P4 re-priced the engine
  // pickers and the edit classes by their settings (tests/unit/edit-pricing.unit.spec.ts).
  const REPRICED = new Set(['GenerateVideoNode', 'FilmShotNode', 'GenerateImageNode', 'UpscaleImageNode', 'EnhanceDetailNode'])
  // Models that were refused as unpriced and now have a price.
  const NEWLY_PRICED: Record<string, string[]> = { GenerateImageNode: ['krea-2-large', 'krea-2-medium'] }

  it('every model id × model-priced class prices exactly as recorded', () => {
    const drift: string[] = []
    for (const [ct, row] of Object.entries(golden.modelPriced)) {
      for (const [model, want] of Object.entries(row)) {
        const got = priceOrRefused(ct, { model })
        if (NEWLY_PRICED[ct]?.includes(model)) {
          if (want !== 'refused' || typeof got !== 'number') drift.push(`${ct} @ ${model}: recorded ${want}, now ${got}`)
        }
        else if (REPRICED.has(ct)) {
          if ((got === 'refused') !== (want === 'refused')) drift.push(`${ct} @ ${model}: recorded ${want}, now ${got}`)
        }
        else if (got !== want) drift.push(`${ct} @ ${model}: recorded ${want}, now ${got}`)
      }
    }
    expect(drift).toEqual([])
  })

  it('every flat class prices exactly as recorded', () => {
    const drift: string[] = []
    for (const [ct, want] of Object.entries(golden.flat)) {
      const got = priceOrRefused(ct, {})
      // A setting-priced edit class keeps only its shape: it still prices.
      // So does a per-second class (Task P5).
      if (SETTING_PRICED_NODE_CLASSES.includes(ct) || REMOTE_VIDEO_NODE_CLASSES.includes(ct)) { if (typeof got !== 'number') drift.push(`${ct}: recorded ${want}, now ${got}`) }
      // A paid class (step 3, R3, ruling (a)) is re-priced by its calls, from the settings the canvas
      // writes (a bare node has no model to price): its figures are pinned by its task's spec
      // (R3.3: runner-paid-llm.unit.spec.ts, and the per-class pin below).
      else if (PAID_NODE_CLASSES.includes(ct)) continue
      else if (got !== want) drift.push(`${ct}: recorded ${want}, now ${got}`)
    }
    expect(drift).toEqual([])
  })

  it('widgets that do not change what is sent do not move a price', () => {
    // Veo 3.1's default clip is 8 s with sound; 720p and 1080p cost the same.
    const bare = priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1' } } }).credits
    const full = priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs: {
      model: 'veo-3.1', prompt: 'a shot', duration: 8, model_options: '{"resolution":"1080p"}',
    } } }).credits
    expect(full).toBe(bare)
  })
})

// The markup and the model USD live in frontend/shared/pricing/ and nowhere
// else. A second copy is how the badge and the charge drifted apart before.
describe('one price calculation (guard)', () => {
  const FRONTEND = fileURLToPath(new URL('../../', import.meta.url))
  const ROOTS = ['app', 'server', 'shared']
  const SKIP_DIRS = new Set(['node_modules', '.nuxt', '.output'])
  /** Re-implementations of the markup: its definition, its multiply, its ceil. */
  const FORBIDDEN: RegExp[] = [
    /function\s+creditsForUsd\w*\s*\(/,
    // a new body under the name (an alias of the shared function is fine)
    /(?:const|let|var)\s+creditsForUsd\w*\s*=\s*(?:\(|function\b|async\b|\w+\s*=>)/,
    // an operand before the ×, on one line, so a JSDoc ' * markup' line is not
    // one; any case and any name holding it (MARKUP, houseMarkup, markupRate)
    /[\w)\]][ \t]*\*[ \t]*\w*markup\w*\b/i,
    /Math\.ceil\(\s*usd\b/,
    // rounding a product up by the markup's own factors: ×100 (cents), ×2,
    // ×1.5, or cents and markup folded together (×200, ×150) —
    // `Math.ceil(cost * 100 * 1.5)`, `Math.ceil(usd * 200)`,
    // `Math.ceil((cost) * 100)`. Operands are names, numbers or a bracketed
    // group. A sum (`w + pad * 2`) or a nested call (`Math.sqrt(n * 1.5)`) is
    // layout maths, not a price.
    /Math\.ceil\(\s*(?:[\w.]+|\([^()\n]*\))(?:\s*\*\s*(?:[\w.]+|\([^()\n]*\)))*\s*\*\s*(?:100|150|200|1\.5|2)\b/,
    // the $0.10 threshold choosing a factor, either way round
    /[<>]=?\s*0\.10?\s*\?\s*(?:2|1\.5)\b/,
  ]
  /** Files allowed a markup of their own, each with the reason. */
  const ALLOWED: Record<string, string> = {
    'server/utils/anthropicPrices.ts':
      'Claude assist token metering: its own ASSIST_MARKUP on LLM usage, not a model node price',
  }

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) out.push(...sourceFiles(p))
      else if (/\.(ts|vue|js|mjs)$/.test(e.name)) out.push(p)
    }
    return out
  }
  function offences(src: string): string[] {
    return FORBIDDEN.filter(re => re.test(src)).map(re => re.source)
  }
  const rel = (p: string) => p.slice(FRONTEND.length).replace(/\\/g, '/')

  it('positive control: the patterns catch the old copies and the real one', () => {
    const oldCopy = [
      'export function creditsForUsdServer(usd: number): number {',
      '  if (!(usd > 0)) return 0',
      '  const markup = usd <= 0.10 ? 2 : 1.5',
      '  return Math.max(1, Math.ceil(usd * 100 * markup))',
      '}',
    ].join('\n')
    expect(offences(oldCopy).length).toBeGreaterThanOrEqual(3)
    expect(offences('const creditsForUsdX = (usd: number) => usd * 2')).toHaveLength(1)
    expect(offences('export const creditsForUsdServer = creditsForUsd')).toEqual([])
    expect(offences(' * emit identical\n *  markup share one definition')).toEqual([])
    // Task P3 hardening: any case, any name, and a ceil by the markup's factors.
    expect(offences('const c = cost * MARKUP')).toHaveLength(1)
    expect(offences('const c = cost * houseMarkup')).toHaveLength(1)
    expect(offences('return Math.ceil(cost * 100 * 1.5)')).toHaveLength(1)
    expect(offences('return Math.ceil(price*2)')).toHaveLength(1)
    expect(offences('return Math.ceil(2 * price * 100)')).toHaveLength(1)
    expect(offences('const m = price <= 0.1 ? 2 : 1.5')).toHaveLength(1)
    // Fix round 1: the threshold either way round, and folded factors.
    expect(offences('const m = cost > 0.10 ? 1.5 : 2')).toHaveLength(1)
    expect(offences('const m = cost < 0.1 ? 2 : 1.5')).toHaveLength(1)
    expect(offences('const m = cost >= 0.10 ? 1.5 : 2')).toHaveLength(1)
    expect(offences('return Math.ceil(price * 200)')).toHaveLength(1)
    expect(offences('return Math.ceil(price * 150)')).toHaveLength(1)
    expect(offences('return Math.ceil(cost * 100 * m)')).toHaveLength(1)
    expect(offences('return Math.ceil((cost) * 100)')).toHaveLength(1)
    expect(offences('return Math.ceil((a + b) * 150)')).toHaveLength(1)
    // …and still not layout maths or prose.
    expect(offences('canvas.width = Math.max(2, Math.ceil(textW + pad * 2))')).toEqual([])
    expect(offences('const bands = Math.ceil(span / (pitch * 2)) + 2')).toEqual([])
    expect(offences('const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.5)))')).toEqual([])
    expect(offences(' * Markup policy: 2× up to $0.10')).toEqual([])
    // The scanner reads real files: the one true copy trips it.
    const markupFile = join(FRONTEND, 'shared/pricing/markup.ts')
    expect(sourceFiles(join(FRONTEND, 'shared'))).toContain(markupFile)
    expect(offences(readFileSync(markupFile, 'utf8')).length).toBeGreaterThanOrEqual(2)
  })

  it('nothing outside shared/pricing re-implements the markup', () => {
    const bad: string[] = []
    for (const root of ROOTS) {
      for (const file of sourceFiles(join(FRONTEND, root))) {
        const r = rel(file)
        if (r.startsWith('shared/pricing/') || r in ALLOWED) continue
        const hits = offences(readFileSync(file, 'utf8'))
        if (hits.length) bad.push(`${r}: ${hits.join(', ')}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('the server charge, the badge and the estimate share one markup function', async () => {
    const shared = await import('#shared/pricing/markup')
    const client = await import('~/lib/pricing')
    expect(creditsForUsdServer).toBe(shared.creditsForUsd)
    expect(client.creditsForUsd).toBe(shared.creditsForUsd)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Step 3, R3.3 (ruling (a), user-approved): the seven LLM text nodes leave
// their flat rows (1 credit each, 2 for Think step by step) for Replicate's
// per-token cards. The ComfyUI path can't read the answer's usage, so it
// charges the ceiling: the text sent (one token per byte) plus the answer
// limit sent. Pinned per class, at the settings the canvas writes by default.
// ───────────────────────────────────────────────────────────────────────────
describe('the LLM text nodes on the ComfyUI path (R3.3)', () => {
  const at = (ct: string, inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: ct, inputs } }).nodes!['1']
  it('each class, default settings', () => {
    expect(at('ChatLLMNode', { model: 'Gemini 3 Flash', prompt: 'Hello', system_prompt: '', temperature: 1, max_tokens: 1024 })).toBe(1)
    expect(at('ImprovePromptNode', { model: 'GPT-5 nano', idea: 'a cat', target: 'image' })).toBe(1)
    expect(at('SummarizeTextNode', { text: 'Some text', length: 'Short', model: 'Gemini 3 Flash' })).toBe(1)
    expect(at('TranslateTextNode', { text: 'Hello', target_language: 'English', custom_language: '' })).toBe(2)
    expect(at('RewriteToneNode', { text: 'We sell shoes', tone: 'Punchy', model: 'Claude 4.5 Haiku' })).toBe(2)
    expect(at('BrainstormIdeasNode', { topic: 'Coffee', count: 3, angle: 'Variations' })).toBe(1)
    expect(at('ReasonStepByStepNode', { question: '17 * 23?', include_reasoning: false, model: 'DeepSeek R1' })).toBe(5)
  })
  it('the dearest settings: Chat on GPT-5 or Claude 4.5 Sonnet at 8192 max tokens, Think step by step on GPT-5 or Claude', () => {
    const chat = (model: string) => at('ChatLLMNode', { model, prompt: 'Hello', system_prompt: '', temperature: 1, max_tokens: 8192 })
    expect(chat('GPT-5')).toBe(17)
    expect(chat('Claude 4.5 Sonnet')).toBe(19)
    expect(chat('Gemini 3 Flash')).toBe(5)
    const reason = (model: string) => at('ReasonStepByStepNode', { question: '17 * 23?', include_reasoning: true, model })
    expect(reason('GPT-5')).toBe(5)
    expect(reason('Claude 4.5 Sonnet')).toBe(7)
  })
  it('a model the node doesn\'t know is refused, never priced low', () => {
    expect(() => at('ChatLLMNode', { model: 'GPT-9', prompt: 'x', system_prompt: '', temperature: 1, max_tokens: 64 })).toThrow(UnpricedGraphError)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Step 3, R3.4 (ruling (a), user-approved): Describe an image (+ its twin),
// Describe a video, Extract text and Find objects leave their flat rows for
// their calls. moondream2 keeps its edit card ($0.002: 1 credit, as before);
// Dolphin and YOLO-World are priced from their GPU-time pages (estimates:
// 2 credits, was 1; 1 credit); Describe a video by the token on Gemini 2.5
// Flash, which on the ComfyUI path (no usage, no video length) is its
// ceiling: a 45-minute video and the longest answer, 62 credits (was 2).
// ───────────────────────────────────────────────────────────────────────────
describe('describe, read and find on the ComfyUI path (R3.4)', () => {
  const at = (ct: string, inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: ct, inputs } }).nodes!['1']
  it('each class, default settings', () => {
    expect(at('DescribeImageNode', { model: 'Moondream 2', image: ['2', 0], prompt: 'Describe this image in detail.' })).toBe(1)
    expect(at('DescribeImageRemoteNode', { image: ['2', 0], prompt: 'Describe this image in detail.' })).toBe(1)
    expect(at('ExtractTextNode', { model: 'ByteDance Dolphin', image: ['2', 0] })).toBe(2)
    expect(at('FindObjectsNode', { model: 'YOLO-World', image: ['2', 0], query: 'person, car, dog', confidence: 0.25 })).toBe(1)
    expect(at('DescribeVideoNode', { model: 'Gemini 2.5 Flash', video_url: 'https://example.test/a.mp4', prompt: 'Describe this video in detail.' })).toBe(62)
  })
})
