/**
 * The Frame render on the runner (server/runner/compositor/) against the REAL
 * Python `CompositorNode.execute`: fixtures/runner-compositor.json, written by
 * scripts/compositor_fixtures.py with the network blocked.
 *
 * Three measurements per fixture:
 *   decode    — our decode of each picture vs the Python loader's tensor
 *               (provider download, Image card, LoadImage, LoadImage MASK);
 *   composite — renderFrame fed the PYTHON tensors vs the Python composite
 *               and protect_mask: the port on its own;
 *   end to end — renderFrame fed our own decodes, then the 8-bit PNG pixels
 *               vs the ones save_live_preview wrote.
 * Tolerances (stated once, here). The port rounds to float32 after every
 * operation torch rounds after, in torch's own order (see plane.ts), so it is
 * bit-for-bit on these fixtures (torch 2.10, arm64):
 *   decode: exact (checked to the fixtures' 16-bit storage, 1/65535);
 *   composite and protect_mask, float: max |Δ| ≤ 1e-5 (the 16-bit storage);
 *   the 8-bit PNG: identical, every value.
 * These fixtures were written on arm64 (Apple silicon). On x86, torch's own
 * kernels may fuse or order float32 operations differently, so the Python
 * result there can differ from these (and from the port) by one float32 ulp,
 * which moves at most one 8-bit level (1/255) on a value sitting on a level.
 *
 * The end-to-end test runs through the runner's own path: pictures decoded
 * one at a time as their turn comes, the pixel work on the worker thread.
 */
import { inflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { renderFrame, type FrameSources } from '~~/server/runner/compositor/render'
import { decodeLoadMask, decodePicture, encodePreviewPng, type PictureSource } from '~~/server/runner/compositor/decode'
import { plane, type Plane } from '~~/server/runner/compositor/plane'
import { renderFrameInWorker } from '~~/server/runner/compositor/worker'

interface Decoded { width: number; height: number; channels: number; data: string }
interface FixtureCase {
  name: string
  links: Record<string, [string, 'provider' | 'card' | 'load' | 'load_mask']>
  inputs: Record<string, unknown>
  width: number
  height: number
  /** The float composite; left out of large cases (their 8-bit pixels are still compared). */
  image?: string
  image8: string
  protect: string
}
const FIX = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/runner-compositor.json', import.meta.url)), 'utf8')) as {
  assets: Record<string, string>
  decoded: Record<string, Decoded>
  cases: FixtureCase[]
}

const TOL_FLOAT = 1e-5

function unpack(b64: string): Buffer {
  return inflateSync(Buffer.from(b64, 'base64'))
}
function u16(b64: string): Float64Array {
  const raw = unpack(b64)
  const out = new Float64Array(raw.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = raw.readUInt16LE(i * 2) / 65535
  return out
}
/** An HWC (or HW) array → a CHW plane. */
function hwcToPlane(values: ArrayLike<number>, h: number, w: number, c: number): Plane {
  const p = plane(c, h, w)
  const n = h * w
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) p.data[k * n + i] = values[i * c + k]!
  return p
}
/** A CHW plane → HWC values, for comparing with the fixtures. */
function planeToHwc(p: Plane): Float64Array {
  const n = p.h * p.w
  const out = new Float64Array(n * p.c)
  for (let i = 0; i < n; i++) for (let k = 0; k < p.c; k++) out[i * p.c + k] = p.data[k * n + i]!
  return out
}
function maxAbs(a: ArrayLike<number>, b: ArrayLike<number>): number {
  expect(a.length).toBe(b.length)
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!))
  return m
}
const asset = (name: string) => new Uint8Array(Buffer.from(FIX.assets[name]!, 'base64'))

async function ourDecode(name: string, via: string): Promise<Plane> {
  return via === 'load_mask' ? decodeLoadMask(asset(name)) : decodePicture(asset(name), via as PictureSource)
}
/** The Python loader's tensor; a large picture is not stored, and our decode (exact on every stored one) stands in. */
function pythonDecode(name: string, via: string): Plane | Promise<Plane> {
  const d = FIX.decoded[`${name}|${via}`]
  if (!d) return ourDecode(name, via)
  return hwcToPlane(u16(d.data), d.height, d.width, d.channels)
}

