import type { Kind, LayoutDef, LayoutOut, TextEl } from './types'

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
export function enumerate(def: LayoutDef, opts: {
  kind: Kind
  title: string
  hasImage: boolean
  run(c: Choice): LayoutOut
  check(out: LayoutOut): string[]
  infoSize: number
}): Candidate[] {
  const { run, check, infoSize, hasImage } = opts
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
    const score = Math.log(maxTextSize / infoSize) - 0.12 * distinctLeftEdges
      + (isDefault ? 1 : 0) - (choice.scale === 'quiet' ? 0.35 : 0)
    list.push({ choice, out, score, sig: s })
  }

  const WT: Record<keyof Choice, number> = { lines: 3, arr: 3, side: 2, scale: 1.5 }
  const dist = (a: Candidate, b: Candidate) =>
    (Object.keys(WT) as (keyof Choice)[]).reduce((d, k) => d + (a.choice[k] !== b.choice[k] ? WT[k] : 0), 0)

  list.sort((a, b) => b.score - a.score)
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
