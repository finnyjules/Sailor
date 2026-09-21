/**
 * LETTER BEHAVIOURS — THE DECISIONS THE UI MAKES ABOUT THEM.
 *
 *  1. "Generate as video" is enabled when the frame has motion. Letter bars (and every other
 *     motionx band) ARE motion, so a frame animated only by them must not be stuck on stills.
 *  2. The Letters group is offered only for a layer the letter engine can actually reach. A
 *     text layer that still carries a LEGACY `layer.animation` is drawn by the old engine,
 *     which never reads `textMotion` — a letter bar added to it would silently do nothing.
 *     One predicate, `canAnimateLetters`, decides that for the gallery and for the add path
 *     alike, so the two can never drift apart.
 *  3. A text bar compiles to no track, so the inspector cannot read its curve back off a
 *     keyframe; it must fall back to the evaluator's own default, not to 'easeInOut'.
 *
 * (1) and (3) live inside `<script setup>` blocks — one of them in an ~11k-line component
 * shared with other sessions, where the change has to stay a single line. They are exercised
 * the way `compositor-setup-tdz` reads that same file: the statement is lifted out by name,
 * its (small, listed) type syntax removed, and RUN against stubs. A renamed or deleted
 * binding, or a statement that stops being plain enough to strip, fails loudly here.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_TEXT_EASE, canAnimateLetters, evaluateTextBehaviours } from '~/lib/motionx/text'
import { PIXEL_TONE_MAX, pixelBrightness } from '~/lib/motionx/reveal'
import { resetValue } from '~/lib/studio/row'
import type { TextCell } from '~/lib/motionx/text/units'

const MODAL = fileURLToPath(new URL('../../../app/components/vue-canvas/CompositorModal.vue', import.meta.url))
const INSPECTOR = fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/MotionInspector.vue', import.meta.url))
const GALLERY = fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/MotionGallery.vue', import.meta.url))
const TIMELINE = fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/MotionBandTimeline.vue', import.meta.url))

const setupOf = (file: string) =>
  readFileSync(file, 'utf8').match(/<script setup[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? ''

/** The whole top-level statement declaring `name`, found by balancing delimiters. */
function statementOf(src: string, name: string): string {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^(?:const|let|function|async function)\\s+${name}\\b`).test(l))
  if (start < 0) throw new Error(`no top-level declaration of \`${name}\``)
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if ('([{'.includes(ch)) depth++
      else if (')]}'.includes(ch)) depth--
    }
    if (depth <= 0) return lines.slice(start, i + 1).join('\n')
  }
  throw new Error(`unbalanced declaration of \`${name}\``)
}

/** The only TypeScript the statements below contain: a cast, a generic call argument, an
 *  `: any` parameter, and primitive parameter / return annotations. The primitive rules name
 *  their three types rather than matching any identifier, so an object literal's `key: value`
 *  cannot be mistaken for an annotation. Anything else left behind is a syntax error when the
 *  statement runs. */
