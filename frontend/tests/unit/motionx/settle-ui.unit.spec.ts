/**
 * SETTLE TRANSITIONS — THE UI (Addendum 3, Part 4).
 *
 * Source-level guards over the settle inspector block and its gallery preview, in the same
 * idiom `letters-ui.unit.spec.ts` uses for the Dither block: no rendering, just pinning what
 * the template and script text actually say, so a future edit can't quietly drop a Studio
 * control for a raw `<input>`/`<select>`, forget to cancel the preview's rAF loop, or let the
 * Open-into-keyframes button reappear for a settle bar.
 *
 * This file is NEW (not `letters-ui.unit.spec.ts`) because another implementer is editing that
 * file for the Steps easing task at the same time — see `.superpowers/sdd/dither/task-18-brief.md`.
 * Twenty-tile gallery-catalog coverage (ids, order, params, the stepped-ease amendment) lives in
 * `gallery.unit.spec.ts`, which nobody else is touching.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const INSPECTOR = fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/MotionInspector.vue', import.meta.url))
const GALLERY = fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/MotionGallery.vue', import.meta.url))
const SETTLE_PREVIEW = fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/MotionSettlePreview.vue', import.meta.url))
const DITHER_PREVIEW = fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/MotionDitherPreview.vue', import.meta.url))
const PREVIEW_CARD = fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/previewCard.ts', import.meta.url))

// ── 1. The settle inspector block ────────────────────────────────────────────

describe('the Settle inspector block', () => {
  const src = readFileSync(INSPECTOR, 'utf8')
  const SETTLE_TESTIDS = ['settle-effect', 'settle-dir', 'settle-strength', 'settle-fade']

  /** The first self-closing tag carrying this test id. */
  const tagFor = (testid: string) =>
    (src.match(/<\w+\b[\s\S]*?\/>/g) ?? []).find((t) => t.includes(`data-testid="${testid}"`))

  it('carries every settle test id', () => {
    for (const id of SETTLE_TESTIDS) expect(src).toContain(`data-testid="${id}"`)
  })

  it('lives in its own v-else-if sibling of the dither block', () => {
    expect(src).toMatch(/v-else-if="behaviour\.kind === 'settle'"/)
  })

  it('Effect is a labelled StudioSelect bound to the ten SETTLE_EFFECTS, and writes ONLY `effect`', () => {
    const tag = tagFor('settle-effect')
    expect(tag, 'no tag carries data-testid="settle-effect"').toBeTruthy()
    expect(tag).toMatch(/<StudioSelect\b/)
    expect(tag).toMatch(/label="Effect"/)
    expect(tag).toMatch(/:options="SETTLE_EFFECT_OPTIONS"/)
    expect(tag).toMatch(/:option-labels="SETTLE_EFFECT_LABELS"/)
    expect(tag).toMatch(/setBehParams\(\s*\{\s*effect:\s*v\s*\}\s*\)/)
    // Never writes `ease` here — an effect swap must not touch the bar's own curve.
    expect(tag).not.toMatch(/ease/)
    expect(src).toMatch(/const SETTLE_EFFECT_OPTIONS = SETTLE_EFFECTS\.map/)
    expect(src).toMatch(/const SETTLE_EFFECT_LABELS = SETTLE_EFFECTS\.map/)
  })

  it('Direction is a labelled StudioSegmentedRow, In / Out', () => {
    const tag = tagFor('settle-dir')
    expect(tag, 'no tag carries data-testid="settle-dir"').toBeTruthy()
    expect(tag).toMatch(/<StudioSegmentedRow\b/)
    expect(tag).toMatch(/label="Direction"/)
    expect(tag).toMatch(/:options="IN_OUT"/)
    expect(tag).toMatch(/:option-labels="IN_OUT_LABELS"/)
  })

  it('Starting strength is a StudioSlider, 0–100 step 1, default 70, with the settling hint, wired through gesture/setBehNum', () => {
    const tag = tagFor('settle-strength')
    expect(tag, 'no tag carries data-testid="settle-strength"').toBeTruthy()
    expect(tag).toMatch(/<StudioSlider\b/)
    expect(tag).toMatch(/label="Starting strength"/)
    expect(tag).toMatch(/:min="0"/)
    expect(tag).toMatch(/:max="100"/)
    expect(tag).toMatch(/:step="1"/)
    expect(tag).toMatch(/:default="70"/)
    expect(tag).toMatch(/numParam\('strength',\s*70\)/)
    expect(tag).toMatch(/v-bind="gesture\('settle-strength'\)"/)
    expect(tag).toMatch(/setBehNum\('settle-strength',\s*\{\s*strength:\s*v\s*\}\)/)
    expect(tag).toContain('How broken the layer is when the transition starts. It settles to nothing by the end.')
  })

  it('Fade is a labelled StudioSwitch bound to settleParams\' own fade', () => {
    const tag = tagFor('settle-fade')
    expect(tag, 'no tag carries data-testid="settle-fade"').toBeTruthy()
    expect(tag).toMatch(/<StudioSwitch\b/)
    expect(tag).toMatch(/label="Fade while it settles"/)
    expect(tag).toMatch(/:model-value="settle\.fade"/)
  })

  it('uses only Studio controls inside the settle block — no raw <input> or <select>', () => {
    const start = src.indexOf("kind === 'settle'")
    expect(start, 'no settle branch found').toBeGreaterThan(-1)
    const end = src.indexOf('</template>', start)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    expect(block).not.toMatch(/<input\b/i)
    expect(block).not.toMatch(/<select\b/i)
  })

  it('reads settle params through the ONE `settleParams` reader, like `reveal` does for dither', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bsettleParams\b[^}]*\}\s*from\s*'~\/lib\/motionx\/reveal'/)
    expect(src).toMatch(/const settle = computed\(\(\) => settleParams\(behaviour\.value\?\.params\)\)/)
  })

  it('the Open into keyframes button\'s v-if excludes settle as well as dither', () => {
    const tag = (src.match(/<StudioButton\b[\s\S]*?<\/StudioButton>/g) ?? [])
      .find((t) => t.includes('data-testid="beh-open"'))
    expect(tag, 'no StudioButton carries data-testid="beh-open"').toBeTruthy()
    expect(tag).toMatch(/v-if="[^"]*behaviour\.kind !== 'dither'[^"]*"/)
    expect(tag).toMatch(/v-if="[^"]*behaviour\.kind !== 'settle'[^"]*"/)
  })
})

