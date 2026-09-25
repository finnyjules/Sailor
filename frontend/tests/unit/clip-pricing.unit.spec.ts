/**
 * Task P5 (model line-up): the other video surfaces are priced per second.
 *
 *  - Frame Animate: the route sends clipRequest's request; runFal prices that
 *    request (shared/pricing/clipSettings.ts requestPrice) and the meter holds
 *    and charges it ahead of the endpoint's flat MODEL_COSTS row. The button
 *    prices the same request.
 *  - The older one-model video nodes (Veo 3, Kling 2.1, Seedance 2.0): their
 *    endpoint's per-second rate × the seconds their Python `execute` sends.
 *  - Lip-sync: the longest clip the call can make (ruling on open question 1),
 *    the badge equal to the charge.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runFal } from '~~/server/utils/falRun'
import {
  __resetMeterContextForTests, __setLedgerForTests, __setSpendGuardForTests, bindMeterContext, preflightMeter, resolveCredits,
} from '~~/server/utils/requestMeter'
import { __setModerationFetchForTests } from '~~/server/utils/moderation'
import { GRAPH_NODE_CREDITS, MODEL_COSTS, PROVIDER_NODE_CLASSES, priceGraph } from '~~/server/utils/priceBook'
import { CLIP_RATES, clipRate, clipUsd } from '#shared/pricing/clipRates'
import {
  KLING_LIPSYNC_MAX_SECONDS, LIPSYNC_MAX_SECONDS, REMOTE_VIDEO_NODE_CLASSES, REQUEST_PRICED_ENDPOINTS,
  remoteVideoCalls, requestPrice, requestSettings,
} from '#shared/pricing/clipSettings'
import { creditsForUsd } from '#shared/pricing/markup'
import { SHARED_PRICED_CLASS_SET, priceNode } from '#shared/pricing/nodePrice'
import { CLIP_MODELS, clipModel, clipModelLabel, clipPriceCredits, clipPriceLabel, clipPriceUsd, clipRequest, clipSeconds } from '~/data/clip-models'
import { MODEL_PRICED_BADGE_CLASSES, nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes } from '~/lib/costEstimate'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const PY = readFileSync(`${REPO}comfy_api_nodes/nodes_replicate.py`, 'utf8')
const ROUTE = readFileSync(`${REPO}frontend/server/api/frame/animate.post.ts`, 'utf8')

const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]
/** What priceGraph charges for one node plus an output node (1 credit base render). */
const charge = (ct: string, inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: ct, inputs }, 2: SINK }).credits
/** Float noise off a hand-computed dollar figure. */
const usd = (n: number) => Math.round(n * 1e6) / 1e6

