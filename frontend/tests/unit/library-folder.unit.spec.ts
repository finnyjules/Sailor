/**
 * Step 4, C6b: Sailor's own data — the user's LoRAs, characters and voices —
 * lives in `<data root>/library/<kind>` (server/utils/library.ts), no longer in
 * ComfyUI's `models/`. The old folder is moved there once, by rename, on first
 * use; never copied. When both exist, both are read, the library first.
 *
 * Every test works in a temp data root; the user's real folders are never
 * touched (library.ts also refuses to move anything outside the OS temp folder
 * under the test runner).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { __setDataRootForTests } from '../../server/utils/dataRoot'
import {
  __resetLibraryLogForTests,
  findInLibrary,
  libraryDir,
  libraryDirs,
  libraryMoveAllowed,
  listLibrary,
  trainingJobsFile,
} from '../../server/utils/library'
import { defaultJobsPath } from '../../server/utils/trainingQueue'
import { listLoraFiles } from '../../server/native/objectInfo'
import { loraFolders, loraOptions, readLoraSidecar } from '../../server/runner/loraFiles'

const g = globalThis as any
g.defineEventHandler = (fn: any) => fn
g.readBody = async (event: any) => event.body ?? {}
g.getQuery = (event: any) => event.query ?? {}
g.setHeader = () => {}
g.createError = (opts: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(opts.message ?? opts.statusMessage ?? 'error') as Error & { statusCode: number }
  err.statusCode = opts.statusCode
  return err
}

const CLERK_KEY = 'NUXT_CLERK_SECRET_KEY'
const savedClerk = process.env[CLERK_KEY]

let root: string
const at = (...p: string[]) => path.join(root, ...p)
function write(rel: string, body: string | Buffer = 'x'): void {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true })
  fs.writeFileSync(at(rel), body)
}
const ev = (over: Record<string, unknown> = {}) => ({ context: { userId: null }, ...over })

let loraList: any, coverGet: any, charList: any, charPatch: any, voiceList: any, voicePreview: any

beforeAll(async () => {
  delete process.env[CLERK_KEY] // local mode: no ownership registry
  loraList = (await import('../../server/api/loras-local.get')).default
  coverGet = (await import('../../server/api/lora-cover.get')).default
  charList = (await import('../../server/api/characters-local.get')).default
  charPatch = (await import('../../server/api/characters-local.patch')).default
  voiceList = (await import('../../server/api/voices-local.get')).default
  voicePreview = (await import('../../server/api/voice-preview-file.get')).default
})
afterAll(() => {
  if (savedClerk === undefined) delete process.env[CLERK_KEY]
  else process.env[CLERK_KEY] = savedClerk
})

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sailor-library-')))
  fs.mkdirSync(at('input'))
  __setDataRootForTests(root)
  __resetLibraryLogForTests()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  __setDataRootForTests(undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the one-time move', () => {
  it('renames models/<kind> to library/<kind>: the same inode, nothing copied, the old name gone', () => {
    write('models/loras/a.safetensors', 'weights')
    write('models/loras/a.json', '{"name":"A"}')
    const ino = fs.statSync(at('models/loras/a.safetensors')).ino
    const rename = vi.spyOn(fs, 'renameSync')
    const copy = vi.spyOn(fs, 'copyFileSync')
    const dir = libraryDir('loras')
    expect(dir).toBe(at('library', 'loras'))
    expect(rename).toHaveBeenCalledTimes(1)
    expect(rename).toHaveBeenCalledWith(at('models', 'loras'), at('library', 'loras'))
    expect(copy).not.toHaveBeenCalled()
    expect(fs.statSync(at('library/loras/a.safetensors')).ino).toBe(ino)
    expect(fs.existsSync(at('models/loras'))).toBe(false)
    expect(fs.existsSync(at('models'))).toBe(true) // the folder itself (and other kinds) stay
  })

  it('is idempotent: later calls move nothing and read only the library', () => {
    write('models/voices/v.json', '{}')
    libraryDir('voices')
    const rename = vi.spyOn(fs, 'renameSync')
    expect(libraryDirs('voices')).toEqual([at('library', 'voices')])
    expect(libraryDir('voices')).toBe(at('library', 'voices'))
    expect(rename).not.toHaveBeenCalled()
  })

  it('moves each kind on its own, and only the three library kinds', () => {
    write('models/characters/c.json', '{}')
    write('models/lama/big_lama.pt')
    write('models/insightface/x.onnx')
    libraryDir('characters')
    expect(fs.existsSync(at('library/characters/c.json'))).toBe(true)
    expect(fs.existsSync(at('library/loras'))).toBe(false) // never made up
    expect(fs.existsSync(at('models/lama/big_lama.pt'))).toBe(true)
    expect(fs.existsSync(at('models/insightface/x.onnx'))).toBe(true)
  })

  it('nothing to move: no folder is made, the library path is still answered', () => {
    expect(libraryDir('loras')).toBe(at('library', 'loras'))
    expect(fs.existsSync(at('library'))).toBe(false)
  })

  it('concurrent first requests: one move, every caller reads the moved files', async () => {
    write('models/loras/a.safetensors')
    write('models/loras/a.json', '{"name":"A"}')
    const rename = vi.spyOn(fs, 'renameSync')
    const results = await Promise.all([
      listLibrary('loras'), listLibrary('loras'), findInLibrary('loras', 'a.json'), listLibrary('loras'),
    ])
    expect(rename).toHaveBeenCalledTimes(1)
    expect([...(results[0] as Map<string, string>).keys()].sort()).toEqual(['a.json', 'a.safetensors'])
    expect(results[2]).toBe(at('library/loras/a.json'))
  })

  it('loses a race to another process cleanly (the source vanished, or the target appeared)', () => {
    write('models/loras/a.json')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    })
    expect(() => libraryDir('loras')).not.toThrow()
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('there'), { code: 'ENOTEMPTY' })
    })
    expect(() => libraryDirs('loras')).not.toThrow()
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('a move the disk refuses (another disk) is never copied: the old folder is read where it is, logged once', async () => {
    write('models/loras/a.json', '{"name":"A"}')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
    })
    const copy = vi.spyOn(fs, 'cpSync')
    expect(libraryDirs('loras')).toEqual([at('library', 'loras'), at('models', 'loras')])
    expect(await findInLibrary('loras', 'a.json')).toBe(at('models/loras/a.json'))
    libraryDirs('loras')
    expect(copy).not.toHaveBeenCalled()
    expect((console.warn as any).mock.calls.filter((c: unknown[]) => String(c[0]).includes('could not move'))).toHaveLength(1)
    expect(fs.existsSync(at('models/loras/a.json'))).toBe(true)
  })

  it('both exist: both are read, the library first (it wins a name both hold), logged once; nothing is moved', async () => {
    write('library/loras/a.json', '{"name":"new"}')
    write('models/loras/a.json', '{"name":"old"}')
    write('models/loras/b.json', '{"name":"B"}')
    const rename = vi.spyOn(fs, 'renameSync')
    expect(libraryDirs('loras')).toEqual([at('library', 'loras'), at('models', 'loras')])
    const listing = await listLibrary('loras')
    expect(listing.get('a.json')).toBe(at('library', 'loras'))
    expect(listing.get('b.json')).toBe(at('models', 'loras'))
    expect(await findInLibrary('loras', 'b.json')).toBe(at('models/loras/b.json'))
    libraryDirs('loras')
    expect(rename).not.toHaveBeenCalled()
    expect((console.info as any).mock.calls.filter((c: unknown[]) => String(c[0]).includes('both'))).toHaveLength(1)
  })

  it('under the test runner the move runs only inside the OS temp folder (the real library is never moved by a test)', () => {
    expect(libraryMoveAllowed(root)).toBe(true)
    expect(libraryMoveAllowed(path.resolve(process.cwd(), '..'))).toBe(false)
    vi.stubEnv('VITEST', '')
    try { expect(libraryMoveAllowed(path.resolve(process.cwd(), '..'))).toBe(true) }
    finally { vi.unstubAllEnvs() }
  })
})

describe('the training ledger', () => {
  it('moves models/.training-jobs.json (and its .bak) beside the library, by link + unlink, same inode', () => {
    write('models/.training-jobs.json', '[{"id":"j1"}]')
    write('models/.training-jobs.json.bak', '[]')
    const ino = fs.statSync(at('models/.training-jobs.json')).ino
    expect(defaultJobsPath()).toBe(at('library', '.training-jobs.json'))
    expect(fs.statSync(at('library/.training-jobs.json')).ino).toBe(ino)
    expect(fs.readFileSync(at('library/.training-jobs.json.bak'), 'utf8')).toBe('[]')
    expect(fs.existsSync(at('models/.training-jobs.json'))).toBe(false)
    expect(fs.existsSync(at('models/.training-jobs.json.bak'))).toBe(false)
  })

  it('never replaces a ledger already in the library', () => {
    write('library/.training-jobs.json', '[{"id":"new"}]')
    write('models/.training-jobs.json', '[{"id":"old"}]')
    expect(trainingJobsFile()).toBe(at('library', '.training-jobs.json'))
    expect(fs.readFileSync(at('library/.training-jobs.json'), 'utf8')).toBe('[{"id":"new"}]')
    expect(fs.readFileSync(at('models/.training-jobs.json'), 'utf8')).toBe('[{"id":"old"}]')
  })
})

describe('the LoRA pickers and the runner\'s LoRA look-up', () => {
  it('list the library after the move, read a sidecar there', async () => {
    write('models/loras/style.safetensors')
    write('models/loras/style.json', '{"replicate_model":"me/style:v1"}')
    write('models/loras/sub/deep.pt')
    expect(loraOptions()).toEqual(['style.safetensors', 'sub/deep.pt', '[None]'])
    expect(loraFolders()).toEqual([at('library', 'loras')])
    const meta = await readLoraSidecar('style.safetensors')
    expect(meta?.get('replicate_model')).toBe('me/style:v1')
    expect(listLoraFiles(root)).toEqual(['style.safetensors', 'sub/deep.pt'])
  })

  it('both exist: a sidecar only the old folder holds is still found, the library\'s wins', async () => {
    write('library/loras/a.safetensors')
    write('library/loras/a.json', '{"replicate_model":"me/new"}')
    write('models/loras/a.json', '{"replicate_model":"me/old"}')
    write('models/loras/b.safetensors')
    write('models/loras/b.json', '{"replicate_model":"me/b"}')
    expect(loraOptions()).toEqual(['a.safetensors', 'b.safetensors', '[None]'])
    expect((await readLoraSidecar('a.safetensors'))?.get('replicate_model')).toBe('me/new')
    expect((await readLoraSidecar('b.safetensors'))?.get('replicate_model')).toBe('me/b')
  })

  it('an unknown data root lists nothing and reads nothing', () => {
    __setDataRootForTests(null)
    expect(loraOptions()).toEqual(['[None]'])
    expect(loraFolders()).toEqual([])
  })
})

describe('the routes', () => {
  it('GET /api/loras-local moves the old folder and lists it; covers are served from it', async () => {
    write('models/loras/Azure.safetensors', 'w')
    write('models/loras/Azure.json', JSON.stringify({ name: 'Azure', replicate_model: 'me/azure' }))
    write('models/loras/Azure.cover.webp', 'img')
    const r = await loraList(ev())
    expect(r.loras.map((l: any) => l.name)).toEqual(['Azure'])
    expect(r.loras[0].coverUrl).toMatch(/^\/api\/lora-cover\?name=Azure\.safetensors/)
    expect(fs.existsSync(at('library/loras/Azure.json'))).toBe(true)
    expect(String(await coverGet(ev({ query: { name: 'Azure.safetensors' } })))).toBe('img')
  })

  it('GET /api/loras-local and the cover route read both folders when both exist', async () => {
    write('library/loras/New.json', JSON.stringify({ name: 'New' }))
    write('models/loras/Old.json', JSON.stringify({ name: 'Old' }))
    write('models/loras/Old.cover.png', 'old-img')
    const r = await loraList(ev())
    expect(r.loras.map((l: any) => l.name).sort()).toEqual(['New', 'Old'])
    expect(String(await coverGet(ev({ query: { name: 'Old.safetensors' } })))).toBe('old-img')
    await expect(coverGet(ev({ query: { name: 'New.safetensors' } }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('characters: listed and patched after the move', async () => {
    const rec = { name: 'Millie', slug: 'millie', states: [{ id: 'default', label: 'Default', refImages: [] }], notes: '' }
    write('models/characters/millie.json', JSON.stringify(rec))
    const r = await charList(ev())
    expect(r.characters.map((c: any) => c.slug)).toEqual(['millie'])
    await charPatch(ev({ body: { slug: 'millie', notes: 'hello' } }))
    expect(JSON.parse(fs.readFileSync(at('library/characters/millie.json'), 'utf8')).notes).toBe('hello')
    expect(fs.existsSync(at('models/characters'))).toBe(false)
  })

  it('characters: a record only the old folder holds (both exist) is listed and patched in place', async () => {
    const rec = (slug: string) => ({ name: slug, slug, states: [{ id: 'default', label: 'Default', refImages: [] }], notes: '' })
    write('library/characters/a.json', JSON.stringify(rec('a')))
    write('models/characters/b.json', JSON.stringify(rec('b')))
    const r = await charList(ev())
    expect(r.characters.map((c: any) => c.slug)).toEqual(['a', 'b'])
    await charPatch(ev({ body: { slug: 'b', notes: 'kept' } }))
    expect(JSON.parse(fs.readFileSync(at('models/characters/b.json'), 'utf8')).notes).toBe('kept')
    expect(fs.existsSync(at('library/characters/b.json'))).toBe(false)
  })

  it('voices: listed and their preview clip served after the move', async () => {
    write('models/voices/v_1.json', JSON.stringify({ voice_id: 'v_1', name: 'Mine' }))
    write('models/voices/v_1.mp3', 'clip')
    const r = await voiceList(ev())
    expect(r.voices.map((v: any) => v.name)).toEqual(['Mine'])
    expect(r.voices[0].previewUrl).toMatch(/^\/api\/voice-preview-file\?id=v_1/)
    expect(String(await voicePreview(ev({ query: { id: 'v_1' } })))).toBe('clip')
    expect(fs.existsSync(at('library/voices/v_1.mp3'))).toBe(true)
  })

  it('voices: a clip only the old folder holds (both exist) is still served', async () => {
    write('library/voices/a.json', JSON.stringify({ voice_id: 'a' }))
    write('models/voices/b.json', JSON.stringify({ voice_id: 'b' }))
    write('models/voices/b.mp3', 'b-clip')
    const r = await voiceList(ev())
    expect(r.voices.map((v: any) => v.id).sort()).toEqual(['a', 'b'])
    expect(String(await voicePreview(ev({ query: { id: 'b' } })))).toBe('b-clip')
  })
})
