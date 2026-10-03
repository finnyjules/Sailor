/**
 * GET /object_info served by Sailor (server/native/objectInfo.ts), driven
 * through the native dispatcher in a real h3 app against a temp data root.
 *
 *   Sailor's node catalogue (step 4, C6: the only source — no engine, no
 *   saved engine copy), with the upload-widget and LoRA-picker lists rebuilt
 *   from disk; hosted → the tenant scrub still applies.
 *
 * `fetch` is stubbed in every test, so nothing here can reach anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { __setInputUploadsDbForTests, __setInputUploadsEngineRootForTests } from '../../server/utils/inputUploads'
import { nativeEngineRoute } from '../../server/native/router'
import {
  MODEL_INPUT_LISTS,
  NODE_CATALOG_REL,
  blankFileLists,
  nodeCatalogFile,
  UPLOAD_INPUT_LISTS,
  __setNodeCatalogFileForTests,
  listLoraFiles,
  objectInfoDisplayName,
  pyFilterFilesContentTypes,
  pyGuessTopType,
} from '../../server/native/objectInfo'
import { __setResourceOwnersDbForTests } from '../../server/utils/resourceOwners'
import { handleHostedObjectInfo, UPLOAD_FLAG_KEYS } from '../../server/utils/engineGate'
import { RUNNER_NODE_RULES, RUNNER_NODE_TYPES, RUNNER_SPECIAL_CLASSES } from '#shared/runner/eligibility'
import { EDITOR_ONLY_ADVICE_OF, RETIRED_CLASSES } from '#shared/runner/retired'
import { CATALOGUED_STOCK_CLASSES, STOCK_CLASSES } from '#shared/runner/stockClasses'

let root: string
let tmp: string
const engineFetch = vi.fn()

const app = createApp()
app.use(eventHandler(async (e) => {
  const r = await nativeEngineRoute(e)
  if (r !== undefined) return r
}))
app.use(eventHandler(() => ({ fallthrough: true })))
const handler = toWebHandler(app)

async function call(method: string, p: string) {
  const res = await handler(new Request(`http://x${p}`, { method }))
  const text = await res.text()
  let body: any = text
  try { body = JSON.parse(text) }
  catch {}
  return { status: res.status, body }
}

const engineAnswers = (body: unknown) => engineFetch.mockImplementation(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))

/**
 * A catalog shaped like ComfyUI's: legacy and v2 combos, stale lists
 * everywhere. LoraLoader, CheckpointLoaderSimple and the dataset folder picker
 * are classes no refresh row names any more (C6): they are served as written.
 */
function staleCatalog(): Record<string, any> {
  return {
    LoadImage: { input: { required: { image: [['gone.png'], { image_upload: true }] } }, output: ['IMAGE', 'MASK'] },
    Image: { input: { required: { image: [['', 'gone.png'], { image_upload: true, default: '' }] } } },
    LoadAudio: { input: { required: { audio: ['COMBO', { multiselect: false, audio_upload: true, options: ['gone.mp3'] }] } } },
    LoadVideo: { input: { required: { file: ['COMBO', { multiselect: false, video_upload: true, options: ['gone.mp4'] }] } } },
    Timeline: { input: { required: { audio_file: ['COMBO', { default: '(none)', multiselect: false, audio_upload: true, options: ['(none)', 'gone.mp3'] }] } } },
    AudioWaveform: { input: { required: { audio_file: ['COMBO', { default: 'gone.mp3', multiselect: false, audio_upload: true, options: ['gone.mp3'] }] } } },
    LoraLoader: { input: { required: { model: ['MODEL'], lora_name: [['old.safetensors'], { tooltip: 'The name of the LoRA.' }] } } },
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['old.ckpt'], { tooltip: 'x' }] } }, display_name: 'Load Checkpoint' },
    FluxLoRARemoteNode: { input: { required: { lora_name: ['COMBO', { sailor_widget: 'lora_picker', default: '[None]', multiselect: false, options: ['old.safetensors', '[None]'] }] } } },
    KSampler: { input: { required: { sampler_name: [['euler', 'dpmpp_2m']] } }, output: ['LATENT'] },
    LoadImageDataSetFromFolder: { input: { required: { folder: ['COMBO', { tooltip: 'The folder to load images from.', multiselect: false, options: ['old_dataset'] }] } } },
  }
}

function write(rel: string, data = 'x') {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
}

