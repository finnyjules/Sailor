/**
 * Shared helpers for the video effects' parity specs (step 3, R6 rule 14):
 * the fixtures written by scripts/runner_media_fixtures.py --group <g>
 * (runner-media-<g>.json), the standard frame inputs they were made from, a
 * class's whole batch made by its core on this thread (as the plan would
 * make it frame by frame), a node run through its plan with the real stores
 * and tools, and rule 12's "as before R6.1" answers.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { MEDIA_EFFECT_SCHEMAS } from '#shared/runner/mediaEffectSchemas.generated'
import { isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { pruneInvalidOutputs, runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { planNode, type DeriveIO, type Derived, type NodePlan } from '~~/server/runner/executors'
import { createEngineResultStore, type ResultStore } from '~~/server/runner/results'
import { createFileKeptBytes, type KeptBytes } from '~~/server/runner/keptBytes'
import { createFileAccess, type FileAccess } from '~~/server/runner/fileAccess'
import { filesOf } from '~~/server/runner/values'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { keepFrames, readFrames, type MediaValueIO } from '~~/server/media/values'
import { VIDEO_EFFECTS, gatherFrame, mediaEffectParams, windowSchedule } from '~~/server/runner/video/table'
import { videoCores } from '~~/server/runner/video/cores'
import type { Tensor } from '~~/server/runner/effects/core/tensor'
import { synth } from './effectsParity'

// ── The fixtures ─────────────────────────────────────────────────────────────

/** A frame batch as recorded (R6 rule 13): its shape, its float32 (T, H, W, 3; whole when small) and its 8-bit forms. */
export interface VfxBatch { count: number; w: number; h: number; f32?: string; f32_sha256: string; round8_sha256: string; trunc8_sha256: string }
export interface VfxPreview { filename: string; mode: string; w: number; h: number; sha256: string; px?: string }
export interface VfxUi { images: { filename: string; subfolder: string; type: string }[]; animated: boolean[] }
/** Speed ramp's count and source frames as Python works them out (R6.2; float32 arrays base64). */
export interface VfxRamp { N: number; src: string; lo: number[]; hi: number[]; frac: string; nearest: number[]; meanRate?: number; cum_sha256?: string; cum?: string }
export interface VfxRun {
  name: string; class_type: string; node_id: string; widgets: Record<string, unknown>; input: string
  out?: VfxBatch; ui?: VfxUi | null; preview?: VfxPreview | null; error?: string
  ramp?: VfxRamp
}
export interface VfxSavedRun { ui: VfxUi; header: { video: { w: number; h: number; codec: string; pixFmt: string; frames: number }[] }; frameCount: number; frameRate: { num: number; den: number }; duration: number; frames: string[] }
export interface VfxSaved { class_type: string; widgets: Record<string, unknown>; input: string; fps: number; x264: VfxSavedRun; openh264: VfxSavedRun }
export interface VfxFixture {
  threads: { torch: number; opencv: number }
  clips: Record<string, { frames: number; w: number; h: number; seed: number }>
  inlineValues: number
  runs: VfxRun[]
  saved: VfxSaved[]
  /** R6.1's acceptance: a clip through Load video → Get video components → Reverse → Create video → Save video. */
  acceptance?: { clip: string; fps: number; reversed: VfxBatch; x264: VfxSavedRun; openh264: VfxSavedRun }
  graphs: Record<string, ApiPrompt>
}

const FIXTURES = resolve(__dirname, '../fixtures')

export function vfxFixture(group: string): VfxFixture {
  return (JSON.parse(readFileSync(join(FIXTURES, `runner-media-${group}.json`), 'utf8')) as { cases: VfxFixture }).cases
}

export const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** A standard input's frames as rgb24 (the fixture script's VFX_CLIPS: frame i is synth(w, h, 3, seed + i)). */
export function clipFrames(fx: VfxFixture, name: string): { frames: Uint8Array[]; w: number; h: number } {
  const c = fx.clips[name]
  if (!c) throw new Error(`No standard input ${name}`)
  return { frames: Array.from({ length: c.frames }, (_, i) => synth(c.w, c.h, 3, c.seed + i)), w: c.w, h: c.h }
}

// ── The core on this thread ──────────────────────────────────────────────────

/** A planar 3 × H × W tensor as Python's H × W × 3 float32 bytes. */
export function hwc(t: Tensor): Float32Array {
  const n = t.w * t.h
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = t.data[k * n + i]!
  return out
}

const bytesOf = (a: Float32Array | Uint8Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)

function concat(list: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(list.reduce((n, f) => n + f.length, 0))
  let at = 0
  for (const f of list) { out.set(f, at); at += f.length }
  return out
}

/**
 * A class's whole output batch made by its core on this thread, frame by
 * frame as the plan makes it (./table.ts: the frames each output frame reads,
 * the state carried): its float32 (T, H, W, 3), round-8 and trunc-8 bytes.
 */
