import { describe, it, expect } from 'vitest'
import {
  sceneStackControls, sceneAgentControls, sceneBindableControls, SCENE_GUIDANCE,
  SCENE_PRIMITIVE_MACRO_KEY, iterateModifierControls, sceneModifierAwareParams,
} from '~/lib/scene3d/agentControls'
import { SCENE_CONTROLS } from '~/lib/scene3d/controls'
import {
  defaultDoc, createPrimitive, createLight, createGroup, createGlbObject,
  MATERIAL_TYPES, PRIMITIVE_KINDS, ENVIRONMENT_KINDS, PLACEABLE_PRIMITIVE_KINDS,
  type SceneDoc, type PrimitiveKind, type MaterialType, type EnvironmentKind,
} from '~/lib/scene3d/config'
import { PRIMITIVE_PARAMS } from '~/lib/scene3d/primParams'
import { createTreatment } from '~/lib/scene3d/treatments'
import {
  createModifier, addModifier, writeModifierStack, modifierStackOf,
} from '~/lib/scene3d/modifierStack'
import { makeConfigParams } from '~/lib/agent/configParams'

/** Every `WORKED EXAMPLE … {…}` block in the guidance, as `[label, parsed JSON]`.
 *  Balanced-brace scan rather than a regex: the examples nest objects (gradient stops),
 *  and a `[^}]*` match would stop at the first inner brace and silently check a
 *  truncated — or, worse, an unparseable and therefore skipped — example. */
function workedExamples(): [string, Record<string, unknown>][] {
  const out: [string, Record<string, unknown>][] = []
  for (const part of SCENE_GUIDANCE.split('WORKED EXAMPLE').slice(1)) {
    const start = part.indexOf('{')
    expect(start, `WORKED EXAMPLE with no JSON: ${part.slice(0, 60)}`).toBeGreaterThan(-1)
    let depth = 0, end = -1
    for (let i = start; i < part.length; i++) {
      if (part[i] === '{') depth++
      else if (part[i] === '}' && --depth === 0) { end = i + 1; break }
    }
    expect(end, `unbalanced braces in: ${part.slice(0, 60)}`).toBeGreaterThan(start)
    out.push([part.slice(0, start).trim().slice(0, 60), JSON.parse(part.slice(start, end)) as Record<string, unknown>])
  }
  return out
}

// stripMeta is not exported — tested indirectly through the public functions, same
// as vectortype/shapefx's own agentControls specs would (no module exposes it either).
// Assert its contract directly here since the brief calls it out by name: every emitted
// control must have exactly none of the four schema-only fields, and everything else
// from SCENE_CONTROLS must survive untouched.
describe('stripMeta (via sceneBindableControls doc-level output)', () => {
  it('removes exactly when/agent/animatable/summary and preserves everything else', () => {
    const doc = defaultDoc()
    const out = sceneBindableControls(doc)
    for (const c of out) {
      expect(c).not.toHaveProperty('when')
      expect(c).not.toHaveProperty('agent')
      expect(c).not.toHaveProperty('animatable')
      expect(c).not.toHaveProperty('summary')
    }
    // Spot check a known doc-level control keeps its real fields (key/label/kind/group
    // plus kind-specific fields like min/max/step/default for a slider).
    const fov = out.find((c) => c.key === 'camera.fov')
    expect(fov).toBeTruthy()
    expect(fov!.label).toBe('Field of view')
    expect((fov as any).kind).toBe('slider')
    expect((fov as any).min).toBe(15)
    expect((fov as any).max).toBe(100)
    expect((fov as any).default).toBe(45)
    expect((fov as any).group).toBe('Camera')
  })

  it('a control with agent: false is excluded entirely', () => {
    // Transform controls are `animatable: false` but NOT `agent: false`. The inspector-only
    // material rows Task 5 added (dispersion, the palette/gradient dials, relief.invert, …)
    // ARE `agent: false`, so this now exercises the filter end-to-end rather than
    // structurally: none of them may reach the agent's vocabulary or the binding list,
    // under either the relative `object.*` or the absolute `objects.<id>.*` namespace.
    const doc = defaultDoc()
    const obj = createPrimitive('sphere', doc.objects)
    doc.objects.push(obj)
    const withheld = SCENE_CONTROLS.filter((c) => (c as any).agent === false).map((c) => c.key)
    expect(withheld.length, 'the filter needs a real opt-out to exercise').toBeGreaterThan(0)

    const bindable = sceneBindableControls(doc)
    const agent = sceneAgentControls(doc, obj)
    for (const key of withheld) {
      const rest = key.replace(/^object\./, '')
      const hit = (c: { key: string }) => c.key === key || c.key === `objects.${obj.id}.${rest}`
      expect(bindable.some(hit), `${key} bindable`).toBe(false)
      expect(agent.some(hit), `${key} agent`).toBe(false)
    }
  })
})

