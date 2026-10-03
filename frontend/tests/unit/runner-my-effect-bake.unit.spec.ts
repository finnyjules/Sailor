/**
 * LC13: a Shader effect showing one of your own effects (a My effect) runs on
 * Sailor's runner, with no ComfyUI. The browser draws it as the canvas does
 * (tests/unit/shader-bake-browser.unit.spec.ts, the LC13 block) and names the
 * digest of the code and dials it drew with; here the server, through the
 * engine kit and the real My effects store (a temp SAILOR_DATA_DIR and a faked
 * owner registry, as my-effects-routes.unit.spec.ts), checks that digest
 * against the store before the hold: the person's own effect (hosted, two
 * accounts), at the code its frames were drawn with (a changed effect is
 * stale), and replays the frames to Save image, still and animated. Caps and
 * the hold are unchanged; nothing is compiled on the server.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { makeKit } from './__runner__/kit'
import { requireMediaTools } from './__runner__/mediaParity'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { runnerTakesNode } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
import {
  SHADER_CATALOG_VERSION, SHADER_ENGINE_WORDS, SHADER_MY_EFFECT_WORDS, aspectSize, myEffectRefOf, shaderBakeKeySync, shaderBakedText, shaderTooManyFramesWords,
} from '#shared/runner/shaderBakeKey'
import { NEEDS_LOCAL_ENGINE_SHADER_CASES } from '#shared/runner/localOnly'
import type { MyEffectRecord } from '#shared/myEffects/record'
import { SPIKE_TAKES } from '~/lib/shadergen/__eval__/spikeTakes'
import { myEffectBakeProblem, myEffectRecordDigest } from '~~/server/runner/myEffectBake'
import { __setResourceOwnersDbForTests } from '~~/server/utils/resourceOwners'
import type { RunnerValue } from '~~/server/runner/types'

// ── The My effects store: a temp data folder and a faked owner registry ─────

const CLERK_KEY = 'NUXT_CLERK_SECRET_KEY'
const savedClerk = process.env[CLERK_KEY]
const savedDataDir = process.env.SAILOR_DATA_DIR
const setHosted = () => { process.env[CLERK_KEY] = 'sk_test_hosted' }
const setLocal = () => { delete process.env[CLERK_KEY] }
const owners = new Map<string, string>()
const query = vi.fn(async (sql: string, params: unknown[] = []) => {
  const [kind, a, b] = params as string[]
  if (/INSERT INTO resource_owners/i.test(sql)) { if (!owners.has(`${kind}:${a}`)) owners.set(`${kind}:${a}`, b!); return { rows: [] } }
  if (/SELECT user_id FROM resource_owners/i.test(sql)) { const v = owners.get(`${kind}:${a}`); return { rows: v ? [{ user_id: v }] : [] } }
  if (/SELECT resource_id FROM resource_owners/i.test(sql)) return { rows: [...owners].filter(([k, u]) => k.startsWith(`${kind}:`) && u === a).map(([k]) => ({ resource_id: k.slice(kind!.length + 1) })) }
  if (/DELETE FROM resource_owners/i.test(sql)) { owners.delete(`${kind}:${a}`); return { rows: [] } }
  return { rows: [] }
})
let dataDir = ''
let store: typeof import('~~/server/utils/myEffectsStore')
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'sailor-lc13-my-effects-'))
  process.env.SAILOR_DATA_DIR = dataDir
  __setResourceOwnersDbForTests({ query })
  store = await import('~~/server/utils/myEffectsStore')
})
afterEach(() => {
  setLocal()
  owners.clear()
  rmSync(join(dataDir, 'my-effects'), { recursive: true, force: true })
})
afterAll(() => {
  __setResourceOwnersDbForTests(null)
  if (savedClerk === undefined) delete process.env[CLERK_KEY]
  else process.env[CLERK_KEY] = savedClerk
  if (savedDataDir === undefined) delete process.env.SAILOR_DATA_DIR
  else process.env.SAILOR_DATA_DIR = savedDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

const take = SPIKE_TAKES.rain![0]!
const later = SPIKE_TAKES.rain![1]!
const ID = 'mine_abcdefghijkl'
const record = (over: Partial<MyEffectRecord> = {}): MyEffectRecord => ({
  id: ID, name: 'Droplets', from: null, animated: true, generative: false, createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z',
  versions: [{ label: 'v1', body: take.body, params: take.params, values: {}, note: '', createdAt: '2026-10-03T00:00:00.000Z' }],
  ...over,
})

// ── Graphs ───────────────────────────────────────────────────────────────────

const SHADER: ReadonlySet<RunnerFamily> = new Set(['cards', 'shader-bake'])
const MEDIA_SHADER: ReadonlySet<RunnerFamily> = new Set(['cards', 'shader-bake', 'media-video'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const card = (image: string) => ({ class_type: 'Image', inputs: { image, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } })
const saveImage = (from: [string, number]) => ({ class_type: 'SaveImage', inputs: { images: from, filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: false, png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: false } })
const shaderInputs = (over: Record<string, unknown> = {}) => ({ effect: `${ID}~v1`, params: '{"u_density":12}', time: 0, duration: 0, fps: 24, seed: 42, resolution: 256, aspect: '16:9', ...over })

function pixels(w: number, h: number, c: number, seed: number): Uint8Array {
  const out = new Uint8Array(w * h * c)
  let x = seed >>> 0
  for (let i = 0; i < out.length; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24 }
  return out
}
const png = async (px: Uint8Array, w: number, h: number, c: number) => new Uint8Array(await sharp(px, { raw: { width: w, height: h, channels: c as 3 | 4 } }).png().toBuffer())
const rgbOf = (rgba: Uint8Array) => rgba.filter((_, i) => i % 4 !== 3)
const rawOf = async (bytes: Uint8Array) => {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  return { w: info.width, h: info.height, c: info.channels, px: new Uint8Array(data) }
}
const bakeNameOf = (bytes: Uint8Array) => `shader_bake_${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.png`
function put(root: string, name: string, bytes: Uint8Array) {
  const path = join(root, 'input', name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
}

/** The bake as the browser writes it: its frames, and the digest of the code and dials it drew with, under the key. */
function baked(prompt: ApiPrompt, id: string, files: string[], sources: string[], digest: string): ApiPrompt {
  const inputs = prompt[id]!.inputs
  inputs.sailor_baked = shaderBakedText(files, shaderBakeKeySync(inputs, sources, SHADER_CATALOG_VERSION, files, digest), digest)
  return prompt
}

