import type { Node, Edge } from '@vue-flow/core'
import { assembleWorkflowLinks, repairInvalidNodeIds, seedHasControlWidget } from '~/composables/useFilteredPrompt'
import { schemaInputsFromInfo, schemaOutputsFromInfo, syncNodeInputsWithSchema, syncNodeOutputsWithSchema } from '~/utils/syncNodeOutputs'
import { ensureVarsInput } from '~/lib/collection/varsInput'
import { stashTakesIntoProperties, restoreTakesFromProperties } from '~/lib/canvas/persistTakes'
import { stashCapsuleIntoProperties, restoreCapsuleFromProperties } from '~/lib/canvas/persistCapsule'
import { migrateKineticWorkflow } from '~/lib/vectortype/migrateKinetic'

// LiteGraph workflow format
export interface LiteGraphNode {
  id: number
  type: string
  pos: [number, number]
  size: [number, number]
  flags?: Record<string, any>
  order?: number
  mode?: number // 0=normal, 2=muted, 4=bypassed
  title?: string
  properties?: Record<string, any>
  widgets_values?: any[]
  inputs?: { name: string; type: string; link: number | null }[]
  outputs?: { name: string; type: string; links: number[] | null; slot_index?: number }[]
  color?: string
  bgcolor?: string
}

export interface LiteGraphWorkflow {
  last_node_id: number
  last_link_id: number
  nodes: LiteGraphNode[]
  links: any[] // Array format: [id, origin_id, origin_slot, target_id, target_slot, type]
  groups: any[]
  config: Record<string, any>
  extra: Record<string, any>
  version: number
}

// Type color map (same palette as NodeSearchDialog.vue lines 66-76)
export const TYPE_COLORS: Record<string, string> = {
  // Media types
  IMAGE: '#60a5fa',       // Blue
  VIDEO: '#4ade80',       // Green
  AUDIO: '#f472b6',       // Pink
  '3D': '#fb923c',        // Orange
  MESH: '#fb923c',        // Orange (alias for 3D)
  // Pipeline types
  MODEL: '#c084fc',       // Purple
  CLIP: '#facc15',        // Yellow
  LATENT: '#a78bfa',      // Light purple
  VAE: '#f87171',         // Red
  CONDITIONING: '#fbbf24', // Amber
  MASK: '#34d399',        // Emerald
  CHARACTER: '#f59e0b',   // Amber (cast character reference)
  // The moodboard taste wire (Plan B, Task B4) — warm ochre, distinct from
  // CHARACTER's amber and the scalar slates.
  TASTE: '#d9a35c',
  // A Collection's variable bundle. Studio nodes used to hardcode this pink on
  // the handle itself, which is why the same colour could mean "vars" on one
  // node and nothing in particular on another. NOTE: shares AUDIO's pink —
  // worth separating if the two ever appear on the same node.
  VARS: '#f472b6',        // Pink
  // Scalar types
  INT: '#94a3b8',         // Slate
  FLOAT: '#94a3b8',       // Slate
  STRING: '#94a3b8',      // Slate
}

export function getTypeColor(type: string): string {
  return TYPE_COLORS[type?.toUpperCase()] || '#6b7280'
}

// Cache for /object_info widget specs
const objectInfo = ref<Record<string, any>>({})
let objectInfoFetched = false
// The fetch in flight, if any. A non-forced caller that arrives while one runs
// (e.g. the start modal's build racing the canvas's mount fetch) waits for it
// instead of downloading the whole schema a second time.
let objectInfoInFlight: Promise<Record<string, any>> | null = null

export async function fetchObjectInfo(force = false) {
  if (objectInfoFetched && !force) return objectInfo.value
  if (objectInfoInFlight && !force) return objectInfoInFlight
  const run = (async () => {
    try {
      const data = await $fetch<Record<string, any>>('/object_info')
      objectInfo.value = data
      objectInfoFetched = true
    } catch (err) {
      console.error('[useVueNodes] Failed to fetch object_info:', err)
    }
    return objectInfo.value
  })()
  objectInfoInFlight = run
  try { return await run }
  finally { if (objectInfoInFlight === run) objectInfoInFlight = null }
}

// Widget types that appear as interactive controls (not connection ports)
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])