describe('sceneStackControls', () => {
  it('emits objects.<id>.<rest> for each object, labelled with the object name', () => {
    const doc: SceneDoc = defaultDoc()
    const box = createPrimitive('box', [])
    box.name = 'My Box'
    doc.objects.push(box)

    const stack = sceneStackControls(doc)
    const colorKey = `objects.${box.id}.material.color`
    const color = stack.find((c) => c.key === colorKey)
    expect(color, colorKey).toBeTruthy()
    expect(color!.label).toBe('My Box · Color')

    const posKey = `objects.${box.id}.position.0`
    const pos = stack.find((c) => c.key === posKey)
    expect(pos, posKey).toBeTruthy()
    expect(pos!.label).toBe('My Box · Position X')
  })

  it('skips an object with a missing, empty, dotted, or all-digit id — never addresses it positionally', () => {
    const doc: SceneDoc = defaultDoc()
    const good = createPrimitive('box', [])
    good.name = 'Good'
    const emptyId = createPrimitive('sphere', [])
    emptyId.name = 'EmptyId'
    ;(emptyId as any).id = ''
    const dottedId = createPrimitive('sphere', [])
    dottedId.name = 'DottedId'
    ;(dottedId as any).id = 'a.b'
    const digitId = createPrimitive('sphere', [])
    digitId.name = 'DigitId'
    ;(digitId as any).id = '123'
    const missingId = createPrimitive('sphere', [])
    missingId.name = 'MissingId'
    delete (missingId as any).id

    doc.objects.push(good, emptyId, dottedId, digitId, missingId)

    const stack = sceneStackControls(doc)

    // The good object IS addressed.
    expect(stack.some((c) => c.key === `objects.${good.id}.material.color`)).toBe(true)

    // None of the unsafe ones produced ANY key naming their id.
    expect(stack.some((c) => c.key.includes('objects..'))).toBe(false)
    expect(stack.some((c) => c.key.includes('a.b'))).toBe(false)
    expect(stack.some((c) => c.key === 'objects.123.material.color')).toBe(false)
    expect(stack.some((c) => c.key.includes('undefined'))).toBe(false)

    // And critically: they were not silently re-addressed by ARRAY POSITION either
    // (e.g. objects.1.*, objects.2.*, ...) — no key contains a bare numeric segment
    // standing in for one of these objects.
    for (const c of stack) {
      const segments = c.key.split('.')
      // segments[1] is the id slot in `objects.<id>.<rest>`
      if (segments[0] === 'objects') {
        expect(/^\d+$/.test(segments[1])).toBe(false)
      }
    }

    // Exactly one object's worth of material.color keys were emitted (the good one).
    const colorKeys = stack.filter((c) => c.key.endsWith('.material.color'))
    expect(colorKeys.length).toBe(1)
  })

  it('evaluates `when` per object: a light yields no material controls, a primitive does', () => {
    const doc: SceneDoc = defaultDoc()
    const light = createLight('point', [])
    light.name = 'Sun'
    const prim = createPrimitive('sphere', [])
    prim.name = 'Ball'
    doc.objects.push(light, prim)

    const stack = sceneStackControls(doc)
    const lightMaterialKeys = stack.filter((c) => c.key.startsWith(`objects.${light.id}.material.`))
    expect(lightMaterialKeys.length).toBe(0)

    const primMaterialKeys = stack.filter((c) => c.key.startsWith(`objects.${prim.id}.material.`))
    expect(primMaterialKeys.length).toBeGreaterThan(0)
    expect(primMaterialKeys.some((c) => c.key === `objects.${prim.id}.material.color`)).toBe(true)

    // Transform controls have no `when` gate — both objects get them.
    expect(stack.some((c) => c.key === `objects.${light.id}.position.0`)).toBe(true)
    expect(stack.some((c) => c.key === `objects.${prim.id}.position.0`)).toBe(true)
  })
})

