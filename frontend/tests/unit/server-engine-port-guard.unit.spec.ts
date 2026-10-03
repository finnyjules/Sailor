/**
 * Step 4, C5 guard: there is no local engine, anywhere. (Step 3, R10.8 made the
 * server stop calling the engine's port except on a few local-only paths;
 * C5 removed those, and this guard now covers the whole app.)
 *
 * Nothing in frontend/app, frontend/server or frontend/shared names:
 *   - the engine's port (8188) or its address, `ENGINE_MAIN_PORT`,
 *     `ENGINE_ORIGIN`, `SAILOR_COMFY_ORIGIN`, `comfyOrigin`;
 *   - the engine's health check (`engineHealth`, `/api/engine/health`);
 *   - `/prompt`, `/queue` or `/interrupt` as a route to call;
 *   - the Gate's engine resume (`/gate/resume`, `gateResumeRoute`);
 *   - the engine queue or socket (`queueSmart`, `engineSocketAllowed`, a `/ws` URL).
 *
 * One allow-list, each entry with its reason: the two path classifiers that
 * name the engine's routes in order to answer them with a plain 404.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const FRONTEND = join(__dirname, '..', '..')
const ROOTS = ['app', 'server', 'shared']
const SKIP_DIRS = new Set(['node_modules', '.nuxt', '.output'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|vue|js|mjs|cjs)$/.test(name)) out.push(p)
  }
  return out
}

const files = [...ROOTS.flatMap(r => walk(join(FRONTEND, r))), join(FRONTEND, 'nuxt.config.ts')]
  .map(p => ({ rel: relative(FRONTEND, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))

/** What names the engine, each with what it catches. */
const FORBIDDEN: Record<string, RegExp> = {
  'the engine’s port': /\b8188\b/,
  'the engine’s port or origin constant': /\b(ENGINE_MAIN_PORT|ENGINE_ORIGIN|SAILOR_COMFY_ORIGIN|comfyOrigin)\b/,
  'the engine health check': /\bengineHealth\b|\/api\/engine\/health/,
  'the engine’s run, queue or Stop route': /['"`](?:\/api|\/comfyui)?\/(?:prompt|queue|interrupt)(?:['"`?/])/,
  'the Gate’s engine resume': /\/gate\/resume|\bgateResumeRoute\b/,
  'the engine queue or socket': /\b(queueSmart|engineSocketAllowed|setEngineAvailable|isMainSocketOpen)\b|\/ws\?clientId|['"`](?:\/api|\/comfyui)?\/ws(?:['"`?/])/,
}

/** Files allowed to name an engine route, and why. */
const ALLOWED: Record<string, { patterns: string[]; why: string }> = {
  'server/utils/enginePath.ts': {
    patterns: ['the engine’s run, queue or Stop route', 'the engine queue or socket'],
    why: 'the path classifier: lists the engine’s routes (every spelling) so they answer a plain 404',
  },
  'server/utils/authGuard.ts': {
    patterns: ['the engine’s run, queue or Stop route'],
    why: 'PROXY_PREFIXES: the engine-style paths the middleware answers itself (a 404 for these)',
  },
}

function offences(text: string): string[] {
  return Object.entries(FORBIDDEN).filter(([, re]) => re.test(text)).map(([name]) => name)
}

describe('there is no local engine, anywhere (step 4, C5)', () => {
  it('reads the app, the server and shared', () => {
    expect(files.length).toBeGreaterThan(500)
    for (const rel of ['app/layouts/default.vue', 'server/middleware/comfyui-proxy.ts', 'shared/runner/needsEngine.ts', 'nuxt.config.ts']) {
      expect(files.some(f => f.rel === rel), rel).toBe(true)
    }
  })

  it('positive control: the patterns catch the old engine code', () => {
    expect(offences("const target = `http://127.0.0.1:${8188}`")).toEqual(['the engine’s port'])
    expect(offences("import { ENGINE_MAIN_PORT, engineHealth } from '../native/engineHealth'")).toEqual(expect.arrayContaining(['the engine’s port or origin constant', 'the engine health check']))
    expect(offences("const res = await $fetch('/prompt', { method: 'POST' })")).toEqual(['the engine’s run, queue or Stop route'])
    expect(offences("fetch('/queue', { method: 'POST' })")).toEqual(['the engine’s run, queue or Stop route'])
    expect(offences("fetch('/interrupt', { method: 'POST' })")).toEqual(['the engine’s run, queue or Stop route'])
    expect(offences("fetch(`/api/prompt?x=1`)")).toEqual(['the engine’s run, queue or Stop route'])
    expect(offences("await $fetch<{ prompt_id?: string }>('/gate/resume', {")).toEqual(['the Gate’s engine resume'])
    expect(offences('const route = gateResumeRoute(id, o)')).toEqual(['the Gate’s engine resume'])
    expect(offences('return `${origin}/ws?clientId=${id}`')).toEqual(['the engine queue or socket'])
    expect(offences("if (!req.url?.startsWith('/ws')) {")).toEqual(['the engine queue or socket'])
    expect(offences('direct.setEngineAvailable(engineSocketAllowed(s))')).toEqual(['the engine queue or socket'])
    expect(offences("fetch('/api/engine/health')")).toEqual(['the engine health check'])
    expect(offences('comfyOrigin: ""')).toEqual(['the engine’s port or origin constant'])
    // …and not Sailor's own words or routes.
    expect(offences("'/api/prompt-route' '/api/runs' 'prompt' '/queue-panel' const node = 1783717818842")).toEqual([])
    expect(offences(' * the prompt the person typed; a queue of runs')).toEqual([])
  })

  it('nothing outside the allow-list names the engine', () => {
    const bad: string[] = []
    for (const f of files) {
      const allowed = ALLOWED[f.rel]?.patterns ?? []
      const hits = offences(f.text).filter(h => !allowed.includes(h))
      if (hits.length) bad.push(`${f.rel}: ${hits.join(', ')}`)
    }
    expect(bad).toEqual([])
  })

  it('every allow-list entry still holds what it is allowed for, and gives its reason', () => {
    for (const [rel, a] of Object.entries(ALLOWED)) {
      const f = files.find(x => x.rel === rel)
      expect(f, rel).toBeTruthy()
      expect(a.why.length, rel).toBeGreaterThan(20)
      for (const p of a.patterns) expect(FORBIDDEN[p]!.test(f!.text), `${rel}: ${p}`).toBe(true)
    }
  })

  it('the engine’s modules are gone', () => {
    for (const rel of ['server/native/engineHealth.ts', 'server/api/engine/health.get.ts', 'server/utils/meterGraphRun.ts', 'app/composables/useDirectExecution.ts', 'shared/runner/localOnly.ts', 'shared/runner/hostedOffer.ts']) {
      expect(files.some(f => f.rel === rel), rel).toBe(false)
    }
  })

  it('the server makes no request to a loopback engine address', () => {
    const offenders = files
      .filter(f => f.rel.startsWith('server/'))
      .filter(f => /['"`]https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{4}/.test(f.text))
      .map(f => f.rel)
    expect(offenders).toEqual([])
  })
})
