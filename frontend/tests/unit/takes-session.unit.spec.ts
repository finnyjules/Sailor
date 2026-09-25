import { describe, it, expect } from 'vitest'
import {
  assignRun, CURRENT, chooseTile, displaySnapshot, failPending, failRun, holdOnLanding, hoverTile, ingestTakes, isTakesWorking,
  openTakes, pendingRunIds, readyCount, setRunIds, settleUnqueued, shownTakeId, showOnData, takesStatus, TAKES_PER_SET,
  wantedActiveTakeId,
} from '~/lib/prompt/takesSession'
import type { Take } from '~/composables/useTakes'

const take = (id: string, promptId: string | null = `p-${id}`, img = `u-${id}`): Take => ({ id, createdAt: 0, promptId, images: [img] })
const open = () => openTakes({ nodeId: 'n1', nodeLabel: 'Rainy shop', request: '', takes: [take('t0')], images: ['u-t0'], activeTakeId: 't0' })
/** A set whose three runs p-t1, p-t2, p-t3 have been queued. */
const queued = () => ['p-t1', 'p-t2', 'p-t3'].reduce(assignRun, open())

describe('takes session', () => {
  it('opens with three pulsing tiles and remembers what was there', () => {
    const s = open()
    expect(TAKES_PER_SET).toBe(3)
    expect(s.tiles.map(t => t.state)).toEqual(['pending', 'pending', 'pending'])
    expect(s.known).toEqual(['t0'])
    expect(s.currentThumb).toBe('u-t0')
    expect(isTakesWorking(s)).toBe(true)
    expect(takesStatus(s)).toBe('Working…')
  })

  it('each queued run takes the next tile; only that run’s take fills it', () => {
    let s = assignRun(open(), 'p-t1')
    expect(s.tiles.map(t => t.promptId)).toEqual(['p-t1', null, null])
    expect(assignRun(s, 'p-t1')).toBe(s)
    s = assignRun(assignRun(s, 'p-t2'), 'p-t3')
    expect(setRunIds(s)).toEqual(['p-t1', 'p-t2', 'p-t3'])
    s = ingestTakes(s, [take('t0'), take('t2')])
    expect(s.tiles.map(t => t.state)).toEqual(['pending', 'ready', 'pending'])
    expect(s.tiles[1]).toEqual({ state: 'ready', takeId: 't2', promptId: 'p-t2', thumb: 'u-t2' })
    expect(takesStatus(s)).toBe('1 of 3 ready')
    expect(pendingRunIds(s)).toEqual(['p-t1', 'p-t3'])
    s = ingestTakes(s, [take('t0'), take('t1'), take('t2'), take('t3')])
    expect(readyCount(s)).toBe(3)
    expect(isTakesWorking(s)).toBe(false)
    expect(takesStatus(s)).toBe('Three takes · hover to preview, Keep one')
  })

  it('a take from a run that is not this set\'s never becomes a tile (an earlier set\'s late arrival, a plain Run)', () => {
    const s = queued()
    expect(ingestTakes(s, [take('t0'), take('old', 'p-old'), take('bare', null)])).toBe(s)
    expect(ingestTakes(open(), [take('t1')]).tiles.map(t => t.state)).toEqual(['pending', 'pending', 'pending'])
  })

  it('returns the same object when nothing new arrived (so watchers can skip)', () => {
    const s = ingestTakes(queued(), [take('t0'), take('t1')])
    expect(ingestTakes(s, [take('t0'), take('t1')])).toBe(s)
  })

  it('a re-emission of the same run (same promptId, new take id) refreshes its tile instead of filling another', () => {
    let s = ingestTakes(assignRun(open(), 'p1'), [take('t0'), take('t1', 'p1')])
    s = ingestTakes(s, [take('t0'), take('t1b', 'p1', 'u-new')])
    expect(s.tiles[0]).toEqual({ state: 'ready', takeId: 't1b', promptId: 'p1', thumb: 'u-new' })
    expect(s.tiles[1]!.state).toBe('pending')
  })

  it('ignores takes with nothing to show', () => {
    const s = assignRun(open(), 'px')
    expect(ingestTakes(s, [{ id: 'x', createdAt: 0, promptId: 'px', text: 'hi' }])).toBe(s)
  })

  it('a failed run fails only its own tile; a tile no run was queued for fails when the loop ends', () => {
    let s = ingestTakes(assignRun(assignRun(open(), 'p-t1'), 'p-t2'), [take('t1')])
    s = failRun(s, 'p-t2')
    expect(s.tiles.map(t => t.state)).toEqual(['ready', 'failed', 'pending'])
    expect(failRun(s, 'p-t1')).toBe(s) // a ready tile stays ready
    expect(failRun(s, 'p-other')).toBe(s)
    s = settleUnqueued(s)
    expect(s.tiles.map(t => t.state)).toEqual(['ready', 'failed', 'failed'])
    expect(isTakesWorking(s)).toBe(false)
    expect(takesStatus(s)).toBe('One of three came back · hover to preview, Keep one')
    expect(takesStatus(failPending(open()))).toBe('No takes came back')
  })

  it('a run failed by the backstop that lands after all still fills its tile', () => {
    const s = ingestTakes(failRun(queued(), 'p-t1'), [take('t1')])
    expect(s.tiles[0]).toMatchObject({ state: 'ready', takeId: 't1' })
  })

  it('shows the hovered tile, else the chosen one, else the version at open', () => {
    let s = ingestTakes(queued(), [take('t1'), take('t2')])
    expect(shownTakeId(s)).toBeNull()
    s = hoverTile(s, 't2'); expect(shownTakeId(s)).toBe('t2')
    s = hoverTile(s, null); expect(shownTakeId(s)).toBeNull()
    s = chooseTile(s, 't1'); expect(shownTakeId(s)).toBe('t1')
    s = hoverTile(s, CURRENT); expect(shownTakeId(s)).toBeNull()
    s = hoverTile(s, null); expect(shownTakeId(s)).toBe('t1')
    s = chooseTile(s, CURRENT); expect(shownTakeId(s)).toBeNull()
  })

  it('the node\'s wanted active take: the shown tile\'s, else the one it had at open', () => {
    const takes = [take('t0'), take('t1')]
    let s = ingestTakes(queued(), takes)
    expect(wantedActiveTakeId(s, takes)).toBe('t0')
    s = hoverTile(s, 't1'); expect(wantedActiveTakeId(s, takes)).toBe('t1')
    s = hoverTile(s, 'gone'); expect(wantedActiveTakeId(s, takes)).toBe('t0')
  })
})

