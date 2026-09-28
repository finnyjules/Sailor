/**
 * R3.H2: a picture made in the run is handed to a provider as Python hands
 * it: `_image_tensor_to_data_url` of the tensor the node that made it hands
 * on — a provider's answer as PIL's RGBA of the download (no EXIF turn), a
 * picture the runner wrote of Python's own tensor (an alpha-dropped answer,
 * an effect's round(255·x)) as its pixels — against the real Python
 * (fixtures/runner-paid-handoff2.json, scripts/runner_paid_fixtures.py
 * --group handoff2). And nothing else in any request changes: an old-against-
 * new run of every family's cases through the kit, with a provider's picture
 * upstream.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createFakeFal, createFakeReplicate, makeKit } from './__runner__/kit'
import { readerFor, wireText } from './__runner__/paidParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { madeHandoffView, PICTURE_ANIMATED_SEE_THROUGH } from '~~/server/runner/pictures/handoffView'
import { PICTURE_GIF_SEE_THROUGH, answerRgbPng } from '~~/server/runner/pictures/pythonView'
import { loaderHandoffBytes, madeHandoffBytes, madeSourceOf } from '~~/server/runner/pictureHandoff'
import { splitPictures } from '~~/server/runner/generators/splitLayers'
import { isReusable, requestFingerprint } from '~~/server/runner/fingerprint'
import { nodeCredits } from '~~/server/runner/metering'
import { RUNNER_VIDEO_MODELS, RUNNER_REPLICATE_VIDEO_MODELS } from '~~/server/runner/generators/video'
import { GPT_IMAGE_25_EDIT_OPTION } from '~~/server/runner/generators/gptImage25'
import { SEEDREAM_5_PRO_EDIT_OPTION } from '~~/server/runner/generators/seedream5ProEdit'
import { HAPPYHORSE_11_ID } from '~~/server/runner/generators/happyHorse11'

/** Old against new: with `h2.off`, no picture is taken for one made in the run (the runner before R3.H2). */
const h2 = vi.hoisted(() => ({ off: false }))
vi.mock('~~/server/runner/pictureHandoff', async (orig) => {
  const m = await orig<typeof import('~~/server/runner/pictureHandoff')>()
  return { ...m, madeSourceOf: (...a: Parameters<typeof m.madeSourceOf>) => (h2.off ? null : m.madeSourceOf(...a)) }
})

interface PyCall { provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown>; payload_json: string }
interface Step { class_type: string; widgets: Record<string, unknown>; answers: unknown[]; calls: PyCall[]; url: string }
interface H2Case {
  name: string; kind: 'answer' | 'dropped' | 'effect'; file: string; source_file?: string; filename?: string
  loader?: 'LoadImage' | 'Image'; effect?: string; producer: Step[]
  class_type: string; input: string; widgets: Record<string, unknown>; answers: unknown[]; calls: PyCall[]
  made: Record<string, { shape: number[]; sha256: string }>; tensor_shape: number[]
}
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-handoff2.json'), 'utf8')) as {
  cases: H2Case[]; files: Record<string, string>; edited: string
}
const CASES = FIXTURE.cases
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex')
const fileBytes = (name: string) => b64(FIXTURE.files[name]!)
const EDITED = 'https://f.test/handoff/edited.png'
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

/** The picture Python sent in the case's call: its `PNG:<sha256>` ref and pixels. */
function pythonPicture(c: H2Case): { ref: string; shape: number[]; sha256: string } {
  const refs = JSON.stringify(c.calls[0]!.payload).match(/PNG:[0-9a-f]{64}/g) ?? []
  expect(refs).toHaveLength(1)
  return { ref: refs[0]!, ...c.made[refs[0]!]! }
}

async function pixelsOf(png: Uint8Array): Promise<{ shape: number[]; sha256: string }> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  return { shape: [info.height, info.width, info.channels], sha256: sha(data) }
}

function chunkTypes(png: Uint8Array): string[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const out: string[] = []
  for (let o = 8; o < png.length; o += 12 + view.getUint32(o)) out.push(String.fromCharCode(...png.subarray(o + 4, o + 8)))
  return out
}

/** Python's PNG: 8-bit, RGB (2) or RGBA (6) as the tensor, no chunk but IHDR, IDAT and IEND. */
function expectPythonsKindOfPng(png: Uint8Array, channels: number): void {
  expect(chunkTypes(png).filter(t => t !== 'IDAT')).toEqual(['IHDR', 'IEND'])
  expect([png[24], png[25]]).toEqual([8, channels === 4 ? 6 : 2])
}

/** Python's payload with its `PNG:<sha256>` in place of the link the runner sent. */
function withPythonPicture(payload: Record<string, unknown>, url: string, ref: string): unknown {
  return JSON.parse(JSON.stringify(payload).split(JSON.stringify(url).slice(1, -1)).join(ref))
}

