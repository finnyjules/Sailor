import { describe, expect, it } from 'vitest'
import {
  checkHygiene, faceRefHygiene, garmentHygiene, healRefImages, parseCharacterRecord, photoHygiene,
  sanitizeBodyShape, slugifyCharacterName, stateHygiene, validRefFilename, voiceHygiene,
  type CharacterRecord,
  type CharacterState,
} from '~~/server/utils/characterRegistry'

function V(over: Partial<CharacterState> = {}): CharacterState {
  return {
    id: 'default', label: 'Default', descriptor: '', refImages: ['a.png'], coverIndex: 0,
    panels: [], sheetImage: null, clothes: [], face: null, status: 'draft', stressResult: null, updatedAt: '', ...over,
  }
}

function rec(over: Partial<CharacterRecord> = {}): CharacterRecord {
  return {
    name: 'Reva', slug: 'reva', states: [V()],
    loraName: null, trigger: null, bodyShape: null, notes: '', createdAt: 't', updatedAt: 't',
    face: null, photos: [], voice: null, origin: 'photos', likenessConfirmed: false, style: 'photo', linkedFrom: null,
    ...over,
  }
}

describe('slugifyCharacterName', () => {
  it('lowercases, hyphenates, strips unsafe chars', () => {
    expect(slugifyCharacterName('Reva Marlowe')).toBe('reva-marlowe')
    expect(slugifyCharacterName('  Dr. Núñez!  ')).toBe('dr-nunez')
  })
  it('returns empty for names with no usable chars', () => {
    expect(slugifyCharacterName('///')).toBe('')
  })
})

describe('parseCharacterRecord', () => {
  it('parses a full record and trusts the given slug over the file field', () => {
    const raw = JSON.stringify(rec({ slug: 'stale-slug' }))
    expect(parseCharacterRecord(raw, 'reva')?.slug).toBe('reva')
  })
  it('defaults missing fields (old/partial records hydrate safely)', () => {
    const r = parseCharacterRecord('{"name":"X"}', 'x')
    expect(r).toMatchObject({ name: 'X', slug: 'x', states: [{ id: 'default', label: 'Default', descriptor: '', refImages: [], coverIndex: 0 }], loraName: null, notes: '' })
  })
  it('returns null for non-objects and invalid JSON', () => {
    expect(parseCharacterRecord('null', 'x')).toBeNull()
    expect(parseCharacterRecord('{bad', 'x')).toBeNull()
  })
  it('drops non-string and path-escaping ref filenames on parse', () => {
    const raw = JSON.stringify({ name: 'X', refImages: ['ok.png', '../evil.png', 5, 'sub/dir.png'] })
    expect(parseCharacterRecord(raw, 'x')?.states[0]!.refImages).toEqual(['ok.png'])
  })
  it('legacy records with no bodyShape field default it to null', () => {
    const raw = JSON.stringify({ name: 'X', refImages: [] })
    expect(parseCharacterRecord(raw, 'x')?.bodyShape).toBeNull()
  })
  it('clamps bodyShape values to [0,1] and drops unknown keys on parse', () => {
    const raw = JSON.stringify(rec({ bodyShape: { frame: 0.5, height: -1, build: 2, notASlider: 0.9 } }))
    expect(parseCharacterRecord(raw, 'reva')?.bodyShape).toEqual({ frame: 0.5, height: 0, build: 1 })
  })
})

describe('sanitizeBodyShape', () => {
  it('non-object (incl. null/array/undefined) → null', () => {
    expect(sanitizeBodyShape(null)).toBeNull()
    expect(sanitizeBodyShape(undefined)).toBeNull()
    expect(sanitizeBodyShape('nope')).toBeNull()
    expect(sanitizeBodyShape([0.5])).toBeNull()
  })
  it('clamps out-of-range values to [0,1]', () => {
    expect(sanitizeBodyShape({ frame: -0.5, hips: 1.5 })).toEqual({ frame: 0, hips: 1 })
  })
  it('drops unknown keys and non-numeric values', () => {
    expect(sanitizeBodyShape({ frame: 0.6, madeUp: 0.4, waist: 'huge', muscle: Number.NaN }))
      .toEqual({ frame: 0.6 })
  })
  it('an empty valid object stays an empty object, not null', () => {
    expect(sanitizeBodyShape({})).toEqual({})
  })
})

describe('validRefFilename', () => {
  it('accepts plain filenames, rejects traversal/separators/empty', () => {
    expect(validRefFilename('char-reva_1.png')).toBe(true)
    expect(validRefFilename('../x.png')).toBe(false)
    expect(validRefFilename('a/b.png')).toBe(false)
    expect(validRefFilename('a\\b.png')).toBe(false)
    expect(validRefFilename('')).toBe(false)
  })
})