/** A kit whose My effects are read from the real store, as server/runner/index.ts wires it. */
function kit(o: { hosted?: boolean; families?: ReadonlySet<RunnerFamily> } = {}) {
  return makeKit({ hosted: !!o.hosted, deps: { families: () => o.families ?? SHADER, myEffect: (rid, uid) => store.readMyEffect(rid, uid) } })
}

/** Image card → My effect (v1) → Save image, baked from one frame of the picture's size. */
async function stillGraph(k: ReturnType<typeof kit>, digest = myEffectRecordDigest(record(), 0)!) {
  const W = 23
  const H = 19
  put(k.root, 'src.png', await png(pixels(W, H, 3, 3), W, H, 3))
  const rgba = pixels(W, H, 4, 7)
  const bytes = await png(rgba, W, H, 4)
  put(k.root, `shader_bake/${'a'.repeat(32)}/${bakeNameOf(bytes)}`, bytes)
  const name = `shader_bake/${'a'.repeat(32)}/${bakeNameOf(bytes)}`
  const p: ApiPrompt = { 0: card('src.png'), fx: { class_type: 'ShaderEffect', inputs: { image: ['0', 0], ...shaderInputs() } }, s: saveImage(['fx', 0]) }
  return { p: baked(p, 'fx', [name], ['src.png'], digest), rgb: rgbOf(rgba), W, H }
}

const refusal = async (k: ReturnType<typeof kit>, p: ApiPrompt, userId: string | null = k.userId) =>
  k.engine.startRun({ userId, takes: [p], ...START }).then(() => null, e => e as Error & { statusCode?: number; data?: Record<string, unknown> })

