import { describe, it, expect } from 'vitest'
import {
  getByIdPath, indexOfId, parseIdPath, resolveIdPath, setByIdPath, toIdPath,
} from '../../app/lib/studio/idPath'

const cfg = () => ({
  appearance: [
    { id: 'La', kind: 'fill', opacity: 1, paint: { color: '#f00' } },
    { id: 'Lb', kind: 'stroke', opacity: 0.5, paint: { color: '#0f0' } },
    { id: 'Lc', kind: 'extrude', opacity: 0.25, paint: { color: '#00f' } },
  ],
  duration: 3,
})

describe('parseIdPath', () => {
  it('splits list / member / rest', () => {
    expect(parseIdPath('appearance.Lb.paint.color'))
      .toEqual({ list: 'appearance', key: 'Lb', rest: 'paint.color', positional: false })
  })
  it('flags a numeric member segment as positional', () => {
    expect(parseIdPath('appearance.1.opacity')?.positional).toBe(true)
  })
  it('rejects a path with no member segment', () => {
    expect(parseIdPath('appearance')).toBeUndefined()
    expect(parseIdPath('')).toBeUndefined()
  })
})

describe('resolveIdPath', () => {
  it('resolves an id to its current position', () => {
    expect(resolveIdPath(cfg(), 'appearance.Lb.paint.color')).toBe('appearance.1.paint.color')
    expect(resolveIdPath(cfg(), 'appearance.Lc.opacity')).toBe('appearance.2.opacity')
  })
  it('resolves a bare member path', () => {
    expect(resolveIdPath(cfg(), 'appearance.La')).toBe('appearance.0')
  })

  it('is a NO-OP across reorder — the id follows its layer', () => {
    const c = cfg()
    expect(resolveIdPath(c, 'appearance.La.opacity')).toBe('appearance.0.opacity')
    // Move layer 0 to the end: [Lb, Lc, La].
    const [moved] = c.appearance.splice(0, 1)
    c.appearance.push(moved!)
    // The SAME id path now resolves to the new slot. Nothing had to be remapped.
    expect(resolveIdPath(c, 'appearance.La.opacity')).toBe('appearance.2.opacity')
    expect(getByIdPath(c, 'appearance.La.opacity')).toBe(1)
    expect(getByIdPath(c, 'appearance.La.paint.color')).toBe('#f00')
  })

  // ── failure modes: undefined, never a fabricated index ────────────────────
  it('returns undefined for an unknown id', () => {
    expect(resolveIdPath(cfg(), 'appearance.NOPE.opacity')).toBeUndefined()
  })
  it('returns undefined for a well-formed path whose layer was deleted', () => {
    const c = cfg()
    expect(resolveIdPath(c, 'appearance.Lb.opacity')).toBe('appearance.1.opacity')
    c.appearance.splice(1, 1)
    expect(resolveIdPath(c, 'appearance.Lb.opacity')).toBeUndefined()
    // …and specifically NOT the layer that slid into slot 1.
    expect(resolveIdPath(c, 'appearance.Lb.opacity')).not.toBe('appearance.1.opacity')
  })
  it('returns undefined for an empty list', () => {
    expect(resolveIdPath({ appearance: [] }, 'appearance.La.opacity')).toBeUndefined()
  })
  it('returns undefined for a missing or non-array list', () => {
    expect(resolveIdPath({}, 'appearance.La.opacity')).toBeUndefined()
    expect(resolveIdPath({ appearance: { La: {} } }, 'appearance.La.opacity')).toBeUndefined()
    expect(resolveIdPath(null, 'appearance.La.opacity')).toBeUndefined()
  })
  it('never returns an index for an unknown id, whatever the list length', () => {
    for (const n of [0, 1, 2, 5]) {
      const c = { appearance: Array.from({ length: n }, (_, i) => ({ id: `X${i}` })) }
      expect(resolveIdPath(c, 'appearance.GHOST.opacity')).toBeUndefined()
    }
  })

  it('passes an in-range positional path through unchanged', () => {
    expect(resolveIdPath(cfg(), 'appearance.1.opacity')).toBe('appearance.1.opacity')
  })
  it('rejects an out-of-range positional path', () => {
    expect(resolveIdPath(cfg(), 'appearance.9.opacity')).toBeUndefined()
  })

  it('resolves duplicate ids to the lowest index (the member that held it first)', () => {
    const c = { appearance: [{ id: 'La', tag: 'original' }, { id: 'La', tag: 'clone' }] }
    expect(resolveIdPath(c, 'appearance.La.tag')).toBe('appearance.0.tag')
    expect(getByIdPath(c, 'appearance.La.tag')).toBe('original')
  })

  it('honours a custom id key (Shader\'s stack uses layerId)', () => {
    const c = { effects: [{ layerId: 'E1' }, { layerId: 'E2' }] }
    expect(resolveIdPath(c, 'effects.E2.params.u_size', 'layerId')).toBe('effects.1.params.u_size')
    // With the default key the same path is unresolvable — not slot 0.
    expect(resolveIdPath(c, 'effects.E2.params.u_size')).toBeUndefined()
  })
})

