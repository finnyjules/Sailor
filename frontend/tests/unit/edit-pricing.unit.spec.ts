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
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { planNode } from '~~/server/runner/executors'
import { measuredInputPixels, nodeCredits, stageEstimate } from '~~/server/runner/metering'
import { ENHANCE_DETAIL_TOO_LARGE, FLUX_2_EDIT_TOO_LARGE, measuredInputProblems } from '~~/server/runner/requestRules'
import {
  MAX_MEASURED_FILES, bmpPixels, graphInputPixels, graphInputSizes, isMeasurableRaster, isobmffIspePixels, picturePixels, sniffPictureFormat,
} from '~~/server/utils/graphInputPixels'
import { meterGraphSubmit } from '~~/server/utils/meterGraphRun'
import { RESTYLE_MODELS } from '~~/server/runner/generators/restyle'
import { REFERENCE_MODEL_IDS } from '~~/server/runner/generators/refEdits'
import { GRAPH_NODE_CREDITS, UnpricedGraphError, priceGraph } from '~~/server/utils/priceBook'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_NODE_RULES, nodeRuleAllows } from '#shared/runner/eligibility'
import { RUNNER_FAMILIES } from '#shared/runner/families'
import { EDIT_RATES, editRate, editUsd, type EditCall } from '#shared/pricing/editRates'
import {
  ENHANCE_ENGINE_SLUGS, LARGEST_INPUT_PIXELS, RESTYLE_LORA_NB_RETRIES, SETTING_PRICED_NODE_CLASSES, UPSCALE_ENGINE_SLUGS, editCalls,
  editSteps, nanoBananaPixels, sizePricedInput, sourceOutputPixels,
} from '#shared/pricing/editSettings'
import { priceNode } from '#shared/pricing/nodePrice'
import { MODEL_PRICED_BADGE_CLASSES, nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes, upstreamInputPixels, vueNodesToEstimateInput, widgetValueMap } from '~/lib/costEstimate'
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
    // Pose Mannequin: a call (character and pose picture wired); with none it is free (paidNoCall), which a bare badge can't see.
    case 'PoseMannequin': return withTier('resolution', { character: LINK, pose_source: 'image', pose_image: LINK })
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
// R7.11: Real-ESRGAN too (its live check measured GPU-time billing over the old $0.002 a picture).
// LC1: flux-dev-lora and Moondream 2 verified by the owed live checks (2026-10-01).
// LC4 fix round 1: Clarity and the Magic Image Refiner verified by two live runs each (2026-10-01/02).
const ESTIMATES = ['catacolabs/sdxl-ad-inpaint', 'fofr/style-transfer']
/** Cards re-read or re-carded on 2026-10-01: Real-ESRGAN (R7.11), and LC1's (Moondream 2, flux-dev-lora, fal's face swap). */
const READ_10_01 = ['nightmareai/real-esrgan', 'lucataco/moondream2', 'black-forest-labs/flux-dev-lora', 'fal-ai/face-swap']
/** LC4: Clarity and the Magic Image Refiner, re-carded from their live checks (pages re-read 2026-10-02). */
const READ_10_02 = ['philz1337x/clarity-upscaler', 'fermatresearch/magic-image-refiner']

