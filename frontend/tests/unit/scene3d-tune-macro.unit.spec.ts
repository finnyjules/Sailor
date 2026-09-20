// The 3D Studio tuner's `primitive` MACRO and its ordering contract.
//
// Why this exists: the routing fix (d28a38296) sends "a 3d iridescent diamond" to
// Scene3DStudio, but a freshly added node's SceneDoc has `objects: []` — so the
// tuner that runs straight after the addNode had NOTHING to address. It could set
// doc-level lighting and nothing else: the prompt landed opalescent-on-nothing.
// The macro closes that: `primitive: gem` puts the stone in the scene through the
// studio's OWN creation seam, and the same patch's material overrides land on it.
//
// Only `/api/vibe` is stubbed here (ofetch's imported $fetch, as studioTune.ts
// uses it). Scene3D resolves no catalog, so there is no ambient-global seam to
// stub — unlike the shader macro's twin spec.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.mock('ofetch', () => ({ $fetch: (...args: unknown[]) => fetchMock(...args) }))

import { tuneScene3DNode } from '~/lib/agent/studioTune'
import {
  parseDoc as parseSceneDoc, serializeDoc as serializeSceneDoc,
  defaultDoc, createPrimitive,
  PRIMITIVE_KINDS, NOT_PLACEABLE_KINDS, PLACEABLE_PRIMITIVE_KINDS,
  MACRO_PRIMITIVE_KINDS, MACRO_EXCLUDED_KINDS, MACRO_NONE,
  type SceneDoc, type PrimitiveObject,
} from '~/lib/scene3d/config'
import { PRIMITIVE_PARAMS } from '~/lib/scene3d/primParams'

const KEY = 'test-key'
beforeEach(() => fetchMock.mockReset())

/** A Scene3D node carrying `doc` on its scene_state widget. The widget layout
 *  mirrors what scene3dWidgetIndex looks for. */
function sceneNode(doc: SceneDoc = defaultDoc()): any {
  return {
    id: 'n1',
    data: {
      nodeType: 'Scene3DStudio',
      // The adapter finds the blob by widget NAME, not position.
      widgetDefs: [{ name: 'beauty_image' }, { name: 'scene_state' }],
      widgetsValues: ['', serializeSceneDoc(doc)],
    },
  }
}
const readDoc = (n: any): SceneDoc => parseSceneDoc(String(n.data.widgetsValues[1] ?? ''))
const prims = (d: SceneDoc) => d.objects.filter(o => o.kind === 'primitive') as PrimitiveObject[]
const vibeBody = () => fetchMock.mock.calls[0]![1].body as {
  // `current` is what the model actually reads as "the value right now";
  // describeControls fills it from the spec's `default` when the key resolves to
  // nothing, which is exactly the macro's case (it is a verb, not a config leaf).
  controls: { path: string; options?: string[]; current?: unknown; hint?: string }[]
  guidance?: string
}

