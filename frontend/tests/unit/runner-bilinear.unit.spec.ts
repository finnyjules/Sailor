/**
 * R1.4: `bilinearResize` (server/runner/pixels/resize.ts) is torch's
 * F.interpolate(mode='bilinear', align_corners=False) bit for bit, against
 * scripts/runner_values_fixtures.py → fixtures/runner-values.json `bilinear`:
 * small cases with their floats stored, and (fix round 1) cases either side of
 * torch's kernel switch at output w + h = 129 and large ones, contiguous and
 * channels-last, whose input is rebuilt from a hash and whose output is a sha256.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { bilinearResize } from '~~/server/runner/pixels/resize'
import { pixels, pixelsCore } from '~~/server/runner/pixels/core'
import { compositorCore, core } from '~~/server/runner/compositor/plane'
import { workerScript } from '~~/server/runner/compositor/worker'

interface BilinearCase {
  name: string; sw: number; sh: number; dw: number; dh: number; channels: number
  src?: string; out?: string; memory?: 'contiguous' | 'channels-last'; seed?: number; out_sha256?: string
}
const FX = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-values.json'), 'utf8')) as { bilinear: BilinearCase[] }

const f32 = (s: string) => {
  const b = Buffer.from(s, 'base64')
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
}
const bytes = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)

/** runner_values_fixtures.py hashed_src: k / 2^24, k = ((i·2654435761 + seed·40503) mod 2^32) >> 8. */
function hashedSrc(n: number, seed: number): Float32Array {
  const out = new Float32Array(n)
  const add = BigInt(seed * 40503)
  for (let i = 0; i < n; i++) {
    const k = Number(((BigInt(i) * 2654435761n + add) & 0xFFFFFFFFn) >> 8n)
    out[i] = k / 16777216
  }
  return out
}

describe('bilinearResize (torch F.interpolate, bilinear, align_corners=False)', () => {
  it('has the fixture cases, either side of w + h = 129, contiguous and channels-last', () => {
    expect(FX.bilinear).toHaveLength(39)
    const hashed = FX.bilinear.filter(c => c.out_sha256)
    expect(hashed.some(c => c.dw + c.dh === 128)).toBe(true)
    expect(hashed.some(c => c.dw + c.dh === 129)).toBe(true)
    expect(hashed.some(c => c.dw * c.dh > 1_000_000)).toBe(true)
    expect(new Set(hashed.map(c => `${c.channels} ${c.memory}`))).toEqual(new Set(['1 contiguous', '3 contiguous', '3 channels-last', '4 contiguous', '4 channels-last']))
  })

  for (const c of FX.bilinear) {
    it(`equals torch bit for bit: ${c.name}`, () => {
      const src = c.src ? f32(c.src) : hashedSrc(c.sw * c.sh * c.channels, c.seed!)
      expect(src.length).toBe(c.sw * c.sh * c.channels)
      const got = bilinearResize(src, c.sw, c.sh, c.channels, c.dw, c.dh, c.memory ?? 'contiguous')
      expect(got.length).toBe(c.dw * c.dh * c.channels)
      if (c.out) expect(bytes(got).equals(bytes(f32(c.out)))).toBe(true)
      else expect(createHash('sha256').update(bytes(got)).digest('hex')).toBe(c.out_sha256)
    })
  }

  it('above w + h = 128 torch is separable (the Frame\'s kernel, left as it is, is not)', () => {
    const c = FX.bilinear.find(x => x.dw + x.dh === 129 && x.channels === 1)!
    const src = hashedSrc(c.sw * c.sh, c.seed!)
    const frame = core.resizeBilinear({ c: 1, h: c.sh, w: c.sw, data: src }, c.dh, c.dw).data
    expect(createHash('sha256').update(bytes(frame)).digest('hex')).not.toBe(c.out_sha256)
    expect(pixels.bilinearKind(1, c.dw, c.dh, false)).toBe('separable')
    expect(pixels.bilinearKind(1, 60, 68, false)).toBe('weights')
    expect(pixels.bilinearKind(4, 517, 333, true)).toBe('weights-cl')
    expect(pixels.bilinearKind(4, 517, 333, false)).toBe('separable')
    expect(pixels.bilinearKind(4, 60, 68, false)).toBe('weights-cl')
  })

  it('the same size gives the same values back', () => {
    const src = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])
    expect([...bilinearResize(src, 3, 2, 1, 3, 2)]).toEqual([...src])
  })

  it('refuses five channels and a wrongly sized picture', () => {
    expect(() => bilinearResize(new Float32Array(5), 1, 1, 5, 2, 2)).toThrow()
    expect(() => bilinearResize(new Float32Array(3), 2, 2, 1, 2, 2)).toThrow()
  })

  it('the pixels core runs from its own source text, with nothing in scope (as the worker runs it)', () => {
    const built = new Function(`return (${pixelsCore.toString()})()`)() as ReturnType<typeof pixelsCore>
    const c = FX.bilinear.find(x => x.dw * x.dh > 1_000_000)!
    const src = hashedSrc(c.sw * c.sh, c.seed!)
    const got = built.bilinear(src, 1, c.sh, c.sw, c.dh, c.dw, false)
    expect(createHash('sha256').update(bytes(got)).digest('hex')).toBe(c.out_sha256)
  })
})