describe('R3.H2 — the fixture', () => {
  it('covers a provider\'s answer of every file kind, an alpha-dropped answer, and effects from each source', () => {
    const kinds = new Set(CASES.map(c => c.kind))
    expect(kinds).toEqual(new Set(['answer', 'dropped', 'effect']))
    const answers = new Set(CASES.filter(c => c.kind === 'answer').map(c => c.file))
    for (const want of ['a plain RGB JPEG', 'a JPEG, EXIF 6', 'an RGBA PNG, partly see-through', 'an RGBA PNG, opaque everywhere', 'a palette PNG with transparency',
      'a grey PNG', 'a CMYK JPEG', 'a 16-bit grey PNG', 'a 16-bit RGB PNG', 'a lossy WebP', 'a lossless WebP with alpha', 'a GIF, no transparency']) {
      expect(answers.has(want), want).toBe(true)
    }
    // Python's hand-off after a download is always RGBA, never turned; after Outpaint RGB; an effect keeps its tensor's channels.
    for (const c of CASES) {
      const want = pythonPicture(c)
      expect(want.shape, c.name).toEqual(c.tensor_shape.slice(1))
      if (c.kind === 'answer') expect(want.shape[2], c.name).toBe(4)
      if (c.kind === 'dropped') expect(want.shape[2], c.name).toBe(3)
    }
    expect(CASES.filter(c => c.kind === 'effect').map(c => c.tensor_shape[3])).toContain(4)
  })
})