const PRIMITIVE = '(?:number|string|boolean)'
const stripTypeSyntax = (code: string) => code
  .replace(/\s+as\s+unknown\s+as\s+\{[^{}]*\}/g, '')
  .replace(/\s+as\s+[A-Za-z_$][\w$.]*(?:<[^<>]*>)?(?:\[\])?(?:\s*\|\s*(?:undefined|null))?/g, '')
  .replace(/\b([A-Za-z_$][\w$]*)<[^<>()]*>\(/g, '$1(')
  .replace(/([(,]\s*)([A-Za-z_$][\w$]*)\s*:\s*any\b/g, '$1$2')
  .replace(new RegExp(`([(,]\\s*)([A-Za-z_$][\\w$]*)\\s*:\\s*${PRIMITIVE}\\b`, 'g'), '$1$2')
  .replace(new RegExp(`\\)\\s*:\\s*${PRIMITIVE}\\b`, 'g'), ')')

/** Lift one statement out of an SFC and run it against `scope`; returns what it declared. */
function runStatement(file: string, name: string, scope: Record<string, unknown>) {
  const js = stripTypeSyntax(statementOf(setupOf(file), name))
  return new Function(...Object.keys(scope), `${js}\nreturn ${name}`)(...Object.values(scope))
}

const ref = <T>(value: T) => ({ value })
/** `computed(fn)` → the fn itself, so a test can call it with whatever state it likes. */
const computed = (fn: unknown) => fn

// ── 1. letters (and bands) count as motion ──────────────────────────────────

describe('hasMotion', () => {
  const evaluate = (over: Record<string, unknown> = {}) =>
    runStatement(MODAL, 'hasMotion', {
      computed,
      localLayers: ref<any[]>([{ id: 'L1', kind: 'text' }]),
      hasAnimatedSlot: ref(false),
      motionxTracks: ref<any[]>([]),
      motionBehaviours: ref<any[]>([]),
      ...over,
    })()

  it('false for a still frame', () => {
    expect(evaluate()).toBe(false)
  })
  it('true for the two older sources — a legacy layer animation, an animated wired slot', () => {
    expect(evaluate({ localLayers: ref<any[]>([{ id: 'L1', animation: { kind: 'fade' } }]) })).toBe(true)
    expect(evaluate({ hasAnimatedSlot: ref(true) })).toBe(true)
  })
  it('true when letter behaviours are the ONLY motion', () => {
    expect(evaluate({
      motionBehaviours: ref<any[]>([{ id: 'b1', layerId: 'L1', kind: 'text.cascade', timing: { start: 0, duration: 1 } }]),
    })).toBe(true)
  })
  it('true when a property band is the only motion', () => {
    expect(evaluate({ motionxTracks: ref<any[]>([{ path: 'layers.L1.opacity', type: 'number', keyframes: [] }]) })).toBe(true)
  })
})

// ── 2. no Letters on a layer the letter engine cannot reach ─────────────────

describe('canAnimateLetters', () => {
  it('a text layer can', () => {
    expect(canAnimateLetters({ kind: 'text' })).toBe(true)
  })
  it('a text layer with an older animation cannot — the old engine never reads textMotion', () => {
    expect(canAnimateLetters({ kind: 'text', animation: { kind: 'fade', dir: 'in' } })).toBe(false)
  })
  it('nothing else can', () => {
    expect(canAnimateLetters({ kind: 'rect' })).toBe(false)
    expect(canAnimateLetters(null)).toBe(false)
    expect(canAnimateLetters(undefined)).toBe(false)
  })
})

describe('motionLayerCaps', () => {
  const caps = (layer: unknown) =>
    runStatement(MODAL, 'motionLayerCaps', {
      computed, canAnimateLetters,
      isGradient: (p: unknown) => !!p && typeof p === 'object' && 'stops' in (p as object),
      selectedLocal: ref(layer),
    })()

  it('offers Letters for a plain text layer only', () => {
    expect(caps({ id: 'L1', kind: 'text' }).text).toBe(true)
    expect(caps({ id: 'L1', kind: 'text', animation: { kind: 'fade' } }).text).toBe(false)
    expect(caps({ id: 'R1', kind: 'rect' }).text).toBe(false)
    expect(caps(null).text).toBe(false)
  })
  it('leaves the gradient cap alone', () => {
    expect(caps({ id: 'R1', kind: 'rect', fill: { type: 'linear', stops: [] } }).gradient).toBe(true)
    expect(caps({ id: 'R1', kind: 'rect', fill: '#fff' }).gradient).toBe(false)
  })
})

describe('the add path refuses a letter bar through the same predicate', () => {
  // `addBehaviour` is a 25-line function in the shared modal; what matters is that its
  // text guard asks `canAnimateLetters`, not `kind === 'text'` on its own.
  const src = statementOf(setupOf(MODAL), 'addBehaviour')
  it('guards on canAnimateLetters', () => {
    expect(src).toMatch(/if\s*\(\s*isText\s*&&\s*!canAnimateLetters\(\s*l\s*\)\s*\)\s*return/)
  })
})

// ── 3. the curve the inspector shows for a letter bar ───────────────────────

describe('behEase', () => {
  const shown = (beh: unknown, motionx: unknown[] = []) =>
    runStatement(INSPECTOR, 'behEase', {
      computed,
      isTextBehaviour: (b: { kind: string }) => typeof b?.kind === 'string' && b.kind.startsWith('text.'),
      DEFAULT_TEXT_EASE,
      behaviour: ref(beh),
      behParam: (k: string) => (beh as any)?.params?.[k],
      props: { motionx },
    })()

  it('a letter bar with no ease of its own shows the curve the evaluator will use', () => {
    expect(shown({ id: 'b1', kind: 'text.cascade', params: {} })).toBe(DEFAULT_TEXT_EASE)
  })
  it('its own ease still wins', () => {
    expect(shown({ id: 'b1', kind: 'text.cascade', params: { ease: 'easeIn' } })).toBe('easeIn')
  })
  it('an ordinary behaviour still reads the curve off its compiled track', () => {
    const beh = { id: 'b1', kind: 'fade', params: {} }
    expect(shown(beh, [{ behaviourId: 'b1', keyframes: [{ t: 0, value: 0, ease: 'linear' }] }])).toBe('linear')
    expect(shown(beh)).toBe('easeInOut')
  })
  it('and DEFAULT_TEXT_EASE really is what an unset letter bar animates under', () => {
    const cells: TextCell[] = [{ char: 'A', x: 0, y: 0, w: 10, h: 20, angle: 0, word: 0, line: 0 }]
    const bar = (params: Record<string, unknown>) =>
      ({ id: 'b', layerId: 'L', kind: 'text.cascade', params: { style: 'rise', stagger: 0, ...params }, timing: { start: 0, duration: 1 } }) as any
    const frame = { w: 100, h: 100 }
    expect(evaluateTextBehaviours([bar({})], 0.4, cells, frame))
      .toEqual(evaluateTextBehaviours([bar({ ease: DEFAULT_TEXT_EASE })], 0.4, cells, frame))
  })
})

// ── 4. every number row still knows its DEFAULT, and it is the evaluator's ──

/**
 * This replaces the `numOrDefault` suite. That helper existed because the inspector's number
 * fields were `<input type="number">`: an emptied one sent `''`, `Number('')` is 0, and each
 * caller clamped what came back to its own range — so clearing Steps landed on 1 instead of
 * 8, and Cascade's amount on 0 instead of 0.6. The fields are `StudioSlider`s now. A row
 * emits a NUMBER, never a string and never NaN, so there is no empty field left to parse and
 * the helper is gone.
 *
 * What carries the guarantee instead is the row's declared `:default` — the value
 * double-click resets to, via `resetValue`. The failure mode is the same one (landing on the
 * range minimum), so the same numbers are pinned here, against the source that declares them.
 */
describe('every behaviour number row declares the evaluator\'s own default', () => {
  const template = readFileSync(INSPECTOR, 'utf8').match(/<template>([\s\S]*)<\/template>/)?.[1] ?? ''
  /** Each `<StudioSlider …/>` tag, by the test id it carries. */
  const rows = new Map<string, string>()
  for (const tag of template.match(/<StudioSlider\b[\s\S]*?\/>/g) ?? []) {
    const id = tag.match(/data-testid="([^"]+)"/)?.[1]
    if (id) rows.set(id, tag)
  }

  // testid → the `:default` the row must declare. A literal for a fixed default, a name for
  // the ones that depend on the kind (Cascade's amount is letter heights / a scale / degrees).
  const DEFAULTS: Record<string, string> = {
    'slide-distance': '0.15',
    'letters-stagger': '0.04',
    'loop-amount': 'loopAmountDefault',
    'loop-speed': 'loopSpeedDefault',
    'loop-offset': '0.12',
    'cascade-amount': 'cascadeAmountDefault',
    'typewriter-blink': '0',
    'scramble-area-w': '60',
    'scramble-area-h': '60',
    'scramble-interval': '0.18',
    'scramble-spin': '0',
    'decode-rate': '14',
    'slot-steps': '8',
  }

  it('every one of them is still there', () => {
    expect([...rows.keys()].sort()).toEqual(expect.arrayContaining(Object.keys(DEFAULTS).sort()))
  })

  it.each(Object.entries(DEFAULTS))('%s resets to %s', (id, expected) => {
    const tag = rows.get(id)
    expect(tag, `no StudioSlider carries data-testid="${id}"`).toBeTruthy()
    expect(tag!.match(/:default="([^"]+)"/)?.[1]).toBe(expected)
  })

  it('and a declared default beats the range minimum, which is the whole point', () => {
    // Steps: min 1, default 8. Cascade rise: min 0, default 0.6.
    expect(resetValue({ default: 8, min: 1, max: 40 })).toBe(8)
    expect(resetValue({ default: 0.6, min: 0, max: 3 })).toBe(0.6)
    // A row with NO default would land on the minimum — the old bug, still reachable.
    expect(resetValue({ min: 1, max: 40 })).toBe(1)
  })
})

// ── 4b. one drag is one undo step ───────────────────────────────────────────

/**
 * A Studio row emits a value per pixel, and every inspector edit records an undo step. The
 * coalescing itself is unit-tested in `undo-coalesce.unit.spec.ts`; what is pinned here is
 * that the inspector actually USES it — a slider that forgets `v-bind="gesture(…)"`, or a
 * write that goes through the discrete `setBehParams` instead of `setBehNum`, silently gets
 * forty undo steps back.
 */
describe('every slider folds its drag into one undo step', () => {
  const template = readFileSync(INSPECTOR, 'utf8').match(/<template>([\s\S]*)<\/template>/)?.[1] ?? ''
  const tags = template.match(/<StudioSlider\b[\s\S]*?\/>/g) ?? []

  it('there are sliders to check', () => {
    expect(tags.length).toBeGreaterThanOrEqual(15)
  })
  it('each one binds the gesture, under the same key it writes with', () => {
    for (const tag of tags) {
      const bound = tag.match(/v-bind="gesture\('([^']+)'\)"/)?.[1]
      expect(bound, `a StudioSlider with no gesture binding: ${tag.slice(0, 90)}`).toBeTruthy()
      const written = tag.match(/(?:setBehNum|setValue)\([^)]*?'([\w-]+)'/)?.[1]
        ?? tag.match(/@update:model-value="(setStart|setDuration)"/)?.[1]
        ?? tag.match(/setBehTiming\(.*,\s*'([\w-]+)'\)/)?.[1]
      expect(written, `a StudioSlider with no recognised writer: ${tag.slice(0, 90)}`).toBeTruthy()
      // setStart / setDuration name their own key inside the function, not in the template.
      if (written !== 'setStart' && written !== 'setDuration') {
        expect(written, `gesture key and write key disagree on ${bound}`).toBe(bound)
      }
    }
  })
})

// ── 5. reduced motion really stops the letter previews ──────────────────────

/**
 * The gallery's letter previews are CSS animations. Their base rules are ancestor + class
 * selectors (`.letters-mask .letter-inner`, specificity 0,2,0) and the reduced-motion
 * overrides were single-class (`.letter-inner`, 0,1,0), so the overrides lost every cascade
 * they were written for and the previews kept moving — and kept whatever resting transform or
 * opacity the base rule gave them (a mask preview is `translateY(100%)`: the word would not
 * even be on screen). An override has to reach the specificity of the rule it overrides.
 */
const styleOf = (file: string) =>
  readFileSync(file, 'utf8').match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? ''

interface Rule { sel: string; body: string; inMedia: boolean; at: number }

/** Every declaration-carrying rule of a stylesheet, in source order; @keyframes are skipped
 *  whole and a @media block's rules are flagged. */
function parseRules(css: string): Rule[] {
  const out: Rule[] = []
  const walk = (text: string, inMedia: boolean, base: number) => {
    let i = 0
    while (i < text.length) {
      const open = text.indexOf('{', i)
      if (open < 0) break
      const head = text.slice(i, open).trim()
      let depth = 1, j = open + 1
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === '{') depth++
        else if (text[j] === '}') depth--
      }
      const body = text.slice(open + 1, j - 1)
      if (head.startsWith('@media')) walk(body, true, base + open + 1)
      else if (!head.startsWith('@') && head) out.push({ sel: head, body, inMedia, at: base + i })
      i = j
    }
  }
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), false, 0)
  return out
}

