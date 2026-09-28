/**
 * PIXEL REVEAL — THE UI.
 *
 * Source-level guards over the pixel-reveal inspector block and its gallery preview, in the
 * same idiom `settle-ui.unit.spec.ts` uses for the Settle block: no rendering, just pinning
 * what the template and script text actually say, so a future edit can't quietly drop a Studio
 * control for a raw `<input>`/`<select>`, let a look swap keep a stale override, or leak the
 * preview's rAF loop.
 *
 * A small numeric spec for `pixelRevealPreviewBlocks.ts`'s pure block-fill helper lives at the
 * bottom (section 4) — it is plain maths, no source-text matching needed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PIXEL_REVEAL_LOOKS, PIXEL_REVEAL_PATTERNS, PIXEL_REVEAL_DIRECTIONS } from '~/lib/motionx/reveal/pixelReveal'
import { paintPixelRevealFrame, meanColor } from '~/components/vue-canvas/compositor/pixelRevealPreviewBlocks'
import { buildPreviewCard } from '~/components/vue-canvas/compositor/previewCard'

const INSPECTOR = fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/MotionInspector.vue', import.meta.url))
const GALLERY = fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/MotionGallery.vue', import.meta.url))
const PIXELREVEAL_PREVIEW = fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/MotionPixelRevealPreview.vue', import.meta.url))

// ── 1. The pixel-reveal inspector block ─────────────────────────────────────

describe('the pixel-reveal inspector block', () => {
  const src = readFileSync(INSPECTOR, 'utf8')
  const TESTIDS = [
    'pixelreveal-look', 'pixelreveal-dir', 'pixelreveal-pieces', 'pixelreveal-pattern',
    'pixelreveal-direction', 'pixelreveal-pixel', 'pixelreveal-levels', 'pixelreveal-spread', 'pixelreveal-heat',
  ]

  /** The first tag (self-closing or not) carrying this test id. */
  const tagFor = (testid: string) => {
    const selfClosing = (src.match(/<\w+\b[\s\S]*?\/>/g) ?? []).find((t) => t.includes(`data-testid="${testid}"`))
    if (selfClosing) return selfClosing
    const open = src.indexOf(`data-testid="${testid}"`)
    if (open < 0) return undefined
    const tagStart = src.lastIndexOf('<', open)
    const tagEnd = src.indexOf('>', open)
    return src.slice(tagStart, tagEnd + 1)
  }

  it('carries every pixel-reveal test id', () => {
    for (const id of TESTIDS) expect(src, id).toContain(`data-testid="${id}"`)
  })

  it('lives in its own v-else-if sibling of the settle/morph blocks', () => {
    expect(src).toMatch(/v-else-if="behaviour\.kind === 'pixelreveal'"/)
  })

  it('the Open into keyframes button\'s v-if excludes pixelreveal as well as dither and settle — a pixel-reveal bar is motion-only and cannot be baked', () => {
    const tag = (src.match(/<StudioButton\b[\s\S]*?<\/StudioButton>/g) ?? [])
      .find((t) => t.includes('data-testid="beh-open"'))
    expect(tag, 'no StudioButton carries data-testid="beh-open"').toBeTruthy()
    expect(tag).toMatch(/v-if="[^"]*behaviour\.kind !== 'dither'[^"]*"/)
    expect(tag).toMatch(/v-if="[^"]*behaviour\.kind !== 'settle'[^"]*"/)
    expect(tag).toMatch(/v-if="[^"]*behaviour\.kind !== 'pixelreveal'[^"]*"/)
  })

  it('reads pixel-reveal params through the ONE `pixelRevealParams` reader, like `reveal`/`settle` do', () => {
    expect(src).toMatch(/\bpixelRevealParams\b[^}]*\}\s*from\s*'~\/lib\/motionx\/reveal'|'~\/lib\/motionx\/reveal'[^;]*\bpixelRevealParams\b/s)
    expect(src).toMatch(/const pixelReveal = computed\(\(\) => pixelRevealParams\(behaviour\.value\?\.params\)\)/)
  })

  it('Look is a labelled StudioSelect over the 9 PIXEL_REVEAL_LOOKS, wired to a dedicated swap function', () => {
    const tag = tagFor('pixelreveal-look')
    expect(tag, 'no tag carries data-testid="pixelreveal-look"').toBeTruthy()
    expect(tag).toMatch(/<StudioSelect\b/)
    expect(tag).toMatch(/label="Look"/)
    expect(tag).toMatch(/:model-value="pixelReveal\.look\.id"/)
    expect(tag).toMatch(/:options="PIXEL_REVEAL_LOOK_OPTIONS"/)
    expect(tag).toMatch(/:option-labels="PIXEL_REVEAL_LOOK_LABELS"/)
    expect(tag).toMatch(/@update:model-value="setPixelRevealLook"/)
    expect(src).toMatch(/const PIXEL_REVEAL_LOOK_OPTIONS = PIXEL_REVEAL_LOOKS\.map/)
    expect(src).toMatch(/const PIXEL_REVEAL_LOOK_LABELS = PIXEL_REVEAL_LOOKS\.map/)
  })

  it('swapping the Look keeps `dir` and REPLACES params, dropping every per-setting override', () => {
    const fn = src.slice(src.indexOf('function setPixelRevealLook'), src.indexOf('function setPixelRevealLook') + 500)
    expect(fn).toMatch(/const dir = \(b\.params\?\.dir as string \| undefined\) \?\? 'in'/)
    expect(fn).toMatch(/params:\s*\{\s*dir,\s*look:\s*id\s*\}/)
    expect(fn).toMatch(/replaceParams:\s*true/)
  })

  it('Direction is a labelled StudioSegmentedRow, In / Out', () => {
    const tag = tagFor('pixelreveal-dir')
    expect(tag).toMatch(/<StudioSegmentedRow\b/)
    expect(tag).toMatch(/label="Direction"/)
    expect(tag).toMatch(/:options="IN_OUT"/)
    expect(tag).toMatch(/:option-labels="IN_OUT_LABELS"/)
  })

  it('Pieces is a segmented row over Words/Letters/Lines/Whole, disabled unless the layer is text', () => {
    const tag = tagFor('pixelreveal-pieces')
    expect(tag).toMatch(/<StudioSegmentedRow\b/)
    expect(tag).toMatch(/label="Pieces"/)
    expect(tag).toMatch(/:options="PIXEL_REVEAL_PIECES_OPTIONS"/)
    expect(tag).toMatch(/:option-labels="PIXEL_REVEAL_PIECES_LABELS"/)
    expect(src).toMatch(/const PIXEL_REVEAL_PIECES_OPTIONS = \['words', 'letters', 'lines', 'whole'\]/)
    // The disabling wrapper reads whether a text layer is selected — `pieceCounts` only arrives
    // from CompositorModal for a text layer, so its presence IS the layer-kind check.
    expect(src).toMatch(/const pixelRevealTextLayer = computed\(\(\) => props\.pieceCounts != null\)/)
    expect(src).toMatch(/pointer-events-none opacity-40[^}]*:\s*!pixelRevealTextLayer/)
  })

  it('Pattern and Direction (sweep) selects come straight off the core tables', () => {
    const patternTag = tagFor('pixelreveal-pattern')
    expect(patternTag).toMatch(/<StudioSelect\b/)
    expect(patternTag).toMatch(/:options="PIXEL_REVEAL_PATTERN_OPTIONS"/)
    expect(patternTag).toMatch(/:option-labels="PIXEL_REVEAL_PATTERN_LABELS"/)
    const dirTag = tagFor('pixelreveal-direction')
    expect(dirTag).toMatch(/<StudioSelect\b/)
    expect(dirTag).toMatch(/:options="PIXEL_REVEAL_DIRECTION_OPTIONS"/)
    expect(dirTag).toMatch(/:option-labels="PIXEL_REVEAL_DIRECTION_LABELS"/)
    expect(src).toMatch(/const PIXEL_REVEAL_PATTERN_OPTIONS = PIXEL_REVEAL_PATTERNS\.map\(\(p\) => p\.value\)/)
    expect(src).toMatch(/const PIXEL_REVEAL_DIRECTION_OPTIONS = PIXEL_REVEAL_DIRECTIONS\.map\(\(d\) => d\.value\)/)
  })

  it('Pixel/Levels/Front width are StudioSliders with the brief\'s ranges, wired through gesture/setBehNum', () => {
    const pixelTag = tagFor('pixelreveal-pixel')
    expect(pixelTag).toMatch(/<StudioSlider\b/)
    expect(pixelTag).toMatch(/:min="4"/)
    expect(pixelTag).toMatch(/:max="64"/)
    expect(pixelTag).toMatch(/v-bind="gesture\('pixelreveal-pixel'\)"/)
    expect(pixelTag).toMatch(/setBehNum\('pixelreveal-pixel',\s*\{\s*pixel:\s*v\s*\}\)/)

    const levelsTag = tagFor('pixelreveal-levels')
    expect(levelsTag).toMatch(/<StudioSlider\b/)
    expect(levelsTag).toMatch(/:min="0"/)
    expect(levelsTag).toMatch(/:max="5"/)
    expect(levelsTag).toMatch(/:step="1"/)
    expect(levelsTag).toMatch(/setBehNum\('pixelreveal-levels',\s*\{\s*levels:\s*v\s*\}\)/)

    const spreadTag = tagFor('pixelreveal-spread')
    expect(spreadTag).toMatch(/<StudioSlider\b/)
    expect(spreadTag).toMatch(/:min="0\.05"/)
    expect(spreadTag).toMatch(/:max="1"/)
    expect(spreadTag).toMatch(/setBehNum\('pixelreveal-spread',\s*\{\s*spread:\s*v\s*\}\)/)
  })

  it('Heat offers Look colour, the 4 named swatches and No heat, each with its own tooltip name', () => {
    const start = src.indexOf('data-testid="pixelreveal-heat"')
    expect(start).toBeGreaterThan(-1)
    const block = src.slice(start, start + 1800)
    expect(block).toMatch(/title="Look colour"/)
    expect(block).toMatch(/setBehParams\(\{\s*heat:\s*undefined\s*\}\)/)
    expect(block).toMatch(/title="No heat"/)
    expect(block).toMatch(/setBehParams\(\{\s*heat:\s*null\s*\}\)/)
    expect(block).toMatch(/setBehParams\(\{\s*heat:\s*s\.hex\s*\}\)/)
    for (const { hex, name } of [
      { hex: '#1700c7', name: 'Ultramarine' },
      { hex: '#aeff00', name: 'Acid' },
      { hex: '#ff3d00', name: 'Signal orange' },
      { hex: '#00d1ff', name: 'Cyan' },
    ]) {
      expect(src, hex).toContain(`hex: '${hex}', name: '${name}'`)
    }
  })

  it('every visible label is sentence case and no explanatory copy sits in the panel (hints are tooltips)', () => {
    const start = src.indexOf("kind === 'pixelreveal'")
    const end = src.indexOf('</template>', start)
    const block = src.slice(start, end)
    // Labels the brief specifies, verbatim, sentence case.
    for (const label of ['Look', 'Direction', 'Pieces', 'Pattern', 'Sweep direction', 'Pixel size', 'Levels', 'Front width', 'Heat']) {
      expect(block, label).toContain(label)
    }
    // No standing explanatory <p>/<span> paragraph the way morph's "Pick an element..." warns —
    // every hint here rides on a `hint`/`title` attribute instead.
    expect(block).not.toMatch(/<p\b/)
  })
})