describe('sceneAgentControls', () => {
  it('ships both the relative object.* namespace and the absolute objects.<id>.* namespace', () => {
    const doc: SceneDoc = defaultDoc()
    const prim = createPrimitive('box', [])
    doc.objects.push(prim)

    const out = sceneAgentControls(doc, prim)
    expect(out.some((c) => c.key === 'object.material.color')).toBe(true)
    expect(out.some((c) => c.key === `objects.${prim.id}.material.color`)).toBe(true)
    // Doc-level groups pass through too.
    expect(out.some((c) => c.key === 'lighting.sunAzimuth')).toBe(true)
  })
})

describe('sceneBindableControls', () => {
  it('contains no relative object.* keys', () => {
    const doc: SceneDoc = defaultDoc()
    const prim = createPrimitive('box', [])
    doc.objects.push(prim)

    const out = sceneBindableControls(doc)
    expect(out.some((c) => c.key.startsWith('object.'))).toBe(false)
    // The absolute twin IS present.
    expect(out.some((c) => c.key === `objects.${prim.id}.material.color`)).toBe(true)
    // Doc-level groups still present.
    expect(out.some((c) => c.key === 'lighting.sunAzimuth')).toBe(true)
  })
})

describe('SCENE_GUIDANCE', () => {
  it('is a non-empty string', () => {
    expect(typeof SCENE_GUIDANCE).toBe('string')
    expect(SCENE_GUIDANCE.length).toBeGreaterThan(100)
  })

  // The routing fix (capabilities.ts) sends "a 3d iridescent diamond" HERE, so the
  // tuner that runs straight after the addNode has to know what those words mean.
  // It described the material only as "thin-film / holographic" — the user-facing
  // words iridescent / opal / gem / diamond appeared nowhere, leaving the model to
  // guess (a gradient material, or just a colour change).
  it('teaches the gem / iridescent recipe in the user\'s own words', () => {
    for (const word of ['iridescent', 'opal', 'gem', 'diamond']) {
      expect(SCENE_GUIDANCE.toLowerCase(), `guidance never says "${word}"`).toContain(word)
    }
  })

  // Detector test, in the shape of geoshape's "guidance names only keys that exist":
  // every identifier the recipe names must be a REAL id in the schema, so a rename
  // or a hallucinated knob fails here rather than at runtime in the vibe call.
  // The recipe splits the two rainbows: thin-film words go to opalescent, foil words to
  // holographic. Pin the routing sentence itself so a rewrite that quietly folds "holographic"
  // back into the opal list fails here rather than in a live vibe call.
  it('routes iridescent words to opalescent and foil words to holographic', () => {
    const opalSentence = SCENE_GUIDANCE.match(/GEM \/ IRIDESCENT RECIPE:[^\n]*?'opalescent'/)?.[0] ?? ''
    for (const word of ['iridescent', 'opalescent', 'opal', 'oil-slick', 'soap bubble', 'rainbow sheen']) {
      expect(opalSentence, `opal list omits "${word}"`).toContain(`"${word}"`)
    }
    expect(opalSentence, 'holographic must not route to opalescent').not.toContain('"holographic"')
    const holoSentence = SCENE_GUIDANCE.match(/"holographic"[^\n]*?'holographic'/)?.[0] ?? ''
    for (const word of ['holographic', 'holo', 'holographic foil', 'holographic sticker', 'glitter foil', 'chrome holo']) {
      expect(holoSentence, `foil list omits "${word}"`).toContain(`"${word}"`)
    }
    expect(SCENE_GUIDANCE).toMatch(/HOLOGRAPHIC FOIL/)
    expect(SCENE_GUIDANCE).toContain('"object.material.type":"holographic"')
    expect(SCENE_GUIDANCE).toContain('"object.material.holoFlakes":0.8')
  })

  it('the recipe names only real material types, primitive kinds, environments and gem params', () => {
    expect(MATERIAL_TYPES).toContain('opalescent')
    expect(MATERIAL_TYPES).toContain('holographic')
    expect(PRIMITIVE_KINDS).toContain('gem')
    expect(ENVIRONMENT_KINDS).toContain('darkStrips')

    // The gem's own geometry params, reached as `object.params.<key>`.
    const gemParams = new Set((PRIMITIVE_PARAMS.gem ?? []).map(p => p.key))
    expect(gemParams.size, 'gem primitive declares no params').toBeGreaterThan(0)
    for (const key of ['points', 'spread', 'depth']) {
      expect(gemParams.has(key), `gem param "${key}" named by guidance does not exist`).toBe(true)
    }
    // …and the guidance must actually reference them, or the check above is vacuous.
    for (const key of ['points', 'spread', 'depth']) {
      expect(SCENE_GUIDANCE, `guidance omits gem param "${key}"`).toContain(key)
    }
  })

  // No control names an object's primitive kind, and the `primitive` macro only
  // ADDS — so the guidance must not promise it can turn a box into a gem.
  it('does not claim it can convert an existing object to another kind', () => {
    expect(SCENE_CONTROLS.some(c => c.key === 'object.kind')).toBe(false)
    expect(SCENE_GUIDANCE).toMatch(/never converts an existing object/)
  })

  // The `primitive` macro's own teaching. Detector test: every id and key the
  // worked example names must be REAL, so a rename fails here rather than in the
  // live vibe call where the model would send a key that silently drops.
  it('teaches the `primitive` macro, and the worked example names only real ids', () => {
    expect(SCENE_GUIDANCE).toContain(SCENE_PRIMITIVE_MACRO_KEY)
    expect(SCENE_GUIDANCE).toMatch(/WORKED EXAMPLE/)

    // EVERY worked example, not just the first: each one teaches the model a set of keys,
    // and an example naming a key that does not exist is a silent drop in the live call.
    const examples = workedExamples()
    expect(examples.length, 'no WORKED EXAMPLE blocks found').toBeGreaterThan(2)

    const declared = new Set(SCENE_CONTROLS.map(c => c.key))
    for (const [label, example] of examples) {
      // The macro's own value must be a placeable kind.
      const kind = example[SCENE_PRIMITIVE_MACRO_KEY] as PrimitiveKind
      expect(PLACEABLE_PRIMITIVE_KINDS, label).toContain(kind)
      if ('object.material.type' in example) {
        expect(MATERIAL_TYPES, label).toContain(example['object.material.type'] as MaterialType)
      }
      if ('lighting.environment' in example) {
        expect(ENVIRONMENT_KINDS, label).toContain(example['lighting.environment'] as EnvironmentKind)
      }

      // Every `object.params.*` key must be a real param OF THE KIND the example
      // creates — the pairing is the point, since params are per-kind.
      const kindParams = new Set((PRIMITIVE_PARAMS[kind] ?? []).map(p => p.key))
      for (const key of Object.keys(example)) {
        if (!key.startsWith('object.params.')) continue
        expect(kindParams.has(key.slice('object.params.'.length)), `${label}: ${key} is not a ${kind} param`).toBe(true)
      }

      // Every `object.material.*` / doc-level key must exist in the schema. The
      // opal* ones are gated behind an opalescent material, which is exactly what
      // one example sets, so assert against the FULL declared vocabulary.
      for (const key of Object.keys(example)) {
        if (key === SCENE_PRIMITIVE_MACRO_KEY || key.startsWith('object.params.')) continue
        expect(declared.has(key), `${label}: ${key} is not a declared control`).toBe(true)
      }
    }
  })
})

