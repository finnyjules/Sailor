import { describe, it, expect } from 'vitest'
import {
  defaultDoc, createPrimitive, createGlbObject, serializeDoc, parseDoc, PRIMITIVE_KINDS, MATERIAL_TYPES,
  gradientAngles, gradientDirection, gradientStopsOf, MATERIAL_DEFAULTS,
  createLight, LIGHT_KINDS, LIGHT_DEFAULTS, lightIntensityDefault, lightIntensityMax,
  createGroup, sceneHasShaderFill,
  DEFAULT_FONT_URL,
  createSvgPathObject, contentDigest, NOT_PLACEABLE_KINDS, ENVIRONMENT_KINDS,
  IMAGE_WRAPS, IMAGE_FITS, IMAGE_PROJECTIONS, IMAGE_AXES, IMAGE_TILING_RANGE,
  type GradientStop, type SceneMaterial, type PrimitiveObject,
} from '~/lib/scene3d/config'
import { PRIM_GROUPS } from '~/lib/scene3d/primGroups'

describe('scene3d config', () => {
  it('round-trips a document through serialize/parse', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    doc.objects.push(createGlbObject('https://example.com/m.glb', doc.objects))
    const back = parseDoc(serializeDoc(doc))
    expect(back).toEqual(doc)
  })

  it('round-trips the GLB material override flag', () => {
    const doc = defaultDoc()
    const glb = createGlbObject('https://example.com/m.glb', doc.objects)
    glb.materialOverride = true
    glb.material.color = '#ff0000'
    doc.objects.push(glb)
    const back = parseDoc(serializeDoc(doc))
    expect(back).toEqual(doc)
    expect((back.objects[0] as { materialOverride?: boolean }).materialOverride).toBe(true)
  })

  it('leaves an absent override flag absent and drops junk values', () => {
    const doc = defaultDoc()
    doc.objects.push(createGlbObject('https://example.com/m.glb', doc.objects))
    const back = parseDoc(serializeDoc(doc))
    expect('materialOverride' in back.objects[0]!).toBe(false)

    const raw = JSON.parse(serializeDoc(doc))
    raw.objects[0].materialOverride = 'yes'
    expect('materialOverride' in parseDoc(JSON.stringify(raw)).objects[0]!).toBe(false)
  })

  it('parses empty/garbage input to the default document', () => {
    expect(parseDoc('')).toEqual(defaultDoc())
    expect(parseDoc('{not json')).toEqual(defaultDoc())
    expect(parseDoc('{"version":999}')).toEqual(defaultDoc())
  })

  it('creates unique ids and numbered names', () => {
    const objs = [createPrimitive('box', [])]
    const second = createPrimitive('box', objs)
    expect(second.id).not.toBe(objs[0]!.id)
    expect(objs[0]!.name).toBe('Box')
    expect(second.name).toBe('Box 2')
  })

  it('fills missing fields with defaults on parse', () => {
    const doc = defaultDoc()
    const raw = JSON.parse(serializeDoc(doc))
    delete raw.lighting.ambient
    const back = parseDoc(JSON.stringify(raw))
    expect(back.lighting.ambient).toBe(defaultDoc().lighting.ambient)
  })

  it('round-trips a document containing every primitive kind', () => {
    const doc = defaultDoc()
    for (const kind of PRIMITIVE_KINDS) doc.objects.push(createPrimitive(kind, doc.objects))
    expect(PRIMITIVE_KINDS).toHaveLength(19)
    const back = parseDoc(serializeDoc(doc))
    expect(back).toEqual(doc)
    expect(back.objects.map((o) => (o as any).primitive)).toEqual([...PRIMITIVE_KINDS])
  })

  it('drops objects with an unknown primitive kind instead of erroring', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    const raw = JSON.parse(serializeDoc(doc))
    raw.objects.push({ ...raw.objects[0], id: 'obj_bad', primitive: 'blob' })
    const back = parseDoc(JSON.stringify(raw))
    expect(back.objects).toHaveLength(1)
    expect((back.objects[0] as any).primitive).toBe('box')
  })

  it('round-trips every material type with params', () => {
    const doc = defaultDoc()
    const boxFor = (patch: any) => {
      const o = createPrimitive('box', doc.objects)
      Object.assign(o.material, patch)
      doc.objects.push(o)
    }
    // One box per material type, in MATERIAL_TYPES order. Adding a material type
    // means adding a boxFor line here (with its type-specific params) — the
    // coverage assertion below fails with a readable diff until you do.
    boxFor({ type: 'standard' })
    boxFor({ type: 'phong', shininess: 80, specular: '#ffddaa' })
    boxFor({ type: 'toon', toonSteps: 4 })
    boxFor({ type: 'matcap', matcap: 'gold' })
    boxFor({ type: 'glass', ior: 1.8, transmission: 0.9, thickness: 1.2, roughness: 0.1 })
    boxFor({ type: 'gemstone', stone: 'ruby' })
    boxFor({ type: 'fresnel', fresnelColor: '#ff00aa', fresnelPower: 5 })
    boxFor({ type: 'gradient', gradientB: '#123456', gradientAxis: 'z', gradientShading: 'faceted' })
    boxFor({ type: 'opalescent', opalHueShift: 120, opalFrequency: 2, opalAngleMix: 0.5, opalFlowSpeed: 1, opalStrength: 0.8 })
    boxFor({ type: 'holographic', holoStrength: 1.2, holoBands: 4, holoAngle: 30, holoFlakes: 0.5, holoFlakeSize: 0.05, holoGloss: 0.6, holoHueShift: 90 })
    boxFor({ type: 'image', image: 'scene3d_tex_1.png' })
    boxFor({
      type: 'shaderFill', unlit: true,
      shader: {
        effectId: 'crystal_prism', params: { amount: 0.5 }, anchor: 'object', speed: 2, seed: 42,
        input: { type: 'gradient', a: '#ff0000', b: '#00ff00', textColor: '#ffffff', angle: 10, density: 4 },
      },
    })
    // Exact list, not a count: a new material type shows up as an intentional
    // one-line diff here instead of an opaque "expected length 9" failure.
    expect(MATERIAL_TYPES).toEqual([
      'standard', 'phong', 'toon', 'matcap', 'glass', 'gemstone', 'fresnel', 'gradient', 'opalescent', 'holographic', 'image', 'shaderFill',
    ])
    expect(doc.objects.map((o) => o.material.type)).toEqual([...MATERIAL_TYPES])
    const back = parseDoc(serializeDoc(doc))
    expect(back).toEqual(doc)
  })

  it('migrates old materials (no type field) to standard', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    const raw = JSON.parse(serializeDoc(doc))
    delete raw.objects[0].material.type
    const back = parseDoc(JSON.stringify(raw))
    expect((back.objects[0] as any).material.type).toBe('standard')
  })

  it('degrades an unknown material type to standard', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    const raw = JSON.parse(serializeDoc(doc))
    raw.objects[0].material.type = 'hologram'
    const back = parseDoc(JSON.stringify(raw))
    expect((back.objects[0] as any).material.type).toBe('standard')
  })

  it('round-trips every physical surface field', () => {
    const doc = defaultDoc()
    const o = createPrimitive('box', doc.objects)
    Object.assign(o.material, {
      clearcoat: 0.8, clearcoatRoughness: 0.2, sheen: 0.5, sheenColor: '#ffddee',
      emissive: '#220044', emissiveIntensity: 2.5, opacity: 0.7, dispersion: 1.5,
      attenuationColor: '#88ffcc', attenuationDistance: 2, iridescence: 0.9,
      iridescenceIOR: 1.8, envMapIntensity: 2,
    })
    doc.objects.push(o)
    expect(parseDoc(serializeDoc(doc))).toEqual(doc)
  })

  it('round-trips phong shininess and specular exactly', () => {
    const doc = defaultDoc()
    const o = createPrimitive('box', doc.objects)
    Object.assign(o.material, { type: 'phong', shininess: 120, specular: '#aabbcc' })
    doc.objects.push(o)
    expect(parseDoc(serializeDoc(doc))).toEqual(doc)
  })

  it('leaves absent phong fields absent (round-trips stay exact)', () => {
    const doc = defaultDoc()
    const o = createPrimitive('box', doc.objects)
    o.material.type = 'phong'
    doc.objects.push(o)
    const back = parseDoc(serializeDoc(doc)).objects[0]!.material
    expect('shininess' in back).toBe(false)
    expect('specular' in back).toBe(false)
  })

  it('drops a junk shininess but keeps a valid specular on parse', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    const raw: any = JSON.parse(serializeDoc(doc))
    raw.objects[0].material.type = 'phong'
    raw.objects[0].material.shininess = 'bright'
    raw.objects[0].material.specular = '#ff0000'
    const back = parseDoc(JSON.stringify(raw)).objects[0]!.material
    expect('shininess' in back).toBe(false)
    expect(back.specular).toBe('#ff0000')
  })

  it('round-trips primitive geometry params and drops junk ones', () => {
    const doc = defaultDoc()
    const sphere = createPrimitive('sphere', doc.objects)
    sphere.params = { detail: 12, arc: 180 }
    doc.objects.push(sphere)
    const box = createPrimitive('box', doc.objects)
    box.params = { cornerRadius: 0.2, cornerSides: 4 }
    doc.objects.push(box)
    const plain = createPrimitive('cone', doc.objects)
    doc.objects.push(plain)
    expect(parseDoc(serializeDoc(doc))).toEqual(doc)

    const raw = JSON.parse(serializeDoc(doc))
    raw.objects[0].params = { detail: 12, bogus: 5, arc: 9999 }
    const back = parseDoc(JSON.stringify(raw))
    expect((back.objects[0] as any).params).toEqual({ detail: 12, arc: 360 })
    expect((back.objects[2] as any).params).toBeUndefined()
  })

  it('round-trips modifiers and drops junk ones', () => {
    const doc = defaultDoc()
    const o = createPrimitive('box', doc.objects)
    o.modifiers = { twist: 120, subdivide: 2, cloneCount: 4 }
    doc.objects.push(o)
    expect(parseDoc(serializeDoc(doc))).toEqual(doc)

    const raw = JSON.parse(serializeDoc(doc))
    raw.objects[0].modifiers = { twist: 120, bogus: 7, bend: 9999 }
    const back = parseDoc(JSON.stringify(raw))
    expect((back.objects[0] as any).modifiers).toEqual({ twist: 120, bend: 180 })
  })

  it('menu groups cover every primitive kind exactly once, in canonical order', () => {
    const menuKinds = PRIM_GROUPS.flatMap((g) => g.kinds.map((k) => k.kind))
    // PRIM_GROUPS must still cover every kind a user can PLACE, exactly and in
    // order — the drift guard stays strict. `svgPath` is exempt because it has
    // no blank form to place: it only ever arrives carrying imported path data.
    const placeable = PRIMITIVE_KINDS.filter((k) => !NOT_PLACEABLE_KINDS.includes(k))
    expect(menuKinds).toEqual(placeable)
  })

  it('round-trips an svgPath primitive with its path content', () => {
    const doc = defaultDoc()
    const o = createSvgPathObject('M0 0 L10 0 L10 10 Z', doc.objects)
    doc.objects = [o]
    const back = parseDoc(serializeDoc(doc))
    expect(back.objects).toHaveLength(1)
    const p = back.objects[0] as PrimitiveObject
    expect(p.primitive).toBe('svgPath')
    expect(p.content?.path).toBe('M0 0 L10 0 L10 10 Z')
    expect(p.content?.pathKey).toBe(contentDigest('M0 0 L10 0 L10 10 Z'))
  })

  it('gives different pathKeys to different paths', () => {
    expect(contentDigest('M0 0 L10 0 Z')).not.toBe(contentDigest('M0 0 L20 0 Z'))
  })

  it('discards a stored pathKey that disagrees with its path, deriving a fresh one', () => {
    // A hand-edited doc, a bad merge, or a future edit path that rewrites
    // `path` without recomputing the digest can leave the pair mismatched.
    // `pathKey` is a geometry cache key: trusting a stale one would make the
    // engine serve cached geometry for a shape the object no longer has, and
    // the bad pair would keep round-tripping through every save. parseDoc
    // must always re-derive it from `path`, never read the stored value.
    const doc = defaultDoc()
    doc.objects = [createSvgPathObject('M0 0 L10 0 L10 10 Z', [])]
    const raw = JSON.parse(serializeDoc(doc))
    raw.objects[0].content.pathKey = 'not-the-real-digest'
    const back = parseDoc(JSON.stringify(raw))
    const p = back.objects[0] as PrimitiveObject
    expect(p.content?.pathKey).toBe(contentDigest('M0 0 L10 0 L10 10 Z'))
    expect(p.content?.pathKey).not.toBe('not-the-real-digest')
  })

  it('derives a pathKey for a document with a path but no stored pathKey at all', () => {
    // An older document (or one written before pathKey existed) must still
    // get a usable cache key rather than silently going without one.
    const doc = defaultDoc()
    doc.objects = [createSvgPathObject('M0 0 L10 0 L10 10 Z', [])]
    const raw = JSON.parse(serializeDoc(doc))
    delete raw.objects[0].content.pathKey
    const back = parseDoc(JSON.stringify(raw))
    const p = back.objects[0] as PrimitiveObject
    expect(p.content?.pathKey).toBe(contentDigest('M0 0 L10 0 L10 10 Z'))
  })

  it('appends svgPath to PRIMITIVE_KINDS before mesh, and excludes it from the add menu', () => {
    // svgPath is one of two primitives that cannot be PLACED — it exists only as
    // the product of an import — so PRIM_GROUPS deliberately does not carry it.
    // `mesh` was appended after it (see the dedicated mesh doc test), then `gem`
    // after mesh (see the dedicated gem ordering test), so svgPath is
    // third-from-last rather than last.
    expect(PRIMITIVE_KINDS).toContain('svgPath')
    expect(PRIMITIVE_KINDS[PRIMITIVE_KINDS.length - 3]).toBe('svgPath')
    expect(NOT_PLACEABLE_KINDS).toContain('svgPath')
  })

  it('includes text and shape in PRIMITIVE_KINDS, appended last', () => {
    expect(PRIMITIVE_KINDS).toContain('text')
    expect(PRIMITIVE_KINDS).toContain('shape')
    // svgPath was appended after shape, then mesh after svgPath, then gem after
    // mesh (see the dedicated svgPath, mesh, and gem ordering tests).
    expect(PRIMITIVE_KINDS.slice(-5)).toEqual(['text', 'shape', 'svgPath', 'mesh', 'gem'])
  })

  it('appends gem to PRIMITIVE_KINDS last, placeable and covered by the add menu', () => {
    expect(PRIMITIVE_KINDS[PRIMITIVE_KINDS.length - 1]).toBe('gem')
    expect(NOT_PLACEABLE_KINDS).not.toContain('gem')
  })

  it('seeds content only for the text primitive; shape is params-only', () => {
    const text = createPrimitive('text', [])
    expect(text.kind).toBe('primitive')
    expect(text.primitive).toBe('text')
    expect(text.content).toEqual({ text: 'Text', font: DEFAULT_FONT_URL })

    const shape = createPrimitive('shape', [])
    expect(shape.kind).toBe('primitive')
    expect(shape.primitive).toBe('shape')
    expect('content' in shape).toBe(false)
  })

  it('round-trips a text primitive\'s content through serialize/parse', () => {
    const doc = defaultDoc()
    const t = createPrimitive('text', doc.objects)
    t.content = { text: 'Hi', font: '/fonts/x.otf' }
    doc.objects.push(t)
    const back = parseDoc(serializeDoc(doc))
    expect(back).toEqual(doc)
    expect((back.objects[0] as any).content).toEqual({ text: 'Hi', font: '/fonts/x.otf' })
  })

  it('drops malformed content fields, dropping the whole property when it ends empty', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('text', doc.objects))
    const raw: any = JSON.parse(serializeDoc(doc))
    raw.objects[0].content = { text: 5, font: {} }
    const back = parseDoc(JSON.stringify(raw))
    expect('content' in back.objects[0]!).toBe(false)
  })

  it('keeps the valid field of a mixed-validity content object and drops only the invalid one', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('text', doc.objects))
    const raw: any = JSON.parse(serializeDoc(doc))
    raw.objects[0].content = { text: 'Hi', font: {} }
    const back = parseDoc(JSON.stringify(raw))
    expect((back.objects[0] as any).content).toEqual({ text: 'Hi' })
  })
})

