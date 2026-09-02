/**
 * The on-disk half of the ambientCG texture cache: where a downloaded set
 * lives under the engine's `input/`, and whether it is still usable.
 *
 * Split out of the fetch route so the decision — "given an input dir and an
 * id, is there a usable manifest already on disk?" — is a pure-ish function a
 * unit test can drive over a `mkdtemp` directory, leaving the route as
 * plumbing (validate, read disk, else download).
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { TextureManifest } from './ambientcgExtract'

/**
 * Must match app/lib/scene3d/textures.ts's TEXTURES_SUBDIR exactly — the
 * client builds the `/view` URLs for these files from its own copy and cannot
 * import server code. Guarded by tests/unit/ambientcg-contract.unit.spec.ts.
 */
export const TEXTURES_SUBDIR = 'sailor_textures'

/** `<input>/sailor_textures/<id>` — the directory one set's maps live in. */
export function textureSetDir(inputDir: string, id: string): string {
  return join(inputDir, TEXTURES_SUBDIR, id)
}

/**
 * The manifest for an already-downloaded set, or null when there isn't a
 * usable one.
 *
 * Self-healing: a manifest that fails to parse, or that parses to something
 * without an array `maps`, is not a permanent failure — the directory is
 * removed so the caller's download path can rebuild it. A truncated write
 * (a crash mid-extract, a full disk) would otherwise wedge that one set
 * forever, since every later request would find the file present and blow up
 * on JSON.parse.
 */
export async function readDiskManifest(inputDir: string, id: string): Promise<TextureManifest | null> {
  const dir = textureSetDir(inputDir, id)
  let raw: string
  try {
    raw = await readFile(join(dir, 'manifest.json'), 'utf8')
  } catch {
    return null // not downloaded yet (or unreadable) — the caller downloads
  }
  try {
    const parsed = JSON.parse(raw) as TextureManifest
    if (!parsed || !Array.isArray(parsed.maps)) throw new Error('manifest has no maps array')
    return parsed
  } catch {
    await rm(dir, { recursive: true, force: true })
    return null
  }
}
