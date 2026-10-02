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
import { gunzipSync } from 'node:zlib'
import { executedPart, pruneInvalidOutputs } from '#shared/runner/validate'
import { outputClassesOf } from '../../server/utils/meterGraphRun'
import { stageEstimate } from '../../server/runner/metering'
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
    // PoseMannequin (R3.15, ruling (p)): the same call, 14; nothing when it makes none (here: no character wired).
    expect(priceGraph({ 1: { class_type: 'PoseMannequin', inputs: { character: ['0', 0], pose_source: 'image', pose_image: ['0', 0] } } }).credits).toBe(14)
    expect(priceGraph({ 1: { class_type: 'PoseMannequin', inputs: {} } }).credits).toBe(0)
    // TurntableNode (R3.16, ruling (b)): by what it sends, on both paths (was a flat 75). Front only: Luma Ray 2
    // 720p, 5 s × $0.18 = $0.90 → 135. With views: one Seedance 2.0 720p arc per segment, 5 s × $0.3034 → 228 each.
    const front = { image: ['0', 0], direction: 'left', instructions: '' }
    expect(priceGraph({ 1: { class_type: 'TurntableNode', inputs: front } }).credits).toBe(135)
    expect(priceGraph({ 1: { class_type: 'TurntableNode', inputs: front } }, { families: new Set(['cards', 'turntable']) }).credits).toBe(135)
    expect(priceGraph({ 1: { class_type: 'TurntableNode', inputs: { ...front, back_reference: ['0', 0] } } }).credits).toBe(456)
    expect(priceGraph({ 1: { class_type: 'TurntableNode', inputs: { ...front, right_reference: ['0', 0], left_reference: ['0', 0] } } }).credits).toBe(684)
    expect(priceGraph({ 1: { class_type: 'TurntableNode', inputs: { ...front, right_reference: ['0', 0], back_reference: ['0', 0], left_reference: ['0', 0] } } }).credits).toBe(912)
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
    // FluxLoRARemoteNode and FluxMultiLoRARemoteNode (8 flat) are priced by their calls since R3.13 (below).
    expect(GRAPH_NODE_CREDITS.FluxLoRARemoteNode).toBeUndefined()
    expect(GRAPH_NODE_CREDITS.FluxMultiLoRARemoteNode).toBeUndefined()
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
// their calls. moondream2 keeps its edit card ($0.002, $0.001 since R3.14 fix round 1: 1 credit, as before);
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
  // Fix round 1 (controller ruling): Python sends `video_url` unchanged, so on
  // this path only an https address can work. Anything else is refused at the
  // /prompt gate (hosted and local) before the hold, in plain words; a web
  // address keeps the ceiling (the badge says "up to").
  it('Describe a video: a web address is 62; an upload link or any other address is refused before the hold', async () => {
    const { blockedPromptRefusal } = await import('../../server/utils/blockedModels')
    const node = (video_url: string) => ({ 1: { class_type: 'DescribeVideoNode', inputs: { model: 'Gemini 2.5 Flash', video_url, prompt: 'Describe this video in detail.' } } })
    expect(blockedPromptRefusal(node('https://example.test/a.mp4'))).toBeNull()
    expect(priceGraph(node('https://example.test/a.mp4')).nodes!['1']).toBe(62)
    for (const url of ['/view?filename=clip.mp4&type=input', 'http://example.test/a.mp4', 'data:video/mp4;base64,AAAA']) {
      expect(blockedPromptRefusal(node(url))?.error.message, url).toBe('Describe a video needs a web address (https) here. To describe a video you uploaded, turn on Sailor’s runner for it.')
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Step 3, R3.5 (ruling (a), user-approved): Restore an old photo and Remove
// background (and their hidden twins) leave their flat rows for their calls,
// read from Replicate's pages: Restore $0.04 an output picture (8 credits, as
// before), Remove background by GPU time ($0.0004, an estimate: 1 credit, as
// before). Upscale and Enhance detail keep their price by the picture's size.
// ───────────────────────────────────────────────────────────────────────────
describe('restore and remove background on the ComfyUI path (R3.5)', () => {
  const at = (ct: string, inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: ct, inputs } }).nodes!['1']
  it('each class, default settings', () => {
    expect(at('RestorePhotoNode', { model: 'Flux Kontext · Restore', image: ['2', 0], safety_tolerance: 2, output_format: 'png' })).toBe(8)
    expect(at('RestorePhotoRemoteNode', { image: ['2', 0], safety_tolerance: '2', output_format: 'jpg' })).toBe(8)
    expect(at('RemoveBackgroundNode', { model: '851-labs/bg-remover', image: ['2', 0] })).toBe(1)
    expect(at('RemoveBackgroundRemoteNode', { image: ['2', 0] })).toBe(1)
  })
  it('Upscale and Enhance detail are unchanged: by the output of the largest input, unmeasured', () => {
    // R7.11: Real-ESRGAN by the picture sent in; unmeasured, the 18.9 MP cap in fifteen tiles at the 1 572 864-px limit
    // ($0.0708; R11.6 fix rounds 2 and 3, LC4).
    expect(at('UpscaleImageNode', { model: 'Real-ESRGAN', image: ['2', 0], scale_factor: 2 })).toBe(15)
    expect(at('UpscaleImageNode', { model: 'Topaz', image: ['2', 0], topaz_upscale_factor: '2x' })).toBe(48)
    // LC4 fix round 2: the refiner by GPU time, $0.0047 + 20 steps × ($0.000051 × 18.9 MP + $0.000038 × 18.9²) ($0.2947).
    expect(at('EnhanceDetailNode', { model: 'Diffusion Refine', image: ['2', 0] })).toBe(45)
  })
  // Fix round 1 (ruling 4): a wired engine was refused as unpriced; it is now priced at the dearest engine the node offers.
  it('Upscale and Enhance detail with a wired engine: the dearest engine, never refused', () => {
    const engines = { UpscaleImageNode: ['Clarity', 'Crystal', 'Real-ESRGAN', 'Recraft Crisp', 'Topaz'], EnhanceDetailNode: ['Creative', 'Faithful', 'Diffusion Refine'] }
    for (const [ct, list] of Object.entries(engines)) {
      const rest = { image: ['2', 0], scale_factor: 2, topaz_upscale_factor: '2x' }
      const dearest = Math.max(...list.map(model => at(ct, { ...rest, model })!))
      expect(at(ct, { ...rest, model: ['9', 0] }), ct).toBe(dearest)
    }
    // LC4 fix round 1: Crystal is the dearest Upscale engine unmeasured again ($1.60); fix round 2: the refiner ($0.2947) Enhance's.
    expect(at('UpscaleImageNode', { image: ['2', 0], scale_factor: 2, topaz_upscale_factor: '2x', model: ['9', 0] })).toBe(240)
    expect(at('EnhanceDetailNode', { image: ['2', 0], model: ['9', 0] })).toBe(45)
    // A missing engine is still refused (nothing says which the node runs).
    expect(() => at('UpscaleImageNode', { image: ['2', 0] })).toThrow(UnpricedGraphError)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// R3.6 (ruling (a)): Separate text from image, Layerize an image and Expand /
// outpaint leave their flat rows for their calls (the providers' pages):
// Layerize $0.09 (16 → 18), Outpaint Flux Fill Pro $0.05 (10, as before) or
// Bria Expand $0.04 (10 → 8), and Layerize an image on fal at its 17
// pictures, $0.03375 each under 1536² (auto_1K: 87) and $0.0675 over (every
// other size: 173; was 51). The ComfyUI path can't see how many came back:
// it is charged that ceiling.
// ───────────────────────────────────────────────────────────────────────────
describe('layers from one call, and outpaint, on the ComfyUI path (R3.6)', () => {
  const at = (ct: string, inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: ct, inputs } }).nodes!['1']
  it('each class, by its settings', () => {
    expect(at('LayerizeGraphicNode', { model: 'Ideogram Layerize', image: ['2', 0], prompt: '', seed: 0 })).toBe(18)
    expect(at('OutpaintImageNode', { model: 'Flux Fill', image: ['2', 0], prompt: '', direction: 'Make square', aspect_ratio: '16:9', seed: 0 })).toBe(10)
    expect(at('OutpaintImageNode', { model: 'Bria Expand', image: ['2', 0], prompt: '', direction: 'Make square', aspect_ratio: '1:1', seed: 0 })).toBe(8)
    expect(at('OutpaintImageNode', { model: ['9', 0], image: ['2', 0] })).toBe(10)
    expect(at('SeedreamLayerizeNode', { image: ['2', 0], prompt: '', image_size: 'auto_1K' })).toBe(87)
    for (const image_size of ['auto', 'auto_1.5K', 'auto_2K']) expect(at('SeedreamLayerizeNode', { image: ['2', 0], prompt: '', image_size }), image_size).toBe(173)
    expect(at('SeedreamLayerizeNode', { image: ['2', 0], prompt: '' })).toBe(173)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// R3.7 (ruling (a)): Separate background and foreground leaves its flat row
// (2) for its two calls (Replicate's pages): the cut-out at Remove
// background's card ($0.0004, 1) and the fill, LaMa ($0.0007, an estimate,
// 1: 2 in all, as before) or Bria Eraser ($0.04, 8: 2 → 9). A wired or
// missing engine is held at the dearer. The ComfyUI path is charged both calls.
// ───────────────────────────────────────────────────────────────────────────
describe('Separate background and foreground on the ComfyUI path (R3.7)', () => {
  const at = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'SplitPhotoLayersNode', inputs } }).nodes!['1']
  it('by its fill engine', () => {
    expect(at({ background_fill: 'LaMa (fast)', image: ['2', 0], mask_grow: 12 })).toBe(2)
    expect(at({ background_fill: 'Bria Eraser (quality)', image: ['2', 0], mask_grow: 0 })).toBe(9)
    expect(at({ background_fill: ['9', 0], image: ['2', 0], mask_grow: 12 })).toBe(9)
    expect(at({ image: ['2', 0] })).toBe(9)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// R3.9 (ruling (a)): Generate a 3D model, its twin Hunyuan3D 2 and Multi-View
// → 3D leave their flat rows (45, badge $0.30) for their calls (Replicate's
// pages): Hunyuan3D 2 and Hunyuan3D-2mv by GPU time (estimates, $0.10: 20),
// TRELLIS by GPU time (an estimate, $0.04: 8), Rodin at $0.40 an output (60).
// Multi-View by its engine; a wired engine at Rodin's, a missing one at
// Python's default (TRELLIS).
// ───────────────────────────────────────────────────────────────────────────
describe('3D models on the ComfyUI path (R3.9)', () => {
  const at = (ct: string, inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: ct, inputs } }).nodes!['1']
  // Fix round 2 (estimate floor): an estimate card never lowers the ComfyUI path below the flat 45 before R3.
  // LC1: the owed live checks verified every 3D card (Hunyuan3D 2 $0.13: 20; TRELLIS $0.06: 12; Hunyuan3D-2mv
  // $0.10, $0.13 from 50 steps: 20): no estimate is read, so none is floored.
  it('each class, by its engine: every card verified (LC1), each at its card; Rodin 60', () => {
    expect(at('Generate3DNode', { model: 'Hunyuan3D 2', image: ['2', 0], steps: 50, guidance_scale: 5.5, octree_resolution: 256, remove_background: true, texture: true, seed: 0 })).toBe(20)
    expect(at('Hunyuan3DRemoteNode', { image: ['2', 0], steps: 20 })).toBe(20)
    expect(at('Hunyuan3DMultiViewNode', { front_image: ['2', 0], engine: 'TRELLIS (textured)' })).toBe(12)
    expect(at('Hunyuan3DMultiViewNode', { front_image: ['2', 0], engine: 'Rodin (textured · quad mesh)', rodin_quality: 'high' })).toBe(60)
    expect(at('Hunyuan3DMultiViewNode', { front_image: ['2', 0], engine: 'Hunyuan3D-2mv (geometry only)' })).toBe(20)
    expect(at('Hunyuan3DMultiViewNode', { front_image: ['2', 0], engine: 'Hunyuan3D-2mv (geometry only)', steps: 30 })).toBe(20)
    expect(at('Hunyuan3DMultiViewNode', { front_image: ['2', 0], engine: 'Hunyuan3D-2mv (geometry only)', steps: 100 })).toBe(20)
    expect(at('Hunyuan3DMultiViewNode', { front_image: ['2', 0], engine: 'Hunyuan3D-2mv (geometry only)', steps: ['9', 0] })).toBe(20)
    expect(at('Hunyuan3DMultiViewNode', { front_image: ['2', 0], engine: ['9', 0] })).toBe(60)
    expect(at('Hunyuan3DMultiViewNode', { front_image: ['2', 0] })).toBe(12)
  })

  // R3.9 fix round 1: Hunyuan3D 2 answers `{mesh}`, which Python can't read, so the ComfyUI path's
  // /prompt gate refuses Generate a 3D model and its twin before the hold (the price above is the
  // runner's, and the badge's). Multi-View is priced and forwarded as before.
  it('Generate a 3D model and its twin are refused on the ComfyUI path before pricing; Multi-View is not', async () => {
    const { blockedPromptRefusal } = await import('../../server/utils/blockedModels')
    const { GENERATE_3D_RUNNER_ONLY } = await import('#shared/runner/gen3d')
    expect(blockedPromptRefusal({ 1: { class_type: 'Generate3DNode', inputs: { model: 'Hunyuan3D 2', image: ['2', 0] } } })?.error.message).toBe(GENERATE_3D_RUNNER_ONLY)
    expect(blockedPromptRefusal({ 1: { class_type: 'Hunyuan3DRemoteNode', inputs: { image: ['2', 0] } } })?.error.message).toBe(GENERATE_3D_RUNNER_ONLY)
    expect(blockedPromptRefusal({ 1: { class_type: 'Hunyuan3DMultiViewNode', inputs: { front_image: ['2', 0], engine: 'Rodin (textured · quad mesh)' } } })).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// R3.9 fix round 2 (controller ruling): an estimate never lowers the ComfyUI
// path's charge. Every class ported in R3.3–R3.9 is pinned here at its
// defaults and at its estimate-card settings: priced at the greater of its
// calls and its flat row before R3 (38b4a0672) wherever an estimate card is
// read; only the 3D nodes sat below it (the other estimates never did).
// ───────────────────────────────────────────────────────────────────────────
describe('an estimate never lowers the ComfyUI path (R3.9 fix round 2)', () => {
  const at = (ct: string, inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: ct, inputs } }).nodes!['1']
  const L = ['2', 0]
  it('the table: every R3.3–R3.9 class priced by its calls, at its flat row before R3', async () => {
    const { PRE_R3_FLAT } = await import('#shared/pricing/estimateFloor')
    const { creditsForUsd: credits } = await import('#shared/pricing/markup')
    // (RestyleWithLoRANode, R3.14, had no flat row before R3: priced by its calls since lineup-p4c.)
    expect(Object.keys(PRE_R3_FLAT).sort()).toEqual([...PAID_NODE_CLASSES].filter(c => c !== 'RestyleWithLoRANode').sort())
    for (const [ct, row] of Object.entries(PRE_R3_FLAT)) expect(credits(row.badgeUsd), ct).toBe(row.credits)
  })
  it('the estimate-priced classes, each at max(estimate, old flat)', () => {
    const want: [string, Record<string, unknown>, number][] = [
      // Extract text (Dolphin, $0.006 verified by LC1: 2; flat 1), Find objects (YOLO-World, $0.0025 verified by LC1: 1; flat 1).
      ['ExtractTextNode', { model: 'ByteDance Dolphin', image: L }, 2],
      ['FindObjectsNode', { model: 'YOLO-World', image: L, query: 'cat', confidence: 0.25 }, 1],
      // Remove background and its twin (estimate: 1; flat 1).
      ['RemoveBackgroundNode', { model: '851-labs/bg-remover', image: L }, 1],
      ['RemoveBackgroundRemoteNode', { image: L }, 1],
      // Layerize (verified by LC1: 18; flat 16), Seedream layerize (estimate: 87 / 173; flat 51).
      ['LayerizeGraphicNode', { model: 'Ideogram Layerize', image: L, prompt: '', seed: 0 }, 18],
      ['SeedreamLayerizeNode', { image: L, prompt: '', image_size: 'auto_1K' }, 87],
      ['SeedreamLayerizeNode', { image: L, prompt: '', image_size: 'auto' }, 173],
      // Separate background and foreground (cut-out estimate + LaMa estimate: 2, or Bria: 9; flat 2).
      ['SplitPhotoLayersNode', { image: L, background_fill: 'LaMa (fast)', mask_grow: 12 }, 2],
      ['SplitPhotoLayersNode', { image: L, background_fill: 'Bria Eraser (quality)', mask_grow: 12 }, 9],
      // Music and its twin (estimate: 9–54; flat 4; LC1 fix round 1 kept the page-run card).
      ['GenerateMusicNode', { model: 'MusicGen', prompt: 'x', duration: 1 }, 9],
      ['MusicGenRemoteNode', { prompt: 'x', duration: 30 }, 54],
      // 3D: every card verified by LC1, so at its card (no floor); Rodin 60.
      ['Generate3DNode', { model: 'Hunyuan3D 2', image: L }, 20],
      ['Hunyuan3DRemoteNode', { image: L }, 20],
      ['Hunyuan3DMultiViewNode', { front_image: L, engine: 'TRELLIS (textured)' }, 12],
      ['Hunyuan3DMultiViewNode', { front_image: L, engine: 'Hunyuan3D-2mv (geometry only)', steps: 50 }, 20],
      ['Hunyuan3DMultiViewNode', { front_image: L, engine: 'Rodin (textured · quad mesh)' }, 60],
    ]
    for (const [ct, inputs, credits] of want) expect(at(ct, inputs), `${ct} ${JSON.stringify(inputs)}`).toBe(credits)
  })
  it('a class whose cards are all verified is never floored (a short speech text stays 1, under its flat 45)', () => {
    expect(at('GenerateSpeechNode', { model: 'MiniMax Speech-02 HD', text: 'x'.repeat(20) })).toBe(1)
    expect(at('ChatLLMNode', { model: 'GPT-5 nano', prompt: 'hi', system_prompt: '', temperature: 1, max_tokens: 16 })).toBeLessThanOrEqual(1)
    expect(at('RestorePhotoNode', { model: 'Flux Kontext · Restore', image: L, safety_tolerance: 2, output_format: 'png' })).toBe(8)
  })
  it('the runner (its family on) pays the card', () => {
    const on = new Set(['cards', 'gen-3d'] as const)
    expect(priceGraph({ 1: { class_type: 'Generate3DNode', inputs: { model: 'Hunyuan3D 2', image: L } } }, { families: on as never }).nodes!['1']).toBe(20)
    expect(priceGraph({ 1: { class_type: 'Hunyuan3DMultiViewNode', inputs: { front_image: L, engine: 'TRELLIS (textured)' } } }, { families: on as never }).nodes!['1']).toBe(12)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// R3.10 (ruling (a)): Transcribe audio (+ its twin Whisper), Identify speakers
// and Clone a singing voice leave their flat rows (1, 1, 10 and 4) for their
// calls, priced by the seconds of sound sent. The ComfyUI path can't measure
// the sound: it is charged the 60 s ceiling, never below the flat row while
// the card is an estimate (Identify speakers stays 10). Sync lips keeps its
// clip price (60 s ceiling, 750).
// ───────────────────────────────────────────────────────────────────────────
describe('sound in on the ComfyUI path (R3.10)', () => {
  const at = (ct: string, inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: ct, inputs } }).nodes!['1']
  const A = ['2', 0]
  it('each class at the 60 s ceiling, floored at its flat row while its card is an estimate', () => {
    expect(at('TranscribeAudioNode', { model: 'Whisper', audio: A, language: 'auto', translate: false })).toBe(2)
    expect(at('WhisperRemoteNode', { audio: A, language: 'en', translate: true })).toBe(2)
    // LC1: its card verified, so no longer floored at the flat 10: 60 s × $0.00005 = $0.003, 1 credit.
    expect(at('IdentifySpeakersNode', { model: 'Whisper Diarization', audio: A, num_speakers: 0, language: 'auto' })).toBe(1)
    expect(at('CloneSingingVoiceNode', { model: 'Realistic Voice Cloning (RVC)', audio: A, rvc_model: 'Guitar', custom_rvc_model_url: '', pitch_change: 'no-change', pitch_shift_semitones: 0, pitch_detection_algorithm: 'rmvpe', output_format: 'wav' })).toBe(9)
    expect(at('LipsyncNode', { model: 'sync.so 2-pro', video_url: 'https://x.test/a.mp4', audio: A, sync_mode: 'cut_off' })).toBe(750)
  })
  it('measured seconds price below the ceiling (the runner\'s measured sound; its family on pays the card)', () => {
    const on = new Set(['cards', 'sound-in'] as const)
    const p = (ct: string, audio: number) => priceGraph({ 1: { class_type: ct, inputs: { audio: A } } }, { inputSeconds: { 1: { audio } }, families: on as never }).nodes!['1']
    // RVC at least 36 s since LC1 (money-rule break #1): $0.0252, 6 credits.
    expect([p('TranscribeAudioNode', 10), p('IdentifySpeakersNode', 10), p('CloneSingingVoiceNode', 10)]).toEqual([1, 1, 6])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// R3.12 (ruling (a)): Text effect, Sketch to image and Generate face references
// leave their flat rows (8, 8 and 16, from their badges) for their calls
// (Replicate's billing tables): Text effect by its path, Ideogram V3 Turbo
// $0.03 generating (6) or Flux Kontext Pro $0.04 restyling a wired picture (8);
// Sketch on Nano Banana's edit card, $0.039 (8); Face references on Ideogram
// Character at its default speed, $0.15 (23).
// ───────────────────────────────────────────────────────────────────────────
describe('text effect, sketch and face references on the ComfyUI path (R3.12)', () => {
  const at = (ct: string, inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: ct, inputs } }).nodes!['1']
  it('each class, by its call', () => {
    const fx = { text: 'HELLO', effect: 'liquid-chrome', aspect_ratio: '1:1', seed: 0, freedom: 0 }
    expect(at('TextEffectNode', fx)).toBe(6)
    expect(at('TextEffectNode', { ...fx, image: ['2', 0] })).toBe(8)
    expect(at('SketchToImageNode', { model: 'Nano Banana', image: ['2', 0], prompt: 'a castle' })).toBe(8)
    expect(at('ConsistentFaceNode', { model: 'Ideogram Character', reference_image: ['2', 0], prompt: '', aspect_ratio: '1:1', seed: 0 })).toBe(23)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// R3.13 (ruling (a)): Flux Dev + LoRA and Flux Dev + LoRAs leave their flat
// rows (LORA_RENDER_CREDITS, 8) for their calls: Flux Dev + LoRA on
// flux-dev-lora's edit card, $0.04 (8, unchanged); Flux Dev + LoRAs on
// flux-dev-multi-lora by GPU time ($0.05 a call up to 28 steps, 10 credits;
// 50 steps 16), two calls with two or more LoRAs (the reload retry, ruling (g)).
// ───────────────────────────────────────────────────────────────────────────
describe('Flux Dev + LoRA and Flux Dev + LoRAs on the ComfyUI path (R3.13)', () => {
  const at = (ct: string, inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: ct, inputs } }).nodes!['1']
  const multi = { prompt: 'x', lora_a: 'a.safetensors', lora_a_url: '', scale_a: 0.9, lora_b: '[None]', lora_b_url: 'hf.co/a/b', scale_b: 0.8, aspect_ratio: '1:1', num_inference_steps: 28, guidance: 3.5, seed: 0, prompt_strength: 0.8, lora_c: '[None]', lora_c_url: '', scale_c: 0.7, lora_d: '[None]', lora_d_url: '', scale_d: 0.6 }
  it('each class, by its calls', () => {
    expect(at('FluxLoRARemoteNode', { prompt: 'x', lora_name: '[None]', lora_url: 'hf.co/a/b', lora_scale: 1, aspect_ratio: '1:1', megapixels: '1', num_inference_steps: 28, guidance: 3.5, seed: 0, prompt_strength: 0.8 })).toBe(8)
    expect(at('FluxMultiLoRARemoteNode', multi)).toBe(20)
    expect(at('FluxMultiLoRARemoteNode', { ...multi, lora_a: '[None]' })).toBe(10)
    expect(at('FluxMultiLoRARemoteNode', { ...multi, num_inference_steps: 50 })).toBe(32)
  })
})

// R3.8 fix round 2: a node no output node reads is never run by ComfyUI (nor the runner), so the
// hosted ComfyUI meter prices only what runs — the runner's own closure (validate.ts executedPart).
describe('only what an output reads is priced (R3.8 fix round 2)', () => {
  const CATALOG = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'server/native/objectInfo.baseline.json.gz'))).toString('utf8')) as Record<string, { output_node?: boolean }>
  const isOutput = outputClassesOf(CATALOG)!
  const gen = { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } }
  const card = { class_type: 'Image', inputs: { image: '', export: false, images: ['g', 0], batch_index: -1 } }
  const dangling = { class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['g', 0], prompt: 'warmer', output_format: 'png', seed: 0, resolution: '1K' } }

  it('an output plus a dangling Edit: priced as the output alone, on both paths', () => {
    const p = { g: gen, i: card, e: dangling }
    const whole = priceGraph(p).credits
    const alone = priceGraph({ g: gen, i: card }).credits
    expect(whole).toBeGreaterThan(alone)
    // The ComfyUI path's price (the part ComfyUI executes) and the runner's (what it runs) are the same.
    expect(Object.keys(executedPart(p, isOutput)).sort()).toEqual(['g', 'i'])
    expect(priceGraph(executedPart(p, isOutput)).credits).toBe(alone)
    const pruned = pruneInvalidOutputs(p, new Set(['fal-edit', 'cards'] as const))
    expect(Object.keys(pruned.prompt).sort()).toEqual(['g', 'i'])
    expect(stageEstimate(pruned.prompt, Object.keys(pruned.prompt), true, new Set(['fal-edit', 'cards'] as const))).toBe(alone)
  })

  it('a prompt whose every node is read, or with no output node, is priced whole (as before)', () => {
    const p = { g: gen, i: card }
    expect(executedPart(p, isOutput)).toBe(p)
    const lone = { g: gen }
    expect(executedPart(lone, isOutput)).toBe(lone)
    // A class the catalog doesn't know counts as an output: what it reads is priced.
    expect(outputClassesOf(CATALOG)!('NoSuchNodeClass')).toBe(true)
    expect(outputClassesOf(null)).toBeUndefined()
  })
})
