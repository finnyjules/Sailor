/**
 * Unpack an ambientCG 1K-JPG material zip into `destDir`, keeping only the map JPEGs
 * under fixed names and writing a manifest. The zip also carries .blend/.usdc/.mtlx/.tres
 * side files and a preview PNG, all dropped. NormalGL is kept (three.js convention);
 * NormalDX is dropped. Pure over bytes + a directory, so tests build a zip in memory.
 */
import JSZip from 'jszip'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

export type TextureMapKey = 'color' | 'roughness' | 'normal' | 'displacement' | 'ao' | 'metalness'

/** Manifest key → the fixed filename written to disk. Order = manifest order. */
export const TEXTURE_MAP_FILES: Record<TextureMapKey, string> = {
  color: 'Color.jpg',
  roughness: 'Roughness.jpg',
  normal: 'NormalGL.jpg',
  displacement: 'Displacement.jpg',
  ao: 'AmbientOcclusion.jpg',
  metalness: 'Metalness.jpg',
}

/** ambientCG's suffix inside the zip (`<Id>_1K-JPG_<Suffix>.jpg`) → manifest key. */
const SUFFIX_TO_KEY: Record<string, TextureMapKey> = {
  Color: 'color',
  Roughness: 'roughness',
  NormalGL: 'normal',
  Displacement: 'displacement',
  AmbientOcclusion: 'ao',
  Metalness: 'metalness',
}

export interface TextureManifest {
  id: string
  maps: TextureMapKey[]
  fetchedAt: string
}

export async function extractTextureZip(zipBytes: Uint8Array, id: string, destDir: string): Promise<TextureManifest> {
  const zip = await JSZip.loadAsync(zipBytes)
  const found = new Map<TextureMapKey, JSZip.JSZipObject>()
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const m = /_([A-Za-z]+)\.jpe?g$/i.exec(name)
    const suffix = m?.[1]
    const key = suffix ? SUFFIX_TO_KEY[suffix] : undefined
    if (key && !found.has(key)) found.set(key, entry)
  }
  if (!found.has('color')) throw new Error(`Texture set ${id} has no colour map`)

  await mkdir(destDir, { recursive: true })
  try {
    const maps: TextureMapKey[] = []
    for (const key of Object.keys(TEXTURE_MAP_FILES) as TextureMapKey[]) {
      const entry = found.get(key)
      if (!entry) continue
      await writeFile(join(destDir, TEXTURE_MAP_FILES[key]), await entry.async('uint8array'))
      maps.push(key)
    }
    const manifest: TextureManifest = { id, maps, fetchedAt: new Date().toISOString() }
    await writeFile(join(destDir, 'manifest.json'), JSON.stringify(manifest))
    return manifest
  } catch (err) {
    await rm(destDir, { recursive: true, force: true })
    throw err
  }
}