describe('healRefImages', () => {
  it('drops refs whose file is gone and clamps coverIndex in each state', () => {
    const { record, dropped } = healRefImages(rec({ states: [V({ refImages: ['a.png', 'b.png'], coverIndex: 1 })] }), f => f === 'b.png')
    expect(record.states[0]!.refImages).toEqual(['b.png'])
    expect(record.states[0]!.coverIndex).toBe(0)
    expect(dropped).toBe(1)
  })
  it('no-ops when all files exist', () => {
    const { record, dropped } = healRefImages(rec({ states: [V({ refImages: ['a.png', 'b.png'] })] }), () => true)
    expect(record.states[0]!.refImages).toEqual(['a.png', 'b.png'])
    expect(dropped).toBe(0)
  })
})

describe('state migration', () => {
  it('legacy top-level refImages hydrate into a Default state', () => {
    const raw = JSON.stringify({ name: 'X', refImages: ['a.png', 'b.png'], coverIndex: 1 })
    const r = parseCharacterRecord(raw, 'x')!
    expect(r.states).toEqual([V({ refImages: ['a.png', 'b.png'], coverIndex: 1 })])
    expect(r).not.toHaveProperty('refImages')
  })
  it('records with neither shape get one empty Default state', () => {
    expect(parseCharacterRecord('{"name":"X"}', 'x')!.states).toEqual([
      V({ refImages: [] }),
    ])
  })
  it('state refs are hygiene-filtered and coverIndex clamped per state', () => {
    const raw = JSON.stringify({ name: 'X', variants: [
      { id: 'default', label: 'Default', descriptor: '', refImages: ['ok.png', '../evil.png'], coverIndex: 5 },
      { id: 'v1', label: 'Raincoat', descriptor: 'yellow raincoat', refImages: ['r.png'], coverIndex: 0 },
    ] })
    const r = parseCharacterRecord(raw, 'x')!
    expect(r.states[0]!.refImages).toEqual(['ok.png'])
    expect(r.states[0]!.coverIndex).toBe(0)
    expect(r.states[1]!.label).toBe('Raincoat')
  })
  it('a default state is always present and first', () => {
    const raw = JSON.stringify({ name: 'X', variants: [{ id: 'v1', label: 'B', descriptor: '', refImages: [], coverIndex: 0 }] })
    const r = parseCharacterRecord(raw, 'x')!
    expect(r.states[0]!.id).toBe('default')
    expect(r.states).toHaveLength(2)
  })
})

describe('healRefImages across states', () => {
  it('drops vanished refs in every state and reports the total', () => {
    const record = parseCharacterRecord(JSON.stringify({ name: 'X', variants: [
      V({ refImages: ['a.png', 'b.png'], coverIndex: 1 }),
      V({ id: 'v1', label: 'Alt', refImages: ['c.png'] }),
    ] }), 'x')!
    const { record: healed, dropped } = healRefImages(record, f => f === 'b.png')
    expect(healed.states[0]!.refImages).toEqual(['b.png'])
    expect(healed.states[0]!.coverIndex).toBe(0)
    expect(healed.states[1]!.refImages).toEqual([])
    // 2 from refImages, plus 2 more from the derived character-level photos
    // (union of every state's refs) that also vanish — a.png and c.png.
    expect(dropped).toBe(4)
  })
})