describe('LC13: a My effect\'s bake is checked against the person\'s own My effects store, then replayed', () => {
  it('is no longer on the local-engine list (empty since step 4, C4)', () => {
    expect(NEEDS_LOCAL_ENGINE_SHADER_CASES).toEqual({})
    expect(myEffectRefOf(`${ID}~v3`)).toEqual({ id: ID, codeIndex: 2 })
    expect(myEffectRefOf(ID)).toEqual({ id: ID, codeIndex: 0 })
    for (const bad of ['mine_abc~v1', `${ID}~v0`, `${ID}~v1x`, 'halftone', 3]) expect(myEffectRefOf(bad), String(bad)).toBeNull()
  })

  it('a still My effect → Save image, locally: run on the runner, the baked RGB saved, nothing sent to a service', async () => {
    await store.writeMyEffect(record(), null)
    const k = kit()
    const { p, rgb, W, H } = await stillGraph(k)
    expect(runnerTakesNode(p, 'fx', SHADER)).toBe(true)
    expect(runnerTakesWorkflow(p, SHADER)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status, run.takes[0]!.nodes.fx!.error ?? '').toBe('done')
    const saved = await rawOf(new Uint8Array(readFileSync(join(k.root, 'output', 'ComfyUI_00001_.png'))))
    expect([saved.w, saved.h, saved.c]).toEqual([W, H, 3])
    expect(Buffer.compare(Buffer.from(saved.px), Buffer.from(rgb))).toBe(0)
    expect(k.fal.submitted()).toEqual([])
  })

  it('an animated generative My effect → Save image, hosted (its owner): every frame kept as one batch and saved', async () => {
    await requireMediaTools()
    setHosted()
    await store.writeMyEffect(record({ generative: true }), 'user_1')
    const k = kit({ hosted: true, families: MEDIA_SHADER })
    const { w, h } = aspectSize(256, '16:9')
    const files: string[] = []
    const rgb: Uint8Array[] = []
    for (let i = 0; i < 3; i++) {
      const rgba = pixels(w, h, 4, 100 + i)
      const bytes = await png(rgba, w, h, 4)
      const name = `shader_bake/${'b'.repeat(32)}/${bakeNameOf(bytes)}`
      put(k.root, name, bytes)
      files.push(name)
      rgb.push(rgbOf(rgba))
    }
    const p = baked({ fx: { class_type: 'ShaderEffect', inputs: shaderInputs({ duration: 0.375, fps: 8 }) }, s: saveImage(['fx', 0]) }, 'fx', files, [], myEffectRecordDigest(record(), 0)!)
    const { runId } = await k.engine.startRun({ userId: 'user_1', takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status, run.takes[0]!.nodes.fx!.error ?? '').toBe('done')
    const v = run.takes[0]!.nodes.fx!.values![0] as Extract<RunnerValue, { kind: 'frames' }>
    expect([v.kind, v.count, v.w, v.h]).toEqual(['frames', 3, w, h])
    const saved = (readdirSync(join(k.root, 'output'), { recursive: true }) as string[]).filter(f => f.endsWith('.png')).sort()
    expect(saved).toHaveLength(3)
    for (const [i, f] of saved.entries()) {
      const got = await rawOf(new Uint8Array(readFileSync(join(k.root, 'output', f))))
      expect(Buffer.compare(Buffer.from(got.px), Buffer.from(rgb[i]!)), f).toBe(0)
    }
    expect(k.fal.submitted()).toEqual([])
    expect(k.replicate.submitted()).toEqual([])
  })

  it('hosted, two accounts: someone else\'s My effect is refused plainly before the hold; the owner\'s runs', async () => {
    setHosted()
    await store.writeMyEffect(record(), 'user_1')
    const k = kit({ hosted: true })
    const { p } = await stillGraph(k)
    // Another account's project holding user_1's effect (a shared project's copy, its own bake).
    const err = await refusal(k, structuredClone(p), 'user_2')
    expect(err).toBeInstanceOf(Error)
    expect(err!.statusCode).toBe(400)
    expect(err!.data?.code).toBe('my-effect')
    expect(err!.data?.reason, 'never the engine').toBeUndefined()
    expect(err!.message).toContain(SHADER_MY_EFFECT_WORDS.missing)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    // The owner: run and done.
    const { runId } = await k.engine.startRun({ userId: 'user_1', takes: [structuredClone(p)], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    // A removed effect: the same words, for its owner too.
    await store.deleteMyEffect(ID, 'user_1')
    const gone = await refusal(k, structuredClone(p), 'user_1')
    expect(gone!.message).toContain(SHADER_MY_EFFECT_WORDS.missing)
  })

  it('the key binds the frames to the effect\'s code: changed after the bake is refused as stale; a hand-edited digest isn\'t the bake', async () => {
    await store.writeMyEffect(record(), null)
    const k = kit()
    const { p } = await stillGraph(k)
    // A new version leaves v1's bake as it was (versions are pinned by id).
    await store.writeMyEffect(record({ versions: [...record().versions, { label: 'v2', body: later.body, params: later.params, values: {}, note: '', createdAt: 'x' }] }), null)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [structuredClone(p)], ...START })
    await k.engine.settled(runId)
    expect((await k.store.get(runId))!.status).toBe('done')
    // v1's code rewritten after its frames were drawn (the record overwritten): stale, refused before the hold.
    await store.writeMyEffect(record({ versions: [{ ...record().versions[0]!, body: `${take.body}\n// edited` }] }), null)
    const stale = await refusal(k, structuredClone(p))
    expect(stale!.data?.code).toBe('my-effect')
    expect(stale!.message).toContain(SHADER_MY_EFFECT_WORDS.changed)
    // Its dials changed (a default moved): stale too.
    const dials = take.params.map((q, i) => (i === 0 ? { ...q, default: 9 } : q))
    await store.writeMyEffect(record({ versions: [{ ...record().versions[0]!, params: dials }] }), null)
    expect((await refusal(k, structuredClone(p)))!.message).toContain(SHADER_MY_EFFECT_WORDS.changed)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    // A digest swapped in by hand under the old key: not this bake (declined, not taken).
    await store.writeMyEffect(record(), null)
    const swapped = structuredClone(p)
    const b = JSON.parse(swapped.fx!.inputs.sailor_baked as string)
    swapped.fx!.inputs.sailor_baked = JSON.stringify({ ...b, source: 'f'.repeat(64) })
    expect(runnerTakesNode(swapped, 'fx', SHADER)).toBe(false)
    const declined = await refusal(k, swapped)
    expect(declined!.data?.reason).toBe(RUNNER_NOT_ELIGIBLE)
    // A setting changed after the bake: the key no longer agrees, as for any Shader effect.
    const seed = structuredClone(p)
    seed.fx!.inputs.seed = 43
    expect(runnerTakesNode(seed, 'fx', SHADER)).toBe(false)
  })

  it('one that works on a picture, with none wired: refused in the catalogue\'s words', async () => {
    await store.writeMyEffect(record(), null)
    const k = kit()
    const { w, h } = aspectSize(256, '16:9')
    const bytes = await png(pixels(w, h, 4, 1), w, h, 4)
    put(k.root, bakeNameOf(bytes), bytes)
    const p = baked({ fx: { class_type: 'ShaderEffect', inputs: shaderInputs() }, s: saveImage(['fx', 0]) }, 'fx', [bakeNameOf(bytes)], [], myEffectRecordDigest(record(), 0)!)
    const err = await refusal(k, p)
    expect(err!.message).toContain(SHADER_ENGINE_WORDS.needsPicture)
  })

  it('caps are unchanged: past the frame cap, refused before the hold in the same words (hosted 301)', async () => {
    setHosted()
    await store.writeMyEffect(record({ generative: true }), 'user_1')
    const k = kit({ hosted: true, families: MEDIA_SHADER })
    const names = Array.from({ length: 301 }, (_, i) => `shader_bake_${i.toString(16).padStart(32, '0')}.png`)
    const p = baked({ fx: { class_type: 'ShaderEffect', inputs: shaderInputs({ duration: 301 / 60, fps: 60 }) }, s: saveImage(['fx', 0]) }, 'fx', names, [], myEffectRecordDigest(record(), 0)!)
    const err = await refusal(k, p, 'user_1')
    expect(err!.data?.code).toBe('too-much-work')
    expect(err!.message).toContain(shaderTooManyFramesWords(300, false))
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('the server never compiles or runs the effect\'s code: the check reads the body as text and hashes it', async () => {
    // A body that is not GLSL at all is only text here: the digest is worked out, nothing is evaluated.
    const odd = record({ versions: [{ ...record().versions[0]!, body: 'process.exit(1); throw new Error("ran")' }] })
    expect(myEffectRecordDigest(odd, 0)).toMatch(/^[0-9a-f]{64}$/)
    const p: ApiPrompt = { fx: { class_type: 'ShaderEffect', inputs: { ...shaderInputs(), image: ['0', 0] } }, 0: card('src.png') }
    baked(p, 'fx', [`shader_bake_${'0'.repeat(32)}.png`], ['src.png'], myEffectRecordDigest(odd, 0)!)
    expect(await myEffectBakeProblem(p, 'fx', async () => odd)).toBeNull()
    // The module imports no renderer, GL or evaluator.
    const src = readFileSync(resolve(__dirname, '../../server/runner/myEffectBake.ts'), 'utf8')
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1])
    expect(imports).toEqual(['#shared/shadergen/contract', '#shared/myEffects/record', '#shared/runner/graph', '#shared/runner/shaderBakeKey'])
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\b(eval|new Function|vm\.|child_process|webgl|moderngl|getContext)\b/i)
  })
})