function writeCatalog(catalog: unknown): string {
  const file = path.join(tmp, 'nodeCatalog.json.gz')
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(catalog)))
  __setNodeCatalogFileForTests(file)
  return file
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-object-info-root-')))
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-object-info-store-')))
  for (const d of ['input', 'output', 'user', 'models']) fs.mkdirSync(path.join(root, d))
  __setInputUploadsEngineRootForTests(root)
  vi.stubGlobal('fetch', engineFetch)
  engineFetch.mockReset()
  engineFetch.mockRejectedValue(new TypeError('fetch failed'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  __setInputUploadsEngineRootForTests(undefined)
  __setNodeCatalogFileForTests(undefined)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(tmp, { recursive: true, force: true })
})

function populateDisk() {
  write('input/b.png'); write('input/a.jpg'); write('input/song.mp3'); write('input/clip.mp4')
  write('input/notes.txt'); write('input/.DS_Store')
  fs.mkdirSync(path.join(root, 'input', 'folder.png')) // a directory, not a file
  write('input/3d/chair.GLB'); write('input/3d/sub/table.obj'); write('input/3d/readme.md')
  write('models/loras/z.safetensors'); write('models/loras/sub/a.pt'); write('models/loras/skip.txt')
  write('models/loras/.git/hidden.safetensors')
  write('models/checkpoints/m.ckpt')
  write('models/unet/u.safetensors'); write('models/diffusion_models/d.sft')
  write('models/vae_approx/taesd_encoder.pth'); write('models/vae_approx/taesd_decoder.pth')
  write('models/vae_approx/taehv.pth'); write('models/vae/v.safetensors')
  write('input/lora_dataset_2/img.png'); write('input/lora_dataset_1/nested/deep.png')
  fs.symlinkSync(path.join(root, 'models'), path.join(root, 'input', 'linked')) // not walked, not listed
}

// ---------------------------------------------------------------- engine down

describe('the catalogue, refreshed from disk (C5: no engine; C6: the only source)', () => {
  it('rebuilds upload and LoRA lists and leaves everything else alone', async () => {
    writeCatalog(staleCatalog())
    populateDisk()
    const r = await call('GET', '/object_info')
    expect(r.status).toBe(200)
    const b = r.body
    // C6b: the first listing moved the old models/loras into the library.
    expect(fs.existsSync(path.join(root, 'library', 'loras', 'z.safetensors'))).toBe(true)
    expect(b.LoadImage.input.required.image).toEqual([['a.jpg', 'b.png'], { image_upload: true }])
    expect(b.Image.input.required.image).toEqual([['', 'a.jpg', 'b.png'], { image_upload: true, default: '' }])
    expect(b.LoadAudio.input.required.audio[1].options).toEqual(['clip.mp4', 'song.mp3'])
    expect(b.LoadVideo.input.required.file[1].options).toEqual(['clip.mp4'])
    expect(b.Timeline.input.required.audio_file[1]).toMatchObject({ default: '(none)', options: ['(none)', 'song.mp3'] })
    expect(b.AudioWaveform.input.required.audio_file[1]).toMatchObject({ default: 'song.mp3', options: ['song.mp3'] })
    expect(b.FluxLoRARemoteNode.input.required.lora_name[1]).toMatchObject({ default: '[None]', options: ['sub/a.pt', 'z.safetensors', '[None]'] })
    // C6: the stock pickers and the dataset folders are no refresh row's: served as written, never listed from disk.
    for (const c of ['KSampler', 'LoraLoader', 'CheckpointLoaderSimple', 'LoadImageDataSetFromFolder']) expect(b[c], c).toEqual(staleCatalog()[c])
    expect(Object.keys(b)).toEqual(Object.keys(staleCatalog()))
  })

  it('an empty input folder gives the lists ComfyUI gives', async () => {
    writeCatalog(staleCatalog())
    const b = (await call('GET', '/object_info')).body
    expect(b.LoadImage.input.required.image[0]).toEqual([])
    expect(b.Image.input.required.image[0]).toEqual([''])
    expect(b.AudioWaveform.input.required.audio_file[1]).toMatchObject({ default: '(no audio found)', options: ['(no audio found)'] })
    expect(b.FluxLoRARemoteNode.input.required.lora_name[1].options).toEqual(['[None]'])
  })

  it('never serves a saved engine copy (C6): the catalogue is the only source', async () => {
    writeCatalog(staleCatalog())
    const dataDir = path.join(root, 'frontend', '.data')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'object_info.json'), JSON.stringify({ OnlyInSaved: { input: { required: {} } } }))
    const b = (await call('GET', '/object_info')).body
    expect(Object.keys(b)).toEqual(Object.keys(staleCatalog()))
    expect((await call('GET', '/object_info/OnlyInSaved')).body).toEqual({})
  })

  it('names a class by the catalogue’s display name, else null', () => {
    writeCatalog(staleCatalog())
    expect(objectInfoDisplayName('CheckpointLoaderSimple')).toBe('Load Checkpoint')
    expect(objectInfoDisplayName('KSampler')).toBeNull()
    expect(objectInfoDisplayName('Nope')).toBeNull()
  })

  it('serves one node, or {} for an unknown one, under every engine spelling', async () => {
    writeCatalog(staleCatalog())
    write('input/b.png')
    for (const p of ['/object_info/LoadImage', '/api/object_info/LoadImage', '/comfyui/object_info/LoadImage', '/comfyui/api/object_info/LoadImage']) {
      const r = await call('GET', p)
      expect(r.status, p).toBe(200)
      expect(r.body, p).toEqual({ LoadImage: { input: { required: { image: [['b.png'], { image_upload: true }] } }, output: ['IMAGE', 'MASK'] } })
    }
    expect((await call('GET', '/object_info/Nope')).body).toEqual({})
  })

  it('keeps aiohttp\'s route table: 405 on other verbs, 404 below a node', async () => {
    writeCatalog(staleCatalog())
    expect(await call('POST', '/object_info')).toEqual({ status: 405, body: '405: Method Not Allowed' })
    expect(await call('GET', '/object_info/a/b')).toEqual({ status: 404, body: '404: Not Found' })
    expect(await call('GET', '/object_info/')).toEqual({ status: 404, body: '404: Not Found' })
  })

  it('503 when the catalogue can’t be read', async () => {
    __setNodeCatalogFileForTests(path.join(tmp, 'missing.gz'))
    const r = await call('GET', '/object_info')
    expect(r.status).toBe(503)
    expect(r.body.error).toMatch(/node list/)
  })

  it('never asks an engine, even one that would answer (step 4, C5)', async () => {
    writeCatalog(staleCatalog())
    engineAnswers({ Live: {} })
    const b = (await call('GET', '/object_info')).body
    expect(Object.keys(b)).toEqual(Object.keys(staleCatalog()))
    expect((await call('GET', '/object_info/KSampler')).body).toEqual({ KSampler: staleCatalog().KSampler })
    expect(engineFetch).not.toHaveBeenCalled()
  })
})