describe('three-era migration', () => {
  it('migrates era-1 legacy top-level refImages into a default draft state', () => {
    const rec = parseCharacterRecord(JSON.stringify({ name: 'Cal', refImages: ['a.png'], coverIndex: 0 }), 'cal')!
    expect(rec.states).toHaveLength(1)
    expect(rec.states[0]).toMatchObject({
      id: 'default', refImages: ['a.png'], panels: [], sheetImage: null, status: 'draft', stressResult: null,
    })
  })

  it('migrates era-2 variants into draft states, preserving descriptor/refs/cover', () => {
    const rec = parseCharacterRecord(JSON.stringify({
      name: 'Cal',
      variants: [
        { id: 'default', label: 'Default', descriptor: '', refImages: ['a.png', 'b.png'], coverIndex: 1 },
        { id: 'wet', label: 'Wet', descriptor: 'soaked jacket', refImages: ['w.png'], coverIndex: 0 },
      ],
    }), 'cal')!
    expect(rec.states.map(s => s.id)).toEqual(['default', 'wet'])
    expect(rec.states[1]).toMatchObject({ descriptor: 'soaked jacket', status: 'draft', panels: [], sheetImage: null })
  })

  it('parses era-3 states natively, dropping invalid panels and unknown statuses', () => {
    const rec = parseCharacterRecord(JSON.stringify({
      name: 'Cal',
      states: [{
        id: 'default', label: 'Default', descriptor: '', refImages: [], coverIndex: 0,
        panels: [{ slot: 'portrait', filename: 'p.png' }, { slot: 'nope', filename: 'x.png' }, { slot: 'body-front', filename: '../evil' }],
        sheetImage: 'sheet.png', status: 'locked', stressResult: { passes: 10, total: 10, at: 't' }, updatedAt: 'u',
      }],
    }), 'cal')!
    expect(rec.states[0]!.panels).toEqual([{ slot: 'portrait', filename: 'p.png' }])
    expect(rec.states[0]!.status).toBe('locked')
    const bad = parseCharacterRecord(JSON.stringify({
      name: 'Cal', states: [{ id: 'default', label: 'D', refImages: [], coverIndex: 0, panels: [], sheetImage: null, status: 'gold', stressResult: null }],
    }), 'cal')!
    expect(bad.states[0]!.status).toBe('draft')
  })

  it('healRefImages heals panels and demotes a locked state whose sheet vanished', () => {
    const rec = parseCharacterRecord(JSON.stringify({
      name: 'Cal',
      states: [{
        id: 'default', label: 'D', descriptor: '', refImages: ['a.png', 'gone.png'], coverIndex: 1,
        panels: [{ slot: 'portrait', filename: 'p.png' }, { slot: 'body-back', filename: 'gone2.png' }],
        sheetImage: 'gone3.png', status: 'locked', stressResult: { passes: 10, total: 10, at: 't' }, updatedAt: '',
      }],
    }), 'cal')!
    const { record, dropped } = healRefImages(rec, f => !f.startsWith('gone'))
    // 3 from this state's own refs/panel/sheet, plus 2 more from the derived
    // character-level photos and face (both built from this same state's
    // refs, since no top-level photos/face were stored) also vanishing.
    expect(dropped).toBe(5)
    const s = record.states[0]!
    expect(s.refImages).toEqual(['a.png'])
    expect(s.panels).toEqual([{ slot: 'portrait', filename: 'p.png' }])
    expect(s.sheetImage).toBe(null)
    expect(s.status).toBe('draft')   // locked promise broken — back to draft
  })
})

describe('rework field hygiene', () => {
  it('checkHygiene keeps a well-formed check and drops junk', () => {
    expect(checkHygiene({ verdict: 'match', score: 97.2, against: 'f.png', at: 't' }))
      .toEqual({ verdict: 'match', score: 97.2, against: 'f.png', at: 't' })
    expect(checkHygiene({ verdict: 'nope', against: 'f.png', at: 't' })).toBeNull()
    expect(checkHygiene({ verdict: 'match', against: '../x', at: 't' })).toBeNull()
    expect(checkHygiene({ verdict: 'unsure', score: 250, against: 'f.png', at: 't' })!.score).toBe(100)
    expect(checkHygiene(null)).toBeNull()
  })
  it('faceRefHygiene needs a safe filename', () => {
    expect(faceRefHygiene({ filename: 'f.png', approvedAt: 't' })).toEqual({ filename: 'f.png', approvedAt: 't' })
    expect(faceRefHygiene({ filename: 'a/b.png' })).toBeNull()
  })
  it('photoHygiene keeps check and a clamped crop', () => {
    expect(photoHygiene({ filename: 'p.png', check: null, crop: { x: -1, y: 0.2, w: 0.5, h: 2 } }))
      .toEqual({ filename: 'p.png', check: null, crop: { x: 0, y: 0.2, w: 0.5, h: 1 } })
    expect(photoHygiene({ filename: '' })).toBeNull()
  })
  it('garmentHygiene needs id, filename and a name', () => {
    expect(garmentHygiene({ id: 'g1', filename: 'coat.png', name: 'Green waxed raincoat' }))
      .toEqual({ id: 'g1', filename: 'coat.png', name: 'Green waxed raincoat' })
    expect(garmentHygiene({ id: 'g1', filename: 'coat.png', name: '  ' })).toBeNull()
  })
  it('voiceHygiene accepts stock and trained voices only', () => {
    expect(voiceHygiene({ kind: 'stock', id: 'warm', label: 'Warm, low' })).toEqual({ kind: 'stock', id: 'warm', label: 'Warm, low' })
    expect(voiceHygiene({ kind: 'cloned', id: 'x', label: 'x' })).toBeNull()
  })
  it('stateHygiene carries clothes, look face and panel checks', () => {
    const s = stateHygiene({
      id: 'default', label: 'Everyday',
      clothes: [{ id: 'g1', filename: 'coat.png', name: 'Raincoat' }, { id: 'bad' }],
      face: { filename: 'heavier.png', approvedAt: 't' },
      panels: [{ slot: 'portrait', filename: 'p.png', check: { verdict: 'match', score: 99, against: 'f.png', at: 't' },
        madeFrom: { face: 'f.png', clothesKey: 'g1', bodyKey: '', model: 'gpt-image-2.5-sunburst' } }],
    })!
    expect(s.clothes).toEqual([{ id: 'g1', filename: 'coat.png', name: 'Raincoat' }])
    expect(s.face).toEqual({ filename: 'heavier.png', approvedAt: 't' })
    expect(s.panels[0]!.check!.verdict).toBe('match')
    expect(s.panels[0]!.madeFrom!.model).toBe('gpt-image-2.5-sunburst')
  })
  it('stateHygiene gives an old look empty clothes and no face', () => {
    const s = stateHygiene({ id: 'default', label: 'Default', panels: [{ slot: 'portrait', filename: 'p.png' }] })!
    expect(s.clothes).toEqual([])
    expect(s.face).toBeNull()
    expect(s.panels[0]!.check ?? null).toBeNull()
  })
})