export function coreBatch(cls: string, widgets: Record<string, unknown>, input: { frames: Uint8Array[]; w: number; h: number }): { count: number; w: number; h: number; f32: Uint8Array; round8: Uint8Array; trunc8: Uint8Array } {
  const spec = VIDEO_EFFECTS[cls]!
  const params = mediaEffectParams(MEDIA_EFFECT_SCHEMAS[cls], widgets)
  const ins = [{ count: input.frames.length, w: input.w, h: input.h, exact: true }]
  const raised = spec.pythonRaises?.(params, ins)
  if (raised) throw new Error(raised)
  const out = spec.shape(params, ins)
  const [core, fn] = spec.op.split('.') as [string, string]
  const op = (videoCores as unknown as Record<string, Record<string, (...a: unknown[]) => { out: Tensor; state?: ArrayBuffer }>>)[core]![fn]!
  const tensorOf = (f: Uint8Array) => videoCores.vx.fromRgb(f, input.w, input.h)
  const through = !!spec.passThrough?.(params, ins)
  // Each output frame's inputs (rgb24) and its own params, as the plan hands them to the worker.
  const reads: { frames: Uint8Array[]; own?: Record<string, unknown> }[] = []
  if (through) for (const f of input.frames) reads.push({ frames: [f] })
  else if (spec.reads === 'held' && spec.gatherOf) {
    const at = spec.gatherOf(params, ins)
    for (let j = 0; j < out.count; j++) reads.push({ frames: [gatherFrame(input.frames, at(j), input.w, input.h)] })
  }
  else if (spec.reads === 'held') for (let j = 0; j < out.count; j++) reads.push({ frames: [input.frames[spec.heldSource ? spec.heldSource(params, ins, j) : j]!] })
  else if (spec.reads === 'window') {
    const plan = spec.windowOf!(params, ins)
    const { wins } = windowSchedule(plan, out.count, input.frames.length)
    for (let j = 0; j < out.count; j++) reads.push({ frames: wins[j]!.map(i => input.frames[i]!), ...(plan.params ? { own: plan.params(j) } : {}) })
  }
  else {
    for (let i = 0; i < input.frames.length; i++) {
      const j = spec.streamOut ? spec.streamOut(params, ins, i) : i
      if (j !== null) reads[j] = { frames: [input.frames[i]!] }
    }
  }
  const f32: Uint8Array[] = []
  const round8: Uint8Array[] = []
  const trunc8: Uint8Array[] = []
  let state: ArrayBuffer | undefined
  for (let j = 0; j < reads.length; j++) {
    const x = reads[j]!.frames.map(tensorOf)
    const r = through ? { out: x[0]! } : op(x, reads[j]!.own ? { ...params, ...reads[j]!.own } : params, state, j, reads.length)
    state = (r as { state?: ArrayBuffer }).state
    f32.push(bytesOf(hwc(r.out)).slice())
    round8.push(videoCores.vx.toRgb(r.out, 'round'))
    trunc8.push(videoCores.vx.toRgb(r.out, 'trunc'))
  }
  return { count: reads.length, w: out.w, h: out.h, f32: concat(f32), round8: concat(round8), trunc8: concat(trunc8) }
}

// ── A node through its plan, with the real stores and tools ──────────────────

export interface VfxHarness { root: string; results: ResultStore; kept: KeptBytes; access: FileAccess; hosted: boolean; userId: string | null }

export function vfxHarness(scratch: string, o: { hosted?: boolean } = {}): VfxHarness {
  const root = mkdtempSync(join(scratch, 'h-'))
  for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
  const hosted = !!o.hosted
  const results = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => hosted })
  const kept = createFileKeptBytes(join(root, 'kept'))
  return { root, results, kept, access: createFileAccess(results, kept), hosted, userId: hosted ? 'user_1' : null }
}

