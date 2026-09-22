import { beforeEach, describe, expect, it } from 'vitest'
import { _resetClipboard, extractForCopy, getClipboard, hasClipboard, materializePaste, parseLayersFromOS, serializeLayersForOS, setClipboard } from '../../app/lib/compositor/layerClipboard'

const L = (id: string, x: number, y: number, groupId?: string): any => ({ id, kind: 'rect', x, y, rotation: 0, opacity: 1, w: 0.1, h: 0.1, ...(groupId ? { groupId } : {}) })
const ids = () => { let n = 0; return () => `p${++n}` }
const gids = () => { let n = 0; return () => `pg${++n}` }

describe('extractForCopy', () => {
  it('deep-clones the selected layers + referenced groups', () => {
    const src: any = { ...L('a', 0.2, 0.2, 'g1'), effects: [{ blur: 4 }] }
    const p = extractForCopy([src, L('b', 0.5, 0.5)], [{ id: 'g1', name: 'Row' }, { id: 'gX' }], new Set(['a']))!
    expect(p.layers).toHaveLength(1)
    expect(p.groups).toEqual([{ id: 'g1', name: 'Row' }])
    ;(p.layers[0] as any).effects[0].blur = 99
    expect(src.effects[0].blur).toBe(4) // independent clone
  })
  it('returns null for an empty selection', () => {
    expect(extractForCopy([L('a', 0.2, 0.2)], [], new Set())).toBeNull()
  })
})

describe('materializePaste', () => {
  it('re-ids, offsets in x+y, appends on top, selection = the new ids', () => {
    const payload = { layers: [L('a', 0.2, 0.2)], groups: [] }
    const r = materializePaste(payload, [L('z', 0.9, 0.9)], [], 0.02, ids(), gids())
    expect(r.layers).toHaveLength(2)
    expect(r.newIds).toEqual(['p1'])
    expect(r.layers[1]).toMatchObject({ id: 'p1', x: 0.22, y: 0.22 })
  })
  it('in-place paste (offset 0) keeps position', () => {
    const r = materializePaste({ layers: [L('a', 0.3, 0.3)], groups: [] }, [], [], 0, ids(), gids())
    expect(r.layers[0]).toMatchObject({ x: 0.3, y: 0.3 })
  })
  it('mints one fresh group id per source group and carries its name', () => {
    const payload = { layers: [L('a', 0.2, 0.2, 'g1'), L('b', 0.3, 0.3, 'g1')], groups: [{ id: 'g1', name: 'Row' }] }
    const r = materializePaste(payload, [], [], 0.02, ids(), gids())
    const copies = r.layers
    expect(copies[0].groupId).toBe('pg1')
    expect(copies[1].groupId).toBe('pg1')
    expect(r.groups).toContainEqual({ id: 'pg1', name: 'Row' })
  })
})

describe('clipboard singleton', () => {
  beforeEach(() => _resetClipboard())
  it('set / get / has round-trip', () => {
    expect(hasClipboard()).toBe(false)
    setClipboard({ layers: [L('a', 0.2, 0.2)], groups: [] })
    expect(hasClipboard()).toBe(true)
    expect(getClipboard()!.layers).toHaveLength(1)
  })
  it('an empty payload is not "has"', () => {
    setClipboard({ layers: [], groups: [] })
    expect(hasClipboard()).toBe(false)
  })
})

// ── Wired layers never enter (or leave) the clipboard ────────────────────────
// `slot` is meaningful only inside ONE frame's graph: pasted here it doubles up
// on a live slot, pasted into another frame it points at a completely different
// input. Both ends refuse — extract drops it, and materialize drops it again so
// a payload from an older session (or a hand-built one) cannot smuggle it back.
const WD = (id: string, slot: number): any =>
  ({ id, kind: 'wired', slot, x: 0.4, y: 0.4, rotation: 0, opacity: 1, w: 0.5, lastAspect: 0.75 })

describe('clipboard refuses wired layers', () => {
  it('extractForCopy drops the wired members of a mixed selection', () => {
    const p = extractForCopy([WD('w1', 0), L('a', 0.2, 0.2)], [], new Set(['w1', 'a']))!
    expect(p.layers).toHaveLength(1)
    expect(p.layers[0]!.kind).toBe('rect')
  })
  it('extractForCopy returns null for a wired-only selection', () => {
    expect(extractForCopy([WD('w1', 0)], [], new Set(['w1']))).toBeNull()
  })
  it('materializePaste drops a wired layer smuggled into a payload', () => {
    const r = materializePaste({ layers: [WD('w1', 0), L('a', 0.2, 0.2)], groups: [] }, [], [], 0.02, ids(), gids())
    expect(r.layers).toHaveLength(1)
    expect(r.layers[0]!.kind).toBe('rect')
    expect(r.newIds).toHaveLength(1)
  })
})