const selectors = (sel: string) => sel.split(',').map((s) => s.trim()).filter(Boolean)
/** The class-level half of CSS specificity (classes, attributes, pseudo-CLASSES). Nothing here
 *  uses an id, and a pseudo-ELEMENT weighs less than any of these. */
const spec = (sel: string) =>
  (sel.match(/\.[\w-]+/g) ?? []).length + (sel.match(/(?<!:):(?!:)[\w-]+(\([^)]*\))?/g) ?? []).length
const compounds = (sel: string) => sel.split(/\s+/).filter(Boolean)
const first = (sel: string) => compounds(sel)[0] ?? ''
const subject = (sel: string) => compounds(sel).at(-1) ?? ''

describe('the letter previews stop under prefers-reduced-motion', () => {
  const rules = parseRules(styleOf(GALLERY))
  const animated = rules.filter((r) => !r.inMedia && /^\.letters-/.test(r.sel) && /\banimation(-name)?\s*:/.test(r.body))
  const overrides = rules.filter((r) => r.inMedia)

  /** The reduced-motion rules that actually beat `r` in the cascade: same preview, same
   *  subject, at least as specific, and later in the file. */
  const winners = (r: Rule) => overrides.filter((o) => o.at > r.at && selectors(o.sel).some((os) =>
    selectors(r.sel).some((rs) => first(os) === first(rs) && subject(os) === subject(rs) && spec(os) >= spec(rs))))

  it('all nine previews animate, so all nine need an override', () => {
    const previews = new Set(animated.flatMap((r) => selectors(r.sel).map((s) => first(s).replace(/::.*/, ''))))
    expect([...previews].sort()).toEqual([
      '.letters-bounce', '.letters-cascade', '.letters-decode', '.letters-jitter', '.letters-mask',
      '.letters-scramble', '.letters-slot', '.letters-typewriter', '.letters-wave',
    ])
  })

  it('every animated rule is answered at its own specificity, with no !important anywhere', () => {
    expect(animated.length).toBeGreaterThanOrEqual(9)
    for (const r of animated) {
      const beaten = winners(r)
      expect(beaten.length, `nothing overrides \`${r.sel}\``).toBeGreaterThan(0)
      expect(beaten.some((o) => /\banimation(-name)?\s*:\s*none/.test(o.body)), `\`${r.sel}\` keeps animating`).toBe(true)
    }
    expect(styleOf(GALLERY)).not.toContain('!important')
  })

  it('and the resting look is answered too, so each preview shows its finished word', () => {
    for (const r of animated) {
      for (const prop of ['opacity', 'transform']) {
        if (!new RegExp(`(^|;)\\s*${prop}\\s*:`).test(r.body)) continue
        const beaten = winners(r).some((o) => new RegExp(`(^|;)\\s*${prop}\\s*:`).test(o.body))
        expect(beaten, `\`${r.sel}\` keeps its own ${prop} under reduced motion`).toBe(true)
      }
    }
  })
})

