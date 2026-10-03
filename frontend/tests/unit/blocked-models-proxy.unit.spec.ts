/**
 * The local `/prompt` proxy used to refuse a prompt that used a discontinued
 * or runner-only model (model line-up, Task H1) and forward the rest to
 * ComfyUI. Step 4, C5: there is no engine to forward to, so `/prompt` is a
 * plain 404 locally, as it has been hosted since R10.9: whatever it holds,
 * nothing is checked, proxied or requested.
 *
 * Driven through server/middleware/comfyui-proxy.ts with fake events, the
 * way engine-path-alias.unit.spec.ts drives it.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/utils/deployMode', () => ({
  deployMode: () => 'local',
  isHosted: () => false,
  engineMultiUser: () => false,
}))

const g = globalThis as any
g.defineEventHandler = (fn: any) => fn
g.createError = (opts: { statusCode: number, message?: string }) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode })
const proxyRequest = vi.fn(async (_event: any, url: string) => ({ proxiedTo: url }))
g.proxyRequest = proxyRequest

let middleware: (event: any) => Promise<any>
beforeAll(async () => {
  middleware = (await import('../../server/middleware/comfyui-proxy')).default as any
})

function ev(path: string, body: unknown) {
  return { path, method: 'POST', context: {}, _requestBody: body, node: { req: { headers: {} }, res: {} } }
}
const prompt = (model: string) => ({ prompt: { 1: { class_type: 'GenerateVideoNode', inputs: { model, prompt: 'x' } } } })

describe('local /prompt (C5: no engine)', () => {
  it('is a plain 404 in every spelling, whatever it holds; nothing is proxied or requested', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      for (const p of ['/prompt', '/api/prompt', '/comfyui/prompt', '/prompt?x=1']) {
        for (const body of [prompt('sora-2'), prompt('veo-3.1'), 'not json']) {
          const err = await middleware(ev(p, body)).then(() => null, e => e)
          expect(err, p).toMatchObject({ statusCode: 404, message: 'Not found' })
        }
      }
      expect(proxyRequest).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    }
    finally {
      vi.unstubAllGlobals()
      g.defineEventHandler = (fn: any) => fn
      g.createError = (opts: { statusCode: number, message?: string }) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode })
      g.proxyRequest = proxyRequest
    }
  })

  it('the proxy holds no prompt check or engine forward any more', async () => {
    const mod = await import('../../server/middleware/comfyui-proxy') as Record<string, unknown>
    expect(mod.PROMPT_CHECK_MAX_BYTES).toBeUndefined()
  })
})
