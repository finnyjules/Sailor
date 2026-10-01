/**
 * Tasks R9.2 and R9.3 (engine-free step 3, decision 5): the Timeline editor
 * exports in the browser only, and the dead Timeline pieces are gone.
 *   - TimelineEditor.vue has no server route: no fetch of the engine's
 *     Timeline renders, no `renderOnServer`, and the `Sailor.VideoExport`
 *     switch no longer reaches it. A browser that can't record says why, in
 *     both places, and makes nothing.
 *   - No file the app, its server or its shared code is built from names the
 *     three engine Timeline routes; TimelineModal.vue and the server frame
 *     renderer are deleted; hosted refuses the routes by default.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifySailor, hostedEngineDecision } from '~~/server/utils/enginePath'

const root = process.cwd()
const editor = readFileSync(join(root, 'app/components/vue-canvas/TimelineEditor.vue'), 'utf8')
// Spelled in pieces so this guard does not name them itself.
const ROUTES = ['render_timeline_stream', 'render_timeline', 'timeline/render_frame'].map(r => `/sailor/${r}`)

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

describe('the Timeline editor exports in the browser only (R9.2)', () => {
  it('has no server route', () => {
    for (const r of ROUTES) expect(editor.includes(r), r).toBe(false)
    expect(editor).not.toMatch(/renderOnServer/)
    expect(editor).not.toMatch(/prefersServerVideoExport/)
    expect(editor).not.toMatch(/ensureTimelineMix|ensureMotionBake/)
  })

  it('a browser that can\'t record says why, locally as in hosted, and makes nothing', () => {
    const body = editor.slice(editor.indexOf('async function exportTimeline()'), editor.indexOf('/** A failed upload in plain words'))
    expect(body).toContain('Video export failed: ${reason}.')
    expect(body).toContain("reason = 'this browser has no WebGL2'")
    expect(body).toContain('reason = "this browser can\'t record video"')
    // The failure is not gated on hosted mode any more.
    expect(body).not.toMatch(/if \(hosted\) \{\s*renderError/)
    expect(body).not.toMatch(/Made on the server/)
  })
})

describe('the dead Timeline pieces are gone (R9.3)', () => {
  it('TimelineModal.vue and the server frame renderer are deleted', () => {
    expect(existsSync(join(root, 'app/components/vue-canvas/TimelineModal.vue'))).toBe(false)
    expect(existsSync(join(root, 'app/lib/serverFrameRenderer.ts'))).toBe(false)
  })

  it('no app, server or shared file names the three routes', () => {
    const hits: string[] = []
    for (const dir of ['app', 'server', 'shared']) {
      for (const f of filesUnder(join(root, dir))) {
        const src = readFileSync(f, 'utf8')
        for (const r of ROUTES) if (src.includes(r)) hits.push(`${f.slice(root.length + 1)}: ${r}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('hosted refuses them by default (unlisted)', () => {
    for (const r of ROUTES) {
      expect(classifySailor(r, 'POST').bucket, r).toBe('unknown')
      expect(hostedEngineDecision(r, 'POST').kind, r).toBe('forbid')
    }
  })
})
