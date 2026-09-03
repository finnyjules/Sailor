import { describe, it, expect, beforeAll } from 'vitest'
import { tickerEffect } from '~/lib/spacetype/effects/ticker'
import { getEffect, SPACE_TYPE_EFFECTS } from '~/lib/spacetype/effects'
import { SPACE_TYPE_SECTIONS } from '~/lib/spacetype/sections'
import { defaultsFromControls, type Params } from '~/lib/spacetype/effect'
import * as THREE from 'three'

describe('ticker registration', () => {
  it('is registered and resolvable by id', () => {
    expect(getEffect('ticker').id).toBe('ticker')
    expect(SPACE_TYPE_EFFECTS.map(e => e.id)).toContain(tickerEffect.id)
  })
  it('is not hidden', () => {
    expect(tickerEffect.hidden).toBeFalsy()
  })
  it('resolves case-insensitively', () => {
    expect(getEffect('Ticker').id).toBe('ticker')
  })
})

describe('ticker controls', () => {
  it('only uses groups the panel can render', () => {
    for (const c of tickerEffect.controls) {
      expect(SPACE_TYPE_SECTIONS).toContain(c.group)
    }
  })
  it('defaults to a flat face-on ticker', () => {
    const d = defaultsFromControls(tickerEffect.controls)
    expect(d.waveAmplitude).toBe(0)
    expect(d.rotateX).toBe(0)
    expect(d.rowCount).toBe(3)
  })
  it('declares waveSpeed live but wave shape structural', () => {
    expect(tickerEffect.liveKeys).toContain('waveSpeed')
    expect(tickerEffect.liveKeys).not.toContain('waveAmplitude')
    expect(tickerEffect.liveKeys).not.toContain('waveFrequency')
  })
})

describe('ticker loopRates', () => {
  it('reports whole-cycle rates for the scroll', () => {
    const d = defaultsFromControls(tickerEffect.controls)
    const rates = tickerEffect.loopRates!(d)
    expect(rates.length).toBeGreaterThan(0)
    for (const r of rates) expect(Number.isFinite(r)).toBe(true)
  })
  // The probe is 3, not 2: at the defaults the SCROLL rate is already
  // loopTiles(speed 0.6, uRepeat 4) = round(2.4) = 2, so a waveSpeed of 2 is
  // indistinguishable from the scroll rate and the "only when non-zero" half of
  // this assertion could never hold. 3 is outside the scroll rate's range here.
  it('includes the wave rate once waveSpeed is non-zero', () => {
    const d = defaultsFromControls(tickerEffect.controls)
    const still = tickerEffect.loopRates!({ ...d, waveSpeed: 0 })
    const moving = tickerEffect.loopRates!({ ...d, waveSpeed: 3 })
    expect(moving).toContain(3)
    expect(still).not.toContain(3)
  })
})

// ─── Per-frame wave rebuild ────────────────────────────────────────────────────
// buildScene/update run against real three with no GL context: BufferGeometry and materials
// are plain data until upload, and onBeforeCompile only fires at draw time. So the geometry
// contract below is fully testable headless. The SHADER behaviour (the glyph-fringing fix)
// is NOT reachable here and is left to the runtime pass.

// fillShaderTexture paints a 1x1 swatch on a canvas; the suite runs in the node environment,
// so stub just the surface it touches rather than pulling in jsdom for two method calls.
beforeAll(() => {
  if (typeof globalThis.document === 'undefined') {
    ;(globalThis as unknown as { document: unknown }).document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ fillStyle: '', fillRect: () => {} }),
      }),
    }
  }
})

function build(overrides: Partial<Params> = {}) {
  const params = { ...defaultsFromControls(tickerEffect.controls), ...overrides } as Params
  const tex = new THREE.Texture()
  tex.userData.uRepeat = Number(params.textRepeat)
  tex.userData.numTexts = 1
  const root = tickerEffect.buildScene(THREE, params, tex)
  return { params, root }
}

function firstGeo(root: THREE.Object3D): THREE.BufferGeometry {
  const mesh = root.children.find(c => (c as THREE.Mesh).isMesh) as THREE.Mesh
  return mesh.geometry as THREE.BufferGeometry
}

