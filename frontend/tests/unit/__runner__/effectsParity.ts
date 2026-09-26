/**
 * Shared helpers for the effects' parity specs (step 3, R2): the fixtures
 * written by scripts/runner_effects_fixtures.py (runner-effects-<group>.json),
 * the same synthetic pictures, the float and 8-bit comparisons of R2 rule 10,
 * and a case run through planEffect with an in-memory run (R2 rule 12).
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { expect } from 'vitest'
import sharp from 'sharp'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { planNode, type DeriveIO, type Derived, type NodePlan } from '~~/server/runner/executors'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { decodeRaw, type PictureSource } from '~~/server/runner/compositor/decode'
import type { Tensor } from '~~/server/runner/effects/core/tensor'
import { effectCores } from '~~/server/runner/effects/cores'
import { effectParams } from '~~/server/runner/effects/plan'
import { effectSchemaOf } from '#shared/runner/effects'

// ── The fixtures ─────────────────────────────────────────────────────────────

export interface FxItem {
  w: number; h: number; c: number
  f32?: string; round8?: string; trunc8?: string
  f32_sha256?: string; round8_sha256?: string; trunc8_sha256?: string
  band?: { count: number; in: string; trunc8: string; round8: string }
}
export interface FxCase {
  name: string
  class_type: string
  node_id: string
  widgets: Record<string, unknown>
  inputs: Record<string, { source: 'rgb' | 'provider' | 'card' | 'blank' | 'mask'; files: string[] }>
  hashed?: true
  error?: { type: string; message: string }
  outputs?: { kind: 'image' | 'mask'; items: FxItem[] }[]
  ui?: { images: { filename: string; subfolder: string; type: string }[]; animated: boolean[] }
  preview?: { filename: string; mode: string; w: number; h: number; px?: string; px_sha256?: string }
}
export interface FxFile {
  torch: string
  threads: number
  platform: string
  band_eps: number
  assets: Record<string, string>
  cases: FxCase[]
}

export function loadFixtures<T extends FxFile = FxFile>(group: string): T {
  return JSON.parse(readFileSync(resolve(__dirname, `../fixtures/runner-effects-${group}.json`), 'utf8')) as T
}

export const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

// ── synth: the same pictures as the fixture script ───────────────────────────

/**
 * Interleaved 8-bit pixels (scripts/runner_effects_fixtures.py `synth`):
 * gradients, texture, and on 4 channels alpha fully see-through, fully
 * opaque and partial.
 */
export function synth(w: number, h: number, channels: number, seed: number): Uint8Array {
  let s = (seed >>> 0) || 0x9E3779B9
  const next = () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s
  }
  const out = new Uint8Array(w * h * channels)
  let o = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < channels; k++) {
        if (k < 3) out[o++] = ((x * 37 + y * 11 + k * 71) & 255) ^ (next() & 31)
        else {
          const r = next()
          out[o++] = (x + y) % 5 === 0 ? 0 : (x * y) % 3 === 0 ? 255 : r & 255
        }
      }
    }
  }
  return out
}

// ── Pictures in ──────────────────────────────────────────────────────────────

/** The node that hands a picture of this source on (compositor/plan.ts pictureSourceOf reads it so). */
export function sourceNode(source: string, file: string): ApiPrompt[string] {
  switch (source) {
    case 'rgb': return { class_type: 'Compositor', inputs: {} }
    case 'provider': return { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } }
    case 'card': return { class_type: 'Image', inputs: { image: file, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } }
    case 'blank': return { class_type: 'Image', inputs: { image: '', export: false, filename_prefix: 'ComfyUI', batch_index: -1 } }
    default: throw new Error(`no source node for ${source}`)
  }
}

/** A case's prompt: a source node per input (`src_<input>`) and the effect (its node id). */
export function pictureOf(c: FxCase): { prompt: ApiPrompt; files: Record<string, Uint8Array>; filesOf: (link: [string, number]) => OutputFile[] } {
  const prompt: ApiPrompt = {}
  const files: Record<string, Uint8Array> = {}
  const wiredFiles: Record<string, string[]> = {}
  const inputs: Record<string, unknown> = { ...c.widgets }
  for (const [name, i] of Object.entries(c.inputs)) {
    const src = `src_${name}`
    prompt[src] = sourceNode(i.source, i.files[0] ?? '')
    inputs[name] = [src, 0]
    wiredFiles[src] = i.source === 'blank' ? [] : i.files
    for (const f of i.files) files[f] = b64(loadedAssets.get(c)?.[f] ?? '')
  }
  prompt[c.node_id] = { class_type: c.class_type, inputs }
  return { prompt, files, filesOf: link => (wiredFiles[link[0]] ?? []).map(filename => ({ filename, subfolder: '', type: 'input' })) }
}

