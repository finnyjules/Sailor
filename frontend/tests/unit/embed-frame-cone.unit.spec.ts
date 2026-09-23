import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { embedCone } from '../../scripts/embed-cone.mjs'
import { EMBED_INPUT_DIRS, EMBED_INPUT_FILES } from '../../scripts/embed-build-cache.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const cone = embedCone(['app/lib/embed/entry-frame.ts'])

describe('the Frame bundle\'s import cone', () => {
  it('is non-trivial (the walker actually walked)', () => {
    expect(cone.files).toContain('app/composables/useCompositorLayers.ts')
    expect(cone.files.length).toBeGreaterThan(100)
  })

  it('every file it is built from is hashed by the build cache', () => {
    const covered = (f: string) =>
      EMBED_INPUT_FILES.includes(f) || EMBED_INPUT_DIRS.some((d: string) => f === d || f.startsWith(`${d}/`))
    expect(cone.files.filter(f => !covered(f))).toEqual([])
  })

  it('names no package beyond the two it is known to need', () => {
    expect(cone.bare.filter(b => !['fontkit', 'paper'].includes(b))).toEqual([])
  })

  it('reaches no Vue or Nuxt code', () => {
    const offenders = cone.files.filter((f) => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
      return /from\s+['"]vue['"]|from\s+['"]#imports['"]|\$fetch\(|useRuntimeConfig\(/.test(
        src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/^\s*import\s+type\b/.test(l)).join('\n'))
    })
    expect(offenders).toEqual([])
  })
})