describe('edit rate cards', () => {
  it('every card carries a source, the date read and a confidence; only GPU-time models are estimates', () => {
    for (const [endpoint, r] of Object.entries(EDIT_RATES)) {
      // fal: the llms.txt; a token-billed card (GPT Image 2.5, Task F2) its model page, where the per-size table is.
      // LC1: fal's face swap is hidden from fal's gallery (no llms.txt price): fal's pricing API.
      expect(r.source, endpoint).toMatch(r.unit === 'by_quality'
        ? /^https:\/\/(fal\.ai\/models\/.+|replicate\.com\/.+)$/
        : endpoint === 'fal-ai/face-swap'
          ? /^https:\/\/api\.fal\.ai\/v1\/models\/pricing\?endpoint_id=fal-ai\/face-swap$/
          : /^https:\/\/(fal\.ai\/models\/.+\/llms\.txt|replicate\.com\/.+)$/)
      expect(r.source, endpoint).toContain(endpoint)
      // Moondream re-read with R3.14 fix round 1 (its page's price had halved).
      // Real-ESRGAN re-carded from R7.11's live check (2026-10-01).
      expect(r.read, endpoint).toBe(READ_10_02.includes(endpoint) ? '2026-10-02' : READ_10_01.includes(endpoint) ? '2026-10-01' : '2026-09-24')
      expect(r.service, endpoint).toBe(r.source.includes('fal.ai') ? 'fal' : 'replicate')
    }
    const est = Object.entries(EDIT_RATES).filter(([, r]) => r.confidence === 'estimate').map(([k]) => k).sort()
    expect(est).toEqual(ESTIMATES)
  })

  it('no runner family can turn on an estimate-priced call: the two legacy engines are retired (H2)', () => {
    // Every model a family switch can turn on has a verified price. Until H2
    // the two exceptions were Product shot's SDXL (ref-edits) and Restyle's
    // IP-Adapter (restyle) — P4 fix round 1, I3. H2 retired both from the
    // runner: no family reaches them, so their saved nodes run on ComfyUI and
    // still price there. A class moved onto a newer model by its own family
    // (Rotate camera F10, Product shot F12) calls something else with that
    // family on, so every family on, and each one off in turn, is tried.
    const ALL = new Set(RUNNER_FAMILIES)
    const sets = [ALL, ...RUNNER_FAMILIES.map(off => new Set(RUNNER_FAMILIES.filter(f => f !== off)))]
    const reachable = new Set<string>()
    for (const ct of SETTING_PRICED_NODE_CLASSES) {
      const rule = RUNNER_NODE_RULES[ct]
      if (!rule) continue
      for (const w of settingsGrid(ct)) {
        for (const families of sets) {
          // What the runner would take: the class's pictures linked, these families on.
          if (!nodeRuleAllows(ct, rule, { ...RUNNER_BASE[ct], ...w }, families)) continue
          const c = editCalls(ct, w, { families })
          if (!('refused' in c)) for (const one of c.calls) reachable.add(one.endpoint)
        }
      }
    }
    // Control: the loop reaches the families' calls (the verified ones).
    expect(reachable.has('fal-ai/nano-banana-2/edit')).toBe(true)
    expect(reachable.has('bytedance/seedream-5-pro')).toBe(true)
    expect(reachable.has('google/nano-banana')).toBe(true)
    expect(reachable.has('fal-ai/bria/product-shot')).toBe(true)
    const est = [...reachable].filter(e => EDIT_RATES[e]!.confidence === 'estimate').sort()
    expect(est).toEqual([])
    expect(reachable.has('catacolabs/sdxl-ad-inpaint')).toBe(false)
    expect(reachable.has('fofr/style-transfer')).toBe(false)
    // Hidden is not deleted: both still price on the ComfyUI path.
    expect(charge('ProductShotNode', {})).toBeGreaterThan(1)
    expect(charge('RestyleFromImageNode', { model: 'Style Transfer · IP-Adapter' })).toBeGreaterThan(1)
  })

  it('every call any setting makes has a card, priced above 0', () => {
    for (const ct of [...SETTING_PRICED_NODE_CLASSES, 'UpscaleImageNode', 'EnhanceDetailNode']) {
      const grid = ct === 'UpscaleImageNode' ? UPSCALE_MODELS.map(model => ({ model }))
        : ct === 'EnhanceDetailNode' ? ENHANCE_MODELS.map(model => ({ model }))
          : settingsGrid(ct)
      for (const w of grid) {
        const steps = editSteps(ct, w)
        const c = steps ? { calls: steps.map(st => st.call) } : editCalls(ct, w)
        if ('refused' in c) throw new Error(`${ct} ${JSON.stringify(w)} refused: ${c.refused}`)
        for (const one of c.calls.flatMap(x => [x, ...(x.fallbacks ?? [])])) {
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

  it('FLUX.2 edit is priced on the picture sent in, the cap when unmeasured (the builder sends the picture as it is)', () => {
    // The runner's backup, Replicate's FLUX.2 [pro] (Task S3), bills the same pictures.
    const flux2 = (input: number, output: number) => ({
      endpoint: 'fal-ai/flux-2-pro/edit', tier: null, inputPixels: input, outputPixels: output,
      fallbacks: [{ endpoint: 'black-forest-labs/flux-2-pro', tier: null, inputPixels: input, outputPixels: output }],
    })
    for (const ct of ['EditImageNode', 'BlendSceneNode']) {
      // Unmeasured: the cap in, the 2048² FLUX.2 output cap out.
      expect(only(ct, { model: 'Flux 2 Pro' })).toEqual(flux2(LARGEST_INPUT_PIXELS, 2048 * 2048))
      // Measured: that size in and out; above the cap, the cap.
      const measured = editCalls(ct, { model: 'Flux 2 Pro' }, { inputPixels: 1024 * 1024 })
      expect(measured).toEqual({ calls: [flux2(1024 * 1024, 1024 * 1024)] })
      const huge = editCalls(ct, { model: 'Flux 2 Pro' }, { inputPixels: 50e6 })
      expect(huge).toEqual({ calls: [flux2(LARGEST_INPUT_PIXELS, 2048 * 2048)] })
    }
    // P5 fix round 1: the cap is the widest Nano Banana 4K picture, NB_SIZES' largest entry.
    expect(LARGEST_INPUT_PIXELS).toBe(12288 * 1536)
    expect(LARGEST_INPUT_PIXELS).toBe(nanoBananaPixels('4K', null))
  })

  it('the Nano Banana edits carry the ComfyUI path\'s fallback chain, read from _run_nano_banana_edit', () => {
    // nodes_replicate.py: the fal twin of the slug (_NANO_BANANA_FAL_EDIT),
    // then fal Nano Banana Pro unless that was first, then the slug on
    // Replicate — each at the same resolution. A new step there fails this.
    const i = PY.indexOf('async def _run_nano_banana_edit(')
    expect(i).toBeGreaterThan(0)
    const rest = PY.slice(i + 4)
    const body = rest.slice(0, rest.search(/\nasync def |\ndef |\nclass /))
    const twins = /_NANO_BANANA_FAL_EDIT\s*=\s*\{([^}]+)\}/.exec(PY)![1]!
    const falTwin = Object.fromEntries([...twins.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(m => [m[1]!, m[2]!]))
    expect(falTwin).toEqual({ 'google/nano-banana-2': 'fal-ai/nano-banana-2/edit', 'google/nano-banana-pro': 'fal-ai/nano-banana-pro/edit' })
    // The chain's steps, in order: exactly one appended fal step (Pro), one fal loop, one Replicate last resort.
    expect(body.match(/fal_chain\.append\(/g)).toHaveLength(1)
    expect(body).toContain('_pro = "fal-ai/nano-banana-pro/edit"')
    expect(body).toMatch(/if fal_primary != _pro:\s*\n\s*fal_chain\.append\(\(_pro,/)
    expect(body.match(/_run_fal_nano_banana_edit\(/g)).toHaveLength(1)
    expect(body.match(/_run_prediction\(/g)).toHaveLength(1)
    expect(body).toContain('await _run_prediction(replicate_slug, nb_input)')
    expect(body).toMatch(/"resolution": resolution/)
    const pyChain = (slug: string) => {
      const first = falTwin[slug]!
      return [first, ...(first === 'fal-ai/nano-banana-pro/edit' ? [] : ['fal-ai/nano-banana-pro/edit']), slug]
    }
    const chainOf = (c: EditCall) => [c.endpoint, ...(c.fallbacks ?? []).map(f => f.endpoint)]
    // Every Nano Banana 2 / Pro edit that goes through the chain in Python.
    const cases: [string, Record<string, unknown>, string][] = [
      ['EditImageNode', { model: 'Nano Banana 2', resolution: '2K' }, 'google/nano-banana-2'],
      ['DevelopImageNode', { resolution: '2K' }, 'google/nano-banana-2'],
      ['RelightNode', {}, 'google/nano-banana-2'],
      ['GenerateFromReferencesNode', { model: 'nano-banana-2', size: '2K' }, 'google/nano-banana-2'],
      ['RestyleFromImageNode', { model: 'Nano Banana 2', resolution: '2K' }, 'google/nano-banana-2'],
      ['RestyleFromImageNode', { model: 'Nano Banana Pro', resolution: '2K' }, 'google/nano-banana-pro'],
    ]
    // Relight and Restyle on Nano Banana 2 go to Replicate first on the runner
    // since Task S3 (fal the backup): the call is that first step, and every
    // step of Python's chain is still covered, in any order.
    const RUNNER_REPLICATE_FIRST = new Set(['RelightNode', 'RestyleFromImageNode:Nano Banana 2'])
    for (const [ct, w, slug] of cases) {
      const c = only(ct, w)
      if (RUNNER_REPLICATE_FIRST.has(ct) || RUNNER_REPLICATE_FIRST.has(`${ct}:${String(w.model)}`)) {
        expect(c.endpoint, ct).toBe('google/nano-banana-2')
        expect([...chainOf(c)].sort(), ct).toEqual([...pyChain(slug)].sort())
      }
      else expect(chainOf(c), ct).toEqual(pyChain(slug))
      for (const step of [c, ...c.fallbacks!]) expect(step.tier, ct).toBe(c.tier)
    }
    // The callers: Edit image, Develop, Relight call it; References and Restyle via _run_image_edit_prediction.
    expect(PY).toMatch(/if replicate_slug in _NANO_BANANA_FAL_EDIT:\s*\n\s*return await _run_nano_banana_edit\(/)
    expect(readFileSync(`${REPO}comfy_extras/nodes_relight.py`, 'utf8')).toContain('await _run_nano_banana_edit(')
    // The Nano Banana actions call Replicate directly: no chain; fal's edit is the runner's backup (Task S3).
    expect(only('RemoveObjectNode', {}).fallbacks).toEqual([{ endpoint: 'fal-ai/nano-banana-2/edit', tier: '1K', inputPixels: null, outputPixels: null }])
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

  it('Lens reframe and Pose Mannequin make the Nano Banana actions\' call: google/nano-banana-2 at 1K', () => {
    for (const file of ['nodes_lens_reframe.py', 'nodes_pose_mannequin.py']) {
      const src = readFileSync(`${REPO}comfy_extras/${file}`, 'utf8')
      expect(src, file).toMatch(/_run_prediction\("google\/nano-banana-2", (\{|input_dict)/)
      expect(src, file).toContain('"resolution": "1K"')
    }
    // The same call as the actions, fal's edit their runner backup (family nano-extras, R3.15).
    expect(only('LensReframe', {})).toEqual(only('RemoveObjectNode', {}))
    expect(only('PoseMannequin', {})).toEqual(only('RemoveObjectNode', {}))
  })
})

// ── Worked examples ──────────────────────────────────────────────────────

const MP1 = 1000 * 1000

/**
 * [class, widgets, USD (the first call at its usual markup, or the dearest
 * fallback covered only at cost if that costs more), credits, measured input
 * pixels].
 *
 * A Nano Banana 2 edit's first call is fal NB2 ($0.08 / $0.12 / $0.16 at
 * 1K/2K/4K), marked up as usual. Its fallbacks (fal NB Pro, then Replicate
 * NB2) are covered at cost only (`usdChargedAtCost`, shared/pricing/markup.ts)
 * — no markup — so the node is priced at whichever is higher: the first
 * call's marked-up price, or a fallback's raw cost. At 1K/2K the first call
 * already covers every fallback's cost, so the price is unchanged from a
 * plain first-call price: $0.08 / $0.12. At 4K, fal NB Pro's $0.30 raw cost
 * (at-cost: $0.20) exceeds the first call's $0.16, so $0.20 is charged —
 * covering that fallback's cost without marking it up.
 */
const EXAMPLES: [string, Record<string, unknown>, number, number, number?][] = [
  // RestyleWithLoRANode: 5 Moondream calls ($0.001, 1 credit each) + the LoRA render ($0.04) + 3 Nano Banana 2 passes,
  // each call's own credits summed since R3.14 (runner-paid-restyle-lora.unit.spec.ts): 5 × 1 + 8 + 3 × a pass.
  // The dollars are the basis those credits came from (R3.14 fix round 1: credits = creditsForUsd(usd)): 2/3 of the credits' dollars above 20,
  // rounded down to 1e-8.
  // 1K: a pass $0.08 (NB Pro at cost $0.075 is below it) → 16; 5 + 8 + 48 = 61.
  ['RestyleWithLoRANode', {}, 0.40666666, 61],
  ['RestyleWithLoRANode', { resolution: '1K' }, 0.40666666, 61],
  // 2K: a pass $0.12 → 18; 5 + 8 + 54 = 67.
  ['RestyleWithLoRANode', { resolution: '2K' }, 0.44666666, 67],
  // 4K: a pass on NB Pro 4K at cost $0.20 beats the first call's $0.16 → 30; 5 + 8 + 90 = 103.
  ['RestyleWithLoRANode', { resolution: '4K' }, 0.68666666, 103],
  ['RestyleWithLoRANode', { resolution: LINK }, 0.68666666, 103],
  // Nano Banana 2 1K/2K: the first call's usual-markup price already covers every fallback's cost.
  ['EditImageNode', { model: 'Nano Banana 2', resolution: '1K' }, 0.08, 16],
  ['EditImageNode', { model: 'Nano Banana 2', resolution: '2K' }, 0.12, 18],
  // Nano Banana 2 4K: the fal Nano Banana Pro fallback, covered at cost only ($0.30 → $0.20), beats the $0.16 first call.
  ['EditImageNode', { model: 'Nano Banana 2', resolution: '4K' }, 0.20, 30],
  ['EditImageNode', { model: 'Flux Kontext Pro', resolution: '4K' }, 0.04, 8],
  // Unmeasured: 18 MP in (the 12288 × 1536 cap, in fal's 1024² megapixels) + 4 MP out (2048²) = 22: $0.03 + 21 × $0.015.
  ['EditImageNode', { model: 'Flux 2 Pro' }, 0.345, 52],
  // Measured 1024²: 1 + 1 MP.
  ['EditImageNode', { model: 'Flux 2 Pro' }, 0.045, 9, 1024 * 1024],
  // Measured 2048²: 4 + 4 MP.
  ['EditImageNode', { model: 'Flux 2 Pro' }, 0.135, 21, 2048 * 2048],
  ['DevelopImageNode', { resolution: '1K' }, 0.08, 16],
  ['DevelopImageNode', { resolution: '2K' }, 0.12, 18],
  // Develop 4K: same fallback-at-cost step as Edit image's Nano Banana 2 4K.
  ['DevelopImageNode', { resolution: '4K' }, 0.20, 30],
  // Replicate's Nano Banana 2 first since Task S3 ($0.067, 14 credits); the
  // ComfyUI path's fal NB Pro step ($0.15) at cost ($0.075) is dearer.
  ['RelightNode', {}, 0.075, 15],
  ['BlendSceneNode', { model: 'Flux 2 Pro' }, 0.345, 52],
  ['BlendSceneNode', { model: 'Flux 2 Pro' }, 0.045, 9, 1024 * 1024],
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
  ['GenerateFromReferencesNode', { model: 'nano-banana-2', size: '3K' }, 0.12, 18], // clamps to 2K
  // References at 4K: the fallback-at-cost step, same as Edit image's Nano Banana 2 4K.
  ['GenerateFromReferencesNode', { model: 'nano-banana-2', size: '4K' }, 0.20, 30],
  ['RotateCameraNode', {}, 0.03, 6],
  ['ProductShotNode', {}, 0.16, 24],
  // Replicate first since Task S3, as Relight: the NB Pro step at cost.
  ['RestyleFromImageNode', { model: 'Nano Banana 2', resolution: '1K' }, 0.075, 15],
  // Restyle Nano Banana 2 4K: the fallback-at-cost step, same as Edit image's.
  ['RestyleFromImageNode', { model: 'Nano Banana 2', resolution: '4K' }, 0.20, 30],
  ['RestyleFromImageNode', { model: 'Nano Banana Pro', resolution: '2K' }, 0.15, 23],
  ['RestyleFromImageNode', { model: 'Nano Banana Pro', resolution: '4K' }, 0.30, 45],
  ['RestyleFromImageNode', { model: 'Nano Banana', resolution: '4K' }, 0.039, 8],
  ['RestyleFromImageNode', { model: 'Style Transfer · IP-Adapter' }, 0.05, 10],
  // Upscale: the input (the 12288 × 1536 cap unmeasured) × scale² out.
  // LC4 fix round 1: Clarity by GPU time, $0.005 a call + $0.00051 a megapixel made a step (18 by default); no floor.
  ['UpscaleImageNode', { model: 'Clarity' }, 0.69806679, 105], // 75.5 M px × 18 steps
  ['UpscaleImageNode', { model: 'Clarity' }, 0.04172, 9, MP1], // 4 MP × 18
  ['UpscaleImageNode', { model: 'Clarity', scale_factor: 4 }, 0.15188, 23, MP1], // 16 MP × 18
  ['UpscaleImageNode', { model: 'Clarity', scale_factor: 1 }, 0.00740648, 2, 512 * 512], // the first live run's: billed $0.0029
  ['UpscaleImageNode', { model: 'Clarity', num_inference_steps: 50, creativity: 1 }, 0.11195475, 17, 1024 * 1024], // the second's: billed $0.0551
  ['UpscaleImageNode', { model: 'Crystal', scale_factor: 1 }, 0.40, 60], // 18.9 M px ≤ 27.5 M
  ['UpscaleImageNode', { model: 'Crystal' }, 1.60, 240], // 75.5 M px ≤ 110 M
  ['UpscaleImageNode', { model: 'Crystal' }, 0.05, 10, MP1], // 4 M px ≤ 4.4 M
  ['UpscaleImageNode', { model: 'Crystal', scale_factor: 10 }, 3.20, 480],
  // R7.11: Real-ESRGAN by the picture sent in, $0.003 a megapixel (at least $0.003), at most 1 572 864 px a call
  // (LC4: 1536 × 1024, under the 2 096 704 Replicate states, after a 2 046 000-px tile ran out of GPU memory):
  // unmeasured, the largest picture (12288 × 1536) in tiles (R11.6 fix round 3: the controller's ruling), fifteen at
  // the limit's 1.5729 MP each; 3840 × 2160 measured, seven (the most any picture of its pixels makes); the live check's 1152² (1.33 MP), $0.00398; 1 MP, the floor.
  ['UpscaleImageNode', { model: 'Real-ESRGAN', scale_factor: 10 }, 0.07077885, 15],
  ['UpscaleImageNode', { model: 'Real-ESRGAN', scale_factor: 2 }, 0.03303013, 7, 3840 * 2160],
  ['UpscaleImageNode', { model: 'Real-ESRGAN', scale_factor: 2 }, 0.003981312, 1, 1152 * 1152],
  ['UpscaleImageNode', { model: 'Real-ESRGAN' }, 0.003, 1, MP1],
  ['UpscaleImageNode', { model: 'Recraft Crisp' }, 0.006, 2],
  ['UpscaleImageNode', { model: 'Topaz' }, 0.32, 48], // 75.5 MP ≤ 96: 4 units
  ['UpscaleImageNode', { model: 'Topaz' }, 0.08, 16, MP1],
  ['UpscaleImageNode', { model: 'Topaz', topaz_upscale_factor: '4x' }, 0.32, 48, MP1 * 4],
  // 679 MP: past the table's 512 MP row, 17 units per 512 MP carried on.
  ['UpscaleImageNode', { model: 'Topaz', topaz_upscale_factor: '6x' }, 1.80486144, 271],
  // LC4: Creative is Clarity in place, by its steps (18).
  ['EnhanceDetailNode', { model: 'Creative' }, 0.1782667, 27], // 18.9 MP × 18 steps
  ['EnhanceDetailNode', { model: 'Creative' }, 0.01418, 3, MP1],
  ['EnhanceDetailNode', { model: 'Faithful' }, 0.08, 16],
  // LC4 fix round 1: the refiner by GPU time, $0.0046 a call + $0.000147 a megapixel a step (20 by default), linear.
  ['EnhanceDetailNode', { model: 'Diffusion Refine' }, 0.06009064, 13], // 18.9 MP × 20 steps
  ['EnhanceDetailNode', { model: 'Diffusion Refine' }, 0.00754, 2, MP1],
  ['EnhanceDetailNode', { model: 'Diffusion Refine' }, 0.0053707, 2, 512 * 512], // the first live run's: billed $0.0024
  ['EnhanceDetailNode', { model: 'Diffusion Refine', refine_steps: 50, detail_strength: 1 }, 0.01230703, 3, 1024 * 1024], // the second's: billed $0.0046
  ['EnhanceDetailNode', { model: 'Diffusion Refine' }, 0.01693125, 4, 2048 * 2048],
]

describe('worked examples', () => {
  it.each(EXAMPLES)('%s %j: $%s, %s credits (input %s px); badge = charge = estimate', (ct, w, usd, credits, inputPixels) => {
    const p = priceNode(ct, w, { inputPixels })
    // usd is compared with tolerance: a fallback covered at cost divides by
    // 1.5 (usdChargedAtCost, shared/pricing/markup.ts), which can leave
    // binary float noise (e.g. 0.3 / 1.5 → 0.19999999999999998) in the raw
    // dollar figure; credits still come out exact because creditsForUsd
    // rounds up to the nano-dollar first.
    expect(p).toEqual({ usd: expect.closeTo(usd, 8), credits })
    const graph = { 1: { class_type: ct, inputs: w }, 2: SINK }
    expect(priceGraph(graph, inputPixels ? { inputPixels: { 1: inputPixels } } : {}).credits).toBe(credits + 1)
    expect(nodeCreditEstimate(ct, w, { inputPixels })).toBe(credits + 1)
    const names = Object.keys(w)
    const est = estimateUsdForNodes([{ id: '1', type: ct, widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(k => w[k]), inputPixels }], { hosted: true })
    expect(est?.hostedCredits).toBe(credits + 1)
  })

  it('a linked setting is priced at its dearest value, a linked or missing model at the dearest model', () => {
    // A linked resolution prices each step at its own dearest tier: fal NB2's
    // max ($0.16, marked up), vs. fal NB Pro's max ($0.30) and Replicate
    // NB2's max ($0.151), each covered only at cost — fal NB Pro's at-cost
    // step ($0.20) wins.
    expect(priceNode('DevelopImageNode', { resolution: LINK })).toEqual({ usd: expect.closeTo(0.20, 8), credits: 30 })
    expect(priceNode('RestyleFromImageNode', { model: 'Nano Banana Pro', resolution: LINK })).toEqual({ usd: 0.30, credits: 45 })
    expect(priceNode('GenerateFromReferencesNode', { model: 'seedream-5-pro', size: LINK })).toEqual({ usd: 0.09, credits: 18 })
    // Linked model, 1K: the dearest of NB2's chain ($0.08), Kontext ($0.04), FLUX.2 at the cap ($0.345).
    expect(priceNode('EditImageNode', { model: LINK, resolution: '1K' })).toEqual({ usd: 0.345, credits: 52 })
    // …and with the picture measured at 1024², FLUX.2 drops to $0.045 (see the worked example above);
    // NB2's chain is now the dearest at $0.08.
    expect(priceNode('EditImageNode', { model: LINK, resolution: '1K' }, { inputPixels: 1024 * 1024 })).toEqual({ usd: 0.08, credits: 16 })
    expect(priceNode('EditImageNode', { resolution: '4K' })).toEqual({ usd: 0.345, credits: 52 })
    expect(priceNode('RestyleFromImageNode', { model: LINK, resolution: '4K' })).toEqual({ usd: 0.30, credits: 45 })
    expect(priceNode('UpscaleImageNode', { model: 'Crystal', scale_factor: LINK })).toEqual({ usd: 3.20, credits: 480 })
    expect(priceNode('UpscaleImageNode', { model: 'Topaz', topaz_upscale_factor: LINK })).toEqual({ usd: 1.80486144, credits: 271 })
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
    // Develop 4K: the fal Nano Banana Pro fallback covered at cost ($0.30 → $0.20 → 30 credits).
    expect(stageEstimate(prompt, ['1'], true)).toBe(30 + 1)
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
  // The ComfyUI path's fallbacks: fal Nano Banana Pro when fal NB2 fails.
  ['Develop 4K on its Nano Banana Pro fallback', 'DevelopImageNode', { resolution: '4K' }, 0.30],
  ['Relight on its Nano Banana Pro fallback', 'RelightNode', {}, 0.15],
  // The largest picture an unmeasured Upscale can be sent (the 12288 × 1536 cap) at 2×.
  ['Upscale: Crystal 2× at the cap', 'UpscaleImageNode', { model: 'Crystal' }, 1.60],
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

// ── The picture's real size (P4 fix round 1, I2) ─────────────────────────

/** A real PNG of w × h, as bytes. */
const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#808080' } }).png().toBuffer()

describe('priced on the size of the picture sent in', () => {
  it('which inputs are size-priced', () => {
    expect(sizePricedInput('UpscaleImageNode', { model: 'Crystal' })).toBe('image')
    expect(sizePricedInput('EnhanceDetailNode', { model: 'Creative' })).toBe('image')
    expect(sizePricedInput('EditImageNode', { model: 'Flux 2 Pro' })).toBe('input_image')
    expect(sizePricedInput('EditImageNode', { model: LINK })).toBe('input_image')
    expect(sizePricedInput('EditImageNode', { model: 'Nano Banana 2' })).toBeNull()
    expect(sizePricedInput('BlendSceneNode', { model: 'Flux 2 Pro' })).toBe('image')
    expect(sizePricedInput('BlendSceneNode', { model: 'Flux Kontext Pro' })).toBeNull()
    expect(sizePricedInput('DevelopImageNode', {})).toBeNull()
  })

  it('an upstream generator\'s settings say how large its picture is (or nothing, and the cap applies)', () => {
    expect(sourceOutputPixels('GenerateImageNode', { model: 'nano-banana-2', aspect_ratio: '1:1', model_options: '{"resolution":"2K"}' })).toBe(2048 ** 2)
    expect(sourceOutputPixels('GenerateImageNode', { model: 'flux-2-pro', aspect_ratio: '1:1', model_options: '{"resolution":"1 MP"}' })).toBe(2e6)
    expect(sourceOutputPixels('GenerateImageNode', { model: 'imagen-4', aspect_ratio: '1:1' })).toBeNull()
    expect(sourceOutputPixels('GenerateImageNode', { model: 'nano-banana-2', model_options: LINK })).toBeNull()
    expect(sourceOutputPixels('Image', { image: 'a.png' })).toBeNull()
  })

  it('LC4: Clarity and the refiner are held at least twice the GPU bill their live runs give, at the dearest settings', () => {
    const usdOf = (...a: Parameters<typeof priceNode>) => (priceNode(...a) as { usd: number }).usd
    // The live runs (predict_time), each priced by its own GPU's rate:
    //  Clarity (A100-40, $0.00115/s): 2.5 s at 0.262 MP made, 18 steps, creativity 0.35; 47.92 s at 4.194 MP, 50 steps, creativity 1.
    //  Refiner (L40S, $0.000975/s): 2.46 s at 0.262 MP, 20 steps, creativity 0.33; 4.70 s at 1.049 MP, 50 steps, creativity 0.6.
    const clarityRuns = [{ mp: 0.262144, steps: 18, creativity: 0.35, s: 2.5 }, { mp: 4.194304, steps: 50, creativity: 1, s: 47.92 }]
    const refineRuns = [{ mp: 0.262144, steps: 20, creativity: 0.33, s: 2.46 }, { mp: 1.048576, steps: 50, creativity: 0.6, s: 4.70 }]
    // Start + slope × MP × steps through both runs, steps as sent and as denoised (× creativity); the worse start and slope.
    type Run = { mp: number; steps: number; creativity: number; s: number }
    const fit = ([a, b]: Run[], denoised: boolean) => {
      const x = (r: Run) => r.mp * r.steps * (denoised ? r.creativity : 1)
      const slope = (b!.s - a!.s) / (x(b!) - x(a!))
      return { slope, start: a!.s - slope * x(a!) }
    }
    const worst = (runs: Run[]) => {
      const f = [fit(runs, false), fit(runs, true)]
      return { slope: Math.max(...f.map(x => x.slope)), start: Math.max(...f.map(x => x.start)) }
    }
    const c = worst(clarityRuns)
    const r = worst(refineRuns)
    expect(c.slope).toBeCloseTo(0.2216, 3)
    expect(c.start).toBeCloseTo(2.14, 2)
    expect(r.slope).toBeCloseTo(0.0754, 3)
    expect(r.start).toBeCloseTo(2.33, 2)
    // The bill at any size and steps, on every step sent (the dearest creativity).
    const clarityBill = (px: number, steps: number) => (c.start + c.slope * (px / 1e6) * steps) * 0.00115
    const refineBill = (px: number, steps: number) => (r.start + r.slope * (px / 1e6) * steps) * 0.000975
    // The measured runs themselves: held at ≥ 2× what they billed.
    expect(usdOf('UpscaleImageNode', { model: 'Clarity', scale_factor: 1 }, { inputPixels: 512 * 512 })).toBeGreaterThanOrEqual(2 * 2.5 * 0.00115)
    expect(usdOf('UpscaleImageNode', { model: 'Clarity', num_inference_steps: 50, creativity: 1 }, { inputPixels: 1024 * 1024 })).toBeGreaterThanOrEqual(2 * 47.92 * 0.00115)
    expect(usdOf('EnhanceDetailNode', { model: 'Diffusion Refine' }, { inputPixels: 512 * 512 })).toBeGreaterThanOrEqual(2 * 2.46 * 0.000975)
    expect(usdOf('EnhanceDetailNode', { model: 'Diffusion Refine', refine_steps: 50, detail_strength: 1 }, { inputPixels: 1024 * 1024 })).toBeGreaterThanOrEqual(2 * 4.70 * 0.000975)
    for (const px of [64 * 64, 512 * 512, 1024 * 1024, 2048 * 2048, LARGEST_INPUT_PIXELS]) {
      // Upscale on Clarity at its dearest: 50 steps, creativity 1, scale 1, 2 and 10.
      for (const scale_factor of [1, 2, 10]) {
        const held = usdOf('UpscaleImageNode', { model: 'Clarity', scale_factor, creativity: 1, num_inference_steps: 50 }, { inputPixels: px })
        expect(held, `Clarity ${px} px ×${scale_factor}`).toBeGreaterThanOrEqual(2 * clarityBill(Math.min(px, LARGEST_INPUT_PIXELS) * scale_factor ** 2, 50) - 1e-9)
      }
      expect(usdOf('EnhanceDetailNode', { model: 'Creative', detail_strength: 1, num_inference_steps: 50 }, { inputPixels: px }))
        .toBeGreaterThanOrEqual(2 * clarityBill(px, 50) - 1e-9)
      expect(usdOf('EnhanceDetailNode', { model: 'Diffusion Refine', detail_strength: 1, refine_steps: 50 }, { inputPixels: px }))
        .toBeGreaterThanOrEqual(2 * refineBill(px, 50) - 1e-9)
      // A wired step count: the service's most (100).
      expect(usdOf('UpscaleImageNode', { model: 'Clarity', num_inference_steps: LINK }, { inputPixels: px }))
        .toBeGreaterThanOrEqual(2 * clarityBill(px * 4, 100) - 1e-9)
      expect(usdOf('EnhanceDetailNode', { model: 'Diffusion Refine', refine_steps: LINK }, { inputPixels: px }))
        .toBeGreaterThanOrEqual(2 * refineBill(px, 100) - 1e-9)
    }
    // Steps are read as sent: fewer steps, a lower price; the node's defaults (18, 20) when missing.
    expect(usdOf('UpscaleImageNode', { model: 'Clarity', num_inference_steps: 10 }, { inputPixels: MP1 })).toBeCloseTo(0.005 + 0.00051 * 4 * 10, 9)
    expect(usdOf('EnhanceDetailNode', { model: 'Diffusion Refine', refine_steps: 10 }, { inputPixels: MP1 })).toBeCloseTo(0.0046 + 0.000147 * 10, 9)
  })

  it('a measured size above the cap is priced at the cap, so no charge exceeds the ceiling badge', () => {
    const ceiling = priceNode('UpscaleImageNode', { model: 'Clarity' })
    expect(priceNode('UpscaleImageNode', { model: 'Clarity' }, { inputPixels: 60e6 })).toEqual(ceiling)
    expect(priceNode('UpscaleImageNode', { model: 'Clarity' }, { inputPixels: LARGEST_INPUT_PIXELS })).toEqual(ceiling)
  })

  it('the hosted gate reads a loaded file\'s header, follows Image cards and generators, and leaves the rest at the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p4-px-'))
    writeFileSync(join(dir, 'small.png'), await png(800, 600))
    const readFile = async (v: string) => picturePixels(join(dir, v.replace(/ \[input\]$/, '')))
    const prompt = {
      1: { class_type: 'LoadImage', inputs: { image: 'small.png [input]' } },
      2: { class_type: 'UpscaleImageNode', inputs: { model: 'Crystal', image: ['1', 0] } },
      3: { class_type: 'GenerateImageNode', inputs: { model: 'nano-banana-2', aspect_ratio: '1:1', model_options: '{"resolution":"1K"}' } },
      4: { class_type: 'Image', inputs: { image: '', images: ['3', 0] } },
      5: { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['4', 0] } },
      6: { class_type: 'EnhanceDetailNode', inputs: { model: 'Faithful', image: ['7', 0] } },
      7: { class_type: 'RemoveBackgroundNode', inputs: {} },
      8: { class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['1', 0] } },
      9: { class_type: 'UpscaleImageNode', inputs: { model: 'Crystal', image: ['10', 0] } },
      10: { class_type: 'LoadImage', inputs: { image: 'missing.png' } },
    }
    const px = await graphInputPixels(prompt, readFile)
    expect(px).toEqual({ 2: 800 * 600, 5: 1024 * 1024 })
    // The charge reads it: Crystal 2× of 0.48 MP is 1.92 M px ($0.05); FLUX.2 at 1024² is $0.045.
    const priced = priceGraph(prompt, { inputPixels: px })
    expect(priced.breakdown.find(b => b.action === 'UpscaleImageNode:Crystal')?.credits).toBe(10)
    expect(priced.breakdown.find(b => b.action === 'EditImageNode:Flux 2 Pro')?.credits).toBe(9)
  })

  // Task G1 (final re-review finding 1): a size-priced node fed by an Upscale
  // or Enhance detail — not just a loaded file or a generator — is measured
  // by following the chain and applying the engine's factor, so it is
  // refused above the cap like any other measured picture instead of
  // silently priced at it.
  it('follows Upscale and Enhance detail upstream, applying their factor, any number of hops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p4-chain-'))
    writeFileSync(join(dir, 'photo.jpg'), await sharp({ create: { width: 4000, height: 4000, channels: 3, background: '#888' } }).jpeg().toBuffer())
    const readFile = async (v: string) => picturePixels(join(dir, v))
    // The probe from final-rereview.md finding 1: 16 MP → Topaz 2× (64 MP out) → Edit on Flux 2 Pro.
    const probe = {
      1: { class_type: 'LoadImage', inputs: { image: 'photo.jpg' } },
      2: { class_type: 'UpscaleImageNode', inputs: { model: 'Topaz', topaz_upscale_factor: '2x', image: ['1', 0] } },
      3: { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['2', 0] } },
    }
    const px = await graphInputPixels(probe, readFile)
    expect(px).toEqual({ 2: 16_000_000, 3: 64_000_000 })
    // Refused above the cap, not capped at it — the exact bug the probe found.
    expect(measuredInputProblems(probe as unknown as ApiPrompt, px)).toEqual([
      { nodeId: '3', classType: 'EditImageNode', input: 'input_image', message: FLUX_2_EDIT_TOO_LARGE },
    ])

    // The second probe: Topaz 2× → Enhance detail (in place, so still 64 MP, still refused).
    const probe2 = {
      1: { class_type: 'LoadImage', inputs: { image: 'photo.jpg' } },
      2: { class_type: 'UpscaleImageNode', inputs: { model: 'Topaz', topaz_upscale_factor: '2x', image: ['1', 0] } },
      3: { class_type: 'EnhanceDetailNode', inputs: { model: 'Faithful', image: ['2', 0] } },
    }
    const px2 = await graphInputPixels(probe2, readFile)
    expect(px2).toEqual({ 2: 16_000_000, 3: 64_000_000 })
    expect(measuredInputProblems(probe2 as unknown as ApiPrompt, px2)).toEqual([
      { nodeId: '3', classType: 'EnhanceDetailNode', input: 'image', message: ENHANCE_DETAIL_TOO_LARGE },
    ])

    // Two Upscales in a row: 16 MP → Real-ESRGAN 2× (64 MP out) → Crystal at 1× (unchanged): node 3's
    // OWN measured input is node 2's computed OUTPUT, not node 1's picture — two hops, still exact.
    const chained = {
      1: { class_type: 'LoadImage', inputs: { image: 'photo.jpg' } },
      2: { class_type: 'UpscaleImageNode', inputs: { model: 'Real-ESRGAN', scale_factor: 2, image: ['1', 0] } },
      3: { class_type: 'UpscaleImageNode', inputs: { model: 'Crystal', scale_factor: 1, image: ['2', 0] } },
    }
    const px3 = await graphInputPixels(chained, readFile)
    expect(px3).toEqual({ 2: 16_000_000, 3: 64_000_000 })

    // An Upscale whose OWN input can't be sized (the file can't be read):
    // nothing downstream is priced on a guess, and both size-priced nodes are
    // refused in plain words (gate-chained-pictures.unit.spec.ts has the rest).
    const unresolvable = {
      1: { class_type: 'LoadImage', inputs: { image: 'missing.jpg' } },
      2: { class_type: 'UpscaleImageNode', inputs: { model: 'Topaz', image: ['1', 0] } },
      3: { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['2', 0] } },
    }
    const sized = await graphInputSizes(unresolvable, readFile)
    expect(sized.pixels).toEqual({})
    expect(sized.problems.map(p => p.nodeId)).toEqual(['2', '3'])
  })

  it('meterGraphSubmit prices and holds on the measured size', async () => {
    const prompt = { 1: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, 2: { class_type: 'UpscaleImageNode', inputs: { model: 'Crystal', image: ['1', 0] } }, 3: SINK }
    const held: number[] = []
    const deps = {
      priceGraph, measureInputPixels: async () => ({ 2: MP1 }),
      spendGuard: async () => {}, validateFileRefs: async () => {}, moderatePrompt: async () => ({ ok: true as const }),
      hold: async (_u: string, credits: number) => { held.push(credits); return { ok: true as const, holdId: 1 } },
      getAvailable: async () => 0, forward: async () => ({ status: 200, body: { prompt_id: 'p' } }),
      registerRun: async () => {}, startSettle: () => {}, releaseHold: async () => {},
    }
    await meterGraphSubmit('u', { prompt }, deps)
    expect(held).toEqual([10 + 1]) // Crystal 2× of 1 MP: $0.05
    await meterGraphSubmit('u', { prompt }, { ...deps, measureInputPixels: undefined })
    expect(held[1]).toBe(240 + 1) // unmeasured: the cap
  })

  it('the runner measures the FLUX.2 picture before it submits and charges on that size', async () => {
    const bytes = new Uint8Array(await png(1024, 1024))
    const node = { class_type: 'EditImageNode', inputs: { model: 'Flux 2 Pro', input_image: ['1', 0] } }
    const file = { filename: 'a.png', subfolder: '', type: 'output' as const }
    const px = await measuredInputPixels(node, () => [file], async () => bytes)
    expect(px).toBe(1024 * 1024)
    expect(nodeCredits(node, px)).toBe(9)
    // The stage hold is the cap (an upper bound); the charge is never above it.
    expect(stageEstimate({ 2: node }, ['2'], false)).toBe(52)
    // Not size-priced, or unreadable: undefined (the cap).
    expect(await measuredInputPixels({ class_type: 'EditImageNode', inputs: { model: 'Nano Banana 2', input_image: ['1', 0] } }, () => [file], async () => bytes)).toBeUndefined()
    expect(await measuredInputPixels(node, () => [file], async () => { throw new Error('gone') })).toBeUndefined()
  })

  it('the badge: follows a generator on the canvas and then equals the charge; otherwise shows the ceiling, never below the charge', () => {
    const gen = { id: '1', data: { nodeType: 'GenerateImageNode', inputs: [], widgetDefs: [{ name: 'model' }, { name: 'aspect_ratio' }, { name: 'model_options' }], widgetsValues: ['nano-banana-2', '1:1', '{"resolution":"1K"}'] } }
    const load = { id: '3', data: { nodeType: 'LoadImage', inputs: [], widgetDefs: [{ name: 'image' }], widgetsValues: ['a.png'] } }
    const up = (src: string) => ({ id: '2', data: { nodeType: 'UpscaleImageNode', inputs: [{ name: 'image', link: 1 }], widgetDefs: [{ name: 'model' }], widgetsValues: ['Crystal'] } , src })
    const edges = (src: string) => [{ source: src, target: '2', targetHandle: 'input-0' }]
    // From a generator: both sides see 1024² — badge = charge exactly.
    const seen = upstreamInputPixels(up('1'), [gen, load, up('1')], edges('1'))
    expect(seen).toBe(1024 * 1024)
    const gatePx = sourceOutputPixels('GenerateImageNode', { model: 'nano-banana-2', aspect_ratio: '1:1', model_options: '{"resolution":"1K"}' })
    expect(nodeCreditEstimate('UpscaleImageNode', { model: 'Crystal' }, { inputPixels: seen })).toBe(charge2('Crystal', gatePx!))
    const [est] = vueNodesToEstimateInput([up('1'), gen], edges('1'))
    expect(est!.inputPixels).toBe(1024 * 1024)
    // From a loaded file: the canvas can't see the size — the ceiling, at or above any charge the gate makes.
    expect(upstreamInputPixels(up('3'), [gen, load, up('3')], edges('3'))).toBeNull()
    const badge = nodeCreditEstimate('UpscaleImageNode', { model: 'Crystal' })!
    for (const real of [1, 1e5, MP1, 4e6, 16e6, LARGEST_INPUT_PIXELS, 50e6]) expect(badge).toBeGreaterThanOrEqual(charge2('Crystal', real))
  })
})

/** The charge for a one-node Upscale graph whose picture measured `px`. */
function charge2(model: string, px: number): number {
  return priceGraph({ 1: { class_type: 'UpscaleImageNode', inputs: { model } }, 2: SINK }, { inputPixels: { 1: px } }).credits
}

// ── P4 fix round 2 ───────────────────────────────────────────────────────

describe('RestyleWithLoRANode: priced by its calls', () => {
  it('reads the calls and the re-roll rule from the Python', () => {
    const i = PY.indexOf('class RestyleWithLoRANode')
    const body = PY.slice(i, PY.indexOf('\nclass ', i + 10))
    expect(Number(/_RESTYLE_MAX_NB_RETRIES\s*=\s*(\d+)/.exec(PY)![1])).toBe(RESTYLE_LORA_NB_RETRIES)
    expect(body).toMatch(/for attempt in range\(1 \+ _RESTYLE_MAX_NB_RETRIES\):/)
    // A re-roll follows a call that SUCCEEDED (and was billed): the loop only
    // breaks on a photo target or an output classified as an illustration.
    expect(body).toMatch(/best_url = await _run_nano_banana_edit\(\s*\n\s*\[content_url, style_url\], instruction,\s*\n\s*resolution=resolution/)
    expect(body).toMatch(/if await _classify_image_style\(best_url\) == "illustration":\s*\n\s*matched = True\s*\n\s*break/)
    // Moondream: one caption, one classification of the reference, one per pass.
    expect(body.match(/"lucataco\/moondream2"/g)).toHaveLength(1)
    expect(body.match(/_classify_image_style\(/g)).toHaveLength(2)
    expect(PY).toMatch(/async def _classify_image_style[\s\S]{0,400}"lucataco\/moondream2"/)
    expect(body).toContain('flux_model = "black-forest-labs/flux-dev-lora"')
    expect(body).toMatch(/IO\.Combo\.Input\("resolution", options=\["1K", "2K", "4K"\], default="1K"/)
    const steps = editSteps('RestyleWithLoRANode', { resolution: '2K' })!
    expect(steps.map(st => [st.call.endpoint, st.times])).toEqual([
      ['lucataco/moondream2', 5], ['black-forest-labs/flux-dev-lora', 1], ['fal-ai/nano-banana-2/edit', 3],
    ])
    expect(steps[2]!.call.fallbacks!.map(f => f.endpoint)).toEqual(['fal-ai/nano-banana-pro/edit', 'google/nano-banana-2'])
  })

  it('left the flat table; the badge equals the charge', () => {
    expect(GRAPH_NODE_CREDITS.RestyleWithLoRANode).toBeUndefined()
    expect(MODEL_PRICED_BADGE_CLASSES.has('RestyleWithLoRANode')).toBe(true)
    for (const resolution of ['1K', '2K', '4K', LINK, undefined]) {
      const w = resolution === undefined ? {} : { resolution }
      expect(nodeCreditEstimate('RestyleWithLoRANode', w)).toBe(charge('RestyleWithLoRANode', w))
    }
  })
})

describe('an upstream Nano Banana picture is sized by its real ratio', () => {
  it('Google\'s table: 16:9 at 1K is 1376 × 768, larger than 1024²; an unknown ratio takes the tier\'s largest', () => {
    expect(nanoBananaPixels('1K', '16:9')).toBe(1376 * 768)
    expect(nanoBananaPixels('1K', '1:1')).toBe(1024 * 1024)
    expect(nanoBananaPixels('4K', '21:9')).toBe(6336 * 2688)
    expect(nanoBananaPixels('1K', 'auto')).toBe(3072 * 384) // 8:1, the largest 1K picture
    expect(nanoBananaPixels('high', '1:1')).toBeNull()
  })

  // Every ratio × tier Nano Banana 2 makes, fed into FLUX.2 edit and Crystal:
  // the badge (from the generator's settings) is never below the charge on the
  // picture actually made (the runner measures it).
  const SIZES: [string, string, number, number][] = [
    ['16:9', '1K', 1376, 768], ['9:16', '2K', 1536, 2752], ['21:9', '1K', 1584, 672], ['21:9', '4K', 6336, 2688],
    ['4:3', '2K', 2400, 1792], ['8:1', '4K', 12288, 1536], ['3:2', '0.5K', 632, 424], ['1:1', '1K', 1024, 1024],
  ]
  for (const [ratio, tier, w, h] of SIZES) {
    it(`NB2 ${ratio} at ${tier} (${w}×${h}) into FLUX.2 edit and Crystal: badge ≥ charge`, () => {
      const gen = { id: '1', data: { nodeType: 'GenerateImageNode', inputs: [], widgetDefs: [{ name: 'model' }, { name: 'aspect_ratio' }, { name: 'model_options' }], widgetsValues: ['nano-banana-2', ratio, JSON.stringify({ resolution: tier })] } }
      for (const [ct, model, port] of [['EditImageNode', 'Flux 2 Pro', 'input_image'], ['UpscaleImageNode', 'Crystal', 'image']] as const) {
        const node = { id: '2', data: { nodeType: ct, inputs: [{ name: port, link: 1 }], widgetDefs: [{ name: 'model' }], widgetsValues: [model] } }
        const seen = upstreamInputPixels(node, [gen, node], [{ source: '1', target: '2', targetHandle: 'input-0' }])
        expect(seen, `${ct} ${ratio} ${tier}`).toBeGreaterThanOrEqual(w * h)
        const badge = nodeCreditEstimate(ct, { model }, { inputPixels: seen })!
        const real = priceGraph({ 2: { class_type: ct, inputs: { model } }, 3: SINK }, { inputPixels: { 2: w * h } }).credits
        expect(badge, `${ct} ${ratio} ${tier}`).toBeGreaterThanOrEqual(real)
      }
    })
  }
})

describe('the gate reads files sparingly', () => {
  it('sniffs PNG, JPEG, WebP, GIF and TIFF (Task G1 widens past PNG/JPEG/WebP); anything else prices at the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p4-sniff-'))
    const make = (fmt: 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff') =>
      sharp({ create: { width: 40, height: 30, channels: 3, background: '#888' } }).toFormat(fmt).toBuffer()
    for (const fmt of ['png', 'jpeg', 'webp', 'gif', 'tiff'] as const) {
      const bytes = await make(fmt)
      expect(isMeasurableRaster(bytes), fmt).toBe(true)
      // A PNG name on a GIF/TIFF file: the bytes decide.
      writeFileSync(join(dir, `a.${fmt}.png`), bytes)
      expect(await picturePixels(join(dir, `a.${fmt}.png`)), fmt).toBe(1200)
      expect(await picturePixels(new Uint8Array(bytes)), fmt).toBe(1200)
    }
    writeFileSync(join(dir, 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="9000" height="9000"/>')
    expect(await picturePixels(join(dir, 'x.svg'))).toBeNull()
  })

  it('reads a BMP from its own header, and AVIF/HEIC by walking their ispe box — no decode (Task G1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p4-sniff2-'))
    const avif = await sharp({ create: { width: 50, height: 20, channels: 3, background: '#888' } }).avif().toBuffer()
    expect(sniffPictureFormat(avif)).toBe('avif')
    writeFileSync(join(dir, 'a.avif'), avif)
    expect(await picturePixels(join(dir, 'a.avif'))).toBe(50 * 20)
    expect(await picturePixels(new Uint8Array(avif))).toBe(50 * 20)
    expect(isobmffIspePixels(avif)).toBe(50 * 20)

    // A real HEIC needs an HEVC encoder this build lacks; a synthetic ftyp
    // 'heic' brand over the same ISOBMFF (meta/iprp/ipco/ispe) boxes proves
    // the box walk itself, which reads either container the same way.
    const heic = Buffer.from(avif)
    heic.write('heic', 8, 'ascii') // ftyp brand: avif → heic; the box structure underneath is unchanged
    expect(sniffPictureFormat(heic)).toBe('heic')
    expect(await picturePixels(new Uint8Array(heic))).toBe(50 * 20)

    // BITMAPINFOHEADER BMP (the common case): 3×2 px, no pixel data needed.
    const bmp = new Uint8Array(26)
    bmp.set([0x42, 0x4D], 0) // "BM"
    new DataView(bmp.buffer).setUint32(14, 40, true) // DIB header size: BITMAPINFOHEADER
    new DataView(bmp.buffer).setInt32(18, 3, true) // width
    new DataView(bmp.buffer).setInt32(22, -2, true) // height, top-down (negative)
    expect(sniffPictureFormat(bmp)).toBe('bmp')
    expect(bmpPixels(bmp)).toBe(6)
    expect(await picturePixels(bmp)).toBe(6)

    // An old-style BITMAPCOREHEADER BMP (12-byte DIB, u16 width/height).
    const bmpCore = new Uint8Array(22)
    bmpCore.set([0x42, 0x4D], 0)
    new DataView(bmpCore.buffer).setUint32(14, 12, true)
    new DataView(bmpCore.buffer).setUint16(18, 4, true)
    new DataView(bmpCore.buffer).setUint16(20, 5, true)
    expect(bmpPixels(bmpCore)).toBe(20)

    // A picture format this still can't read (no BMP codec, no HEVC decoder
    // for a real HEIC): a header short of what bmpPixels/isobmffIspePixels
    // need prices at the cap, exactly as an unrecognised format does.
    expect(bmpPixels(new Uint8Array([0x42, 0x4D]))).toBeNull()
    expect(isobmffIspePixels(new Uint8Array([0, 0, 0, 12, ...Buffer.from('ftyp'), ...Buffer.from('heic')]))).toBeNull()
  })

  it('reads each file value once, and at most MAX_MEASURED_FILES per prompt', async () => {
    const reads: string[] = []
    const readFile = async (v: string) => { reads.push(v); return 1000 }
    const prompt: Record<string, { class_type: string, inputs: Record<string, unknown> }> = {}
    // 12 distinct files, each feeding two upscalers.
    for (let i = 0; i < 12; i++) {
      prompt[`L${i}`] = { class_type: 'LoadImage', inputs: { image: `f${i}.png` } }
      prompt[`U${i}a`] = { class_type: 'UpscaleImageNode', inputs: { model: 'Crystal', image: [`L${i}`, 0] } }
      prompt[`U${i}b`] = { class_type: 'UpscaleImageNode', inputs: { model: 'Crystal', image: [`L${i}`, 0] } }
    }
    const px = await graphInputPixels(prompt, readFile)
    expect(MAX_MEASURED_FILES).toBe(8)
    expect(reads).toHaveLength(8)
    expect(new Set(reads).size).toBe(8)
    // The measured ones (both nodes on a read file) get the size; the rest, the cap.
    expect(Object.keys(px)).toHaveLength(16)
    const priced = priceGraph(prompt, { inputPixels: px })
    const capped = priced.breakdown.filter(b => b.credits === 240)
    expect(capped).toHaveLength(8)
  })
})

describe('the runner measures the file it sends: the first on the linked slot', () => {
  // Final review finding 1: every builder sends the first file of a batch (as
  // Python does), so that is the one measured, priced and judged against the
  // cap, whatever the batch's length.
  it('takes the first; an unreadable first prices at the cap; the rest are never read', async () => {
    const node = { class_type: 'UpscaleImageNode', inputs: { model: 'Crystal', image: ['1', 0] } }
    const files = ['l', 's', 'm'].map(n => ({ filename: `${n}.png`, subfolder: '', type: 'output' as const }))
    const bytes: Record<string, Uint8Array> = {
      's.png': new Uint8Array(await png(100, 100)), 'l.png': new Uint8Array(await png(1200, 900)), 'm.png': new Uint8Array(await png(400, 400)),
    }
    const read: string[] = []
    expect(await measuredInputPixels(node, () => files, async f => { read.push(f.filename); return bytes[f.filename]! })).toBe(1200 * 900)
    expect(read).toEqual(['l.png'])
    expect(await measuredInputPixels(node, () => files, async f => { if (f.filename === 'l.png') throw new Error('gone'); return bytes[f.filename]! })).toBeUndefined()
    // A batch longer than the old 8-file limit is still measured by its first file.
    const nine = Array.from({ length: 9 }, () => files[0]!)
    expect(await measuredInputPixels(node, () => nine, async f => bytes[f.filename]!)).toBe(1200 * 900)
  })
})
