import { describe, it, expect } from 'vitest'
import { animatableTargets, animatableRange } from '~/lib/scene3d/motion/targets'
import { applyMotionToDoc } from '~/lib/scene3d/motion/apply'
import { defaultDoc, createPrimitive, type SceneObject } from '~/lib/scene3d/config'
import { SCENE_CONTROLS } from '~/lib/scene3d/controls'
import type { SceneMotionTrack } from '~/lib/scene3d/motion/types'
import { createTreatment } from '~/lib/scene3d/treatments'

const track = (over: Partial<SceneMotionTrack> = {}): SceneMotionTrack => ({
  path: 'lighting.sunIntensity', from: 0, to: 1, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0, ...over,
})

describe('animatableTargets', () => {
  it('includes lighting.brightness (a simple dial) with its declared slider range', () => {
    const doc = defaultDoc()
    const t = animatableTargets(doc).find((x) => x.path === 'lighting.brightness')
    expect(t).toBeTruthy()
    expect(t!.min).toBe(0.25)
    expect(t!.max).toBe(3)
    expect(t!.label).toBe('Brightness')
  })

  it('offers lighting.sunIntensity with its declared slider range only once Advanced lighting is on', () => {
    // The raw sun/ambient dials sit behind `lighting.advanced` (controls.ts `when`), and
    // targets are derived from the same visibility gate the inspector uses.
    const doc = defaultDoc()
    expect(animatableTargets(doc).find((x) => x.path === 'lighting.sunIntensity')).toBeUndefined()
    doc.lighting.advanced = true
    const t = animatableTargets(doc).find((x) => x.path === 'lighting.sunIntensity')
    expect(t).toBeTruthy()
    expect(t!.min).toBe(0)
    expect(t!.max).toBe(3)
    expect(t!.label).toBe('Sun intensity')
  })

  it('includes a per-object relief path, id-addressed and labelled with the object name', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.name = 'My Box'
    doc.objects.push(box)

    const path = `objects.${box.id}.material.relief.scale`
    const t = animatableTargets(doc).find((x) => x.path === path)
    expect(t, path).toBeTruthy()
    expect(t!.label).toBe('My Box · Relief scale')
    expect(t!.min).toBe(0)
    expect(t!.max).toBe(4)
  })

  it('reaches every object, not just one', () => {
    const doc = defaultDoc()
    const a = createPrimitive('box', doc.objects); a.name = 'A'; doc.objects.push(a)
    const b = createPrimitive('sphere', doc.objects); b.name = 'B'; doc.objects.push(b)
    const paths = animatableTargets(doc).map((t) => t.path)
    expect(paths).toContain(`objects.${a.id}.material.roughness`)
    expect(paths).toContain(`objects.${b.id}.material.roughness`)
  })

  it('excludes transform paths — SCENE_CONTROLS declares them animatable: false', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    doc.objects.push(box)
    const paths = animatableTargets(doc).map((t) => t.path)

    // Nothing emitted for any axis of position/rotation/scale, relative or id-addressed.
    for (const axis of ['0', '1', '2']) {
      for (const field of ['position', 'rotation', 'scale']) {
        expect(paths).not.toContain(`object.${field}.${axis}`)
        expect(paths).not.toContain(`objects.${box.id}.${field}.${axis}`)
      }
    }

    // Don't just assume — assert the schema itself still marks every Transform control
    // animatable: false, so a future edit that silently drops the flag fails THIS test
    // rather than shipping a track that fights ObjectMotion.
    const transform = SCENE_CONTROLS.filter((c) => c.group === 'Transform')
    expect(transform.length).toBeGreaterThan(0)
    for (const c of transform) expect(c.animatable, c.key).toBe(false)
  })

  it('excludes anything under objects.<id>.motion.', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    doc.objects.push(box)
    const paths = animatableTargets(doc).map((t) => t.path)
    expect(paths.some((p) => p.includes('.motion.'))).toBe(false)
    expect(paths.some((p) => p.startsWith(`objects.${box.id}.motion`))).toBe(false)
  })

  it('every target has a finite range with max > min', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    for (const t of animatableTargets(doc)) {
      expect(Number.isFinite(t.min), `${t.path} min`).toBe(true)
      expect(Number.isFinite(t.max), `${t.path} max`).toBe(true)
      expect(t.max, `${t.path} range`).toBeGreaterThan(t.min)
    }
  })

  it('a default scene (no objects) still offers the doc-level (Lighting/Camera/Post) targets', () => {
    const paths = animatableTargets(defaultDoc()).map((t) => t.path)
    expect(paths).toContain('lighting.brightness')
    expect(paths).toContain('camera.fov')
    expect(paths).toContain('post.bloomStrength')
  })

  /**
   * ALLOW-LIST, not a presence check. Every other assertion in this file asks whether a
   * particular path is offered, so the vocabulary could grow by a dozen entries without
   * one of them going red — and it silently did: eleven inspector-only material sliders
   * joined SCENE_CONTROLS and, being sliders, defaulted to animatable. They now carry
   * `animatable: false`, and this pins the result so the NEXT addition has to be
   * deliberate. Per material type, because `when` gates most material keys: a scene of
   * standard boxes offers a different set from a scene of gradient ones.
   */
  const objectTargets = (type: SceneObject['material']['type']): string[] => {
    const doc = defaultDoc()
    const o = createPrimitive('box', doc.objects)
    o.material.type = type
    doc.objects.push(o)
    const prefix = `objects.${o.id}.`
    return animatableTargets(doc)
      .map((t) => t.path)
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length))
      .sort()
  }

  const RELIEF = ['material.relief.contrast', 'material.relief.scale', 'material.relief.tiling']
  const SCREEN = ['material.screen.angle', 'material.screen.contrast', 'material.screen.density', 'material.screen.misregister', 'material.screen.softness']
  const PBR = ['material.metalness', 'material.roughness']
  const COAT = ['material.clearcoat', 'material.clearcoatRoughness', 'material.envMapIntensity']
  // The ambientCG texture set's tiling — animatable by default, like relief.tiling. Offered
  // on exactly the three physical types that can carry a set (standard / glass / opalescent).
  const TEXTURE = ['material.textureTiling']
  const PHYSICAL = [
    ...COAT, 'material.emissiveIntensity', 'material.iridescence', 'material.iridescenceIOR',
    'material.ior', 'material.opacity', 'material.sheen', 'material.thickness', 'material.transmission',
  ]

  /**
   * The same allow-list, for the DOC-level half of the vocabulary. The test above it
   * ("still offers the doc-level targets") is a presence check on three paths, so the
   * Lighting / Camera / Post namespaces could grow without anything going red — exactly
   * the hole the per-object allow-list was added to close. Pinned from the current,
   * correct vocabulary.
   *
   * `post.*` is derived from the SHARED post catalog (~/lib/studio/post), which other
   * surfaces grow too: adding an effect there legitimately lands new paths here. That is
   * a deliberate grant, so it belongs in this list — update it in the same change, do not
   * loosen the assertion.
   */
  const docTargets = (prefix: string, mutate?: (doc: ReturnType<typeof defaultDoc>) => void): string[] => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    mutate?.(doc)
    return animatableTargets(doc).map((t) => t.path).filter((p) => p.startsWith(prefix)).sort()
  }

  // Lighting has two modes. Simple (the default) offers the three feel dials plus the
  // light's direction; Advanced lighting reveals the raw sun/ambient dials on top.
  // Both lists are exact, so growing either vocabulary has to be deliberate.
  const SIMPLE_LIGHTING = [
    'lighting.brightness', 'lighting.softness', 'lighting.sunAzimuth', 'lighting.sunElevation', 'lighting.warmth',
  ]

  it('offers exactly these lighting targets in simple mode (the default)', () => {
    expect(docTargets('lighting.')).toEqual(SIMPLE_LIGHTING)
  })

  it('offers exactly these lighting targets once Advanced lighting is on', () => {
    expect(docTargets('lighting.', (doc) => { doc.lighting.advanced = true })).toEqual([
      ...SIMPLE_LIGHTING, 'lighting.ambient', 'lighting.sunIntensity',
    ].sort())
  })

  it('offers exactly these camera targets', () => {
    expect(docTargets('camera.')).toEqual(['camera.fov'])
  })

  it('offers exactly these post targets', () => {
    expect(docTargets('post.')).toEqual([
      'post.bloomRadius', 'post.bloomStrength', 'post.bloomThreshold',
      'post.blurAmount', 'post.chromaAmount', 'post.contrast', 'post.distortAmount',
      'post.dotScreenAngle', 'post.dotScreenScale', 'post.duotoneMix', 'post.exposure',
      'post.filmIntensity', 'post.grainAmount', 'post.grainSize',
      'post.gtaoIntensity', 'post.gtaoRadius', 'post.gtaoThickness',
      'post.halftoneRadius', 'post.halftoneScatter', 'post.hue', 'post.saturation',
      'post.vignetteAmount', 'post.vignetteRadius', 'post.vignetteSoftness',
    ])
  })

  it('offers no doc-level namespace beyond Lighting / Camera / Post', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    const stray = animatableTargets(doc).map((t) => t.path)
      .filter((p) => !p.startsWith('object') && !/^(lighting|camera|post)\./.test(p))
    expect(stray).toEqual([])
  })

  it.each([
    ['standard', [...PBR, ...PHYSICAL, ...RELIEF, ...TEXTURE, ...SCREEN]],
    ['glass', [...PBR, ...PHYSICAL, ...RELIEF, ...TEXTURE]],
    ['phong', ['material.shininess', ...RELIEF, ...SCREEN]],
    ['toon', [...RELIEF, ...SCREEN]],
    ['matcap', [...RELIEF, ...SCREEN]],
    ['fresnel', [...RELIEF, ...SCREEN]],
    ['gradient', [...RELIEF, ...SCREEN]],
    // imageWrap (select), imageTilingLinked (switch), imageFlipX/Y (switch) are not sliders, so they never
    // reach animatableTargets — only the tiling and offset/rotation sliders do.
    // imageAlpha is a switch, not a slider, so it never reaches animatableTargets either —
    // imageCutout and opacity are the two sliders Task 8 adds/widens onto image; imageGlow
    // is Task 9's (its showIf gate is not a factor here — iterateObjectControls filters on
    // `when` alone). imageBrightness/imageContrast/imageSaturation are Task 10's — plain
    // sliders with no showIf gate, always reachable. imageProjection/imageProjectionAxis
    // (Task 11) are selects, so they never reach animatableTargets either; imageBoxBlend is
    // a slider (its showIf gate is likewise not a factor here) and does. imageSeamless is
    // Task 12's — a plain slider with no showIf gate, always reachable; it changes the
    // pixels rather than a uniform (identityKey, not updateMaterial), but that only affects
    // WHETHER a written value takes a rebuild, not whether it is a motion target at all.
    ['image', [...PBR, ...RELIEF, ...SCREEN, 'material.imageBoxBlend', 'material.imageBrightness', 'material.imageContrast', 'material.imageCutout', 'material.imageGlow', 'material.imageOffsetX', 'material.imageOffsetY', 'material.imageRotation', 'material.imageSaturation', 'material.imageSeamless', 'material.imageTiling', 'material.imageTilingY', 'material.opacity']],
    ['shaderFill', [...PBR, ...RELIEF, ...SCREEN]],
    ['opalescent', [
      ...PBR, ...COAT, ...RELIEF, ...TEXTURE, ...SCREEN,
      'material.opalAngleMix', 'material.opalFlowSpeed', 'material.opalFrequency',
      'material.opalHueShift', 'material.opalStrength',
    ]],
    // No PBR pair and no texture tiling: a foil pins metalness and Gloss owns its roughness.
    ['holographic', [
      ...COAT, ...RELIEF, ...SCREEN,
      'material.holoAngle', 'material.holoBands', 'material.holoFlakeSize', 'material.holoFlakes',
      'material.holoGloss', 'material.holoHueShift', 'material.holoStrength',
    ]],
  ] as const)('offers exactly these per-object targets for a %s material', (type, expected) => {
    expect(objectTargets(type)).toEqual([...expected].sort())
  })
})