// ── Gradient ramp model ──────────────────────────────────────────────────────

const gmat = (patch: Partial<SceneMaterial> = {}): SceneMaterial =>
  ({ type: 'gradient', color: '#9aa3af', roughness: 0.6, metalness: 0, ...patch })

/** Parse one material through a full doc round-trip. */
function reparse(mat: SceneMaterial): SceneMaterial {
  const doc = defaultDoc()
  const o = createPrimitive('box', doc.objects)
  o.material = mat
  doc.objects.push(o)
  return parseDoc(serializeDoc(doc)).objects[0]!.material
}

/** Same, but starting from arbitrary (possibly malformed) raw material JSON. */
function reparseRaw(raw: any): SceneMaterial {
  const doc = defaultDoc()
  doc.objects.push(createPrimitive('box', doc.objects))
  const json: any = JSON.parse(serializeDoc(doc))
  json.objects[0].material = raw
  return parseDoc(JSON.stringify(json)).objects[0]!.material
}

describe('scene3d gradient ramp model', () => {
  it('round-trips stops and every new gradient field exactly', () => {
    const mat = gmat({
      gradientStops: [{ pos: 0, color: '#ff0000' }, { pos: 0.4, color: '#00ff00' }, { pos: 1, color: '#0000ff' }],
      gradientType: 'radial', gradientYaw: 37.5, gradientPitch: -12,
      gradientOffset: -0.25, gradientSpread: 1.75,
    })
    expect(reparse(mat)).toEqual(mat)
  })

  it('leaves absent gradient fields absent (round-trips stay exact)', () => {
    const back = reparse(gmat())
    expect('gradientStops' in back).toBe(false)
    expect('gradientType' in back).toBe(false)
    expect('gradientYaw' in back).toBe(false)
    expect('gradientPitch' in back).toBe(false)
    expect('gradientOffset' in back).toBe(false)
    expect('gradientSpread' in back).toBe(false)
  })

  it('clamps out-of-range stop positions and sorts unsorted input', () => {
    const back = reparseRaw({
      ...gmat(),
      gradientStops: [{ pos: 1.8, color: '#111111' }, { pos: -3, color: '#222222' }, { pos: 0.5, color: '#333333' }],
    })
    expect(back.gradientStops).toEqual([
      { pos: 0, color: '#222222' }, { pos: 0.5, color: '#333333' }, { pos: 1, color: '#111111' },
    ])
  })

  it('drops the array when fewer than two valid stops survive', () => {
    expect(reparseRaw({ ...gmat(), gradientStops: [{ pos: 0, color: '#fff' }] }).gradientStops).toBeUndefined()
    expect(reparseRaw({ ...gmat(), gradientStops: [] }).gradientStops).toBeUndefined()
    // one malformed entry drops that entry, leaving only one valid → array dropped
    expect(reparseRaw({
      ...gmat(),
      gradientStops: [{ pos: 0, color: '#fff' }, { pos: 'x', color: '#000' }],
    }).gradientStops).toBeUndefined()
  })

  it('drops the array when more than eight stops are given', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ pos: i / 8, color: '#ffffff' }))
    expect(reparseRaw({ ...gmat(), gradientStops: nine }).gradientStops).toBeUndefined()
    const eight = nine.slice(0, 8)
    expect(reparseRaw({ ...gmat(), gradientStops: eight }).gradientStops).toHaveLength(8)
  })

  it('drops malformed entries and keeps the rest when two or more survive', () => {
    const back = reparseRaw({
      ...gmat(),
      gradientStops: [
        { pos: 0, color: '#ff0000' },
        null,
        { pos: 0.5 },                      // no colour
        { color: '#00ff00' },              // no pos
        { pos: NaN, color: '#123456' },    // non-finite
        { pos: 1, color: '#0000ff' },
      ],
    })
    expect(back.gradientStops).toEqual([{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }])
  })

  it('drops a non-array gradientStops without touching other fields', () => {
    const back = reparseRaw({ ...gmat({ gradientType: 'radial' }), gradientStops: 'nope' })
    expect(back.gradientStops).toBeUndefined()
    expect(back.gradientType).toBe('radial')
  })

  it('rejects an unknown gradientType', () => {
    expect(reparseRaw({ ...gmat(), gradientType: 'conic' }).gradientType).toBeUndefined()
  })

  it('gradientStopsOf synthesizes the legacy two-colour pair when absent', () => {
    expect(gradientStopsOf(gmat({ color: '#abcdef' }))).toEqual([
      { pos: 0, color: '#abcdef' }, { pos: 1, color: MATERIAL_DEFAULTS.gradientB },
    ])
    expect(gradientStopsOf(gmat({ color: '#abcdef', gradientB: '#001122' }))).toEqual([
      { pos: 0, color: '#abcdef' }, { pos: 1, color: '#001122' },
    ])
    const stops: GradientStop[] = [{ pos: 0, color: '#000' }, { pos: 1, color: '#fff' }]
    expect(gradientStopsOf(gmat({ gradientStops: stops }))).toBe(stops)
  })

  it('gradientAngles derives from the axis and defers to stored angles', () => {
    expect(gradientAngles(gmat({ gradientAxis: 'x' }))).toEqual({ yaw: 90, pitch: 0 })
    expect(gradientAngles(gmat({ gradientAxis: 'y' }))).toEqual({ yaw: 0, pitch: 90 })
    expect(gradientAngles(gmat({ gradientAxis: 'z' }))).toEqual({ yaw: 0, pitch: 0 })
    // absent axis falls back to the default axis ('y')
    expect(gradientAngles(gmat())).toEqual({ yaw: 0, pitch: 90 })
    // stored angles win, including 0 (which must not be treated as absent)
    expect(gradientAngles(gmat({ gradientAxis: 'x', gradientYaw: 0, gradientPitch: 0 })))
      .toEqual({ yaw: 0, pitch: 0 })
  })

  it('maps the axis presets to exact unit direction vectors', () => {
    const dirOf = (axis: 'x' | 'y' | 'z') => {
      const { yaw, pitch } = gradientAngles(gmat({ gradientAxis: axis }))
      return gradientDirection(yaw, pitch)
    }
    // Exact, not approximate — see the projection-equivalence test in
    // scene3d-materials for why the zeros must be true zeros.
    expect(dirOf('x')).toEqual([1, 0, 0])
    expect(dirOf('y')).toEqual([0, 1, 0])
    expect(dirOf('z')).toEqual([0, 0, 1])
  })

  it('produces unit-length directions for arbitrary angles', () => {
    for (const [yaw, pitch] of [[33, 17], [-120, -45], [200, 89], [0, 0]] as const) {
      const [x, y, z] = gradientDirection(yaw, pitch)
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12)
    }
  })
})

