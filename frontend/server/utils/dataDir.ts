/**
 * Store-directory resolution for the flat JSON/asset stores (Stage 6). With
 * SAILOR_DATA_DIR unset (local dev, and any deploy that hasn't opted in),
 * every store resolves to its historical path — byte-identical to
 * pre-Stage-6 behavior. With SAILOR_DATA_DIR set (hosted, pointed at the Fly
 * volume) every store moves under it, created on first use so a fresh volume
 * doesn't need a manual mkdir.
 */
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

export type StoreName = 'brand-kits' | 'moodboards' | 'templates-layouts' | 'templates-fonts-user' | 'frame-templates' | 'data'

const LOCAL_PATHS: Record<StoreName, string[]> = {
  'brand-kits': ['server', 'brand-kits'],
  'moodboards': ['server', 'moodboards'],
  'templates-layouts': ['server', 'templates', 'layouts'],
  'templates-fonts-user': ['server', 'templates', 'fonts', 'user'],
  'frame-templates': ['server', 'frame-templates'],
  'data': ['.data'],
}

export function storeDir(name: StoreName): string {
  const base = process.env.SAILOR_DATA_DIR
  if (base) {
    const dir = join(base, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  return join(process.cwd(), ...LOCAL_PATHS[name])
}