describe('R3.H2 — the picture a provider\'s answer is handed on as (madeHandoffView)', () => {
  for (const c of CASES.filter(x => x.kind === 'answer' && x.class_type === 'EditImageNode')) {
    it(`${c.file}: PIL's RGBA of the download (no EXIF turn), as Python's plain 8-bit PNG`, async () => {
      const bytes = fileBytes(c.file)
      const view = await madeHandoffView(bytes, 'answer')
      const sent = view.png ?? bytes
      const want = pythonPicture(c)
      expect(await pixelsOf(sent)).toEqual({ shape: want.shape, sha256: want.sha256 })
      expect([view.h, view.w, view.channels]).toEqual(want.shape)
      expectPythonsKindOfPng(sent, 4)
    })
  }
  for (const c of CASES.filter(x => x.kind === 'dropped')) {
    it(`${c.name}: the RGB the runner kept is handed on as it is`, async () => {
      const kept = await answerRgbPng(fileBytes(c.file))
      const view = await madeHandoffView(kept, 'kept')
      const sent = view.png ?? kept
      const want = pythonPicture(c)
      expect(await pixelsOf(sent)).toEqual({ shape: want.shape, sha256: want.sha256 })
      expectPythonsKindOfPng(sent, 3)
    })
  }

  it('a plain RGBA PNG answer goes untouched; a kept PNG is written again without its pHYs', async () => {
    const plain = CASES.find(c => c.file === 'an RGBA PNG, partly see-through')!
    const once = (await madeHandoffView(fileBytes(plain.file), 'answer')).png ?? fileBytes(plain.file)
    expect((await madeHandoffView(once, 'answer')).png).toBeNull()
    const kept = new Uint8Array(await sharp(new Uint8Array(12).fill(9), { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer())
    expect(chunkTypes(kept)).toContain('pHYs')
    const view = await madeHandoffView(kept, 'kept')
    expect(chunkTypes(view.png!)).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(await pixelsOf(view.png!)).toEqual(await pixelsOf(kept))
    expect(view.channels).toBe(3)
  })

  it('see-through: marked on an answer with an alpha below 255, not on an opaque one', async () => {
    expect((await madeHandoffView(fileBytes('an RGBA PNG, partly see-through'), 'answer')).seeThrough).toBe(true)
    expect((await madeHandoffView(fileBytes('a plain RGB JPEG'), 'answer')).seeThrough).toBe(false)
    expect((await madeHandoffView(fileBytes('an RGBA PNG, opaque everywhere'), 'answer')).seeThrough).toBe(false)
  })

  it('an answer PIL would read its own way is refused in plain words (a GIF whose first frame is see-through)', async () => {
    const px = new Uint8Array(4 * 4 * 4).map((_, i) => (i % 4 === 3 ? (i % 8 === 3 ? 0 : 255) : 90))
    const gif = new Uint8Array(await sharp(px, { raw: { width: 4, height: 4, channels: 4 } }).gif().toBuffer())
    await expect(madeHandoffView(gif, 'answer')).rejects.toThrow(PICTURE_GIF_SEE_THROUGH)
    expect(PICTURE_ANIMATED_SEE_THROUGH).toBeTruthy()
  })
})

// ── Which node made the picture, and how Python holds it ─────────────────────

describe('R3.H2 — madeSourceOf', () => {
  const cards = new Set<RunnerFamily>(['cards'])
  const gen = { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'x', aspect_ratio: '1:1', seed: 1, model_options: '{}' } }
  const card = (images: unknown) => ({ class_type: 'Image', inputs: { image: '', export: false, images, batch_index: -1 } })
  it('a provider\'s answer, followed back through an Image card, a Gate and an action with nothing to do', () => {
    const p: ApiPrompt = {
      g: gen, c: card(['g', 0]), gate: { class_type: 'ComfyGateNode', inputs: { data_in: ['c', 0], bypass: false } },
      a: { class_type: 'RemoveObjectNode', inputs: { image: ['gate', 0], target: '', instructions: '' } },
    }
    expect(madeSourceOf(p, ['a', 0], cards)).toEqual({ nodeId: 'g', slot: 0, classType: 'GenerateImageNode', view: 'answer' })
    // An action that makes its call hands on its own answer.
    const called: ApiPrompt = { ...p, a: { class_type: 'RemoveObjectNode', inputs: { image: ['gate', 0], target: 'the lamp', instructions: '' } } }
    expect(madeSourceOf(called, ['a', 0], cards)?.nodeId).toBe('a')
    // With `cards` off: handed off as before.
    expect(madeSourceOf(p, ['a', 0], new Set())).toBeNull()
  })

  it('kept pictures: alpha-dropped answers, the effects, the cards; Separate background and foreground by slot', () => {
    const p: ApiPrompt = {
      l: { class_type: 'LoadImage', inputs: { image: 'x.png', upload: 'image' } },
      o: { class_type: 'OutpaintImageNode', inputs: { image: ['l', 0] } },
      fl: { class_type: 'FluxLoRARemoteNode', inputs: {} },
      fm: { class_type: 'FluxMultiLoRARemoteNode', inputs: {} },
      rl: { class_type: 'RestyleWithLoRANode', inputs: {} },
      e: { class_type: 'AdjustInvert', inputs: { image: ['l', 0], amount: 0.3 } },
      s: { class_type: 'SplitPhotoLayersNode', inputs: { image: ['l', 0] } },
      em: { class_type: 'EmptyImage', inputs: {} },
      sl: { class_type: 'SmartLayout', inputs: {} },
      se: { class_type: 'ShaderEffect', inputs: {} },
      tm: { class_type: 'TextMask', inputs: {} },
      tp: { class_type: 'TextOnPath', inputs: {} },
      s3: { class_type: 'Scene3DStudio', inputs: {} },
    }
    for (const id of ['o', 'fl', 'fm', 'rl', 'e', 'em', 'sl', 'se', 'tm', 'tp']) expect(madeSourceOf(p, [id, 0], cards)?.view, id).toBe('kept')
    expect(madeSourceOf(p, ['s3', 2], cards)?.view).toBe('kept')
    expect(madeSourceOf(p, ['s', 0], cards)?.view).toBe('answer')
    expect(madeSourceOf(p, ['s', 1], cards)?.view).toBe('kept')
    // Masks and values are not pictures.
    expect(madeSourceOf(p, ['tm', 1], cards)).toBeNull()
    expect(madeSourceOf(p, ['tp', 1], cards)).toBeNull()
  })

  it('handed off as before: a loader, the Frame, Blend scene keeping a subject, Pose or Lens with no call, Seedream\'s preview, an unknown node', () => {
    const p: ApiPrompt = {
      l: { class_type: 'LoadImage', inputs: { image: 'x.png', upload: 'image' } },
      i: { class_type: 'Image', inputs: { image: 'x.png', export: false, batch_index: -1 } },
      f: { class_type: 'Compositor', inputs: {} },
      bk: { class_type: 'BlendSceneNode', inputs: { image: ['l', 0], keep_subject: ['f', 1] } },
      b: { class_type: 'BlendSceneNode', inputs: { image: ['l', 0] } },
      pm: { class_type: 'PoseMannequin', inputs: {} },
      lr: { class_type: 'LensReframe', inputs: {} },
      sd: { class_type: 'SeedreamLayerizeNode', inputs: {} },
      u: { class_type: 'SomethingElse', inputs: {} },
    }
    for (const id of ['l', 'i', 'f', 'bk', 'pm', 'lr', 'sd', 'u']) expect(madeSourceOf(p, [id, 0], cards), id).toBeNull()
    expect(madeSourceOf(p, ['b', 0], cards)?.view).toBe('answer')
    expect(madeSourceOf(p, ['pm', 0], cards, n => n === 'pm')?.view).toBe('answer')
    expect(madeSourceOf(p, ['lr', 0], cards, n => n === 'lr')?.view).toBe('answer')
  })
})

// ── The engine: a made picture handed off, end to end (the kit) ──────────────

/** The download of each URL a case serves: its producer's answer file, then the edited picture. */
function downloadsOf(c: H2Case): (url: string) => Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const byUrl = new Map<string, Uint8Array>([[EDITED, b64(FIXTURE.edited)]])
  for (const s of c.producer) byUrl.set(s.url, fileBytes(c.file))
  return async (url) => {
    const b = byUrl.get(url)
    if (!b) throw new Error(`not served: ${url}`)
    return { bytes: b, contentType: null }
  }
}

