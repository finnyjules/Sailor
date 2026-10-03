/**
 * Stage 5 security review C1: ComfyUI mirrors EVERY route under `/api/`
 * (server.py registers both `path` and `"/api" + path`), and comfyui-proxy
 * strips a leading `/comfyui` before proxying. So every hosted tenant gate
 * added in Task 5 — metered /prompt, the /queue filter, the /interrupt
 * ownership check, the /history + /view Nitro routes — had an alias form
 * that walked straight past it into the raw proxy:
 *
 *   /api/prompt        → UNMETERED graph runs
 *   /api/queue         → every tenant's queue
 *   /api/interrupt     → cancel anyone's run
 *   /api/history       → every tenant's prompts + output filenames
 *   /api/view          → every tenant's pixels
 *   /comfyui/<same>    → same, via the /comfyui base SettingsModal uses
 *   /comfyui/api/queue → both aliases stacked
 *   /comfyui/internal/files/output → filename enumeration oracle
 *
 * These tests drive the REAL middleware (default export of
 * server/middleware/comfyui-proxy.ts) with fake events, so they fail against
 * the pre-fix tree rather than merely asserting a new helper's return value.
 *
 * Local mode is the other half of the contract: normalization runs but every
 * decision must still fall through to the raw proxy with a byte-identical
 * target, so a local install is untouched by any of this.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The cached engine-health check (server/native/engineHealth.ts) is stubbed:
// its 3 s process-wide cache would otherwise carry one test's engine state
// into the next, and a real probe would reach whatever is on :8188. 'up'
// (the default) defers to each test's own fetch stub, as before the check.
const engineHealthState = vi.hoisted(() => ({ value: 'up' as 'up' | 'down' }))
vi.mock('../../server/native/engineHealth', async orig => ({
  ...(await orig() as object),
  engineHealth: async () => engineHealthState.value,
}))
beforeEach(() => { engineHealthState.value = 'up' })

// Nitro auto-imports used at module scope / inside the handler.
const g = globalThis as any
g.defineEventHandler = (fn: any) => fn
g.createError = (opts: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(opts.message ?? opts.statusMessage) as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
}
const proxyRequest = vi.fn(async (_event: any, url: string, _opts?: any) => ({ proxiedTo: url }))
g.proxyRequest = proxyRequest

let mode: 'local' | 'hosted' = 'local'
// Stage 6 Task 8 — the per-user settings/userdata switch. OFF by default here,
// so settings/userdata decide as userScoped but the middleware refuses them 403
// (the shipping default); the dedicated block below flips it on.
let multiUser = false
vi.mock('../../server/utils/deployMode', () => ({
  deployMode: () => mode,
  isHosted: () => mode === 'hosted',
  engineMultiUser: () => multiUser,
}))

const handleMeteredPrompt = vi.fn(async () => ({ handler: 'metered' }))
vi.mock('../../server/utils/meterGraphRun', () => ({
  isPromptPath: (p: string) => p === '/prompt' || p.startsWith('/prompt?'),
  handleMeteredPrompt: (...a: any[]) => handleMeteredPrompt(...(a as [])),
}))

const handleHostedQueueGet = vi.fn(async () => ({ handler: 'queue' }))
const handleHostedInterrupt = vi.fn(async () => ({ handler: 'interrupt' }))
const handleHostedObjectInfo = vi.fn(async () => ({ handler: 'objectInfo' }))
const handleHostedUpload = vi.fn(async () => ({ handler: 'upload' }))
const handleHostedSailor = vi.fn(async () => ({ handler: 'sailorProjects' }))
const handleHostedSailorData = vi.fn(async () => ({ handler: 'sailorData' }))
const handleHostedOutputListing = vi.fn(async () => ({ handler: 'outputListing' }))
const handleHostedUserScoped = vi.fn(async () => ({ handler: 'userScoped' }))
vi.mock('../../server/utils/engineGate', () => ({
  handleHostedQueueGet: (...a: any[]) => handleHostedQueueGet(...(a as [])),
  handleHostedInterrupt: (...a: any[]) => handleHostedInterrupt(...(a as [])),
  handleHostedObjectInfo: (...a: any[]) => handleHostedObjectInfo(...(a as [])),
  handleHostedUpload: (...a: any[]) => handleHostedUpload(...(a as [])),
  handleHostedSailor: (...a: any[]) => handleHostedSailor(...(a as [])),
  handleHostedSailorData: (...a: any[]) => handleHostedSailorData(...(a as [])),
  handleHostedOutputListing: (...a: any[]) => handleHostedOutputListing(...(a as [])),
  handleHostedUserScoped: (...a: any[]) => handleHostedUserScoped(...(a as [])),
}))

let middleware: (event: any) => Promise<any>
let normalizeEnginePath: (path: string) => string
let hostedEngineDecision: (p: string, m: string) => { kind: string, message?: string }

beforeAll(async () => {
  middleware = (await import('../../server/middleware/comfyui-proxy')).default as any
  ;({ normalizeEnginePath, hostedEngineDecision } = await import('../../server/utils/enginePath'))
})

beforeEach(() => {
  proxyRequest.mockClear()
  handleMeteredPrompt.mockClear()
  handleHostedQueueGet.mockClear()
  handleHostedInterrupt.mockClear()
  handleHostedObjectInfo.mockClear()
  handleHostedUpload.mockClear()
  handleHostedSailor.mockClear()
  handleHostedSailorData.mockClear()
  handleHostedOutputListing.mockClear()
  handleHostedUserScoped.mockClear()
  multiUser = false
})
afterEach(() => { mode = 'local' })

function ev(path: string, method = 'GET') {
  return { path, method, context: { userId: 'u1' }, node: { req: {}, res: {} } }
}
async function status(path: string, method = 'GET'): Promise<number | 'proxied' | 'passthrough' | string> {
  try {
    const res = await middleware(ev(path, method))
    if (res === undefined) return 'passthrough'
    if (proxyRequest.mock.calls.length) return 'proxied'
    return (res as any)?.handler ?? 'unknown'
  } catch (e: any) {
    return e?.statusCode ?? 'threw'
  }
}

// ---------------------------------------------------------------- pure part

describe('normalizeEnginePath', () => {
  it('leaves canonical engine paths untouched', () => {
    for (const p of ['/prompt', '/queue', '/interrupt', '/history', '/view', '/upload/image', '/object_info', '/system_stats']) {
      expect(normalizeEnginePath(p)).toBe(p)
    }
  })

  it('strips one leading /comfyui', () => {
    expect(normalizeEnginePath('/comfyui/history')).toBe('/history')
    expect(normalizeEnginePath('/comfyui/queue')).toBe('/queue')
    expect(normalizeEnginePath('/comfyui/internal/files/output')).toBe('/internal/files/output')
    expect(normalizeEnginePath('/comfyui')).toBe('/')
    expect(normalizeEnginePath('/comfyui/')).toBe('/')
  })

  it('strips one leading /api when the remainder is an engine mirror route', () => {
    expect(normalizeEnginePath('/api/history')).toBe('/history')
    expect(normalizeEnginePath('/api/prompt')).toBe('/prompt')
    expect(normalizeEnginePath('/api/queue')).toBe('/queue')
    expect(normalizeEnginePath('/api/interrupt')).toBe('/interrupt')
    expect(normalizeEnginePath('/api/view')).toBe('/view')
    expect(normalizeEnginePath('/api/internal/files/output')).toBe('/internal/files/output')
  })

  it('strips both, in order, for stacked aliases', () => {
    expect(normalizeEnginePath('/comfyui/api/queue')).toBe('/queue')
    expect(normalizeEnginePath('/comfyui/api/history/abc')).toBe('/history/abc')
  })

  it('NEVER rewrites Nitro\'s own /api namespace', () => {
    for (const p of ['/api/wallet', '/api/billing/checkout', '/api/vibe', '/api/admin/users', '/api/webhooks/clerk', '/api/pool/status']) {
      expect(normalizeEnginePath(p)).toBe(p)
    }
  })

  it('does not strip a second /api', () => {
    expect(normalizeEnginePath('/api/api/queue')).toBe('/api/api/queue')
  })

  it('preserves query strings', () => {
    expect(normalizeEnginePath('/api/view?filename=a.png&type=output')).toBe('/view?filename=a.png&type=output')
    expect(normalizeEnginePath('/comfyui/queue?x=2')).toBe('/queue?x=2')
    expect(normalizeEnginePath('/comfyui/api/prompt?x=1')).toBe('/prompt?x=1')
    expect(normalizeEnginePath('/api/wallet?x=1')).toBe('/api/wallet?x=1')
  })

  it('does not treat a longer sibling segment as the engine route', () => {
    expect(normalizeEnginePath('/api/viewport')).toBe('/api/viewport')
    expect(normalizeEnginePath('/api/queued')).toBe('/api/queued')
  })

  // F6 — every gate is a PREFIX match, so a dot segment inside an ALLOWED
  // prefix would carry a refused path past its refusal. Nitro folds these
  // upstream today, but that is an undocumented invariant of someone else's
  // router; this makes the guarantee local to the function that depends on it.
  describe('F6: dot segments are folded before any prefix is matched', () => {
    it('folds `..` out of an allowlisted prefix', () => {
      expect(normalizeEnginePath('/extensions/../history')).toBe('/history')
      expect(normalizeEnginePath('/extensions/../internal/files/output')).toBe('/internal/files/output')
      expect(normalizeEnginePath('/system_stats/../queue')).toBe('/queue')
    })

    it('folds percent-encoded dot segments', () => {
      expect(normalizeEnginePath('/extensions/%2e%2e/history')).toBe('/history')
      expect(normalizeEnginePath('/extensions/%2E%2E/history')).toBe('/history')
      expect(normalizeEnginePath('/extensions/%2e/history')).toBe('/extensions/history')
    })

    it('folds before the alias strips, not after', () => {
      expect(normalizeEnginePath('/comfyui/extensions/../history')).toBe('/history')
      expect(normalizeEnginePath('/comfyui/api/extensions/../queue')).toBe('/queue')
    })

    it('preserves the query string verbatim through canonicalization', () => {
      // URL.search would re-encode this; callers forward the RAW path, so the
      // two must not drift.
      expect(normalizeEnginePath('/extensions/../view?filename=a b.png')).toBe('/view?filename=a b.png')
    })

    it('leaves an ENCODED separator alone — `..%2f` is one literal segment', () => {
      // aiohttp reads it the same way, so folding it here would make the gate
      // and the engine disagree about which path was requested.
      expect(normalizeEnginePath('/extensions/..%2fhistory')).toBe('/extensions/..%2fhistory')
    })
  })
})

describe('F6: a dot-segment path is REFUSED, not proxied', () => {
  beforeEach(() => { mode = 'hosted' })

  it('refuses paths that fold onto a gated engine route', async () => {
    // Stage 6 Task 7: /internal/files/OUTPUT GET is now the per-user listing,
    // so the dot-fold probe uses /internal/files/INPUT — still forbidden — to
    // prove folding onto a gated route is refused.
    // Step 3, R10.9: an engine-only route is a plain 404.
    for (const p of ['/extensions/../history', '/extensions/%2e%2e/history', '/comfyui/extensions/../history', '/extensions/../internal/files/input', '/extensions/../gate/resume']) {
      expect(await status(p), p).toBe(404)
    }
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('still refuses — not proxies — a dot-segment path that folds onto /queue', async () => {
    expect(await status('/extensions/../queue', 'GET')).toBe(404)
    expect(handleHostedQueueGet).not.toHaveBeenCalled()
    expect(proxyRequest).not.toHaveBeenCalled()
  })
})

// -------------------------------------------------------------- hosted mode

describe('hosted mode: alias forms hit the same gates as canonical paths', () => {
  beforeEach(() => { mode = 'hosted' })

  // Step 3, R10.9: hosted never reaches the engine. Running a graph, its
  // queue, Stop, and the engine's /history and /view mirrors are engine-only
  // routes: a plain 404 in every spelling and verb, never a handler, never
  // the raw proxy.
  it('answers every /prompt alias 404, any verb — never metered onto the engine, never proxied', async () => {
    for (const p of ['/prompt', '/api/prompt', '/comfyui/prompt', '/comfyui/api/prompt', '/prompt?x=1', '/api/prompt?x=1']) {
      for (const m of ['POST', 'GET', 'DELETE']) {
        expect(await status(p, m), `${m} ${p}`).toBe(404)
      }
    }
    expect(handleMeteredPrompt).not.toHaveBeenCalled()
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('answers every /queue and /interrupt alias 404, any verb', async () => {
    for (const p of ['/queue', '/api/queue', '/comfyui/queue', '/comfyui/api/queue', '/queue?x=0', '/interrupt', '/api/interrupt', '/comfyui/interrupt', '/comfyui/api/interrupt']) {
      for (const m of ['GET', 'POST', 'DELETE', 'PUT', 'PATCH']) {
        expect(await status(p, m), `${m} ${p}`).toBe(404)
      }
    }
    expect(handleHostedQueueGet).not.toHaveBeenCalled()
    expect(handleHostedInterrupt).not.toHaveBeenCalled()
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('answers /history aliases 404 — the canonical /history Nitro route serves the UI', async () => {
    for (const p of ['/api/history', '/comfyui/history', '/comfyui/api/history', '/api/history/abc-123', '/comfyui/history/abc-123']) {
      expect(await status(p), p).toBe(404)
    }
  })

  it('answers /view aliases 404 — the canonical /view Nitro route serves the UI', async () => {
    for (const p of ['/api/view?filename=a.png', '/comfyui/view?filename=a.png', '/comfyui/api/view?filename=a.png&type=output']) {
      expect(await status(p), p).toBe(404)
    }
  })

  it('serves GET /internal/files/output per-user (LoadImageOutput picker) across every alias', async () => {
    // Stage 6 Task 7: the ONE /internal route the LoadImageOutput combo needs
    // is served as the caller's own outputs; every other /internal path stays
    // a 403 enumeration-oracle refusal.
    // Bare `/internal` is not a PROXY_PREFIX (reached only via /comfyui or
    // /api), same as the /view and /history alias tests above.
    for (const p of ['/comfyui/internal/files/output', '/api/internal/files/output', '/comfyui/api/internal/files/output']) {
      expect(await status(p), p).toBe('outputListing')
    }
  })

  it('still refuses the rest of /internal — file listings are a cross-tenant enumeration oracle', async () => {
    // /internal/files/input, other /internal subpaths, and any non-GET verb on
    // the output listing all stay forbidden.
    for (const p of ['/comfyui/internal/files/input', '/api/internal/files/temp', '/comfyui/internal/logs']) {
      expect(await status(p), p).toBe(404)
    }
    for (const m of ['POST', 'DELETE', 'PUT']) {
      expect(await status('/comfyui/internal/files/output', m), m).toBe(404)
    }
  })

  it('denies unlisted engine paths by default (a plain 404)', async () => {
    for (const p of ['/comfyui/models/checkpoints', '/comfyui/free', '/comfyui/api/free']) {
      expect(await status(p), p).toBe(404)
    }
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  // STAGE 6 TASK 8, as changed by R10.9 — /settings + /userdata are
  // engine-only routes: 404 in every guarded spelling, whatever the
  // multi-user switch says, never forwarded.
  it('T8: settings + userdata 404 in every guarded alias, switch on or off', async () => {
    for (const on of [false, true]) {
      multiUser = on
      for (const [p, m] of [
        ['/comfyui/settings', 'GET'], ['/api/settings', 'GET'], ['/comfyui/api/settings', 'GET'],
        ['/comfyui/userdata/x', 'GET'], ['/api/userdata/x', 'DELETE'], ['/comfyui/api/v2/userdata', 'GET'],
        ['/comfyui/settings/Comfy.Locale', 'POST'], ['/comfyui/userdata/a.json/move/b.json', 'POST'], ['/comfyui/settings', 'PUT'],
      ] as const) {
        expect(await status(p, m), `${on} ${m} ${p}`).toBe(404)
      }
    }
    expect(handleHostedUserScoped).not.toHaveBeenCalled()
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('T8: the BARE canonical spellings are not proxy-prefixed — they pass through to Nitro, never the engine', async () => {
    // `/settings`, `/userdata`, `/v2/userdata` are deliberately NOT in
    // PROXY_PREFIXES, so they never reach the hosted decision OR the raw proxy;
    // Nitro simply 404s them. Safe (no engine contact), just not a 403.
    for (const p of ['/settings', '/userdata/x', '/v2/userdata']) {
      expect(await status(p), p).toBe('passthrough')
      expect(proxyRequest, p).not.toHaveBeenCalled()
      expect(handleHostedUserScoped, p).not.toHaveBeenCalled()
    }
  })

  // ROUND 2 — these expectations MOVED, and the move is the lesson.
  //
  // This block used to assert that /object_info, /upload and /gate raw-proxy,
  // which read as a specification of the allowlist but was really just an echo
  // of it: the test was written from the LIST, not from what the upstream
  // handlers do. Both of the entries that looked most inert turned out to be
  // the two worst holes in the tenant boundary (F1, F2).
  //
  // So: an allowlist entry is a claim about a HANDLER, and adding one requires
  // reading that handler in ComfyUI's server.py — what does it read, what does
  // it write, whose data is in scope? "It's a static GET" is not an audit.
  // Step 3, R10.9: the raw allowlist is empty — the two survivors of that
  // audit (/system_stats, /extensions) are engine-only routes now, a 404.
  it('raw-proxies nothing: the round-2 survivors answer 404 (R10.9)', async () => {
    for (const [p, m] of [['/system_stats', 'GET'], ['/extensions/foo.js', 'GET'], ['/api/system_stats', 'GET'], ['/comfyui/extensions', 'GET']] as const) {
      proxyRequest.mockClear()
      expect(await status(p, m), `${m} ${p}`).toBe(404)
      expect(proxyRequest, `${m} ${p} must not proxy`).not.toHaveBeenCalled()
    }
  })

  // Step 3, R10.6 (decision 4): /global_subgraphs left the raw allowlist. Blueprints are built from
  // local-only classes, so hosted answers an empty list itself, in every spelling, and refuses one
  // blueprint by id; ComfyUI is never asked.
  it('R10.6: the blueprint list is empty in every spelling, and one blueprint is refused, never proxied', async () => {
    for (const p of ['/global_subgraphs', '/api/global_subgraphs', '/comfyui/global_subgraphs', '/comfyui/api/global_subgraphs', '/global_subgraphs?x=1']) {
      proxyRequest.mockClear()
      expect(await middleware(ev(p, 'GET')), p).toEqual({})
      expect(proxyRequest, p).not.toHaveBeenCalled()
      expect(hostedEngineDecision(normalizeEnginePath(p), 'GET'), p).toEqual({ kind: 'emptySubgraphs' })
    }
    for (const [p, m] of [['/global_subgraphs/abc', 'GET'], ['/api/global_subgraphs/abc', 'GET'], ['/global_subgraphs', 'POST'], ['/global_subgraphs/../global_subgraphs/abc', 'GET']] as const) {
      proxyRequest.mockClear()
      expect(await status(p, m), `${m} ${p}`).toBe(403)
      expect(proxyRequest, `${m} ${p}`).not.toHaveBeenCalled()
    }
  })

  // STAGE 6 TASK 2 — `/sailor/thing` used to sit in the list above, and its
  // removal is the lesson landing a second time. `/sailor` was allowlisted
  // because it is Sailor's OWN namespace, which is a fact about the path and
  // not about the handlers: comfy_extras/nodes_sailor_projects.py reads the
  // project uuid off the path, checks `_is_safe_id` (traversal only) and
  // serves it, with no identity anywhere in the request or on disk. So this
  // one entry published every tenant's saved graphs — list, read, overwrite,
  // delete — plus the install-wide spend ledger, to every signed-in user.
  // /sailor is now the worked example of the round-2 rule: an allowlist entry
  // is a claim about a HANDLER, and it needs the handler audit before it is
  // made. Projects are gated, spend is refused, and the still-unaudited rest
  // of the extension keeps today's behaviour under a NAMED branch so the gap
  // is visible rather than implied by a list.
  it('T2: routes every /sailor/projects alias to the ownership gate, never the raw proxy', async () => {
    for (const [p, m] of [
      ['/sailor/projects', 'GET'],
      ['/sailor/projects/abc', 'GET'],
      ['/sailor/projects/abc', 'PUT'],
      ['/sailor/projects/abc', 'DELETE'],
      ['/sailor/projects/abc/versions', 'POST'],
      ['/sailor/projects/abc/generations', 'GET'],
      ['/comfyui/sailor/projects', 'GET'],
      ['/comfyui/sailor/projects/abc', 'DELETE'],
      ['/sailor/projects?x=1', 'GET'],
      ['/sailor/assets/../projects/abc', 'GET'],
    ] as const) {
      proxyRequest.mockClear(); handleHostedSailor.mockClear()
      await middleware(ev(p, m))
      expect(handleHostedSailor, `${m} ${p} must be gated`).toHaveBeenCalledTimes(1)
      expect(proxyRequest, `${m} ${p} must not raw-proxy`).not.toHaveBeenCalled()
    }
  })

  it('T2: refuses /sailor/spend — it aggregates the whole install\'s ledger', async () => {
    for (const p of ['/sailor/spend', '/sailor/spend/summary', '/comfyui/sailor/spend/summary']) {
      expect(await status(p), p).toBe(403)
    }
    expect(proxyRequest, '/sailor/spend must never reach the engine').not.toHaveBeenCalled()
    expect(handleHostedSailor).not.toHaveBeenCalled()
  })

  it('T2: the /api mirror of a projects route is refused outright, not proxied', async () => {
    // ComfyUI mirrors EVERY route under /api (server.py:1207-1218), custom
    // extensions included. `/sailor` is deliberately NOT in
    // ENGINE_ROUTE_PREFIXES, so the mirror never normalizes and the
    // deny-by-default tail refuses it — fail closed, no engine contact.
    // R10.9: the deny-by-default tail is a plain 404.
    for (const p of ['/api/sailor/projects', '/api/sailor/projects/abc', '/comfyui/api/sailor/projects/abc']) {
      expect(await status(p), p).toBe(404)
    }
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  // STAGE 6 TASK 2b — the rest of the /sailor extension is now audited and
  // bucketed. This block used to assert the whole tail still raw-proxied; that
  // was the un-audited gap Task 2 named out loud, and closing it is 2b's whole
  // job. Per-user DATA routes go to the data gate, audited stateless
  // capability routes still raw-proxy, compute/shared-write routes 403.
  it('T2b: per-user DATA routes go to the data gate, never the raw proxy', async () => {
    for (const [p, m] of [
      ['/sailor/input_listing', 'GET'],
      ['/sailor/output_listing', 'GET'],
      ['/sailor/assets', 'GET'],
      ['/sailor/asset_import', 'POST'],
      ['/sailor/assets/a-1', 'DELETE'],
      ['/sailor/asset_thumbnails?asset_id=a-1', 'GET'],
      ['/sailor/asset_waveform?asset_id=a-1', 'GET'],
      ['/sailor/input_thumbnail?filename=a.png', 'GET'],
      ['/sailor/input_file?filename=a.png', 'DELETE'],
      ['/sailor/output_file?filename=a.png&subfolder=', 'DELETE'],
      ['/comfyui/sailor/assets', 'GET'],
      ['/comfyui/sailor/input_file?filename=a.png', 'DELETE'],
    ] as const) {
      proxyRequest.mockClear(); handleHostedSailorData.mockClear()
      await middleware(ev(p, m))
      expect(handleHostedSailorData, `${m} ${p} must be data-gated`).toHaveBeenCalledTimes(1)
      expect(proxyRequest, `${m} ${p} must not raw-proxy`).not.toHaveBeenCalled()
    }
  })

  it('T2b: audited stateless catalog/capability routes are answered by Sailor itself (A3), never raw-proxied', async () => {
    for (const [p, m] of [
      ['/sailor/shader_effects', 'GET'],
      ['/sailor/shader_effects/assets/atlas.png', 'GET'],
      ['/sailor/space_defaults', 'GET'],
      ['/sailor/space_thumbnails', 'GET'],
      ['/sailor/space_thumbnail/burst', 'GET'],
      ['/sailor/font_subset', 'POST'],
      ['/comfyui/sailor/shader_effects', 'GET'],
    ] as const) {
      proxyRequest.mockClear()
      const res = await middleware({ ...ev(p, m), node: { req: {}, res: { setHeader() {} } } })
      expect(res, `${m} ${p} is answered natively`).toBeDefined()
      expect(proxyRequest, `${m} ${p} must not raw-proxy`).not.toHaveBeenCalled()
      expect(handleHostedSailorData, `${m} ${p} must not be data-gated`).not.toHaveBeenCalled()
    }
  })

  it('T2b: compute / shared-write routes are refused, engine never touched', async () => {
    for (const [p, m] of [
      ['/sailor/render_timeline', 'POST'],
      ['/sailor/render_timeline_stream', 'POST'],
      ['/sailor/timeline/render_frame', 'POST'],
      ['/sailor/spacetype_encode', 'POST'],
      ['/sailor/motion/cleanup_frames', 'POST'],
      ['/sailor/lora/save_captions', 'POST'],
      ['/sailor/lora/clear_dataset', 'POST'],
      // R10.5: the model-bundle routes are gone, refused by default.
      ['/sailor/models/status', 'GET'],
      ['/sailor/models/download', 'GET'],
      ['/sailor/space_default/burst', 'POST'],
      ['/sailor/space_thumbnail/burst', 'POST'],
      ['/comfyui/sailor/render_timeline', 'POST'],
    ] as const) {
      proxyRequest.mockClear()
      expect(await status(p, m), `${m} ${p}`).toBe(403)
      expect(proxyRequest, `${m} ${p} must never reach the engine`).not.toHaveBeenCalled()
      expect(handleHostedSailorData).not.toHaveBeenCalled()
    }
  })

  it('T2b: an unclassified /sailor route fails closed (deny by default)', async () => {
    for (const [p, m] of [['/sailor/some_future_route', 'GET'], ['/sailor/newthing', 'POST']] as const) {
      proxyRequest.mockClear()
      expect(await status(p, m), `${m} ${p}`).toBe(403)
      expect(proxyRequest).not.toHaveBeenCalled()
      expect(handleHostedSailorData).not.toHaveBeenCalled()
    }
  })

  it('T2b: the /api mirror of a data route fails closed, not proxied (/sailor not in ENGINE_ROUTE_PREFIXES)', async () => {
    for (const [p, m] of [['/api/sailor/assets', 'GET'], ['/api/sailor/input_file?filename=a.png', 'DELETE'], ['/comfyui/api/sailor/assets', 'GET']] as const) {
      proxyRequest.mockClear()
      expect(await status(p, m), `${m} ${p}`).toBe(404)
      expect(proxyRequest).not.toHaveBeenCalled()
      expect(handleHostedSailorData).not.toHaveBeenCalled()
    }
  })

  // F1: POST /gate/resume takes a client-supplied prompt_id, rebuilds the
  // STORED graph and re-queues it under a fresh uuid — unmetered arbitrary
  // re-execution, with no hold, no price and no graph_runs row — while popping
  // another tenant's paused-gate context. Metered resume is a future task.
  it('F1: refuses EVERY /gate alias — unmetered re-execution of a stored graph', async () => {
    for (const p of ['/gate', '/gate/resume', '/comfyui/gate/resume', '/api/gate/resume', '/comfyui/api/gate/resume']) {
      for (const m of ['POST', 'GET']) {
        expect(await status(p, m), `${m} ${p}`).toBe(404)
      }
    }
    expect(proxyRequest, '/gate must never reach the engine').not.toHaveBeenCalled()
  })

  it('F1: the decision itself refuses /gate (404 since R10.9), canonical and aliased', () => {
    for (const p of ['/gate/resume', '/comfyui/gate/resume', '/api/gate/resume']) {
      expect(hostedEngineDecision(normalizeEnginePath(p), 'POST').kind, p).toBe('notFound')
    }
  })

  // F2: /object_info embeds the SHARED input-directory listing in every
  // LoadImage-family combo. The canvas needs the schemas, so it is scrubbed
  // rather than refused — but it must never raw-proxy.
  it('F2: routes every GET /object_info alias through the scrubber', async () => {
    for (const p of ['/object_info', '/object_info/LoadImage', '/comfyui/object_info', '/api/object_info', '/comfyui/api/object_info', '/object_info?x=2']) {
      proxyRequest.mockClear(); handleHostedObjectInfo.mockClear()
      await middleware(ev(p, 'GET'))
      expect(handleHostedObjectInfo, `GET ${p} must be scrubbed`).toHaveBeenCalledTimes(1)
      expect(proxyRequest, `GET ${p} must not raw-proxy`).not.toHaveBeenCalled()
    }
  })

  it('F2: refuses non-GET verbs on /object_info (404 since R10.9)', async () => {
    for (const m of ['POST', 'DELETE', 'PUT']) {
      expect(await status('/object_info', m), m).toBe(404)
    }
  })

  // F4: ComfyUI's image_upload() honours an `overwrite` form field and the
  // input dir is shared, so the body must be inspected before it is forwarded.
  it('F4: routes every POST /upload alias through the overwrite gate', async () => {
    for (const p of ['/upload/image', '/upload/mask', '/comfyui/upload/image', '/api/upload/image', '/comfyui/api/upload/image']) {
      proxyRequest.mockClear(); handleHostedUpload.mockClear()
      await middleware(ev(p, 'POST'))
      expect(handleHostedUpload, `POST ${p} must be gated`).toHaveBeenCalledTimes(1)
      expect(proxyRequest, `POST ${p} must not raw-proxy`).not.toHaveBeenCalled()
    }
  })

  it('F4: refuses non-POST verbs on /upload', async () => {
    for (const m of ['GET', 'DELETE']) {
      expect(await status('/upload/image', m), m).toBe(403)
    }
  })

  // F8, as changed by R10.9: every /prompt verb is the same plain 404.
  it('F8: /prompt is notFound for every verb', () => {
    for (const m of ['GET', 'POST', 'DELETE']) expect(hostedEngineDecision('/prompt', m).kind, m).toBe('notFound')
  })

  it('never diverts Nitro\'s own /api routes into the engine gates', async () => {
    for (const p of ['/api/wallet', '/api/billing/checkout', '/api/vibe', '/api/admin/x', '/api/pool/status']) {
      expect(await status(p, 'POST'), p).toBe('passthrough')
    }
    expect(handleMeteredPrompt).not.toHaveBeenCalled()
    expect(handleHostedQueueGet).not.toHaveBeenCalled()
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('leaves the canonical /view and /history Nitro routes alone', async () => {
    expect(await status('/view?filename=a.png')).toBe('passthrough')
    expect(await status('/history')).toBe('passthrough')
    expect(await status('/history/abc')).toBe('passthrough')
  })
})

// --------------------------------------------------------------- local mode

describe('local mode is byte-identical — no gate, no 403, same proxy target', () => {
  const ALL = [
    ['/prompt', 'POST'], ['/api/prompt', 'POST'], ['/comfyui/prompt', 'POST'], ['/comfyui/api/prompt', 'POST'],
    ['/queue', 'GET'], ['/api/queue', 'GET'], ['/comfyui/queue', 'GET'], ['/comfyui/api/queue', 'GET'],
    ['/queue', 'POST'], ['/api/queue', 'DELETE'],
    ['/interrupt', 'POST'], ['/api/interrupt', 'POST'], ['/comfyui/interrupt', 'POST'],
    ['/api/history', 'GET'], ['/comfyui/history', 'GET'], ['/api/view?filename=a.png', 'GET'],
    ['/comfyui/internal/files/output', 'GET'], ['/comfyui/settings', 'GET'],
    // Round 2: the prefixes that stopped raw-proxying in HOSTED mode must
    // still raw-proxy locally — no scrubber, no overwrite sniff, no 403.
    // (`/upload/image` and `/upload/mask` are native since engine-free Phase A
    // A4, and `/object_info` since A5: see the next describe.)
    ['/upload', 'POST'], ['/gate/resume', 'POST'],
    ['/extensions/../history', 'GET'],
    // Stage 6 Task 2's projects gate and spend refusal are hosted-only; since
    // engine-free Phase A those paths are answered natively in local mode (see
    // the next describe), so they are no longer in this raw-proxy list.
    // Stage 6 Task 2b: the /sailor routes Sailor does not serve itself still
    // raw-proxy unchanged in local mode. (The DATA bucket and, since A3, the
    // capability routes and the lora/motion/space-preset writes are answered
    // natively since engine-free Phase A: see below.)
    ['/sailor/render_timeline', 'POST'], ['/sailor/spacetype_encode', 'POST'],
  ] as const

  it('proxies every path the hosted gates intercept', async () => {
    for (const [p, m] of ALL) {
      proxyRequest.mockClear()
      await middleware(ev(p, m))
      expect(proxyRequest, `${m} ${p} must raw-proxy in local mode`).toHaveBeenCalledTimes(1)
    }
    expect(handleMeteredPrompt).not.toHaveBeenCalled()
    expect(handleHostedQueueGet).not.toHaveBeenCalled()
    expect(handleHostedInterrupt).not.toHaveBeenCalled()
    expect(handleHostedSailor, 'local mode must never enter the projects gate').not.toHaveBeenCalled()
  })

  it('sends the pre-Stage-5 target URL for each alias (normalization must not reach the proxy)', async () => {
    const expected: [string, string][] = [
      ['/api/prompt', 'http://127.0.0.1:8188/api/prompt'],
      ['/api/queue', 'http://127.0.0.1:8188/api/queue'],
      ['/api/history', 'http://127.0.0.1:8188/api/history'],
      ['/comfyui/history', 'http://127.0.0.1:8188/history'],
      ['/comfyui/api/queue', 'http://127.0.0.1:8188/api/queue'],
      ['/comfyui/internal/files/output', 'http://127.0.0.1:8188/internal/files/output'],
      ['/comfyui/settings', 'http://127.0.0.1:8188/settings'],
      ['/comfyui/sailor/render_timeline', 'http://127.0.0.1:8188/sailor/render_timeline'],
      ['/queue?a=2', 'http://127.0.0.1:8188/queue?a=2'],
      ['/comfyui', 'http://127.0.0.1:8188/'],
    ]
    for (const [p, url] of expected) {
      proxyRequest.mockClear()
      await middleware(ev(p, 'GET'))
      expect(proxyRequest.mock.calls[0]?.[1], p).toBe(url)
    }
  })
})

describe('local mode: projects and spend are answered by Sailor itself (engine-free Phase A)', () => {
  let root = ''
  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    root = mkdtempSync(join(tmpdir(), 'engine-path-alias-'))
    ;(await import('../../server/utils/inputUploads')).__setInputUploadsEngineRootForTests(root)
    // These routes are native now — a test that leaks past the router into
    // `forwardToEngine`'s real `fetch` would otherwise try to reach the real
    // :8188. Stubbed to fail fast, same as "engine unreachable", so any such
    // leak fails loudly here instead of silently hitting a live port.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
  })
  afterEach(async () => {
    ;(await import('../../server/utils/inputUploads')).__setInputUploadsEngineRootForTests(undefined)
    ;(await import('node:fs')).rmSync(root, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('never raw-proxies them and never enters the hosted projects gate, under any spelling', async () => {
    for (const [p, m] of [
      ['/sailor/projects', 'GET'], ['/api/sailor/projects', 'GET'], ['/comfyui/sailor/projects/abc', 'GET'],
      ['/comfyui/api/sailor/projects/abc/generations', 'GET'], ['/sailor/projects/abc', 'DELETE'],
      ['/sailor/spend/summary', 'GET'], ['/sailor/projects?x=2', 'GET'],
    ] as const) {
      proxyRequest.mockClear()
      const res = await middleware(ev(p, m))
      expect(proxyRequest, `${m} ${p} is native in local mode`).not.toHaveBeenCalled()
      expect(res, `${m} ${p}`).toBeDefined()
    }
    expect(handleHostedSailor, 'local mode must never enter the projects gate').not.toHaveBeenCalled()
  })

  it('answers the media library routes natively too, never entering the hosted data gate', async () => {
    for (const [p, m] of [
      ['/sailor/input_listing', 'GET'], ['/api/sailor/output_listing', 'GET'], ['/comfyui/sailor/assets', 'GET'],
      ['/sailor/assets/a-1', 'DELETE'], ['/comfyui/api/sailor/input_file?filename=a.png', 'DELETE'],
      ['/sailor/output_file?filename=a.png', 'DELETE'], ['/sailor/input_thumbnail?filename=a.png', 'GET'],
      ['/sailor/asset_thumbnails?asset_id=a-1', 'GET'], ['/sailor/asset_waveform?asset_id=a-1', 'GET'],
    ] as const) {
      proxyRequest.mockClear()
      const res = await middleware({ ...ev(p, m), node: { req: {}, res: { setHeader() {} } } })
      expect(proxyRequest, `${m} ${p} is native in local mode`).not.toHaveBeenCalled()
      expect(res, `${m} ${p}`).toBeDefined()
    }
    expect(handleHostedSailorData, 'local mode must never enter the data gate').not.toHaveBeenCalled()
  })

  it('answers the small /sailor routes natively too (A3), including the writes the hosted gate refuses', async () => {
    for (const [p, m] of [
      ['/sailor/shader_effects', 'GET'], ['/comfyui/sailor/shader_effects/assets/a.png', 'GET'], ['/api/sailor/space_defaults', 'GET'],
      ['/sailor/space_default/burst', 'POST'], ['/sailor/space_thumbnails', 'GET'], ['/sailor/space_thumbnail/burst', 'GET'],
      ['/sailor/space_thumbnail/burst', 'POST'], ['/sailor/font_subset', 'POST'], ['/sailor/lora/save_captions', 'POST'],
      ['/sailor/lora/clear_dataset', 'POST'], ['/sailor/motion/cleanup_frames', 'POST'],
    ] as const) {
      proxyRequest.mockClear()
      const res = await middleware({ ...ev(p, m), node: { req: {}, res: { setHeader() {} } } })
      expect(proxyRequest, `${m} ${p} is native in local mode`).not.toHaveBeenCalled()
      expect(res, `${m} ${p}`).toBeDefined()
    }
  })

  it('answers /upload/image and /upload/mask natively (A4), under any spelling', async () => {
    // GET is aiohttp's 405 on these POST routes — enough to prove the router
    // owns them without a body; native-uploads covers the writes.
    for (const p of ['/upload/image', '/api/upload/mask', '/comfyui/upload/image', '/comfyui/api/upload/image?x=2']) {
      proxyRequest.mockClear()
      const res = await middleware({ ...ev(p, 'GET'), node: { req: {}, res: { setHeader() {} } } })
      expect(proxyRequest, `${p} is native in local mode`).not.toHaveBeenCalled()
      expect(res, p).toBe('405: Method Not Allowed')
    }
  })

  it('answers /object_info natively (A5), under any spelling, never entering the hosted scrubber', async () => {
    // fetch is stubbed to fail (engine down), so the committed baseline answers.
    for (const p of ['/object_info', '/api/object_info', '/comfyui/object_info', '/comfyui/api/object_info/KSampler', '/object_info?x=2']) {
      proxyRequest.mockClear()
      const res = await middleware({ ...ev(p, 'GET'), node: { req: {}, res: { setHeader() {} } } }) as any
      expect(proxyRequest, `${p} is native in local mode`).not.toHaveBeenCalled()
      expect(res?.KSampler, p).toBeTruthy()
    }
    expect(handleHostedObjectInfo, 'local mode must never enter the hosted scrubber').not.toHaveBeenCalled()
  })

  it('the model-bundle routes are gone (R10.5): 404 from Sailor, never the engine\'s downloader, even with the engine up', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
    for (const p of ['/sailor/models/download?key=upscale', '/sailor/models/status?key=upscale', '/comfyui/api/sailor/models/download?key=x']) {
      proxyRequest.mockClear()
      expect(await middleware({ ...ev(p, 'GET'), node: { req: {}, res: { setHeader() {} } } }), p).toBe('404: Not Found')
      expect(proxyRequest, p).not.toHaveBeenCalled()
    }
  })
})

/**
 * Final-review I2 (spec ruling 4): an engine-only route asked for while the
 * cached health check says the main engine is down answers 503
 * {error:'This needs the local engine'} — never h3's 502 from a refused proxy
 * — in local and hosted mode alike; the socket and pool workers are left alone.
 */
