/**
 * R10.3 guard: the ComfyUI worker pool is gone (extra headless engines on
 * :8189+, `/api/pool/ensure`, the `?comfyWorker=N` routing, spill and parallel
 * dispatch, per-worker sockets). One socket to the local engine stays for
 * R10.2's explicit local-only route.
 *
 * The engine's `/gate/resume` stays for one case only: a Gate inside a run the
 * local engine is running (a KSampler graph on the local-only route) still
 * pauses in Python and needs the engine to resume it. It is sent locally only;
 * hosted never sends it and its proxy refuses it (enginePath F1).
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gateResumeRoute } from '~/lib/runner/gateChoices'
import { hostedEngineDecision, normalizeEnginePath } from '../../server/utils/enginePath'

const root = process.cwd()

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|vue|js|mjs)$/.test(name)) out.push(full)
  }
  return out
}

const sources = ['app', 'server', 'shared'].flatMap(d => walk(join(root, d)))
  .map(f => ({ file: relative(root, f), text: readFileSync(f, 'utf8') }))

describe('R10.3: the worker pool is gone', () => {
  it('nothing in app/, server/ or shared/ names the pool', () => {
    const hits = sources
      .filter(s => /\/api\/pool\/ensure|comfyWorker|queueSmart|queueParallel|sailor:pool/.test(s.text))
      .map(s => s.file)
    expect(hits).toEqual([])
  })

  it('the pool’s files are deleted', () => {
    for (const f of [
      'server/utils/comfyWorkerPool.ts',
      'server/plugins/comfyWorkerPool.ts',
      'server/api/pool/ensure.post.ts',
      'server/utils/workerRoute.ts',
      'app/lib/graph/pickWorker.ts',
      'app/lib/graph/cloudOnly.ts',
    ]) expect(existsSync(join(root, f)), f).toBe(false)
  })

  it('the run channel keeps one socket and queues on the local engine only', () => {
    const src = readFileSync(join(root, 'app/composables/useDirectExecution.ts'), 'utf8')
    expect(src).not.toMatch(/new Map<number, SocketState>|ensurePoolSocket|giveUpWorker|\/api\/pool/)
    expect(src).toContain("$fetch<{ prompt_id?: string }>('/prompt'")
  })
})

describe('R10.3: the engine Gate resume is local-only', () => {
  it('only the Gate card (local branch) names /gate/resume', () => {
    // R10.9: hosted refuses the whole /gate prefix as an engine-only route (404), without naming resume.
    const hits = sources.filter(s => s.text.includes('/gate/resume')).map(s => s.file).sort()
    expect(hits).toEqual(['app/components/vue-canvas/ComfyGateNode.vue'])
  })

  it('the Gate card sends it only after the runner and hosted have been turned away', () => {
    const src = readFileSync(join(root, 'app/components/vue-canvas/ComfyGateNode.vue'), 'utf8')
    const runner = src.indexOf("if (route === 'runner') {")
    const none = src.indexOf("if (route === 'none') return")
    const resume = src.indexOf("'/gate/resume'")
    expect(runner).toBeGreaterThan(0)
    expect(none).toBeGreaterThan(runner)
    expect(resume).toBeGreaterThan(none)
    expect(src).toContain('gateResumeRoute(props.data.promptId, { runner: isRunner.value, hosted })')
  })

  it('routes runner Gates to the runner, local engine Gates to the engine, and nothing in hosted', () => {
    expect(gateResumeRoute('runner-abc', { runner: true, hosted: false })).toBe('runner')
    expect(gateResumeRoute('runner-abc', { runner: true, hosted: true })).toBe('runner')
    expect(gateResumeRoute('p1', { runner: false, hosted: false })).toBe('engine')
    expect(gateResumeRoute('p1', { runner: false, hosted: true })).toBe('none')
    expect(gateResumeRoute(undefined, { runner: false, hosted: false })).toBe('none')
  })

  it('hosted refuses /gate/resume at the proxy (a plain 404 since R10.9)', () => {
    for (const p of ['/gate/resume', '/comfyui/gate/resume', '/api/gate/resume']) {
      expect(hostedEngineDecision(normalizeEnginePath(p), 'POST').kind, p).toBe('notFound')
    }
  })
})