describe('animatableRange — the widening mechanism', () => {
  it('reports the slider range when animatable is absent', () => {
    expect(animatableRange({ min: 0, max: 1 })).toEqual({ min: 0, max: 1 })
  })
  it('reports the slider range when animatable: true', () => {
    expect(animatableRange({ min: 0, max: 1, animatable: true })).toEqual({ min: 0, max: 1 })
  })
  it('reports the WIDENED range when animatable is an explicit {min,max}, not the slider\'s own', () => {
    expect(animatableRange({ min: 0, max: 1, animatable: { min: -50, max: 50 } })).toEqual({ min: -50, max: 50 })
  })
})

describe('applyMotionToDoc — path tracks', () => {
  it('writes the track value at the right doc-level path', () => {
    const doc = defaultDoc()
    doc.motion = { duration: 1, fps: 30, loop: true, tracks: [track({ path: 'lighting.sunIntensity', from: 0, to: 2 })] }
    const out = applyMotionToDoc(doc, 1).doc
    expect(out.lighting.sunIntensity).toBeCloseTo(2, 6)
  })

  it('writes the value at the right OBJECT and leaves the other object untouched', () => {
    const doc = defaultDoc()
    const a = createPrimitive('box', doc.objects); doc.objects.push(a)
    const b = createPrimitive('sphere', doc.objects); doc.objects.push(b)
    doc.motion = {
      duration: 1, fps: 30, loop: true,
      tracks: [track({ path: `objects.${a.id}.material.roughness`, from: 0, to: 0.9 })],
    }
    const out = applyMotionToDoc(doc, 1).doc
    const outA = out.objects.find((o) => o.id === a.id)!
    const outB = out.objects.find((o) => o.id === b.id)!
    expect((outA as any).material.roughness).toBeCloseTo(0.9, 6)
    expect((outB as any).material.roughness).toBe(b.material.roughness) // untouched
  })

  it('does not mutate the input doc', () => {
    const doc = defaultDoc()
    doc.motion = { duration: 1, fps: 30, loop: true, tracks: [track({ path: 'lighting.sunIntensity', from: 0, to: 2 })] }
    const before = JSON.stringify(doc)
    applyMotionToDoc(doc, 1)
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('a track whose parent container is missing is skipped and fabricates nothing', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects); doc.objects.push(box)
    expect(box.material.relief).toBeUndefined() // precondition: relief block genuinely absent
    doc.motion = {
      duration: 1, fps: 30, loop: true,
      tracks: [track({ path: `objects.${box.id}.material.relief.scale`, from: 0, to: 1 })],
    }
    const out = applyMotionToDoc(doc, 1).doc
    const outBox = out.objects.find((o) => o.id === box.id)!
    expect((outBox as any).material.relief).toBeUndefined() // still absent — nothing fabricated
  })

  it('a bogus doc-level path is skipped without throwing and fabricates nothing', () => {
    const doc = defaultDoc()
    doc.motion = { duration: 1, fps: 30, loop: true, tracks: [track({ path: 'nope.does.not.exist', from: 0, to: 1 })] }
    expect(() => applyMotionToDoc(doc, 1)).not.toThrow()
    const out = applyMotionToDoc(doc, 1).doc as any
    expect(out.nope).toBeUndefined()
  })

  it('an unresolvable object id is ignored, not fabricated or re-aimed at another object', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects); doc.objects.push(box)
    doc.motion = {
      duration: 1, fps: 30, loop: true,
      tracks: [track({ path: 'objects.does-not-exist.material.roughness', from: 0, to: 0.9 })],
    }
    const out = applyMotionToDoc(doc, 1).doc
    expect((out.objects[0] as any).material.roughness).toBe(box.material.roughness)
  })

  it('a track explicitly aimed at the motion sub-namespace is ignored, never fighting the preset system', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.motion = { loop: { kind: 'spin', speed: 1, amount: 1 } }
    doc.objects.push(box)
    doc.motion = {
      duration: 1, fps: 30, loop: true,
      tracks: [track({ path: `objects.${box.id}.motion.loop.speed`, from: 0, to: 99 })],
    }
    const out = applyMotionToDoc(doc, 1).doc
    const outBox = out.objects.find((o) => o.id === box.id)!
    expect(outBox.motion?.loop?.speed).toBe(1) // unchanged — the track never touched it
  })

  it('with no tracks, output is unchanged from the existing preset-only behaviour', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects); box.position = [0, 5, 0]
    box.motion = { loop: { kind: 'bob', speed: 1, amount: 2 } }
    doc.objects.push(box)
    doc.motion = { duration: 4, fps: 30, loop: true } // no tracks field at all
    const quarter = applyMotionToDoc(doc, 0.25).doc.objects[0]!.position
    expect(quarter[1]).toBeGreaterThan(5) // same bob-peak assertion scene3d-motion.unit.spec.ts already pins
    const zero = applyMotionToDoc(doc, 0).doc.objects[0]!.position
    expect(zero[1]).toBeCloseTo(5, 6)
  })

  it('an empty tracks array behaves identically to an absent one', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects); box.position = [1, 2, 3]; doc.objects.push(box)
    doc.motion = { duration: 4, fps: 30, loop: true, tracks: [] }
    const out = applyMotionToDoc(doc, 0.5).doc
    expect(out.objects[0]!.position).toEqual([1, 2, 3])
  })
})

