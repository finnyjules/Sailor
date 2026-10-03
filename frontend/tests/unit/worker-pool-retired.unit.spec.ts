/**
 * R10.3 guard: the ComfyUI worker pool is gone (extra headless engines on
 * :8189+, `/api/pool/ensure`, the `?comfyWorker=N` routing, spill and parallel
 * dispatch, per-worker sockets). Step 4, C5: so are the last socket to the
 * local engine and its `/gate/resume`: a Gate pauses only in a runner run, and
 * resumes through the runner.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
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

  it('the run channel to the local engine is gone too (step 4, C5)', () => {
    expect(existsSync(join(root, 'app/composables/useDirectExecution.ts'))).toBe(false)
  })
})

describe('C5: the Gate resumes through the runner only', () => {
  it('nothing names /gate/resume or the engine resume route', () => {
    const hits = sources.filter(s => /\/gate\/resume|gateResumeRoute/.test(s.text)).map(s => s.file).sort()
    expect(hits).toEqual([])
  })

  it('the Gate card sends its action to the runner, and nothing else', () => {
    const src = readFileSync(join(root, 'app/components/vue-canvas/ComfyGateNode.vue'), 'utf8')
    const guard = src.indexOf('if (!isRunner.value) return')
    const send = src.indexOf("new CustomEvent('sailor:runnerGateAction'")
    expect(guard).toBeGreaterThan(0)
    expect(send).toBeGreaterThan(guard)
    expect(src).not.toMatch(/\$fetch|fetch\(/)
  })

  it('/gate/resume is a plain 404 at the proxy (R10.9; locally too since C5)', () => {
    for (const p of ['/gate/resume', '/comfyui/gate/resume', '/api/gate/resume']) {
      expect(hostedEngineDecision(normalizeEnginePath(p), 'POST').kind, p).toBe('notFound')
    }
  })
})
