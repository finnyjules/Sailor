import { describe, it, expect } from 'vitest'
import { assembleWorkflowLinks, healDanglingLinks, repairInvalidNodeIds, seedHasControlWidget, realignWidgetValues, stripVarsLinks } from '../../app/composables/useFilteredPrompt'
import type { LiteGraphNode } from '../../app/composables/useVueNodes'

// Minimal node factory with one IMAGE input ("images", slot 0) and one IMAGE
// output (slot 0) — mirrors an artifact Image sink / generator.
function node(id: number): LiteGraphNode {
  return {
    id,
    type: 'Image',
    inputs: [{ name: 'images', type: 'IMAGE', link: null }],
    outputs: [{ name: 'IMAGE', type: 'IMAGE', links: null }],
  } as unknown as LiteGraphNode
}

const edge = (source: number, target: number) => ({
  source: String(source),
  target: String(target),
  sourceHandle: 'output-0',
  targetHandle: 'input-0',
  data: { dataType: 'IMAGE' },
})

// VARS edge (Collection → Smart Layout): Collection is a frontend-only
// data-table node with no backend class_type, so this edge must never
// serialize into the prompt (see assembleWorkflowLinks / stripVarsLinks).
const varsEdge = (source: number, target: number) => ({
  source: String(source),
  target: String(target),
  sourceHandle: 'output-0',
  targetHandle: 'input-1',
  data: { dataType: 'VARS' },
})