describe('read-time conversion for the rework', () => {
  const era2 = JSON.stringify({
    name: 'Jene',
    variants: [
      { id: 'default', label: 'Default', refImages: ['a.png', 'b.png'], coverIndex: 1 },
      { id: 'wet', label: 'Wet', refImages: ['b.png', 'c.png'], coverIndex: 0 },
    ],
  })
  it('builds character photos from every look, default first, without duplicates', () => {
    const r = parseCharacterRecord(era2, 'jene')!
    expect(r.photos.map(p => p.filename)).toEqual(['a.png', 'b.png', 'c.png'])
    expect(r.photos.every(p => p.check === null)).toBe(true)
  })
  it('takes the face from the default look\'s cover', () => {
    expect(parseCharacterRecord(era2, 'jene')!.face).toEqual({ filename: 'b.png', approvedAt: '' })
  })
  it('defaults origin to photos, likeness unconfirmed, no voice, photo style, not linked', () => {
    const r = parseCharacterRecord(era2, 'jene')!
    expect(r.origin).toBe('photos')
    expect(r.likenessConfirmed).toBe(false)
    expect(r.voice).toBeNull()
    expect(r.style).toBe('photo')
    expect(r.linkedFrom).toBeNull()
  })
  it('keeps an anime style and a valid link, drops a junk link', () => {
    const anime = parseCharacterRecord(JSON.stringify({ name: 'Aiko', style: 'anime', linkedFrom: 'reva', states: [] }), 'aiko')!
    expect(anime.style).toBe('anime')
    expect(anime.linkedFrom).toBe('reva')
    const junk = parseCharacterRecord(JSON.stringify({ name: 'X', style: 'watercolour', linkedFrom: '../evil', states: [] }), 'x')!
    expect(junk.style).toBe('photo')
    expect(junk.linkedFrom).toBeNull()
  })
  it('keeps stored rework fields as they are', () => {
    const r = parseCharacterRecord(JSON.stringify({
      name: 'Maren', origin: 'described', likenessConfirmed: false,
      face: { filename: 'f.png', approvedAt: '2026-09-27T00:00:00.000Z' },
      photos: [{ filename: 'f.png', check: { verdict: 'match', score: 100, against: 'f.png', at: 't' } }],
      voice: { kind: 'stock', id: 'warm', label: 'Warm, low' },
      states: [{ id: 'default', label: 'Everyday', refImages: [] }],
    }), 'maren')!
    expect(r.origin).toBe('described')
    expect(r.face!.filename).toBe('f.png')
    expect(r.photos[0]!.check!.verdict).toBe('match')
    expect(r.voice!.id).toBe('warm')
  })
  it('a character with no photos at all has no face', () => {
    const r = parseCharacterRecord(JSON.stringify({ name: 'X', states: [{ id: 'default', label: 'D', refImages: [] }] }), 'x')!
    expect(r.face).toBeNull()
    expect(r.photos).toEqual([])
  })
})

describe('healRefImages for rework fields', () => {
  it('drops vanished photos, clothes and faces', () => {
    const r = parseCharacterRecord(JSON.stringify({
      name: 'R', face: { filename: 'gone-face.png', approvedAt: '' },
      photos: [{ filename: 'keep.png' }, { filename: 'gone.png' }],
      states: [{ id: 'default', label: 'D', refImages: ['keep.png'],
        clothes: [{ id: 'g', filename: 'gone-coat.png', name: 'Coat' }], face: { filename: 'gone-look.png', approvedAt: '' } }],
    }), 'r')!
    const { record, dropped } = healRefImages(r, f => f === 'keep.png')
    expect(record.photos.map(p => p.filename)).toEqual(['keep.png'])
    expect(record.face).toBeNull()
    expect(record.states[0]!.clothes).toEqual([])
    expect(record.states[0]!.face).toBeNull()
    expect(dropped).toBe(4)
  })
})
