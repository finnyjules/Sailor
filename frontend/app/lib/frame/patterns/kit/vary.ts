import type { Kind, LayoutDef, LayoutOut, TextEl, El } from './types'
import type { Box } from './check'

// ═══════════════════════ vary ═══════════════════════
// Ported from the prototype (docs/superpowers/specs/assets/2026-09-23-frame-layout-system/
// layout-pane.html, `lineOptions`, `sig`, `candidatesFor`). Enumerates every checked, distinct
// variation of a layout — line breaks, arrangement, scale, image side — ranks them and orders
// them for diversity, so the Layout tab can step through them.
//
// No accent-colour choice in stage 1 — it would recolour the user's own text.

export interface Choice { lines: number; arr: number; scale: 'full' | 'quiet'; side: 'right' | 'left' }

export const DEFAULT_CHOICE: Choice = { lines: 0, arr: 0, scale: 'full', side: 'right' }

export interface LineOption { v: number; lines: string[]; label: string }

/** Balance `words` into `n` roughly equal-length lines (by character count). */
function balance(words: string[], n: number): string[] {
  const total = words.join(' ').length
  const target = total / n
  const out: string[] = []
  let cur = ''
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w
    if (cur && out.length < n - 1 && t.length > target * 1.08) { out.push(cur); cur = w } else cur = t
  }
  out.push(cur)
  return out
}

/** The distinct ways a title can be broken into lines: a single word can't break; a phrase is
 *  either one line or every word its own line; a sentence is balanced across 2, 3 or 4 lines.
 *  Duplicates (the same lines, e.g. a two-word phrase splitting the same way twice) are dropped. */
export function lineOptions(kind: Kind, title: string, oneLineFirst?: boolean): LineOption[] {
  const words = title.split(' ')
  if (kind === 'word') return [{ v: 0, lines: [title], label: title }]
  const opts: string[][] = kind === 'phrase'
    ? (oneLineFirst ? [[title], words] : [words, [title]])
    : [balance(words, 3), balance(words, 2), balance(words, 4)]
  const seen = new Set<string>()
  const out: LineOption[] = []
  for (const l of opts) {
    const k = l.join('|')
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ v: out.length, lines: l, label: l.join(' / ') })
  }
  return out
}

export interface Candidate { choice: Choice; out: LayoutOut; score: number; sig: string }

/** A geometry signature: two outputs with the same signature look the same on the page. */
function sigOf(out: LayoutOut): string {
  const keys = ['x', 'y', 'w', 'h', 'top', 'base', 'size', 'cx', 'cy', 'r'] as const
  return JSON.stringify(
    out.els
      .filter(e => e.k !== 'missing')
      .map((e) => {
        const rec = e as unknown as Record<string, number | string | undefined>
        return [
          e.k,
          rec.role ?? null,
          rec.s ?? null,
          rec.color ?? null,
          rec.rot ?? null,
          ...keys.map((k) => {
            const v = rec[k]
            return v == null ? null : Math.round((v as number) * 2)
          }),
        ]
      }),
  )
}

/** Every combination → run → check → dedupe (by geometry signature) → rank → diversity order.
 *  `run(choice)` builds the sheet for that choice and calls the layout; `check(out)` returns reasons. */
/** Area of a box's intersection with another (0 when they don't overlap). */
function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return w > 0 && h > 0 ? w * h : 0
}

/** How much of a candidate's image its own text sits on top of: the summed intersection area of
 *  every text box with the image box, over the image's own area. 0 with no image or no `boxOf`
 *  (the sheet the candidate's geometry was measured in — vary itself carries no sheet). */
function coverOf(out: LayoutOut, boxOf?: (e: El) => Box | null): number {
  if (!boxOf) return 0
  const image = out.els.find((e): e is Extract<El, { k: 'p' }> | Extract<El, { k: 'c' }> =>
    e.k === 'p' || (e.k === 'c' && !!e.photo))
  if (!image) return 0
  const imageBox = boxOf(image)
  if (!imageBox) return 0
  const area = (imageBox.x1 - imageBox.x0) * (imageBox.y1 - imageBox.y0)
  if (area <= 0) return 0
  const texts = out.els.filter((e): e is TextEl => e.k === 't')
  const covered = texts.reduce((sum, t) => {
    const box = boxOf(t)
    return box ? sum + overlapArea(box, imageBox) : sum
  }, 0)
  return covered / area
}

