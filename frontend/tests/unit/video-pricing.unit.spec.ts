/**
 * Task P2 (model line-up): video priced per second of the clip actually sent.
 *
 * - The rate card covers every catalogue model, each rate with its source.
 * - Settings parity: every runner builder, over every setting, sends the
 *   seconds, resolution and sound the price reads (effectiveVideoSettings).
 *   Fabric has no runner builder; its rule is checked against the Python one.
 * - Worked examples, badge = charge, and the line-up page's loss table.
 * - P1 review minors: a linked widget prices the same on the badge and the
 *   charge; prototype names are refused; every MODEL_COSTS row follows the markup.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VIDEO_MODELS } from '~~/app/data/video-models'
import { LEGACY_VIDEO_MODEL_IDS } from '~~/app/data/video-prices'
import { RUNNER_REPLICATE_VIDEO_MODELS, RUNNER_VIDEO_MODELS } from '~~/server/runner/generators/video'
import { asInt, parseJsonObject } from '~~/server/runner/generators/opts'
import { RUNNER_REPLICATE_VIDEO_MODEL_IDS, RUNNER_VIDEO_MODEL_IDS } from '#shared/runner/eligibility'
import { MODEL_COSTS, UnpricedGraphError, priceGraph } from '~~/server/utils/priceBook'
import { PACKS, PACK_VIDEO_CLIP } from '~~/server/utils/packs'
import { creditsForUsd } from '#shared/pricing/markup'
import { nodeCredits, priceNode, providerUsd } from '#shared/pricing/nodePrice'
import { VIDEO_RATES, videoRate, videoRateLabel, videoUsd } from '#shared/pricing/videoRates'
import { effectiveVideoSettings, hasVideoSettings, maxVideoSeconds } from '#shared/pricing/videoSettings'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes, linkedInputNames, widgetValueMap } from '~/lib/costEstimate'
import { graphToPrompt } from '~/lib/graph/graphToPrompt'

const VIDEO_CLASSES = ['GenerateVideoNode', 'FilmShotNode'] as const
const SINK = { class_type: 'SaveImage', inputs: {} }

/** What priceGraph charges for one video node plus an output node. */
function charge(classType: string, inputs: Record<string, unknown>): number {
  return priceGraph({ 1: { class_type: classType, inputs }, 2: SINK }).credits
}