/** The body of a Python class's `execute`, from its `class X(` line to the next top-level class/def. */
function pyClass(name: string): string {
  const start = PY.indexOf(`class ${name}(IO.ComfyNode):`)
  if (start < 0) throw new Error(`${name} moved`)
  const rest = PY.slice(start + 10)
  const end = rest.search(/\n(?:class |def |async def |# ====)/)
  return PY.slice(start, start + 10 + (end < 0 ? rest.length : end))
}
/** A Combo's option list in a class body: `IO.Combo.Input("name", options=[...]`. */
function comboOptions(body: string, name: string): string[] {
  const m = new RegExp(`IO\\.Combo\\.Input\\(\\s*"${name}",\\s*options=(\\[[^\\]]*\\]|_[A-Z0-9_]+)`).exec(body)
  if (!m) throw new Error(`${name} combo moved`)
  const list = m[1]!.startsWith('[') ? m[1]! : new RegExp(`${m[1]}\\s*=\\s*(\\[[^\\]]*\\])`).exec(PY)![1]!
  return [...list.matchAll(/"([^"]+)"/g)].map(x => x[1]!)
}

// ── Rate cards ────────────────────────────────────────────────────────────

describe('clip rate cards', () => {
  it('every card is per second, verified, sourced and dated, with figures above zero', () => {
    expect(Object.keys(CLIP_RATES).length).toBe(11)
    for (const [endpoint, r] of Object.entries(CLIP_RATES)) {
      expect(r.unit, endpoint).toBe('per_second')
      expect(r.confidence, endpoint).toBe('verified')
      expect(r.read, endpoint).toBe('2026-09-24')
      expect(r.source, endpoint).toMatch(r.service === 'fal' ? /^https:\/\/fal\.ai\/models\/.+\/llms\.txt$/ : /^https:\/\/replicate\.com\//)
      expect(r.source, endpoint).toContain(endpoint)
      for (const p of Object.values(r.byResolution)) {
        for (const v of typeof p === 'number' ? [p] : [p.audio, p.silent]) expect(v, endpoint).toBeGreaterThan(0)
      }
    }
  })
  it('every endpoint a request or a node can reach has a card', () => {
    for (const e of REQUEST_PRICED_ENDPOINTS) expect(clipRate(e), e).not.toBeNull()
    const reached = new Set<string>()
    for (const ct of REMOTE_VIDEO_NODE_CLASSES) {
      for (const inputs of [{}, { engine: 'sync' }, { engine: 'fabric' }]) for (const c of remoteVideoCalls(ct, inputs)!) reached.add(c.endpoint)
    }
    for (const e of reached) expect(clipRate(e), e).not.toBeNull()
    expect([...reached].sort()).toEqual(['bytedance/seedance-2.0', 'google/veo-3', 'kwaivgi/kling-lip-sync', 'kwaivgi/kling-v2.1', 'sync/lipsync-2-pro', 'veed/fabric-1.0'])
  })
  it('prototype names are not endpoints', () => {
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(clipRate(k)).toBeNull()
      expect(requestPrice(k, { duration: 5 })).toBeNull()
    }
  })
  it('an unlisted resolution is priced at the card’s highest rate', () => {
    expect(clipUsd('bytedance/seedance-2.0', { seconds: 5, resolution: '1080P', audio: true })).toBe(5)       // 4k $1.00
    expect(clipUsd('veed/fabric-1.0', { seconds: 60, resolution: '1080p', audio: false })).toBe(9)            // 720p $0.15
  })
})

// ── Frame Animate ─────────────────────────────────────────────────────────

/** What each Animate model sends, by hand from the endpoint's llms.txt: resolution key, sound, $/s. */
const ANIMATE_EXPECT: Record<string, { endpoint: string, resolution: string | null, audio: boolean, perSecond: number }> = {
  'seedance-2.0': { endpoint: 'bytedance/seedance-2.0/image-to-video', resolution: '720p', audio: true, perSecond: 0.3034 },
  'hailuo-h3': { endpoint: 'minimax/h3/image-to-video', resolution: '768p', audio: true, perSecond: 0.06 },
  'hailuo-h3-max': { endpoint: 'minimax/h3-max/image-to-video', resolution: '768p', audio: true, perSecond: 0.08 },
  'kling-v3-pro': { endpoint: 'fal-ai/kling-video/v3/pro/image-to-video', resolution: null, audio: false, perSecond: 0.112 },
  'flux-3-draft': { endpoint: 'blackforestlabs/flux-3/first-last-frame-to-video/draft', resolution: '720p', audio: true, perSecond: 0.06 },
}

describe('Frame Animate: the request sent is the request priced', () => {
  it('the route sends clipRequest’s request through runFal and nothing else', () => {
    expect(ROUTE).toContain('clipRequest(spec.id, seconds, fullPrompt, stillUrl)')
    expect(ROUTE).toContain('runFal(req.endpoint, req.input')
    expect(ROUTE.match(/runFal\(/g)!.length).toBe(1)
    expect(ROUTE).toContain('const seconds = clipSeconds(spec, body.seconds)')
    expect(ROUTE).not.toMatch(/setMeterPriceHint|preflightMeter/)
  })
  it('each model × length: the settings billed are the length and resolution sent', () => {
    for (const m of CLIP_MODELS) {
      const want = ANIMATE_EXPECT[m.id]!
      for (const s of m.durations) {
        const req = clipRequest(m.id, s, 'p', 'https://still')
        expect(req.endpoint, m.id).toBe(want.endpoint)
        const sent = requestSettings(req.endpoint, req.input)!
        expect(sent, `${m.id} ${s}`).toEqual({ endpoint: want.endpoint, seconds: s, resolution: want.resolution, audio: want.audio })
        // The payload itself carries the length (text or integer, as the endpoint's schema asks).
        expect(Number(req.input.duration), `${m.id} ${s}`).toBe(s)
      }
    }
  })
  it('each model × length: shown price = rate × seconds, marked up, in credits', () => {
    for (const m of CLIP_MODELS) {
      for (const s of m.durations) {
        const want = usd(ANIMATE_EXPECT[m.id]!.perSecond * s)
        expect(clipPriceUsd(m.id, s), `${m.id} ${s}`).toBe(want)
        expect(clipPriceCredits(m.id, s), `${m.id} ${s}`).toBe(creditsForUsd(want))
        expect(clipPriceLabel(m.id, s)).toBe(`${creditsForUsd(want)} credits`)
      }
    }
  })
  it('worked examples', () => {
    expect(clipPriceCredits('seedance-2.0', 5)).toBe(228)     // $1.517 × 1.5
    expect(clipPriceCredits('seedance-2.0', 12)).toBe(547)    // $3.6408
    expect(clipPriceCredits('hailuo-h3', 5)).toBe(45)         // $0.30
    expect(clipPriceCredits('hailuo-h3-max', 15)).toBe(180)   // $1.20
    expect(clipPriceCredits('kling-v3-pro', 3)).toBe(51)      // $0.336
    expect(clipPriceCredits('flux-3-draft', 5)).toBe(45)      // $0.30
    expect(clipPriceCredits('flux-3-draft', 15)).toBe(135)    // $0.90
  })
  it('a length the model does not offer is priced at the default the route falls back to', () => {
    const m = clipModel('hailuo-h3')!
    expect(clipSeconds(m, 7)).toBe(5)
    expect(clipSeconds(m, '10')).toBe(10)
    expect(clipPriceCredits('hailuo-h3', 7)).toBe(clipPriceCredits('hailuo-h3', 5))
    expect(clipPriceCredits('nope', 5)).toBeNull()
  })
  it('the dropdown quotes the price at the length the model would run with', () => {
    expect(CLIP_MODELS.map(m => clipModelLabel(m))).toEqual([
      'Seedance 2.0 (720p · 228 credits)', 'Hailuo H3 (768p · 45 credits)', 'Hailuo H3 Max (768p · 60 credits)',
      'Kling 3.0 Pro (1080p · 84 credits)', 'FLUX 3 draft (720p · 45 credits)',
    ])
    // 12 s picked on Seedance: models without a 12 s clip quote their default.
    expect(CLIP_MODELS.map(m => clipModelLabel(m, 12))).toEqual([
      'Seedance 2.0 (720p · 547 credits)', 'Hailuo H3 (768p · 45 credits)', 'Hailuo H3 Max (768p · 144 credits)',
      'Kling 3.0 Pro (1080p · 84 credits)', 'FLUX 3 draft (720p · 45 credits)',
    ])
  })
  it('odd request values are priced at the service’s longest clip / dearest setting', () => {
    const e = 'bytedance/seedance-2.0/image-to-video'
    expect(requestSettings(e, {})!.seconds).toBe(15)                         // "auto": the model picks, up to 15
    expect(requestSettings(e, { duration: 'auto' })!.seconds).toBe(15)
    expect(requestSettings(e, { duration: '99' })!.seconds).toBe(15)
    expect(requestSettings(e, { duration: 7.5 })!.seconds).toBe(15)
    expect(requestSettings('minimax/h3/image-to-video', {})!).toMatchObject({ seconds: 5, resolution: '2k' })   // schema defaults
    expect(requestSettings('minimax/h3/image-to-video', { resolution: 7 })!.resolution).toBe('(unlisted)')
    expect(requestPrice('minimax/h3/image-to-video', { duration: 5, resolution: 7 })!.usd).toBe(0.8)         // 4K $0.16
    expect(requestSettings('fal-ai/kling-video/v3/pro/image-to-video', { duration: '5' })!.audio).toBe(true) // default sound on
    expect(requestSettings('fal-ai/kling-video/v3/pro/image-to-video', { duration: '5', generate_audio: 'no' })!.audio).toBe(true)
    expect(requestPrice('fal-ai/flux/dev', { duration: 5 })).toBeNull()                                      // not per second: its row
  })
  it('the MODEL_COSTS rows are ceilings at the longest Animate clip, never below any Animate price', () => {
    for (const m of CLIP_MODELS) {
      const row = MODEL_COSTS[ANIMATE_EXPECT[m.id]!.endpoint]!
      const top = Math.max(...m.durations.map(s => clipPriceCredits(m.id, s)!))
      expect(row.credits, m.id).toBe(top)
      expect(row.credits, m.id).toBe(creditsForUsd(row.usd))
      expect(row.confidence, m.id).toBe('verified')
    }
  })
})

// ── The meter: a per-request price wins over the flat row ─────────────────

type Ledger = { hold: ReturnType<typeof vi.fn>, settleHold: ReturnType<typeof vi.fn>, releaseHold: ReturnType<typeof vi.fn>, getAvailable: ReturnType<typeof vi.fn>, debit: ReturnType<typeof vi.fn> }
function fakeLedger(): Ledger {
  let seq = 0
  return {
    getAvailable: vi.fn(async () => 100_000),
    hold: vi.fn(async () => ({ ok: true as const, holdId: ++seq })),
    settleHold: vi.fn(async () => ({ ok: true as const, balance: 0, settled: true })),
    releaseHold: vi.fn(async () => {}),
    debit: vi.fn(async () => ({ ok: true })),
  }
}
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), statusText: 'OK' })
function falFetch(app: string) {
  const base = `https://queue.fal.run/${app}`
  return vi.fn(async (url: string) => {
    if (url === base) return json({ request_id: 'r1', status_url: `${base}/requests/r1/status`, response_url: `${base}/requests/r1` })
    if (url === `${base}/requests/r1/status`) return json({ status: 'COMPLETED' })
    if (url === `${base}/requests/r1`) return json({ video: { url: 'https://out.mp4' } })
    throw new Error('unexpected fetch ' + url)
  })
}