export function enumerate(def: LayoutDef, opts: {
  kind: Kind
  title: string
  hasImage: boolean
  run(c: Choice): LayoutOut
  check(out: LayoutOut): string[]
  infoSize: number
  /** The candidate's own sheet, so vary can measure real ink boxes without depending on the
   *  sheet type itself. Optional: omitted, the cover penalty is 0 and scores match Stage 1. */
  boxOf?: (e: El) => Box | null
}): Candidate[] {
  const { run, check, infoSize, hasImage, boxOf } = opts
  const lineOpts = lineOptions(opts.kind, opts.title, def.oneLineFirst)

  const defSig = sigOf(run(DEFAULT_CHOICE))
  const arrVaries = [1, 2].some(a => sigOf(run({ ...DEFAULT_CHOICE, arr: a })) !== defSig)
  const sideMatters = hasImage && sigOf(run({ ...DEFAULT_CHOICE, side: 'left' })) !== defSig

  const vals: { lines: number[]; arr: number[]; scale: Array<'full' | 'quiet'>; side: Array<'right' | 'left'> } = {
    lines: lineOpts.map(o => o.v),
    arr: arrVaries ? [0, 1, 2] : [0],
    scale: def.keepScale ? ['full'] : ['full', 'quiet'],
    side: sideMatters ? ['right', 'left'] : ['right'],
  }

  let combos: Choice[] = [{ ...DEFAULT_CHOICE }]
  for (const key of ['lines', 'arr', 'scale', 'side'] as const) {
    combos = combos.flatMap(c => vals[key].map(v => ({ ...c, [key]: v }) as Choice))
  }

  const seen = new Set<string>()
  const list: Candidate[] = []
  for (const choice of combos) {
    const out = run(choice)
    const s = sigOf(out)
    if (seen.has(s)) continue
    seen.add(s)
    if (check(out).length) continue

    const texts = out.els.filter((e): e is TextEl => e.k === 't')
    const maxTextSize = texts.length ? Math.max(...texts.map(e => e.size || 0)) : 0
    const distinctLeftEdges = new Set(
      texts.filter(e => !e.rot && (e.align ?? 'left') === 'left').map(e => Math.round(e.x * 10) / 10),
    ).size
    const isDefault = choice.lines === DEFAULT_CHOICE.lines && choice.arr === DEFAULT_CHOICE.arr
      && choice.scale === DEFAULT_CHOICE.scale && choice.side === DEFAULT_CHOICE.side
    // Soft penalty, not rejection (spec §6): text sitting on top of more than a fifth of the
    // image ranks down, but still gets ordered — never dropped by `check`.
    const cover = coverOf(out, boxOf)
    const score = Math.log(maxTextSize / infoSize) - 0.12 * distinctLeftEdges
      + (isDefault ? 1 : 0) - (choice.scale === 'quiet' ? 0.35 : 0) - (cover > 0.2 ? 0.5 : 0)
    list.push({ choice, out, score, sig: s })
  }

  const WT: Record<keyof Choice, number> = { lines: 3, arr: 3, side: 2, scale: 1.5 }
  const dist = (a: Candidate, b: Candidate) =>
    (Object.keys(WT) as (keyof Choice)[]).reduce((d, k) => d + (a.choice[k] !== b.choice[k] ? WT[k] : 0), 0)

  list.sort((a, b) => b.score - a.score)
  // The default always leads when it passes — the score bonus alone could be outranked.
  const di = list.findIndex(c => (Object.keys(DEFAULT_CHOICE) as (keyof Choice)[]).every(k => c.choice[k] === DEFAULT_CHOICE[k]))
  if (di > 0) list.unshift(...list.splice(di, 1))
  const ordered: Candidate[] = list.length ? [list.shift()!] : []
  while (list.length) {
    let bestIdx = 0
    let bestValue = -Infinity
    list.forEach((c, i) => {
      const recent = ordered.slice(-3)
      const v = Math.min(...recent.map(o => dist(o, c))) + c.score * 0.8
      if (v > bestValue) { bestValue = v; bestIdx = i }
    })
    ordered.push(list.splice(bestIdx, 1)[0]!)
  }
  return ordered
}