describe('ticker band stroke', () => {
  const meshCount = (root: THREE.Object3D) => root.children.filter(c => (c as THREE.Mesh).isMesh).length

  it('builds no stroke mesh at all at width 0', () => {
    const { root } = build({ rowCount: 2, strokeWidth: 0 })
    expect(meshCount(root)).toBe(2)          // two bands, nothing else
  })

  it('adds one stroke mesh per row once width is non-zero', () => {
    const { root } = build({ rowCount: 2, strokeWidth: 0.2 })
    expect(meshCount(root)).toBe(4)          // two bands + two rail meshes
  })

  it('keeps stroke width structural — it changes geometry, so it must force a rebuild', () => {
    expect(tickerEffect.liveKeys).not.toContain('strokeWidth')
  })

  it('re-bakes the rails with the band as a travelling wave advances', () => {
    const { params, root } = build({ rowCount: 1, strokeWidth: 0.2, waveAmplitude: 2, waveSpeed: 1 })
    const stroke = root.children.filter(c => (c as THREE.Mesh).isMesh)
      .map(c => (c as THREE.Mesh).geometry as THREE.BufferGeometry)
      .find(g => !g.getAttribute('uv'))!     // the rail mesh is the one without UVs
    tickerEffect.update(0, params, root)
    const at0 = Float32Array.from(stroke.getAttribute('position').array as Float32Array)
    tickerEffect.update(0.25, params, root)
    expect(Array.from(stroke.getAttribute('position').array as Float32Array)).not.toEqual(Array.from(at0))
  })
})

describe('ticker wave rebuild', () => {
  it('leaves geometry untouched across frames when the wave is still', () => {
    const { params, root } = build({ waveAmplitude: 2, waveSpeed: 0 })
    const geo = firstGeo(root)
    const before = Float32Array.from(geo.getAttribute('position').array as Float32Array)
    tickerEffect.update(0.37, params, root)
    expect(Array.from(geo.getAttribute('position').array as Float32Array)).toEqual(Array.from(before))
  })

  it('re-bakes positions as a travelling wave advances', () => {
    const { params, root } = build({ waveAmplitude: 2, waveSpeed: 1 })
    const geo = firstGeo(root)
    tickerEffect.update(0, params, root)
    const at0 = Float32Array.from(geo.getAttribute('position').array as Float32Array)
    tickerEffect.update(0.25, params, root)
    expect(Array.from(geo.getAttribute('position').array as Float32Array)).not.toEqual(Array.from(at0))
  })

  it('re-bakes UVs alongside positions, so glyphs cannot breathe through a moving wave', () => {
    const { params, root } = build({ waveAmplitude: 2, waveSpeed: 1 })
    const geo = firstGeo(root)
    tickerEffect.update(0, params, root)
    const uv0 = Float32Array.from(geo.getAttribute('uv').array as Float32Array)
    tickerEffect.update(0.25, params, root)
    expect(Array.from(geo.getAttribute('uv').array as Float32Array)).not.toEqual(Array.from(uv0))
  })

  it('settles back to the resting phase when waveSpeed returns to 0', () => {
    // waveSpeed is a liveKey, so dragging it to 0 does NOT rebuild the scene. Without an
    // explicit settle the band would freeze at whatever phase was last written.
    const { params, root } = build({ waveAmplitude: 2, waveSpeed: 1 })
    const geo = firstGeo(root)
    tickerEffect.update(0, params, root)
    const rest = Float32Array.from(geo.getAttribute('position').array as Float32Array)
    tickerEffect.update(0.3, params, root)
    expect(Array.from(geo.getAttribute('position').array as Float32Array)).not.toEqual(Array.from(rest))
    tickerEffect.update(0.3, { ...params, waveSpeed: 0 }, root)
    const settled = geo.getAttribute('position').array as Float32Array
    for (let i = 0; i < rest.length; i++) expect(settled[i]).toBeCloseTo(rest[i]!, 5)
  })

  it('is pure in t01 — the same frame renders identically twice', () => {
    const { params, root } = build({ waveAmplitude: 2, waveSpeed: 1 })
    const geo = firstGeo(root)
    tickerEffect.update(0.42, params, root)
    const a = Float32Array.from(geo.getAttribute('position').array as Float32Array)
    tickerEffect.update(0.11, params, root)
    tickerEffect.update(0.42, params, root)
    const b = geo.getAttribute('position').array as Float32Array
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i]!, 5)
  })
})