describe('assembleWorkflowLinks', () => {
  it('wires a valid edge on both endpoints', () => {
    const a = node(1)
    const b = node(2)
    const links = assembleWorkflowLinks([a, b], [edge(1, 2)])

    expect(links).toHaveLength(1)
    expect(links[0]).toEqual([1, 1, 0, 2, 0, 'IMAGE'])
    expect(a.outputs![0].links).toEqual([1])
    expect(b.inputs![0].link).toBe(1)
  })

  it('skips an edge whose SOURCE node is absent (orphaned edge)', () => {
    // Sink b survives; its generator (id 99) was deleted/replaced, leaving an
    // orphaned edge. Emitting a link here would reference a non-existent node:
    // ComfyUI's loader drops that link but b.inputs[0].link survives → dangling
    // → graphToPrompt throws "No link found in parent graph".
    const b = node(2)
    const links = assembleWorkflowLinks([b], [edge(99, 2)])

    expect(links).toHaveLength(0)
    expect(b.inputs![0].link).toBeNull()
  })

  it('skips an edge whose TARGET node is absent', () => {
    const a = node(1)
    const links = assembleWorkflowLinks([a], [edge(1, 99)])

    expect(links).toHaveLength(0)
    expect(a.outputs![0].links).toEqual([])
  })

  it('never emits a link referencing a node outside the serialized set', () => {
    const a = node(1)
    const b = node(2)
    // Mix of valid + two orphaned edges (missing source, missing target).
    const links = assembleWorkflowLinks([a, b], [edge(1, 2), edge(99, 2), edge(1, 88)])

    const ids = new Set([1, 2])
    for (const l of links) {
      expect(ids.has(Number(l[1]))).toBe(true) // origin exists
      expect(ids.has(Number(l[3]))).toBe(true) // target exists
    }
    expect(links).toHaveLength(1)
  })

  it('emits a VARS edge interleaved between IMAGE edges, keeping contiguous ids across all three', () => {
    // Collection (id 3) → SmartLayout's `vars` input (slot 1), sandwiched
    // between two ordinary IMAGE edges. VARS links must persist through
    // assembleWorkflowLinks like any other edge — it's the sole link-builder
    // feeding BOTH execution AND persistence (getWorkflow / snapshotActiveCanvasIntoDoc),
    // so skipping here would silently drop the Collection→target wire on every
    // save/reload cycle. Stripping VARS links now happens ONLY at the execution
    // boundary (stripVarsLinks, called from runVueWorkflow just before queueing).
    const a = node(1)
    const b = node(2)
    const smartLayout = {
      id: 4,
      type: 'SmartLayout',
      inputs: [
        { name: 'images', type: 'IMAGE', link: null },
        { name: 'vars', type: 'VARS', link: null },
      ],
      outputs: [{ name: 'IMAGE', type: 'IMAGE', links: null }],
    } as unknown as LiteGraphNode
    const collection = {
      id: 3,
      type: 'Collection',
      inputs: [],
      outputs: [{ name: 'VARS', type: 'VARS', links: null }],
    } as unknown as LiteGraphNode

    const varsInEdge = { ...varsEdge(3, 4), targetHandle: 'input-1' }
    const links = assembleWorkflowLinks(
      [a, b, smartLayout, collection],
      [edge(1, 2), varsInEdge, edge(2, 4)],
    )

    expect(links).toHaveLength(3)
    expect(links.some((l) => l[5] === 'VARS')).toBe(true)
    expect(links[0]).toEqual([1, 1, 0, 2, 0, 'IMAGE'])
    expect(links[1]).toEqual([2, 3, 0, 4, 1, 'VARS'])
    expect(links[2]).toEqual([3, 2, 0, 4, 0, 'IMAGE'])

    // VARS target input is wired to the VARS link id.
    expect(smartLayout.inputs![1].link).toBe(2)
    // Collection's VARS output picked up the link id.
    expect(collection.outputs![0].links).toEqual([2])
  })

  it('is idempotent on the live objects — a repeat call with unchanged edges rewrites nothing', () => {
    // Regression for the Frame-editor open freeze: convertToLiteGraph hands the
    // LIVE reactive node inputs/outputs into this function by reference, so any
    // write here lands on the graph the deep autosave watch observes. The old
    // code reassigned `output.links = []` (a fresh array) on EVERY call, so a
    // no-op serialize still tripped the watch → re-dirtied → re-serialized: a
    // feedback loop. A repeat call with identical connectivity must now leave the
    // exact same references in place (zero reactive writes).
    const a = node(1)
    const b = node(2)
    assembleWorkflowLinks([a, b], [edge(1, 2)])
    const outRef = a.outputs![0].links
    const inVal = b.inputs![0].link
    expect(outRef).toEqual([1])
    expect(inVal).toBe(1)

    assembleWorkflowLinks([a, b], [edge(1, 2)])
    // Same array IDENTITY (not just equal) ⇒ no reactive set fired.
    expect(a.outputs![0].links).toBe(outRef)
    expect(b.inputs![0].link).toBe(inVal)
  })

  it('still rewrites link fields when connectivity actually changes', () => {
    const a = node(1)
    const b = node(2)
    const c = node(3)
    assembleWorkflowLinks([a, b, c], [edge(1, 2)])
    expect(b.inputs![0].link).toBe(1)
    expect(c.inputs![0].link).toBeNull()

    // Move the edge from b to c.
    assembleWorkflowLinks([a, b, c], [edge(1, 3)])
    expect(b.inputs![0].link).toBeNull()
    expect(c.inputs![0].link).toBe(1)
    expect(a.outputs![0].links).toEqual([1])
  })

  it('round-trips a VARS link tuple: edges → links[] → re-wired inputs, matching a save/reload cycle', () => {
    // Regression for the persistence bug: a workflow's links[] containing a
    // VARS tuple must leave the target input wired when rebuilt — this is the
    // shape convertFromLiteGraph consumes on reload. We can't easily invoke
    // convertFromLiteGraph here (it needs full Vue Flow composable context),
    // so this exercises the same tuple-consumption contract assembleWorkflowLinks
    // produces and stripVarsLinks consumes, proving the wire survives a
    // build → strip-at-boundary → (would-be) reload round trip when the strip
    // is skipped (i.e. the persisted copy, not the execution copy).
    const collection = {
      id: 10,
      type: 'Collection',
      inputs: [],
      outputs: [{ name: 'VARS', type: 'VARS', links: null }],
    } as unknown as LiteGraphNode
    const smartLayout = {
      id: 11,
      type: 'SmartLayout',
      inputs: [{ name: 'vars', type: 'VARS', link: null }],
      outputs: [],
    } as unknown as LiteGraphNode

    // varsEdge's targetHandle is 'input-1', matching Smart Layout's real `vars`
    // slot position (slot 0 in this minimal node stands in for it structurally).
    const varsInEdge = { ...varsEdge(10, 11), targetHandle: 'input-0' }
    const links = assembleWorkflowLinks([collection, smartLayout], [varsInEdge])

    expect(links).toEqual([[1, 10, 0, 11, 0, 'VARS']])
    expect(smartLayout.inputs![0].link).toBe(1)
    expect(collection.outputs![0].links).toEqual([1])
  })
})