function isWidgetType(type: string): boolean {
  return WIDGET_TYPES.has(type)
}

export function getInputTooltip(nodeType: string, inputName: string): string | undefined {
  const groups = objectInfo.value[nodeType]?.input
  if (!groups) return undefined
  for (const group of ['required', 'optional'] as const) {
    const spec = groups[group]?.[inputName]
    if (Array.isArray(spec) && spec[1] && typeof spec[1].tooltip === 'string') {
      return spec[1].tooltip
    }
  }
  return undefined
}

export function getWidgetDefs(nodeType: string): any[] {
  const info = objectInfo.value[nodeType]
  if (!info?.input?.required) return []
  const defs: any[] = []

  function processInputGroup(group: Record<string, any>) {
    for (const [name, spec] of Object.entries(group)) {
      const specArr = Array.isArray(spec) ? spec : [spec]
      const config = specArr[1] || {}
      // Combo widgets arrive in two shapes: legacy ComfyUI puts the option list
      // directly as spec[0]; v3 IO nodes emit the string "COMBO" with options in
      // config.options. Capture options from whichever shape is present.
      const isCombo = Array.isArray(specArr[0]) || specArr[0] === 'COMBO'
      const type = isCombo ? 'COMBO' : String(specArr[0])
      const options = Array.isArray(specArr[0])
        ? specArr[0]
        : (isCombo && Array.isArray(config.options) ? config.options : undefined)

      // Skip port-type inputs — they're rendered as handles, not widgets.
      if (!isWidgetType(type)) continue
      // `forceInput: true` flips a would-be widget into a connectable socket.
      // We treat it the same as a port-type here so the Vue node renders an
      // input handle instead of a widget control. Standard ComfyUI behaviour.
      if (config.forceInput) continue

      defs.push({ name, type, options, ...config })

      // Seed-type INT inputs have an extra "control_after_generate" value
      // in LiteGraph's widgets_values. Add a hidden placeholder to keep
      // widgetDefs aligned with widgetsValues. Default to "randomize" so
      // new generators randomize their seed on each Run — `ComfyNodeWidget`
      // lets the user flip this to "fixed" via a lock icon. The slot is added
      // whenever ComfyUI's frontend would (explicit flag OR seed/noise_seed
      // name) — a name-only seed without the slot shifts every later widget by
      // one and breaks validation downstream.
      if (seedHasControlWidget(name, type, config)) {
        defs.push({ name: `${name}_control`, type: 'SEED_CONTROL', default: 'randomize', hidden: true })
      }
    }
  }

  processInputGroup(info.input.required)
  if (info?.input?.optional) {
    processInputGroup(info.input.optional)
  }
  return defs
}

// Subgraph detection: UUID-style node types reference a subgraph definition
export function isSubgraphType(type: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(type)
}

