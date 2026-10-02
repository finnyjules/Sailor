/**
 * Task R10.4 (engine-free step 3, spec ruling 7): the studios export video in
 * the browser only.
 *   - studioVideoExport.ts has no server route: no fallback, no server switch,
 *     no "Made on the server" notice, no fetch of a server-made file.
 *   - None of its six callers carries a fallback or reads the old switch.
 *   - The engine encode client, the `Sailor.VideoExport` switch and the hosted
 *     gate's entry for the engine encode route are gone; nothing the app, its
 *     server or its shared code is built from names that route, and hosted
 *     refuses it by default.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifySailor, hostedEngineDecision } from '~~/server/utils/enginePath'
import * as support from '~/lib/engine/videoExportSupport'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')
// Spelled in pieces so this guard does not name it itself.
const ENCODE_ROUTE = ['spacetype', 'encode'].join('_')

const CALLERS = [
  'app/components/vue-canvas/ArtifactFrameNode.vue',
  'app/components/vue-canvas/Scene3DStudioSurface.vue',
  'app/components/vue-canvas/GradientStudioSurface.vue',
  'app/components/vue-canvas/ShaderStudioSurface.vue',
  'app/components/vue-canvas/CompositorModal.vue',
  'app/components/vue-canvas/SpaceTypeSurface.vue',
]

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...filesUnder(full))
    else if (/\.(ts|vue|js|mjs)$/.test(name)) out.push(full)
  }
  return out
}

describe('studio video exports are browser only (R10.4)', () => {
  it('the shared export has no server route', () => {
    const src = read('app/lib/studio/studioVideoExport.ts')
    expect(src).not.toMatch(/serverFallback|forceServer|Made on the server|resultBlob|\/view\?/)
    expect(src).toContain("Video export failed: this browser can't record video.")
    expect(src).toContain("Video export failed: the browser's video encoder failed.")
  })

  it('none of the six callers carries a fallback or reads the old switch', () => {
    for (const f of CALLERS) {
      const src = read(f)
      expect(src, f).toContain('exportStudioVideo(')
      expect(src, f).not.toMatch(/serverFallback|forceServer|prefersServerVideoExport|encodeFrames|engine\/encodeVideo|resultBlob|made\.notice/)
    }
  })

  it('the engine encode client and the server switch are deleted', () => {
    expect(existsSync(join(root, 'app/lib/engine/encodeVideo.ts'))).toBe(false)
    expect(Object.keys(support)).not.toContain('prefersServerVideoExport')
    expect(Object.keys(support)).not.toContain('VIDEO_EXPORT_PREF_KEY')
  })

  it('no app, server or shared file names the engine encode route', () => {
    const hits: string[] = []
    for (const dir of ['app', 'server', 'shared']) {
      for (const f of filesUnder(join(root, dir))) {
        if (readFileSync(f, 'utf8').includes(ENCODE_ROUTE)) hits.push(f.slice(root.length + 1))
      }
    }
    expect(hits).toEqual([])
  })

  it('nothing reads the old Sailor.VideoExport switch', () => {
    const key = ['Sailor', 'VideoExport'].join('.')
    const hits: string[] = []
    for (const dir of ['app', 'server', 'shared']) {
      for (const f of filesUnder(join(root, dir))) {
        if (readFileSync(f, 'utf8').includes(key)) hits.push(f.slice(root.length + 1))
      }
    }
    expect(hits).toEqual([])
  })

  it('hosted refuses the route by default (unlisted)', () => {
    const p = `/sailor/${ENCODE_ROUTE}`
    expect(classifySailor(p, 'POST').bucket).toBe('unknown')
    expect(hostedEngineDecision(p, 'POST').kind).toBe('forbid')
  })
})