describe('texture set vocabulary', () => {
  it('offers texture + tiling for physical types and withholds them otherwise', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box')
    doc.objects.push(box)
    const keys = (d: SceneDoc) => sceneBindableControls(d).map(c => c.key)
    expect(keys(doc)).toContain(`objects.${box.id}.material.texture`)
    expect(keys(doc)).toContain(`objects.${box.id}.material.textureTiling`)
    box.material.type = 'toon'
    expect(keys(doc)).not.toContain(`objects.${box.id}.material.texture`)
    box.material.type = 'opalescent'
    expect(keys(doc)).toContain(`objects.${box.id}.material.texture`)
  })
  it('the texture control is a text control the agent may write', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box')
    doc.objects.push(box)
    const c = sceneBindableControls(doc).find(x => x.key === `objects.${box.id}.material.texture`) as any
    expect(c.kind).toBe('text')
    expect(c.aiEditable).toBe(true)
    expect(c.hint).toMatch(/wood/)
  })
  it('the guide carries the wooden-box example', () => {
    expect(SCENE_GUIDANCE).toContain('"object.material.texture":"wood"')
    expect(SCENE_GUIDANCE).toMatch(/SURFACE TEXTURES/)
  })
})

describe('sceneStackControls: treatments', () => {
  it('names every treatment dial absolutely, by object id and treatment id', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects); box.name = 'Bottle'
    const glow = createTreatment('glow')
    box.treatments = [glow]
    doc.objects.push(box)
    const keys = sceneStackControls(doc).map((c) => c.key)
    expect(keys).toContain(`objects.${box.id}.treatments.${glow.id}.strength`)
    expect(keys).toContain(`objects.${box.id}.treatments.${glow.id}.tint`)
    expect(keys).toContain(`objects.${box.id}.treatments.${glow.id}.invert`)
    const c = sceneStackControls(doc).find((x) => x.key.endsWith(`.${glow.id}.strength`))!
    expect(c.label).toBe('Bottle · Glow strength')
    expect((c as any).when).toBeUndefined()
    expect((c as any).bindable).toBeUndefined()
  })
  it('an object without treatments adds no stack controls', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    expect(sceneStackControls(doc).some((c) => c.key.includes('.treatments.'))).toBe(false)
  })
  // Treatment rows are `bindable: false`, but sceneStackControls strips the flag along with
  // every other schema-only field, so the bind menu can only refuse them by key.
  it('treatment dials reach the agent stack but never the Collections bind menu', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.treatments = [createTreatment('blur')]
    doc.objects.push(box)
    expect(sceneStackControls(doc).some((c) => c.key.includes('.treatments.'))).toBe(true)
    expect(sceneBindableControls(doc).filter((c) => c.key.includes('.treatments.'))).toEqual([])
  })
  // treatments.ts gates the field to primitives and GLBs; a light that somehow carries one
  // (a hand-edited scene_state) must not mint controls the renderer will never honour.
  it('a non-host object carrying treatments mints nothing', () => {
    const doc = defaultDoc()
    const light = createLight('point', doc.objects)
    ;(light as unknown as { treatments: unknown[] }).treatments = [createTreatment('blur')]
    doc.objects.push(light)
    expect(sceneStackControls(doc).some((c) => c.key.includes('.treatments.'))).toBe(false)
  })
  // S5: a FINISH is a treatment like any other from the agent/motion vantage point —
  // iterateTreatmentControls is fully generic over treatmentControls(kind), so opalescence
  // needed no per-kind agent edit to become a motion target and agent control by stable id.
  it('a finish (opalescence) dial is a motion target and agent control by stable id, exactly like any other treatment', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects); box.name = 'Gem'
    const opal = createTreatment('opalescence')
    box.treatments = [opal]
    doc.objects.push(box)
    const keys = sceneStackControls(doc).map((c) => c.key)
    for (const field of ['strength', 'frequency', 'hueShift', 'angleMix']) {
      expect(keys).toContain(`objects.${box.id}.treatments.${opal.id}.${field}`)
    }
    const c = sceneStackControls(doc).find((x) => x.key.endsWith(`.${opal.id}.strength`))!
    expect(c.label).toBe('Gem · Opalescence strength')
    // Not masked — no invert row for a finish.
    expect(keys.some((k) => k.endsWith(`.${opal.id}.invert`))).toBe(false)
  })
})