describe('the meter holds and charges the request’s own price', () => {
  const CLERK = 'NUXT_CLERK_SECRET_KEY'
  const saved = { clerk: process.env[CLERK], fal: process.env.FAL_KEY, openai: process.env.OPENAI_API_KEY }
  let ledger: Ledger
  beforeEach(() => {
    __resetMeterContextForTests()
    ledger = fakeLedger()
    __setLedgerForTests(ledger as any)
    __setSpendGuardForTests(async () => {})
    process.env[CLERK] = 'sk_test_hosted'
    process.env.FAL_KEY = 'test-fal-key'
    delete process.env.OPENAI_API_KEY
    __setModerationFetchForTests(null)
  })
  afterEach(() => {
    for (const [k, v] of [[CLERK, saved.clerk], ['FAL_KEY', saved.fal], ['OPENAI_API_KEY', saved.openai]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    __setLedgerForTests(null)
    __setSpendGuardForTests(null)
    __resetMeterContextForTests()
    vi.unstubAllGlobals()
  })

  it('resolveCredits: a per-request price wins over the flat row; a bad one is ignored', () => {
    const e = 'bytedance/seedance-2.0/image-to-video'
    expect(resolveCredits(e)).toBe(MODEL_COSTS[e]!.credits)
    expect(resolveCredits(e, undefined, 182)).toBe(182)
    expect(resolveCredits(e, 5, 182)).toBe(182)
    for (const bad of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(resolveCredits(e, undefined, bad)).toBe(MODEL_COSTS[e]!.credits)
    // A per-request price also prices an endpoint with no row at all.
    expect(resolveCredits('someorg/unbooked', undefined, 12)).toBe(12)
    expect(resolveCredits('someorg/unbooked')).toBeNull()
  })

  it('preflightMeter holds the per-request price, and settle charges it, not the flat row', async () => {
    bindMeterContext({ userId: 'u1' })   // per test: the meter context does not cross a beforeEach
    const e = 'minimax/h3-max/image-to-video'
    const t = await preflightMeter(e, { credits: 60 })
    expect(MODEL_COSTS[e]!.credits).not.toBe(60)
    expect(ledger.hold).toHaveBeenCalledWith('u1', 60, expect.stringMatching(/^meter:/))
    await t!.settle('job')
    expect(ledger.settleHold).toHaveBeenCalledWith(1, 60, `provider:${e}`)
  })

  it('every Animate model × length: runFal holds = settles = the price the button shows', async () => {
    bindMeterContext({ userId: 'u1' })   // per test: the meter context does not cross a beforeEach
    for (const m of CLIP_MODELS) {
      for (const s of m.durations) {
        ledger.hold.mockClear(); ledger.settleHold.mockClear()
        const req = clipRequest(m.id, s, 'a cat', 'https://still')
        vi.stubGlobal('fetch', falFetch(req.endpoint))
        await runFal(req.endpoint, req.input, { pollIntervalMs: 1 })
        const shown = clipPriceCredits(m.id, s)
        expect(ledger.hold.mock.calls[0]![1], `${m.id} ${s} hold`).toBe(shown)
        expect(ledger.settleHold.mock.calls[0]![1], `${m.id} ${s} charge`).toBe(shown)
      }
    }
  })

  it('the precedence case: a 4 s Seedance clip is never charged the flat row', async () => {
    bindMeterContext({ userId: 'u1' })   // per test: the meter context does not cross a beforeEach
    const req = clipRequest('seedance-2.0', 4, 'x', 'https://still')
    vi.stubGlobal('fetch', falFetch(req.endpoint))
    await runFal(req.endpoint, req.input, { pollIntervalMs: 1 })
    expect(MODEL_COSTS[req.endpoint]!.credits).toBe(547)
    expect(ledger.hold.mock.calls[0]![1]).toBe(183)          // 4 × $0.3034 = $1.2136 × 1.5
    expect(ledger.settleHold.mock.calls[0]![1]).toBe(183)
  })

  it('an endpoint with no per-second card still holds its flat row', async () => {
    bindMeterContext({ userId: 'u1' })   // per test: the meter context does not cross a beforeEach
    vi.stubGlobal('fetch', falFetch('fal-ai/flux/dev'))
    await runFal('fal-ai/flux/dev', { prompt: 'x' }, { pollIntervalMs: 1 })
    expect(ledger.hold.mock.calls[0]![1]).toBe(MODEL_COSTS['fal-ai/flux/dev']!.credits)
  })
})

// ── The older one-model video nodes ───────────────────────────────────────

describe('older video nodes: priced on what Python sends', () => {
  it('the Python builders read as the price assumes', () => {
    const veo = pyClass('Veo3RemoteNode')
    expect(veo).toContain('"google/veo-3"')
    expect(veo).not.toMatch(/"duration"|"generate_audio"|"resolution"/)          // schema defaults: 8 s, sound on
    const kling = pyClass('KlingVideoRemoteNode')
    expect(kling).toContain('"kwaivgi/kling-v2.1"')
    expect(kling).toContain('"duration": int(duration)')
    expect(kling).not.toMatch(/"mode"/)                                          // schema default: standard, 720p
    expect(comboOptions(kling, 'duration')).toEqual(['5', '10'])
    const sd = pyClass('Seedance2RemoteNode')
    expect(sd).toContain('"bytedance/seedance-2.0"')
    expect(sd).toContain('"duration": int(duration)')
    expect(sd).toContain('"resolution": resolution')
    expect(sd).not.toMatch(/"video"|"reference_video/)                           // no video in: the non_video_in tiers
    expect(comboOptions(sd, 'duration')).toEqual(['5', '10'])
    expect(comboOptions(sd, 'resolution')).toEqual(['480p', '720p', '1080p'])
  })

  const DURATIONS: unknown[] = ['5', '10', 5, 10, ' 10 ', '15', '7', '-1', '0', 'x', '', 7.9, null, undefined, LINK]
  const SEC = (v: unknown, max: number): number => {
    const n = typeof v === 'number' ? Math.trunc(v) : typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number.parseInt(v, 10) : Number.NaN
    return n >= 1 && n <= max ? n : max
  }

  it('Veo 3: 8 s with sound at $0.40/s, whatever else is set', () => {
    for (const inputs of [{}, { aspect_ratio: '9:16', seed: 3 }, { image: LINK }]) {
      expect(priceNode('Veo3RemoteNode', inputs)).toEqual({ usd: 3.2, credits: 480 })
      expect(charge('Veo3RemoteNode', inputs)).toBe(481)
    }
  })
  it('Kling 2.1: int(duration) × $0.05/s (standard, 720p); unreadable or out of range → 10 s', () => {
    for (const d of DURATIONS) {
      const want = usd(SEC(d, 10) * 0.05)
      expect(priceNode('KlingVideoRemoteNode', { duration: d }), String(d)).toEqual({ usd: want, credits: creditsForUsd(want) })
    }
    expect(priceNode('KlingVideoRemoteNode', { duration: '5' })).toEqual({ usd: 0.25, credits: 38 })
    expect(priceNode('KlingVideoRemoteNode', { duration: '10' })).toEqual({ usd: 0.5, credits: 75 })
  })
  it('Seedance 2.0 (Replicate): int(duration) × the resolution’s rate; unlisted or linked → 4k', () => {
    const RATE: Record<string, number> = { '480p': 0.08, '720p': 0.18, '1080p': 0.45, '4k': 1 }
    for (const d of DURATIONS) {
      for (const r of ['480p', '720p', '1080p', '4k', '1080P', '', 7, undefined, LINK]) {
        const rate = typeof r === 'string' && r in RATE ? RATE[r]! : 1
        const want = usd(SEC(d, 15) * rate)
        expect(priceNode('Seedance2RemoteNode', { duration: d, resolution: r }), `${String(d)} ${String(r)}`).toEqual({ usd: want, credits: creditsForUsd(want) })
      }
    }
    expect(priceNode('Seedance2RemoteNode', { duration: '5', resolution: '1080p' })).toEqual({ usd: 2.25, credits: 338 })   // the node's defaults
  })
})

// ── Lip-sync ──────────────────────────────────────────────────────────────

describe('lip-sync: the longest clip the call can make', () => {
  it('every lip-sync node caps the sound clip at 60 s (the length the price assumes)', () => {
    for (const ct of ['LipsyncRemoteNode', 'LipsyncNode', 'LipSyncNode']) expect(pyClass(ct), ct).toContain('_audio_dict_to_wav_data_url(audio, max_seconds=60)')
    expect(PY).toContain('# 60s cap matches Fabric\'s max output length')
    expect(LIPSYNC_MAX_SECONDS).toBe(60)
    expect(KLING_LIPSYNC_MAX_SECONDS).toBe(10)
    expect(pyClass('LipsyncRemoteNode')).toContain('"sync/lipsync-2-pro"')
    expect(pyClass('LipsyncNode')).toContain('"sync/lipsync-2-pro"')
    // LipSyncNode's engine choice and the two endpoints.
    expect(PY).toContain('return "sync" if has_video else "fabric"')
    expect(PY).toContain('return "kwaivgi/kling-lip-sync", {"video_url": video, "audio_file": audio}')
    expect(PY).toContain('return "veed/fabric-1.0", {"image": image, "audio": audio, "resolution": resolution}')
    const ls = pyClass('LipSyncNode')
    expect(ls).toContain('resolution = opts.get("resolution", resolution)')
    expect(ls).toContain('engine = opts.get("engine", engine)')
    expect(ls).toContain('video_src = opts.get("face_video")')
    expect(comboOptions(ls, 'engine')).toEqual(['auto', 'fabric', 'sync'])
    expect(comboOptions(ls, 'resolution')).toEqual(['480p', '720p', '1080p'])
  })

  it('sync.so 2-pro nodes: 60 s × $0.08325', () => {
    for (const ct of ['LipsyncRemoteNode', 'LipsyncNode']) {
      for (const inputs of [{}, { sync_mode: 'loop', model: 'sync.so 2-pro' }, { audio: LINK }]) {
        expect(priceNode(ct, inputs), ct).toEqual({ usd: 4.995, credits: 750 })
      }
    }
  })

  const FABRIC_720 = { usd: 9, credits: 1350 }
  const FABRIC_480 = { usd: 4.8, credits: 720 }
  const KLING = { usd: 0.14, credits: 21 }
  const mo = (o: Record<string, unknown>) => JSON.stringify(o)
  const CASES: Array<[string, Record<string, unknown>, { usd: number, credits: number }]> = [
    ['defaults: auto, 720p, no video → Fabric 720p', {}, FABRIC_720],
    ['auto, 480p → Fabric 480p', { engine: 'auto', resolution: '480p' }, FABRIC_480],
    ['auto, 1080p (not on the schema) → Fabric at the top rate', { resolution: '1080p' }, FABRIC_720],
    ['explicit fabric', { engine: 'fabric', resolution: '480p' }, FABRIC_480],
    ['explicit sync → Kling lip-sync 10 s', { engine: 'sync' }, KLING],
    ['auto with a face video → sync', { engine: 'auto', model_options: mo({ face_video: 'v.mp4', audio: 'a.mp3' }) }, KLING],
    ['auto with an image AND a video → sync (the video wins)', { model_options: mo({ face_image: 'f.png', face_video: 'v.mp4' }) }, KLING],
    ['auto with an empty face video → fabric', { model_options: mo({ face_video: '' }) }, FABRIC_720],
    ['options engine overrides the widget', { engine: 'sync', model_options: mo({ engine: 'fabric', resolution: '480p' }) }, FABRIC_480],
    ['options resolution overrides the widget', { resolution: '480p', model_options: mo({ resolution: '720p' }) }, FABRIC_720],
    ['options resolution null → sent as None → top rate', { resolution: '480p', model_options: mo({ resolution: null }) }, FABRIC_720],
    ['an unknown engine is auto', { engine: 'wav2lip', resolution: '480p' }, FABRIC_480],
    ['broken options JSON → {}', { resolution: '480p', model_options: '{nope' }, FABRIC_480],
    ['options not an object → {}', { resolution: '480p', model_options: '[1]' }, FABRIC_480],
    ['linked model_options → the dearer engine', { resolution: '480p', model_options: LINK }, FABRIC_720],
    ['linked engine → the dearer engine at the resolution', { engine: LINK, resolution: '480p' }, FABRIC_480],
    ['linked resolution → Fabric’s top rate', { resolution: LINK }, FABRIC_720],
    ['linked resolution on sync → Kling', { engine: 'sync', resolution: LINK }, KLING],
  ]
  for (const [name, inputs, want] of CASES) {
    it(`LipSyncNode: ${name}`, () => {
      expect(priceNode('LipSyncNode', inputs)).toEqual(want)
      expect(charge('LipSyncNode', inputs)).toBe(want.credits + 1)
    })
  }
})

// ── One price: badge = estimate = charge, and the tables ──────────────────

describe('badge, run estimate and charge agree for every node priced here', () => {
  const GRID: Record<string, Array<Record<string, unknown>>> = {
    Veo3RemoteNode: [{ aspect_ratio: '16:9' }],
    KlingVideoRemoteNode: ['5', '10', LINK].map(duration => ({ duration })),
    Seedance2RemoteNode: ['480p', '720p', '1080p', LINK].flatMap(resolution => ['5', '10', LINK].map(duration => ({ resolution, duration }))),
    LipsyncRemoteNode: [{ sync_mode: 'cut_off' }],
    LipsyncNode: [{ model: 'sync.so 2-pro' }],
    LipSyncNode: ['auto', 'fabric', 'sync', LINK].flatMap(engine => ['480p', '720p', '1080p', LINK].map(resolution => ({ engine, resolution, model_options: '{}' }))),
  }
  it('the classes have left the flat table and are in the badge set', () => {
    for (const ct of REMOTE_VIDEO_NODE_CLASSES) {
      expect(GRAPH_NODE_CREDITS[ct], ct).toBeUndefined()
      expect(SHARED_PRICED_CLASS_SET.has(ct), ct).toBe(true)
      expect(MODEL_PRICED_BADGE_CLASSES.has(ct), ct).toBe(true)
      expect(PROVIDER_NODE_CLASSES, ct).toContain(ct)
    }
    expect(Object.keys(GRID).sort()).toEqual([...REMOTE_VIDEO_NODE_CLASSES].sort())
    expect(GRAPH_NODE_CREDITS.EnhanceVideoNode).toBe(150)   // unchanged: no longest clip to charge (see priceBook.ts)
  })
  for (const [ct, grid] of Object.entries(GRID)) {
    it(`${ct}: nodeCreditEstimate and the hosted run estimate equal priceGraph`, () => {
      for (const inputs of grid) {
        const want = charge(ct, inputs)
        expect(nodeCreditEstimate(ct, inputs), JSON.stringify(inputs)).toBe(want)
        const names = Object.keys(inputs).filter(k => !Array.isArray(inputs[k]))
        const linkedNames = Object.keys(inputs).filter(k => Array.isArray(inputs[k]))
        const est = estimateUsdForNodes([{
          id: '1', type: ct, widgetDefs: [...names, ...linkedNames].map(name => ({ name })),
          widgetsValues: [...names.map(k => inputs[k]), ...linkedNames.map(() => 'x')], linkedInputs: linkedNames,
        } as any], { hosted: true })
        expect(est?.hostedCredits, JSON.stringify(inputs)).toBe(want)
      }
    })
  }
})

describe('loss table: every call is charged at or above what it costs', () => {
  it('Animate, the older nodes and lip-sync at their dearest settings', () => {
    const rows: Array<[string, number, number]> = [
      ['Animate Seedance 12 s', clipPriceCredits('seedance-2.0', 12)!, 12 * 0.3034],
      ['Animate H3 Max 15 s (list price)', clipPriceCredits('hailuo-h3-max', 15)!, 15 * 0.08],
      ['Animate Kling 10 s', clipPriceCredits('kling-v3-pro', 10)!, 10 * 0.112],
      ['Animate FLUX 3 draft 15 s', clipPriceCredits('flux-3-draft', 15)!, 15 * 0.06],
      ['Veo 3 8 s with sound', (priceNode('Veo3RemoteNode', {}) as any).credits, 8 * 0.4],
      ['Kling 2.1 10 s', (priceNode('KlingVideoRemoteNode', { duration: '10' }) as any).credits, 10 * 0.05],
      ['Seedance 2.0 10 s 1080p', (priceNode('Seedance2RemoteNode', { duration: '10', resolution: '1080p' }) as any).credits, 10 * 0.45],
      ['Fabric 60 s 720p', (priceNode('LipSyncNode', {}) as any).credits, 60 * 0.15],
      ['sync.so 2-pro 60 s', (priceNode('LipsyncNode', {}) as any).credits, 60 * 0.08325],
      ['Kling lip-sync 10 s', (priceNode('LipSyncNode', { engine: 'sync' }) as any).credits, 10 * 0.014],
    ]
    for (const [name, credits, cost] of rows) expect(credits / 100, name).toBeGreaterThanOrEqual(cost)
  })
})