// ── 2. The gallery mounts MotionPixelRevealPreview for the pixelreveal tiles ─

describe('the gallery\'s pixel-reveal preview branch', () => {
  const src = readFileSync(GALLERY, 'utf8')

  it('imports MotionPixelRevealPreview', () => {
    expect(src).toMatch(/import MotionPixelRevealPreview from '~\/components\/vue-canvas\/compositor\/MotionPixelRevealPreview\.vue'/)
  })

  it('mounts it for preview === pixelreveal, wired to the tile\'s own look and direction', () => {
    const tag = (src.match(/<MotionPixelRevealPreview\b[\s\S]*?\/>/) ?? [])[0]
    expect(tag, 'no <MotionPixelRevealPreview> tag found').toBeTruthy()
    expect(tag).toMatch(/v-else-if="m\.preview === 'pixelreveal'"/)
    expect(tag).toMatch(/:look="/)
    expect(tag).toMatch(/m\.params\?\.look/)
    expect(tag).toMatch(/:out="m\.params\?\.dir === 'out'"/)
  })

  it('no longer renders the old blank placeholder well', () => {
    expect(src).not.toMatch(/no preview component built yet/)
  })
})

// ── 3. MotionPixelRevealPreview.vue itself ──────────────────────────────────

describe('MotionPixelRevealPreview.vue', () => {
  const src = readFileSync(PIXELREVEAL_PREVIEW, 'utf8')

  it('declares the look/out props', () => {
    expect(src).toMatch(/defineProps<\{\s*look:\s*string;\s*out:\s*boolean\s*\}>/)
  })

  it('the canvas is aria-hidden', () => {
    expect(src).toMatch(/<canvas\b[^>]*aria-hidden="true"/)
  })

  it('starts its rAF loop on mount and cancels it on unmount — no leaked loop once the tile is gone', () => {
    expect(src).toMatch(/onMounted\(/)
    expect(src).toMatch(/raf = requestAnimationFrame\(loop\)/)
    expect(src).toMatch(/onBeforeUnmount\(\(\) => \{ if \(raf\) cancelAnimationFrame\(raf\); raf = 0 \}\)/)
  })

  it('draws a still frame under prefers-reduced-motion instead of animating', () => {
    const body = src.slice(src.indexOf('onMounted('), src.indexOf('onBeforeUnmount('))
    expect(body).toMatch(/prefers-reduced-motion:\s*reduce/)
    expect(body).toMatch(/draw\(0\.4\)/)
  })

  it('draws through the shared paintPixelRevealFrame helper, not a hand-rolled loop of its own', () => {
    expect(src).toMatch(/import\s*\{\s*paintPixelRevealFrame\s*\}\s*from\s*'\.\/pixelRevealPreviewBlocks'/)
    expect(src).toMatch(/paintPixelRevealFrame\(/)
  })

  it('resolves an unknown/missing look through the library\'s own pixelRevealLookOf', () => {
    expect(src).toMatch(/pixelRevealLookOf\(props\.look\)/)
  })

  it('draws the SAME synthetic card every other preview tile draws', () => {
    expect(src).toMatch(/import\s*\{\s*buildPreviewCard\s*\}\s*from\s*'\.\/previewCard'/)
  })

  it('says up front that this is a preview of the idea, not the shader', () => {
    expect(src).toMatch(/PREVIEW OF THE IDEA/)
  })
})

// ── 4. pixelRevealPreviewBlocks.ts — the pure block-fill helper ────────────

describe('paintPixelRevealFrame / meanColor', () => {
  const COLS = 48
  const ROWS = 30

  it('meanColor averages a uniform patch to its own colour, alpha-weighted', () => {
    const src = new Uint8ClampedArray(4 * 4 * 4)
    for (let i = 0; i < src.length; i += 4) { src[i] = 100; src[i + 1] = 150; src[i + 2] = 200; src[i + 3] = 255 }
    expect(meanColor(src, 4, 4, 0, 0, 4, 4)).toEqual([100, 150, 200, 255])
  })

  it('meanColor returns transparent black for an all-transparent rect', () => {
    const src = new Uint8ClampedArray(4 * 4 * 4)
    expect(meanColor(src, 4, 4, 0, 0, 4, 4)).toEqual([0, 0, 0, 0])
  })

  it('meanColor fades a block straddling the card edge instead of full-strength picking up the transparent half', () => {
    const src = new Uint8ClampedArray(2 * 1 * 4)
    src[0] = 255; src[1] = 255; src[2] = 255; src[3] = 255 // opaque left pixel
    // right pixel stays all-zero (transparent)
    const [, , , a] = meanColor(src, 2, 1, 0, 0, 2, 1)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(255)
  })

  it('paintPixelRevealFrame draws nothing at amount 0 (nothing has reached its threshold yet)', () => {
    const card = buildPreviewCard(COLS, ROWS)
    const data = new Uint8ClampedArray(COLS * ROWS * 4)
    const look = PIXEL_REVEAL_LOOKS[0]!
    paintPixelRevealFrame(data, card, COLS, ROWS, look.settings, 0, look.settings.pixel * (COLS / 240))
    expect(data.some((v) => v !== 0)).toBe(false)
  })

  it('paintPixelRevealFrame draws something under the card by amount 1 for every look', () => {
    const card = buildPreviewCard(COLS, ROWS)
    for (const look of PIXEL_REVEAL_LOOKS) {
      const data = new Uint8ClampedArray(COLS * ROWS * 4)
      paintPixelRevealFrame(data, card, COLS, ROWS, look.settings, 1, look.settings.pixel * (COLS / 240))
      let anyAlpha = false
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) { anyAlpha = true; break }
      expect(anyAlpha, `${look.id} drew nothing at amount 1`).toBe(true)
    }
  })

  it('stays transparent at the canvas\'s own corners, well outside the card\'s rounded footprint', () => {
    const card = buildPreviewCard(COLS, ROWS)
    const data = new Uint8ClampedArray(COLS * ROWS * 4)
    const look = PIXEL_REVEAL_LOOKS[0]!
    paintPixelRevealFrame(data, card, COLS, ROWS, look.settings, 1, look.settings.pixel * (COLS / 240))
    const corner = (x: number, y: number) => data[(y * COLS + x) * 4 + 3]
    expect(corner(0, 0)).toBe(0)
    expect(corner(COLS - 1, 0)).toBe(0)
    expect(corner(0, ROWS - 1)).toBe(0)
    expect(corner(COLS - 1, ROWS - 1)).toBe(0)
  })
})
