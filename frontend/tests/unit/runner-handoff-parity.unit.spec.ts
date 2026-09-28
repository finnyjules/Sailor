/**
 * R3.H: a picture from a loader (LoadImage, or an Image card's own file) is
 * handed to a provider as Python hands it: `_image_tensor_to_data_url` of the
 * loader's tensor (EXIF turned, RGB; the Image card's RGBA when its file has
 * see-through pixels), against the real Python (fixtures/runner-paid-handoff.json,
 * scripts/runner_paid_fixtures.py --group handoff).
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createFakeFal, createFakeReplicate, makeKit } from './__runner__/kit'
import { wireText } from './__runner__/paidParity'
import type { ApiLink, ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { handoffView, orientOps, plainPngChunks, PICTURE_ANIMATED_SEE_THROUGH } from '~~/server/runner/pictures/handoffView'
import { PICTURE_16_BIT, PICTURE_CMYK, PICTURE_UNREADABLE } from '~~/server/runner/pictures/pythonView'
import { OVER_CAP_JPEG_QUALITY, loaderHandoffBytes, loaderHandoffs, loaderSourceOf } from '~~/server/runner/pictureHandoff'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { splitPictures } from '~~/server/runner/generators/splitLayers'
import { isReusable, requestFingerprint } from '~~/server/runner/fingerprint'
import { PICTURE_UPLOAD_CAPS, PRODUCT_SHOT_MAX_BYTES, PRODUCT_SHOT_TOO_LARGE, backupInputProblem, checkedInputFile, inputFileCaps, linkedFileCheck, pictureTooLargeWords } from '~~/server/runner/requestRules'
import { nodeCredits } from '~~/server/runner/metering'
import { RUNNER_REPLICATE_VIDEO_MODELS, RUNNER_VIDEO_MODELS } from '~~/server/runner/generators/video'
import { RUNNER_WAN3_MODELS } from '~~/server/runner/generators/wan3'
import { RUNNER_ONLY_FAL_VIDEO_MODELS } from '~~/server/runner/generators/h3MaxTurbo'
import { RUNNER_GEMINI_OMNI_FLASH_MODELS } from '~~/server/runner/generators/geminiOmniFlash'
import { RUNNER_VEO_31_LITE_MODELS } from '~~/server/runner/generators/veo31Lite'
import { RUNNER_HAPPYHORSE_11_MODELS } from '~~/server/runner/generators/happyHorse11'
import { RUNNER_GROK_IMAGINE_VIDEO_15_MODELS } from '~~/server/runner/generators/grokImagineVideo15'
import { LTX_25_FAST_ID } from '~~/server/runner/generators/ltx25Fast'
import { HAPPYHORSE_11_BACKUP_MAX_PICTURE_BYTES, HAPPYHORSE_11_ID, HAPPYHORSE_11_MAX_PICTURE_BYTES } from '~~/server/runner/generators/happyHorse11'
import { LUMA_RAY_32_ID } from '~~/server/runner/generators/lumaRay32'
import { GPT_IMAGE_25_EDIT_OPTION } from '~~/server/runner/generators/gptImage25'
import { SEEDREAM_5_PRO_EDIT_OPTION } from '~~/server/runner/generators/seedream5ProEdit'
import type { OutputFile } from '~~/server/runner/types'
import { rgbTurnedPng } from '~~/server/runner/pictures/pythonView'

/** How many times the loader view is made (fix round 2: a capped picture is encoded once a run). */
const viewCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock('~~/server/runner/pictures/handoffView', async (orig) => {
  const m = await orig<typeof import('~~/server/runner/pictures/handoffView')>()
  return { ...m, handoffView: (...a: Parameters<typeof m.handoffView>) => { viewCalls.n++; return m.handoffView(...a) } }
})

interface HandoffCase {
  name: string; file: string; filename: string; loader: 'LoadImage' | 'Image'; class_type: string; input: string
  widgets: Record<string, unknown>; answers: unknown[]
  calls: Array<{ provider: string; endpoint: string; payload: Record<string, unknown>; payload_json: string }>
  made: Record<string, { shape: number[]; sha256: string }>
  tensor_shape: number[]
  error?: { type: string; message: string }
}
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-handoff.json'), 'utf8')) as {
  cases: HandoffCase[]; files: Record<string, string>
}
const CASES = FIXTURE.cases
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))
const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex')
const fileOf = (c: HandoffCase) => b64(FIXTURE.files[c.file]!)

/** The picture Python sent in a call: its `PNG:<sha256>`, described in `made`. */
function pythonPicture(c: HandoffCase, call = 0): { shape: number[]; sha256: string } {
  const payload = c.calls[call]!.payload
  const refs = JSON.stringify(payload).match(/PNG:[0-9a-f]{64}/g) ?? []
  expect(refs).toHaveLength(1)
  return c.made[refs[0]!]!
}

/** Decoded 8-bit pixels and their numpy shape. */
async function pixelsOf(png: Uint8Array): Promise<{ shape: number[]; sha256: string }> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  return { shape: [info.height, info.width, info.channels], sha256: sha(data) }
}

/** A PNG's chunk types, in order. */
function chunkTypes(png: Uint8Array): string[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const out: string[] = []
  for (let o = 8; o < png.length; o += 12 + view.getUint32(o)) out.push(String.fromCharCode(...png.subarray(o + 4, o + 8)))
  return out
}

