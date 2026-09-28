/**
 * The local `/prompt` proxy refuses a prompt that uses a discontinued or
 * runner-only model (model line-up, Task H1), in ComfyUI's own 400 shape,
 * and never forwards it. Any other prompt is proxied as before.
 *
 * Driven through server/middleware/comfyui-proxy.ts with fake events, the
 * way engine-path-alias.unit.spec.ts drives it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/native/engineHealth', async orig => ({
  ...(await orig() as object),
  engineHealth: async () => 'up',
}))
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

import { __resetModelMenusForTests } from '../../shared/runner/modelMenus'
import { VIDEO_MODELS_BY_ID } from '../../app/data/video-models'

let middleware: (event: any) => Promise<any>
beforeAll(async () => {
  middleware = (await import('../../server/middleware/comfyui-proxy')).default as any
})

const sora = VIDEO_MODELS_BY_ID['sora-2']!
afterEach(() => {
  delete sora.discontinued
  __resetModelMenusForTests()
  proxyRequest.mockClear()
})

function ev(path: string, body: unknown) {
  return { path, method: 'POST', context: {}, _requestBody: body, node: { req: { headers: {} }, res: {} } }
}
const prompt = (model: string) => ({ prompt: { 1: { class_type: 'GenerateVideoNode', inputs: { model, prompt: 'x' } } } })

describe('local /prompt proxy', () => {
  it('refuses a discontinued model in every spelling, 400, never forwarded', async () => {
    sora.discontinued = '2026-09-24'
    __resetModelMenusForTests()
    for (const p of ['/prompt', '/api/prompt', '/comfyui/prompt', '/prompt?comfyWorker=1']) {
      const e = ev(p, prompt('sora-2'))
      const res = await middleware(e)
      expect(e.node.res, p).toMatchObject({ statusCode: 400 })
      expect(res.error, p).toMatchObject({
        type: 'value_not_in_list',
        message: 'Sora 2 was discontinued by its service on 24 Sep 2026. Pick another model in “Generate a video”, such as Hailuo H3 Max.',
      })
      expect(res.node_errors['1'].class_type, p).toBe('GenerateVideoNode')
    }
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('Generate a 3D model is refused at any size, over the 8 MB cap too (R3.9 fix round 2); Multi-View over the cap is forwarded', async () => {
    const { PROMPT_CHECK_MAX_BYTES } = await import('../../server/middleware/comfyui-proxy')
    const { GENERATE_3D_RUNNER_ONLY } = await import('../../shared/runner/gen3d')
    const body = (class_type: string, bytes: number) => {
      const p = { prompt: { 1: { class_type, inputs: { image: ['2', 0] } }, 2: { class_type: 'LoadImage', inputs: { image: 'a.png' } } } }
      const base = JSON.stringify({ ...p, pad: '' })
      return Buffer.from(JSON.stringify({ ...p, pad: 'x'.repeat(Math.max(0, bytes - base.length)) }))
    }
    for (const ct of ['Generate3DNode', 'Hunyuan3DRemoteNode']) {
      for (const bytes of [0, PROMPT_CHECK_MAX_BYTES + 1]) {
        const e = ev('/prompt', body(ct, bytes))
        const res = await middleware(e)
        expect(e.node.res, `${ct} ${bytes}`).toMatchObject({ statusCode: 400 })
        expect(res.error.message, `${ct} ${bytes}`).toBe(GENERATE_3D_RUNNER_ONLY)
      }
    }
    expect(proxyRequest).not.toHaveBeenCalled()
    // A prompt text that merely mentions the class isn't a node of it.
    const mention = Buffer.from(JSON.stringify({ prompt: { 1: { class_type: 'GenerateImageNode', inputs: { prompt: '"class_type": "Generate3DNode"' } } }, pad: 'x'.repeat(PROMPT_CHECK_MAX_BYTES) }))
    expect(await middleware(ev('/prompt', mention))).toEqual({ proxiedTo: 'http://127.0.0.1:8188/prompt' })
    const mv = ev('/prompt', body('Hunyuan3DMultiViewNode', PROMPT_CHECK_MAX_BYTES + 1))
    expect(await middleware(mv)).toEqual({ proxiedTo: 'http://127.0.0.1:8188/prompt' })
  })

  it('a body over the 8 MB cap is forwarded unchecked (the browser checked first); at the cap it is checked', async () => {
    sora.discontinued = '2026-09-24'
    __resetModelMenusForTests()
    const { PROMPT_CHECK_MAX_BYTES } = await import('../../server/middleware/comfyui-proxy')
    expect(PROMPT_CHECK_MAX_BYTES).toBe(8 * 1024 * 1024)
    const sized = (bytes: number) => {
      const base = JSON.stringify({ ...prompt('sora-2'), pad: '' })
      return Buffer.from(JSON.stringify({ ...prompt('sora-2'), pad: 'x'.repeat(bytes - base.length) }))
    }
    expect(sized(PROMPT_CHECK_MAX_BYTES).length).toBe(PROMPT_CHECK_MAX_BYTES)
    const atCap = ev('/prompt', sized(PROMPT_CHECK_MAX_BYTES))
    expect((await middleware(atCap)).error.type).toBe('value_not_in_list')
    expect(proxyRequest).not.toHaveBeenCalled()
    const over = ev('/prompt', sized(PROMPT_CHECK_MAX_BYTES + 1))
    expect(await middleware(over)).toEqual({ proxiedTo: 'http://127.0.0.1:8188/prompt' })
    expect(proxyRequest).toHaveBeenCalledTimes(1)
  })

  it('proxies every other prompt as before', async () => {
    const e = ev('/prompt', prompt('veo-3.1'))
    expect(await middleware(e)).toEqual({ proxiedTo: 'http://127.0.0.1:8188/prompt' })
    expect(proxyRequest).toHaveBeenCalledTimes(1)
    // An unreadable body is left to ComfyUI.
    await middleware(ev('/prompt', 'not json'))
    expect(proxyRequest).toHaveBeenCalledTimes(2)
  })
})
