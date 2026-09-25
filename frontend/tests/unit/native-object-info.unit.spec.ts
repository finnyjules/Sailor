/**
 * GET /object_info served by Sailor (server/native/objectInfo.ts), driven
 * through the native dispatcher in a real h3 app against a temp engine root.
 *
 *   engine up   → its body passes through untouched, and the full catalog is
 *                 saved (to a temp file here — never the real `.data/`);
 *   engine down → the saved copy, else the committed baseline, with the
 *                 upload-widget and model-picker lists rebuilt from disk;
 *   hosted      → the tenant scrub still applies to whichever body is served.
 *
 * `fetch` is stubbed in every test, so nothing here can reach a real engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The cached engine-health check (server/native/engineHealth.ts) is stubbed:
// its 3 s process-wide cache would otherwise carry one test's engine state
// into the next, and a real probe would reach whatever is on :8188. 'up'
// (the default) defers to each test's own fetch stub, as before the check.
const engineHealthState = vi.hoisted(() => ({ value: 'up' as 'up' | 'down' }))
vi.mock('../../server/native/engineHealth', async orig => ({
  ...(await orig() as object),
  engineHealth: async () => engineHealthState.value,
}))
beforeEach(() => { engineHealthState.value = 'up' })
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { __setInputUploadsDbForTests, __setInputUploadsEngineRootForTests } from '../../server/utils/inputUploads'
import { nativeEngineRoute } from '../../server/native/router'
import {
  MODEL_INPUT_LISTS,
  __objectInfoSaveSettledForTests,
  blankFileLists,
  inputSubfolders,
  objectInfoBaselineFile,
  UPLOAD_INPUT_LISTS,
  __setObjectInfoBaselineFileForTests,
  __setObjectInfoCacheFileForTests,
  modelFolderTable,
  getFilenameList,
  objectInfoCacheFile,
  parseExtraModelPathsYaml,
  pyFilterFilesContentTypes,
  pyGuessTopType,
} from '../../server/native/objectInfo'
import { handleHostedObjectInfo, UPLOAD_FLAG_KEYS } from '../../server/utils/engineGate'

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

/** A catalog shaped like ComfyUI's: legacy and v2 combos, stale lists everywhere. */
function staleCatalog(): Record<string, any> {
  return {
    LoadImage: { input: { required: { image: [['gone.png'], { image_upload: true }] } }, output: ['IMAGE', 'MASK'] },
    LoadImageMask: { input: { required: { image: [['gone.png'], { image_upload: true }], channel: [['alpha', 'red', 'green', 'blue']] } } },
    Image: { input: { required: { image: [['', 'gone.png'], { image_upload: true, default: '' }] } } },
    LoadAudio: { input: { required: { audio: ['COMBO', { multiselect: false, audio_upload: true, options: ['gone.mp3'] }] } } },
    LoadVideo: { input: { required: { file: ['COMBO', { multiselect: false, video_upload: true, options: ['gone.mp4'] }] } } },
    Timeline: { input: { required: { audio_file: ['COMBO', { default: '(none)', multiselect: false, audio_upload: true, options: ['(none)', 'gone.mp3'] }] } } },
    AudioWaveform: { input: { required: { audio_file: ['COMBO', { default: 'gone.mp3', multiselect: false, audio_upload: true, options: ['gone.mp3'] }] } } },
    Load3D: { input: { required: { model_file: ['COMBO', { multiselect: false, file_upload: true, options: [] }] } } },
    LoraLoader: { input: { required: { model: ['MODEL'], lora_name: [['old.safetensors'], { tooltip: 'The name of the LoRA.' }] } } },
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['old.ckpt'], { tooltip: 'x' }] } } },
    VAELoader: { input: { required: { vae_name: [['pixel_space']] } } },
    UNETLoader: { input: { required: { unet_name: [[]], weight_dtype: [['default', 'fp8_e4m3fn']] } } },
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

