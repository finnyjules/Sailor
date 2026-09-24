/**
 * Hosted /prompt gate — moodboard reference pictures (B8 review, 2026-09-24).
 *
 * GenerateImageNode and RestyleFromImageNode carry a hidden `style_refs` JSON
 * naming files under input/moodboard_<ms>/. The folder is a timestamp, so it
 * is guessable: without a check a tenant could point their run at another
 * tenant's board. The hosted gate must refuse any named file the caller did
 * not upload — keyed exactly as the moodboard upload route records it,
 * canonicalUploadKey('input', folder, file), the same rule runner/inputs.ts
 * applies on the runner path.
 *
 * Drives runGraphFileValidation — the live hosted wiring — so the key the
 * gate looks up is proven, not stubbed away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const owners = new Map<string, string>()

vi.mock('../../server/utils/inputUploads', async (orig) => {
  const real = await orig<typeof import('../../server/utils/inputUploads')>()
  return { ...real, uploadOwner: vi.fn(async (key: string) => owners.get(key) ?? null) }
})
vi.mock('../../server/utils/graphRuns', async (orig) => {
  const real = await orig<typeof import('../../server/utils/graphRuns')>()
  return { ...real, ownedOutputKeys: vi.fn(async () => new Set<string>()) }
})

const { runGraphFileValidation, __resetUploadFlagMapForTests } = await import('../../server/utils/meterGraphRun')
const { canonicalUploadKey } = await import('../../server/utils/inputUploads')
const { MeterRefusalError } = await import('../../server/utils/requestMeter')
const { extractFileRefs, GRAPH_FILE_READERS } = await import('../../server/utils/engineFileSurface')

const ALICE = 'user_alice'
const BOB = 'user_bob'
const TARGET = 'http://engine.test'
const FOLDER = 'moodboard_1727000000000'

const styleRefs = (folder: string, files: unknown[]) => JSON.stringify({ folder, files })
const graph = (class_type: string, style_refs: unknown) => ({
  '1': { class_type, inputs: { prompt: 'a lighthouse', style_refs } },
})

beforeEach(() => {
  owners.clear()
  __resetUploadFlagMapForTests()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  // Alice's board, recorded under the key images.post.ts writes.
  for (const f of ['a.png', 'b.webp']) owners.set(canonicalUploadKey('input', FOLDER, f), ALICE)
})
afterEach(() => { vi.unstubAllGlobals() })

describe.each(['GenerateImageNode', 'RestyleFromImageNode'])('hosted gate — %s moodboard refs', (ct) => {
  it('allows a run on the caller\'s own board', async () => {
    await expect(runGraphFileValidation(graph(ct, styleRefs(FOLDER, ['a.png', 'b.webp'])), ALICE, TARGET))
      .resolves.toBeUndefined()
  })

  it('REFUSES (403) another tenant\'s board', async () => {
    const run = () => runGraphFileValidation(graph(ct, styleRefs(FOLDER, ['a.png'])), BOB, TARGET)
    await expect(run()).rejects.toBeInstanceOf(MeterRefusalError)
    await expect(run()).rejects.toMatchObject({ statusCode: 403 })
  })

  it('REFUSES when one file of an otherwise-own board is someone else\'s', async () => {
    owners.set(canonicalUploadKey('input', FOLDER, 'c.png'), BOB)
    await expect(runGraphFileValidation(graph(ct, styleRefs(FOLDER, ['a.png', 'c.png'])), ALICE, TARGET))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('REFUSES a file nobody uploaded (no ownership row)', async () => {
    await expect(runGraphFileValidation(graph(ct, styleRefs(FOLDER, ['ghost.png'])), ALICE, TARGET))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('REFUSES a wired / non-string style_refs — it cannot be vetted', async () => {
    await expect(runGraphFileValidation(graph(ct, ['2', 0]), BOB, TARGET)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('passes an empty style_refs — no board, nothing read', async () => {
    await expect(runGraphFileValidation(graph(ct, ''), BOB, TARGET)).resolves.toBeUndefined()
  })
})

describe('moodboard refs — same parse rule as the engine and the runner', () => {
  const refs = (raw: string) => extractFileRefs(GRAPH_FILE_READERS.GenerateImageNode![0]!, raw)

  it('names each file as <folder>/<file>, split back into canonicalUploadKey\'s subfolder + filename', () => {
    expect(refs(styleRefs('moodboard_5', ['a.png', 'b.jpg']))).toEqual(['moodboard_5/a.png', 'moodboard_5/b.jpg'])
  })

  it('vets the ≤3 image files the engine would read', () => {
    expect(refs(styleRefs('moodboard_5', ['a.png', 'x.txt', '../y.png', 'b.png', 'c.png', 'd.png'])))
      .toEqual(['moodboard_5/a.png', 'moodboard_5/b.png', 'moodboard_5/c.png'])
  })

  it('a payload the engine ignores (non-moodboard folder) names nothing', () => {
    expect(refs(styleRefs('lora_dataset_1', ['a.png']))).toEqual([])
  })
})
