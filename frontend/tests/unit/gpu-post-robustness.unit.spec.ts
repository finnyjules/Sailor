import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** A WebGL2 stand-in: every method is a no-op unless overridden, constants are their names.
 *  Enough for GpuPost to init, compile, link and "draw". */
interface Stub {
  lost: boolean
  maxTex: number
  failFrag?: (src: string) => boolean
  uploads: unknown[]
  canvases: FakeCanvas[]
}
interface FakeCanvas {
  width: number; height: number
  listeners: Record<string, ((e: unknown) => void)[]>
  addEventListener(t: string, f: (e: unknown) => void): void
  getContext(kind: string): unknown
}

function makeGl(stub: Stub) {
  const shaders = new Map<object, string>()
  const own: Record<string, unknown> = {
    MAX_TEXTURE_SIZE: 'MAX_TEXTURE_SIZE',
    isContextLost: () => stub.lost,
    getParameter: (p: unknown) => (p === 'MAX_TEXTURE_SIZE' ? stub.maxTex : 0),
    createShader: () => ({}),
    shaderSource: (s: object, src: string) => { shaders.set(s, src) },
    getShaderParameter: (s: object) => !(stub.failFrag?.(shaders.get(s) ?? '')),
    getShaderInfoLog: () => "ERROR: 0:12: 'uFoo' : undeclared identifier",
    getProgramParameter: () => true,
    createProgram: () => ({}), createBuffer: () => ({}), createTexture: () => ({}),
    getUniformLocation: () => ({}), getAttribLocation: () => 0,
    texImage2D: (...a: unknown[]) => { stub.uploads.push(a[5]) },
  }
  return new Proxy(own, {
    get: (t, k: string) => (k in t ? t[k] : (/^[A-Z_0-9]+$/.test(k) ? k : () => {})),
  })
}

function install(stub: Stub) {
  vi.stubGlobal('document', {
    createElement: () => {
      const c: FakeCanvas = {
        width: 0, height: 0, listeners: {},
        addEventListener(t, f) { (this.listeners[t] ??= []).push(f) },
        getContext(kind) {
          if (kind === 'webgl2') return makeGl(stub)
          return { save() {}, restore() {}, setTransform() {}, clearRect() {}, drawImage() {} }
        },
      }
      stub.canvases.push(c)
      return c
    },
  })
}

let stub: Stub
beforeEach(() => {
  stub = { lost: false, maxTex: 4096, uploads: [], canvases: [] }
  install(stub)
  vi.resetModules()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const src = {} as CanvasImageSource

describe('GpuPost — context loss', () => {
  it('returns null and does not count a run when the context is lost, then re-inits once it is back', async () => {
    const { GpuPost } = await import('~/lib/compositor/gpuPost')
    const p = new GpuPost('frag')
    expect(p.render(src, src, 10, 10, {})).not.toBeNull()
    expect(p.runs).toBe(1)
    stub.lost = true
    expect(p.render(src, src, 10, 10, {})).toBeNull()
    expect(p.runs).toBe(1)
    stub.lost = false
    const before = stub.canvases.length
    expect(p.render(src, src, 10, 10, {})).not.toBeNull()
    expect(stub.canvases.length).toBe(before + 1)   // a fresh canvas + context
    expect(p.runs).toBe(2)
  })

  it('drops its context on webglcontextlost, so the next render re-inits', async () => {
    const { GpuPost } = await import('~/lib/compositor/gpuPost')
    const p = new GpuPost('frag')
    p.render(src, src, 10, 10, {})
    const first = stub.canvases[0]!
    expect(first.listeners.webglcontextlost?.length).toBe(1)
    first.listeners.webglcontextlost![0]!({})
    p.render(src, src, 10, 10, {})
    expect(stub.canvases.length).toBe(2)
    expect(p.runs).toBe(2)
  })

  it('a lost context is not a permanent failure — available() is true again afterwards', async () => {
    const { GpuPost } = await import('~/lib/compositor/gpuPost')
    const p = new GpuPost('frag')
    stub.lost = true
    p.render(src, src, 10, 10, {})
    stub.lost = false
    expect(p.available()).toBe(true)
  })
})

describe('GpuPost — float depth reuse', () => {
  it('uploads a float field once, again only for a new field or after the context is dropped', async () => {
    const { GpuPost } = await import('~/lib/compositor/gpuPost')
    const p = new GpuPost('frag')
    const f1 = { kind: 'float' as const, width: 2, height: 2, data: new Float32Array(4) }
    const f2 = { kind: 'float' as const, width: 2, height: 2, data: new Float32Array(4) }
    p.render(src, f1, 10, 10, {}); p.render(src, f1, 10, 10, {})
    expect(p.depthUploads).toBe(1)
    expect(p.runs).toBe(2)
    p.render(src, f2, 10, 10, {})
    expect(p.depthUploads).toBe(2)
    p.render(src, src, 10, 10, {})              // an image depth replaces the texture's contents
    p.render(src, f2, 10, 10, {})
    expect(p.depthUploads).toBe(3)
    stub.lost = true; p.render(src, f2, 10, 10, {}); stub.lost = false
    p.render(src, f2, 10, 10, {})               // fresh context: must upload again
    expect(p.depthUploads).toBe(4)
  })
})

describe('GpuPost — texture size limit', () => {
  it('returns null (layer draws plain) when either side exceeds MAX_TEXTURE_SIZE', async () => {
    const { GpuPost } = await import('~/lib/compositor/gpuPost')
    const p = new GpuPost('frag')
    stub.maxTex = 2048
    expect(p.render(src, src, 2049, 10, {})).toBeNull()
    expect(p.render(src, src, 10, 4000, {})).toBeNull()
    expect(p.runs).toBe(0)
    expect(p.render(src, src, 2048, 2048, {})).not.toBeNull()
  })
})

describe('finish availability', () => {
  it('is per kind: a Spot UV compile failure leaves Gold foil available', async () => {
    stub.failFrag = s => s.includes('uVarnishOnly')
    const f = await import('~/lib/compositor/finishPass')
    expect(f.finishAvailable('gold_foil')).toBe(true)
    expect(f.finishAvailable('spot_uv')).toBe(false)
    expect(f.finishUnavailableReason('gold_foil')).toBe('')
  })

  it('tells the person a plain sentence, never the raw GLSL log', async () => {
    stub.failFrag = s => s.includes('uVarnishOnly')
    const f = await import('~/lib/compositor/finishPass')
    const r = f.finishUnavailableReason('spot_uv')
    expect(r).toBe("Finishes need WebGL 2, which this browser can't provide right now.")
    expect(r).not.toMatch(/ERROR|shader|undeclared/)
  })
})

describe('applyFinish', () => {
  it('uploads the layer once — depth is a shared 1×1 stand-in, not the layer again', async () => {
    const f = await import('~/lib/compositor/finishPass')
    const off = document.createElement('canvas') as unknown as FakeCanvas
    off.width = 40; off.height = 30
    stub.uploads.length = 0
    const ok = f.applyFinish(off as unknown as HTMLCanvasElement, 'gold_foil', { metal: 'gold', brushed: 0.5, pressed: 0.5, grain: 0.4 }, { x: 0.2, y: 0.1, height: 0.6 }, 1)
    expect(ok).toBe(true)
    expect(stub.uploads.filter(u => u === off).length).toBe(1)
    const depth = stub.uploads.find(u => u !== off) as FakeCanvas
    expect([depth.width, depth.height]).toEqual([1, 1])
  })
})