/** Each case's asset table (set by `withAssets`). */
const loadedAssets = new WeakMap<FxCase, Record<string, string>>()

/** Ties the fixture file's assets to its cases (pictureOf reads them). */
export function withAssets<T extends FxFile>(fx: T): T {
  for (const c of fx.cases) loadedAssets.set(c, fx.assets)
  return fx
}

/** Each input of a case as the tensors Python held (the batch), decoded as the runner decodes it. */
export async function tensorsOf(c: FxCase): Promise<Record<string, Tensor>[]> {
  const { files } = pictureOf(c)
  const n = Math.max(1, ...Object.values(c.inputs).map(i => i.files.length))
  const out: Record<string, Tensor>[] = []
  for (let i = 0; i < n; i++) {
    const row: Record<string, Tensor> = {}
    for (const [name, inp] of Object.entries(c.inputs)) {
      const file = inp.files[inp.files.length === 1 ? 0 : i]
      const raw = inp.source === 'blank' ? await decodeRaw(null, 'blank') : await decodeRaw(files[file!]!, inp.source as PictureSource)
      row[name] = effectCores.tk.fromPicture(raw)
    }
    out.push(row)
  }
  return out
}

/** The core's op for a class (effects/table.ts EFFECTS[cls].op), in this thread. */
export function coreOp(op: string): (inp: Record<string, Tensor>, p: Record<string, unknown>) => { outputs: Tensor[]; preview: Tensor | null } {
  const [core, fn] = op.split('.') as [keyof typeof effectCores, string]
  return (effectCores[core] as unknown as Record<string, never>)[fn]
}

/** A case's widgets as the node's execute() receives them. */
export function paramsOf(c: FxCase): Record<string, unknown> {
  return effectParams(effectSchemaOf(c.class_type)!, c.widgets)
}

// ── Comparisons (R2 rule 10) ─────────────────────────────────────────────────

/** A planar C × H × W tensor as Python's H × W × C float32 bytes. */
export function interleaved(t: Tensor): Float32Array {
  const n = t.w * t.h
  const out = new Float32Array(n * t.c)
  for (let k = 0; k < t.c; k++) for (let i = 0; i < n; i++) out[i * t.c + k] = t.data[k * n + i]!
  return out
}

/** An exact result: Python's float32, bit for bit. */
export function expectExact(ts: Float32Array, pyB64: string, label = ''): void {
  const py = b64(pyB64)
  const want = new Uint32Array(py.buffer, py.byteOffset, py.byteLength / 4)
  const got = new Uint32Array(ts.buffer, ts.byteOffset, ts.length)
  expect(got.length, label).toBe(want.length)
  let bad = -1
  for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) { bad = i; break }
  expect(bad, `${label}: first float that differs (got ${ts[bad]}, want ${new Float32Array(py.buffer, py.byteOffset, py.byteLength / 4)[bad]})`).toBe(-1)
}

/** An exact hashed result: the sha256 of Python's float32 bytes. */
export function expectExactHash(ts: Float32Array, pySha: string, label = ''): void {
  expect(sha256(new Uint8Array(ts.buffer, ts.byteOffset, ts.byteLength)), label).toBe(pySha)
}

/** A hashed case's band (the fixture's packing): the in-band values' positions and Python's bytes there. */
export function bandOf(band: NonNullable<FxItem['band']>): [number, number, number][] {
  const inside = inflateSync(b64(band.in))
  const tr = inflateSync(b64(band.trunc8))
  const ro = inflateSync(b64(band.round8))
  const out: [number, number, number][] = []
  let j = 0
  for (let i = 0; i < inside.length; i++) if (inside[i]) { out.push([i, tr[j]!, ro[j]!]); j++ }
  return out
}

/**
 * A library result's 8-bit bytes: equal to Python's, except at pixels where
 * Python's float lies within eps of a quantisation boundary, where they may
 * differ by exactly one level. The band is Python's float (small cases:
 * `pyF32`) or the fixture's band list (hashed cases).
 */