/** The case's graph, its producer wired straight in, or through an Image card and a Gate. */
function promptOf(c: H2Case, through = false): ApiPrompt {
  const p: ApiPrompt = {}
  let at: [string, number]
  if (c.kind === 'answer' || (c.kind === 'effect' && !c.loader)) {
    p.g = { class_type: 'GenerateImageNode', inputs: { ...c.producer[0]!.widgets } }
    at = ['g', 0]
  }
  else if (c.kind === 'dropped') {
    p.src = { class_type: 'Image', inputs: { image: 'source.png', export: false, filename_prefix: 'ComfyUI', batch_index: -1 } }
    p.o = { class_type: 'OutpaintImageNode', inputs: { ...c.producer[0]!.widgets, image: ['src', 0] } }
    at = ['o', 0]
  }
  else {
    p.src = c.loader === 'LoadImage'
      ? { class_type: 'LoadImage', inputs: { image: c.filename!, upload: 'image' } }
      : { class_type: 'Image', inputs: { image: c.filename!, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } }
    at = ['src', 0]
  }
  if (c.kind === 'effect') {
    p.e = { class_type: c.effect!, inputs: { image: at, ...(c.effect === 'AdjustInvert' ? { amount: 0.37 } : { exposure: 0.3 }) } }
    at = ['e', 0]
  }
  if (through) {
    p.card = { class_type: 'Image', inputs: { image: '', export: false, images: at, batch_index: -1 } }
    // (Open: it hands its picture on without waiting.)
    p.gate = { class_type: 'ComfyGateNode', inputs: { data_in: ['card', 0], bypass: true } }
    at = ['gate', 0]
  }
  p['1'] = { class_type: c.class_type, inputs: { ...c.widgets, [c.input]: at } }
  return { ...p, ...readerFor(c.class_type, '1') }
}

function familiesOf(c: H2Case): Set<RunnerFamily> {
  const f = new Set<RunnerFamily>(['cards', c.class_type === 'EditImageNode' ? 'fal-edit' : 'nano-actions'])
  if (c.kind === 'dropped') f.add('layers')
  if (c.kind === 'effect') f.add('effects-tone')
  return f
}

async function runCase(c: H2Case, through = false) {
  const fal = createFakeFal({ answer: ({ endpoint }) => (endpoint === c.producer[0]?.calls[0]?.endpoint && c.producer[0]?.class_type === 'GenerateImageNode' ? c.producer[0]!.answers[0] : { images: [{ url: EDITED }] }) })
  const replicate = createFakeReplicate({ answer: ({ model }) => (c.kind === 'dropped' && model === c.producer[0]!.calls[0]!.endpoint ? [c.producer[0]!.url] : EDITED) })
  const k = makeKit({ fal, replicate, deps: { families: () => familiesOf(c), download: downloadsOf(c) } })
  if (c.kind === 'dropped') writeFileSync(join(k.root, 'input', 'source.png'), fileBytes(c.source_file!))
  if (c.kind === 'effect' && c.loader) writeFileSync(join(k.root, 'input', c.filename!), fileBytes(c.file))
  const prompt = promptOf(c, through)
  const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
  await k.engine.settled(runId)
  const run = (await k.store.get(runId))!
  const sent = [...fal.submitted(), ...replicate.submitted()].filter(r => r.endpoint === c.calls[0]!.endpoint)
  const uploads = (k.upload.mock.calls as unknown as [Uint8Array, string][]).map(([b, name]) => ({ bytes: b, url: `https://fal.storage/${name}` }))
  return { k, run, sent, uploads, prompt }
}