describe('stripVarsLinks', () => {
  it('nulls a VARS input link, drops its tuple from links[], and prunes it from the source output — leaving an unrelated IMAGE link untouched', () => {
    // Defense-in-depth pass: a workflow can reach this function with a VARS
    // link already baked in (e.g. a save made before the assembleWorkflowLinks
    // guard existed). Collection has no backend class_type, so a surviving
    // VARS link here would still abort graphToPrompt.
    const wf = {
      nodes: [
        { id: 1, type: 'Gen', inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }] },
        {
          id: 2,
          type: 'SmartLayout',
          inputs: [
            { name: 'images', type: 'IMAGE', link: 1 },
            { name: 'vars', type: 'VARS', link: 2 },
          ],
          outputs: [],
        },
        { id: 3, type: 'Collection', inputs: [], outputs: [{ name: 'VARS', type: 'VARS', links: [2] }] },
      ],
      links: [
        [1, 1, 0, 2, 0, 'IMAGE'],
        [2, 3, 0, 2, 1, 'VARS'],
      ],
    }

    stripVarsLinks(wf as any)

    // VARS input nulled.
    expect(wf.nodes[1].inputs[1].link).toBeNull()
    // VARS tuple removed from links[]; the IMAGE tuple survives untouched.
    expect(wf.links).toEqual([[1, 1, 0, 2, 0, 'IMAGE']])
    // VARS link id pruned from the Collection source output.
    expect(wf.nodes[2].outputs[0].links).toEqual([])
    // Unrelated IMAGE input/output untouched.
    expect(wf.nodes[1].inputs[0].link).toBe(1)
    expect(wf.nodes[0].outputs[0].links).toEqual([1])
  })

  it('is a no-op when no VARS input carries a link', () => {
    const wf = {
      nodes: [
        { id: 1, type: 'Gen', inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [5] }] },
        { id: 2, type: 'Image', inputs: [{ name: 'images', type: 'IMAGE', link: 5 }], outputs: [] },
      ],
      links: [[5, 1, 0, 2, 0, 'IMAGE']],
    }

    stripVarsLinks(wf as any)

    expect(wf.links).toEqual([[5, 1, 0, 2, 0, 'IMAGE']])
    expect(wf.nodes[1].inputs[0].link).toBe(5)
  })
})

describe('healDanglingLinks', () => {
  it('nulls an input.link absent from links[] and reports it', () => {
    const wf = {
      nodes: [
        { id: 7, type: 'Image', inputs: [{ name: 'images', type: 'IMAGE', link: 999 }], outputs: [] },
      ],
      links: [], // 999 is dangling
    }
    const report = healDanglingLinks(wf)

    expect(report).toEqual([
      { nodeId: 7, nodeType: 'Image', slot: 0, inputName: 'images', linkId: 999 },
    ])
    expect(wf.nodes[0].inputs[0].link).toBeNull()
  })

  it('leaves a consistent workflow untouched', () => {
    const wf = {
      nodes: [
        { id: 1, type: 'Gen', inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [5] }] },
        { id: 2, type: 'Image', inputs: [{ name: 'images', type: 'IMAGE', link: 5 }], outputs: [] },
      ],
      links: [[5, 1, 0, 2, 0, 'IMAGE']],
    }
    const report = healDanglingLinks(wf)

    expect(report).toHaveLength(0)
    expect(wf.nodes[1].inputs[0].link).toBe(5)
  })

  it('prunes stale ids from output.links', () => {
    const wf = {
      nodes: [{ id: 1, type: 'Gen', inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [5, 999] }] }],
      links: [[5, 1, 0, 2, 0, 'IMAGE']],
    }
    healDanglingLinks(wf)
    expect(wf.nodes[0].outputs[0].links).toEqual([5])
  })

  it('nulls an input whose link EXISTS but points to a deleted origin node', () => {
    // The InvalidLinkError case: a node re-splice minted a new origin id, but the
    // input keeps a link tuple whose origin node (1783974714869) is gone. The
    // link id (5) is still present in links[], so the id-membership check alone
    // passes it through — then litegraph's resolveInput follows it to the missing
    // node and throws "No input node found for id [..] slot [0] images".
    const wf = {
      nodes: [
        { id: 2, type: 'Inpaint', inputs: [{ name: 'images', type: 'IMAGE', link: 5 }], outputs: [] },
      ],
      links: [[5, 1783974714869, 0, 2, 0, 'IMAGE']], // link 5 present, origin node absent
    }
    const report = healDanglingLinks(wf)

    expect(report).toEqual([
      { nodeId: 2, nodeType: 'Inpaint', slot: 0, inputName: 'images', linkId: 5 },
    ])
    expect(wf.nodes[0].inputs[0].link).toBeNull()
  })

  it('nulls a deleted-origin input inside subgraph definitions too', () => {
    const wf = {
      nodes: [],
      links: [],
      definitions: [
        {
          nodes: [{ id: 3, type: 'Image', inputs: [{ name: 'images', type: 'IMAGE', link: 8 }], outputs: [] }],
          links: [[8, 99999, 0, 3, 0, 'IMAGE']], // origin node 99999 absent from this subgraph
        },
      ],
    }
    const report = healDanglingLinks(wf)
    expect(report).toHaveLength(1)
    expect(wf.definitions[0].nodes[0].inputs[0].link).toBeNull()
  })

  it('heals dangling links inside subgraph definitions too', () => {
    const wf = {
      nodes: [],
      links: [],
      definitions: [
        { nodes: [{ id: 3, type: 'Image', inputs: [{ name: 'images', type: 'IMAGE', link: 42 }], outputs: [] }], links: [] },
      ],
    }
    const report = healDanglingLinks(wf)
    expect(report).toHaveLength(1)
    expect(wf.definitions[0].nodes[0].inputs[0].link).toBeNull()
  })

  // Production definitions shape is `{ subgraphs: [...] }` — NOT a bare array.
  // (Confirmed by flatten-subgraphs fixture + useSubgraphNavigation/useVueNodes.)
  it('heals a deleted-origin body link in the production `{ subgraphs: [...] }` shape', () => {
    const wf = {
      nodes: [],
      links: [],
      definitions: {
        subgraphs: [
          {
            id: 'sg-1',
            name: 'Inpaint',
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            // body node 23's IMAGE input points at link 36 whose origin (24) was deleted
            nodes: [
              { id: 23, type: 'GLSLShader', inputs: [{ name: 'images', type: 'IMAGE', link: 36 }], outputs: [] },
            ],
            links: [[36, 24, 0, 23, 0, 'IMAGE']], // origin node 24 absent from nodes
          },
        ],
      },
    }
    const report = healDanglingLinks(wf)
    expect(report).toHaveLength(1)
    expect(wf.definitions.subgraphs[0].nodes[0].inputs[0].link).toBeNull()
  })

  it('does NOT sever a subgraph boundary link (origin_id -10 / target_id -20)', () => {
    const wf = {
      nodes: [],
      links: [],
      definitions: {
        subgraphs: [
          {
            id: 'sg-1',
            name: 'Inpaint',
            inputNode: { id: -10 }, // boundary input node lives OUTSIDE `nodes`
            outputNode: { id: -20 },
            nodes: [
              { id: 23, type: 'GLSLShader', inputs: [{ name: 'images', type: 'IMAGE', link: 34 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [35] }] },
            ],
            links: [
              [34, -10, 0, 23, 0, 'IMAGE'], // boundary input → body: LEGIT, must survive
              [35, 23, 0, -20, 0, 'IMAGE'], // body → boundary output: LEGIT
            ],
          },
        ],
      },
    }
    const report = healDanglingLinks(wf)
    expect(report).toHaveLength(0)
    expect(wf.definitions.subgraphs[0].nodes[0].inputs[0].link).toBe(34)
  })
})