// ── 6. the Dither block (Task 4) ────────────────────────────────────────────

describe('the Dither inspector block', () => {
  const src = readFileSync(INSPECTOR, 'utf8')
  const DITHER_TESTIDS = [
    'dither-style', 'dither-chars', 'dither-dir', 'dither-cell', 'dither-drift', 'dither-angle', 'dither-softness',
    // Assemble (Task 13)
    'dither-look', 'dither-pattern', 'dither-levels', 'dither-band', 'dither-scatter',
  ]

  /** The first self-closing tag (Studio control or otherwise) carrying this test id. */
  const tagFor = (testid: string) =>
    (src.match(/<\w+\b[\s\S]*?\/>/g) ?? []).find((t) => t.includes(`data-testid="${testid}"`))

  it('carries every dither test id', () => {
    for (const id of DITHER_TESTIDS) expect(src).toContain(`data-testid="${id}"`)
  })

  it('the softness row is guarded by a v-if that mentions wipe', () => {
    const tag = tagFor('dither-softness')
    expect(tag, 'no tag carries data-testid="dither-softness"').toBeTruthy()
    expect(tag!.match(/v-if="([^"]*)"/)?.[1]).toMatch(/wipe/)
  })

  it('the Open into keyframes button\'s v-if excludes dither', () => {
    const tag = (src.match(/<StudioButton\b[\s\S]*?<\/StudioButton>/g) ?? [])
      .find((t) => t.includes('data-testid="beh-open"'))
    expect(tag, 'no StudioButton carries data-testid="beh-open"').toBeTruthy()
    expect(tag).toMatch(/v-if="[^"]*behaviour\.kind !== 'dither'[^"]*"/)
  })

  it('uses only Studio controls inside the dither block — no raw input or select, except the Custom characters free-text row (Task 15 — no Studio text control exists)', () => {
    const start = src.indexOf("kind === 'dither'")
    expect(start, 'no dither branch found').toBeGreaterThan(-1)
    const end = src.indexOf('</template>', start)
    expect(end).toBeGreaterThan(start)
    const block = src.slice(start, end)
    const inputs = block.match(/<input\b[^>]*>/gi) ?? []
    const stray = inputs.filter((t) => !t.includes('data-testid="dither-custom-chars"'))
    expect(stray).toEqual([])
    expect(inputs.some((t) => t.includes('data-testid="dither-custom-chars"'))).toBe(true)
    expect(block).not.toMatch(/<select/i)
  })

  // ── Pixels style (Task 9) ───────────────────────────────────────────────
  // Task 13 note: REVEAL_STYLES grew a fifth member ('assemble', listed second) — this case
  // originally pinned the Style select to exactly four options/labels, which Assemble
  // legitimately invalidates. Updated to five, Pixels first, Assemble second.
  it('the Style select offers the five REVEAL_STYLES options, Pixels first, Assemble second', () => {
    const tag = tagFor('dither-style')
    expect(tag, 'no tag carries data-testid="dither-style"').toBeTruthy()
    expect(tag).toMatch(/<StudioSelect\b/)
    expect(tag).toMatch(/:options="DITHER_STYLES"/)
    expect(tag).toMatch(/:option-labels="DITHER_STYLE_LABELS"/)
    // DITHER_STYLES is the library's own REVEAL_STYLES (Pixels first); DITHER_STYLE_LABELS
    // must pair with it by index.
    expect(src).toMatch(/const DITHER_STYLES:\s*string\[\]\s*=\s*\[\.\.\.REVEAL_STYLES\]/)
    expect(src).toContain("const DITHER_STYLE_LABELS = ['Pixels', 'Assemble', 'Dissolve', 'Wipe', 'Dots']")
  })

  it('dither-chars appears only for Pixels and binds PIXEL_CHARS', () => {
    const tag = tagFor('dither-chars')
    expect(tag, 'no tag carries data-testid="dither-chars"').toBeTruthy()
    expect(tag).toMatch(/<StudioSelect\b/)
    expect(tag!.match(/v-if="([^"]*)"/)?.[1]).toMatch(/pixels/)
    expect(src).toMatch(/PIXEL_CHARS/)
    expect(src).toContain('PIXEL_CHAR_OPTIONS')
    expect(src).toContain('PIXEL_CHAR_LABELS')
  })

  it('the cell and drift rows carry Pixels-specific copy', () => {
    expect(src).toContain('Block size')
    expect(src).toContain('Shimmer speed')
  })

  it('the Angle row\'s v-if excludes Pixels', () => {
    const tag = tagFor('dither-angle')
    expect(tag, 'no tag carries data-testid="dither-angle"').toBeTruthy()
    expect(tag!.match(/v-if="([^"]*)"/)?.[1]).toMatch(/!==\s*'pixels'/)
  })

  it('the cell slider\'s default comes from revealCellDefault', () => {
    const tag = tagFor('dither-cell')
    expect(tag, 'no tag carries data-testid="dither-cell"').toBeTruthy()
    expect(tag).toMatch(/revealCellDefault\(/)
  })

  // ── the fix wave ────────────────────────────────────────────────────────
  it('the Block size slider bottoms out at 4 for Pixels — below that there is nothing to halve', () => {
    const tag = tagFor('dither-cell')
    expect(tag).toMatch(/:min="ditherCellMin"/)
    // 4 for Pixels (the finest block is ~2–7‰ depending on aspect, so 1–3‰ has no ladder
    // at all), the library's own floor for every mask style.
    expect(src).toMatch(/const ditherCellMin = computed\(\(\) =>[^\n]*'pixels'[^\n]*\b4\b[^\n]*REVEAL_RANGES\.cell\[0\]/)
  })

  it('the Characters select binds a computed, not a revealParams call in the template', () => {
    const tag = tagFor('dither-chars')
    expect(tag, 'no tag carries data-testid="dither-chars"').toBeTruthy()
    expect(tag).not.toMatch(/revealParams\(/)
    expect(tag).toMatch(/:model-value="ditherChars"/)
    expect(src).toMatch(/const ditherChars = computed\(/)
  })
})

// ── The Custom characters row (Task 15) ─────────────────────────────────────
describe('the Custom characters row', () => {
  const src = readFileSync(INSPECTOR, 'utf8')

  /** The nearest enclosing tag around a `data-testid` marker — works for a plain, non-self-
   *  closing `<input>` (unlike the self-closing-only `tagFor` helpers above). */
  function elementFor(testid: string): string {
    const at = src.indexOf(`data-testid="${testid}"`)
    expect(at, `no element carries data-testid="${testid}"`).toBeGreaterThan(-1)
    const tagStart = src.lastIndexOf('<', at)
    const tagEnd = src.indexOf('>', at)
    return src.slice(tagStart, tagEnd + 1)
  }

  /** A top-level `function name(...) { ... }` declaration, its body found by BALANCING braces
   *  from the first `{` after the signature — safe for a one-liner (`onCustomCharsFocus`) and a
   *  multi-line body alike, unlike a naive search for the next `\n}`. */
  function functionSrc(name: string): string {
    const start = src.indexOf(`function ${name}(`)
    expect(start, `no function ${name} found`).toBeGreaterThan(-1)
    const braceStart = src.indexOf('{', start)
    let depth = 0
    for (let i = braceStart; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
    }
    throw new Error(`unterminated function ${name}`)
  }

  it('sits right under the Characters select, and is a plain <input> — there is no Studio text control', () => {
    const charsIdx = src.indexOf('data-testid="dither-chars"')
    const rowIdx = src.indexOf('data-testid="dither-custom-chars"')
    const dirIdx = src.indexOf('data-testid="dither-dir"')
    expect(charsIdx).toBeGreaterThan(-1)
    expect(rowIdx).toBeGreaterThan(charsIdx)
    expect(rowIdx).toBeLessThan(dirIdx)
    expect(elementFor('dither-custom-chars')).toMatch(/^<input\b/)
  })

  it('shown only when the Characters menu is on Custom (value 14), for Pixels or Assemble\'s Characters look', () => {
    const wrapStart = src.lastIndexOf('v-if="', src.indexOf('data-testid="dither-custom-chars"'))
    const wrapEnd = src.indexOf('"', wrapStart + 'v-if="'.length)
    const cond = src.slice(wrapStart + 'v-if="'.length, wrapEnd)
    expect(cond).toMatch(/ditherChars === '14'/)
    expect(cond).toMatch(/pixels/)
    expect(cond).toMatch(/assemble/)
    expect(cond).toMatch(/characters/)
  })

  it('carries the test id, a 64-char maxlength, spellcheck off, and data-owns-keys', () => {
    const tag = elementFor('dither-custom-chars')
    expect(tag).toMatch(/maxlength="64"/)
    expect(tag).toMatch(/spellcheck="false"/)
    expect(tag).toMatch(/data-owns-keys/)
  })

  it('labels itself "Your characters" and hints at the sort order', () => {
    const at = src.indexOf('data-testid="dither-custom-chars"')
    const before = src.slice(Math.max(0, at - 400), at)
    expect(before).toContain('Your characters')
    expect(src).toContain('Type the characters to build the picture from. They are sorted from light to dark for you.')
  })

  it('placeholder is the library\'s own default set, not a hand-typed copy', () => {
    const tag = elementFor('dither-custom-chars')
    expect(tag).toMatch(/:placeholder="DEFAULT_CUSTOM_CHARS"/)
    expect(src).toMatch(/import\s*\{[^}]*\bDEFAULT_CUSTOM_CHARS\b[^}]*\}\s*from\s*'~\/lib\/motionx\/reveal'/)
  })

  it('reads the RAW stored value (not through revealParams), so an emptied field shows empty, not the default', () => {
    const tag = elementFor('dither-custom-chars')
    expect(tag).toMatch(/:value="behParam\('customChars'\)/)
    expect(tag).not.toMatch(/revealParams\(/)
  })

  it('writes on every input with record = false — a live edit, not a discrete one', () => {
    const body = functionSrc('onCustomCharsInput')
    expect(body).toMatch(/params:\s*\{\s*customChars:/)
    expect(body).toMatch(/\}\s*,\s*false\s*\)/)
  })

  it('emits before-change exactly once per edit session — on the first input after a focus, not on focus itself and not again while still typing', () => {
    const focusBody = functionSrc('onCustomCharsFocus')
    expect(focusBody).not.toMatch(/emit\(/)
    const inputBody = functionSrc('onCustomCharsInput')
    expect(inputBody).toMatch(/emit\('before-change'\)/)
    // guarded by a session flag so it fires once, not on every keystroke
    expect(inputBody).toMatch(/if\s*\(!customCharsSession\)/)
  })

  it('does nothing extra on blur beyond ending the session (no emit)', () => {
    const body = functionSrc('onCustomCharsBlur')
    expect(body).not.toMatch(/emit\(/)
  })
})

// ── The Assemble style (Task 13) ─────────────────────────────────────────────
describe('the Assemble inspector block', () => {
  const src = readFileSync(INSPECTOR, 'utf8')
  const tagFor = (testid: string) =>
    (src.match(/<\w+\b[\s\S]*?\/>/g) ?? []).find((t) => t.includes(`data-testid="${testid}"`))

  it('the Look row is a labelled StudioSegmentedRow, shown only for Assemble', () => {
    const tag = tagFor('dither-look')
    expect(tag, 'no tag carries data-testid="dither-look"').toBeTruthy()
    expect(tag).toMatch(/<StudioSegmentedRow\b/)
    expect(tag).toMatch(/label="Look"/)
    expect(tag).toMatch(/:options="\['dither', 'characters'\]"|:options="DITHER_LOOKS"/)
    expect(tag).toMatch(/:option-labels="\['Dither', 'Characters'\]"|:option-labels="DITHER_LOOK_LABELS"/)
    expect(tag!.match(/v-if="([^"]*)"/)?.[1]).toMatch(/assemble/)
  })

  it('the Pattern select appears only for the Dither look and binds DITHER_PATTERNS', () => {
    const tag = tagFor('dither-pattern')
    expect(tag, 'no tag carries data-testid="dither-pattern"').toBeTruthy()
    expect(tag).toMatch(/<StudioSelect\b/)
    const cond = tag!.match(/v-if="([^"]*)"/)?.[1] ?? ''
    expect(cond).toMatch(/assemble/)
    expect(cond).toMatch(/dither/)
    expect(tag).toMatch(/hint="The same patterns as the Dither effect in Shader Studio"/)
    expect(src).toContain('DITHER_PATTERN_OPTIONS')
    expect(src).toContain('DITHER_PATTERN_LABELS')
    expect(src).toMatch(/DITHER_PATTERNS\.map/)
  })

  it('the Colour levels slider ranges 2–8, default 3', () => {
    const tag = tagFor('dither-levels')
    expect(tag, 'no tag carries data-testid="dither-levels"').toBeTruthy()
    expect(tag).toMatch(/<StudioSlider\b/)
    expect(tag).toMatch(/:min="2"/)
    expect(tag).toMatch(/:max="8"/)
    expect(tag).toMatch(/:step="1"/)
    expect(tag).toMatch(/:default="3"|:default="REVEAL_DEFAULTS\.levels"/)
    expect(tag).toMatch(/v-bind="gesture\('dither-levels'\)"/)
    expect(tag).toMatch(/setBehNum\('dither-levels',\s*\{\s*levels:\s*v\s*\}\)/)
  })

  it('dither-chars also appears for Assemble with the Characters look', () => {
    const tag = tagFor('dither-chars')
    const cond = tag!.match(/v-if="([^"]*)"/)?.[1] ?? ''
    expect(cond).toMatch(/pixels/)
    expect(cond).toMatch(/assemble/)
    expect(cond).toMatch(/characters/)
  })

  it('Band width and Scatter sliders are Assemble-only, 0–100 step 1, stored (not fraction) units', () => {
    const band = tagFor('dither-band')
    expect(band, 'no tag carries data-testid="dither-band"').toBeTruthy()
    expect(band).toMatch(/<StudioSlider\b/)
    expect(band).toMatch(/label="Band width"/)
    expect(band).toMatch(/:min="0"/)
    expect(band).toMatch(/:max="100"/)
    expect(band).toMatch(/:step="1"/)
    expect(band!.match(/v-if="([^"]*)"/)?.[1]).toMatch(/assemble/)
    // reads the STORED 0–100 value via numParam, never via revealParams (which returns 0–1)
    expect(band).toMatch(/numParam\('band'/)
    expect(band).not.toMatch(/revealParams\(/)
    expect(band).toMatch(/setBehNum\('dither-band',\s*\{\s*band:\s*v\s*\}\)/)

    const scatter = tagFor('dither-scatter')
    expect(scatter, 'no tag carries data-testid="dither-scatter"').toBeTruthy()
    expect(scatter).toMatch(/label="Scatter"/)
    expect(scatter).toMatch(/:min="0"/)
    expect(scatter).toMatch(/:max="100"/)
    expect(scatter).toMatch(/:step="1"/)
    expect(scatter!.match(/v-if="([^"]*)"/)?.[1]).toMatch(/assemble/)
    expect(scatter).toMatch(/numParam\('scatter'/)
    expect(scatter).not.toMatch(/revealParams\(/)
    expect(scatter).toMatch(/setBehNum\('dither-scatter',\s*\{\s*scatter:\s*v\s*\}\)/)
  })

  it('the Block size label and hint extend to Assemble', () => {
    const start = src.indexOf('const ditherCellLabel = computed(')
    expect(start, 'no ditherCellLabel computed found').toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n', start + 400) + 1)
    expect(body).toContain("'assemble'")
    expect(src).toContain('How big the cells are. They stay this size for the whole transition.')
  })

  it("Assemble's Block size floor is 2, distinct from Pixels' 4", () => {
    expect(src).toMatch(/const ditherCellMin = computed\(\(\) =>[^\n]*'pixels'[^\n]*\b4\b[^\n]*'assemble'[^\n]*\b2\b[^\n]*REVEAL_RANGES\.cell\[0\]/)
  })

  it('the Drift row is labelled Shimmer speed for Assemble too, with its own hint', () => {
    expect(src).toContain('How fast the scattered order re-rolls. 0 is still.')
    const start = src.indexOf('const ditherDriftLabel = computed(')
    expect(start, 'no ditherDriftLabel computed found').toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n', start + 400) + 1)
    expect(body).toContain("'assemble'")
    expect(body).toContain('Shimmer speed')
  })

  it('the Angle row stays visible for Assemble (its v-if only excludes Pixels)', () => {
    const tag = tagFor('dither-angle')
    expect(tag!.match(/v-if="([^"]*)"/)?.[1]).toMatch(/!==\s*'pixels'/)
  })

  it('Edge softness stays Wipe-only — Assemble does not show it', () => {
    const tag = tagFor('dither-softness')
    expect(tag!.match(/v-if="([^"]*)"/)?.[1]).toMatch(/wipe/)
    expect(tag!.match(/v-if="([^"]*)"/)?.[1]).not.toMatch(/assemble/)
  })

  it('every new Assemble row keeps the gesture/setBehNum undo pairing (sliders only)', () => {
    for (const id of ['dither-levels', 'dither-band', 'dither-scatter']) {
      const tag = tagFor(id)
      expect(tag, `no tag carries data-testid="${id}"`).toBeTruthy()
      expect(tag).toMatch(new RegExp(`v-bind="gesture\\('${id}'\\)"`))
    }
  })
})

/** The gallery tile stands in for the real transition, so it must not show something the
 *  transition never shows. It ramps with the library's own `pixelBrightness`, so it has to
 *  use the shader's COMPRESSED tone too — on raw luma the white caption bar lit ~9 % of its
 *  cells at amount 0, where the real transition draws nothing at all. */
describe('the Dither gallery tile ramps like the shader', () => {
  const PREVIEW = readFileSync(
    fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/MotionDitherPreview.vue', import.meta.url)),
    'utf8',
  )

  it('compresses tone with the library\'s own constants (the ones the shader uses) and ramps with pixelBrightness', () => {
    expect(PREVIEW).toContain('PIXEL_TONE_MIN + (PIXEL_TONE_MAX - PIXEL_TONE_MIN) * luma')
    expect(PREVIEW).toContain('pixelBrightness(amount)')
    // the raw-luma version is gone
    expect(PREVIEW).not.toMatch(/clamp01\(luma \+ brightness\)/)
  })

  it('draws nothing at amount 0, for the brightest cell there is', () => {
    // The tile's own test of the same arithmetic: the top of the tone range (pure white) at amount 0.
    const brightest = PIXEL_TONE_MAX
    expect(Math.min(1, Math.max(0, brightest + pixelBrightness(0)))).toBe(0)
  })
})

describe('the Dither timeline row name', () => {
  it('MotionBandTimeline imports MOTION_ONLY_LABELS for the reveal fallback label', () => {
    expect(readFileSync(TIMELINE, 'utf8')).toContain('MOTION_ONLY_LABELS')
  })
})

// ── The Assemble gallery tile (Task 13) ──────────────────────────────────────
describe('the Assemble gallery tile', () => {
  const PREVIEW = readFileSync(
    fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/MotionDitherPreview.vue', import.meta.url)),
    'utf8',
  )
  const GALLERY_SRC = readFileSync(GALLERY, 'utf8')

  it('MotionDitherPreview gains a mode prop distinguishing Pixels from Assemble', () => {
    expect(PREVIEW).toMatch(/mode\?:\s*'pixels'\s*\|\s*'assemble'/)
  })

  it('the Assemble paint path uses the library\'s own assembleTest, not a hand-rolled front', () => {
    expect(PREVIEW).toMatch(/import\s*\{[^}]*assembleTest[^}]*\}\s*from\s*'~\/lib\/motionx\/reveal'/)
    expect(PREVIEW).toMatch(/assembleTest\(/)
  })

  it('blocks are 4px on the 48×30 tile', () => {
    // A constant block size and a grid derived from it — not the Pixels halving ladder.
    expect(PREVIEW).toMatch(/ASSEMBLE_BLOCK\s*=\s*4/)
  })

  it('colours are quantised to 3 levels against bayer8', () => {
    expect(PREVIEW).toMatch(/ASSEMBLE_LEVELS\s*=\s*3/)
    expect(PREVIEW).toMatch(/bayer8\(/)
  })

  it('MotionGallery passes mode="assemble" for the assemble preview kind', () => {
    const tag = (GALLERY_SRC.match(/<MotionDitherPreview\b[\s\S]*?\/>/g) ?? [])
      .find((t) => t.includes("m.preview === 'assemble'"))
    expect(tag, 'no MotionDitherPreview tag branches on m.preview === \'assemble\'').toBeTruthy()
    expect(tag).toMatch(/mode="assemble"/)
  })

  it('MotionGallery still renders the plain Dither preview for the dither preview kind', () => {
    const tag = (GALLERY_SRC.match(/<MotionDitherPreview\b[\s\S]*?\/>/g) ?? [])
      .find((t) => t.includes("m.preview === 'dither'"))
    expect(tag, 'no MotionDitherPreview tag branches on m.preview === \'dither\'').toBeTruthy()
  })
})
