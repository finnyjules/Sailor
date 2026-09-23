import { describe, expect, it } from 'vitest'
import { galleryItemKey, mergeGenerationIntoGallery, type GalleryItem } from '~/lib/assets/galleryMerge'

const file = { filename: 'sailor_00001_.png', subfolder: '', type: 'output' }
const key = 'output::sailor_00001_.png'
const project = { uuid: 'proj-1', name: 'Poster' }
const runnerRecord = { ...file, promptId: 'run_abc.1.t3', timestamp: 1_700_000_000_000 }

function diskItem(): GalleryItem {
  return { promptId: `file:${key}`, status: 'completed', images: [{ ...file }], executionTime: null, timestamp: 1_600_000_000_000 }
}

describe('mergeGenerationIntoGallery', () => {
  it('a disk-listed file with a runner record takes the record’s promptId, project and date', () => {
    const byPrompt = new Map<string, GalleryItem>([[`file:${key}`, diskItem()]])
    const seen = new Set([key])
    expect(mergeGenerationIntoGallery(byPrompt, seen, runnerRecord, project)).toBe('replaced')
    expect(byPrompt.size).toBe(1)
    const it = [...byPrompt.values()][0]!
    expect(it.promptId).toBe('run_abc.1.t3')
    expect(it.projectUuid).toBe('proj-1')
    expect(it.projectName).toBe('Poster')
    expect(it.timestamp).toBe(1_700_000_000_000)
    expect(it.images).toEqual([file])
  })

  it('a file owned by a real ComfyUI prompt is left alone', () => {
    const real: GalleryItem = { promptId: 'a1b2-comfy', status: 'completed', images: [{ ...file }], executionTime: 3, timestamp: 5, projectUuid: 'other' }
    const byPrompt = new Map<string, GalleryItem>([['a1b2-comfy', real]])
    const seen = new Set([key])
    expect(mergeGenerationIntoGallery(byPrompt, seen, runnerRecord, project)).toBe('skipped')
    expect(byPrompt.size).toBe(1)
    expect(byPrompt.get('a1b2-comfy')).toEqual({ promptId: 'a1b2-comfy', status: 'completed', images: [file], executionTime: 3, timestamp: 5, projectUuid: 'other' })
  })

  it('a record for a file nobody has seen becomes a new item', () => {
    const byPrompt = new Map<string, GalleryItem>()
    const seen = new Set<string>()
    expect(mergeGenerationIntoGallery(byPrompt, seen, runnerRecord, project)).toBe('added')
    expect(byPrompt.get(`gen:${key}`)).toEqual({
      promptId: 'run_abc.1.t3',
      status: 'completed',
      images: [file],
      executionTime: null,
      timestamp: 1_700_000_000_000,
      projectUuid: 'proj-1',
      projectName: 'Poster',
    })
    expect(seen.has(key)).toBe(true)
  })

  it('only the first record for a file claims it', () => {
    const byPrompt = new Map<string, GalleryItem>([[`file:${key}`, diskItem()]])
    const seen = new Set([key])
    mergeGenerationIntoGallery(byPrompt, seen, runnerRecord, project)
    expect(mergeGenerationIntoGallery(byPrompt, seen, { ...runnerRecord, promptId: 'run_zzz.1.t0' }, { uuid: 'proj-2', name: 'B' })).toBe('skipped')
    expect(byPrompt.get(`file:${key}`)!.promptId).toBe('run_abc.1.t3')
    expect(byPrompt.get(`file:${key}`)!.projectUuid).toBe('proj-1')
  })

  it('treats a missing subfolder as the root folder', () => {
    const byPrompt = new Map<string, GalleryItem>([[`file:${key}`, diskItem()]])
    const seen = new Set([key])
    const { subfolder: _drop, ...noSub } = runnerRecord
    expect(mergeGenerationIntoGallery(byPrompt, seen, noSub as typeof runnerRecord, project)).toBe('replaced')
  })
})

describe('galleryItemKey', () => {
  it('stays unique when one stage made two files (same promptId)', () => {
    const a: GalleryItem = { promptId: 'run_abc.1.t3', status: 'completed', images: [{ ...file }], executionTime: null, timestamp: 1 }
    const b: GalleryItem = { ...a, images: [{ ...file, filename: 'sailor_00002_.png' }] }
    expect(galleryItemKey(a)).not.toBe(galleryItemKey(b))
  })
})
