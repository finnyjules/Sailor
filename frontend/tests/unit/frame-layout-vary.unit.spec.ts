import { describe, it, expect } from 'vitest'
import { DEFAULT_CHOICE, enumerate, lineOptions } from '~/lib/frame/patterns/kit/vary'
import type { Choice } from '~/lib/frame/patterns/kit/vary'
import type { El, LayoutDef, LayoutOut } from '~/lib/frame/patterns/kit/types'
import type { Box } from '~/lib/frame/patterns/kit/check'

// A fake layout: `fn` is never called by `enumerate` (the caller's own `run` builds the sheet
// and calls the layout) — it only has to satisfy the LayoutDef shape.
const fakeDef = (extra: Partial<LayoutDef> = {}): LayoutDef => ({
  id: 'fake', name: 'Fake', fits: ['phrase'], fn: () => ({ els: [], did: '' }), ...extra,
})

const INFO_SIZE = 5

/** Text x shifts with `arr` (but arr 1 and 2 land on the SAME x, so they collide once run) —
 *  a duplicate on purpose. Lines count follows `choice.lines` (0 = two lines, 1 = one line).
 *  Size shrinks with `scale`. A photo's x flips with `side`. */
function run(choice: Choice): LayoutOut {
  const lines = choice.lines === 0 ? ['Two', 'Words'] : ['Two Words']
  const arrX = choice.arr === 0 ? 10 : 15
  const size = choice.scale === 'quiet' ? 8 : 10
  const sideX = choice.side === 'left' ? 0 : 20
  const els: El[] = lines.map((s, i) => ({
    k: 't', s, x: arrX, top: 10 + i * 12, size, wt: 600, ls: 0, lh: 1, role: 'title',
  }))
  els.push({ k: 'p', x: sideX, y: 0, w: 10, h: 10, role: 'photo' })
  return { els, did: `lines=${choice.lines} arr=${choice.arr} scale=${choice.scale} side=${choice.side}` }
}

/** Fails only the (quiet, left) combination — an arbitrary, deliberately reachable failure. */
const check = (out: LayoutOut): string[] =>
  out.did.includes('scale=quiet') && out.did.includes('side=left') ? ['quiet + left collides'] : []