describe('animatableTargets: treatments', () => {
  it('emits an id-addressed slider path per treatment dial, labelled with the object and kind', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects); box.name = 'Bottle'
    const blur = createTreatment('blur'); const rim = createTreatment('rimLight')
    box.treatments = [blur, rim]
    doc.objects.push(box)
    const targets = animatableTargets(doc)
    const amount = targets.find((t) => t.path === `objects.${box.id}.treatments.${blur.id}.amount`)
    expect(amount).toMatchObject({ label: 'Bottle · Blur amount', min: 0, max: 3 })
    expect(targets.find((t) => t.path === `objects.${box.id}.treatments.${rim.id}.strength`)?.label).toBe('Bottle · Rim light strength')
    // colour rows and switches are not tracks
    expect(targets.find((t) => t.path.endsWith(`.${rim.id}.color`))).toBeUndefined()
    expect(targets.find((t) => t.path.endsWith(`.${blur.id}.invert`))).toBeUndefined()
    expect(targets.find((t) => t.path.endsWith(`.${blur.id}.enabled`))).toBeUndefined()
  })
  it('withholds the progressive-blur ramp targets while Progressive is off, and offers all three once it is on', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects); box.name = 'Bottle'
    const blur = createTreatment('blur')
    box.treatments = [blur]
    doc.objects.push(box)

    const rampPaths = ['rampAngle', 'rampStart', 'rampEnd'].map((f) => `objects.${box.id}.treatments.${blur.id}.${f}`)

    expect((blur as any).progressive).toBe(false) // precondition
    const offPaths = animatableTargets(doc).map((t) => t.path)
    for (const p of rampPaths) expect(offPaths, p).not.toContain(p)

    ;(blur as any).progressive = true
    const onPaths = animatableTargets(doc).map((t) => t.path)
    for (const p of rampPaths) expect(onPaths, p).toContain(p)
  })

  it('a track on a treatment dial writes through the id, and survives reordering the stack', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    const a = createTreatment('fade'); const b = createTreatment('blur')
    box.treatments = [a, b]
    doc.objects.push(box)
    doc.motion.tracks = [track({ path: `objects.${box.id}.treatments.${b.id}.amount`, from: 0, to: 0.8 })]
    // Sampled mid-track (t01 = 0.5) rather than at the end, where a looping track wraps back to `from`.
    expect((applyMotionToDoc(doc, 0.5).doc.objects[0]!.treatments![1] as any).amount).toBeCloseTo(0.4, 5)
    box.treatments = [b, a] // reorder: same id, new index
    expect((applyMotionToDoc(doc, 0.5).doc.objects[0]!.treatments![0] as any).amount).toBeCloseTo(0.4, 5)
    expect((applyMotionToDoc(doc, 0.5).doc.objects[0]!.treatments![1] as any).opacity).toBe(0.5) // fade untouched (its default)
  })
})