describe('R3.H2 — the engine hands a made picture off as Python does (kit, fake providers)', () => {
  for (const c of CASES) {
    it(`${c.name}: the upload decodes to Python's picture; the request is Python's but for the link; charged as before`, async () => {
      const { run, sent, uploads, k, prompt } = await runCase(c)
      for (const [id, n] of Object.entries(run.takes[0]!.nodes)) expect(n.status, `${id}: ${n.error ?? ''}`).toBe('done')
      expect(sent).toHaveLength(1)
      const py = c.calls[0]!
      const want = pythonPicture(c)
      const links = JSON.stringify(sent[0]!.payload).match(/https:\/\/fal\.storage\/[^"]+/g) ?? []
      expect(links).toHaveLength(1)
      const upload = uploads.find(u => u.url === links[0])!
      expect(await pixelsOf(upload.bytes)).toEqual({ shape: want.shape, sha256: want.sha256 })
      expectPythonsKindOfPng(upload.bytes, want.shape[2]!)
      // Everything else in the request is Python's, on the wire too.
      const mine = withPythonPicture(sent[0]!.payload, links[0]!, want.ref) as Record<string, unknown>
      expect(mine).toEqual(py.payload)
      expect(wireText(mine)).toBe(wireText(JSON.parse(py.payload_json)))
      // The fingerprint names the bytes sent.
      expect(k.deps.handoff.hashOf(links[0]!)).toBe(sha(upload.bytes))
      const endpoint = py.provider === 'fal' ? py.endpoint : `replicate:${py.endpoint}`
      expect(run.takes[0]!.nodes['1']!.fingerprint).toBe(isReusable(sent[0]!.payload) ? requestFingerprint(endpoint, sent[0]!.payload, u => (u === links[0] ? sha(upload.bytes) : undefined)) : null)
      // Charged on the picture's pixel count, which the hand-off keeps (answers are never turned).
      const [h, w] = want.shape as [number, number]
      expect(run.takes[0]!.nodes['1']!.credits).toBe(nodeCredits(prompt['1']!, w * h, familiesOf(c)))
    })
  }

  it('through an Image card fed by a wire and a Gate, the same picture as straight in', async () => {
    for (const c of CASES.filter(x => x.kind === 'answer' && /see-through|CMYK JPEG$|JPEG, EXIF 6/.test(x.file) && x.class_type === 'EditImageNode')) {
      const { run, sent, uploads } = await runCase(c, true)
      expect(run.takes[0]!.nodes['1']!.status, c.name).toBe('done')
      const links = JSON.stringify(sent[0]!.payload).match(/https:\/\/fal\.storage\/[^"]+/g) ?? []
      const upload = uploads.find(u => u.url === links[0])!
      const want = pythonPicture(c)
      expect(await pixelsOf(upload.bytes), c.name).toEqual({ shape: want.shape, sha256: want.sha256 })
    }
  })

  it('an answer that is not a PNG is uploaded under its own name as a .png', async () => {
    const c = CASES.find(x => x.kind === 'answer' && x.file === 'a plain RGB JPEG' && x.class_type === 'EditImageNode')!
    const { run, uploads } = await runCase(c)
    const made = run.takes[0]!.nodes.g!.outputs[0]!.filename
    expect(made).toMatch(/\.jpe?g$/)
    expect(uploads.map(u => u.url)).toContain(`https://fal.storage/${made.replace(/\.jpe?g$/, '.png')}`)
  })

  it('with `cards` off, a provider\'s picture is handed off as its own file, as before R3.H2', async () => {
    const c = CASES.find(x => x.kind === 'answer' && x.file === 'a plain RGB JPEG' && x.class_type === 'EditImageNode')!
    const fal = createFakeFal({ answer: ({ endpoint }) => (endpoint === 'fal-ai/flux/schnell' ? c.producer[0]!.answers[0] : { images: [{ url: EDITED }] }) })
    const k = makeKit({ fal, deps: { families: () => new Set<RunnerFamily>(['fal-edit']), download: downloadsOf(c) } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [promptOf(c)], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes['1']!.status).toBe('done')
    const made = run.takes[0]!.nodes.g!.outputs[0]!.filename
    const [[bytes, name]] = (k.upload.mock.calls as unknown as [Uint8Array, string][])
    expect(name).toBe(made)
    expect(Buffer.compare(Buffer.from(bytes), Buffer.from(fileBytes(c.file)))).toBe(0)
  })
})

// ── Separate background and foreground: the same view ────────────────────────

describe('R3.H2 — Separate background and foreground takes the made picture as Python does', () => {
  it('a provider\'s answer: the cut-out gets Python\'s RGBA, the fill its RGB', async () => {
    const bytes = fileBytes('a plain RGB JPEG')
    const pics = await splitPictures(bytes, null, new AbortController().signal, 'answer')
    const view = await madeHandoffView(bytes, 'answer')
    expect(await pixelsOf(pics.picture!)).toEqual(await pixelsOf(view.png!))
    expect(pics.picture![25]).toBe(6)
    const { data } = await sharp(view.png!).raw().toBuffer({ resolveWithObject: true })
    const rgb = new Uint8Array(data.length / 4 * 3)
    for (let i = 0; i < data.length / 4; i++) rgb.set(data.subarray(i * 4, i * 4 + 3), i * 3)
    expect(await pixelsOf(pics.fill!)).toEqual({ shape: [view.h, view.w, 3], sha256: sha(rgb) })
  })
  it('a kept RGB picture: both calls get it', async () => {
    const kept = await answerRgbPng(fileBytes('a plain RGB JPEG'))
    const pics = await splitPictures(kept, null, new AbortController().signal, 'kept')
    expect(pics.picture).toBe(pics.fill)
    expect(await pixelsOf(pics.picture ?? kept)).toEqual(await pixelsOf(kept))
  })
})

// ── Caps: judged on the bytes sent; an opaque answer may go as a JPEG ────────

describe('R3.H2 — caps', () => {
  /** An RGB picture of random noise, which PNG can't shrink. */
  async function noise(side: number, fmt: 'jpeg' | 'png', alpha = false): Promise<Uint8Array> {
    let x = 12345
    const c = alpha ? 4 : 3
    const px = new Uint8Array(side * side * c).map((_, i) => (alpha && i % 4 === 3 ? (i % 8 === 3 ? 128 : 255) : ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 24)))
    const s = sharp(px, { raw: { width: side, height: side, channels: c } })
    return new Uint8Array(await (fmt === 'jpeg' ? s.jpeg({ quality: 90 }) : s.png()).toBuffer())
  }

  it('an opaque answer over a cap goes as the JPEG of the same picture (it has no alpha to lose); one with see-through pixels keeps its PNG', async () => {
    const opaque = await noise(600, 'jpeg')
    const png = await madeHandoffBytes(opaque, 'answer')
    expect(png.format).toBe('png')
    const cap = Math.floor(png.bytes.byteLength / 2)
    const jpeg = await madeHandoffBytes(opaque, 'answer', { cap })
    expect(jpeg.format).toBe('jpeg')
    expect(jpeg.bytes.byteLength).toBeLessThanOrEqual(cap)
    expect(jpeg.alpha).toBe(false)
    const meta = await sharp(jpeg.bytes).metadata()
    expect([meta.format, meta.channels, meta.width, meta.height]).toEqual(['jpeg', 3, 600, 600])
    const see = await noise(600, 'png', true)
    const kept = await madeHandoffBytes(see, 'answer', { cap: 1000 })
    expect([kept.format, kept.alpha]).toEqual(['png', true])
  })

  it('the loader\'s choice is unchanged (an Image card\'s RGBA always keeps its PNG)', async () => {
    const see = await noise(300, 'png', true)
    const got = await loaderHandoffBytes(see, { keepsAlpha: true }, undefined, { cap: 1000 })
    expect([got.format, got.alpha]).toEqual(['png', true])
    const rgb = await noise(300, 'jpeg')
    const j = await loaderHandoffBytes(rgb, { keepsAlpha: false }, undefined, { cap: 1000 })
    expect(j.format).toBe('jpeg')
  })

  it('HappyHorse 1.1: a provider\'s opaque picture whose RGBA PNG is over 20 MB goes as a JPEG, not refused; charged as before', async () => {
    const answer = await noise(3000, 'jpeg')
    const families = new Set<RunnerFamily>(['cards', 'replicate-image', 'happyhorse-1.1'])
    const fal = createFakeFal({ answer: ({ endpoint }) => (endpoint === 'fal-ai/flux/schnell' ? { images: [{ url: 'https://f.test/big.jpg' }] } : { video: { url: 'https://f.test/v.mp4' } }) })
    const k = makeKit({ fal, deps: { families: () => families, download: async url => ({ bytes: url.endsWith('.jpg') ? answer : new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), contentType: null }) } })
    const p: ApiPrompt = {
      g: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'x', aspect_ratio: '1:1', seed: 1, model_options: '{}' } },
      v: { class_type: 'GenerateVideoNode', inputs: { model: HAPPYHORSE_11_ID, prompt: 'the sea moves', aspect_ratio: '16:9', duration: '5', seed: 3, model_options: '{}', image: ['g', 0] } },
      ...readerFor('GenerateVideoNode', 'v'),
    }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.takes[0]!.nodes.v!.error ?? null).toBeNull()
    const video = fal.submitted().find(r => r.endpoint !== 'fal-ai/flux/schnell')!
    const link = (JSON.stringify(video.payload).match(/https:\/\/fal\.storage\/[^"]+/g) ?? [])[0]!
    expect(link).toMatch(/\.jpg$/)
    const [[bytes]] = (k.upload.mock.calls as unknown as [Uint8Array, string][]).filter(([, n]) => link.endsWith(n))
    expect(bytes!.byteLength).toBeLessThanOrEqual(20_000_000)
    expect((await sharp(bytes!).metadata()).channels).toBe(3)
    expect(run.takes[0]!.nodes.v!.credits).toBe(nodeCredits(p.v!, 3000 * 3000, families))
  }, 120_000)
})

// ── Old against new: nothing but the picture bytes changes ───────────────────

/** The families switched on in this checkout's frontend/.env (2026-09-28), none switched on or off here. */
const LOCAL_ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>([
  'frame', 'cards', 'effects-tone', 'effects-blur', 'effects-cells', 'effects-warp', 'effects-mask', 'effects-noise', 'shader-bake',
  'live-previews', 'fal-edit', 'replicate-image', 'replicate-video', 'nano-banana-2-blend', 'nano-actions', 'ref-edits', 'restyle', 'wan-3',
  'gpt-image-2.5', 'h3-max-turbo', 'gemini-omni-flash', 'veo-3.1-lite', 'qwen-image-3', 'grok-imagine-2', 'seedream-5-pro-edit',
  'qwen-2511-angles', 'bria-product-shot', 'muse-image', 'nano-banana-2-lite', 'recraft-v4.1', 'krea-2', 'happyhorse-1.1',
  'grok-imagine-video-1.5', 'ltx-2.5-fast', 'luma-ray-3.2', 'sync-3', 'topaz-video',
] as RunnerFamily[])
const ALL = new Set<RunnerFamily>(RUNNER_FAMILIES)

interface ProbeCase { label: string; class_type: string; links: string[]; widgets: Record<string, unknown> }
interface FamilyCase { class_type: string; links?: string[]; widgets: Record<string, unknown> }
/** Phase B's cases with a picture: every fal-edit, nano-actions, ref-edits and restyle class, model and setting it has. */
const PHASE_B: ProbeCase[] = Object.values(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-families.json'), 'utf8')) as Record<string, FamilyCase[]>)
  .flat().filter(c => c.class_type && c.links?.length)
  .map((c, i) => ({ label: `Phase B #${i} ${c.class_type} ${String(c.widgets.model)}`, class_type: c.class_type, links: c.links!, widgets: c.widgets }))
/** The line-up's picture-taking options Phase B has no case for, and Generate a video on every video model. */
const LINE_UP: ProbeCase[] = [
  ...[GPT_IMAGE_25_EDIT_OPTION, SEEDREAM_5_PRO_EDIT_OPTION].map(model => ({
    label: `line-up ${model}`, class_type: 'EditImageNode', links: ['input_image'],
    widgets: { model, prompt: 'make it dusk', aspect_ratio: 'match_input_image', resolution: '1K', seed: 7, safety_tolerance: 2, prompt_upsampling: false, output_format: 'png' },
  })),
  { label: 'line-up Blend scene', class_type: 'BlendSceneNode', links: ['image'], widgets: { model: 'Nano Banana 2', prompt: '', unify_lighting: true, contact_shadows: true, match_camera_look: true, preserve_identity: true, output_format: 'png', seed: 0 } },
  ...[...new Set([...Object.keys(RUNNER_VIDEO_MODELS), ...Object.keys(RUNNER_REPLICATE_VIDEO_MODELS)])].map(model => ({
    label: `video ${model}`, class_type: 'GenerateVideoNode', links: ['image'], widgets: { model, prompt: 'the sea moves', aspect_ratio: '16:9', duration: '5', seed: 3, model_options: '{}' },
  })),
]
/** Every R3 class that takes a picture: up to eight of its fixture cases each (their pictures wired from the made picture). */
const R3: ProbeCase[] = (() => {
  const out: ProbeCase[] = []
  for (const g of ['describe', 'repair', 'layers', 'split', 'image-extras', 'lora', 'restyle-lora', 'nano-extras', 'turntable', 'gen-3d', 'film-shot']) {
    const cases = (JSON.parse(readFileSync(join(__dirname, 'fixtures', `runner-paid-${g}.json`), 'utf8')) as { cases: Array<{ name: string; class_type: string; widgets: Record<string, unknown>; pictures?: string[]; sounds?: string[] }> }).cases
    const per = new Map<string, number>()
    for (const c of cases) {
      if (!c.pictures?.length || c.sounds?.length) continue
      const n = per.get(c.class_type) ?? 0
      if (n >= 8) continue
      per.set(c.class_type, n + 1)
      out.push({ label: `R3 ${g} · ${c.name}`, class_type: c.class_type, links: c.pictures, widgets: c.widgets })
    }
  }
  return out
})()

const PROBE_ANSWER = 'https://f.test/probe/generated.jpg'
let probeJpeg: Uint8Array | null = null
let probePng: Uint8Array | null = null

/** One probe case through the kit, old (h2.off) or new: every request after the made picture, the uploads, and each node's end. */
async function probeRun(c: ProbeCase, families: ReadonlySet<RunnerFamily>, off: boolean) {
  probeJpeg ??= new Uint8Array(await sharp(new Uint8Array(24 * 18 * 3).map((_, i) => (i * 37) % 256), { raw: { width: 24, height: 18, channels: 3 } }).jpeg({ quality: 92 }).toBuffer())
  probePng ??= new Uint8Array(await sharp(new Uint8Array(8 * 6 * 4).map((_, i) => (i * 53) % 256), { raw: { width: 8, height: 6, channels: 4 } }).png().toBuffer())
  const fal = createFakeFal({ answer: ({ endpoint }) => (endpoint === 'fal-ai/flux/schnell' ? { images: [{ url: PROBE_ANSWER }] } : { images: [{ url: 'https://f.test/probe/out.png' }], video: { url: 'https://f.test/probe/out.mp4' } }) })
  const replicate = createFakeReplicate()
  const k = makeKit({
    fal, replicate,
    deps: {
      families: () => families,
      download: async url => ({ bytes: url === PROBE_ANSWER ? probeJpeg! : url.endsWith('.mp4') ? new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]) : probePng!, contentType: null }),
    },
  })
  const p: ApiPrompt = {
    g: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 7, model_options: '{}' } },
    n: { class_type: c.class_type, inputs: { ...c.widgets } },
  }
  for (const name of c.links) p.n!.inputs[name] = ['g', 0]
  const prompt = { ...p, ...readerFor(c.class_type, 'n') }
  h2.off = off
  try {
    let started: string | Error
    try { started = (await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })).runId }
    catch (e) { started = e instanceof Error ? e : new Error(String(e)) }
    if (started instanceof Error) return { refused: started.message }
    await k.engine.settled(started)
    const run = (await k.store.get(started))!
    const all = [...fal.submitted(), ...replicate.submitted()].filter(r => r.endpoint !== 'fal-ai/flux/schnell')
    const uploads = (k.upload.mock.calls as unknown as [Uint8Array, string][]).map(([b, name]) => ({ bytes: b, name }))
    const nodes = Object.fromEntries(Object.entries(run.takes[0]!.nodes).map(([id, n]) => [id, { status: n.status, error: n.error ?? null, credits: n.credits ?? null }]))
    return { requests: all.map(r => ({ endpoint: r.endpoint, payload: r.payload })), uploads, nodes, status: run.status }
  }
  finally { h2.off = false }
}