describe('the video rate card', () => {
  it('covers every catalogue model (hidden ones too) and nothing else', () => {
    expect(Object.keys(VIDEO_RATES).sort()).toEqual(VIDEO_MODELS.map(m => m.id).sort())
    for (const m of VIDEO_MODELS) expect(hasVideoSettings(m.id), m.id).toBe(true)
  })

  it('every rate names its service, source page, date, unit and confidence, and is above zero', () => {
    for (const [id, r] of Object.entries(VIDEO_RATES)) {
      expect(r.source, id).toMatch(/^https:\/\/(fal\.ai|replicate\.com)\//)
      expect(r.read, id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(['per_second', 'per_clip'], id).toContain(r.unit)
      expect(['verified', 'estimate'], id).toContain(r.confidence)
      expect(r.source.includes('fal.ai') ? 'fal' : 'replicate', id).toBe(r.service)
      const figures = Object.values(r.byResolution).flatMap(v =>
        typeof v === 'number' ? [v] : Object.values(v as Record<string, number>))
      expect(figures.length, id).toBeGreaterThan(0)
      for (const f of figures) expect(f, id).toBeGreaterThan(0)
    }
  })

  it('the first service is the one the builder sends to: fal for the fal list, Replicate for the rest', () => {
    for (const id of RUNNER_VIDEO_MODEL_IDS) expect(VIDEO_RATES[id]!.service, id).toBe('fal')
    for (const id of RUNNER_REPLICATE_VIDEO_MODEL_IDS) expect(VIDEO_RATES[id]!.service, id).toBe('replicate')
    expect(VIDEO_RATES['fabric-1.0']!.service).toBe('replicate')
  })

  // A model a family switch can turn on must have a verified price. The one
  // exception is reported to the controller: LTX-Video is billed by GPU time,
  // so Replicate publishes no per-clip figure (it is on the hide list).
  const ESTIMATE_OK: Record<string, string> = {
    'ltx-video': 'Replicate bills it by compute time; the page gives only an approximate run cost',
  }
  it('every runner video model is priced verified, except the listed ones', () => {
    for (const id of [...RUNNER_VIDEO_MODEL_IDS, ...RUNNER_REPLICATE_VIDEO_MODEL_IDS]) {
      if (id in ESTIMATE_OK) continue
      expect(videoRate(id)!.confidence, id).toBe('verified')
    }
    for (const id of Object.keys(ESTIMATE_OK)) expect(videoRate(id)!.confidence, id).toBe('estimate')
  })

  it('every catalogue model prices above zero at its defaults, on both video classes', () => {
    for (const m of VIDEO_MODELS) {
      for (const ct of VIDEO_CLASSES) expect(providerUsd(ct, { model: m.id })!, `${ct} ${m.id}`).toBeGreaterThan(0)
    }
  })
})

// ── Settings parity ─────────────────────────────────────────────────────────
// What each service does with a setting the builder does NOT send, from the
// saved schemas (read 2026-09-24): the model's schema default.
const SERVICE_DEFAULT: Record<string, { seconds?: number, resolution?: string | null, audio?: boolean }> = {
  // H3 / H3 Max always render sound (no generate_audio input on fal).
  'hailuo-h3': { audio: true },
  'hailuo-h3-max': { audio: true },
  // Sora: no resolution input on Sora 2; Sora 2 Pro `resolution` default "standard" = 720p. Sound always.
  'sora-2': { resolution: null, audio: true },
  'sora-2-pro': { resolution: '720p', audio: true },
  'runway-gen-4.5': { resolution: null, audio: false },
  // kwaivgi/kling-v3-video: `mode` default "pro" ("'pro' generates 1080p").
  'kling-v3': { resolution: '1080p' },
  'kling-v2.5-turbo-pro': { resolution: null, audio: false },
  // bytedance/seedance-2.0-fast: generate_audio default true.
  'seedance-2.0-fast': { audio: true },
  'hailuo-2.3': { audio: false },
  // wan-video/wan-2.7-t2v and wan-2.5-i2v-fast: duration default 5.
  'wan-2.7-t2v': { seconds: 5, audio: false },
  'wan-2.5-i2v-fast': { seconds: 5, audio: false },
  'luma-ray-2-720p': { resolution: '720p', audio: false },
  'ltx-video': { seconds: 5, resolution: null, audio: false },
  // fal seedance-2.0: generate_audio default true (sent only when set).
  'seedance-2.0': { audio: true },
}

/** The seconds, resolution and sound a built payload carries (or the service's default for one it doesn't). */
function sentSettings(id: string, payload: Record<string, unknown>) {
  const def = SERVICE_DEFAULT[id] ?? {}
  const d = payload.duration
  const seconds = d === undefined ? def.seconds : (typeof d === 'number' ? d : Number.parseInt(String(d), 10))
  const r = payload.resolution
  const resolution = r === undefined ? def.resolution : String(r).toLowerCase()
  const a = payload.generate_audio
  const audio = a === undefined ? def.audio : a
  return { seconds, resolution, audio }
}

describe('settings parity: the price reads what the builder sends', () => {
  const builders: [string, { defaultDuration: number, build: (a: any) => Record<string, unknown> }, boolean][] = [
    ...Object.values(RUNNER_VIDEO_MODELS).map(d => [d.id, d, true] as [string, typeof d, boolean]),
    ...Object.values(RUNNER_REPLICATE_VIDEO_MODELS).map(d => [d.id, d, d.modes.includes('t2v')] as [string, typeof d, boolean]),
  ]

  it('covers every runner builder (control)', () => {
    expect(builders.map(b => b[0]).sort())
      .toEqual([...RUNNER_VIDEO_MODEL_IDS, ...RUNNER_REPLICATE_VIDEO_MODEL_IDS].sort())
  })

  for (const [id, desc, takesNoImage] of builders) {
    it(`${id}: every duration × resolution × sound × first frame`, () => {
      const cat = VIDEO_MODELS.find(m => m.id === id)!
      const durations: unknown[] = [...new Set([...cat.durations, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 30, 60])]
        .flatMap(n => [n, String(n)])
        .concat([undefined, '', 'eight', 7.6, '8s'])
      const resolutions: (string | undefined)[] = [...new Set([...(cat.resolutions ?? []), '480p', '720p', '768p', '1080p', '2k', '4K', undefined])]
      const sounds: unknown[] = [true, false, 'false', 0, undefined]
      const images: (string | null)[] = takesNoImage ? [null, 'https://x/first.png'] : ['https://x/first.png']
      let cases = 0
      const drift: string[] = []
      for (const dur of durations) {
        for (const res of resolutions) {
          for (const snd of sounds) {
            const adv: Record<string, unknown> = {}
            if (res !== undefined) adv.resolution = res
            if (snd !== undefined) adv.generate_audio = snd
            const modelOptions = JSON.stringify(adv)
            for (const image of images) {
              // As the runner's executor calls it: asInt(duration, desc.defaultDuration), parseJsonObject(model_options).
              const payload = desc.build({
                prompt: 'p', aspectRatio: '16:9', duration: asInt(dur, desc.defaultDuration), seed: 0,
                image, adv: parseJsonObject(modelOptions),
              })
              const want = sentSettings(id, payload)
              const got = effectiveVideoSettings(id, dur, '16:9', modelOptions)
              cases++
              if (JSON.stringify(got) !== JSON.stringify(want)) {
                drift.push(`${JSON.stringify({ dur, adv, image: !!image })}: sent ${JSON.stringify(want)}, priced ${JSON.stringify(got)}`)
              }
            }
          }
        }
      }
      expect(drift.slice(0, 5)).toEqual([])
      expect(cases).toBeGreaterThan(100)
    })
  }

  // Fabric has no runner builder. _b_fabric_1_0 (comfy_api_nodes/video_models.py:465-477)
  // sends only image, audio and `resolution` (default 720p); the clip is as long as
  // the sound, capped at 60 s by GenerateVideoNode (nodes_replicate.py:3974).
  it('fabric-1.0 follows the Python builder: resolution default 720p, length = the 60 s cap', () => {
    const REPO = fileURLToPath(new URL('../../../', import.meta.url))
    const py = readFileSync(`${REPO}comfy_api_nodes/video_models.py`, 'utf8')
    const body = py.slice(py.indexOf('def _b_fabric_1_0'), py.indexOf('def _b_pixverse_v6'))
    expect(body).toContain('"resolution": _opt_str(adv, "resolution", "720p")')
    expect(body).not.toMatch(/"duration"/)
    const node = readFileSync(`${REPO}comfy_api_nodes/nodes_replicate.py`, 'utf8')
    expect(node).toContain('audio_data_url = _audio_dict_to_wav_data_url(audio, max_seconds=60) if audio is not None else None')
    for (const dur of ['5', '10', 60, undefined]) {
      expect(effectiveVideoSettings('fabric-1.0', dur, '16:9', '{}')).toEqual({ seconds: 60, resolution: '720p', audio: true })
      expect(effectiveVideoSettings('fabric-1.0', dur, '16:9', '{"resolution":"480p"}')!.resolution).toBe('480p')
    }
  })

  it('model_options may arrive as JSON text or as the parsed object', () => {
    expect(effectiveVideoSettings('flux-3', '20', '16:9', { resolution: '1080p', generate_audio: false }))
      .toEqual(effectiveVideoSettings('flux-3', '20', '16:9', '{"resolution":"1080p","generate_audio":false}'))
  })
})

// ── Worked examples, one per unit type ──────────────────────────────────────
describe('worked examples', () => {
  const examples: { name: string, inputs: Record<string, unknown>, rate: number, seconds: number, usd: number, credits: number }[] = [
    // fal, per second, split by sound: $0.40/s with audio.
    { name: 'Veo 3.1, 8 s with sound', inputs: { model: 'veo-3.1', duration: '8', model_options: '{"generate_audio":true}' }, rate: 0.40, seconds: 8, usd: 3.20, credits: 480 },
    // Replicate, per second, split by sound; the builder sends no mode, so "pro" (1080p): $0.336/s with audio.
    { name: 'Kling 3.0, 15 s with sound', inputs: { model: 'kling-v3', duration: '15', model_options: '{"generate_audio":true}' }, rate: 0.336, seconds: 15, usd: 5.04, credits: 756 },
    // fal, per second by resolution: $0.3034/s at 720p.
    { name: 'Seedance 2.0, 15 s at 720p', inputs: { model: 'seedance-2.0', duration: '15', model_options: '{"resolution":"720p"}' }, rate: 0.3034, seconds: 15, usd: 4.551, credits: 683 },
    // fal, per second, one resolution: $0.08/s at 768p (list price after the promotion).
    { name: 'H3 Max, 5 s', inputs: { model: 'hailuo-h3-max', duration: '5', model_options: '{}' }, rate: 0.08, seconds: 5, usd: 0.40, credits: 60 },
    // fal, per second by resolution: $0.29/s at 1080p.
    { name: 'Flux 3, 20 s at 1080p', inputs: { model: 'flux-3', duration: '20', model_options: '{"resolution":"1080p"}' }, rate: 0.29, seconds: 20, usd: 5.80, credits: 870 },
  ]

  for (const ex of examples) {
    it(`${ex.name}: rate × seconds, through the markup`, () => {
      expect(providerUsd('GenerateVideoNode', ex.inputs)).toBeCloseTo(ex.usd, 9)
      expect(providerUsd('GenerateVideoNode', ex.inputs)).toBeCloseTo(ex.rate * ex.seconds, 9)
      expect(nodeCredits('GenerateVideoNode', ex.inputs)).toBe(creditsForUsd(ex.rate * ex.seconds))
      expect(nodeCredits('GenerateVideoNode', ex.inputs)).toBe(ex.credits)
    })

    it(`${ex.name}: badge = charge = run estimate, on both video classes`, () => {
      for (const ct of VIDEO_CLASSES) {
        const c = charge(ct, ex.inputs)
        expect(c, ct).toBe(ex.credits + 1)   // + base render
        expect(nodeCreditEstimate(ct, ex.inputs), ct).toBe(c)
        const names = Object.keys(ex.inputs)
        const est = estimateUsdForNodes([{
          id: '1', type: ct, widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => ex.inputs[n]),
        }], { hosted: true })!
        expect(est.hostedCredits, ct).toBe(c)
      }
    })
  }

  it('length, resolution and sound each move the price', () => {
    const base = { model: 'veo-3.1', duration: '4', model_options: '{}' }
    expect(providerUsd('GenerateVideoNode', base)).toBeCloseTo(1.60)
    expect(providerUsd('GenerateVideoNode', { ...base, duration: '8' })).toBeCloseTo(3.20)
    expect(providerUsd('GenerateVideoNode', { ...base, model_options: '{"generate_audio":false}' })).toBeCloseTo(0.80)
    expect(providerUsd('GenerateVideoNode', { ...base, model_options: '{"resolution":"4k"}' })).toBeCloseTo(2.40)
    // Veo rounds 5 s up to 6 s, and the price follows the rounding.
    expect(providerUsd('GenerateVideoNode', { ...base, duration: '5' })).toBeCloseTo(0.40 * 4)
    expect(providerUsd('GenerateVideoNode', { ...base, duration: '7' })).toBeCloseTo(0.40 * 6)
  })

  it('per-clip models: Hailuo 2.3 by resolution × length, LTX-Video flat', () => {
    expect(providerUsd('GenerateVideoNode', { model: 'hailuo-2.3', duration: '6' })).toBeCloseTo(0.28)
    expect(providerUsd('GenerateVideoNode', { model: 'hailuo-2.3', duration: '10' })).toBeCloseTo(0.56)
    expect(providerUsd('GenerateVideoNode', { model: 'hailuo-2.3', duration: '6', model_options: '{"resolution":"1080p"}' })).toBeCloseTo(0.49)
    // 1080p at 10 s has no clip price: the card's dearest second × 10.
    expect(providerUsd('GenerateVideoNode', { model: 'hailuo-2.3', duration: '10', model_options: '{"resolution":"1080p"}' })).toBeCloseTo(0.49 / 6 * 10, 6)
    expect(providerUsd('GenerateVideoNode', { model: 'ltx-video', duration: '5' })).toBeCloseTo(0.081)
  })

  it('a resolution the card has no price for is priced at the card\'s highest rate', () => {
    // Wan 2.5 I2V Fast's builder default "480p" has no tier on Replicate's page.
    expect(providerUsd('GenerateVideoNode', { model: 'wan-2.5-i2v-fast' })).toBeCloseTo(0.102 * 5)
    expect(providerUsd('GenerateVideoNode', { model: 'hailuo-h3-max', model_options: '{"resolution":"4k"}' })).toBeCloseTo(0.16 * 5)
  })

  it('legacy labels price at the model they run', () => {
    for (const [legacy, id] of Object.entries(LEGACY_VIDEO_MODEL_IDS)) {
      const inputs = { duration: '10', model_options: '{"resolution":"1080p"}' }
      expect(providerUsd('GenerateVideoNode', { ...inputs, model: legacy }), legacy).toBe(providerUsd('GenerateVideoNode', { ...inputs, model: id }))
    }
  })
})

// The line-up page's "where we lose money" table (24 Sep 2026), video rows.
// "It costs" is the service's price; our charge must now be at or above it.
describe('the line-up page\'s loss table: no video row is below cost', () => {
  const rows: { what: string, inputs: Record<string, unknown>, costs: number }[] = [
    { what: 'Lip-sync (Fabric), 60 s clip', inputs: { model: 'fabric-1.0' }, costs: 9.00 },
    { what: 'Flux 3 video, 20 s at 1080p', inputs: { model: 'flux-3', duration: '20', model_options: '{"resolution":"1080p"}' }, costs: 5.80 },
    { what: 'Seedance 2.0, 15 s at 720p', inputs: { model: 'seedance-2.0', duration: '15', model_options: '{"resolution":"720p"}' }, costs: 4.55 },
    // The page used the 720p "standard" rate; the builder gets "pro" (1080p), $5.04.
    { what: 'Kling 3.0, 15 s with sound', inputs: { model: 'kling-v3', duration: '15' }, costs: 3.78 },
    { what: 'Luma Ray 2, 9 s', inputs: { model: 'luma-ray-2-720p', duration: '9' }, costs: 1.62 },
    { what: 'Seedance 2.0 fast, 10 s', inputs: { model: 'seedance-2.0-fast', duration: '10' }, costs: 1.50 },
    { what: 'PixVerse v6, 8 s', inputs: { model: 'pixverse-v6', duration: '8' }, costs: 0.96 },
  ]
  for (const r of rows) {
    it(`${r.what}: charged at or above $${r.costs.toFixed(2)}`, () => {
      const usd = providerUsd('GenerateVideoNode', r.inputs)!
      expect(usd).toBeGreaterThanOrEqual(r.costs - 1e-9)
      expect(charge('GenerateVideoNode', r.inputs) / 100).toBeGreaterThanOrEqual(r.costs)
    })
  }
})

// ── P1 review minor 1: badge and charge see the same inputs ─────────────────
// A widget converted to a linked input: graphToPrompt sends a [nodeId, slot]
// reference in its place; the badge's map marks it linked the same way. Both
// price a linked setting at its most expensive.
describe('a linked pricing widget: badge = charge', () => {
  const OBJECT_INFO = {
    GenerateVideoNode: {
      input: {
        required: {
          model: ['COMBO', { options: VIDEO_MODELS.map(m => m.id) }],
          prompt: ['STRING', {}],
          aspect_ratio: ['COMBO', { options: ['16:9'] }],
          duration: ['COMBO', { options: ['5', '10', '15'] }],
          seed: ['INT', { control_after_generate: true }],
          model_options: ['STRING', {}],
        },
        optional: { image: ['IMAGE', {}] },
      },
    },
    IntInputNode: { input: { required: { value: ['INT', {}] } } },
    SaveImage: { input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', {}] } } },
  }
  // widgetDefs as getWidgetDefs builds them for that schema (seed gets its control slot).
  const WIDGET_DEFS = ['model', 'prompt', 'aspect_ratio', 'duration', 'seed', 'seed_control', 'model_options'].map(name => ({ name }))

  function workflow(linked: 'duration' | 'model_options') {
    const values = ['kling-v3', 'a shot', '16:9', '5', 0, 'fixed', '{"generate_audio":false}']
    const inputs = [{ name: 'image', type: 'IMAGE', link: null }, { name: linked, type: 'COMBO', link: 1, widget: { name: linked } }]
    return {
      values, inputs,
      wf: {
        nodes: [
          { id: 2, type: 'IntInputNode', mode: 0, widgets_values: [15], inputs: [], outputs: [{ name: 'INT', type: 'INT', links: [1] }] },
          { id: 3, type: 'GenerateVideoNode', mode: 0, widgets_values: values, inputs, outputs: [] },
          { id: 4, type: 'SaveImage', mode: 0, widgets_values: ['out'], inputs: [], outputs: [] },
        ],
        links: [[1, 2, 0, 3, 1, 'INT']],
      },
    }
  }

  for (const linked of ['duration', 'model_options'] as const) {
    it(`a linked ${linked}`, () => {
      const { wf, values, inputs } = workflow(linked)
      const prompt = graphToPrompt(wf as any, OBJECT_INFO)
      expect(Array.isArray(prompt['3']!.inputs[linked]), 'the charge sees a link reference').toBe(true)
      const chargeCredits = priceGraph(prompt as any).credits

      const names = linkedInputNames('3', inputs, [])
      expect(names).toEqual(['image', linked].filter(n => inputs.find(i => i.name === n)!.link != null))
      const badge = nodeCreditEstimate('GenerateVideoNode', widgetValueMap(WIDGET_DEFS, values, names))
      expect(badge).toBe(chargeCredits)
      const est = estimateUsdForNodes([{ id: '3', type: 'GenerateVideoNode', widgetDefs: WIDGET_DEFS, widgetsValues: values, linkedInputs: names }], { hosted: true })!
      expect(est.hostedCredits).toBe(chargeCredits)

      // …at the most expensive the link could turn out: 15 s, and for linked
      // options the card's dearest rate (4k, $0.42/s).
      const worst = linked === 'duration' ? 0.224 * 15 : 0.42 * 5
      expect(chargeCredits).toBe(creditsForUsd(worst) + 1)
    })
  }

  it('a live Vue Flow edge marks its input linked too', () => {
    const inputs = [{ name: 'image', link: null }, { name: 'duration', link: null }]
    expect(linkedInputNames('3', inputs, [{ target: '3', targetHandle: 'input-1' }, { target: '9', targetHandle: 'input-0' }]))
      .toEqual(['duration'])
    expect(maxVideoSeconds('kling-v3')).toBe(15)
  })
})

// ── P1 review minor 2: names on Object.prototype are not models ─────────────
describe('prototype names are refused, never priced at 0', () => {
  const names = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']
  it('on the video classes', () => {
    for (const ct of VIDEO_CLASSES) {
      for (const model of names) {
        expect('refused' in priceNode(ct, { model }), `${ct} ${model}`).toBe(true)
        expect(() => priceGraph({ 1: { class_type: ct, inputs: { model } }, 2: SINK }), `${ct} ${model}`).toThrow(UnpricedGraphError)
      }
    }
  })
  it('on the engine pickers and the image class', () => {
    for (const ct of ['UpscaleImageNode', 'EnhanceDetailNode', 'GenerateImageNode']) {
      for (const model of names) expect('refused' in priceNode(ct, { model }), `${ct} ${model}`).toBe(true)
    }
  })
  it('the rate card lookup reads own keys only', () => {
    for (const model of names) expect(videoRate(model)).toBeNull()
    expect(videoUsd('constructor', { seconds: 5, resolution: null, audio: true })).toBeNull()
  })
})

// ── P1 review minor 3: the pack's video clip goes through the shared price ──
describe('credit packs price their video clip through the shared calculation', () => {
  it('a clip is Seedance 2.0, 5 s at 720p, per second', () => {
    const clip = nodeCredits('GenerateVideoNode', PACK_VIDEO_CLIP)!
    expect(clip).toBe(creditsForUsd(0.3034 * 5))
    expect(clip).toBe(228)
    expect(PACKS.map(p => p.covers.match(/~(\d+) video clips/)![1])).toEqual(
      PACKS.map(p => String(Math.floor(p.credits / clip))))
  })
})

// ── P1 review minor 4: every MODEL_COSTS row follows the markup ─────────────
describe('MODEL_COSTS rows follow the markup', () => {
  // Rows allowed to differ, each with its reason.
  const FLOAT_NOISE = 'creditsForUsd ceils binary float noise one credit high (0.035 × 200 = 7.000000000000001); the row holds the exact policy figure'
  const ALLOWED: Record<string, string> = {
    'krea/krea-2-medium': FLOAT_NOISE,
    'fal-ai/flux-lora': FLOAT_NOISE,
    'fal-ai/flux-control-lora-depth': FLOAT_NOISE,
    'fal-ai/bytedance/seedream/v5/lite/edit': FLOAT_NOISE,
    'kwaivgi/kling-lip-sync': FLOAT_NOISE,
    'fal-ai/kling-video/v3/pro/image-to-video': FLOAT_NOISE,
    'meta/sam-2': 'retired from inpaint, kept for pricing history (hand-set 4 credits; the markup gives 5)',
    'ostris/flux-dev-lora-trainer': 'hardware-billed training: 600 credits keeps parity with LoraTrainingNode in the graph table',
    'ostris/sdxl-lora-trainer': 'hardware-billed training: 600 credits keeps parity with LoraTrainingNode in the graph table',
  }
  it('credits === creditsForUsd(usd) for every row with a usd, or the row is listed with a reason', () => {
    const off: string[] = []
    for (const [slug, row] of Object.entries(MODEL_COSTS)) {
      if (typeof row.usd !== 'number') continue
      const want = creditsForUsd(row.usd)
      if (row.credits !== want && !(slug in ALLOWED)) off.push(`${slug}: ${row.credits} credits for $${row.usd}, markup gives ${want}`)
    }
    expect(off).toEqual([])
  })
  it('every listed row still exists and still differs (the list does not rot)', () => {
    for (const slug of Object.keys(ALLOWED)) {
      const row = MODEL_COSTS[slug]
      expect(row, slug).toBeDefined()
      expect(row!.credits, slug).not.toBe(creditsForUsd(row!.usd!))
    }
  })
})

// ── The gallery label ───────────────────────────────────────────────────────
describe('the video gallery price label', () => {
  it('shows the per-second price at the default settings', () => {
    expect(videoRateLabel('hailuo-h3-max')).toBe('$0.08/s at 768p')
    expect(videoRateLabel('veo-3.1')).toBe('$0.40/s at 720p')
    expect(videoRateLabel('seedance-2.0')).toBe('$0.3034/s at 720p')
    expect(videoRateLabel('wan-2.5-i2v-fast')).toBe('$0.102/s at 480p')
    expect(videoRateLabel('runway-gen-4.5')).toBe('$0.12/s')
    expect(videoRateLabel('kling-v3')).toBe('$0.336/s at 1080p')
  })
  it('per-clip models show the clip price', () => {
    expect(videoRateLabel('hailuo-2.3')).toBe('$0.28 for 6 s at 768p')
    expect(videoRateLabel('ltx-video')).toBe('$0.081 a clip')
  })
  it('in hosted mode, credits per second of the default clip', () => {
    expect(videoRateLabel('hailuo-h3-max', { hosted: true })).toBe('12 credits/s at 768p')
    expect(videoRateLabel('veo-3.1', { hosted: true })).toBe('60 credits/s at 720p')
    // creditsForUsd(0.28) is 43, not 42: see the float-noise note on MODEL_COSTS below.
    expect(videoRateLabel('hailuo-2.3', { hosted: true })).toBe(`${creditsForUsd(0.28)} credits for 6 s at 768p`)
  })
  it('every catalogue model has a label, and the gallery no longer shows priceHint', () => {
    for (const m of VIDEO_MODELS) expect(videoRateLabel(m.id), m.id).toBeTruthy()
    const src = readFileSync(fileURLToPath(new URL('../../app/components/vue-canvas/VideoModelGalleryModal.vue', import.meta.url)), 'utf8')
    expect(src).not.toContain('priceHint')
    expect(src).toContain('videoRateLabel')
  })
})
