import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { ringEffect } from '~/lib/spacetype/effects/ring'
import { defaultsFromControls } from '~/lib/spacetype/effect'

function imageParams(n: number) {
  const items = Array.from({ length: n }, (_, i) => ({ id: `i${i}`, kind: 'image', src: `data:${i}` }))
  return { ...defaultsFromControls(ringEffect.controls), content: JSON.stringify(items) }
}

describe('ringEffect', () => {
  it('builds one quad per image tile', () => {
    const params = imageParams(6)
    const env = { width: 960, height: 540, imageTextures: new Map() }
    const root = ringEffect.buildScene(THREE, params, new THREE.Texture(), env)
    const st = (root as any).userData.ringState
    expect(st.quads).toHaveLength(6)
  })

  it('update places quads on the ring radius', () => {
    const params = imageParams(4)
    const root = ringEffect.buildScene(THREE, params, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() })
    ringEffect.update!(0, params, root)
    const st = (root as any).userData.ringState
    const r = Number(params.radius)
    for (const q of st.quads) {
      expect(Math.hypot(q.position.x, q.position.z)).toBeCloseTo(r, 4)
    }
  })

  it('loopRates reports the true speed, fractions included (the engine closes them over k loops)', () => {
    expect(ringEffect.loopRates!({ ...defaultsFromControls(ringEffect.controls), speed: 3 })).toEqual([3])
    expect(ringEffect.loopRates!({ ...defaultsFromControls(ringEffect.controls), speed: 0.25 })).toEqual([0.25])
    expect(ringEffect.loopRates!({ ...defaultsFromControls(ringEffect.controls), speed: 0 })).toEqual([])
  })

  it('repeater duplicates tiles around the ring', () => {
    const items = [
      { id: 'i0', kind: 'image', src: 'data:0' },
      { id: 'i1', kind: 'image', src: 'data:1' },
    ]
    const params = { ...defaultsFromControls(ringEffect.controls), content: JSON.stringify(items), repeat: 3 }
    const root = ringEffect.buildScene(THREE, params, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() })
    expect((root as any).userData.ringState.quads).toHaveLength(6)
  })

  it('is registered in the effect list', async () => {
    const { SPACE_TYPE_EFFECTS } = await import('~/lib/spacetype/effects/index')
    expect(SPACE_TYPE_EFFECTS.some(e => e.id === 'ring')).toBe(true)
  })

  it('bend builds and updates without error', () => {
    const items = [{ id: 'i0', kind: 'image', src: 'data:0' }, { id: 'i1', kind: 'image', src: 'data:1' }]
    const params = { ...defaultsFromControls(ringEffect.controls), content: JSON.stringify(items), bend: 1 }
    const root = ringEffect.buildScene(THREE, params, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() })
    expect(() => ringEffect.update!(0.25, params, root)).not.toThrow()
    expect((root as any).userData.ringState.quads).toHaveLength(2)
  })

  it('renders finite (no NaN) for a pre-tuneup doc missing the new keys', () => {
    const legacy = {
      content: JSON.stringify([{ id: 'i0', kind: 'image', src: 'data:0' }, { id: 'i1', kind: 'image', src: 'data:1' }]),
      radius: 5, ringTilt: -0.28, cardSize: 1.4, perspective: 0.4, speed: 1, direction: 'cw',
    }
    const root = ringEffect.buildScene(THREE, legacy as any, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() })
    ringEffect.update!(0.25, legacy as any, root)
    expect(Number.isFinite(root.rotation.x)).toBe(true)
    expect(Number.isFinite(root.rotation.z)).toBe(true)
    for (const q of (root as any).userData.ringState.quads) {
      expect(Number.isFinite(q.scale.x)).toBe(true)
      const pos = (q.geometry.attributes.position as any).array as Float32Array
      expect(pos.every((v: number) => Number.isFinite(v))).toBe(true)
    }
  })

  // Global word type controls (font/typeWeight/typeYScale/tracking — see
  // docs/superpowers/specs/2026-08-07-ring-word-type-controls-design.md). `layoutChars`
  // (word/letter tile rasterisation) calls `document.createElement('canvas')`, which
  // throws under this suite's `node` test environment (no jsdom/happy-dom, no canvas
  // polyfill — confirmed empirically: `document` is undefined here). So these tests use
  // IMAGE content (whose tile path never calls layoutChars) to exercise the actual code
  // under test — buildScene's unconditional `resolveFontFamily`/`fontHasWeightAxis`
  // resolution of the new params, which runs once before the tile loop regardless of
  // tile kind — without hitting the canvas ReferenceError. This still proves: (a) the
  // new controls don't crash buildScene when set to non-default values, (b) quad count
  // is unaffected by the type controls, and (c) legacy docs missing the keys fall back
  // to RING_DEFAULTS instead of producing NaN. `typeColor` is no longer a real control
  // (superseded by `wordFill`, Task 2) but is still set here as a LEGACY key: it exercises
  // `resolveWordFill`'s migration fallback (a pre-wordFill doc keeps its saved colour) —
  // still only through the unconditional pre-loop resolution, since these are image tiles.
  it('non-default type controls + legacy typeColor build without throwing', () => {
    const items = [{ id: 'i0', kind: 'image', src: 'data:0' }, { id: 'i1', kind: 'image', src: 'data:1' }]
    const params = {
      ...defaultsFromControls(ringEffect.controls),
      content: JSON.stringify(items),
      font: 'Roboto Flex',
      typeWeight: 900,
      typeYScale: 240,
      tracking: 40,
      typeColor: '#ff0000',
    }
    let root: THREE.Object3D | undefined
    expect(() => {
      root = ringEffect.buildScene(THREE, params, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() })
    }).not.toThrow()
    const st = (root as any).userData.ringState
    expect(st.quads).toHaveLength(2)
  })

  // Card ratio (see docs/superpowers/specs/2026-08-07-ring-card-ratio-design.md): image
  // tile's `tile.aspect` comes from the content item's `aspect` (default 1 if absent) —
  // set it to a non-1 value so a 'native' vs '1:1' comparison is actually meaningful
  // (native alone wouldn't distinguish "overridden" from "coincidentally already 1").
  it('cardRatio 1:1 forces the image quad to a square, overriding its native aspect', () => {
    const items = [{ id: 'i0', kind: 'image', src: 'data:0', aspect: 1.5 }]
    const params = { ...defaultsFromControls(ringEffect.controls), content: JSON.stringify(items), cardRatio: '1:1' }
    let root: THREE.Object3D | undefined
    expect(() => {
      root = ringEffect.buildScene(THREE, params, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() })
    }).not.toThrow()
    const st = (root as any).userData.ringState
    expect(st.quads).toHaveLength(1)
    expect(st.quads[0].userData.aspect).toBe(1)
  })

  it('cardRatio native preserves the image tile\'s own aspect (unchanged behaviour)', () => {
    const items = [{ id: 'i0', kind: 'image', src: 'data:0', aspect: 1.5 }]
    const params = { ...defaultsFromControls(ringEffect.controls), content: JSON.stringify(items), cardRatio: 'native' }
    const root = ringEffect.buildScene(THREE, params, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() })
    const st = (root as any).userData.ringState
    expect(st.quads[0].userData.aspect).toBe(1.5)
  })

  // Words/letters never consult cardRatio (see the image-only branch in buildScene) — a
  // word tile's aspect is derived purely from its rasterised glyph atlas. `layoutChars`
  // calls `document.createElement('canvas')`, which throws under this suite's `node` test
  // environment (see the comment above on the type-controls tests), so a full word-tile
  // build can't be exercised headlessly here. Structurally this is enforced by cardRatio
  // being read ONLY inside `if (tile.kind === 'image')` — the `else` branch (word/letter)
  // never references `params.cardRatio` at all, so there is nothing for a word doc to pick
  // up even when the control is set to a non-native value.

  // Word fill (Task 2 of "Ring fills" — see docs/superpowers/sdd/task-2-brief.md): the ONE
  // global fill (solid/gradient/ombre/grid/noise/…) that paints every word/letter tile on
  // the ring, masked to the glyph shape. `typeColor` (the old flat-colour control) is gone;
  // `wordFill` replaces it. Word-tile RENDER can't be exercised headlessly (layoutChars
  // throws — see the comment above), so this only asserts the control declaration itself —
  // the actual glyph-masked-fill wiring is exercised indirectly by every card/image-doc
  // build above still succeeding unchanged (buildScene resolves `wordFill` unconditionally,
  // before the tile loop, so a bad resolution would break those too).
  it('declares a wordFill control with a solid-white default, and drops typeColor', () => {
    const wordFill = ringEffect.controls.find(c => c.key === 'wordFill')
    expect(wordFill).toBeDefined()
    expect(wordFill?.default).toBe('{"type":"solid","a":"#ffffff","b":"#000000","textColor":"#ffffff","angle":45,"density":8}')
    expect(wordFill?.group).toBe('Type')   // sits with the font dials, and like them shows only while there is text
    expect(ringEffect.liveKeys).not.toContain('wordFill')
    expect(ringEffect.controls.find(c => c.key === 'typeColor')).toBeUndefined()
  })

  // Regression (Task 1 landed a tile.ts rename: the old `image` ExpandedTile is now `card`).
  // A card/image ring doc must still build — this is the word-fill branch's sibling path,
  // proving buildScene's unconditional `resolveWordFill`/word-fill-texture resolution (now
  // running before the tile loop for EVERY doc, not just word docs) doesn't regress a doc
  // that has no words at all.
  it('a card/image-only doc still builds one quad per card (regression)', () => {
    const params = imageParams(3)
    const root = ringEffect.buildScene(THREE, params, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() })
    const st = (root as any).userData.ringState
    expect(st.quads).toHaveLength(3)
  })

  // Task 3 ("Ring fills" — task-3-brief.md): a card tile can be a generated fill
  // (solid/gradient/ombre/grid/noise) instead of an image. `fillShaderTexture` rasterises
  // a TEXTURED fill (gradient/ombre/grid/noise) via `document.createElement('canvas')`,
  // which throws under this suite's `node` env (no jsdom/happy-dom/canvas polyfill — the
  // same constraint documented above for word/letter tiles). A SOLID fill card takes the
  // `fillPrimary` path instead (a plain `THREE.Color`, no canvas), so SOLID is what's
  // exercised headlessly here — it's the solid/textured DISPATCH itself (ring.ts's card
  // branch) under test, not any one fill's pixels.
  it('a solid fill card builds one opaque quad (no image, no canvas)', () => {
    const items = [{ id: 'c0', kind: 'card', fillKind: 'solid', fill: { type: 'solid', a: '#ff0000', b: '#000000', textColor: '#ffffff', angle: 45, density: 8 } }]
    const params = { ...defaultsFromControls(ringEffect.controls), content: JSON.stringify(items) }
    let root: THREE.Object3D | undefined
    expect(() => {
      root = ringEffect.buildScene(THREE, params, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() })
    }).not.toThrow()
    const st = (root as any).userData.ringState
    expect(st.quads).toHaveLength(1)
    const mesh = st.quads[0]
    const mat = mesh.material as THREE.MeshBasicMaterial
    expect(mat.map).toBeNull()
    expect(mat.color.getHexString()).toBe('ff0000')
    expect(mesh.userData.aspect).toBe(1)          // square by default (cardRatio 'native')
    expect(mesh.userData.matUniforms).toBeDefined() // corner-radius mask now attaches to fill cards too
  })

  it('a fill card with no tile.fill falls back to a sensible default solid (no throw)', () => {
    const items = [{ id: 'c0', kind: 'card', fillKind: 'solid' }]
    const params = { ...defaultsFromControls(ringEffect.controls), content: JSON.stringify(items) }
    let root: THREE.Object3D | undefined
    expect(() => {
      root = ringEffect.buildScene(THREE, params, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() })
    }).not.toThrow()
    expect((root as any).userData.ringState.quads).toHaveLength(1)
  })

  it('an image card in the new card/fillKind shape still builds one quad (regression)', () => {
    const items = [{ id: 'i0', kind: 'card', fillKind: 'image', src: 'data:0', aspect: 1.5 }]
    const params = { ...defaultsFromControls(ringEffect.controls), content: JSON.stringify(items) }
    const root = ringEffect.buildScene(THREE, params, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() })
    const st = (root as any).userData.ringState
    expect(st.quads).toHaveLength(1)
    expect(st.quads[0].userData.aspect).toBe(1.5) // unchanged image-tile aspect behaviour
  })

  it('mixed image + solid-fill cards build the right quad count', () => {
    const items = [
      { id: 'i0', kind: 'card', fillKind: 'image', src: 'data:0' },
      { id: 'c0', kind: 'card', fillKind: 'solid', fill: { type: 'solid', a: '#00ff00', b: '#000000', textColor: '#ffffff', angle: 45, density: 8 } },
      { id: 'i1', kind: 'card', fillKind: 'image', src: 'data:1' },
    ]
    const params = { ...defaultsFromControls(ringEffect.controls), content: JSON.stringify(items) }
    let root: THREE.Object3D | undefined
    expect(() => {
      root = ringEffect.buildScene(THREE, params, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() })
    }).not.toThrow()
    expect((root as any).userData.ringState.quads).toHaveLength(3)
  })

  it('legacy doc missing the new type keys builds finite (RING_DEFAULTS backfill)', () => {
    const legacy = {
      content: JSON.stringify([{ id: 'i0', kind: 'image', src: 'data:0' }]),
      radius: 5, ringTilt: -0.28, cardSize: 1.4, perspective: 0.4, speed: 1, direction: 'cw',
      // font, typeWeight, typeYScale, tracking, typeColor deliberately absent
    }
    expect('font' in legacy).toBe(false)
    expect('typeWeight' in legacy).toBe(false)
    const root = ringEffect.buildScene(THREE, legacy as any, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() })
    ringEffect.update!(0, legacy as any, root)
    expect(Number.isFinite(root.rotation.x)).toBe(true)
    const st = (root as any).userData.ringState
    expect(st.quads).toHaveLength(1)
    for (const q of st.quads) {
      expect(Number.isFinite(q.scale.x)).toBe(true)
    }
  })

  // Showcase host (Task 2 — see docs/superpowers/sdd/task-2-brief.md): the renamed
  // 'ring' effect now dispatches placement to a pluggable layout via a `layout`
  // control. `id` stays 'ring' for saved-doc compat; only `label` changes.
  it('id stays ring (saved scenes), labelled for its layout, with no layout dial', () => {
    expect(ringEffect.id).toBe('ring')
    expect(ringEffect.label).toBe('Ring')
    expect(ringEffect.gallery).toBe('layouts')
    expect(ringEffect.controls.some(c => c.key === 'layout')).toBe(false)
  })

  it('builds + updates under layout=ring identical to before (image-only doc)', () => {
    const items = [{ id: 'i0', kind: 'card', fillKind: 'image', src: 'data:0' }]
    const params = { ...defaultsFromControls(ringEffect.controls), content: JSON.stringify(items) }
    const root = ringEffect.buildScene(THREE, params, new THREE.Texture(), { width: 960, height: 540, imageTextures: new Map() })
    expect(() => ringEffect.update!(0.25, params, root)).not.toThrow()
    expect((root as any).userData.ringState.quads).toHaveLength(1)
  })
})