// Maps each unified-artifact Comfy node type to the Vue Flow node component
// that should render it. Adding a new media type (audio, video, …) means
// one entry here + one corresponding entry in the canvas's `nodeTypes` map.
// Legacy nodes (LoadImage / PreviewImage / SaveImage / LoadAudio / etc.)
// stay off this map so existing workflows render as the classic node-box.
export const ARTIFACT_NODE_COMPONENTS: Record<string, string> = {
  Image: 'artifact-image',
  Audio: 'artifact-audio',
  Video: 'artifact-video',
  Text:  'artifact-text',
  // The Compositor is presented as a first-class "Frame" artboard artifact.
  Compositor: 'artifact-frame',
  // The Timeline is a first-class artifact card too (live preview + editor modal).
  Timeline: 'artifact-timeline',
  // The Pose Mannequin node: character thumb + posed-mannequin editor modal.
  PoseMannequin: 'pose-mannequin',
  // The 3D Model viewer: loads a GLB URL into an interactive Three.js viewer.
  Model3D: 'artifact-3d',
  // Real-time GPU shader effects: live WebGL preview + manifest-driven sliders.
  ShaderEffect: 'shader-effect',
  // Space Type: client-side Three.js 3D ribbon typography. Frontend-only config
  // node (no backend class_type) — reopen the editor to re-edit, like the Frame.
  SpaceType: 'space-type',
  // Gradient Studio: client-side WebGL procedural gradient generator. Frontend-only
  // config node (no backend class_type) — like Space Type, reopen to re-edit.
  GradientStudio: 'gradient-studio',
  // Shader Studio: client-side WebGL image shader compositor. Frontend-only
  // config node (no backend class_type) — like Gradient Studio, reopen to re-edit.
  ShaderStudio: 'shader-studio',
  // Texture Studio: client-side WebGL tileable texture generator. Frontend-only
  // config node (no backend class_type) — like Gradient Studio, reopen to re-edit.
  TextureStudio: 'texture-studio',
  // Shape Studio: client-side Three.js faceted flat-shape generator. Frontend-only
  // config node (no backend class_type) — like Gradient Studio, reopen to re-edit.
  ShapeStudio: 'shape-studio',
  // Vector Type: client-side variable-font outline studio (fontkit `getVariation`,
  // real Bézier geometry — not a raster text layer). Frontend-only config node
  // (no backend class_type) — like Gradient Studio, reopen to re-edit.
  VectorType: 'vector-type',
  // Scene3D Studio: real backend node (Scene3DStudio) — stages a Three.js scene
  // and bakes beauty/depth/normal control renders back into its widgets.
  Scene3DStudio: 'scene3d-studio',
  // Shot Director: frontend-only config node for driving video models (Seedance etc.)
  // via a guardrailed shot-sheet UI — no backend class_type, reopen to re-edit.
  ShotDirector: 'shot-director',
  // Character: frontend-only card representing a castable person from the
  // registry (Task 5) — no backend class_type, wires CHARACTER into ShotDirector.
  Character: 'character',
  // Character Sheet is retired (Task 5, sheet-builder folded into the
  // Character Studio) — deliberately absent here. A saved graph's old
  // CharacterSheet node falls through the `|| 'comfy'` default below and
  // renders as a generic node-box; its cast wiring (castEdges.ts) reads
  // node.type/properties directly and is unaffected by which component draws it.
  // Lip-Sync Studio: frontend-only config node for driving a face (character/
  // image/video) with a voice (typed TTS/uploaded audio/clip URL) via a
  // guardrailed sheet UI — no backend class_type, reopen to re-edit. Dispatches
  // to the backend LipSyncNode (class_type) at Generate time (Task 6).
  LipSyncStudio: 'lip-sync',
  // Collection: frontend-only data-table node (rows/columns of named
  // variables) — no backend class_type, reopen to re-edit like Space Type.
  Collection: 'collection',
  // Reference: frontend-only shorthand card for an @name registry entry —
  // no backend class_type, one IMAGE output resolved at submit time (Task 10).
  Reference: 'reference',
  // BatchGrid: frontend-only results deck from Smart Layout batch export —
  // no backend class_type; holds rendered output URLs in properties.
  BatchGrid: 'batch-grid',
  // SketchPile: frontend-only sketch results deck — no backend class_type;
  // holds the batch's /view URLs + provenance in properties.sailor_sketch.
  SketchPile: 'sketch-pile',
  // Moodboard: frontend-only pile card referencing an app-level moodboard
  // library entry by id (properties.sailor_moodboard) — no backend class_type
  // in Plan A (Plan B adds the Python twin + ports). Library owns; nodes reference.
  Moodboard: 'moodboard',
}

// Reverse mapping: when a node has a dangling output of one of these types,
// the auto-materialize step drops the corresponding artifact node downstream.
// Anything not in this map (e.g. LATENT, MASK, CONDITIONING) is left alone.
export const ARTIFACT_NODE_FOR_OUTPUT: Record<string, string> = {
  IMAGE:  'Image',
  AUDIO:  'Audio',
  VIDEO:  'Video',
  STRING: 'Text',
}

// Single source of truth for Vue Flow component routing.
export function getVueFlowType(nodeType: string): string {
  if (nodeType === 'ComfyGateNode') return 'gate'
  return ARTIFACT_NODE_COMPONENTS[nodeType] || 'comfy'
}

// Back-compat alias — older code references the image-specific set.
export const ARTIFACT_IMAGE_NODES = new Set<string>([
  ...Object.keys(ARTIFACT_NODE_COMPONENTS),
])

