import { describe, it, expect } from 'vitest'
import { animatableTargets, applyMotion } from '../../app/lib/gradientfx/motion'
import { defaultConfig, stripeConfig } from '../../app/lib/gradientfx/randomize'
import { ensureConfigDefaults, resolvePost } from '../../app/lib/gradientfx/types'
import { getByPath } from '../../app/lib/studio/path'

/**
 * Raw stripeConfig() leaves cfg.focus and layers[0].mesh undefined; the real
 * app always normalizes through ensureConfigDefaults on load (see
 * gradientfx-controls.unit.spec.ts's cfgWithLayout helper). Build every test
 * config the same way so focus.* and mesh.* paths actually resolve.
 *
 * stripeConfig, not defaultConfig: defaultConfig now opens a brand-new document
 * on the flat Linear ramp (`layout:'ramp'`, Task 7), which has no Shape/Relief
 * group at all, so it can't characterize the shape/relief motion targets this
 * file pins below. stripeConfig is the historical stripe-shaped default
 * (byte-identical to what defaultConfig used to return) that still exercises
 * them.
 */
const cfg = () => ensureConfigDefaults(stripeConfig() as any) as any

describe('animatableTargets', () => {
  it('returns absolute paths that resolve on the config', () => {
    const c = cfg()
    const targets = animatableTargets(c)
    expect(targets.length).toBeGreaterThan(0)
    for (const t of targets) {
      expect(getByPath(c, t.path), `${t.path} unresolved`).not.toBeUndefined()
    }
  })

  it('expands layer-relative controls once per layer', () => {
    const c = cfg()
    c.layers = [c.layers[0], JSON.parse(JSON.stringify(c.layers[0]))]
    const paths = animatableTargets(c).map((t) => t.path)
    const l0 = paths.filter((p) => p.startsWith('layers.0.'))
    const l1 = paths.filter((p) => p.startsWith('layers.1.'))
    expect(l0.length).toBeGreaterThan(0)
    expect(l1.length).toBe(l0.length)
  })

  it('every target has a finite range with max > min', () => {
    for (const t of animatableTargets(cfg())) {
      expect(Number.isFinite(t.min), `${t.path} min`).toBe(true)
      expect(Number.isFinite(t.max), `${t.path} max`).toBe(true)
      expect(t.max, `${t.path} range`).toBeGreaterThan(t.min)
    }
  })

  it('animates far more than the 11 legacy shape keys', () => {
    // The point of the refactor: relief, flow and focus params become
    // animatable for the first time.
    expect(animatableTargets(cfg()).length).toBeGreaterThan(11)
  })

  it('includes non-shape targets that were previously impossible', () => {
    const paths = animatableTargets(cfg()).map((t) => t.path)
    // Was relief.grain until Task 8 moved grain into the shared post stack —
    // post.grainAmount is its animatable successor (see postControls()).
    expect(paths).toContain('post.grainAmount')
    expect(paths).toContain('focus.blur')
  })

  it('uses the animatable range override where it differs from the UI slider', () => {
    const c = cfg()
    const sweep = animatableTargets(c).find((t) => t.path.endsWith('.shape.sweep'))
    expect(sweep).toBeDefined()
    expect(sweep!.min).toBe(0)
    expect(sweep!.max).toBe(360)
  })

  it('produces unique labels so the dropdown is unambiguous', () => {
    const labels = animatableTargets(cfg()).map((t) => t.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('excludes non-numeric controls', () => {
    const paths = animatableTargets(cfg()).map((t) => t.path)
    expect(paths).not.toContain('canvas.background')
    expect(paths).not.toContain('canvas.layout')
  })

  // Both `agent` and `animatable` are opt-OUT (see controls.ts's doc comment),
  // so a new slider silently joins both vocabularies by default. The agent
  // side is pinned by gradientfx-controls.unit.spec.ts's frozen snapshot; this
  // pins the motion side the same way so a schema edit that silently adds or
  // removes a motion target fails loudly here instead of shipping unnoticed.
  it('pins the default config\'s animatable target set', () => {
    const paths = animatableTargets(cfg()).map((t) => t.path)
    // 51 = 50 (see the previous count, after Task 8 retired relief.grain) plus 1:
    // 8fadea551 added screen-space Distort as a shared POST_EFFECTS catalog entry
    // (post.distortAmount, uniform: 'u_amount'), which animatableTargets picks up
    // automatically like every other post slider. Was: 50 = 51 (see the previous
    // count, from Task 5's post-stack adoption) minus 1: Task 8 retired
    // relief.grain (its rendering moved into the shared post stack;
    // post.grainAmount — already counted among the post.* sliders below — is its
    // animatable successor). Was: 32 (relief.light.azimuth/elevation moved from the
    // liquid layout, where the shader ignores them, to the banded layouts, where
    // they aim the relief light — so the default linear config can animate the
    // light too) + 19 post.* sliders adopted from the shared post stack (Task 5):
    // every POST_EFFECTS param whose `uniform` isn't null, minus the two colour
    // params (duotoneShadow/Highlight — motion only animates sliders) and gtao's
    // three (withheld from a 2D host by postControls({ threeD: false })) and
    // halftoneScatter (uniform: null).
    expect(paths.length).toBe(51)
    expect(paths).toMatchSnapshot()
  })
})

const track = (over: any = {}) => ({
  path: 'layers.0.shape.count', from: 0, to: 10,
  easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0, ...over,
})

describe('path-based applyMotion', () => {
  it('writes the animated value at the track path', () => {
    const c: any = cfg()
    c.motion.duration = 1
    c.motion.tracks = [track()]
    expect((applyMotion(c, 1) as any).layers[0].shape.count).toBe(10)
  })

  it('does not mutate the input config', () => {
    const c: any = cfg()
    c.motion.duration = 1
    c.motion.tracks = [track()]
    const before = c.layers[0].shape.count
    applyMotion(c, 1)
    expect(c.layers[0].shape.count).toBe(before)
  })

  it('animates a non-shape path that was impossible before', () => {
    const c: any = cfg()
    c.motion.duration = 1
    // relief.relief, not relief.grain: grain moved into the shared post stack and a
    // track pointing at it is now REWRITTEN (see the legacy-track block below).
    c.motion.tracks = [track({ path: 'relief.relief', from: 0, to: 1 })]
    expect((applyMotion(c, 1) as any).relief.relief).toBe(1)
  })

  it('ignores an unresolvable path without fabricating structure', () => {
    const c: any = cfg()
    c.motion.duration = 1
    c.motion.tracks = [track({ path: 'nope.does.not.exist' })]
    expect((applyMotion(c, 1) as any).nope).toBeUndefined()
  })

  it('ignores a track with no path at all', () => {
    const c: any = cfg()
    c.motion.duration = 1
    c.motion.tracks = [track({ path: undefined })]
    expect(() => applyMotion(c, 1)).not.toThrow()
  })
})

describe('legacy track migration', () => {
  it('rewrites {layer, param} tracks to absolute paths', () => {
    const c: any = cfg()
    c.motion.tracks = [
      { layer: 0, param: 'count', from: 2, to: 8, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 },
      { layer: 1, param: 'phase', from: 0, to: 1, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 },
    ]
    const out: any = ensureConfigDefaults(c)
    expect(out.motion.tracks[0].path).toBe('layers.0.shape.count')
    expect(out.motion.tracks[1].path).toBe('layers.1.shape.phase')
  })

  it('strips the legacy layer/param fields once migrated', () => {
    const c: any = cfg()
    c.motion.tracks = [
      { layer: 0, param: 'count', from: 2, to: 8, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 },
    ]
    const out: any = ensureConfigDefaults(c)
    expect(out.motion.tracks[0].path).toBe('layers.0.shape.count')
    expect(out.motion.tracks[0].layer).toBeUndefined()
    expect(out.motion.tracks[0].param).toBeUndefined()
    expect('layer' in out.motion.tracks[0]).toBe(false)
    expect('param' in out.motion.tracks[0]).toBe(false)
  })

  it('leaves already-migrated tracks untouched', () => {
    const c: any = cfg()
    c.motion.tracks = [{ path: 'relief.relief', from: 0, to: 1, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 }]
    expect((ensureConfigDefaults(c) as any).motion.tracks[0].path).toBe('relief.relief')
  })

  it('a migrated legacy track still animates', () => {
    const c: any = cfg()
    c.motion.duration = 1
    c.motion.tracks = [{ layer: 0, param: 'count', from: 0, to: 10, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 }]
    expect((applyMotion(ensureConfigDefaults(c), 1) as any).layers[0].shape.count).toBe(10)
  })

  it('animates a legacy {layer, param} track with no migration step at all', () => {
    // Regression test for the CRITICAL finding: ensureConfigDefaults only runs
    // on the editor-open path. The node card, headless bake, and studio frame
    // source all render straight from the saved blob, so applyMotion itself
    // must tolerate un-migrated tracks.
    const c: any = cfg()
    c.motion.duration = 1
    c.motion.tracks = [{ layer: 0, param: 'count', from: 0, to: 10, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 }]
    expect((applyMotion(c, 1) as any).layers[0].shape.count).toBe(10)
  })
})

// The defect this block exists to prevent: `relief.grain` was an animatable target
// before grain moved into the shared post stack, so saved documents carry tracks that
// point at it. Such a track ALREADY has a `path`, so the {layer,param} rewrite left it
// alone — and applyMotion then re-created `relief.grain` on its clone every frame,
// after ensureConfigDefaults had deliberately deleted it. resolvePost's legacy-wins
// rule saw that resurrected field and force-wrote grain back on, so on those documents
// the new Grain switch and both sliders were dead: turning Grain off left it on.
describe('legacy relief.grain motion track', () => {
  const grainTrack = (from = 0, to = 1) => ({ path: 'relief.grain', from, to, easing: 'linear' as const, loops: 1, hold: 0, cycleOffset: 0, delay: 0 })

  it('is rewritten onto post.grainAmount by the migration', () => {
    const c: any = cfg()
    c.relief.grain = 0.4
    c.motion.tracks = [grainTrack()]
    const out: any = ensureConfigDefaults(c)
    expect(out.motion.tracks[0].path).toBe('post.grainAmount')
    expect(out.relief.grain).toBeUndefined()
  })

  it('animates post.grainAmount, and leaves relief.grain absent after a render cycle', () => {
    const c: any = cfg()
    c.relief.grain = 0.4
    c.motion.duration = 1
    c.motion.tracks = [grainTrack()]
    const migrated: any = ensureConfigDefaults(c)

    const frame: any = applyMotion(migrated, 1)
    expect(frame.post.grainAmount).toBe(1)
    // The resurrection: a re-created relief.grain is what resolvePost picks up.
    expect(frame.relief.grain).toBeUndefined()
    expect('grain' in frame.relief).toBe(false)
  })

  it('leaves the Grain switch live on a document that has been through the migration', () => {
    const c: any = cfg()
    c.relief.grain = 0.4
    c.motion.duration = 1
    c.motion.tracks = [grainTrack()]
    const migrated: any = ensureConfigDefaults(c)
    // The user switches Grain off. It must stay off through a render cycle.
    migrated.post.grain = false
    expect(resolvePost(applyMotion(migrated, 1) as any).grain).toBe(false)
    // ...and the amount slider still follows the track when it is on.
    migrated.post.grain = true
    expect(resolvePost(applyMotion(migrated, 1) as any).grainAmount).toBe(1)
  })

  it('still animates grain on an UN-migrated blob, where the legacy field is live', () => {
    // The node card, headless bake and studio frame source render straight off the
    // saved blob, so applyMotion sees a config ensureConfigDefaults never touched:
    // relief.grain is still present and still WINS at render (resolvePost). Writing
    // the migrated path there instead would strand the animation on a static value.
    const raw: any = defaultConfig()
    delete raw.post // a doc old enough to carry relief.grain predates `post` entirely
    raw.relief.grain = 0.2
    raw.motion.duration = 1
    raw.motion.tracks = [grainTrack()]
    const frame: any = applyMotion(raw, 1)
    expect(frame.relief.grain).toBe(1)
    expect(resolvePost(frame).grainAmount).toBe(1)
  })
})

describe('applyMotion parent-container guard', () => {
  it('animates an optional-but-real leaf even when unset', () => {
    const c: any = cfg()
    c.motion.duration = 1
    delete c.flow.swirl
    c.motion.tracks = [track({ path: 'flow.swirl', from: 0, to: 50 })]
    expect((applyMotion(c, 1) as any).flow.swirl).toBe(50)
  })

  it('skips a path whose parent container does not exist, without throwing', () => {
    const c: any = cfg()
    c.motion.duration = 1
    c.layers = [c.layers[0]]
    c.motion.tracks = [track({ path: 'layers.5.shape.count' })]
    expect(() => applyMotion(c, 1)).not.toThrow()
    const out: any = applyMotion(c, 1)
    expect(out.layers[5]).toBeUndefined()
  })

  it('skips a completely bogus path', () => {
    const c: any = cfg()
    c.motion.duration = 1
    c.motion.tracks = [track({ path: 'nope.does.not.exist' })]
    const out: any = applyMotion(c, 1)
    expect(out.nope).toBeUndefined()
  })
})