describe('sceneStackControls / iterateModifierControls: modifiers', () => {
  /** A new-shape primitive whose modifierStack holds one twist row (fixed id for assertions). */
  function twistBox(): { doc: SceneDoc; boxId: string; modId: string } {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.name = 'Bottle'
    const twist = { ...createModifier('twist'), id: 'mod_twist_1', twist: 30 }
    box.modifierStack = writeModifierStack([twist]).modifierStack
    doc.objects.push(box)
    return { doc, boxId: box.id, modId: 'mod_twist_1' }
  }

  it('names every modifier dial absolutely, by object id and modifier id', () => {
    const { doc, boxId, modId } = twistBox()
    const keys = sceneStackControls(doc).map((c) => c.key)
    expect(keys).toContain(`objects.${boxId}.modifierStack.${modId}.twist`)
    expect(keys).toContain(`objects.${boxId}.modifierStack.${modId}.twistAxis`)
    const c = sceneStackControls(doc).find((x) => x.key.endsWith(`.${modId}.twist`))!
    expect(c.label).toBe('Bottle · Twist')
    expect((c as any).bindable).toBeUndefined()
  })

  it('a select param (twistAxis) reaches the agent vocab but is NOT a motion target', () => {
    const { doc, boxId, modId } = twistBox()
    const axis = sceneStackControls(doc).find((c) => c.key === `objects.${boxId}.modifierStack.${modId}.twistAxis`)
    expect(axis).toBeTruthy()
    expect(axis!.kind).toBe('select')
    // optionLabels are stripped from the agent vocab — the model writes raw option values.
    expect((axis as any).optionLabels).toBeUndefined()
  })

  it('folds a LEGACY bag into deterministic-id modifier controls (no writes on read)', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.modifiers = { twist: 90, bend: 45 }
    doc.objects.push(box)
    const keys = sceneStackControls(doc).map((c) => c.key)
    expect(keys).toContain(`objects.${box.id}.modifierStack.mod:twist:0.twist`)
    expect(keys).toContain(`objects.${box.id}.modifierStack.mod:bend:0.bend`)
    // Read-through mints controls without ever writing the array onto the object.
    expect((box as any).modifierStack).toBeUndefined()
  })

  it('a duplicate modifier (two twists) mints two distinct addressable controls', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    let stack = addModifier([], 'twist')
    stack = addModifier(stack, 'twist')
    box.modifierStack = stack
    doc.objects.push(box)
    const twistKeys = sceneStackControls(doc)
      .map((c) => c.key)
      .filter((k) => k.startsWith(`objects.${box.id}.modifierStack.`) && k.endsWith('.twist'))
    expect(twistKeys).toHaveLength(2)
    expect(new Set(twistKeys).size).toBe(2)
    expect(twistKeys[0]).toContain(stack[0]!.id)
    expect(twistKeys[1]).toContain(stack[1]!.id)
  })

  it('GLB, light and group objects mint no modifier controls', () => {
    const doc = defaultDoc()
    const glb = createGlbObject('http://x/y.glb', doc.objects)
    const light = createLight('point', doc.objects)
    const group = createGroup(doc.objects)
    // Even a stray modifierStack on a non-primitive is ignored.
    ;(glb as any).modifierStack = [createModifier('twist')]
    ;(light as any).modifiers = { twist: 90 }
    doc.objects.push(glb, light, group)
    expect(sceneStackControls(doc).some((c) => c.key.includes('.modifierStack.'))).toBe(false)
  })

  it('modifier dials reach the agent stack but never the Collections bind menu', () => {
    const { doc } = twistBox()
    expect(sceneStackControls(doc).some((c) => c.key.includes('.modifierStack.'))).toBe(true)
    expect(sceneBindableControls(doc).filter((c) => c.key.includes('.modifierStack.'))).toEqual([])
  })

  it('reordering rows keeps each control addressing its own row by id', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.modifierStack = [
      { ...createModifier('twist'), id: 'mA', twist: 10 },
      { ...createModifier('bend'), id: 'mB', bend: 20 },
    ]
    doc.objects.push(box)
    // Swap the two rows: the ids travel with them, so the control keys are unchanged.
    box.modifierStack = [box.modifierStack[1]!, box.modifierStack[0]!]
    const keys = sceneStackControls(doc).map((c) => c.key)
    expect(keys).toContain(`objects.${box.id}.modifierStack.mA.twist`)
    expect(keys).toContain(`objects.${box.id}.modifierStack.mB.bend`)
  })

  it('iterateModifierControls visits with the live modifier instance', () => {
    const { doc, modId } = twistBox()
    const seen: string[] = []
    iterateModifierControls(doc, (_c, _obj, _id, mod) => { if (mod.id === modId) seen.push(mod.kind) })
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen)).toEqual(new Set(['twist']))
  })
})

