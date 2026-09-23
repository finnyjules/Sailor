import { describe, it, expect } from 'vitest'
import { DEFAULT_CHOICE, enumerate, lineOptions } from '~/lib/frame/patterns/kit/vary'
import type { Choice } from '~/lib/frame/patterns/kit/vary'
import type { El, LayoutDef, LayoutOut } from '~/lib/frame/patterns/kit/types'

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
})