// Convert a subgraph definition (from workflow.definitions.subgraphs[]) to LiteGraphWorkflow
export function subgraphToLiteGraph(sg: any): LiteGraphWorkflow {
  const nodes: LiteGraphNode[] = [...(sg.nodes || [])]

  // Inject synthetic input node: one output port per subgraph input
  if (sg.inputNode && sg.inputs?.length) {
    const b = sg.inputNode.bounding || [0, 0, 180, 200] // [x, y, w, h]
    nodes.push({
      id: sg.inputNode.id ?? -10,
      type: '__subgraph_input__',
      pos: [b[0], b[1]] as [number, number],
      size: [b[2], b[3]] as [number, number],
      title: 'Inputs',
      outputs: sg.inputs.map((inp: any) => ({
        name: inp.label || inp.name,
        type: inp.type,
        links: inp.linkIds || [],
      })),
      inputs: [],
    })
  }

  // Inject synthetic output node: one input port per subgraph output
  if (sg.outputNode && sg.outputs?.length) {
    const b = sg.outputNode.bounding || [800, 0, 140, 100]
    nodes.push({
      id: sg.outputNode.id ?? -20,
      type: '__subgraph_output__',
      pos: [b[0], b[1]] as [number, number],
      size: [b[2], b[3]] as [number, number],
      title: 'Outputs',
      inputs: sg.outputs.map((out: any) => ({
        name: out.label || out.name,
        type: out.type,
        link: out.linkIds?.[0] ?? null,
      })),
      outputs: [],
    })
  }

  return {
    last_node_id: sg.state?.lastNodeId ?? 0,
    last_link_id: sg.state?.lastLinkId ?? 0,
    nodes,
    links: sg.links || [],
    groups: sg.groups || [],
    config: sg.config || {},
    extra: sg.extra || {},
    version: 0.4,
  }
}

// Use simplified types to avoid Vue Flow's deep recursive generics (TS2589)
type VueFlowNode = Node<Record<string, any>>
type VueFlowEdge = Edge<Record<string, any>>

/**
 * Optional hook for callers that own a `useCanvasGroups()` instance. When
 * provided, group state is round-tripped through the LiteGraph workflow's
 * `groups` array on load / save.
 */
export interface GroupsBridge {
  load: (raw: any[] | undefined | null) => void
  export: () => any[]
}

/**
 * Optional hook for callers that own a `useCanvasAnnotations()` instance.
 * Annotations are a Sailor-only concept, so they live under the
 * `workflow.extra.sailor` namespace where LiteGraph won't touch them.
 */
export interface AnnotationsBridge {
  load: (raw: unknown) => void
  export: () => unknown
}