// ── OS clipboard serialize / parse (cross-frame / project / session) ─────────
describe('serializeLayersForOS / parseLayersFromOS', () => {
  it('round-trips layers + groups; materialize re-mints ids', () => {
    const src = [L('a', 0.2, 0.2, 'g1'), L('b', 0.3, 0.3, 'g1')]
    const groups = [{ id: 'g1', name: 'Row' }]
    const text = serializeLayersForOS(src, groups)
    const parsed = parseLayersFromOS(text)!
    expect(parsed.layers).toHaveLength(2)
    expect(parsed.groups).toEqual([{ id: 'g1', name: 'Row' }])
    // ids survive parse unchanged — the re-mint boundary is materializePaste
    expect(parsed.layers.map(l => l.id)).toEqual(['a', 'b'])
    const r = materializePaste(parsed, [], [], 0.02, ids(), gids())
    expect(r.newIds).toEqual(['p1', 'p2'])              // re-minted, not 'a'/'b'
    expect(r.layers.map(l => l.id)).not.toContain('a')  // no source id leaks through
    expect(r.layers[0]!.groupId).toBe('pg1')            // group re-minted too
  })
  it('a foreign text paste parses to null', () => {
    expect(parseLayersFromOS('just some copied prose')).toBeNull()
    expect(parseLayersFromOS('https://example.com/x')).toBeNull()
    expect(parseLayersFromOS('{"foo":1}')).toBeNull()          // valid JSON, wrong shape
    expect(parseLayersFromOS('')).toBeNull()
    expect(parseLayersFromOS(null)).toBeNull()
  })
  it('a payload from a newer/older version is refused', () => {
    const good = JSON.parse(serializeLayersForOS([L('a', 0.2, 0.2)]))
    const bumped = JSON.stringify({ ...good, version: good.version + 1 })
    expect(parseLayersFromOS(bumped)).toBeNull()
  })
  it('wired layers never enter the serialized payload', () => {
    const text = serializeLayersForOS([WD('w1', 0), L('a', 0.2, 0.2)], [])
    const env = JSON.parse(text)
    expect(env.payload.layers).toHaveLength(1)
    expect(env.payload.layers[0].kind).toBe('rect')
    // and a hand-forged blob carrying a wired kind still yields no wired on parse
    const forged = JSON.stringify({ ...env, payload: { layers: [WD('w2', 1), L('c', 0.4, 0.4)], groups: [] } })
    const parsed = parseLayersFromOS(forged)!
    expect(parsed.layers.every(l => l.kind !== 'wired')).toBe(true)
  })
  it('a wired-only selection serializes to a payload with no layers → parse null', () => {
    const text = serializeLayersForOS([WD('w1', 0)], [])
    expect(parseLayersFromOS(text)).toBeNull()
  })
  it('round-trips the motion field across the OS clipboard', () => {
    const motion: any = { motionx: [{ path: 'layers.a.opacity', type: 'number', keyframes: [] }], behaviours: [], tracks: [] }
    const text = serializeLayersForOS([L('a', 0.2, 0.2)], [], motion)
    const parsed = parseLayersFromOS(text)!
    expect(parsed.motion?.motionx).toEqual(motion.motionx)
  })
  it('an old payload with no motion field parses with motion left undefined', () => {
    const text = serializeLayersForOS([L('a', 0.2, 0.2)], [])
    const parsed = parseLayersFromOS(text)!
    expect(parsed.motion).toBeUndefined()
  })
})

describe('clipboard motion', () => {
  it('extractForCopy carries the motion aimed at the copied ids, un-remapped', () => {
    const motion = { motionx: [{ path: 'layers.a.opacity', type: 'number', keyframes: [] }, { path: 'layers.b.opacity', type: 'number', keyframes: [] }],
      behaviours: [{ id: 'bh', kind: 'fade', layerId: 'a', timing: { start: 0, duration: 1 } }], tracks: [] }
    const p = extractForCopy([L('a', 0.2, 0.2), L('b', 0.5, 0.5)], [], new Set(['a']), motion as any)!
    expect(p.motion?.motionx.map((t: any) => t.path)).toEqual(['layers.a.opacity'])
    expect(p.motion?.behaviours.map((b: any) => b.id)).toEqual(['bh'])
  })
  it('materializePaste remaps the motion onto the pasted ids', () => {
    const payload: any = { layers: [L('a', 0.2, 0.2)], groups: [],
      motion: { motionx: [{ path: 'layers.a.opacity', type: 'number', keyframes: [], behaviourId: 'bh' }],
        behaviours: [{ id: 'bh', kind: 'fade', layerId: 'a', timing: { start: 0, duration: 1 } }], tracks: [] } }
    const r = materializePaste(payload, [], [], 0.02, ids(), gids(), () => 'nb1')
    expect(r.motion.motionx[0]).toMatchObject({ path: 'layers.p1.opacity', behaviourId: 'nb1' })
    expect(r.motion.behaviours[0]).toMatchObject({ id: 'nb1', layerId: 'p1' })
  })
  it('an old payload without motion pastes with empty motion', () => {
    const r = materializePaste({ layers: [L('a', 0.2, 0.2)], groups: [] } as any, [], [], 0.02, ids(), gids(), () => 'nb1')
    expect(r.motion).toEqual({ motionx: [], behaviours: [], tracks: [] })
  })
})
