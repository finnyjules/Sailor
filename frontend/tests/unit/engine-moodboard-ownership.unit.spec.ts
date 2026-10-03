/**
 * Moodboard reference pictures (B8 review, 2026-09-24): GenerateImageNode and
 * RestyleFromImageNode carry a hidden `style_refs` JSON naming files under
 * input/moodboard_<ms>/. The ownership rule (canonicalUploadKey('input',
 * folder, file)) is applied on the runner path (runner/inputs.ts).
 *
 * Step 3, R10.9: hosted never reaches the engine, so the hosted /prompt
 * wiring these cases used to drive (runGraphFileValidation) is gone. What
 * stays is the shared parse rule both paths read the files with.
 */
import { describe, expect, it } from 'vitest'

const { extractFileRefs, GRAPH_FILE_READERS } = await import('../../server/utils/engineFileSurface')

const styleRefs = (folder: string, files: unknown[]) => JSON.stringify({ folder, files })

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