describe('the `primitive` macro creates the object through the studio’s own seam', () => {
  it('THE CASE: an EMPTY doc + "a 3d iridescent diamond" yields a real gem, opalescent, in ONE patch', async () => {
    fetchMock.mockResolvedValueOnce({
      rationale: 'an iridescent diamond',
      changes: [
        { key: 'primitive', value: 'gem' },
        { key: 'object.material.type', value: 'opalescent' },
        { key: 'object.material.opalHueShift', value: 120 },
      ],
    })
    const node = sceneNode() // objects: []
    const res = await tuneScene3DNode(node, 'a 3d iridescent diamond', KEY)
    expect(res.ok).toBe(true)

    const doc = readDoc(node)
    const p = prims(doc)
    expect(p).toHaveLength(1)
    expect(p[0]!.primitive).toBe('gem')
    // The material overrides from the SAME patch landed on the NEW object —
    // this is the re-describe half of the ordering contract.
    expect(p[0]!.material.type).toBe('opalescent')
    expect(p[0]!.material.opalHueShift).toBe(120)
  })

  it('seeds the gem’s own geometry params, exactly as createPrimitive would', async () => {
    fetchMock.mockResolvedValueOnce({ rationale: '', changes: [{ key: 'primitive', value: 'gem' }] })
    const node = sceneNode()
    await tuneScene3DNode(node, 'a gem', KEY)

    const made = prims(readDoc(node))[0]!
    // Field-for-field what the studio's add menu produces (same seam), so the
    // agent can never mint a shape the picker could not.
    const expected = createPrimitive('gem', [])
    expect(made.primitive).toBe(expected.primitive)
    expect(made.position).toEqual(expected.position)
    expect(made.scale).toEqual(expected.scale)
    expect(made.visible).toBe(true)
    expect(made.name).toBeTruthy()
    // The gem's params are addressable straight after (PRIMITIVE_PARAMS.gem).
    const gemKeys = PRIMITIVE_PARAMS.gem!.map(p => p.key)
    expect(gemKeys).toContain('points')
    expect(gemKeys).toContain('depth')
  })

  it('the macro is offered as a select over the kinds the AGENT can meaningfully add', async () => {
    fetchMock.mockResolvedValueOnce({ rationale: '', changes: [] })
    await tuneScene3DNode(sceneNode(), 'anything', KEY)

    const macro = vibeBody().controls.find(c => c.path === 'primitive')
    expect(macro, 'the `primitive` macro must be in the tuner vocabulary').toBeTruthy()
    expect(macro!.options).toEqual(MACRO_PRIMITIVE_KINDS)
    expect(macro!.options).toContain('gem')
    // Kinds that only ever exist carrying imported data are withheld — the agent
    // has no payload for them, and a blank one is not a shape.
    for (const excluded of NOT_PLACEABLE_KINDS) {
      expect(macro!.options, `${excluded} must not be offered`).not.toContain(excluded)
    }
  })

  it('withholds `text` — the agent cannot set the words, so it could only make a solid reading “Text”', async () => {
    // `object.content.text` is deliberately NOT a control, so a text primitive
    // added from here would be stuck on createPrimitive's placeholder forever.
    // It stays in the STUDIO's own add menu, where the user can type into it.
    expect(PLACEABLE_PRIMITIVE_KINDS).toContain('text')
    expect(MACRO_PRIMITIVE_KINDS).not.toContain('text')

    fetchMock.mockResolvedValueOnce({
      rationale: '', changes: [{ key: 'primitive', value: 'text' }],
    })
    const node = sceneNode()
    await tuneScene3DNode(node, 'the word BLOOM in 3d', KEY)
    expect(prims(readDoc(node)), 'no half-built text solid').toHaveLength(0)
  })

  it('an excluded kind is refused — no object is created', async () => {
    fetchMock.mockResolvedValueOnce({
      rationale: '', changes: [{ key: 'primitive', value: 'svgPath' }],
    })
    const node = sceneNode()
    const res = await tuneScene3DNode(node, 'an svg path', KEY)
    // validatePatch drops it (not in the select's options), so nothing happens.
    expect(prims(readDoc(node))).toHaveLength(0)
    expect(res.ok).toBe(false)
  })
})

