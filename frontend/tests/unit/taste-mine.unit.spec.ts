// Observed-taste miner (app/lib/taste/mine.ts).
//
// Two halves:
//  1. Always-on fixture tests: a synthetic projects dir with one legacy bare
//     LiteGraph workflow, one ProjectDoc-with-canvases doc, and all three
//     schema-drift cases (v1 singular shader `effect`, gradient legacy
//     `relief.grain`, Vector Type legacy flat fill/stroke). The assertions read
//     POST-migration paths, so a broken migration call turns them red.
//  2. The actual mine run, guarded by TASTE_MINE=1: walks the real saved
//     projects at <repo>/user/sailor/projects and writes per-param stats to
//     app/lib/taste/observed.json.
//
//     Run:  TASTE_MINE=1 npx vitest run tests/unit/taste-mine.unit.spec.ts

import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  aggregate,
  mineVersion,
  pickLatestVersionFile,
  type MineResult,
  type ObservedTaste,
} from '~/lib/taste/mine'

// ── Shared walker: projects dir → aggregated stats ──────────────────────────

function emptyResult(): MineResult {
  return { nums: [], enums: [], colors: [], nodeCounts: { gradient: 0, shader: 0, vectorType: 0 } }
}

/** Walk a projects dir, mining ONLY the latest version per project. */
function mineProjectsDir(root: string, topN?: number): ObservedTaste {
  const res = emptyResult()
  let scanned = 0
  let mined = 0
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory())
  for (const entry of entries) {
    scanned++
    const versionsDir = path.join(root, entry.name, 'versions')
    if (!fs.existsSync(versionsDir)) continue
    const latest = pickLatestVersionFile(fs.readdirSync(versionsDir))
    if (!latest) continue
    let version: unknown
    try {
      version = JSON.parse(fs.readFileSync(path.join(versionsDir, latest), 'utf8'))
    } catch { continue }
    const before = res.nodeCounts.gradient + res.nodeCounts.shader + res.nodeCounts.vectorType
    mineVersion(version, entry.name, res)
    const after = res.nodeCounts.gradient + res.nodeCounts.shader + res.nodeCounts.vectorType
    if (after > before) mined++
  }
  return aggregate(res, { projectsScanned: scanned, projectsMined: mined }, topN)
}

// ── Synthetic fixture: all three studios, all three drift cases ─────────────

/** ProjectDoc (canvases) carrying a legacy-grain Gradient node and a legacy
 *  flat-fill Vector Type node. */
function projectDocVersion(): unknown {
  return {
    id: 'v1', name: 'current', createdAt: 1,
    workflow: {
      canvases: [{
        id: 'c1',
        workflow: {
          nodes: [
            {
              type: 'GradientStudio',
              properties: {
                sailor_gradientStudio: {
                  seed: '#fixture',
                  canvas: { aspect: '1:1', layout: 'liquid', margin: 0, background: '#100a24', center: { x: 0, y: 0 } },
                  // Legacy grain: ensureConfigDefaults must migrate this to
                  // post.grainAmount and DELETE relief.grain.
                  relief: { grain: 0.8, relief: 0, light: { azimuth: 192, elevation: 45 } },
                  flow: { angle: 110, intensity: 100 },
                  layers: [{
                    blend: 'normal', opacity: 1,
                    shape: { type: 'bands', count: 12 },
                    color: { stops: [{ color: '#3c61f1', pos: 0 }, { color: '#d9ff39', pos: 1 }] },
                  }],
                },
                sailor_varBindings: { ignored: true },
              },
            },
            {
              type: 'VectorType',
              properties: {
                sailor_vectorType: {
                  // Legacy flat paint: mergeConfig must migrate fill/stroke
                  // into the appearance[] stack.
                  config: { text: 'Hi', size: 120, fill: '#ff0000', stroke: '#00ff00', strokeWidth: 2 },
                  canvasW: 1280, canvasH: 720, aspectKey: '16:9', background: '#0b0d12',
                },
              },
            },
          ],
          links: [],
        },
      }],
    },
  }
}

/** Legacy bare LiteGraph workflow (no canvases) carrying a v1 shader config
 *  (singular `effect`, no effects[]). */
function legacyWorkflowVersion(uCount: number): unknown {
  return {
    id: 'v2', name: 'named', createdAt: 2,
    workflow: {
      nodes: [{
        type: 'ShaderStudio',
        properties: {
          sailor_shaderStudio: {
            version: 1,
            source: { kind: 'none' },
            resolution: 1536,
            // u_chromatic survives the v1->v4 Textured Glass migration untouched
            // (only u_depth/u_shadeWidth are retired — see migrate.ts's
            // migrateTexturedGlass), so it's a stable non-retired param to probe.
            effect: { id: 'blinds', params: { u_count: uCount, u_chromatic: 0.34 }, enabled: true },
            duotone: { enabled: true, ink: '#1a1a2e', paper: '#f5f5f5' },
          },
        },
      }],
      links: [],
    },
  }
}

function writeFixtureDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-mine-'))
  // Project A: ProjectDoc, has current.json AND an older named version whose
  // values must NOT be counted (latest-only rule).
  const a = path.join(root, 'aaaaaaaa-0000-0000-0000-000000000001', 'versions')
  fs.mkdirSync(a, { recursive: true })
  fs.writeFileSync(path.join(a, 'current.json'), JSON.stringify(projectDocVersion()))
  const staleDoc: any = projectDocVersion()
  staleDoc.workflow.canvases[0].workflow.nodes[0].properties.sailor_gradientStudio.relief.grain = 0.1
  fs.writeFileSync(path.join(a, 'b_1000.json'), JSON.stringify(staleDoc))
  // Project B: legacy bare workflow, ONLY named versions — the newest b_ wins.
  const b = path.join(root, 'bbbbbbbb-0000-0000-0000-000000000002', 'versions')
  fs.mkdirSync(b, { recursive: true })
  fs.writeFileSync(path.join(b, 'b_1000.json'), JSON.stringify(legacyWorkflowVersion(5)))
  fs.writeFileSync(path.join(b, 'b_2000.json'), JSON.stringify(legacyWorkflowVersion(39)))
  // Project C: no versions at all — must be skipped, not crash.
  fs.mkdirSync(path.join(root, 'cccccccc-0000-0000-0000-000000000003'), { recursive: true })
  return root
}