// ── Lights ────────────────────────────────────────────────────────────────

describe('scene3d lights model', () => {
  it('creates each light kind with sane defaults and a unique id/name', () => {
    for (const kind of LIGHT_KINDS) {
      const l = createLight(kind, [])
      expect(l.kind).toBe('light')
      expect(l.light).toBe(kind)
      expect(l.id).toMatch(/^obj_/)
      expect(typeof l.name).toBe('string')
      expect(l.color).toBe(LIGHT_DEFAULTS.color)
      expect(l.intensity).toBeGreaterThan(0)
      // dummy material present (type uniformity), position off the origin
      expect(l.material).toBeTruthy()
      expect(l.position.some((c) => c !== 0)).toBe(true)
    }
  })

  it('scales point/spot intensity higher than area (physical candela falloff)', () => {
    // point/spot use inverse-square decay, so they need far larger values than a
    // no-decay area light to read bright — spawn defaults and slider ceilings reflect that.
    expect(lightIntensityDefault('point')).toBeGreaterThan(lightIntensityDefault('rect'))
    expect(lightIntensityDefault('spot')).toBeGreaterThan(lightIntensityDefault('rect'))
    expect(lightIntensityMax('point')).toBeGreaterThan(lightIntensityMax('rect'))
    expect(createLight('spot', []).intensity).toBe(lightIntensityDefault('spot'))
    expect(createLight('rect', []).intensity).toBe(lightIntensityDefault('rect'))
  })

  it('numbers duplicate light names', () => {
    const a = createLight('point', [])
    const b = createLight('point', [a])
    expect(b.name).not.toBe(a.name)
  })

  it('round-trips a light through parse/serialize with clamped fields', () => {
    const l = createLight('spot', [])
    l.intensity = 5; l.angle = 0.7; l.penumbra = 0.5; l.color = '#ff8800'; l.castShadow = true
    const doc = { ...defaultDoc(), objects: [l] }
    const back = parseDoc(serializeDoc(doc))
    const r = back.objects[0] as any
    expect(r.kind).toBe('light')
    expect(r.light).toBe('spot')
    expect(r.intensity).toBe(5)
    expect(r.color).toBe('#ff8800')
    expect(r.castShadow).toBe(true)
  })

  it('drops an unknown light kind and keeps old docs unchanged', () => {
    const doc = parseDoc(JSON.stringify({ version: 1, objects: [{ kind: 'light', light: 'laser', id: 'x', name: 'x' }] }))
    expect(doc.objects.length).toBe(0)
  })

  it('round-trips a group and its child through serialize/parse', () => {
    const doc = defaultDoc()
    const group = createGroup(doc.objects)
    const child = createPrimitive('box', doc.objects)
    child.parentId = group.id
    doc.objects = [group, child]
    const back = parseDoc(serializeDoc(doc))
    expect(back.objects).toHaveLength(2)
    expect(back.objects[0]!.kind).toBe('group')
    expect(back.objects[1]!.parentId).toBe(group.id)
  })

  it('drops a parentId pointing at an object an older build deleted', () => {
    const doc = defaultDoc()
    const child = createPrimitive('box', doc.objects)
    child.parentId = 'a-group-that-is-gone'
    doc.objects = [child]
    const back = parseDoc(serializeDoc(doc))
    expect(back.objects).toHaveLength(1)
    expect(back.objects[0]!.parentId).toBeUndefined()
  })

  it('breaks a parentId cycle rather than preserving it', () => {
    const doc = defaultDoc()
    const a = createPrimitive('box', doc.objects)
    const b = createPrimitive('sphere', doc.objects)
    a.parentId = b.id
    b.parentId = a.id
    doc.objects = [a, b]
    const back = parseDoc(serializeDoc(doc))
    expect(back.objects.filter((o) => o.parentId)).toHaveLength(1)
  })

  it('a scene of groups never switches on the shader-field refresh', () => {
    const doc = defaultDoc()
    doc.objects = [createGroup(doc.objects)]
    expect(sceneHasShaderFill(doc)).toBe(false)
  })

  describe('lighting environment', () => {
    // A fresh scene is seeded to the "Softbox beauty" look (lib/scene3d/lighting.ts), so its
    // raw environment is `softbox`, not the old `room` default.
    it('defaults to softbox', () => {
      expect(defaultDoc().lighting.environment).toBe('softbox')
    })

    it('round-trips every environment kind', () => {
      for (const kind of ENVIRONMENT_KINDS) {
        const doc = defaultDoc()
        doc.lighting.environment = kind
        expect(parseDoc(serializeDoc(doc)).lighting.environment).toBe(kind)
      }
    })

    it('normalizes missing and invalid environment to softbox', () => {
      const raw = JSON.parse(serializeDoc(defaultDoc()))
      delete raw.lighting.environment
      expect(parseDoc(JSON.stringify(raw)).lighting.environment).toBe('softbox')
      raw.lighting.environment = 'disco'
      expect(parseDoc(JSON.stringify(raw)).lighting.environment).toBe('softbox')
    })
  })
})