// ── 2. The gallery mounts MotionSettlePreview for the settle tiles ──────────

describe('the gallery\'s settle preview branch', () => {
  const src = readFileSync(GALLERY, 'utf8')

  it('imports MotionSettlePreview', () => {
    expect(src).toMatch(/import MotionSettlePreview from '~\/components\/vue-canvas\/compositor\/MotionSettlePreview\.vue'/)
  })

  it('mounts it for preview === settle, wired to the tile\'s own effect and direction', () => {
    const tag = (src.match(/<MotionSettlePreview\b[\s\S]*?\/>/) ?? [])[0]
    expect(tag, 'no <MotionSettlePreview> tag found').toBeTruthy()
    expect(tag).toMatch(/v-else-if="m\.preview === 'settle'"/)
    expect(tag).toMatch(/:effect="/)
    expect(tag).toMatch(/m\.params\?\.effect/)
    expect(tag).toMatch(/:out="m\.params\?\.dir === 'out'"/)
  })
})

// ── 3. MotionSettlePreview.vue itself ────────────────────────────────────────

describe('MotionSettlePreview.vue', () => {
  const src = readFileSync(SETTLE_PREVIEW, 'utf8')

  it('declares the effect/out props', () => {
    expect(src).toMatch(/defineProps<\{\s*effect:\s*string;\s*out:\s*boolean\s*\}>/)
  })

  it('the canvas is aria-hidden', () => {
    expect(src).toMatch(/<canvas\b[^>]*aria-hidden="true"/)
  })

  it('starts its rAF loop on mount and cancels it on unmount — no leaked loop once the tile is gone', () => {
    expect(src).toMatch(/onMounted\(/)
    expect(src).toMatch(/raf = requestAnimationFrame\(loop\)/)
    expect(src).toMatch(/onBeforeUnmount\(\(\) => \{ if \(raf\) cancelAnimationFrame\(raf\); raf = 0 \}\)/)
  })

  it('draws a still frame at amount 0.4 under prefers-reduced-motion instead of animating', () => {
    const body = src.slice(src.indexOf('onMounted('), src.indexOf('onBeforeUnmount('))
    expect(body).toMatch(/prefers-reduced-motion:\s*reduce/)
    expect(body).toMatch(/draw\(0\.4,\s*0\)/)
  })

  it('never creates a canvas element per frame — offscreen canvases are memoised module-level lets, not local to draw()', () => {
    // The draw-based effects (split/blur/zoomblur/pixelate) reuse `sourceCanvas`/`tintCanvases`/
    // `tinyCanvas`, each guarded by an `if (...) return ...` before any `createElement`.
    expect(src).toMatch(/if \(sourceCanvas\) return sourceCanvas/)
    expect(src).toMatch(/if \(tintCanvases\) return tintCanvases/)
  })

  it('drives distortion strength through the library\'s settleStrength/settleFade, not a hand-rolled curve', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bsettleStrength\b[^}]*\bsettleFade\b[^}]*\}\s*from\s*'~\/lib\/motionx\/reveal'|import\s*\{[^}]*\bsettleFade\b[^}]*\bsettleStrength\b[^}]*\}\s*from\s*'~\/lib\/motionx\/reveal'/)
    expect(src).toMatch(/settleStrength\(amount,\s*1\)/)
    expect(src).toMatch(/settleFade\(amount,\s*true\)/)
  })

  it('falls back through the library\'s settleEffectOf for an unknown/missing effect id, same rule as everywhere else', () => {
    expect(src).toMatch(/settleEffectOf\(props\.effect\)/)
  })

  it('covers all ten effect ids from the brief', () => {
    for (const id of ['slice', 'glitch', 'split', 'blur', 'zoomblur', 'pixelate', 'wave', 'liquify', 'swirl', 'ripple']) {
      expect(src, `no reference to effect id "${id}"`).toContain(`'${id}'`)
    }
  })

  it('says up front that these are previews of the idea, not the shaders', () => {
    expect(src).toMatch(/PREVIEWS OF THE IDEA/)
  })
})

// ── 4. The shared preview card (extracted from MotionDitherPreview) ─────────

describe('previewCard.ts is the ONE card builder, shared by both preview components', () => {
  const cardSrc = readFileSync(PREVIEW_CARD, 'utf8')
  const ditherSrc = readFileSync(DITHER_PREVIEW, 'utf8')
  const settleSrc = readFileSync(SETTLE_PREVIEW, 'utf8')

  it('exports buildPreviewCard', () => {
    expect(cardSrc).toMatch(/export function buildPreviewCard\(/)
  })

  it('MotionDitherPreview imports it instead of declaring its own buildSource/insideCard', () => {
    expect(ditherSrc).toMatch(/import\s*\{\s*buildPreviewCard\s*\}\s*from\s*'\.\/previewCard'/)
    expect(ditherSrc).not.toMatch(/function buildSource\(/)
    expect(ditherSrc).not.toMatch(/function insideCard\(/)
  })

  it('MotionSettlePreview imports the same helper', () => {
    expect(settleSrc).toMatch(/import\s*\{\s*buildPreviewCard\s*\}\s*from\s*'\.\/previewCard'/)
  })
})