describe('the macro tells the truth about what is in the scene', () => {
  it('an EMPTY scene reads "(none)" — never a shape that is not there', async () => {
    // The default doubles as "what is currently in the scene". Reporting 'box' on
    // an empty doc, next to a hint saying a kind already present is TARGETED, is
    // an invitation to skip the macro entirely — which puts us straight back to
    // the reported bug on the reported prompt.
    fetchMock.mockResolvedValueOnce({ rationale: '', changes: [] })
    await tuneScene3DNode(sceneNode(), 'anything', KEY)

    const macro = vibeBody().controls.find(c => c.path === 'primitive')!
    expect(macro.current).toBe(MACRO_NONE)
    // Display-only: it must be UNSUBMITTABLE. validatePatch keeps a select value
    // only when options includes it, so absence from options is the guarantee.
    expect(macro.options).not.toContain(MACRO_NONE)
  })

  it('"(none)" cannot be submitted as a value', async () => {
    fetchMock.mockResolvedValueOnce({
      rationale: '', changes: [{ key: 'primitive', value: MACRO_NONE }],
    })
    const node = sceneNode()
    const res = await tuneScene3DNode(node, 'nothing', KEY)
    expect(prims(readDoc(node))).toHaveLength(0)
    expect(res.ok).toBe(false)
  })

  it('a non-empty scene reports what IS there', async () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', []))
    fetchMock.mockResolvedValueOnce({ rationale: '', changes: [] })
    await tuneScene3DNode(sceneNode(doc), 'anything', KEY)

    expect(vibeBody().controls.find(c => c.path === 'primitive')!.current).toBe('box')
  })

  it('the ADD row reads "(none) → gem", not "box → gem" — the macro never converts', async () => {
    // The row is the user's only account of what happened. Sourcing "before" from
    // the first primitive of ANY kind made an ADD read as a CONVERSION — the one
    // thing this macro is built never to do.
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', []))
    fetchMock.mockResolvedValueOnce({
      rationale: 'add a gem', changes: [{ key: 'primitive', value: 'gem' }],
    })
    const res = await tuneScene3DNode(sceneNode(doc), 'add a gem', KEY)

    const row = res.rows.find(r => r.label === 'Primitive')!
    expect(row.before).toBe(MACRO_NONE)
    expect(row.after).toBe('gem')
  })

  it('a REDUNDANT macro produces NO row at all, and does not report success on its own', async () => {
    // before === after, so pushTuneRow filters it — which is exactly right: the
    // scene did not change. Previously this reported "Primitive: gem → gem" with
    // ok:true while nothing had happened.
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', []))
    doc.objects.push(createPrimitive('gem', []))
    fetchMock.mockResolvedValueOnce({
      rationale: 'gem it', changes: [{ key: 'primitive', value: 'gem' }],
    })
    const res = await tuneScene3DNode(sceneNode(doc), 'gem it', KEY)

    expect(res.rows.some(r => r.label === 'Primitive')).toBe(false)
    expect(res.rows).toHaveLength(0)
    expect(res.ok, 'nothing changed, so this is not a success').toBe(false)
  })
})

describe('same-kind is a NO-OP that preserves hand-tuned work', () => {
  it('does not duplicate, and does not reset the existing gem’s params', async () => {
    // The guidance's worked example primes the model to send `primitive` on
    // nearly every turn, so `{primitive: gem}` on a doc that ALREADY has a gem is
    // the COMMON case — the shader macro's Critical, in additive form. Appending
    // a second gem each turn would be the same class of silent destruction.
    const doc = defaultDoc()
    const gem = createPrimitive('gem', [])
    gem.params = { ...(gem.params ?? {}), points: 30, depth: 1.7 }
    gem.material = { ...gem.material, type: 'opalescent', opalHueShift: 280 }
    gem.position = [1, 2, 3]
    doc.objects.push(gem)

    fetchMock.mockResolvedValueOnce({
      rationale: 'more rainbow',
      changes: [
        { key: 'primitive', value: 'gem' },
        { key: 'object.material.opalStrength', value: 0.8 },
        // A DOC-LEVEL key, so this tune succeeds on its own merits. Without it a
        // total failure (macro never fires, patch all dropped) would satisfy the
        // "no second gem" assertion vacuously — the count would be 1 because
        // nothing ran, not because the guard held. Brightness is one of the simple
        // lighting dials, so it is offered on a default doc (ambient sits behind
        // Advanced lighting and would be dropped as un-offered).
        { key: 'lighting.brightness', value: 1.5 },
      ],
    })
    const node = sceneNode(doc)
    const res = await tuneScene3DNode(node, 'more rainbow', KEY)
    expect(res.ok, 'the tune must actually have run').toBe(true)
    expect(readDoc(node).lighting.brightness).toBe(1.5)

    const p = prims(readDoc(node))
    expect(p, 'a redundant macro must not append a second gem').toHaveLength(1)
    // Hand-tuned geometry + transform survive untouched.
    expect(p[0]!.params?.points).toBe(30)
    expect(p[0]!.params?.depth).toBe(1.7)
    expect(p[0]!.position).toEqual([1, 2, 3])
    expect(p[0]!.material.opalHueShift).toBe(280)
    // …and the same patch's override still lands on that existing gem.
    expect(p[0]!.material.opalStrength).toBe(0.8)
  })

  it('a raw sun dial lands on its own, and a stale "advanced" switch from the model does not take it down', async () => {
    // `lighting.sunIntensity` used to be withheld until `lighting.advanced` was on, so the two
    // had to land in one patch. The Advanced switch is gone (the raw dials live in the
    // Fine-tune card, always reachable in Studio-look mode) — but a model that still emits
    // the old key must only lose THAT key, never the dial beside it.
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', []))
    fetchMock.mockResolvedValueOnce({
      rationale: 'harder sun',
      changes: [
        { key: 'lighting.advanced', value: true },
        { key: 'lighting.sunIntensity', value: 2.5 },
      ],
    })
    const node = sceneNode(doc)
    const res = await tuneScene3DNode(node, 'harder sun', KEY)
    expect(res.ok).toBe(true)
    expect(readDoc(node).lighting.sunIntensity).toBe(2.5)
    expect(readDoc(node).lighting.advanced).toBe(false)     // the retired key is ignored, not applied
  })

  it('a DIFFERENT kind adds alongside rather than mutating what is there', async () => {
    // The studio has no "change this object's kind" concept anywhere (no control
    // names it, and the surface never assigns `.primitive`). So the macro adds,
    // exactly as the add menu does, and the user's box is left alone.
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', []))

    fetchMock.mockResolvedValueOnce({ rationale: '', changes: [{ key: 'primitive', value: 'gem' }] })
    const node = sceneNode(doc)
    await tuneScene3DNode(node, 'add a gem', KEY)

    const p = prims(readDoc(node))
    expect(p.map(o => o.primitive)).toEqual(['box', 'gem'])
  })
})