describe('indexOfId', () => {
  it('returns undefined rather than -1 for an unknown id', () => {
    expect(indexOfId(cfg(), 'appearance', 'NOPE')).toBeUndefined()
    expect(indexOfId(cfg(), 'appearance', 'Lc')).toBe(2)
  })
})

describe('toIdPath', () => {
  it('converts a positional path back to an id path', () => {
    expect(toIdPath(cfg(), 'appearance.1.paint.color')).toBe('appearance.Lb.paint.color')
  })
  it('returns undefined for an out-of-range index', () => {
    expect(toIdPath(cfg(), 'appearance.9.opacity')).toBeUndefined()
  })
  it('returns undefined when the member carries no usable id', () => {
    expect(toIdPath({ appearance: [{}] }, 'appearance.0.opacity')).toBeUndefined()
    expect(toIdPath({ appearance: [{ id: '' }] }, 'appearance.0.opacity')).toBeUndefined()
  })
  it('returns undefined for a path that is already id-addressed', () => {
    expect(toIdPath(cfg(), 'appearance.Lb.opacity')).toBeUndefined()
  })
  it('round-trips through resolveIdPath', () => {
    const c = cfg()
    const idPath = toIdPath(c, 'appearance.2.opacity')!
    expect(resolveIdPath(c, idPath)).toBe('appearance.2.opacity')
  })
})

describe('setByIdPath', () => {
  it('writes through a resolvable id path', () => {
    const c = cfg()
    expect(setByIdPath(c, 'appearance.Lb.opacity', 0.9)).toBe(true)
    expect(c.appearance[1]!.opacity).toBe(0.9)
  })
  it('writes an absent leaf whose parent exists', () => {
    const c = cfg()
    expect(setByIdPath(c, 'appearance.La.paint.stops', 4)).toBe(true)
    expect((c.appearance[0]!.paint as any).stops).toBe(4)
  })
  it('refuses an unknown id and grows NO junk into the config', () => {
    const c = cfg()
    const before = JSON.stringify(c)
    expect(setByIdPath(c, 'appearance.NOPE.opacity', 0.9)).toBe(false)
    expect(JSON.stringify(c)).toBe(before)
    expect((c as any).appearance.NOPE).toBeUndefined()
  })
  it('refuses a deleted layer instead of writing to its replacement', () => {
    const c = cfg()
    c.appearance.splice(1, 1) // Lb gone; Lc slides into slot 1
    expect(setByIdPath(c, 'appearance.Lb.opacity', 0.9)).toBe(false)
    expect(c.appearance[1]!.opacity).toBe(0.25) // Lc untouched
  })
  it('refuses when the leaf\'s parent container is missing', () => {
    const c = cfg()
    expect(setByIdPath(c, 'appearance.La.extrude.depth', 3)).toBe(false)
    expect((c.appearance[0] as any).extrude).toBeUndefined()
  })
})

describe('getByIdPath', () => {
  it('returns undefined for an unknown id', () => {
    expect(getByIdPath(cfg(), 'appearance.NOPE.opacity')).toBeUndefined()
  })
})

describe('nested id lists (objects.<id>.treatments.<tid>.<dial>)', () => {
  const nested = () => ({
    objects: [
      { id: 'A', treatments: [{ id: 't1', kind: 'blur', amount: 0.2 }, { id: 't2', kind: 'fade', opacity: 0.5 }] },
      { id: 'B' },
    ],
  })
  it('resolves an id inside a nested list to its positional index', () => {
    expect(resolveIdPath(nested(), 'objects.A.treatments.t2.opacity')).toBe('objects.0.treatments.1.opacity')
  })
  it('refuses an unknown nested id rather than fabricating a key on the array', () => {
    expect(resolveIdPath(nested(), 'objects.A.treatments.zzz.opacity')).toBeUndefined()
    const cfg = nested()
    expect(setByIdPath(cfg, 'objects.A.treatments.zzz.opacity', 1)).toBe(false)
    expect(cfg).toEqual(nested())
  })
  it('reads and writes through the nested id', () => {
    const cfg = nested()
    expect(getByIdPath(cfg, 'objects.A.treatments.t1.amount')).toBe(0.2)
    expect(setByIdPath(cfg, 'objects.A.treatments.t1.amount', 0.9)).toBe(true)
    expect(cfg.objects[0]!.treatments![0]!.amount).toBe(0.9)
  })
  it('a nested path on an object with no list refuses', () => {
    expect(resolveIdPath(nested(), 'objects.B.treatments.t1.amount')).toBeUndefined()
  })
  it('an out-of-range positional index inside the rest refuses', () => {
    expect(resolveIdPath(nested(), 'objects.A.treatments.5.amount')).toBeUndefined()
  })
  it('a missing plain (non-array) intermediate is still appended as written', () => {
    expect(resolveIdPath(nested(), 'objects.B.material.roughness')).toBe('objects.1.material.roughness')
  })
})
