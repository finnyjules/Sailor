import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NANO_FAMILY } from '../../server/utils/inpaintFalInputs'
import { describe, expect, it } from 'vitest'
import { MODEL_COSTS, PRICE_BOOK_VERSION, costForModel, priceGraph } from '../../server/utils/priceBook'

describe('price book: graph pricer (unchanged spike behavior)', () => {
  // spike-v4 (Stage 5 Task 3): GenerateVideoNode is no longer flat-priced —
  // its model widget spans $0.04 to $3.20 per clip, so it prices by model and
  // REFUSES without one. Fixture updated to a still-flat premium class; the
  // model-priced path is covered in price-graph.unit.spec.ts.
  it('base render + premium node', () => {
    const p = priceGraph({
      1: { class_type: 'SaveImage' },
      2: { class_type: 'Veo3RemoteNode' },
    })
    expect(p.credits).toBe(901)
    expect(p.version).toBe(PRICE_BOOK_VERSION)
  })

  it('no output node → zero credits', () => {
    expect(priceGraph({ 1: { class_type: 'KSampler' } }).credits).toBe(0)
  })

  // spike-v3 (pricing call 2026-08-13): the LoRA family was 50% of observed
  // spend and completely unpriced — priced as a CATEGORY (slug-independent,
  // personal fine-tunes can never live in a static slug table).
  it('LoRA-family nodes are priced', () => {
    const p = priceGraph({
      1: { class_type: 'SaveImage' },
      2: { class_type: 'RestyleWithLoRANode' },
      3: { class_type: 'FluxLoRARemoteNode' },
      4: { class_type: 'FluxMultiLoRARemoteNode' },
    })
    expect(p.credits).toBe(1 + 18 + 8 + 8)
  })

  // spike-v3: the two below-policy prices from the pricing analysis.
  // LipSync observed $1.00/run (was 30cr = 70¢ loss); EditImage's graph path
  // was 12cr against a 23cr direct-route price for the same action.
  it('LipSync and EditImage are priced above provider cost', () => {
    expect(priceGraph({ 1: { class_type: 'SaveImage' }, 2: { class_type: 'LipSyncNode' } }).credits).toBe(151)
    expect(priceGraph({ 1: { class_type: 'SaveImage' }, 2: { class_type: 'EditImageNode' } }).credits).toBe(24)
  })
})

describe('price book: model costs', () => {
  it('looks up a known model and returns null for unknown', () => {
    expect(costForModel('meta/sam-2')).toMatchObject({ usd: 0.022, credits: 4 })
    expect(costForModel('does-not/exist')).toBeNull()
  })

  it('never prices an action below provider cost', () => {
    for (const [model, c] of Object.entries(MODEL_COSTS)) {
      const costInCredits = Math.max(1, Math.ceil(c.usd * 100))
      expect(c.credits, `${model} priced below cost`).toBeGreaterThanOrEqual(costInCredits)
    }
  })

  it('markup stays within the strategy band (≤3×, floor-priced entries exempt)', () => {
    for (const [model, c] of Object.entries(MODEL_COSTS)) {
      if (c.usd * 100 < 1) continue // floor of 1 credit on sub-cent actions
      expect(c.credits, `${model} markup looks like a typo`).toBeLessThanOrEqual(Math.ceil(c.usd * 100 * 3))
    }
  })

  it('credits are positive integers', () => {
    for (const [model, c] of Object.entries(MODEL_COSTS)) {
      expect(Number.isInteger(c.credits) && c.credits >= 1, model).toBe(true)
    }
  })

  // Review fix (Stage 5 Task 3): these three rows were derived as if their
  // graph nodes carried no price_badge. They do (nodes_replicate.py:1423
  // Clarity, :1344 Kling, :1596 Seedance2 — the multi-line price_badge form
  // the original sweep missed). Kling is point-priced so its badge stands.
  // Clarity and Seedance2 are RANGE-priced (see priceBook.ts comments) and
  // the same slugs are priced at range top via the picker nodes, so these
  // rows are pinned to range-top USD ($0.20 / $0.60) — badge divergence
  // ($0.10 / $0.50) flagged for the pre-launch invoice sweep.
  it('kling/seedance2/clarity match their graph node range-top USD', () => {
    expect(MODEL_COSTS['kwaivgi/kling-v2.1']).toMatchObject({ usd: 0.35, credits: 53 })
    expect(MODEL_COSTS['bytedance/seedance-2.0']).toMatchObject({ usd: 0.6, credits: 90 })
    expect(MODEL_COSTS['philz1337x/clarity-upscaler']).toMatchObject({ usd: 0.2, credits: 30 })
  })
})

describe('price book: coverage of the codebase', () => {
  // Every provider model slug that appears in server code must be priced —
  // an unpriced model is unmetered spend waiting for Stage 4.
  const serverRoot = fileURLToPath(new URL('../../server', import.meta.url))
  const SLUG = /'((?:black-forest-labs|fal-ai|meta|bytedance|recraft-ai|ostris|lucataco|minimax|krea|851-labs)\/[a-z0-9./-]+)'/g
  // Non-inference references that legitimately appear in code without a price:
  const EXEMPT = new Set<string>([
    // A model FAMILY fragment in inpaintFalInputs.ts's NANO_FAMILY, not a callable slug — the
    // app is assembled as `fal-ai/${family}/edit`. The assembled slugs are checked below.
    'bytedance/seedream/v5/lite',
  ])

  function walk(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, acc)
      else if (p.endsWith('.ts')) acc.push(p)
    }
    return acc
  }

  it('every model slug in server/ has a price entry', () => {
    const found = new Set<string>()
    for (const file of walk(serverRoot)) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(SLUG)) found.add(m[1])
    }
    expect(found.size).toBeGreaterThan(10) // the scan itself must be alive
    const unpriced = [...found].filter(s => !MODEL_COSTS[s] && !EXEMPT.has(s))
    expect(unpriced, `unpriced model slugs: ${unpriced.join(', ')}`).toEqual([])
  })

  it('every slug ASSEMBLED at call time is priced too (the literal scan above cannot see these)', () => {
    // nanoGenInput builds `fal-ai/${family}/edit` from a variant key. An unpriced one is refused
    // outright in hosted mode, so a new family has to arrive with its price.
    const assembled = ['nano-banana-pro', ...Object.values(NANO_FAMILY)].map(f => `fal-ai/${f}/edit`)
    const unpriced = assembled.filter(s => !MODEL_COSTS[s])
    expect(unpriced, `unpriced assembled slugs: ${unpriced.join(', ')}`).toEqual([])
  })
})