describe('the macro control is withheld from the Collections bind vocabulary', () => {
  it('`primitive` is a verb, not a config leaf — binding it would write a dead key', async () => {
    // Same hazard the shader macro documents: `sceneBindableControls` feeds the
    // Collections bind menu, where a persisted binding to `primitive` would set a
    // bogus top-level property on the SceneDoc on every sweep row.
    const { sceneBindableControls } = await import('~/lib/scene3d/agentControls')
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('gem', []))
    expect(sceneBindableControls(doc).some(c => c.key === 'primitive')).toBe(false)
  })
})

describe('targeting is deterministic when several objects share a kind', () => {
  it('targets the FIRST matching primitive in doc order, not an arbitrary one', async () => {
    // Two gems is a perfectly ordinary scene. The rule has to be stated and
    // pinned, or "which gem did it tune?" becomes luck of the array.
    const doc = defaultDoc()
    const first = createPrimitive('gem', [])
    const second = createPrimitive('gem', doc.objects)
    doc.objects.push(first, second)

    fetchMock.mockResolvedValueOnce({
      rationale: '',
      changes: [
        { key: 'primitive', value: 'gem' },
        { key: 'object.material.type', value: 'opalescent' },
        { key: 'object.material.opalHueShift', value: 200 },
      ],
    })
    const node = sceneNode(doc)
    await tuneScene3DNode(node, 'make the gem iridescent', KEY)

    const p = prims(readDoc(node))
    expect(p).toHaveLength(2)
    expect(p[0]!.material.type, 'the FIRST gem is the target').toBe('opalescent')
    expect(p[0]!.material.opalHueShift).toBe(200)
    expect(p[1]!.material.type, 'the second gem is untouched').not.toBe('opalescent')
  })
})

describe('placeable-kind derivation', () => {
  it('is PRIMITIVE_KINDS minus the studio’s own NOT_PLACEABLE_KINDS — never a hand-list', () => {
    expect(PLACEABLE_PRIMITIVE_KINDS).toEqual(
      PRIMITIVE_KINDS.filter(k => !NOT_PLACEABLE_KINDS.includes(k)),
    )
    // A new kind added to the studio joins the placeable set automatically.
    expect(PLACEABLE_PRIMITIVE_KINDS.length).toBe(PRIMITIVE_KINDS.length - NOT_PLACEABLE_KINDS.length)
  })

  it('the MACRO set is the placeable set minus what the agent cannot finish', () => {
    // Two different questions: "can the studio place a blank one?" (placeable)
    // and "can the AGENT produce a finished one from a patch?" (macro). `text`
    // answers yes to the first and no to the second.
    expect(MACRO_PRIMITIVE_KINDS).toEqual(
      PLACEABLE_PRIMITIVE_KINDS.filter(k => !MACRO_EXCLUDED_KINDS.includes(k)),
    )
    expect(MACRO_EXCLUDED_KINDS).toContain('text')
  })
})
