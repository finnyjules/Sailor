import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDiskManifest, textureSetDir, TEXTURES_SUBDIR } from '../../server/utils/ambientcgDiskCache'

/**
 * The decision the fetch route makes BEFORE it is allowed to touch the
 * network: is there already a usable set on disk? Extracted into
 * ambientcgDiskCache so it can be driven over a real temp directory here,
 * which is the only way to test the corrupt-manifest self-heal (it deletes a
 * directory).
 */
async function seed(id: string, contents: string | null): Promise<string> {
  const input = await mkdtemp(join(tmpdir(), 'acg-input-'))
  if (contents !== null) {
    const dir = join(input, TEXTURES_SUBDIR, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'Color.jpg'), 'jpeg-bytes')
    await writeFile(join(dir, 'manifest.json'), contents)
  }
  return input
}

const exists = (p: string) => access(p).then(() => true, () => false)

describe('readDiskManifest (the fetch route\'s pre-catalog disk check)', () => {
  it('returns an already-downloaded manifest without consulting the catalog', async () => {
    // A catalog call is a network call to ambientcg.com; the whole point of
    // the disk-first ordering is that a restart with ambientcg.com down still
    // binds sets whose maps are already here. Spying on the module proves no
    // catalog import is reached from this path at all.
    const catalog = await import('../../server/utils/ambientcgCatalog')
    const spy = vi.spyOn(catalog, 'getAmbientcgCatalog')
    const manifest = { id: 'Wood095', maps: ['color', 'roughness'], fetchedAt: '2026-09-01T00:00:00.000Z' }
    const input = await seed('Wood095', JSON.stringify(manifest))
    try {
      expect(await readDiskManifest(input, 'Wood095')).toEqual(manifest)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      await rm(input, { recursive: true, force: true })
    }
  })

  it('removes a corrupt manifest and reports null so the caller re-downloads', async () => {
    const input = await seed('Wood095', '{"id":"Wood095","maps":[') // truncated write
    try {
      expect(await readDiskManifest(input, 'Wood095')).toBeNull()
      expect(await exists(textureSetDir(input, 'Wood095'))).toBe(false)
    } finally {
      await rm(input, { recursive: true, force: true })
    }
  })

  it('removes a manifest whose maps is not an array', async () => {
    const input = await seed('Wood095', '{"id":"Wood095","fetchedAt":"x"}')
    try {
      expect(await readDiskManifest(input, 'Wood095')).toBeNull()
      expect(await exists(textureSetDir(input, 'Wood095'))).toBe(false)
    } finally {
      await rm(input, { recursive: true, force: true })
    }
  })

  it('reports null for a set that was never downloaded', async () => {
    const input = await seed('Wood095', null)
    try {
      expect(await readDiskManifest(input, 'Wood095')).toBeNull()
    } finally {
      await rm(input, { recursive: true, force: true })
    }
  })

  it('scopes each set to its own directory under the textures subfolder', () => {
    expect(textureSetDir('/engine/input', 'Wood095')).toBe(join('/engine/input', 'sailor_textures', 'Wood095'))
  })
})