describe('R3.H — the loader view a provider is handed (handoffView)', () => {
  it('the fixture covers every kind the brief names, for both loaders, and Python sent a picture in every case', () => {
    const files = new Set(CASES.map(c => c.file))
    for (const want of ['a plain RGB JPEG', 'a JPEG, EXIF 3', 'a JPEG, EXIF 6', 'a JPEG, EXIF 8', 'an RGBA PNG, partly see-through',
      'a palette PNG with transparency', 'a CMYK JPEG', 'a 16-bit grey PNG', 'a 16-bit RGB PNG', 'a lossy WebP']) {
      expect(files.has(want), want).toBe(true)
    }
    for (const c of CASES) {
      expect(c.error, c.name).toBeUndefined()
      expect(c.calls, c.name).toHaveLength(1)
    }
    expect(new Set(CASES.map(c => c.loader))).toEqual(new Set(['LoadImage', 'Image']))
    expect(CASES.length).toBeGreaterThanOrEqual(60)
  })

  for (const c of CASES) {
    it(`${c.name}: decodes to Python's pixels, size and mode`, async () => {
      const bytes = fileOf(c)
      const view = await handoffView(bytes, { keepsAlpha: c.loader === 'Image' })
      const sent = view.png ?? bytes
      const want = pythonPicture(c)
      expect(await pixelsOf(sent)).toEqual(want)
      expect([view.h, view.w, view.channels]).toEqual(want.shape)
      // Python's PNG: 8-bit RGB or RGBA, no chunk but IHDR, IDAT and IEND.
      expect(chunkTypes(sent).filter(t => t !== 'IDAT')).toEqual(['IHDR', 'IEND'])
      expect(sent[24]).toBe(8)
      expect(sent[25]).toBe(want.shape[2] === 4 ? 6 : 2)
    })
  }

  it('a plain RGB PNG is sent untouched; one with a text chunk is written again without it', async () => {
    const plain = CASES.find(c => c.file === 'a plain RGB PNG' && c.loader === 'LoadImage')!
    expect((await handoffView(fileOf(plain), { keepsAlpha: false })).png).toBeNull()
    const text = CASES.find(c => c.file === 'an RGB PNG with a text chunk' && c.loader === 'Image')!
    expect(chunkTypes(fileOf(text))).toContain('tEXt')
    const view = await handoffView(fileOf(text), { keepsAlpha: true })
    expect(view.png).not.toBeNull()
    expect(chunkTypes(view.png!)).not.toContain('tEXt')
  })

  it('a written PNG is the same picture again (the view of its own output is the output)', async () => {
    for (const c of CASES.filter(x => /EXIF 6|see-through|CMYK/.test(x.file))) {
      const view = await handoffView(fileOf(c), { keepsAlpha: c.loader === 'Image' })
      const again = await handoffView(view.png ?? fileOf(c), { keepsAlpha: c.loader === 'Image' })
      expect(again.png, c.name).toBeNull()
    }
  })

  it('the raw-pixel turn equals sharp\'s own EXIF turn for every orientation', async () => {
    const w = 7
    const h = 4
    const px = new Uint8Array(w * h * 3).map((_, i) => (i * 53 + 11) % 256)
    const plain = await sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()
    for (let o = 1; o <= 8; o++) {
      const tagged = await sharp(plain).withMetadata({ orientation: o }).png().toBuffer()
      const byExif = await sharp(tagged, { autoOrient: true }).raw().toBuffer({ resolveWithObject: true })
      const ops = orientOps(o)
      let s = sharp(px, { raw: { width: w, height: h, channels: 3 } })
      if (ops.flop) s = s.flop()
      if (ops.flip) s = s.flip()
      if (ops.rotate) s = s.rotate(ops.rotate)
      const byOps = await s.raw().toBuffer({ resolveWithObject: true })
      expect([byOps.info.width, byOps.info.height], `orientation ${o}`).toEqual([byExif.info.width, byExif.info.height])
      expect(sha(byOps.data), `orientation ${o}`).toBe(sha(byExif.data))
    }
  })

  it('plainPngChunks keeps a decodable PNG', async () => {
    const png = await sharp(new Uint8Array(12).fill(9), { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer()
    expect(chunkTypes(new Uint8Array(png))).toContain('pHYs')
    const plain = plainPngChunks(new Uint8Array(png))
    expect(chunkTypes(plain)).toEqual(['IHDR', 'IDAT', 'IEND'])
    expect(await pixelsOf(plain)).toEqual(await pixelsOf(new Uint8Array(png)))
  })
})

// ── The engine: a loader's picture handed off, end to end (the kit) ──────────

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
/** The families switched on in this checkout's frontend/.env (2026-09-27), none switched on or off here. */
const LOCAL_ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>([
  'frame', 'cards', 'effects-tone', 'effects-blur', 'effects-cells', 'effects-warp', 'effects-mask', 'effects-noise', 'shader-bake',
  'live-previews', 'fal-edit', 'replicate-image', 'replicate-video', 'nano-banana-2-blend', 'nano-actions', 'ref-edits', 'restyle', 'wan-3',
  'gpt-image-2.5', 'h3-max-turbo', 'gemini-omni-flash', 'veo-3.1-lite', 'qwen-image-3', 'grok-imagine-2', 'seedream-5-pro-edit',
  'qwen-2511-angles', 'bria-product-shot', 'muse-image', 'nano-banana-2-lite', 'recraft-v4.1', 'krea-2', 'happyhorse-1.1',
  'grok-imagine-video-1.5', 'ltx-2.5-fast', 'luma-ray-3.2', 'sync-3', 'topaz-video',
] as RunnerFamily[])

/** The case's graph: its loader (LoadImage, or an Image card with its own file) → the node. */
function promptOf(c: HandoffCase): ApiPrompt {
  const loader = c.loader === 'LoadImage'
    ? { class_type: 'LoadImage', inputs: { image: c.filename, upload: 'image' } }
    : { class_type: 'Image', inputs: { image: c.filename, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } }
  return { 11: loader, 1: { class_type: c.class_type, inputs: { ...c.widgets, [c.input]: ['11', 0] } } }
}

/** A case through the engine: the upload that carried the picture, the call sent, the charge. */
async function runCase(c: HandoffCase, families: ReadonlySet<RunnerFamily>, bytes = fileOf(c)) {
  const fal = createFakeFal({ answer: () => ({ images: [{ url: 'https://f.test/handoff/edited.png' }] }) })
  const replicate = createFakeReplicate({ answer: () => 'https://f.test/handoff/edited.png' })
  const k = makeKit({ fal, replicate, deps: { families: () => families } })
  writeFileSync(join(k.root, 'input', c.filename), bytes)
  const { runId } = await k.engine.startRun({ userId: k.userId, takes: [promptOf(c)], ...START })
  await k.engine.settled(runId)
  const run = (await k.store.get(runId))!
  const sent = [...fal.submitted(), ...replicate.submitted()]
  const uploads = (k.upload.mock.calls as unknown as [Uint8Array, string][]).map(([b, name]) => ({ bytes: b, url: `https://fal.storage/${name}` }))
  return { k, run, sent, uploads }
}

/** Python's payload with its `PNG:<sha256>` in place of the link the runner sent. */
function withPythonPicture(payload: Record<string, unknown>, url: string, ref: string): unknown {
  return JSON.parse(JSON.stringify(payload).split(JSON.stringify(url).slice(1, -1)).join(ref))
}

const ON_FOR: Record<string, RunnerFamily[]> = { EditImageNode: ['cards', 'fal-edit'], RemoveObjectNode: ['cards', 'nano-actions'] }
/** LoadImage's own card refuses these before the hold (R1.3, unchanged): Python's view of them is not ported for LoadImage. */
const LOAD_IMAGE_REFUSES: Record<string, string> = {
  'a CMYK JPEG': PICTURE_CMYK, 'a CMYK JPEG, EXIF 6': PICTURE_CMYK,
  'a 16-bit grey PNG': PICTURE_16_BIT, 'a 16-bit RGB PNG': PICTURE_16_BIT, 'a 16-bit RGBA PNG, partly see-through': PICTURE_16_BIT,
}

describe('R3.H — the engine hands a loader\'s picture off as Python does (kit, fake providers)', () => {
  for (const c of CASES) {
    const refused = c.loader === 'LoadImage' ? LOAD_IMAGE_REFUSES[c.file] : undefined
    if (refused) {
      it(`${c.name}: refused before the hold, in LoadImage's own words (unchanged)`, async () => {
        const k = makeKit({ deps: { families: () => new Set(ON_FOR[c.class_type]) } })
        writeFileSync(join(k.root, 'input', c.filename), fileOf(c))
        await expect(k.engine.startRun({ userId: k.userId, takes: [promptOf(c)], ...START })).rejects.toThrow(refused)
        expect(k.ledger.hold).not.toHaveBeenCalled()
        expect(k.upload).not.toHaveBeenCalled()
      })
      continue
    }
    it(`${c.name}: the upload decodes to Python's picture; the request is Python's but for the link; charged as Python's picture is priced`, async () => {
      const { run, sent, uploads, k } = await runCase(c, new Set(ON_FOR[c.class_type]))
      expect(run.status).toBe('done')
      expect(sent).toHaveLength(1)
      const py = c.calls[0]!
      expect(sent[0]!.endpoint).toBe(py.endpoint)
      const ref = Object.keys(c.made)[0]!
      // The one picture link in the request, and the bytes uploaded for it.
      const links = JSON.stringify(sent[0]!.payload).match(/https:\/\/fal\.storage\/[^"]+/g) ?? []
      expect(links).toHaveLength(1)
      const upload = uploads.find(u => u.url === links[0])!
      expect(await pixelsOf(upload.bytes)).toEqual(c.made[ref])
      // Python's kind of file: an 8-bit RGB or RGBA PNG with no chunk but IHDR, IDAT and IEND.
      expect(chunkTypes(upload.bytes).filter(t => t !== 'IDAT')).toEqual(['IHDR', 'IEND'])
      expect([upload.bytes[24], upload.bytes[25]]).toEqual([8, c.made[ref]!.shape[2] === 4 ? 6 : 2])
      // Everything else in the request is Python's, on the wire too.
      const mine = withPythonPicture(sent[0]!.payload, links[0]!, ref) as Record<string, unknown>
      expect(mine).toEqual(py.payload)
      expect(wireText(mine)).toBe(wireText(JSON.parse(py.payload_json)))
      // The fingerprint names the bytes sent (handoff.ts: a link is remembered by the sha256 of its bytes).
      expect(k.deps.handoff.hashOf(links[0]!)).toBe(sha(upload.bytes))
      // (engine.ts fingerprintEndpoint: fal's bare endpoint, Replicate's with its service.)
      const endpoint = py.provider === 'fal' ? py.endpoint : `replicate:${py.endpoint}`
      const shaOfPicture = (u: string) => (u === links[0] ? sha(upload.bytes) : undefined)
      // (Recorded for a request that can be reused, one with a seed: Remove object sends none.)
      const fp = run.takes[0]!.nodes['1']!.fingerprint
      expect(fp).toBe(isReusable(sent[0]!.payload) ? requestFingerprint(endpoint, sent[0]!.payload, shaOfPicture) : null)
      // The price: the file's header measures as many pixels as Python's (turned) tensor has, so the charge is unchanged.
      const [h, w] = c.tensor_shape.slice(1, 3) as [number, number]
      const meta = await sharp(fileOf(c)).metadata()
      expect(meta.width! * meta.height!).toBe(w * h)
      const node = promptOf(c)['1']!
      const families = new Set(ON_FOR[c.class_type])
      expect(run.takes[0]!.nodes['1']!.credits).toBe(nodeCredits(node, w * h, families))
    })
  }
})

// ── Old against new: nothing in any request changes but the picture links ────

interface FamilyCase { class_type: string; links?: string[]; widgets: Record<string, unknown> }
const FAMILY_CASES = Object.values(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-families.json'), 'utf8')) as Record<string, FamilyCase[]>)
  .flat().filter(c => c.class_type && c.links?.length)
/** Every video model the runner plans, each with a first frame from an Image card. */
const VIDEO_IDS = [...new Set([
  ...Object.keys(RUNNER_VIDEO_MODELS), ...Object.keys(RUNNER_REPLICATE_VIDEO_MODELS), ...Object.keys(RUNNER_WAN3_MODELS),
  ...Object.keys(RUNNER_ONLY_FAL_VIDEO_MODELS), ...Object.keys(RUNNER_GEMINI_OMNI_FLASH_MODELS), ...Object.keys(RUNNER_VEO_31_LITE_MODELS),
  ...Object.keys(RUNNER_HAPPYHORSE_11_MODELS), ...Object.keys(RUNNER_GROK_IMAGINE_VIDEO_15_MODELS), LTX_25_FAST_ID, LUMA_RAY_32_ID,
])]
/** The line-up's picture-taking options the Phase B fixture has no case for. */
const LINE_UP: FamilyCase[] = [
  ...[GPT_IMAGE_25_EDIT_OPTION, SEEDREAM_5_PRO_EDIT_OPTION].map(model => ({
    class_type: 'EditImageNode', links: ['input_image'],
    widgets: { model, prompt: 'make it dusk', aspect_ratio: 'match_input_image', resolution: '1K', seed: 7, safety_tolerance: 2, prompt_upsampling: false, output_format: 'png' },
  })),
  { class_type: 'BlendSceneNode', links: ['image'], widgets: { model: 'Nano Banana 2', prompt: '', unify_lighting: true, contact_shadows: true, match_camera_look: true, preserve_identity: true, output_format: 'png', seed: 0 } },
  ...VIDEO_IDS.map(model => ({ class_type: 'GenerateVideoNode', links: ['image'], widgets: { model, prompt: 'the sea moves', aspect_ratio: '16:9', duration: '5', seed: 3, model_options: '{}' } })),
]

/** A case as a graph: each linked picture from an Image card with its own file. */
function probeGraph(c: FamilyCase): ApiPrompt {
  const p: ApiPrompt = { n: { class_type: c.class_type, inputs: { ...c.widgets } } }
  for (const name of c.links!) {
    p[`c_${name}`] = { class_type: 'Image', inputs: { image: `${name}.png`, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } }
    p.n!.inputs[name] = [`c_${name}`, 0]
  }
  return p
}

/** planNode as before R3.H (every file through toUrl) and now (a picture input through imageToUrl). */
async function oldAndNew(c: FamilyCase, families: ReadonlySet<RunnerFamily>): Promise<{ old: NodePlan | Error; now: NodePlan | Error; routed: string[] }> {
  const prompt = probeGraph(c)
  const filesFrom = (link: [string, number]): OutputFile[] => [{ filename: String(prompt[link[0]]!.inputs.image), subfolder: '', type: 'input' }]
  const routed: string[] = []
  const plan = (withImage: boolean) => planNode({
    prompt, nodeId: 'n', gateOpen: false, filesFrom, families,
    toUrl: async f => `https://fal.storage/${f.filename}`,
    ...(withImage ? { imageToUrl: async (f: OutputFile, link: ApiLink) => { routed.push(String(link[0])); return `https://NEW.storage/${f.filename}` } } : {}),
  }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  const old = await plan(false)
  const now = await plan(true)
  return { old, now, routed }
}

const requestOf = (p: NodePlan) => (p.kind === 'provider' ? { provider: p.provider, endpoint: p.endpoint, payload: p.payload, backup: p.backup ?? null, media: p.media } : { kind: p.kind })

describe('R3.H — old against new: each request is the same but for its picture links (planNode, every family on here and locally)', () => {
  for (const [label, families] of [['this checkout\'s families', LOCAL_ON], ['every family', new Set(RUNNER_FAMILIES)]] as const) {
    it(`${label}: ${FAMILY_CASES.length} Phase B cases and ${LINE_UP.length} line-up cases`, async () => {
      let provider = 0
      let withPicture = 0
      for (const c of [...FAMILY_CASES, ...LINE_UP]) {
        const { old, now, routed } = await oldAndNew(c, families)
        if (old instanceof Error || now instanceof Error) {
          // A case the runner doesn't plan (a model this switch set leaves to ComfyUI) fails the same way both times.
          expect(now instanceof Error ? now.message : null, c.class_type).toBe(old instanceof Error ? old.message : null)
          continue
        }
        // The new request is the old one with each picture's link in the NEW place: nothing else differs.
        expect(JSON.stringify(requestOf(now)).replaceAll('https://NEW.storage/', 'https://fal.storage/')).toBe(JSON.stringify(requestOf(old)))
        if (now.kind !== 'provider') continue
        provider++
        // Every linked picture the request carries went through imageToUrl (none through toUrl).
        const text = JSON.stringify(now.payload)
        for (const name of c.links!) expect(text, `${c.class_type} ${name}`).not.toContain(`https://fal.storage/${name}.png`)
        // (A model that takes no first frame sends none: nothing is handed off for it.)
        if (text.includes('https://NEW.storage/')) {
          withPicture++
          expect(routed.length).toBeGreaterThan(0)
        }
      }
      expect(provider).toBeGreaterThan(1000)
      expect(withPicture).toBeGreaterThan(1000)
    })
  }

  it('moodboard pictures are still sent as their files (Python sends them as they are)', async () => {
    const c: FamilyCase = { class_type: 'RestyleFromImageNode', links: ['content_image'], widgets: { model: 'Nano Banana 2', prompt: '', style_in: '', structure_strength: 0.5, resolution: '1K', output_format: 'png', seed: 0, style_refs: JSON.stringify({ folder: 'moodboard_1754000000000', files: ['00_a.png'] }) } }
    const { now } = await oldAndNew(c, LOCAL_ON)
    if (now instanceof Error) throw now
    const text = JSON.stringify((now as Extract<NodePlan, { kind: 'provider' }>).payload)
    expect(text).toContain('https://NEW.storage/content_image.png')
    expect(text).toContain('https://fal.storage/00_a.png')
    expect(text).not.toContain('NEW.storage/00_a.png')
  })
})

// ── Before the hold: refusals and file caps judged on what is sent ───────────

const caseOf = (file: string, loader: 'LoadImage' | 'Image', cls = 'EditImageNode') =>
  CASES.find(c => c.file === file && c.loader === loader && c.class_type === cls)!

/** An RGB picture of random noise, which PNG can't shrink: `side`² pixels. */
async function noiseJpeg(side: number): Promise<Uint8Array> {
  let x = 12345
  const px = new Uint8Array(side * side * 3).map(() => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 24))
  return new Uint8Array(await sharp(px, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 90 }).toBuffer())
}

describe('R3.H — refused before the hold, and caps judged on the PNG that is sent', () => {
  it('an Image card file Python\'s loader can\'t read is refused at the start, before anything is held or sent', async () => {
    const c = caseOf('a plain RGB JPEG', 'Image')
    const k = makeKit({ deps: { families: () => new Set<RunnerFamily>(['cards', 'fal-edit']) } })
    writeFileSync(join(k.root, 'input', c.filename), new Uint8Array([0xFF, 0xD8, 0xFF, 1, 2, 3]))
    await expect(k.engine.startRun({ userId: k.userId, takes: [promptOf(c)], ...START })).rejects.toThrow(PICTURE_UNREADABLE)
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('an animated Image card file with see-through parts is refused at the start (Python picks RGB or RGBA over every frame)', async () => {
    const frame = (a: number) => sharp(new Uint8Array(4 * 4 * 4).fill(a), { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer()
    const webp = new Uint8Array(await sharp([await frame(255), await frame(10)], { join: { animated: true } }).webp({ lossless: true }).toBuffer())
    expect((await sharp(webp).metadata()).pages).toBe(2)
    const c = { ...caseOf('a lossless WebP with alpha', 'Image') }
    const k = makeKit({ deps: { families: () => new Set<RunnerFamily>(['cards', 'fal-edit']) } })
    writeFileSync(join(k.root, 'input', c.filename), webp)
    await expect(k.engine.startRun({ userId: k.userId, takes: [promptOf(c)], ...START })).rejects.toThrow(PICTURE_ANIMATED_SEE_THROUGH)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('with `cards` off, an Image card\'s file is handed off as it is, as before R3.H (and nothing is read at the start)', async () => {
    const c = caseOf('a JPEG, EXIF 6', 'Image')
    const { run, uploads } = await runCase(c, new Set<RunnerFamily>(['fal-edit']))
    expect(run.status).toBe('done')
    expect(uploads).toHaveLength(1)
    expect(sha(uploads[0]!.bytes)).toBe(sha(fileOf(c)))
    expect(uploads[0]!.url).toBe(`https://fal.storage/${c.filename}`)
  })

  it('the node\'s turn judges a loader\'s picture on the bytes sent (and hands their size to the backup check)', async () => {
    const node = { class_type: 'ProductShotNode', inputs: { image: ['11', 0] } }
    const families = new Set<RunnerFamily>(['cards', 'bria-product-shot'])
    const file: OutputFile = { filename: 'photo.jpg', subfolder: '', type: 'input' }
    const small = new Uint8Array(100)
    const big = new Uint8Array(12_000_001)
    // The file on disk is small; what is sent is over the cap (in words about the user's picture, fix round 2).
    const over = await linkedFileCheck(node as never, () => [file], async () => small, families, async () => small.byteLength, () => Promise.resolve({ bytes: big, alpha: true }))
    expect(over).toEqual({ problem: pictureTooLargeWords('Product shot', true), bytes: big.byteLength })
    expect(over.problem).toBe('This picture has see-through parts and is too large for Product shot. Use a smaller picture, or one without see-through parts.')
    // The file on disk is over the cap; what is sent is under it.
    const under = await linkedFileCheck(node as never, () => [file], async () => big, families, async () => big.byteLength, () => Promise.resolve({ bytes: rgbPng(), alpha: false }))
    expect(under.problem).toBeNull()
    // Not a loader's picture: judged on the file, as before.
    const raw = await linkedFileCheck(node as never, () => [file], async () => big, families, async () => big.byteLength, () => null)
    expect(raw.problem).toBe(PRODUCT_SHOT_TOO_LARGE)
  })

  it('loaderHandoffs lists every picture input fed by a loader, skips an action with nothing to do, and needs `cards`', () => {
    const prompt: ApiPrompt = {
      a: { class_type: 'Image', inputs: { image: 'a.png' } },
      b: { class_type: 'LoadImage', inputs: { image: 'b.png' } },
      g: { class_type: 'ComfyGateNode', inputs: { data_in: ['a', 0], bypass: true } },
      r: { class_type: 'RelightNode', inputs: { image: ['g', 0], reference: ['b', 0], light: '{}' } },
      x: { class_type: 'RemoveObjectNode', inputs: { image: ['a', 0], target: '' } },
      m: { class_type: 'RemoveObjectNode', inputs: { image: ['a', 1], target: 'the lamp' } },
    }
    const on = new Set<RunnerFamily>(['cards', 'fal-edit', 'nano-actions'])
    expect(loaderHandoffs(prompt, on).map(h => [h.at, h.input, h.nodeId, h.kind.keepsAlpha])).toEqual([
      ['r', 'image', 'a', true], ['r', 'reference', 'b', false],
    ])
    expect(loaderHandoffs(prompt, new Set<RunnerFamily>(['fal-edit', 'nano-actions']))).toEqual([])
    expect(loaderSourceOf(prompt, ['a', 1], on)).toBeNull()
  })
})

/** A small plain RGB PNG. */
function rgbPng(): Uint8Array {
  return b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC')
}

// ── Separate background and foreground: an Image card's RGBA to the remover, its RGB to the fill ──

describe('R3.H — Separate background and foreground takes the same view', () => {
  it('an Image card with see-through pixels: the cut-out gets Python\'s RGBA, the fill its RGB', async () => {
    const c = caseOf('an RGBA PNG, partly see-through', 'Image')
    const pics = await splitPictures(fileOf(c), { keepsAlpha: true }, new AbortController().signal)
    const picture = pics.picture ?? fileOf(c)
    expect(await pixelsOf(picture)).toEqual(pythonPicture(c))
    const fill = await pixelsOf(pics.fill!)
    expect(fill.shape).toEqual([15, 23, 3])
    const rgb = await sharp(picture).removeAlpha().raw().toBuffer()
    expect(fill.sha256).toBe(sha(rgb))
  })

  it('from LoadImage the same picture is RGB for both calls', async () => {
    const c = caseOf('an RGBA PNG, partly see-through', 'LoadImage')
    const pics = await splitPictures(fileOf(c), { keepsAlpha: false }, new AbortController().signal)
    expect(pics.fill).toBe(pics.picture)
    expect(await pixelsOf(pics.picture!)).toEqual(pythonPicture(c))
  })
})

// ── Fix: JPEG over caps (controller's ruling, a departure from Python) ───────

/**
 * A 12 MP phone photo: 4032 × 3024 stored, EXIF 6 (upright 3024 × 4032), a
 * JPEG of photo-like detail whose PNG (about 36 MB) is over every cap and
 * whose quality-95 JPEG (about 5 MB) is under all of them.
 */
async function phonePhoto(w = 4032, h = 3024): Promise<Uint8Array> {
  let x = 99
  const rnd = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 16) / 65536
  const sw = Math.round(w / 8)
  const sh = Math.round(h / 8)
  const small = new Uint8Array(sw * sh * 3).map(() => Math.floor(rnd() * 256))
  const base = await sharp(small, { raw: { width: sw, height: sh, channels: 3 } }).resize(w, h, { kernel: 'cubic' }).raw().toBuffer()
  for (let i = 0; i < base.length; i++) base[i] = Math.max(0, Math.min(255, base[i]! + Math.round((rnd() - 0.5) * 10)))
  const jpg = await sharp(base, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).withMetadata({ orientation: 6 }).toBuffer()
  return new Uint8Array(jpg)
}
let PHONE: Promise<Uint8Array> | null = null
const phone = () => (PHONE ??= phonePhoto())

/** The sent JPEG is the loader's picture: upright, RGB, sRGB, no EXIF, close to the PNG's pixels (q95). */
async function expectSameUprightPicture(sent: Uint8Array, source: Uint8Array): Promise<void> {
  const meta = await sharp(sent).metadata()
  const stored = await sharp(source).metadata()
  expect([meta.format, meta.width, meta.height, meta.channels, meta.space, meta.orientation, meta.exif]).toEqual(['jpeg', stored.height, stored.width, 3, 'srgb', undefined, undefined])
  const view = await handoffView(source, { keepsAlpha: true })
  const a = await sharp(view.png!).raw().toBuffer()
  const b = await sharp(sent).raw().toBuffer()
  let diff = 0
  for (let i = 0; i < a.length; i += 97) diff += Math.abs(a[i]! - b[i]!)
  expect(diff / Math.ceil(a.length / 97)).toBeLessThan(4)
}

const productShot = (file: string): ApiPrompt => ({
  11: { class_type: 'Image', inputs: { image: file, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } },
  1: { class_type: 'ProductShotNode', inputs: { scene_prompt: 'on a table', aspect: 'Square', product_size: 'Original', keep_product_exact: true, seed: 0, image: ['11', 0] } },
})
const happyHorse = (file: string): ApiPrompt => ({
  11: { class_type: 'Image', inputs: { image: file, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } },
  1: { class_type: 'GenerateVideoNode', inputs: { model: HAPPYHORSE_11_ID, prompt: 'the sea moves', aspect_ratio: '16:9', duration: '5', seed: 3, model_options: '{}', image: ['11', 0] } },
})

describe('R3.H fix — JPEG over caps', () => {
  it('loaderHandoffBytes chooses by the caps: PNG, the JPEG of the same picture, or the PNG with the backup dropped; RGBA keeps its PNG', async () => {
    let x = 7
    const px = new Uint8Array(64 * 48 * 3).map(() => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 24))
    const src = new Uint8Array(await sharp(px, { raw: { width: 64, height: 48, channels: 3 } }).png().toBuffer())
    const P = (await loaderHandoffBytes(src, { keepsAlpha: true })).bytes.byteLength
    const J = (await sharp((await handoffView(src, { keepsAlpha: true })).png!).jpeg({ quality: OVER_CAP_JPEG_QUALITY }).toBuffer()).byteLength
    expect(J).toBeLessThan(P)
    const pick = async (cap: number, backupCap?: number) => (await loaderHandoffBytes(src, { keepsAlpha: true }, undefined, { cap, ...(backupCap ? { backupCap } : {}) })).format
    expect(await pick(P)).toBe('png')
    expect(await pick(P - 1)).toBe('jpeg')
    expect(await pick(P, J)).toBe('jpeg') // the backup stays available
    expect(await pick(P, J - 1)).toBe('png') // the PNG fits the model; the backup is dropped
    expect(await pick(J - 1)).toBe('jpeg') // over even as a JPEG: the caller refuses it
    // RGBA with see-through pixels: no JPEG, whatever the cap.
    const rgba = new Uint8Array(await sharp(new Uint8Array(64 * 48 * 4).map((_, i) => (i % 4 === 3 ? 100 : px[i % px.length]!)), { raw: { width: 64, height: 48, channels: 4 } }).png().toBuffer())
    expect((await loaderHandoffBytes(rgba, { keepsAlpha: true }, undefined, { cap: 10 })).format).toBe('png')
    // No caps: Python's PNG, as before the fix.
    expect((await loaderHandoffBytes(src, { keepsAlpha: true })).format).toBe('png')
  })

  it('a 12 MP phone JPEG into Product shot on Bria is handed off as a JPEG under 12 MB, not refused; charged as before', async () => {
    const jpeg = await phone()
    const view = await handoffView(jpeg, { keepsAlpha: true })
    expect(view.png!.byteLength).toBeGreaterThan(PRODUCT_SHOT_MAX_BYTES)
    const families = new Set<RunnerFamily>(['cards', 'bria-product-shot'])
    const k = makeKit({ fal: createFakeFal({ answer: () => ({ images: [{ url: 'https://f.test/shot.png' }] }) }), deps: { families: () => families } })
    writeFileSync(join(k.root, 'input', 'phone.jpg'), jpeg)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [productShot('phone.jpg')], ...START })
    await k.engine.settled(runId)
    const run = (await k.store.get(runId))!
    expect(run.status).toBe('done')
    expect(k.fal.submitted().map(r => r.endpoint)).toEqual(['fal-ai/bria/product-shot'])
    const [[bytes, name]] = k.upload.mock.calls as unknown as [Uint8Array, string][]
    expect(name).toBe('phone.jpg')
    expect(k.fal.submitted()[0]!.payload.image_url).toBe('https://fal.storage/phone.jpg')
    expect(bytes.byteLength).toBeLessThanOrEqual(PRODUCT_SHOT_MAX_BYTES)
    await expectSameUprightPicture(bytes, jpeg)
    // The fingerprint and reuse key follow the bytes sent; the price does not change.
    expect(k.deps.handoff.hashOf('https://fal.storage/phone.jpg')).toBe(sha(bytes))
    expect(run.takes[0]!.nodes['1']!.credits).toBe(nodeCredits(productShot('phone.jpg')['1']!, undefined, families))
  }, 120_000)

  for (const backup of [true, false]) {
    it(`a 12 MP phone JPEG into HappyHorse 1.1 (backups ${backup ? 'on' : 'off'}) is handed off as a JPEG under both caps; ${backup ? 'the Replicate backup stays' : 'nothing refused'}`, async () => {
      const jpeg = await phone()
      const families = new Set<RunnerFamily>(['cards', 'happyhorse-1.1'])
      const fal = createFakeFal({ answer: () => ({ video: { url: 'https://f.test/clip.mp4' } }) })
      const k = makeKit({ fal, deps: { families: () => families, backup: () => ({ enabled: backup, stallMs: 0 }) } })
      writeFileSync(join(k.root, 'input', 'phone.jpg'), jpeg)
      const prompt = happyHorse('phone.jpg')
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
      await k.engine.settled(runId)
      const run = (await k.store.get(runId))!
      expect(run.status).toBe('done')
      expect(fal.submitted()).toHaveLength(1)
      const [[bytes, name]] = k.upload.mock.calls as unknown as [Uint8Array, string][]
      expect(name).toBe('phone.jpg')
      expect(JSON.stringify(fal.submitted()[0]!.payload)).toContain('https://fal.storage/phone.jpg')
      expect(bytes.byteLength).toBeLessThanOrEqual(HAPPYHORSE_11_BACKUP_MAX_PICTURE_BYTES)
      expect(bytes.byteLength).toBeLessThanOrEqual(HAPPYHORSE_11_MAX_PICTURE_BYTES)
      await expectSameUprightPicture(bytes, jpeg)
      expect(k.deps.handoff.hashOf('https://fal.storage/phone.jpg')).toBe(sha(bytes))
      expect(run.takes[0]!.nodes['1']!.credits).toBe(nodeCredits(prompt['1']!, undefined, families))
      // The backup's request carries the same picture and takes its size: it is not dropped.
      const plan = await planNode({
        prompt, nodeId: '1', gateOpen: false, families, inputBytes: bytes.byteLength,
        filesFrom: () => [{ filename: 'phone.jpg', subfolder: '', type: 'input' }],
        toUrl: async f => `https://fal.storage/${f.filename}`,
      })
      if (plan.kind !== 'provider') throw new Error('HappyHorse is one provider call')
      expect(plan.backup).toBeDefined()
      expect(backupInputProblem(plan.backup!, bytes.byteLength)).toBeNull()
    }, 120_000)
  }

  it('caps: Bria 12 MB; HappyHorse 20 MB (backup 10 MB); Seedance 2.0 30 MB; Kling 3.0 50 MiB (backup 10 MB, none with elements); a wired model the smallest', () => {
    const on = new Set<RunnerFamily>(['cards', 'bria-product-shot', 'happyhorse-1.1', 'replicate-video'])
    expect(inputFileCaps('ProductShotNode', {}, on, true)).toEqual({ cap: PRODUCT_SHOT_MAX_BYTES, name: 'Product shot' })
    expect(inputFileCaps('GenerateVideoNode', { model: HAPPYHORSE_11_ID }, on, true)).toEqual({ cap: HAPPYHORSE_11_MAX_PICTURE_BYTES, backupCap: HAPPYHORSE_11_BACKUP_MAX_PICTURE_BYTES, name: 'HappyHorse 1.1' })
    // The backup's cap only while backups run (fix round 2: and only where the route has a backup).
    expect(inputFileCaps('GenerateVideoNode', { model: HAPPYHORSE_11_ID }, on, false)).toEqual({ cap: HAPPYHORSE_11_MAX_PICTURE_BYTES, name: 'HappyHorse 1.1' })
    expect(inputFileCaps('GenerateVideoNode', { model: 'seedance-2.0' }, on, true)).toEqual({ cap: 30_000_000, name: 'Seedance 2.0' })
    expect(inputFileCaps('FilmShotNode', { model: 'seedance-2.0' }, on, true)).toEqual({ cap: 30_000_000, name: 'Seedance 2.0' })
    expect(inputFileCaps('GenerateVideoNode', { model: 'kling-v3' }, on, true)).toEqual({ cap: 52_428_800, backupCap: 10_000_000, name: 'Kling 3.0' })
    expect(inputFileCaps('GenerateVideoNode', { model: 'kling-v3', model_options: JSON.stringify({ elements: [{ frontal_image_url: 'x' }] }) }, on, true)).toEqual({ cap: 52_428_800, name: 'Kling 3.0' })
    expect(inputFileCaps('GenerateVideoNode', { model: 'kling-v3' }, new Set<RunnerFamily>(['cards']), true)).toBeNull()
    expect(inputFileCaps('FilmShotNode', { model: HAPPYHORSE_11_ID }, on, true)).toBeNull()
    // A wired model: the smallest cap among the models it could pick (priced at its dearest).
    expect(inputFileCaps('GenerateVideoNode', { model: ['m', 0] }, on, true)).toEqual({ cap: HAPPYHORSE_11_MAX_PICTURE_BYTES, backupCap: 10_000_000, name: null })
    expect(inputFileCaps('GenerateVideoNode', { model: ['m', 0] }, new Set<RunnerFamily>(['cards']), false)).toEqual({ cap: 30_000_000, name: 'Seedance 2.0' })
    expect(checkedInputFile('GenerateVideoNode', on, ['m', 0])).toBe('image')
    expect(inputFileCaps('GenerateVideoNode', { model: 'veo-3.1' }, on, true)).toBeNull()
    expect(inputFileCaps('EditImageNode', { model: 'Flux 2 Pro' }, on, true)).toBeNull()
  })

  it('an Image card with see-through pixels over Bria\'s cap is refused plainly before the hold (a JPEG would lose its alpha)', async () => {
    let x = 3
    const side = 2000
    const px = new Uint8Array(side * side * 4).map((_, i) => (i % 4 === 3 ? 128 : ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 24)))
    const png = new Uint8Array(await sharp(px, { raw: { width: side, height: side, channels: 4 } }).png().toBuffer())
    expect(png.byteLength).toBeGreaterThan(PRODUCT_SHOT_MAX_BYTES)
    const k = makeKit({ deps: { families: () => new Set<RunnerFamily>(['cards', 'bria-product-shot']) } })
    writeFileSync(join(k.root, 'input', 'cutout.png'), png)
    await expect(k.engine.startRun({ userId: k.userId, takes: [productShot('cutout.png')], ...START })).rejects.toThrow(pictureTooLargeWords('Product shot', true))
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  }, 120_000)

  it('a photo over Bria\'s cap even as a JPEG is refused plainly before the hold', async () => {
    const jpeg = await noiseJpeg(4000)
    const asJpeg = await loaderHandoffBytes(jpeg, { keepsAlpha: true }, undefined, { cap: PRODUCT_SHOT_MAX_BYTES })
    expect(asJpeg.format).toBe('jpeg')
    expect(asJpeg.bytes.byteLength).toBeGreaterThan(PRODUCT_SHOT_MAX_BYTES)
    const k = makeKit({ deps: { families: () => new Set<RunnerFamily>(['cards', 'bria-product-shot']) } })
    writeFileSync(join(k.root, 'input', 'noise.jpg'), jpeg)
    await expect(k.engine.startRun({ userId: k.userId, takes: [productShot('noise.jpg')], ...START })).rejects.toThrow('This picture is too large for Product shot. Use a smaller picture.')
    expect(k.ledger.hold).not.toHaveBeenCalled()
  }, 120_000)
})

// ── Fix round 2: every stated cap, one encoder, encoded once ─────────────────

/** Where each cap is stated: the saved schema file and the words (or number) in it. */
const CAP_SOURCES: Record<string, { file: string; says: string }> = {
  'fal fal-ai/bria/product-shot': { file: 'fal/fal-ai__bria__product-shot.json', says: 'Maximum file size 12MB' },
  'fal alibaba/happy-horse/v1.1/image-to-video': { file: 'fal/alibaba__happy-horse__v1.1__image-to-video.json', says: 'Max 20 MB' },
  'replicate alibaba/happyhorse-1.1': { file: 'replicate/alibaba__happyhorse-1.1.json', says: '<=10MB each' },
  'fal bytedance/seedance-2.0/image-to-video': { file: 'fal/bytedance__seedance-2.0__image-to-video.json', says: 'Max 30 MB' },
  'fal fal-ai/kling-video/v3/pro/image-to-video': { file: 'fal/fal-ai__kling-video__v3__pro__image-to-video.json', says: '"max_file_size": 52428800' },
  'replicate kwaivgi/kling-v3-video': { file: 'replicate/kwaivgi__kling-v3-video.json', says: 'max 10MB' },
}

describe('R3.H fix round 2 — every stated picture cap', () => {
  it('each cap in PICTURE_UPLOAD_CAPS is stated in its saved schema, with the same number', () => {
    expect(Object.keys(PICTURE_UPLOAD_CAPS).sort()).toEqual(Object.keys(CAP_SOURCES).sort())
    for (const [route, { file, says }] of Object.entries(CAP_SOURCES)) {
      const text = readFileSync(join(__dirname, 'fixtures', 'provider-schemas', file), 'utf8')
      expect(text, route).toContain(says)
      const n = Number(says.match(/\d+/)![0])
      expect(PICTURE_UPLOAD_CAPS[route]!.bytes, route).toBe(n < 1000 ? n * 1_000_000 : n)
    }
  })

  it('inputFileCaps knows the route each plan takes: for every planned request with a linked picture, its caps are the table\'s for the endpoint and backup the plan sends to', async () => {
    const families = new Set(RUNNER_FAMILIES) as ReadonlySet<RunnerFamily>
    const cases: FamilyCase[] = [
      ...FAMILY_CASES, ...LINE_UP,
      ...VIDEO_IDS.flatMap(model => ['21:9', '9:16', '1:1'].map(aspect_ratio => ({ class_type: 'GenerateVideoNode', links: ['image'], widgets: { model, prompt: 'the sea moves', aspect_ratio, duration: '5', seed: 3, model_options: '{}' } }))),
      { class_type: 'ProductShotNode', links: ['image'], widgets: { scene_prompt: 'on a table', aspect: 'Square', product_size: 'Original', keep_product_exact: true, seed: 0 } },
    ]
    let capped = 0
    for (const c of cases) {
      const { now } = await oldAndNew(c, families)
      if (now instanceof Error || now.kind !== 'provider') continue
      const sendsImage = JSON.stringify(now.payload).includes('https://NEW.storage/image.png')
      const caps = inputFileCaps(c.class_type, probeGraph(c).n!.inputs, families, true)
      const primary = PICTURE_UPLOAD_CAPS[`${now.provider} ${now.endpoint}`]
      const backup = now.backup ? PICTURE_UPLOAD_CAPS[`${now.backup.provider} ${now.backup.endpoint}`] : undefined
      if (!sendsImage || !primary) {
        // A route no service caps is not checked (and its backup has no cap either).
        expect(caps, `${c.class_type} ${String(c.widgets.model)}`).toBeNull()
        expect(backup).toBeUndefined()
        continue
      }
      capped++
      expect(caps?.cap, `${c.class_type} ${String(c.widgets.model)}`).toBe(primary.bytes)
      expect(caps?.backupCap, `${c.class_type} ${String(c.widgets.model)} backup`).toBe(backup?.bytes)
    }
    expect(capped).toBeGreaterThan(10)
  })
})

describe('R3.H fix round 2 — phone photos into Seedance 2.0 and Kling 3.0', () => {
  const video = (file: string, model: string): ApiPrompt => ({
    11: { class_type: 'Image', inputs: { image: file, export: false, filename_prefix: 'ComfyUI', batch_index: -1 } },
    1: { class_type: 'GenerateVideoNode', inputs: { model, prompt: 'the sea moves', aspect_ratio: '16:9', duration: '5', seed: 3, model_options: '{}', image: ['11', 0] } },
  })
  const cases = [
    { label: 'a 24 MP phone JPEG into Seedance 2.0 image-to-video', w: 6000, h: 4000, model: 'seedance-2.0', families: ['cards'] as RunnerFamily[], cap: 30_000_000, endpoint: 'bytedance/seedance-2.0/image-to-video' },
    { label: 'a 48 MP phone JPEG into Kling 3.0 (backups on)', w: 8064, h: 6048, model: 'kling-v3', families: ['cards', 'replicate-video'] as RunnerFamily[], cap: 52_428_800, endpoint: 'fal-ai/kling-video/v3/pro/image-to-video' },
  ]
  for (const t of cases) {
    it(`${t.label}: handed off as a JPEG under the cap, not refused; encoded once; charged as before`, async () => {
      const jpeg = await phonePhoto(t.w, t.h)
      const view = await handoffView(jpeg, { keepsAlpha: true })
      expect(view.png!.byteLength).toBeGreaterThan(t.cap)
      const families = new Set<RunnerFamily>(t.families)
      const fal = createFakeFal({ answer: () => ({ video: { url: 'https://f.test/clip.mp4' } }) })
      const k = makeKit({ fal, deps: { families: () => families, backup: () => ({ enabled: true, stallMs: 0 }) } })
      writeFileSync(join(k.root, 'input', 'phone.jpg'), jpeg)
      const prompt = video('phone.jpg', t.model)
      viewCalls.n = 0
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [prompt], ...START })
      await k.engine.settled(runId)
      const run = (await k.store.get(runId))!
      expect(run.status).toBe('done')
      expect(fal.submitted().map(r => r.endpoint)).toEqual([t.endpoint])
      const [[bytes, name]] = k.upload.mock.calls as unknown as [Uint8Array, string][]
      expect(name).toBe('phone.jpg')
      expect(bytes.byteLength).toBeLessThanOrEqual(t.cap)
      // Encoded once, at the start of the run; the node's turn sends the kept bytes.
      expect(viewCalls.n).toBe(1)
      await expectSameUprightPicture(bytes, jpeg)
      const kept = Object.values(run.takes[0]!.handoffs ?? {})
      expect(kept).toHaveLength(1)
      expect(kept[0]!.format).toBe('jpeg')
      expect(kept[0]!.file.filename).toBe(`${sha(bytes)}.bin`)
      expect(k.deps.handoff.hashOf('https://fal.storage/phone.jpg')).toBe(sha(bytes))
      expect(run.takes[0]!.nodes['1']!.credits).toBe(nodeCredits(prompt['1']!, undefined, families))
    }, 180_000)
  }
})

describe('R3.H fix round 2 — one encoder of the loader view', () => {
  it('rgbTurnedPng (the LoadImage card) is handoffView without alpha, byte for byte, on every fixture file it takes', async () => {
    let n = 0
    for (const [name, b] of Object.entries(FIXTURE.files)) {
      if (LOAD_IMAGE_REFUSES[name]) continue
      const bytes = b64(b)
      const a = await rgbTurnedPng(bytes)
      const v = await handoffView(bytes, { keepsAlpha: false })
      expect(a.png === null ? null : sha(a.png), name).toBe(v.png === null ? null : sha(v.png))
      expect([a.w, a.h], name).toEqual([v.w, v.h])
      n++
    }
    expect(n).toBeGreaterThan(20)
  })
})