describe('texture set fields', () => {
  it('round-trips texture and textureTiling on a material', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box')
    obj.material.texture = 'ambientcg:Wood095'
    obj.material.textureTiling = 2.5
    doc.objects.push(obj)
    const back = parseDoc(serializeDoc(doc))
    const m = (back.objects[0] as any).material
    expect(m.texture).toBe('ambientcg:Wood095')
    expect(m.textureTiling).toBe(2.5)
  })
  it('keeps an unresolved phrase and drops junk', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box')
    ;(obj.material as any).texture = 'wood'
    ;(obj.material as any).textureTiling = 'nope'
    doc.objects.push(obj)
    const m = (parseDoc(serializeDoc(doc)).objects[0] as any).material
    expect(m.texture).toBe('wood')
    expect(m.textureTiling).toBeUndefined()
  })
  it('drops an empty texture string', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box')
    ;(obj.material as any).texture = ''
    doc.objects.push(obj)
    expect((parseDoc(serializeDoc(doc)).objects[0] as any).material.texture).toBeUndefined()
  })
  it('has a default tiling of 1', () => {
    expect(MATERIAL_DEFAULTS.textureTiling).toBe(1)
  })
})

describe('image material options', () => {
  it('defaults describe a plain, untransformed picture', () => {
    expect(MATERIAL_DEFAULTS.imageWrap).toBe('clamp')
    expect(MATERIAL_DEFAULTS.imageTiling).toBe(1)
    expect(MATERIAL_DEFAULTS.imageTilingLinked).toBe(true)
    expect(MATERIAL_DEFAULTS.imageOffsetX).toBe(0)
    expect(MATERIAL_DEFAULTS.imageOffsetY).toBe(0)
    expect(MATERIAL_DEFAULTS.imageRotation).toBe(0)
    expect(MATERIAL_DEFAULTS.imageFlipX).toBe(false)
    expect(MATERIAL_DEFAULTS.imageFlipY).toBe(false)
    expect(MATERIAL_DEFAULTS.imageFit).toBe('stretch')
    expect(MATERIAL_DEFAULTS.imageTint).toBe('#ffffff')
    expect(MATERIAL_DEFAULTS.imageAlpha).toBe(false)
    expect(MATERIAL_DEFAULTS.imageCutout).toBe(0)
    expect(MATERIAL_DEFAULTS.imageGlow).toBe(0)
    expect(MATERIAL_DEFAULTS.imageBrightness).toBe(0)
    expect(MATERIAL_DEFAULTS.imageContrast).toBe(1)
    expect(MATERIAL_DEFAULTS.imageSaturation).toBe(1)
    expect(MATERIAL_DEFAULTS.imageProjection).toBe('uv')
    expect(MATERIAL_DEFAULTS.imageProjectionAxis).toBe('y')
    expect(MATERIAL_DEFAULTS.imageBoxBlend).toBe(0.25)
    expect(MATERIAL_DEFAULTS.imageSeamless).toBe(0)
  })

  it('every option list contains its own default', () => {
    expect(IMAGE_WRAPS).toContain(MATERIAL_DEFAULTS.imageWrap)
    expect(IMAGE_FITS).toContain(MATERIAL_DEFAULTS.imageFit)
    expect(IMAGE_PROJECTIONS).toContain(MATERIAL_DEFAULTS.imageProjection)
    expect(IMAGE_AXES).toContain(MATERIAL_DEFAULTS.imageProjectionAxis)
    expect(IMAGE_TILING_RANGE.min).toBeGreaterThan(0)
    expect(IMAGE_TILING_RANGE.max).toBeGreaterThan(IMAGE_TILING_RANGE.min)
  })

  it('round-trips every image option through the document parser', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box', doc.objects)
    Object.assign(obj.material, {
      type: 'image', image: 'a.png',
      imageWrap: 'mirror', imageTiling: 3, imageTilingY: 5, imageTilingLinked: false,
      imageOffsetX: 0.25, imageOffsetY: -0.25, imageRotation: 45,
      imageFlipX: true, imageFlipY: true, imageFit: 'cover',
      imageTint: '#ff8800', imageAlpha: true, imageCutout: 0.4, imageGlow: 2,
      imageBrightness: 0.2, imageContrast: 1.4, imageSaturation: 0.5,
      imageProjection: 'cylindrical', imageProjectionAxis: 'z', imageBoxBlend: 0.5,
      imageSeamless: 0.2,
    })
    doc.objects.push(obj)
    const back = parseDoc(JSON.stringify(doc))
    expect(back.objects[0]!.material).toMatchObject({
      imageWrap: 'mirror', imageTiling: 3, imageTilingY: 5, imageTilingLinked: false,
      imageOffsetX: 0.25, imageOffsetY: -0.25, imageRotation: 45,
      imageFlipX: true, imageFlipY: true, imageFit: 'cover',
      imageTint: '#ff8800', imageAlpha: true, imageCutout: 0.4, imageGlow: 2,
      imageBrightness: 0.2, imageContrast: 1.4, imageSaturation: 0.5,
      imageProjection: 'cylindrical', imageProjectionAxis: 'z', imageBoxBlend: 0.5,
      imageSeamless: 0.2,
    })
  })

  it('drops junk option values rather than storing them', () => {
    const doc = defaultDoc()
    const obj = createPrimitive('box', doc.objects)
    Object.assign(obj.material, { type: 'image', imageWrap: 'nope', imageFit: 7, imageProjection: null })
    doc.objects.push(obj)
    const back = parseDoc(JSON.stringify(doc))
    expect(back.objects[0]!.material.imageWrap).toBeUndefined()
    expect(back.objects[0]!.material.imageFit).toBeUndefined()
    expect(back.objects[0]!.material.imageProjection).toBeUndefined()
  })
})