export function useVueNodes(opts: { groupsBridge?: GroupsBridge; annotationsBridge?: AnnotationsBridge } = {}) {
  const nodes = ref<VueFlowNode[]>([])
  const edges = ref<VueFlowEdge[]>([])
  let lastWorkflow: LiteGraphWorkflow | null = null

  function convertFromLiteGraph(workflow: LiteGraphWorkflow, definitions?: { subgraphs?: any[] }) {
    // Heal nodes saved with an invalid id (null/NaN/"null") before anything reads
    // them — otherwise their links serialize with null endpoints and the run
    // breaks with "No link found in parent graph". Self-perpetuating corruption,
    // so we fix it on load (mutates workflow in place) and remap links by the
    // node's own link refs.
    const repairedIds = repairInvalidNodeIds(workflow as any)
    if (repairedIds.length) {
      console.warn('[Sailor] repaired node(s) with invalid id on load:', repairedIds)
    }
    // Retired node types are rewritten here, BEFORE anything reads the graph:
    // this is the one choke point every load crosses (project open, tab switch,
    // subgraph enter, collab merge), and a per-reader adapter would have to be
    // added to each of them and kept in step forever. Mutates in place, like the
    // id repair above, so `lastWorkflow` and the re-serialize see the new shape.
    const migratedKinetic = migrateKineticWorkflow(workflow as any)
    if (migratedKinetic) {
      console.info(`[Sailor] migrated ${migratedKinetic} KineticType node(s) to Vector Type`)
    }
    lastWorkflow = workflow
    opts.groupsBridge?.load(workflow.groups)
    // Annotations live under workflow.extra.sailor — a namespaced sub-object
    // so other tools that read `extra` for their own purposes won't collide.
    opts.annotationsBridge?.load((workflow.extra as any)?.sailor)

    // Build a lookup map for subgraph definitions
    const subgraphDefs = new Map<string, any>()
    if (definitions?.subgraphs) {
      for (const sg of definitions.subgraphs) {
        if (sg.id) subgraphDefs.set(sg.id, sg)
      }
    }

    // Detect corrupted/missing positions: when every node shares the same
    // coordinates (or pos is missing entirely), workflows persisted with
    // empty positions stack every node at the viewport-center default. Lay
    // them out on a grid as a fallback so the user can at least see and
    // re-organize them. Triggered by either pattern: no pos field at all,
    // or multiple nodes at identical coordinates.
    function posOk(p: unknown): p is [number, number] {
      return Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
    }
    const positionKeys = new Set<string>()
    let collisionCount = 0
    for (const n of workflow.nodes) {
      if (!posOk(n.pos)) continue
      const k = `${n.pos[0]},${n.pos[1]}`
      if (positionKeys.has(k)) collisionCount++
      positionKeys.add(k)
    }
    const needsLayout = workflow.nodes.length > 1 && collisionCount >= workflow.nodes.length - 1
    const COL_WIDTH = 320
    const ROW_HEIGHT = 240
    const PER_ROW = 4
    function fallbackPos(idx: number): [number, number] {
      const row = Math.floor(idx / PER_ROW)
      const col = idx % PER_ROW
      return [40 + col * COL_WIDTH, 40 + row * ROW_HEIGHT]
    }

    nodes.value = workflow.nodes.map((lgNode, idx) => {
      // Resolve the position once so each branch below uses the safe value.
      const safePos: [number, number] = (needsLayout || !posOk(lgNode.pos))
        ? fallbackPos(idx)
        : lgNode.pos as [number, number]
      ;(lgNode as any).pos = safePos // patch so any later code paths see it too
      // Subgraph I/O boundary nodes (synthetic, injected by subgraphToLiteGraph)
      if (lgNode.type === '__subgraph_input__' || lgNode.type === '__subgraph_output__') {
        return {
          id: String(lgNode.id),
          type: 'subgraph-io',
          position: { x: safePos[0], y: safePos[1] },
          data: {
            nodeType: lgNode.type,
            title: lgNode.title || (lgNode.type === '__subgraph_input__' ? 'Inputs' : 'Outputs'),
            inputs: lgNode.inputs || [],
            outputs: lgNode.outputs || [],
            isInput: lgNode.type === '__subgraph_input__',
            size: lgNode.size,
          },
        }
      }

      // Note / MarkdownNote nodes get a dedicated type with their text content
      if (lgNode.type === 'Note' || lgNode.type === 'MarkdownNote') {
        const noteText = lgNode.widgets_values?.[0] || ''
        return {
          id: String(lgNode.id),
          type: 'note',
          position: { x: safePos[0], y: safePos[1] },
          data: {
            nodeType: lgNode.type,
            title: lgNode.title || 'Note',
            text: noteText,
            color: lgNode.color,
            bgcolor: lgNode.bgcolor,
            size: lgNode.size,
          },
        }
      }

      // Gate nodes get a dedicated component
      if (lgNode.type === 'ComfyGateNode') {
        return {
          id: String(lgNode.id),
          type: 'gate',
          position: { x: safePos[0], y: safePos[1] },
          data: {
            nodeType: lgNode.type,
            title: lgNode.title || 'Gate',
            inputs: lgNode.inputs || [],
            outputs: lgNode.outputs || [],
            widgetsValues: lgNode.widgets_values || [],
            widgetDefs: getWidgetDefs(lgNode.type),
            properties: lgNode.properties || {},
            mode: lgNode.mode ?? 0,
            paused: false,
            promptId: null,
          },
        }
      }

      // Enrich subgraph nodes with definition metadata
      const sgDef = isSubgraphType(lgNode.type) ? subgraphDefs.get(lgNode.type) : null

      // Rehydrate any stashed runtime preview (see convertToLiteGraph) back onto
      // node.data so the artifact shows its last generated image after a tab
      // switch / reload, rather than an empty node.
      const stashedPreview = (lgNode.properties as any)?.sailor_preview
      const previewData: any = {}
      if (stashedPreview && typeof stashedPreview === 'object') {
        if (Array.isArray(stashedPreview.images) && stashedPreview.images.length) {
          previewData.images = stashedPreview.images
          if (stashedPreview.animated !== undefined) previewData.animated = stashedPreview.animated
        }
        if (Array.isArray(stashedPreview.audios) && stashedPreview.audios.length) {
          previewData.audios = stashedPreview.audios
        }
        if (typeof stashedPreview.text === 'string' && stashedPreview.text) {
          previewData.text = stashedPreview.text
        }
      }
      // Rehydrate the stashed filmstrip (takes + active pick) — see the stash
      // in convertToLiteGraph. Restored after sailor_preview so takes/activeTakeId
      // land alongside the preview-derived images.
      const stashedTakes = restoreTakesFromProperties(lgNode.properties as any)
      if (stashedTakes) {
        previewData.takes = stashedTakes.takes
        previewData.activeTakeId = stashedTakes.activeTakeId
      }
      // Rehydrate the capsule's resting state (collapsed / hasRun). Same stash
      // pattern; deliberately carries no `running` / `runningSince` — see
      // persistCapsule.ts. Spread as its own object so a future field added to
      // the stash can never leak into previewData's shape.
      const stashedCapsule = restoreCapsuleFromProperties(lgNode.properties as any) ?? {}

      return {
        id: String(lgNode.id),
        type: getVueFlowType(lgNode.type),
        position: { x: safePos[0], y: safePos[1] },
        data: {
          nodeType: lgNode.type,
          title: lgNode.title || sgDef?.name || lgNode.type,
          category: objectInfo.value[lgNode.type]?.category || '',
          outputNode: !!objectInfo.value[lgNode.type]?.output_node,
          priceBadge: objectInfo.value[lgNode.type]?.price_badge || null,
          // Append-only schema sync: saves made before a node type grew extra
          // ports carry a short snapshot forever — append the missing trailing
          // ports from /object_info (never reorder/remove; edges reference
          // ports by index). No-op when the type is unknown. The VueNodeCanvas
          // objectInfo watch only covers the load-order where objectInfo
          // arrives AFTER conversion — this covers project opens in a settled
          // app (found live: a pre-wire GenerateImageNode had no style_in).
          inputs: syncNodeInputsWithSchema(
            lgNode.inputs,
            schemaInputsFromInfo(objectInfo.value[lgNode.type]),
          ) ?? (lgNode.inputs || []),
          outputs: syncNodeOutputsWithSchema(
            lgNode.outputs,
            schemaOutputsFromInfo(objectInfo.value[lgNode.type]),
          ) ?? (lgNode.outputs || []),
          widgetsValues: lgNode.widgets_values || [],
          widgetDefs: getWidgetDefs(lgNode.type),
          properties: lgNode.properties || {},
          ...previewData,
          ...stashedCapsule,
          mode: lgNode.mode ?? 0,
          color: lgNode.color,
          bgcolor: lgNode.bgcolor,
          size: lgNode.size,
          // Subgraph metadata
          isSubgraph: !!sgDef,
          subgraphName: sgDef?.name || null,
          subgraphId: sgDef?.id || null,
          innerNodeCount: sgDef?.nodes?.length || 0,
        },
      }
    }) as VueFlowNode[]

    // Saved workflows predating the Collection→SmartLayout VARS wiring lack
    // the `vars` input handle on SmartLayout nodes — normalize every loaded
    // node so old graphs gain it too (idempotent no-op for everything else).
    for (const n of nodes.value as any[]) ensureVarsInput(n)

    edges.value = (workflow.links || [])
      .filter((link) => link != null)
      .map((link) => {
        const linkArr = Array.isArray(link) ? link : Object.values(link)
        return {
          id: `e-${linkArr[0]}`,
          source: String(linkArr[1]),
          sourceHandle: `output-${linkArr[2]}`,
          target: String(linkArr[3]),
          targetHandle: `input-${linkArr[4]}`,
          type: 'comfy',
          data: { dataType: String(linkArr[5]) },
        }
      }) as VueFlowEdge[]
  }

  function convertToLiteGraph(): LiteGraphWorkflow {
    const base = lastWorkflow || { groups: [], config: {}, extra: {}, version: 0.4 }

    const rawNodes = (nodes.value as any[]).filter((n) => {
      // Exclude synthetic subgraph I/O nodes — they're reconstructed from definitions
      const id = Number(n.id)
      return !(id < 0 && (n.data?.nodeType === '__subgraph_input__' || n.data?.nodeType === '__subgraph_output__'))
    })
    const lgNodes: LiteGraphNode[] = rawNodes.map((n) => {
      const d = n.data || {}
      // Stash runtime preview (generated images/audio/text) into `properties`
      // so it survives serialization. The URLs point to ComfyUI output files
      // that persist server-side, so restoring them rehydrates the artifact
      // preview on tab switch / reload instead of showing an empty node.
      let properties = d.properties
      const preview: any = {}
      if (Array.isArray(d.images) && d.images.length) {
        preview.images = d.images
        if (d.animated !== undefined) preview.animated = d.animated
      }
      if (Array.isArray(d.audios) && d.audios.length) preview.audios = d.audios
      if (typeof d.text === 'string' && d.text) preview.text = d.text
      if (Object.keys(preview).length) {
        properties = { ...(d.properties || {}), sailor_preview: preview }
      }
      // Filmstrip: stash takes + the user's pick alongside the preview — the
      // curated field mapping below would otherwise drop them on every save,
      // wiping filmstrips on reload. (Restored in convertFromLiteGraph.)
      properties = stashTakesIntoProperties(d, properties)
      // Capsule resting state: the spec says the collapsed flag persists with
      // the project, and the curated field mapping below drops anything not
      // stashed — so without this every capsule reverted to a full card on
      // reload. `running` / `runningSince` are excluded on purpose; a saved
      // wall-clock start stamp reloads as a counter that ticks forever.
      properties = stashCapsuleIntoProperties(d, properties)
      return {
        id: Number(n.id),
        type: d.nodeType,
        pos: [n.position.x, n.position.y] as [number, number],
        size: d.size || [220, 120],
        title: d.title,
        inputs: d.inputs,
        outputs: d.outputs,
        widgets_values: (d.nodeType === 'Note' || d.nodeType === 'MarkdownNote') ? [d.text || ''] : d.widgetsValues,
        properties,
        mode: d.mode,
        color: d.color,
        bgcolor: d.bgcolor,
      }
    })

    // Rebuild links and update node references. assembleWorkflowLinks clears
    // existing refs, skips orphaned edges (endpoint node absent from lgNodes —
    // which would otherwise emit a phantom-origin link that ComfyUI's loader
    // turns into a dangling input → "No link found in parent graph" run abort),
    // and returns 1..N contiguous link ids so last_link_id == link count.
    const lgLinks = assembleWorkflowLinks(lgNodes, edges.value as any[])
    const linkId = lgLinks.length

    // Merge annotations into `extra.sailor`, preserving any sibling keys
    // the rest of Sailor (or other tools) might have stashed there.
    const baseExtra = (base.extra && typeof base.extra === 'object') ? { ...base.extra } : {}
    if (opts.annotationsBridge) {
      const existingCnext = (baseExtra as any).sailor && typeof (baseExtra as any).sailor === 'object'
        ? (baseExtra as any).sailor
        : {}
      ;(baseExtra as any).sailor = { ...existingCnext, ...(opts.annotationsBridge.export() as object) }
    }

    const result: any = {
      last_node_id: Math.max(0, ...lgNodes.map((n) => n.id)),
      last_link_id: linkId,
      nodes: lgNodes,
      links: lgLinks,
      // Groups: if a bridge is wired up the canvas owns the source of truth;
      // otherwise pass through whatever was loaded so subgraphs that don't
      // surface a group editor still round-trip cleanly.
      groups: opts.groupsBridge ? opts.groupsBridge.export() : base.groups,
      config: base.config,
      extra: baseExtra,
      version: base.version,
    }
    // Preserve definitions (subgraphs) if present in the original workflow
    if ((base as any).definitions) {
      result.definitions = (base as any).definitions
    }
    return result as LiteGraphWorkflow
  }

  return {
    nodes,
    edges,
    objectInfo,
    convertFromLiteGraph,
    convertToLiteGraph,
    getTypeColor,
    isSubgraphType,
    subgraphToLiteGraph,
  }
}