describe('repairInvalidNodeIds', () => {
  it('reassigns a null id and remaps its links structurally (real-world fixture)', () => {
    // Mirrors the corrupted project: an EditImageNode saved with id:null, sitting
    // between a dog Image artifact and an output Image sink. Links 2 (in) and 3
    // (out) reference the null node by its null endpoint.
    const wf = {
      last_node_id: null,
      nodes: [
        { id: 1781041940865, type: 'GenerateImageNode', inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1] }] },
        { id: 1781042009752, type: 'Image', inputs: [{ name: 'images', type: 'IMAGE', link: 1 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [2] }] },
        { id: null, type: 'EditImageNode', inputs: [{ name: 'input_image', type: 'IMAGE', link: 2 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [3] }] },
        { id: 1781058163192, type: 'Image', inputs: [{ name: 'images', type: 'IMAGE', link: 3 }], outputs: [] },
      ],
      links: [
        [1, 1781041940865, 0, 1781042009752, 0, 'IMAGE'],
        [2, 1781042009752, 0, null, 0, 'IMAGE'],
        [3, null, 0, 1781058163192, 0, 'IMAGE'],
      ],
    }
    const report = repairInvalidNodeIds(wf)

    expect(report).toHaveLength(1)
    expect(report[0].oldId).toBeNull()
    expect(report[0].type).toBe('EditImageNode')
    const newId = report[0].newId
    expect(Number.isFinite(newId)).toBe(true)
    expect(wf.nodes[2].id).toBe(newId)
    // link 2 target and link 3 origin now point at the repaired node
    expect(wf.links[1][3]).toBe(newId)
    expect(wf.links[2][1]).toBe(newId)
    // last_node_id is a real number again, no null endpoints remain
    expect(Number.isFinite(wf.last_node_id as any)).toBe(true)
    for (const l of wf.links) {
      expect(l[1]).not.toBeNull()
      expect(l[3]).not.toBeNull()
    }
  })

  it('treats numeric-string ids as valid and leaves a clean workflow untouched', () => {
    const wf = {
      last_node_id: 2,
      nodes: [
        { id: '1', type: 'A', inputs: [], outputs: [] },
        { id: 2, type: 'B', inputs: [], outputs: [] },
      ],
      links: [],
    }
    expect(repairInvalidNodeIds(wf)).toHaveLength(0)
    expect(wf.nodes.map(n => n.id)).toEqual(['1', 2])
  })

  it('repairs a non-numeric string id ("null") and avoids colliding with existing ids', () => {
    const wf = {
      nodes: [
        { id: 5, type: 'A', inputs: [], outputs: [] },
        { id: 'null', type: 'B', inputs: [], outputs: [] },
      ],
      links: [],
    }
    const report = repairInvalidNodeIds(wf)
    expect(report).toHaveLength(1)
    expect(report[0].newId).toBe(6) // max(5)+1
    expect(wf.nodes[1].id).toBe(6)
  })
})