describe('esbuild guard: the pixels core survives Nitro\'s build, in the worker too', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild'))
  const src = readFileSync(fileURLToPath(new URL('../../server/runner/pixels/core.ts', import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'pixels-esbuild-'))
  const c = FX.bilinear.find(x => x.dw + x.dh === 129 && x.channels === 1)!
  const picture = { raw: true, source: 'provider', w: 2, h: 2, data: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]) }
  const alpha = new Float32Array([1, 0.5, 0.25, 0])

  it('finds an esbuild to build with', () => expect(builds.length).toBeGreaterThan(0))

  for (const esbuildDir of builds) {
    for (const minify of [false, true]) {
      it(`${esbuildDir.split('/').at(-3)} target es2019, minify ${minify}`, async () => {
        const esb = require(esbuildDir) as typeof import('esbuild')
        let code = (await esb.transform(src, { loader: 'ts', target: 'es2019', format: 'esm' })).code
        if (minify) code = (await esb.transform(code, { loader: 'js', target: 'es2019', minify: true })).code
        const file = join(dir, `core-${minify}.mjs`)
        writeFileSync(file, code)
        const mod = await import(`${pathToFileURL(file).href}?${Math.random()}`) as { pixelsCore: typeof pixelsCore }
        const built = new Function(`return (${mod.pixelsCore.toString()})()`)() as ReturnType<typeof pixelsCore>
        const got = built.bilinear(hashedSrc(c.sw * c.sh, c.seed!), 1, c.sh, c.sw, c.dh, c.dw, false)
        expect(createHash('sha256').update(bytes(got)).digest('hex')).toBe(c.out_sha256)
        const w = new Worker(workerScript(compositorCore, mod.pixelsCore), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          const l = new Uint8Array(alpha.length).map((_, i) => Math.round((1 - alpha[i]!) * 255))
          expect((await reply({ id: 1, op: 'px.clipBegin', l, mw: 2, mh: 2, w: 2, h: 2 })).error).toBeUndefined()
          const done = await reply({ id: 2, op: 'px.clip', picture: { ...picture, data: picture.data.slice() } })
          const want = pixels.clip(picture, pixels.clipBegin(l, 2, 2, 2, 2).alpha)
          expect([...done.value.px]).toEqual([...want.px])
          const ch = await reply({ id: 3, op: 'px.channel', picture: { ...picture, data: picture.data.slice() }, index: 3 })
          expect([...ch.value.scanlines]).toEqual([...pixels.channelMask16(picture, 3).scanlines])
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }
})