async function sourcesOf(c: FixtureCase, decode: (name: string, via: string) => Plane | Promise<Plane>): Promise<FrameSources> {
  const layers: (Plane | null)[] = Array(16).fill(null)
  const masks: (Plane | null)[] = Array(16).fill(null)
  let overlay: Plane | null = null
  let overlayMask: Plane | null = null
  for (const [input, [name, via]] of Object.entries(c.links)) {
    const p = await decode(name, via)
    const m = /^layer(\d+)(_mask)?$/.exec(input)
    if (m) (m[2] ? masks : layers)[Number(m[1]) - 1] = p
    else if (input === 'overlay') overlay = p
    else if (input === 'overlay_mask') overlayMask = p
    else throw new Error(`unknown link ${input}`)
  }
  return { layers, masks, overlay, overlayMask }
}

const report: string[] = []
afterAll(() => {
  if (process.env.COMPOSITOR_PARITY_REPORT) console.log(`\n${report.join('\n')}\n`)
})

describe('decode parity: our sharp decode vs the Python loader', () => {
  const keys = Object.keys(FIX.decoded)
  it('covers every source kind', () => {
    const vias = new Set(keys.map(k => k.split('|')[1]))
    expect([...vias].sort()).toEqual(['card', 'load', 'load_mask', 'provider'])
  })
  it.each(keys)('%s', async (key) => {
    const [name, via] = key.split('|') as [string, string]
    const d = FIX.decoded[key]!
    const ours = await ourDecode(name, via)
    expect([ours.c, ours.h, ours.w]).toEqual([d.channels, d.height, d.width])
    const err = maxAbs(planeToHwc(ours), u16(d.data))
    report.push(`decode ${key}: max |Δ| ${(err * 255).toFixed(4)}/255`)
    // PNG and JPEG alike decode to the same bytes (JPEG: libjpeg-turbo, same IDCT and upsampling, in both).
    expect(err).toBeLessThanOrEqual(1 / 65535)
  })
})

describe('composite parity: renderFrame vs CompositorNode.execute', () => {
  it('has the spread the brief asks for', () => {
    const names = FIX.cases.map(c => c.name).join('\n')
    for (const m of ['normal', 'multiply', 'screen', 'overlay', 'soft_light', 'hard_light', 'difference', 'lighten', 'darken', 'add']) {
      expect(names).toContain(`blend ${m}`)
    }
    for (const word of ['turned', 'z ', 'mask', 'explicit artboard', 'overlay', 'protect', 'cloner linear', 'cloner grid', 'cloner radial', 'vary', '16×16']) {
      expect(names).toContain(word)
    }
  })

  it.each(FIX.cases.map(c => [c.name, c] as const))('%s — the port, on the Python tensors', async (_n, c) => {
    const r = await renderFrame(c.inputs, await sourcesOf(c, pythonDecode))
    expect([r.image.h, r.image.w]).toEqual([c.height, c.width])
    const e1 = c.image ? maxAbs(planeToHwc(r.image), u16(c.image)) : 0
    const e2 = maxAbs(r.protect.data, u16(c.protect))
    report.push(`composite ${c.name}: image ${c.image ? (e1 * 255).toFixed(4) : '(8-bit only)'}/255, protect ${(e2 * 255).toFixed(4)}/255`)
    expect(e1).toBeLessThanOrEqual(TOL_FLOAT)
    expect(e2).toBeLessThanOrEqual(TOL_FLOAT)
  })

  it.each(FIX.cases.map(c => [c.name, c] as const))('%s — end to end on the worker, the 8-bit PNG', async (_n, c) => {
    const lazy = (link: [string, string] | undefined) => (link ? () => ourDecode(link[0], link[1]) : null)
    const r = await renderFrameInWorker(c.inputs, {
      layers: Array.from({ length: 16 }, (_, i) => lazy(c.links[`layer${i + 1}`])),
      masks: Array.from({ length: 16 }, (_, i) => lazy(c.links[`layer${i + 1}_mask`])),
      overlay: lazy(c.links.overlay),
      overlayMask: lazy(c.links.overlay_mask),
    })
    const png = await encodePreviewPng(r.image)
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
    expect([info.height, info.width, info.channels]).toEqual([c.height, c.width, 3])
    const want = unpack(c.image8)
    let off = 0
    let worst = 0
    for (let i = 0; i < want.length; i++) {
      const d = Math.abs(data[i]! - want[i]!)
      if (d) off++
      worst = Math.max(worst, d)
    }
    report.push(`png ${c.name}: max ${worst}/255, ${off} of ${want.length} values off`)
    expect(off).toBe(0)
  })
})
