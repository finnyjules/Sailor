import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { DEFAULT_CONFIG, mergeConfig } from '~/lib/shapefx/config'
import { configureBlitTexture } from '~/lib/shapefx/engine'
import { SHAPE_CONTROLS, SHAPE_SECTIONS } from '~/lib/shapefx/controls'
import { DEFAULT_POST } from '~/lib/studio/post/settings'

// Task 7: Shape Studio adopts the shared post stack — same seam as Task 5
// (Gradient, gradientfx-post.unit.spec.ts) and Task 6 (Texture,
// texturefx-post.unit.spec.ts), against ShapeConfig's typed `post` field and
// mergeConfig's backfill (Shape's ensureConfigDefaults equivalent).
//
// Named `shapefx-post-adoption` rather than `shapefx-post` (the naming Task 5/6
// used) because `shapefx-post.unit.spec.ts` already exists and covers a DIFFERENT
// concern: Shape's own POST_FRAG grain/distortion pass (lib/shapefx/post.ts),
// landed before this task. That file is untouched by Task 7 — see engine.ts's
// drawFrame(), which keeps that pass and adds the shared stack after it.
describe('shape post adoption', () => {
  it('defaults post to off for a config saved before the change (missing post key entirely)', () => {
    // style.grain: 0 — explicit, not compensating for a nonzero default:
    // DEFAULT_CONFIG no longer carries a legacy grain value at all (the old grain
    // slider was retired in Task 8; see post-grain-migration.unit.spec.ts's "a
    // fresh shape config carries no legacy grain" case). A nonzero style.grain
    // would turn post.grain on by design (Task 8's routing-parity migration; see
    // post.ts's postNeeded doc comment and shapefx-post.unit.spec.ts's own
    // grain-migration coverage) — orthogonal to what THIS test checks (the post
    // field's backfill).
    const legacy = mergeConfig({ ...structuredClone(DEFAULT_CONFIG), style: { ...DEFAULT_CONFIG.style, grain: 0 }, post: undefined })
    expect(legacy.post).toEqual(DEFAULT_POST)
  })

  it('preserves post settings that are already present, backfilling only missing keys', () => {
    const cfg = mergeConfig({ ...structuredClone(DEFAULT_CONFIG), post: { bloom: true, bloomStrength: 0.9 } })
    expect(cfg.post.bloom).toBe(true)
    expect(cfg.post.bloomStrength).toBe(0.9)
    // Untouched keys still fall back to DEFAULT_POST.
    expect(cfg.post.vignette).toBe(DEFAULT_POST.vignette)
  })

  it('DEFAULT_CONFIG itself carries a post field already at rest (off)', () => {
    expect(DEFAULT_CONFIG.post).toEqual(DEFAULT_POST)
  })

  it('exposes the post controls without ambient occlusion (Shape has no depth/normal buffers wired)', () => {
    const keys = SHAPE_CONTROLS.map(c => c.key)
    expect(keys).toContain('post.bloom')
    expect(keys).toContain('post.vignette')
    expect(keys.some(k => k.startsWith('post.gtao'))).toBe(false)
  })

  it('the post sections land in SHAPE_SECTIONS so the schema-driven inspector renders them', () => {
    // Nested paths under the "Effects" parent (sectionFor → `${POST_SECTION}/${label}`),
    // not bare labels — these qualified strings are what groupIntoSections keys on.
    expect(SHAPE_SECTIONS).toContain('Effects/Bloom')
    expect(SHAPE_SECTIONS).toContain('Effects/Vignette')
  })
})

// The blit that carries applyPost's result back onto Shape's own canvas is a
// byte-for-byte copy, and two of the properties it depends on used to be left at
// three's defaults. They are correct in three@0.171, so nothing failed — but a
// version bump flipping either would corrupt transparent (premultiply) or
// colour-managed (colorSpace) Shape exports with no test to notice. Pinned here.
describe('shared-post blit texture', () => {
  // A stub image: CanvasTexture's constructor only stores what it is handed, and
  // this file runs in the node environment (no document).
  const tex = () => configureBlitTexture(new THREE.CanvasTexture({ width: 1, height: 1 } as unknown as HTMLCanvasElement))

  it('keeps straight alpha — applyPost\'s canvas is not premultiplied', () => {
    expect(tex().premultiplyAlpha).toBe(false)
  })

  it('does no colour-space conversion on sample — BLIT_FRAG would not undo one', () => {
    expect(tex().colorSpace).toBe(THREE.NoColorSpace)
  })

  it('samples 1:1 with no mips and no wrap', () => {
    const t = tex()
    expect(t.generateMipmaps).toBe(false)
    expect(t.minFilter).toBe(THREE.LinearFilter)
    expect(t.magFilter).toBe(THREE.LinearFilter)
    expect(t.wrapS).toBe(THREE.ClampToEdgeWrapping)
    expect(t.wrapT).toBe(THREE.ClampToEdgeWrapping)
  })
})