describe('holding the display after the strip closes', () => {
  const hold = { snap: { images: ['u-t0'], activeTakeId: 't0' }, promptIds: ['p-t2', 'p-t3'] }
  const landed = { images: ['u-t2'], activeTakeId: 't2', takes: [take('t0'), take('t2')] }

  it('a late take from a held run goes into history but the node keeps what it closed on', () => {
    const out = holdOnLanding(landed, take('t2'), 't0', hold)
    expect(out).toMatchObject({ images: ['u-t0'], activeTakeId: 't0' })
    expect(out!.takes.map(t => t.id)).toEqual(['t0', 't2'])
  })

  it('does not apply to other runs, or once the user picked another take', () => {
    expect(holdOnLanding(landed, take('x', 'p-new'), 't0', hold)).toBeNull()
    expect(holdOnLanding(landed, take('t2'), 't9', hold)).toBeNull()
    expect(holdOnLanding(landed, take('t2'), 't0', undefined)).toBeNull()
  })
})

describe('display snapshot', () => {
  const t1 = take('t1')
  const data = { images: ['u-t0'], activeTakeId: 't0', takes: [take('t0'), t1], title: 'Rainy shop' }

  it('projects a take onto the display fields, keeping the takes list and everything else', () => {
    const out = showOnData(data, 't1', displaySnapshot(data))
    expect(out.images).toEqual(['u-t1'])
    expect(out.activeTakeId).toBe('t1')
    expect(out.takes).toBe(data.takes)
    expect(out.title).toBe('Rainy shop')
  })

  it('null restores exactly what was there at open, even with no active take', () => {
    const bare = { images: ['plain'], activeTakeId: null, takes: [t1] }
    const snap = displaySnapshot(bare)
    const moved = showOnData(bare, 't1', snap)
    expect(showOnData(moved, null, snap)).toMatchObject({ images: ['plain'], activeTakeId: null })
  })

  it('an unknown take id restores the snapshot rather than blanking the node', () => {
    const snap = displaySnapshot(data)
    expect(showOnData(data, 'gone', snap).images).toEqual(['u-t0'])
  })
})
