import { mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createEngineResultStore, nextCounter, extFor, userSubfolder } from '~~/server/runner/results'
import { createHandoff, sha256Hex, mimeFor } from '~~/server/runner/handoff'
import {
  parseStyleRefs, moodboardFiles, parseInputFileRef, collectInputFiles, assertFilesOwned,
} from '~~/server/runner/inputs'
import { shortUserHash } from '~~/server/utils/meterGraphRun'

function engineRoot() {
  const root = mkdtempSync(join(tmpdir(), 'runner-engine-'))
  for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t))
  return { root, dirForType: (t: string) => join(root, t) }
}

describe('result doorway', () => {
  it('numbers files the way ComfyUI does and never overwrites', async () => {
    const { root, dirForType } = engineRoot()
    writeFileSync(join(root, 'output', 'generate_image_00007_.png'), 'x')
    const store = createEngineResultStore({ dirForType, hosted: () => false })
    const a = await store.save(new Uint8Array([1]), { userId: null, prefix: 'generate_image', ext: 'png' })
    const b = await store.save(new Uint8Array([2]), { userId: null, prefix: 'generate_image', ext: 'png' })
    expect(a).toEqual({ filename: 'generate_image_00008_.png', subfolder: '', type: 'output' })
    expect(b.filename).toBe('generate_image_00009_.png')
    expect([...await store.read(a)]).toEqual([1])
    expect(await store.exists(b)).toBe(true)
    expect(await store.exists({ filename: 'nope.png', subfolder: '', type: 'output' })).toBe(false)
  })
  it('puts hosted results in the per-user folder', async () => {
    const { root, dirForType } = engineRoot()
    const store = createEngineResultStore({ dirForType, hosted: () => true })
    const f = await store.save(new Uint8Array([1]), { userId: 'user_1', prefix: 'generate_video', ext: 'mp4' })
    expect(f.subfolder).toBe(`u_${shortUserHash('user_1')}`)
    expect(readdirSync(join(root, 'output', f.subfolder))).toEqual(['generate_video_00001_.mp4'])
  })
  it('refuses to read outside the engine folders', async () => {
    const { dirForType } = engineRoot()
    const store = createEngineResultStore({ dirForType, hosted: () => false })
    await expect(store.read({ filename: '../../etc/passwd', subfolder: '', type: 'input' })).rejects.toThrow()
    await expect(store.read({ filename: 'a.png', subfolder: '../..', type: 'input' })).rejects.toThrow()
  })
  it('helpers', () => {
    expect(nextCounter(['generate_image_00002_.png', 'generate_image_00010_.jpg', 'other_00050_.png'], 'generate_image')).toBe(11)
    expect(nextCounter([], 'generate_image')).toBe(1)
    expect(extFor('image/jpeg', 'https://x/y', 'png')).toBe('jpg')
    expect(extFor(null, 'https://x/y.webp?sig=1', 'png')).toBe('webp')
    expect(extFor('application/octet-stream', 'https://x/y', 'mp4')).toBe('mp4')
    expect(userSubfolder('user_1', false)).toBe('')
  })
})

describe('handoff', () => {
  it('uploads a file once and remembers what it contained', async () => {
    const upload = vi.fn(async () => 'https://fal.media/abc.png')
    const h = createHandoff({ read: async () => new Uint8Array([9, 9]), upload })
    const f = { filename: 'a.png', subfolder: '', type: 'output' as const }
    expect(await h.toUrl(f)).toBe('https://fal.media/abc.png')
    expect(await h.toUrl(f)).toBe('https://fal.media/abc.png')
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledWith(new Uint8Array([9, 9]), 'a.png', 'image/png')
    expect(h.hashOf('https://fal.media/abc.png')).toBe(sha256Hex(new Uint8Array([9, 9])))
    expect(h.hashOf('https://elsewhere')).toBeUndefined()
    expect(mimeFor('clip.MP4')).toBe('video/mp4')
    expect(mimeFor('x.jpeg')).toBe('image/jpeg')
  })
})

describe('inputs', () => {
  it('parseStyleRefs keeps Python’s guards', () => {
    expect(parseStyleRefs('')).toBeNull()
    expect(parseStyleRefs('{bad')).toBeNull()
    expect(parseStyleRefs(JSON.stringify({ folder: 'boards', files: ['a.png'] }))).toBeNull()
    expect(parseStyleRefs(JSON.stringify({ folder: 'moodboard_12', files: ['../x.png', 'a.gif'] }))).toBeNull()
    expect(parseStyleRefs(JSON.stringify({ folder: 'moodboard_12', files: ['a.png', 'b.JPG', 'c.webp', 'd.jpeg'] })))
      .toEqual({ folder: 'moodboard_12', files: ['a.png', 'b.JPG', 'c.webp'] })
    expect(moodboardFiles(JSON.stringify({ folder: 'moodboard_1', files: ['a.png'] })))
      .toEqual([{ filename: 'a.png', subfolder: 'moodboard_1', type: 'input' }])
  })
  it('parseInputFileRef reads plain, nested and annotated names', () => {
    expect(parseInputFileRef('a.png')).toEqual({ filename: 'a.png', subfolder: '', type: 'input' })
    expect(parseInputFileRef('sub/a.png')).toEqual({ filename: 'a.png', subfolder: 'sub', type: 'input' })
    expect(parseInputFileRef('u_abc/x.png [output]')).toEqual({ filename: 'x.png', subfolder: 'u_abc', type: 'output' })
    expect(parseInputFileRef('')).toBeNull()
    expect(parseInputFileRef('../x.png')).toBeNull()
  })
  it('collectInputFiles finds moodboard pictures and loaded files, not wired cards', () => {
    const files = collectInputFiles({
      '1': { class_type: 'GenerateImageNode', inputs: { model: 'nano-banana-2', style_refs: JSON.stringify({ folder: 'moodboard_3', files: ['m.png'] }) } },
      '2': { class_type: 'Image', inputs: { image: 'first.png' } },
      '3': { class_type: 'Image', inputs: { image: 'ignored.png', images: ['1', 0] } },
      '4': { class_type: 'Video', inputs: { file: 'clip.mp4' } },
    })
    expect(files).toEqual([
      { filename: 'm.png', subfolder: 'moodboard_3', type: 'input' },
      { filename: 'first.png', subfolder: '', type: 'input' },
      { filename: 'clip.mp4', subfolder: '', type: 'input' },
    ])
  })
  it('assertFilesOwned refuses someone else’s picture in hosted, not locally', async () => {
    const check = { ownsInput: vi.fn(async (_u: string, f: any) => f.filename !== 'theirs.png'), ownsOutput: vi.fn(async () => false) }
    const mine = { filename: 'mine.png', subfolder: '', type: 'input' as const }
    const theirs = { filename: 'theirs.png', subfolder: '', type: 'input' as const }
    await expect(assertFilesOwned([mine], 'u1', true, check)).resolves.toBeUndefined()
    await expect(assertFilesOwned([mine, theirs], 'u1', true, check)).rejects.toMatchObject({ statusCode: 403 })
    await expect(assertFilesOwned([theirs], null, false, check)).resolves.toBeUndefined()
    await expect(assertFilesOwned([{ filename: 'x.png', subfolder: '', type: 'output' }], 'u1', true, check)).rejects.toMatchObject({ statusCode: 403 })
  })
})