describe('agent apply: modifier writes (materialize on edit + option/index coercion)', () => {
  // The SAME params proxy the scene adapter wires (studioTune.ts): absolute id paths, no live
  // selection (relative prefix resolves to -1, unused here).
  const paramsFor = (config: SceneDoc) =>
    sceneModifierAwareParams(makeConfigParams(() => config, () => -1, 'objects', 'id', 'object'), () => config)

  it('materializes a LEGACY bag on write, lands the twist row, and keeps the Vary bag', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.modifiers = { twist: 90, varyColorStrength: 0.7 }
    doc.objects.push(box)
    const params = paramsFor(doc)
    params[`objects.${box.id}.modifierStack.mod:twist:0.twist`] = 45
    const out = doc.objects[0] as any
    expect(Array.isArray(out.modifierStack)).toBe(true)
    expect(out.modifierStack.find((r: any) => r.id === 'mod:twist:0').twist).toBe(45)
    // materialize KEEPS the legacy bag, so the Vary material uniform survives the first edit.
    expect(out.modifiers.varyColorStrength).toBe(0.7)
  })

  it('lands on a NEW-shape object without re-folding — the row id is untouched', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.modifierStack = [{ ...createModifier('twist'), id: 'mod_t', twist: 0 }]
    doc.objects.push(box)
    const params = paramsFor(doc)
    params[`objects.${box.id}.modifierStack.mod_t.twist`] = 30
    const out = doc.objects[0] as any
    expect(out.modifierStack).toHaveLength(1)
    expect(out.modifierStack[0].id).toBe('mod_t')
    expect(out.modifierStack[0].twist).toBe(30)
  })

  it('coerces an axis SELECT option back to its stored INDEX, and reads the index back as the option', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.modifierStack = [{ ...createModifier('twist'), id: 'mod_t', twist: 10, twistAxis: 1 }]
    doc.objects.push(box)
    const params = paramsFor(doc)
    const key = `objects.${box.id}.modifierStack.mod_t.twistAxis`
    params[key] = 'z' // the option string the model was offered
    expect((doc.objects[0] as any).modifierStack[0].twistAxis).toBe(2) // stored as the numeric index
    expect(params[key]).toBe('z') // read renders the stored index back to its option
  })

  it('leaves a non-modifier path alone (no materialize, plain write-through)', () => {
    const doc = defaultDoc()
    const box = createPrimitive('box', doc.objects)
    box.modifiers = { twist: 90 }
    doc.objects.push(box)
    const params = paramsFor(doc)
    params[`objects.${box.id}.material.roughness`] = 0.5
    expect((doc.objects[0] as any).modifierStack).toBeUndefined()
    expect((doc.objects[0] as any).material.roughness).toBe(0.5)
  })
})