export const vfxRunId = (n: number) => `run_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export function mediaIo(h: VfxHarness, runId: string, signal?: AbortSignal): MediaValueIO {
  return { access: h.access, kept: h.kept, runId, userId: h.userId, hosted: h.hosted, ...(signal ? { signal } : {}) }
}

/** rgb24 frames kept as one FFV1 batch of the run (R5.2), as Get video components keeps them. */
export async function keptBatch(h: VfxHarness, runId: string, input: { frames: Uint8Array[]; w: number; h: number }): Promise<Extract<RunnerValue, { kind: 'frames' }>> {
  async function* frames() { for (const f of input.frames) yield f.slice() }
  return keepFrames(runId, frames(), input.w, input.h, mediaIo(h, runId))
}

/** Every frame of a kept batch, decoded as the next node reads it. */
export async function batchBytes(h: VfxHarness, runId: string, v: Extract<RunnerValue, { kind: 'frames' }>): Promise<Uint8Array> {
  const got: Uint8Array[] = []
  await readFrames(v, mediaIo(h, runId), async (f) => { got.push(f) })
  return concat(got)
}

export function vfxIo(h: VfxHarness, nodeId: string, runId: string, signal: AbortSignal = new AbortController().signal, assets: OutputFile[] = []): DeriveIO {
  type SaveOpts = Parameters<NonNullable<DeriveIO['saveAssetFromPath']>>[1]
  const opts = (a: SaveOpts) => ({
    userId: h.userId, prefix: a.prefix, ext: a.ext,
    ...(a.subfolder !== undefined ? { subfolder: a.subfolder } : {}),
    ...(a.folder ? { folder: a.folder } : {}),
    ...(a.counter ? { counter: a.counter } : {}),
    ...(a.exact ? { exact: true as const } : {}),
  })
  return {
    read: f => h.access.read(f),
    keep: (b, ext) => h.kept.put(runId, b, ext),
    saveAsset: async () => { throw new Error('not here') },
    saveAssetFromPath: async (path, a) => {
      const f = await h.results.saveFromPath!(path, opts(a))
      if ((a.folder ?? 'output') === 'output') assets.push(f)
      return f
    },
    savePreview: async () => { throw new Error('no unique previews') },
    savePreviewAs: (bytes, o) => h.results.savePreviewAs(bytes, { filename: o.filename, userId: h.userId }),
    hosted: h.hosted, signal, nodeId,
    runWorkflow: null, runPrompt: {},
    media: mediaIo(h, runId, signal),
  }
}

/** One node of `prompt` through its plan, reading `values` (by node id and slot). */
export async function runVfxNode(
  h: VfxHarness, prompt: ApiPrompt, id: string, values: Record<string, Record<number, RunnerValue>>,
  o: { runId: string; families: ReadonlySet<RunnerFamily>; signal?: AbortSignal; assets?: OutputFile[] },
): Promise<Derived> {
  const plan: NodePlan = await planNode({
    prompt, nodeId: id, families: o.families, gateOpen: false,
    filesFrom: l => filesOf(values[l[0]]?.[l[1]]),
    valueFrom: l => values[l[0]]?.[l[1]],
    toUrl: async () => '',
  })
  if (plan.kind !== 'derive') throw new Error(`${prompt[id]!.class_type} planned ${plan.kind}`)
  return plan.derive(vfxIo(h, id, o.runId, o.signal, o.assets))
}

/** A preview PNG as rgb24 (and its IHDR's colour type). */
export async function previewPixels(h: VfxHarness, file: { filename: string; subfolder: string; type: string }): Promise<{ px: Uint8Array; w: number; h: number; channels: number }> {
  const path = h.results.pathOf!(file as OutputFile)
  const { data, info } = await sharp(readFileSync(path)).raw().toBuffer({ resolveWithObject: true })
  return { px: new Uint8Array(data), w: info.width, h: info.height, channels: info.channels }
}

// ── Rule 12: every answer as before R6.1 ─────────────────────────────────────

/**
 * Rule 12's baseline (R6.1 fix round 1, M2): the answers of the code at
 * f0d1f7da1, before R6.1, pinned by a generator run over a `git archive` of
 * that commit (fixtures/runner-media-vfx-rule12.json): per graph and family
 * set, the hash of `invariantAnswers`; saved project graphs by their
 * prompt's hash; PICTURE_OUTPUTS whole.
 */
export interface Rule12Pin {
  commit: string
  sets: Record<string, string[]>
  pictureOutputs: Record<string, number[]>
  graphs: Record<string, { prompt: ApiPrompt; answers: Record<string, string> }>
  saved: Record<string, Record<string, string>>
}
export function rule12Pin(): Rule12Pin {
  return JSON.parse(readFileSync(join(FIXTURES, 'runner-media-vfx-rule12.json'), 'utf8')) as Rule12Pin
}
/** The pin's hash of a JSON value (sha256, 16 hex digits). */
export const hash16 = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16)

/** Rule 12's answers: runnerTakesNode, nodesNeedingEngine, outputKindsFor, valueWiresAllowed (and the workflow's). */
export function invariantAnswers(p: ApiPrompt, families: ReadonlySet<RunnerFamily>) {
  const kinds = outputKindsFor(families)
  return {
    needs: nodesNeedingEngine(p, { runnerOn: true, families, titleOf: id => id }),
    workflow: runnerTakesWorkflow(p, families),
    eligible: isRunnerEligible(p, families),
    pruned: pruneInvalidOutputs(p, families),
    nodes: Object.keys(p).map(id => [runnerTakesNode(p, id, families), valueWiresAllowed(p, id, kinds, families)]),
    kinds,
  }
}