// --------------------------------------------------------------------- hosted

describe('hosted: the scrub applies to whichever body is served', () => {
  afterEach(() => { __setInputUploadsDbForTests(null); __setResourceOwnersDbForTests(null) })

  it('scrubs the refreshed catalogue to the caller\'s own uploads', async () => {
    writeCatalog(staleCatalog())
    populateDisk()
    __setInputUploadsDbForTests({
      async query(sql: string, params: unknown[] = []) {
        if (/select\s+file_key\s+from\s+input_uploads/i.test(sql)) return { rows: params[0] === 'u1' ? [{ file_key: 'input::b.png' }] : [] }
        throw new Error(`unexpected sql: ${sql}`)
      },
    })
    __setResourceOwnersDbForTests({
      async query(_sql: string, params: unknown[] = []) { return { rows: params[1] === 'z' ? [{ user_id: 'u2' }] : [] } },
    })
    const out = await handleHostedObjectInfo({ path: '/object_info', context: { userId: 'u1' } } as any) as any
    expect(out.LoadImage.input.required.image[0]).toEqual(['b.png'])
    expect(out.AudioWaveform.input.required.audio_file[1]).toMatchObject({ default: 'b.png', options: ['b.png'] })
    expect(JSON.stringify(out)).not.toContain('song.mp3')
    expect(JSON.stringify(out)).not.toContain('lora_dataset')
    // LoRA lists: curated (no owner row) and the caller's own stay; another
    // tenant's LoRA (z, owned by u2) is gone. The owner sees it.
    expect(out.FluxLoRARemoteNode.input.required.lora_name[1].options).toEqual(['sub/a.pt', '[None]'])
    const owner = await handleHostedObjectInfo({ path: '/object_info', context: { userId: 'u2' } } as any) as any
    expect(owner.FluxLoRARemoteNode.input.required.lora_name[1].options).toEqual(['sub/a.pt', 'z.safetensors', '[None]'])
  })

  it('never asks the engine (R10.9): the stored catalog is served and scrubbed even while an engine answers', async () => {
    writeCatalog(staleCatalog())
    write('input/b.png')
    __setInputUploadsDbForTests({ async query() { return { rows: [] } } })
    engineAnswers(staleCatalog())
    const live = await handleHostedObjectInfo({ path: '/object_info', context: { userId: 'u1' } } as any) as any
    expect(live.KSampler).toEqual(staleCatalog().KSampler)

    engineFetch.mockImplementation(async () => new Response('{"KSampler": NaN}', { status: 200 }))
    const fallback = await handleHostedObjectInfo({ path: '/object_info', context: { userId: 'u1' } } as any) as any
    expect(Object.keys(fallback)).toEqual(Object.keys(staleCatalog()))
    expect(fallback.LoadImage.input.required.image[0]).toEqual([])
    expect(engineFetch).not.toHaveBeenCalled()
  })

  it('503 in plain words only when there is nothing to serve at all — never the engine', async () => {
    __setNodeCatalogFileForTests(path.join(tmp, 'missing.gz'))
    __setInputUploadsDbForTests({ async query() { return { rows: [] } } })
    engineAnswers(staleCatalog())
    const err = await handleHostedObjectInfo({ path: '/object_info', context: { userId: 'u1' } } as any).catch(e => e)
    expect(err).toMatchObject({ statusCode: 503 })
    expect(String(err.message)).not.toMatch(/engine|ComfyUI/i)
    expect(engineFetch).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------------ Python helpers

describe('Python ports', () => {
  it('mimetypes.guess_type, strict=False: suffix map, encodings, case, url schemes', () => {
    expect(pyGuessTopType('a.PNG')).toBe('image')
    expect(pyGuessTopType('a.svgz')).toBe('image')
    expect(pyGuessTopType('a.png.gz')).toBe('image')
    expect(pyGuessTopType('a.png.GZ')).toBe(null) // encodings are case sensitive; .gz is not a type
    expect(pyGuessTopType('a.ts')).toBe('video')
    expect(pyGuessTopType('README')).toBe(null)
    expect(pyGuessTopType('.png')).toBe(null)
    expect(pyGuessTopType('ab:c.mp3')).toBe('audio')
    expect(pyGuessTopType('ab:c.mp3#x')).toBe('audio')
    expect(pyGuessTopType('a:b.txt')).toBe('other')
  })

  it('filter_files_content_types caches by the text after the last dot', () => {
    // First sighting of ".gz" is an image, so every later ".gz" is an image too.
    expect(pyFilterFilesContentTypes(['x.png.gz', 'y.tar.gz'], ['image'])).toEqual(['x.png.gz', 'y.tar.gz'])
    expect(pyFilterFilesContentTypes(['webp'], ['image'])).toEqual(['webp'])
  })

  it('LoRA pickers list the library (C6b): the old models/loras moves there once; extra_model_paths.yaml is not read', () => {
    fs.writeFileSync(path.join(root, 'extra_model_paths.yaml'), ['mine:', '    base_path: shared/', '    loras: extra_loras'].join('\n'))
    write('shared/extra_loras/e.safetensors')
    write('models/loras/z.safetensors')
    write('models/checkpoints/m.ckpt')
    expect(listLoraFiles(root)).toEqual(['z.safetensors'])
    expect(fs.existsSync(path.join(root, 'library', 'loras', 'z.safetensors'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'models', 'loras'))).toBe(false)
    // Other model kinds stay where they were, untouched and unlisted.
    expect(fs.existsSync(path.join(root, 'models', 'checkpoints', 'm.ckpt'))).toBe(true)
    expect(listLoraFiles(null)).toEqual([])
  })

  it('LoRA pickers read both folders, the library first, when both exist', () => {
    write('library/loras/a.safetensors')
    write('models/loras/b.safetensors'); write('models/loras/a.safetensors')
    expect(listLoraFiles(root)).toEqual(['a.safetensors', 'b.safetensors'])
    // Nothing was moved over an existing library folder.
    expect(fs.existsSync(path.join(root, 'models', 'loras', 'b.safetensors'))).toBe(true)
  })
})

// ----------------------------------------------------------- the committed file

function findList(catalog: any, key: string): unknown {
  const [cls, input] = key.split('.') as [string, string]
  const spec = catalog[cls].input.required?.[input] ?? catalog[cls].input.optional?.[input]
  return Array.isArray(spec[0]) ? spec[0] : spec[1].options
}

describe('where the catalogue is found', () => {
  const saved = process.env.SAILOR_NODE_CATALOG
  beforeEach(() => { __setNodeCatalogFileForTests(undefined) })
  afterEach(() => {
    if (saved === undefined) delete process.env.SAILOR_NODE_CATALOG
    else process.env.SAILOR_NODE_CATALOG = saved
    vi.restoreAllMocks()
  })

  it('SAILOR_NODE_CATALOG first, then <data root>/frontend/…, then <cwd>/…', () => {
    expect(NODE_CATALOG_REL).toBe(path.join('server', 'assets', 'nodeCatalog.json.gz'))
    const cwd = path.join(tmp, 'cwd')
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    const inCwd = path.join(cwd, NODE_CATALOG_REL)
    const inRoot = path.join(root, 'frontend', NODE_CATALOG_REL)
    const inEnv = path.join(tmp, 'env.json.gz')
    for (const f of [inCwd, inRoot, inEnv]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x') }
    process.env.SAILOR_NODE_CATALOG = inEnv
    expect(nodeCatalogFile()).toBe(inEnv)
    fs.rmSync(inEnv)
    expect(nodeCatalogFile()).toBe(inRoot)
    fs.rmSync(inRoot)
    expect(nodeCatalogFile()).toBe(inCwd)
  })

  it('warns once, and serves nothing, when none exists', async () => {
    delete process.env.SAILOR_NODE_CATALOG
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'nowhere'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(nodeCatalogFile()).toBeNull()
    expect(nodeCatalogFile()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/SAILOR_NODE_CATALOG/)
    expect((await call('GET', '/object_info')).status).toBe(503)
  })
})

describe('the committed catalogue (C6: Sailor’s own)', () => {
  const real = path.resolve(__dirname, '..', '..', NODE_CATALOG_REL)
  const catalog = JSON.parse(zlib.gunzipSync(fs.readFileSync(real)).toString('utf8'))

  it('the old engine-derived files are gone', () => {
    expect(fs.existsSync(path.resolve(__dirname, '..', '..', 'server', 'native', 'objectInfo.catalog.json.gz'))).toBe(false)
    expect(fs.existsSync(path.resolve(__dirname, '..', '..', 'scripts', 'snapshot_object_info.mjs'))).toBe(false)
  })

  it('holds exactly the classes the runner takes, the editor-only cards, the retired classes and the catalogued stock ones', () => {
    const runner = new Set([...RUNNER_NODE_TYPES, ...Object.keys(RUNNER_NODE_RULES), ...RUNNER_SPECIAL_CLASSES])
    const editorOnly = Object.keys(EDITOR_ONLY_ADVICE_OF)
    for (const c of [...runner, ...editorOnly, ...CATALOGUED_STOCK_CLASSES]) expect(catalog[c], c).toBeDefined()
    for (const c of CATALOGUED_STOCK_CLASSES) expect(STOCK_CLASSES.has(c), c).toBe(true)
    const extra = Object.keys(catalog).filter(c => !runner.has(c) && !editorOnly.includes(c) && !RETIRED_CLASSES.has(c) && !CATALOGUED_STOCK_CLASSES.has(c))
    expect(extra).toEqual([])
    // Counts at C6: 225 runner + 1 editor-only + 191 retired + 9 stock (from 862).
    expect(Object.keys(catalog).length).toBe(426)
  })

  it('every refreshed list is blanked (what ComfyUI shows for empty folders)', () => {
    expect(blankFileLists(structuredClone(catalog))).toEqual(catalog)
    expect(findList(catalog, 'FluxLoRARemoteNode.lora_name')).toEqual(['[None]'])
    expect(findList(catalog, 'AudioWaveform.audio_file')).toEqual(['(no audio found)'])
    // …and so no upload-flagged list carries a file name.
    for (const node of Object.values<any>(catalog)) {
      for (const section of Object.values<any>(node.input ?? {})) {
        for (const spec of Object.values<any>(section ?? {})) {
          if (!Array.isArray(spec) || !spec[1] || !UPLOAD_FLAG_KEYS.some(k => spec[1][k])) continue
          const list = Array.isArray(spec[0]) ? spec[0] : spec[1].options
          if (Array.isArray(list)) expect(list.every((x: string) => ['', '(none)', '(no audio found)'].includes(x))).toBe(true)
        }
      }
    }
  })

  it('holds every node input the refresh tables name, as a combo', () => {
    for (const key of [...Object.keys(MODEL_INPUT_LISTS), ...Object.keys(UPLOAD_INPUT_LISTS)]) {
      const [cls, input] = key.split('.') as [string, string]
      const node = catalog[cls]
      expect(node, key).toBeTruthy()
      const spec = node.input.required?.[input] ?? node.input.optional?.[input]
      expect(Array.isArray(spec?.[0]) || Array.isArray(spec?.[1]?.options), key).toBe(true)
    }
  })
})

