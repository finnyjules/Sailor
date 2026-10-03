import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { PNG } from 'pngjs'

// Browser/server shader parity gate: renders every catalog effect through the
// WebGL2 singleton renderer (frontend/app/lib/shaderfx/renderer.ts) on the
// /dev/shaderfx-harness page and diffs against the server-GL golden PNGs in
// tests/fixtures/shaderfx-golden (rendered by the old Python server-GL path at
// u_time=0.7, u_seed=42, defaults; frozen when Python left the repo, step 4 C7).
//
// Requires the WORKTREE's dev server. The shared playwright.config.ts baseURL
// (3002) may point at a different checkout's dev server — override with:
//   SHADERFX_BASE_URL=http://127.0.0.1:3210 npx playwright test tests/shaderfx-golden.spec.ts --project=chromium

const thisDir = fileURLToPath(new URL('.', import.meta.url))
const ROOT = path.resolve(thisDir, '..', '..')
const CATALOG = path.join(ROOT, 'shader_effects')
const GOLDEN = path.join(ROOT, 'frontend', 'tests', 'fixtures', 'shaderfx-golden')

const BASE_URL = process.env.SHADERFX_BASE_URL ?? ''

const GOLDEN_TIME = 0.7
const GOLDEN_SEED = 42
const SIZES = [128, 256]

// Browser-vs-server tolerance, starting from the calibrated timeline WebGL numbers
// (mean 2.5/255, >8/255 outliers ≤ 6%). Recalibrate in Step 4 if the spike demands it.
const PCT_THRESHOLD = 8 / 255
const MAX_MEAN = 2.5 / 255
const MAX_PCT_OVER = 0.06

function diffStats(a: PNG, b: PNG): { max: number; mean: number; pctOver: number } {
  if (a.width !== b.width || a.height !== b.height) return { max: 1, mean: 1, pctOver: 1 }
  let max = 0, sum = 0, over = 0, n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i + c]! - b.data[i + c]!) / 255
      if (d > max) max = d
      if (d > PCT_THRESHOLD) over++
      sum += d
      n++
    }
  }
  return { max, mean: sum / n, pctOver: over / n }
}

function dataUrl(file: string): string {
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
}

interface GradientStop { pos: number; color: string }
type ParamDefault = number | string | GradientStop[]

interface ManifestEffect {
  id: string
  animated?: boolean
  params: { uniform: string; type?: string; default: ParamDefault; maxStops?: number }[]
  textures: { uniform: string; file: string; extraUniforms?: Record<string, number> }[]
}

type UniformValue = number | [number, number, number]

/** Mirrors parse_hex() in _shader_effects.py and hexVec3() in lib/shaderfx/params.ts. */
function hexVec3(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = parseInt(h, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** The same expansion `to_uniforms()` performs, so the harness feeds the browser
 *  renderer exactly what the server golden was rendered from. */
function paramUniforms(p: ManifestEffect['params'][number]): Record<string, UniformValue> {
  if (p.type === 'color') return { [p.uniform]: hexVec3(p.default as string) }
  if (p.type === 'gradient') {
    const stops = [...(p.default as GradientStop[])].sort((a, b) => a.pos - b.pos).slice(0, p.maxStops ?? 8)
    const out: Record<string, UniformValue> = { [`${p.uniform}Count`]: stops.length }
    stops.forEach((s, i) => {
      out[`${p.uniform}[${i}]`] = hexVec3(s.color)
      out[`${p.uniform}Pos[${i}]`] = s.pos
    })
    return out
  }
  return { [p.uniform]: p.default as number }
}

const manifest = JSON.parse(fs.readFileSync(path.join(CATALOG, 'manifest.json'), 'utf-8'))

for (const eff of manifest.effects as ManifestEffect[]) {
  for (const size of SIZES) {
    test(`parity: ${eff.id} @ ${size}`, async ({ page }) => {
      const goldenPath = path.join(GOLDEN, `${eff.id}_${size}.png`)
      expect(fs.existsSync(goldenPath), `missing golden ${goldenPath}`).toBe(true)

      const uniforms: Record<string, UniformValue> = { u_time: GOLDEN_TIME, u_seed: GOLDEN_SEED, u_hasInput: 1 }
      for (const p of eff.params) Object.assign(uniforms, paramUniforms(p))
      const textures: Record<string, string> = {}
      for (const t of eff.textures) {
        textures[t.uniform] = dataUrl(path.join(CATALOG, 'assets', t.file))
        for (const [k, v] of Object.entries(t.extraUniforms ?? {})) uniforms[k] = v
      }

      await page.goto(`${BASE_URL}/dev/shaderfx-harness`)
      await page.waitForFunction(() => (window as any).__renderShaderFx)
      const out = await page.evaluate(
        job => (window as any).__renderShaderFx(job),
        {
          effectId: eff.id,
          source: fs.readFileSync(path.join(CATALOG, `${eff.id}.frag`), 'utf-8'),
          uniforms,
          textures,
          baseDataUrl: dataUrl(path.join(GOLDEN, `fixture_${size}.png`)),
          width: size,
          height: size,
          passes: (eff as any).passes ?? 1,
        },
      )

      const browser = PNG.sync.read(Buffer.from(out.split(',')[1]!, 'base64'))
      const golden = PNG.sync.read(fs.readFileSync(goldenPath))
      const stats = diffStats(browser, golden)
      console.log(`parity ${eff.id}@${size}: mean=${(stats.mean * 255).toFixed(3)}/255 max=${(stats.max * 255).toFixed(1)}/255 pctOver=${(stats.pctOver * 100).toFixed(2)}%`)
      expect(stats.mean).toBeLessThanOrEqual(MAX_MEAN)
      expect(stats.pctOver).toBeLessThanOrEqual(MAX_PCT_OVER)
    })
  }
}