/**
 * The made picture's links, named alike old and new: `generate_image_…` as its
 * .jpg (old) or .png (new); Separate background and foreground uploads the
 * picture it makes as `split_image.png` (the cut-out's, new; the fill's, both).
 */
const stemmed = (v: unknown) => JSON.stringify(v).replace(/https:\/\/fal\.storage\/(generate_image[^".]*\.(jpg|png)|split_image\.png)/g, 'https://fal.storage/<made>')

describe('R3.H2 — old against new: every request is the same but for the made picture\'s bytes (kit, a provider\'s picture upstream)', () => {
  const sets: Array<[string, ReadonlySet<RunnerFamily>, ProbeCase[]]> = [
    ['this checkout\'s families', LOCAL_ON, [...PHASE_B, ...LINE_UP]],
    ['every family', ALL, [...PHASE_B, ...LINE_UP, ...R3]],
  ]
  for (const [label, families, cases] of sets) {
    it(`${label}: ${cases.length} cases`, async () => {
      let sentWithPicture = 0
      let ran = 0
      for (const c of cases) {
        const old = await probeRun(c, families, true)
        const now = await probeRun(c, families, false)
        if ('refused' in old || 'refused' in now) {
          // A case the runner doesn't take under this switch set is refused the same way both times.
          expect('refused' in now ? now.refused : null, c.label).toBe('refused' in old ? old.refused : null)
          continue
        }
        ran++
        // The same nodes end the same way, with the same credits (prices go by pixel count, which is kept).
        expect(now.nodes, c.label).toEqual(old.nodes)
        expect(now.status, c.label).toBe(old.status)
        // The same requests, in order, identical but for the made picture's link extension.
        expect(stemmed(now.requests), c.label).toBe(stemmed(old.requests))
        const madeLinks = JSON.stringify(now.requests).match(/https:\/\/fal\.storage\/generate_image[^"]+/g) ?? []
        if (!madeLinks.length) continue
        sentWithPicture++
        // Old: the answer's own file. New: Python's RGBA of it, as a plain PNG.
        const oldUp = old.uploads.find(u => u.name.startsWith('generate_image'))!
        expect(Buffer.compare(Buffer.from(oldUp.bytes), Buffer.from(probeJpeg!)), c.label).toBe(0)
        for (const link of new Set(madeLinks)) {
          expect(link, c.label).toMatch(/\.png$/)
          const up = now.uploads.find(u => link.endsWith(`/${u.name}`))!
          expect(up, c.label).toBeTruthy()
          const view = await madeHandoffView(probeJpeg!, 'answer')
          expect(await pixelsOf(up.bytes), c.label).toEqual(await pixelsOf(view.png!))
          expect(up.bytes[25], c.label).toBe(6)
        }
      }
      // (Measured 2026-09-28: this checkout's families 1,388 run, 1,230 with the made picture sent; every family 1,565 and 1,395.)
      expect(ran).toBeGreaterThan(label === 'every family' ? 1500 : 1300)
      expect(sentWithPicture).toBeGreaterThan(label === 'every family' ? 1350 : 1200)
    }, 600_000)
  }
})
