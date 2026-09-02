import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractTextureZip, TEXTURE_MAP_FILES } from '../../server/utils/ambientcgExtract'

async function fixtureZip(names: string[]): Promise<Uint8Array> {
  const z = new JSZip()
  for (const n of names) z.file(n, `bytes-of-${n}`)
  return new Uint8Array(await z.generateAsync({ type: 'uint8array' }))
}

describe('extractTextureZip', () => {
  it('writes only the renamed maps plus a manifest, drops side files and NormalDX', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acg-'))
    try {
      const zip = await fixtureZip([
        'Wood095_1K-JPG_Color.jpg', 'Wood095_1K-JPG_Roughness.jpg', 'Wood095_1K-JPG_NormalGL.jpg',
        'Wood095_1K-JPG_NormalDX.jpg', 'Wood095_1K-JPG_Displacement.jpg',
        'Wood095_1K-JPG.blend', 'Wood095_1K-JPG.mtlx', 'Wood095_1K-JPG.usdc', 'Wood095.png',
      ])
      const m = await extractTextureZip(zip, 'Wood095', dir)
      expect(m.id).toBe('Wood095')
      expect(m.maps).toEqual(['color', 'roughness', 'normal', 'displacement'])
      const files = (await readdir(dir)).sort()
      expect(files).toEqual(['Color.jpg', 'Displacement.jpg', 'NormalGL.jpg', 'Roughness.jpg', 'manifest.json'])
      expect((await readFile(join(dir, 'Color.jpg'), 'utf8'))).toBe('bytes-of-Wood095_1K-JPG_Color.jpg')
      expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).maps).toEqual(m.maps)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('records ao and metalness when present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acg-'))
    try {
      const zip = await fixtureZip(['X_1K-JPG_Color.jpg', 'X_1K-JPG_AmbientOcclusion.jpg', 'X_1K-JPG_Metalness.jpg'])
      const m = await extractTextureZip(zip, 'X', dir)
      expect(m.maps).toEqual(['color', 'ao', 'metalness'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('rejects a zip with no colour map and leaves nothing behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acg-'))
    try {
      const zip = await fixtureZip(['X_1K-JPG.blend'])
      await expect(extractTextureZip(zip, 'X', dir)).rejects.toThrow(/no colour map/i)
      expect(await readdir(dir)).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('rejects a corrupt zip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acg-'))
    try {
      await expect(extractTextureZip(new Uint8Array([1, 2, 3]), 'X', dir)).rejects.toThrow()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('exposes the fixed filenames', () => {
    expect(TEXTURE_MAP_FILES.color).toBe('Color.jpg')
    expect(TEXTURE_MAP_FILES.normal).toBe('NormalGL.jpg')
    expect(TEXTURE_MAP_FILES.ao).toBe('AmbientOcclusion.jpg')
  })
})