describe('seedHasControlWidget', () => {
  it('adds the control slot for an explicit flag (GenerateImageNode case)', () => {
    expect(seedHasControlWidget('seed', 'INT', { control_after_generate: true })).toBe(true)
  })

  it('adds the control slot for a seed-named INT with NO flag (EditImageNode case)', () => {
    // The exact bug: flag unset → fall back to name → still needs the slot, or
    // safety_tolerance shifts to 0 (< min 1) and ComfyUI drops the node.
    expect(seedHasControlWidget('seed', 'INT', {})).toBe(true)
    expect(seedHasControlWidget('noise_seed', 'INT', { min: 0 })).toBe(true)
  })

  it('respects an explicit control_after_generate:false even for a seed name', () => {
    expect(seedHasControlWidget('seed', 'INT', { control_after_generate: false })).toBe(false)
  })

  it('does not add the slot for non-seed INTs or non-INT types', () => {
    expect(seedHasControlWidget('safety_tolerance', 'INT', {})).toBe(false)
    expect(seedHasControlWidget('seed', 'STRING', {})).toBe(false)
    expect(seedHasControlWidget('steps', 'INT', { min: 1 })).toBe(false)
  })
})

describe('realignWidgetValues — legacy seed-control migration', () => {
  // EditImageNode schema: model, input_image (port), prompt, aspect_ratio,
  // seed (name-only → control slot), safety_tolerance (min 1), prompt_upsampling,
  // output_format. input_image is forceInput so it's not a widget value.
  const editInfo = {
    EditImageNode: {
      input: {
        required: {
          model: [['Flux Kontext Pro', 'Nano Banana'], {}],
          input_image: ['IMAGE', { forceInput: true }],
          prompt: ['STRING', {}],
          aspect_ratio: [['match_input_image', '1:1'], {}],
          seed: ['INT', { default: 0, min: 0 }],
          safety_tolerance: ['INT', { default: 2, min: 1, max: 6 }],
          prompt_upsampling: ['BOOLEAN', { default: false }],
          output_format: [['png', 'jpg'], {}],
        },
      },
    },
  }

  it('interleaves the missing control slot so safety_tolerance keeps its value', () => {
    // Legacy 7-value array (no control slot) — exactly what corrupted the run.
    const wf = {
      nodes: [{
        type: 'EditImageNode',
        widgets_values: ['Flux Kontext Pro', 'add a black cat next to the dog',
          'match_input_image', 1359004626, 2, false, 'png'],
      }],
    }
    const out = realignWidgetValues(wf as any, editInfo as any)
    const wv = out.nodes[0].widgets_values as any[]
    // model, prompt, aspect_ratio, seed, seed_control, safety_tolerance, prompt_upsampling, output_format
    expect(wv).toEqual(['Flux Kontext Pro', 'add a black cat next to the dog',
      'match_input_image', 1359004626, 'randomize', 2, false, 'png'])
    // The whole point: safety_tolerance lands 2 (>= min 1), not the shifted false→0.
    expect(wv[5]).toBe(2)
  })

  it('leaves an already-aligned 8-value array untouched', () => {
    const aligned = ['Flux Kontext Pro', 'p', 'match_input_image', 7, 'fixed', 3, true, 'png']
    const wf = { nodes: [{ type: 'EditImageNode', widgets_values: [...aligned] }] }
    const out = realignWidgetValues(wf as any, editInfo as any)
    expect(out.nodes[0].widgets_values).toEqual(aligned)
  })
})