describe('engine down: engine-only routes answer 503, not a failed proxy', () => {
  function evWithRes(path: string, method = 'GET') {
    const res: { statusCode?: number, setHeader(): void } = { setHeader() {} }
    return { event: { ...ev(path, method), node: { req: {}, res } }, res }
  }

  const engineOnly: Array<[string, string]> = [
    ['/prompt', 'POST'],
    ['/api/prompt', 'POST'],
    ['/sailor/render_timeline', 'POST'],
    ['/sailor/render_timeline_stream', 'POST'],
    ['/sailor/timeline/render_frame', 'POST'],
    ['/sailor/spacetype_encode', 'POST'],
    ['/queue', 'GET'],
  ]

  it('local mode: each answers 503 with the plain message and is never proxied', async () => {
    mode = 'local'
    engineHealthState.value = 'down'
    for (const [p, m] of engineOnly) {
      proxyRequest.mockClear()
      const { event, res } = evWithRes(p, m)
      expect(await middleware(event), `${m} ${p}`).toEqual({ error: 'This needs the local engine' })
      expect(res.statusCode, `${m} ${p}`).toBe(503)
      expect(proxyRequest, `${m} ${p}`).not.toHaveBeenCalled()
    }
  })

  it('local mode: with the engine up the same routes are proxied as before', async () => {
    mode = 'local'
    engineHealthState.value = 'up'
    for (const [p, m] of engineOnly) {
      proxyRequest.mockClear()
      await middleware(ev(p, m))
      expect(proxyRequest, `${m} ${p}`).toHaveBeenCalledTimes(1)
    }
  })

  it('hosted mode: an engine route is a plain 404 whether the engine is up or down (R10.9); a refused /sailor route stays 403', async () => {
    mode = 'hosted'
    for (const state of ['down', 'up'] as const) {
      engineHealthState.value = state
      expect(await status('/system_stats', 'GET'), state).toBe(404)
      expect(await status('/sailor/render_timeline', 'POST'), state).toBe(403)
    }
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('the socket (/api/ws, /comfyui/ws) is left to its own handling, not answered 503', async () => {
    mode = 'local'
    engineHealthState.value = 'down'
    for (const p of ['/api/ws?clientId=x', '/comfyui/ws']) {
      proxyRequest.mockClear()
      await middleware(ev(p, 'GET'))
      expect(proxyRequest, p).toHaveBeenCalledTimes(1)
    }
  })
})