export function expectBand(
  ts8: Uint8Array, py8: Uint8Array, pyF32: Float32Array | null, band: [number, number, number][] | null,
  eps: number, mode: 'trunc' | 'round', label = '',
): void {
  expect(ts8.length, label).toBe(py8.length)
  const near = new Set<number>()
  if (pyF32) {
    for (let i = 0; i < pyF32.length; i++) {
      const v = pyF32[i]! * 255
      const edge = mode === 'trunc' ? Math.round(v) : Math.floor(v) + 0.5
      if (Math.abs(v - edge) < eps) near.add(i)
    }
  }
  for (const [i] of band ?? []) near.add(i)
  let far = -1
  for (let i = 0; i < ts8.length; i++) {
    const d = Math.abs(ts8[i]! - py8[i]!)
    if (d === 0) continue
    if (d > 1 || !near.has(i)) { far = i; break }
  }
  expect(far, `${label}: first byte outside the band (got ${ts8[far]}, want ${py8[far]})`).toBe(-1)
}

// ── A case through planEffect (R2 rule 12) ───────────────────────────────────

export interface EffectRun {
  made: Derived
  bytes(f: OutputFile): Uint8Array
  previews: { filename: string; bytes: Uint8Array }[]
  kept: () => number
}

const keyOf = (f: OutputFile) => `${f.type}:${f.subfolder ? `${f.subfolder}/` : ''}${f.filename}`

/** A run's file store in memory: what a derive plan reads, keeps and previews. */
export function memoryIO(files: Record<string, Uint8Array>, nodeId: string, o: { hosted?: boolean; signal?: AbortSignal } = {}) {
  const store = new Map<string, Uint8Array>(Object.entries(files).map(([name, b]) => [`input:${name}`, b]))
  const previews: { filename: string; bytes: Uint8Array }[] = []
  let seq = 0
  const io: DeriveIO = {
    read: async (f) => {
      const b = store.get(keyOf(f))
      if (!b) throw new Error(`no such file ${keyOf(f)}`)
      return b
    },
    keep: async (bytes, ext) => {
      const f: OutputFile = { filename: `k${++seq}.${ext}`, subfolder: 'run_x', type: 'kept' }
      store.set(keyOf(f), bytes)
      return f
    },
    saveAsset: async () => { throw new Error('no assets') },
    savePreview: async () => { throw new Error('no unique previews') },
    savePreviewAs: async (bytes, { filename }) => {
      previews.push({ filename, bytes })
      const f: OutputFile = { filename, subfolder: 'sailor_runner', type: 'temp' }
      store.set(keyOf(f), bytes)
      return f
    },
    hosted: !!o.hosted,
    signal: o.signal ?? new AbortController().signal,
    nodeId,
    runWorkflow: null,
    runPrompt: {},
  }
  return { io, store, previews, kept: () => seq, bytes: (f: OutputFile) => store.get(keyOf(f))! }
}

/** Runs a case's node through planNode (so planEffect) with its pictures in a memory store. */
export async function runEffectCase(
  c: FxCase,
  o: { families: ReadonlySet<RunnerFamily>; prompt?: ApiPrompt; hosted?: boolean; signal?: AbortSignal; files?: Record<string, Uint8Array> },
): Promise<EffectRun> {
  const pic = pictureOf(c)
  const prompt = o.prompt ?? pic.prompt
  const mem = memoryIO({ ...pic.files, ...o.files }, c.node_id, { hosted: o.hosted, signal: o.signal })
  const plan: NodePlan = await planNode({
    prompt, nodeId: c.node_id, families: o.families, gateOpen: false, hosted: o.hosted,
    filesFrom: pic.filesOf, toUrl: async () => '',
  })
  expect(plan.kind).toBe('derive')
  const made = await (plan as Extract<NodePlan, { kind: 'derive' }>).derive(mem.io)
  return { made, bytes: mem.bytes, previews: mem.previews, kept: mem.kept }
}

/** The files a value carries. */
export function filesOfValue(v: RunnerValue | undefined): OutputFile[] {
  if (!v || (v.kind !== 'files' && v.kind !== 'mask')) throw new Error(`not a file value: ${JSON.stringify(v)}`)
  return v.files
}

/** A PNG's pixels as sharp reads them (its own channels). */
export async function pngPixels(bytes: Uint8Array): Promise<{ w: number; h: number; channels: number; px: Uint8Array }> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  return { w: info.width, h: info.height, channels: info.channels, px: new Uint8Array(data) }
}