describe('layout kit — vary', () => {
  it('lineOptions: a single word cannot break', () => {
    expect(lineOptions('word', 'Solo')).toEqual([{ v: 0, lines: ['Solo'], label: 'Solo' }])
  })

  it('lineOptions: a phrase offers one line and every word its own line, default order', () => {
    const opts = lineOptions('phrase', 'Two Words')
    expect(opts.map(o => o.lines)).toEqual([['Two', 'Words'], ['Two Words']])
  })

  it('lineOptions: oneLineFirst puts the single line first', () => {
    const opts = lineOptions('phrase', 'Two Words', true)
    expect(opts.map(o => o.lines)).toEqual([['Two Words'], ['Two', 'Words']])
  })

  it('lineOptions: a sentence balances across 2, 3 and 4 lines, deduped', () => {
    const opts = lineOptions('sentence', 'The quick brown fox jumps')
    expect(opts.length).toBeGreaterThan(0)
    expect(opts.length).toBeLessThanOrEqual(3)
    const seen = new Set(opts.map(o => o.lines.join('|')))
    expect(seen.size).toBe(opts.length)
  })

  it('enumerate: dedupes by geometry, drops failing candidates, puts the default first, and diversifies', () => {
    const result = enumerate(fakeDef(), {
      kind: 'phrase', title: 'Two Words', hasImage: true, run, check, infoSize: INFO_SIZE,
    })

    expect(result.length).toBeGreaterThan(1)

    // Duplicates removed: every surviving candidate has a distinct geometry signature.
    expect(new Set(result.map(c => c.sig)).size).toBe(result.length)

    // Failing candidates dropped: none of the survivors are the deliberately-failing combo.
    expect(result.every(c => !(c.choice.scale === 'quiet' && c.choice.side === 'left'))).toBe(true)
    expect(result.every(c => check(c.out).length === 0)).toBe(true)

    // The default choice comes first (it passes the check here, and gets the ranking bonus).
    expect(result[0]!.choice).toEqual(DEFAULT_CHOICE)

    // Consecutive candidates differ in a heavy-weighted choice (lines/arr/side) when the
    // scoring leaves room to diversify — here most full-scale candidates tie on score, so the
    // diversity pass should steer away from the default on a heavy axis rather than a light one.
    const second = result[1]!.choice
    const differsOnHeavyAxis = second.lines !== DEFAULT_CHOICE.lines
      || second.arr !== DEFAULT_CHOICE.arr
      || second.side !== DEFAULT_CHOICE.side
    expect(differsOnHeavyAxis).toBe(true)
  })

  it('enumerate: when the default fails, the best-ranked passing candidate comes first', () => {
    const failsDefault = (out: LayoutOut): string[] =>
      out.did === 'lines=0 arr=0 scale=full side=right' ? ['default deliberately fails'] : check(out)

    const result = enumerate(fakeDef(), {
      kind: 'phrase', title: 'Two Words', hasImage: true, run, check: failsDefault, infoSize: INFO_SIZE,
    })

    expect(result.length).toBeGreaterThan(0)
    expect(result[0]!.choice).not.toEqual(DEFAULT_CHOICE)
    expect(failsDefault(result[0]!.out).length).toBe(0)
    // Nothing outscores the chosen first candidate among the survivors.
    expect(result[0]!.score).toBe(Math.max(...result.map(c => c.score)))
  })

  it('enumerate: every candidate failing returns an empty list', () => {
    const result = enumerate(fakeDef(), {
      kind: 'phrase', title: 'Two Words', hasImage: true, run, check: () => ['always fails'], infoSize: INFO_SIZE,
    })
    expect(result).toEqual([])
  })

  it('enumerate: cover penalty ranks a candidate whose text covers the image below an identical one that does not', () => {
    // arr 0 (x=25, no cover) is excluded by `check` below, so it never competes for the default
    // slot — leaving arr 1 (x=0, covers 40% of the image) and arr 2 (x=30, no cover) as the only
    // survivors. Both are non-default, so the score gap between them is the cover penalty alone.
    const image: El = { k: 'p', x: 0, y: 0, w: 20, h: 20, role: 'photo' } as El
    const boxes = new Map<El, Box>()
    const runCover = (choice: Choice): LayoutOut => {
      const x = choice.arr === 0 ? 25 : choice.arr === 1 ? 0 : 30
      const title: El = { k: 't', s: 'Solo', x, top: 0, w: 20, size: 20, wt: 600, ls: 0, lh: 1, role: 'title' } as El
      boxes.set(title, { x0: x, y0: 0, x1: x + 20, y1: 8 })
      boxes.set(image, { x0: 0, y0: 0, x1: 20, y1: 20 })
      return { els: [title, image], did: `arr=${choice.arr}` }
    }
    const checkCover = (out: LayoutOut): string[] => (out.did === 'arr=0' ? ['excluded from the default slot'] : [])
    const boxOfFn = (e: El) => boxes.get(e) ?? null

    const result = enumerate(fakeDef({ keepScale: true }), {
      kind: 'word', title: 'Solo', hasImage: true, run: runCover, check: checkCover, infoSize: INFO_SIZE, boxOf: boxOfFn,
    })

    expect(result.length).toBe(2)
    const covering = result.find(c => c.choice.arr === 1)!
    const clear = result.find(c => c.choice.arr === 2)!
    expect(covering).toBeDefined()
    expect(clear).toBeDefined()
    expect(clear.score - covering.score).toBeCloseTo(0.5, 5)
    expect(result[0]).toBe(clear)
  })

  it('enumerate: with no boxOf passed, scores equal the Stage 1 formula exactly (cover never penalised)', () => {
    const image: El = { k: 'p', x: 0, y: 0, w: 20, h: 20, role: 'photo' } as El
    const runCover = (choice: Choice): LayoutOut => {
      const x = choice.arr === 0 ? 25 : choice.arr === 1 ? 0 : 30
      const title: El = { k: 't', s: 'Solo', x, top: 0, w: 20, size: 20, wt: 600, ls: 0, lh: 1, role: 'title' } as El
      return { els: [title, image], did: `arr=${choice.arr}` }
    }
    const result = enumerate(fakeDef({ keepScale: true }), {
      kind: 'word', title: 'Solo', hasImage: true, run: runCover, check: () => [], infoSize: INFO_SIZE,
    })
    // arr 0 is the default (gets the +1 bonus); arr 1 and arr 2 are otherwise identical (same
    // maxTextSize, same distinct-left-edge count) — with no `boxOf`, cover is always 0, so they tie.
    const a1 = result.find(c => c.choice.arr === 1)!
    const a2 = result.find(c => c.choice.arr === 2)!
    expect(a1.score).toBe(a2.score)
  })

  it('enumerate: a style\'s rank is added to the Stage 1 score', () => {
    // Same fixture as the cover-penalty test, but ranked: arr 1 (x=0) is given a big reward by
    // `rank`, so it should win the top slot even though it also carries the cover penalty.
    const image: El = { k: 'p', x: 0, y: 0, w: 20, h: 20, role: 'photo' } as El
    const boxes = new Map<El, Box>()
    const runCover = (choice: Choice): LayoutOut => {
      const x = choice.arr === 0 ? 25 : choice.arr === 1 ? 0 : 30
      const title: El = { k: 't', s: 'Solo', x, top: 0, w: 20, size: 20, wt: 600, ls: 0, lh: 1, role: 'title' } as El
      boxes.set(title, { x0: x, y0: 0, x1: x + 20, y1: 8 })
      boxes.set(image, { x0: 0, y0: 0, x1: 20, y1: 20 })
      return { els: [title, image], did: `arr=${choice.arr}` }
    }
    const checkCover = (out: LayoutOut): string[] => (out.did === 'arr=0' ? ['excluded from the default slot'] : [])
    const boxOfFn = (e: El) => boxes.get(e) ?? null
    const rank = (out: LayoutOut): number => (out.did === 'arr=1' ? 10 : 0)

    const result = enumerate(fakeDef({ keepScale: true }), {
      kind: 'word', title: 'Solo', hasImage: true, run: runCover, check: checkCover, infoSize: INFO_SIZE, boxOf: boxOfFn, rank,
    })
    expect(result[0]!.choice.arr).toBe(1)
  })

  it('enumerate: no `rank` opt (Swiss) — scores are exactly the Stage 1 formula, unchanged', () => {
    // Pin: the same fixture and formula as the pre-Task-4 tests above, run again with every
    // Task 4 addition (`rank`) simply omitted — the score must not move.
    const result = enumerate(fakeDef(), {
      kind: 'phrase', title: 'Two Words', hasImage: true, run, check, infoSize: INFO_SIZE,
    })
    const def = result.find(c => c.choice.lines === DEFAULT_CHOICE.lines && c.choice.arr === DEFAULT_CHOICE.arr
      && c.choice.scale === DEFAULT_CHOICE.scale && c.choice.side === DEFAULT_CHOICE.side)!
    // maxTextSize 10, distinctLeftEdges 1 (both lines at x=10), isDefault, full scale, no cover.
    expect(def.score).toBeCloseTo(Math.log(10 / INFO_SIZE) - 0.12 * 1 + 1, 10)
  })

  it('enumerate: the default leads even when another variation outscores it', () => {
    // one line (lines=1) is set far larger, so its score beats the default's +1 bonus
    const bigOneLine = (c: Choice): LayoutOut => {
      const out = run(c)
      if (c.lines === 1) for (const e of out.els) if (e.k === 't') e.size = 100
      return out
    }
    const result = enumerate(fakeDef(), {
      kind: 'phrase', title: 'Two Words', hasImage: true, run: bigOneLine, check, infoSize: INFO_SIZE,
    })
    expect(Math.max(...result.map(c => c.score))).toBeGreaterThan(result[0]!.score)
    expect(result[0]!.choice).toEqual(DEFAULT_CHOICE)
  })
})