function writeBaseline(catalog: unknown): string {
  const file = path.join(tmp, 'baseline.json.gz')
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(catalog)))
  __setObjectInfoBaselineFileForTests(file)
  return file
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-object-info-root-')))
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-object-info-store-')))
  for (const d of ['input', 'output', 'user', 'models']) fs.mkdirSync(path.join(root, d))
  __setInputUploadsEngineRootForTests(root)
  __setObjectInfoCacheFileForTests(path.join(tmp, 'data', 'object_info.json'))
  vi.stubGlobal('fetch', engineFetch)
  engineFetch.mockReset()
  engineFetch.mockRejectedValue(new TypeError('fetch failed'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  __setInputUploadsEngineRootForTests(undefined)
  __setObjectInfoBaselineFileForTests(undefined)
  __setObjectInfoCacheFileForTests(undefined)
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

describe('engine down: the baseline, refreshed from disk', () => {
  it('rebuilds upload and model lists and leaves everything else alone', async () => {
    writeBaseline(staleCatalog())
    populateDisk()
    const r = await call('GET', '/object_info')
    expect(r.status).toBe(200)
    const b = r.body
    expect(b.LoadImage.input.required.image).toEqual([['a.jpg', 'b.png'], { image_upload: true }])
    expect(b.LoadImageMask.input.required.image[0]).toEqual(['a.jpg', 'b.png', 'clip.mp4', 'notes.txt', 'song.mp3', '.DS_Store'].sort())
    expect(b.LoadImageMask.input.required.channel).toEqual([['alpha', 'red', 'green', 'blue']])
    expect(b.Image.input.required.image).toEqual([['', 'a.jpg', 'b.png'], { image_upload: true, default: '' }])
    expect(b.LoadAudio.input.required.audio[1].options).toEqual(['clip.mp4', 'song.mp3'])
    expect(b.LoadVideo.input.required.file[1].options).toEqual(['clip.mp4'])
    expect(b.Timeline.input.required.audio_file[1]).toMatchObject({ default: '(none)', options: ['(none)', 'song.mp3'] })
    expect(b.AudioWaveform.input.required.audio_file[1]).toMatchObject({ default: 'song.mp3', options: ['song.mp3'] })
    expect(b.Load3D.input.required.model_file[1].options).toEqual(['3d/chair.GLB', '3d/sub/table.obj'])
    expect(b.LoraLoader.input.required.lora_name).toEqual([['sub/a.pt', 'z.safetensors'], { tooltip: 'The name of the LoRA.' }])
    expect(b.LoraLoader.input.required.model).toEqual(['MODEL'])
    expect(b.CheckpointLoaderSimple.input.required.ckpt_name[0]).toEqual(['m.ckpt'])
    expect(b.UNETLoader.input.required.unet_name[0]).toEqual(['d.sft', 'u.safetensors'])
    expect(b.UNETLoader.input.required.weight_dtype).toEqual([['default', 'fp8_e4m3fn']])
    expect(b.VAELoader.input.required.vae_name[0]).toEqual(['v.safetensors', 'taehv.pth', 'taesd', 'pixel_space'])
    expect(b.FluxLoRARemoteNode.input.required.lora_name[1]).toMatchObject({ default: '[None]', options: ['sub/a.pt', 'z.safetensors', '[None]'] })
    expect(b.LoadImageDataSetFromFolder.input.required.folder[1].options)
      .toEqual(['3d', '3d/sub', 'folder.png', 'lora_dataset_1', 'lora_dataset_1/nested', 'lora_dataset_2'])
    expect(b.KSampler).toEqual(staleCatalog().KSampler)
    expect(Object.keys(b)).toEqual(Object.keys(staleCatalog()))
  })

  it('an empty input folder gives the lists ComfyUI gives', async () => {
    writeBaseline(staleCatalog())
    const b = (await call('GET', '/object_info')).body
    expect(b.LoadImage.input.required.image[0]).toEqual([])
    expect(b.Image.input.required.image[0]).toEqual([''])
    expect(b.AudioWaveform.input.required.audio_file[1]).toMatchObject({ default: '(no audio found)', options: ['(no audio found)'] })
    expect(b.LoraLoader.input.required.lora_name[0]).toEqual([])
    expect(b.LoadImageDataSetFromFolder.input.required.folder[1].options).toEqual([])
  })

  it('prefers the saved copy over the baseline', async () => {
    writeBaseline(staleCatalog())
    const saved = { OnlyInSaved: { input: { required: {} } }, LoraLoader: staleCatalog().LoraLoader }
    fs.mkdirSync(path.join(tmp, 'data'))
    fs.writeFileSync(path.join(tmp, 'data', 'object_info.json'), JSON.stringify(saved))
    write('models/loras/new.safetensors')
    const b = (await call('GET', '/object_info')).body
    expect(Object.keys(b)).toEqual(['OnlyInSaved', 'LoraLoader'])
    expect(b.LoraLoader.input.required.lora_name[0]).toEqual(['new.safetensors'])
  })

  it('serves one node, or {} for an unknown one, under every engine spelling', async () => {
    writeBaseline(staleCatalog())
    write('input/b.png')
    for (const p of ['/object_info/LoadImage', '/api/object_info/LoadImage', '/comfyui/object_info/LoadImage', '/comfyui/api/object_info/LoadImage']) {
      const r = await call('GET', p)
      expect(r.status, p).toBe(200)
      expect(r.body, p).toEqual({ LoadImage: { input: { required: { image: [['b.png'], { image_upload: true }] } }, output: ['IMAGE', 'MASK'] } })
    }
    expect((await call('GET', '/object_info/Nope')).body).toEqual({})
  })

  it('keeps aiohttp\'s route table: 405 on other verbs, 404 below a node', async () => {
    writeBaseline(staleCatalog())
    expect(await call('POST', '/object_info')).toEqual({ status: 405, body: '405: Method Not Allowed' })
    expect(await call('GET', '/object_info/a/b')).toEqual({ status: 404, body: '404: Not Found' })
    expect(await call('GET', '/object_info/')).toEqual({ status: 404, body: '404: Not Found' })
  })

  it('503 when there is neither an engine nor any stored catalog', async () => {
    __setObjectInfoBaselineFileForTests(path.join(tmp, 'missing.gz'))
    const r = await call('GET', '/object_info')
    expect(r.status).toBe(503)
    expect(r.body.error).toMatch(/node list/)
  })

  it('a non-2xx engine answer counts as down', async () => {
    writeBaseline(staleCatalog())
    engineFetch.mockImplementation(async () => new Response('boom', { status: 500 }))
    const b = (await call('GET', '/object_info')).body
    expect(Object.keys(b)).toEqual(Object.keys(staleCatalog()))
  })
})

// ------------------------------------------------------------------ engine up

describe('engine up: pass-through and a saved copy', () => {
  it('passes the engine body through untouched and saves the full catalog', async () => {
    writeBaseline({ Stale: {} })
    populateDisk()
    const live = staleCatalog()
    engineAnswers(live)
    const r = await call('GET', '/object_info')
    expect(r.body).toEqual(live) // stale lists and all: the engine's answer is the answer
    expect(engineFetch.mock.calls[0][0]).toBe('http://127.0.0.1:8188/object_info')
    expect(engineFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    await __objectInfoSaveSettledForTests()
    const savedFile = path.join(tmp, 'data', 'object_info.json')
    const saved = JSON.parse(fs.readFileSync(savedFile, 'utf8'))
    // Stored blanked, like the baseline: no file or folder names on disk.
    expect(saved).toEqual(blankFileLists(staleCatalog()))
    expect(JSON.stringify(saved)).not.toMatch(/gone\.|old\.|old_dataset/)
    expect(fs.readdirSync(path.join(tmp, 'data'))).toEqual(['object_info.json']) // no temp file left

    // Down again: the saved copy (not the baseline) is served, refreshed.
    engineFetch.mockReset()
    engineFetch.mockRejectedValue(new TypeError('fetch failed'))
    const down = (await call('GET', '/object_info')).body
    expect(Object.keys(down)).toEqual(Object.keys(live))
    expect(down.LoadImage.input.required.image[0]).toEqual(['a.jpg', 'b.png'])
  })

  it('does not save a single node or a pool worker\'s catalog', async () => {
    engineAnswers({ LoadImage: staleCatalog().LoadImage })
    await call('GET', '/object_info/LoadImage')
    expect(engineFetch.mock.calls[0][0]).toBe('http://127.0.0.1:8188/object_info/LoadImage')
    engineAnswers(staleCatalog())
    await call('GET', '/object_info?comfyWorker=2')
    expect(engineFetch.mock.calls[1][0]).toBe('http://127.0.0.1:8191/object_info')
    await __objectInfoSaveSettledForTests()
    expect(fs.existsSync(path.join(tmp, 'data', 'object_info.json'))).toBe(false)
  })
})

describe('engine up: exact bytes, Python JSON, and a remembered outage', () => {
  it('passes the engine\'s exact text through as JSON, NaN and all, when nothing is stored', async () => {
    __setObjectInfoBaselineFileForTests(path.join(tmp, 'missing.gz'))
    const text = '{"KSampler": {"input": {"required": {"cfg": ["FLOAT", {"default": NaN}]}}}}'
    engineFetch.mockImplementation(async () => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }))
    const res = await handler(new Request('http://x/object_info'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(await res.text()).toBe(text)
    await __objectInfoSaveSettledForTests()
    expect(fs.existsSync(path.join(tmp, 'data', 'object_info.json'))).toBe(false) // nothing parseable to save
  })

  it('an unparseable engine answer with a stored catalog: the stored one is served (overlaid), as hosted does', async () => {
    writeBaseline(staleCatalog())
    engineFetch.mockImplementation(async () => new Response('{"KSampler": NaN}', { status: 200 }))
    const b = (await call('GET', '/object_info')).body
    expect(Object.keys(b)).toEqual(Object.keys(staleCatalog()))
  })

  it('remembers a failed engine for 3 s, then asks again', async () => {
    writeBaseline(staleCatalog())
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      await call('GET', '/object_info')
      await call('GET', '/object_info/KSampler')
      expect(engineFetch).toHaveBeenCalledTimes(1)
      now.mockReturnValue(1_000_000 + 3_001)
      engineAnswers({ Live: {} })
      expect((await call('GET', '/object_info')).body).toEqual({ Live: {} })
      expect(engineFetch).toHaveBeenCalledTimes(2)
    }
    finally {
      now.mockRestore()
    }
  })

  it('the main engine already known down (cached health): the stored catalog, no fetch; a pool worker is still asked', async () => {
    writeBaseline(staleCatalog())
    engineHealthState.value = 'down'
    engineAnswers({ Live: {} })
    expect((await call('GET', '/object_info')).body).not.toEqual({ Live: {} })
    expect(engineFetch).not.toHaveBeenCalled()
    expect((await call('GET', '/object_info?comfyWorker=2')).body).toEqual({ Live: {} })
    expect(engineFetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8191/object_info')
  })
})

// --------------------------------------------------------------------- hosted

describe('hosted: the scrub applies to whichever body is served', () => {
  afterEach(() => { __setInputUploadsDbForTests(null) })

  it('scrubs the refreshed baseline to the caller\'s own uploads', async () => {
    writeBaseline(staleCatalog())
    populateDisk()
    __setInputUploadsDbForTests({
      async query(sql: string, params: unknown[] = []) {
        if (/select\s+file_key\s+from\s+input_uploads/i.test(sql)) return { rows: params[0] === 'u1' ? [{ file_key: 'input::b.png' }] : [] }
        throw new Error(`unexpected sql: ${sql}`)
      },
    })
    const out = await handleHostedObjectInfo({ path: '/object_info', context: { userId: 'u1' } } as any) as any
    expect(out.LoadImage.input.required.image[0]).toEqual(['b.png'])
    expect(out.LoadImageMask.input.required.image[0]).toEqual(['b.png'])
    expect(out.AudioWaveform.input.required.audio_file[1]).toMatchObject({ default: 'b.png', options: ['b.png'] })
    expect(JSON.stringify(out)).not.toContain('song.mp3')
    expect(out.LoadImageDataSetFromFolder.input.required.folder[1].options).toEqual([])
    // Model lists are shared assets and stay refreshed.
    expect(out.LoraLoader.input.required.lora_name[0]).toEqual(['sub/a.pt', 'z.safetensors'])
  })

  it('empties the dataset folder pickers on a live body too, and serves the stored catalog for unparseable text', async () => {
    writeBaseline(staleCatalog())
    write('input/b.png')
    __setInputUploadsDbForTests({ async query() { return { rows: [] } } })
    engineAnswers(staleCatalog())
    const live = await handleHostedObjectInfo({ path: '/object_info', context: { userId: 'u1' } } as any) as any
    expect(live.LoadImageDataSetFromFolder.input.required.folder[1].options).toEqual([])
    expect(live.KSampler).toEqual(staleCatalog().KSampler)

    engineFetch.mockImplementation(async () => new Response('{"KSampler": NaN}', { status: 200 }))
    const fallback = await handleHostedObjectInfo({ path: '/object_info', context: { userId: 'u1' } } as any) as any
    expect(Object.keys(fallback)).toEqual(Object.keys(staleCatalog()))
    expect(fallback.LoadImage.input.required.image[0]).toEqual([])
  })

  it('502 only when there is nothing to serve at all', async () => {
    __setObjectInfoBaselineFileForTests(path.join(tmp, 'missing.gz'))
    __setInputUploadsDbForTests({ async query() { return { rows: [] } } })
    await expect(handleHostedObjectInfo({ path: '/object_info', context: { userId: 'u1' } } as any)).rejects.toMatchObject({ statusCode: 502 })
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

  it('extra_model_paths.yaml: sections, block lists, base_path, is_default, legacy names', () => {
    const cfg = parseExtraModelPathsYaml([
      '# a comment',
      'mine:',
      '    base_path: shared/',
      '    is_default: true',
      '    loras: |',
      '         extra_loras',
      '         more_loras',
      '    unet: unet_dir  # trailing comment',
      'off:',
    ].join('\n'))
    expect(cfg).toEqual({
      mine: { base_path: 'shared/', is_default: true, loras: 'extra_loras\nmore_loras\n', unet: 'unet_dir' },
      off: null,
    })
    fs.writeFileSync(path.join(root, 'extra_model_paths.yaml'), [
      'mine:',
      '    base_path: shared/',
      '    loras: |',
      '         extra_loras',
      '    unet: unet_dir',
    ].join('\n'))
    write('shared/extra_loras/e.safetensors')
    write('shared/unet_dir/w.safetensors')
    write('models/loras/z.safetensors')
    const t = modelFolderTable(root)
    expect(t.get('loras')!.paths).toEqual([path.join(root, 'models', 'loras'), path.join(root, 'shared', 'extra_loras')])
    expect(getFilenameList(t, 'loras')).toEqual(['e.safetensors', 'z.safetensors'])
    expect(getFilenameList(t, 'diffusion_models')).toEqual(['w.safetensors'])
  })
})

// ----------------------------------------------------------- the committed file

function findList(catalog: any, key: string): unknown {
  const [cls, input] = key.split('.') as [string, string]
  const spec = catalog[cls].input.required?.[input] ?? catalog[cls].input.optional?.[input]
  return Array.isArray(spec[0]) ? spec[0] : spec[1].options
}

describe('where the baseline is found', () => {
  const REL = path.join('server', 'native', 'objectInfo.baseline.json.gz')
  const saved = process.env.SAILOR_OBJECT_INFO_BASELINE
  beforeEach(() => { __setObjectInfoBaselineFileForTests(undefined) })
  afterEach(() => {
    if (saved === undefined) delete process.env.SAILOR_OBJECT_INFO_BASELINE
    else process.env.SAILOR_OBJECT_INFO_BASELINE = saved
    vi.restoreAllMocks()
  })

  it('SAILOR_OBJECT_INFO_BASELINE first, then <engine root>/frontend/…, then <cwd>/…', () => {
    const cwd = path.join(tmp, 'cwd')
    vi.spyOn(process, 'cwd').mockReturnValue(cwd)
    const inCwd = path.join(cwd, REL)
    const inRoot = path.join(root, 'frontend', REL)
    const inEnv = path.join(tmp, 'env.json.gz')
    for (const f of [inCwd, inRoot, inEnv]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x') }
    process.env.SAILOR_OBJECT_INFO_BASELINE = inEnv
    expect(objectInfoBaselineFile()).toBe(inEnv)
    fs.rmSync(inEnv)
    expect(objectInfoBaselineFile()).toBe(inRoot)
    fs.rmSync(inRoot)
    expect(objectInfoBaselineFile()).toBe(inCwd)
  })

  it('warns once, and serves nothing, when none exists', async () => {
    delete process.env.SAILOR_OBJECT_INFO_BASELINE
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'nowhere'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(objectInfoBaselineFile()).toBeNull()
    expect(objectInfoBaselineFile()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/SAILOR_OBJECT_INFO_BASELINE/)
    expect((await call('GET', '/object_info')).status).toBe(503)
  })
})

describe('get_input_subfolders', () => {
  it('every real folder under input/, relative and sorted; symlinked folders are not followed', () => {
    write('input/b/x.png'); write('input/a/c/y.png'); write('input/.hidden/z')
    fs.symlinkSync(path.join(root, 'models'), path.join(root, 'input', 'link'))
    expect(inputSubfolders(path.join(root, 'input'))).toEqual(['.hidden', 'a', 'a/c', 'b'])
    expect(inputSubfolders(path.join(root, 'missing'))).toEqual([])
  })
})

describe('the committed baseline', () => {
  const real = path.resolve(__dirname, '..', '..', 'server', 'native', 'objectInfo.baseline.json.gz')
  const baseline = JSON.parse(zlib.gunzipSync(fs.readFileSync(real)).toString('utf8'))

  it('is a full catalog with every refreshed list blanked (what ComfyUI shows for empty folders)', () => {
    expect(Object.keys(baseline).length).toBeGreaterThan(500)
    expect(blankFileLists(structuredClone(baseline))).toEqual(baseline)
    expect(findList(baseline, 'LoraLoader.lora_name')).toEqual([])
    expect(findList(baseline, 'LoadImageDataSetFromFolder.folder')).toEqual([])
    expect(findList(baseline, 'AudioWaveform.audio_file')).toEqual(['(no audio found)'])
    // …and so no upload-flagged list carries a file name.
    for (const node of Object.values<any>(baseline)) {
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
      const node = baseline[cls]
      expect(node, key).toBeTruthy()
      const spec = node.input.required?.[input] ?? node.input.optional?.[input]
      expect(Array.isArray(spec?.[0]) || Array.isArray(spec?.[1]?.options), key).toBe(true)
    }
  })
})

describe('test isolation', () => {
  it('the saved copy never points at the real data folder during tests', () => {
    __setObjectInfoCacheFileForTests(undefined)
    expect(objectInfoCacheFile()).toBeNull()
  })
})
