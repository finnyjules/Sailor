import { describe, it, expect } from 'vitest'
import {
  CURRENT, chooseTile, displaySnapshot, failPending, hoverTile, ingestTakes, isTakesWorking, openTakes,
  readyCount, settleExpected, shownTakeId, showOnData, takesStatus, TAKES_PER_SET,
} from '~/lib/prompt/takesSession'
import type { Take } from '~/composables/useTakes'

const take = (id: string, promptId: string | null = `p-${id}`, img = `u-${id}`): Take => ({ id, createdAt: 0, promptId, images: [img] })
const open = () => openTakes({ nodeId: 'n1', nodeLabel: 'Rainy shop', request: '', takes: [take('t0')], images: ['u-t0'] })

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

  it('fills tiles one by one in arrival order, ignoring takes that were already there', () => {
    let s = open()
    s = ingestTakes(s, [take('t0'), take('t1')])
    expect(s.tiles.map(t => t.state)).toEqual(['ready', 'pending', 'pending'])
    expect(s.tiles[0]).toEqual({ state: 'ready', takeId: 't1', promptId: 'p-t1', thumb: 'u-t1' })
    expect(takesStatus(s)).toBe('1 of 3 ready')
    s = ingestTakes(s, [take('t0'), take('t1'), take('t2'), take('t3')])
    expect(readyCount(s)).toBe(3)
    expect(isTakesWorking(s)).toBe(false)
    expect(takesStatus(s)).toBe('Three takes · hover to preview, Keep one')
  })

  it('returns the same object when nothing new arrived (so watchers can skip)', () => {
    const s = ingestTakes(open(), [take('t0'), take('t1')])
    expect(ingestTakes(s, [take('t0'), take('t1')])).toBe(s)
  })

  it('a re-emission of the same run (same promptId, new take id) refreshes its tile instead of filling another', () => {
    let s = ingestTakes(open(), [take('t0'), take('t1', 'p1')])
    s = ingestTakes(s, [take('t0'), take('t1b', 'p1', 'u-new')])
    expect(s.tiles[0]).toEqual({ state: 'ready', takeId: 't1b', promptId: 'p1', thumb: 'u-new' })
    expect(s.tiles[1]!.state).toBe('pending')
  })

  it('ignores takes with nothing to show', () => {
    const s = open()
    expect(ingestTakes(s, [{ id: 'x', createdAt: 0, promptId: 'px', text: 'hi' }])).toBe(s)
  })

  it('fewer runs queued than asked marks the rest failed; a failed run fails what is pending', () => {
    let s = ingestTakes(open(), [take('t1')])
    s = settleExpected(s, 2)
    expect(s.tiles.map(t => t.state)).toEqual(['ready', 'pending', 'failed'])
    s = failPending(s)
    expect(s.tiles.map(t => t.state)).toEqual(['ready', 'failed', 'failed'])
    expect(isTakesWorking(s)).toBe(false)
    expect(takesStatus(s)).toBe('One of three came back · hover to preview, Keep one')
    expect(takesStatus(failPending(open()))).toBe('No takes came back')
  })

  it('shows the hovered tile, else the chosen one, else the version at open', () => {
    let s = ingestTakes(open(), [take('t1'), take('t2')])
    expect(shownTakeId(s)).toBeNull()
    s = hoverTile(s, 't2'); expect(shownTakeId(s)).toBe('t2')
    s = hoverTile(s, null); expect(shownTakeId(s)).toBeNull()
    s = chooseTile(s, 't1'); expect(shownTakeId(s)).toBe('t1')
    s = hoverTile(s, CURRENT); expect(shownTakeId(s)).toBeNull()
    s = hoverTile(s, null); expect(shownTakeId(s)).toBe('t1')
    s = chooseTile(s, CURRENT); expect(shownTakeId(s)).toBeNull()
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
