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
import type { TextCell } from '~/lib/motionx/text/units'

const MODAL = fileURLToPath(new URL('../../../app/components/vue-canvas/CompositorModal.vue', import.meta.url))
const INSPECTOR = fileURLToPath(new URL('../../../app/components/vue-canvas/compositor/MotionInspector.vue', import.meta.url))

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

/** The only TypeScript the statements below contain: a cast, a generic call argument, and an
 *  `: any` parameter. Anything else left behind is a syntax error when the statement runs. */
const stripTypeSyntax = (code: string) => code
  .replace(/\s+as\s+unknown\s+as\s+\{[^{}]*\}/g, '')
  .replace(/\s+as\s+[A-Za-z_$][\w$.]*(?:<[^<>]*>)?(?:\[\])?(?:\s*\|\s*(?:undefined|null))?/g, '')
  .replace(/\b([A-Za-z_$][\w$]*)<[^<>()]*>\(/g, '$1(')
  .replace(/([(,]\s*)([A-Za-z_$][\w$]*)\s*:\s*any\b/g, '$1$2')

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