describe('taste miner (fixtures)', () => {
  test('pickLatestVersionFile prefers current.json, else newest b_<ms>', () => {
    expect(pickLatestVersionFile(['b_1000.json', 'current.json', 'b_2000.json'])).toBe('current.json')
    expect(pickLatestVersionFile(['b_1000.json', 'b_2000.json'])).toBe('b_2000.json')
    expect(pickLatestVersionFile(['notes.txt'])).toBeNull()
    expect(pickLatestVersionFile([])).toBeNull()
  })

  test('handles legacy workflow, ProjectDoc, and all three schema drifts', () => {
    const root = writeFixtureDir()
    try {
      // Every fixture param has n=1, so rank alone can't guarantee a specific
      // path makes a small top-N cut — take them all for the attribution check.
      const observed = mineProjectsDir(root, Number.MAX_SAFE_INTEGER)

      expect(observed.projectsScanned).toBe(3)
      expect(observed.projectsMined).toBe(2)
      expect(observed.studios.gradient.nodes).toBe(1)
      expect(observed.studios.shader.nodes).toBe(1) // latest b_ only, not both
      expect(observed.studios.vectorType.nodes).toBe(1)

      // Shader drift: v1 singular `effect` must surface at the POST-migration
      // effects[<id>] path. A broken migrateShaderConfig call turns this red.
      const shader = observed.studios.shader
      expect(shader.params['effects[blinds].params.u_count']).toMatchObject({ n: 1, median: 39 })
      expect(shader.params['effects[blinds].params.u_chromatic']).toMatchObject({ n: 1, median: 0.34 })
      expect(Object.keys(shader.params).some(p => p.startsWith('effect.'))).toBe(false)
      // Latest-only: the older b_1000 value (u_count 5) must not appear.
      expect(shader.params['effects[blinds].params.u_count']!.min).toBe(39)
      // Duotone colors pooled (enabled in the fixture).
      expect(shader.colors['#1a1a2e']).toBe(1)
      expect(shader.colors['#f5f5f5']).toBe(1)

      // Gradient drift: legacy relief.grain must land at post.grainAmount and
      // the legacy path must be GONE. Red if ensureConfigDefaults is skipped.
      const gradient = observed.studios.gradient
      expect(gradient.params['post.grainAmount']).toMatchObject({ n: 1, median: 0.8 })
      expect(gradient.params['relief.grain']).toBeUndefined()
      expect(gradient.enums['post.grain']).toMatchObject({ true: 1 })
      // Stop colors + background pooled; stale version's values not counted.
      expect(gradient.colors['#3c61f1']).toBe(1)
      expect(gradient.colors['#100a24']).toBe(1)

      // Vector Type drift: legacy flat fill/stroke must surface as the
      // appearance[] stack. Red if mergeConfig is skipped.
      const vt = observed.studios.vectorType
      expect(vt.params['appearance[stroke].width']).toMatchObject({ n: 1, median: 2 })
      expect(vt.params['size']).toMatchObject({ n: 1, median: 120 })
      expect(vt.params['canvas.canvasW']).toMatchObject({ n: 1, median: 1280 })
      expect(vt.colors['#ff0000']).toBe(1) // legacy fill → appearance[fill].paint.a
      expect(vt.colors['#00ff00']).toBe(1) // legacy stroke → appearance[stroke].paint.a
      expect(vt.colors['#0b0d12']).toBe(1) // wrapper background

      // Attribution: topParams carries per-project values.
      const top = observed.topParams.find(t => t.studio === 'gradient' && t.path === 'post.grainAmount')
      expect(top?.perProject['aaaaaaaa-0000-0000-0000-000000000001']).toEqual([0.8])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── The real mine run (opt-in: TASTE_MINE=1) ────────────────────────────────

const PROJECTS_DIR = path.resolve(__dirname, '../../..', 'user/sailor/projects')
const OUT_FILE = path.resolve(__dirname, '../..', 'app/lib/taste/observed.json')

const mineTest = process.env.TASTE_MINE ? test : test.skip

describe('taste miner (real projects)', () => {
  mineTest('mines saved projects into app/lib/taste/observed.json', () => {
    expect(fs.existsSync(PROJECTS_DIR), `projects dir missing: ${PROJECTS_DIR}`).toBe(true)
    const observed = mineProjectsDir(PROJECTS_DIR)
    fs.writeFileSync(OUT_FILE, JSON.stringify(observed, null, 2) + '\n')

    expect(observed.projectsScanned).toBeGreaterThan(0)
    const totalNodes = observed.studios.gradient.nodes
      + observed.studios.shader.nodes + observed.studios.vectorType.nodes
    expect(totalNodes).toBeGreaterThan(0)
    // eslint-disable-next-line no-console
    console.log(`[taste-mine] scanned=${observed.projectsScanned} mined=${observed.projectsMined}`
      + ` gradient=${observed.studios.gradient.nodes} shader=${observed.studios.shader.nodes}`
      + ` vectorType=${observed.studios.vectorType.nodes} -> ${OUT_FILE}`)
  })
})
