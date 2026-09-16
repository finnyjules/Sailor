<script setup lang="ts">
// Fullscreen editor for the 3D Studio node. StudioModalShell chrome; the
// preview slot hosts a live Three.js viewport (SceneEngine + SceneInteraction),
// the controls rail is doc-driven sections. All state lives in a SceneDoc —
// on bake we render the three passes off-screen, upload them, and write the
// filenames + serialized doc back onto the node's widgets (PoseMannequin flow).
//
// Kit note: the studio control components (StudioSlider/StudioColor/StudioSegmented/
// StudioSelect/StudioSwitch) all use `v-model` (defineModel), and only StudioSlider
// carries a `label` prop — the others take just `options`/nothing, so their labels
// live in surrounding markup (mirrors ShapeStudioSurface.vue). Enum-union fields go
// through string proxies because StudioSegmented/StudioSelect models are `string`.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import * as THREE from 'three'
import {
  Box, Boxes, Plus, Loader2, Upload, Lightbulb, Sparkles, Shuffle, ClipboardPaste,
  ChevronUp, ChevronRight, Shapes,
} from 'lucide-vue-next'
import {
  parseDoc, serializeDoc, createPrimitive, createGlbObject, createLight, createGroup, createDecal,
  MATERIAL_DEFAULTS, LIGHT_KINDS, gradientAngles, gradientStopsOf, opalStopsOf, screenOf,
  DEFAULT_FONT_URL, DECAL_DEFAULTS, sceneHasShaderFill, sceneHasOpalFlow, applySeedStopsToMaterial, NO_BASE_COLOR,
  type SceneDoc, type SceneObject, type PrimitiveObject, type PrimitiveKind, type MaterialType, type GradientStop, type LightKind, type LightObject, type ReliefSpec, type SceneMaterial, type ScreenSpec, type Vec3,
  type DecalObject, type DecalContent,
} from '~/lib/scene3d/config'
import {
  cloneTreatments, createTreatment, findTreatment, isTreatmentHost, maskedTreatmentPlan, newTreatmentId,
  treatmentsOf, unrenderedTreatmentIds, docHasMotionTreatment, TREATMENT_LABELS, type Treatment, type TreatmentKind,
} from '~/lib/scene3d/treatments'
import { sceneScreenVelocities, collectGhostPoses } from '~/lib/scene3d/motion/velocity'
import { treatmentControls, treatmentField } from '~/lib/scene3d/treatmentControls'
import { eulerFromNormal } from '~/lib/scene3d/decals'
import { getLook, resolveLook, resolveDials } from '~/lib/scene3d/lighting'
import { HARMONY_TYPES, HARMONY_LABELS } from '~/lib/color/harmony'
import { MATCAP_IDS, matcapThumb, onTextureError } from '~/lib/scene3d/materials'
import { toHeightPixels, heightGradient, RELIEF_FLAT_THRESHOLD } from '~/lib/scene3d/relief'
import { DEFAULT_SHADER_SPEC, normalizeShaderSpec, type ShaderSpec } from '~/lib/spacetype/fillTile'
import { fetchShaderFxCatalog } from '~/lib/shaderfx/catalog'
import { LIVE_FIELD_CEILING } from '~/lib/shaderfill/descriptor'
import { AVAILABLE_FONTS, loadFont, fontDisplayName, fontCacheGet, parseGoogleFontValue, parseLibraryFontValue } from '~/lib/scene3d/outlines'
import { loadGoogleCatalog, type GoogleFont } from '~/data/google-fonts'
import { libraryToken, resolveLibraryFace, libraryFamily } from '~/data/library-fonts'
import FontPicker from '~/components/vue-canvas/FontPicker.vue'
import TexturePicker from '~/components/vue-canvas/TexturePicker.vue'
import ShapePicker from '~/components/vue-canvas/studio/ShapePicker.vue'
import PalettePicker from '~/components/vue-canvas/studio/PalettePicker.vue'
import { shapeById } from '~/lib/shapes/catalog'
import { shapeToSvg } from '~/lib/shapes/svg'
import { anchorAbove } from '~/lib/shapes/pickerLayout'
import { PRIM_GROUPS } from '~/lib/scene3d/primGroups'
import {
  DEFAULT_PRIM_FACE, resolvePrimFace, primFaceLabel, primFaceIcon,
  LIGHT_KIND_LABELS, DEFAULT_LIGHT_FACE, resolveLightFace, lightFaceLabel,
  DECAL_ENTRIES, DEFAULT_DECAL_FACE, resolveDecalFace, decalFaceLabel, decalFaceIcon,
  type DecalEntryId,
} from '~/lib/scene3d/toolbarFaces'
import { SceneEngine, baseSizeFor, baseVertexCountFor, buildGeometry } from '~/lib/scene3d/engine'
import { convertToMesh, remeshObject, remeshMeshData, solidifyObject, resolutionForTarget, REMESH_RESOLUTION_MAX } from '~/lib/scene3d/toMesh'
import { MESH_VERTEX_CAP, MESH_DEFAULT_TARGET, decodeMesh, encodeMesh, meshDataFromGeometry, geometryFromMeshData, type MeshData } from '~/lib/scene3d/mesh'
import { loadMesh, meshCacheGet } from '~/lib/scene3d/meshCache'
import { SculptSession, commitSculptToDoc } from '~/lib/scene3d/sculpt/session'
import { applyBrush, type BrushKind, type BrushStamp } from '~/lib/scene3d/sculpt/brushes'
import { expandStamp, type SymmetryMode, type SymmetrySpec } from '~/lib/scene3d/sculpt/symmetry'
import Scene3DSculptToolbar from '~/components/vue-canvas/studio/Scene3DSculptToolbar.vue'
import Scene3DViewportActions from '~/components/vue-canvas/studio/Scene3DViewportActions.vue'
import { sculptDecision } from '~/lib/scene3d/sculpt/decision'
import { rebaseMany, groupObjects, ungroupMany, rootObjects, descendantIds, cloneSubtree, axisDeltaWrites, worldMatrixOf } from '~/lib/scene3d/hierarchy'
import { remesh, boundsOf } from '~/lib/scene3d/voxel'
import { mergeMeshes, type MergeOp } from '~/lib/scene3d/voxel/merge'
import Scene3DObjectRow from './studio/Scene3DObjectRow.vue'
import { totalClones, clampedClones } from '~/lib/scene3d/modifiers'
import { MODIFIER_SPECS, modifierValue, varySettingsFor } from '~/lib/scene3d/primParams'
import {
  modifierStackOf, writeModifierStack, canReorderModifier, cloneModifierStack, MODIFIER_LABELS,
  addModifier as addModifierOp, removeModifier as removeModifierOp,
  duplicateModifier as duplicateModifierOp, reorderModifier as reorderModifierOp,
  type ModifierKind, type ModifierInstance,
} from '~/lib/scene3d/modifierStack'
import { modifierControls, modifierField } from '~/lib/scene3d/modifierControls'
import { SceneInteraction, type PlacementHit } from '~/lib/scene3d/interaction'
import { loadGlb, GLB_SIZE_CAP_BYTES } from '~/lib/scene3d/glb'
import { fitGlbGroup } from '~/lib/scene3d/fitGlb'
import { svgToLeafPaths, outlineStrokes, type SvgLeafPath } from '~/composables/useVectorSvg'
import { buildSvgObjects, SVG_SPLIT_THRESHOLD } from '~/lib/scene3d/svgImport'
import { renderPasses } from '~/lib/scene3d/passes'
import { encodeFrames } from '~/lib/engine/encodeVideo'
import { SCENE_TEMPLATES, animateSceneDefaults } from '~/lib/scene3d/motion/defaults'
import { LOOP_OPTIONS, IN_OPTIONS, OUT_OPTIONS, CAMERA_OPTIONS, LOOP_USES_AMOUNT, CAMERA_USES_CYCLES, CAMERA_USES_AMOUNT, setObjectLoop, setObjectTransition, setObjectDirection } from '~/lib/scene3d/motion/panel'
import { sceneHasMotion, renderMotionFrame } from '~/lib/scene3d/motion/render'
import { applyMotionToDoc } from '~/lib/scene3d/motion/apply'
import { EASE_PRESETS, presetKeyForEaseRef, easeRefForPresetKey, easeRefToCurveString, curveStringToEaseRef } from '~/lib/scene3d/motion/easePresets'
import type { LoopKind, TransitionPreset, CameraMotion, Direction } from '~/lib/scene3d/motion/types'
import { detectWebGL } from '~/lib/spacetype/webgl'
import { useInpaint } from '~/composables/useInpaint'
import { downloadBlobAsFile } from '~/lib/studio/downloadBlob'
import { useStudioAutosave } from '~/lib/studio/autosave'
import StudioModalShell from '~/components/vue-canvas/StudioModalShell.vue'
import StudioSection from '~/components/vue-canvas/StudioSection.vue'
import StudioActionsFooter from '~/components/vue-canvas/studio/StudioActionsFooter.vue'
import StudioButton from '~/components/vue-canvas/studio/StudioButton.vue'
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import StudioColor from '~/components/vue-canvas/studio/StudioColor.vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import StudioSelect from '~/components/vue-canvas/studio/StudioSelect.vue'
import StudioSwitch from '~/components/vue-canvas/studio/StudioSwitch.vue'
import StudioRow from '~/components/vue-canvas/studio/StudioRow.vue'
import type { ControlSpec } from '~/lib/spacetype/effect'
import StudioGradientRamp from '~/components/vue-canvas/studio/StudioGradientRamp.vue'
// The ONE Vary swatch-list editor, shared with the Frame cloner panel.
import VaryPalette from '~/components/vue-canvas/VaryPalette.vue'
import StudioControlPanel from '~/components/vue-canvas/studio/StudioControlPanel.vue'
import ShaderFillEditor from '~/components/vue-canvas/widgets/ShaderFillEditor.vue'
import Scene3DMotionTimeline from '~/components/vue-canvas/Scene3DMotionTimeline.vue'
import CurveEditor from '~/components/vue-canvas/CurveEditor.vue'
import {
  ENV_BY_LABEL, SCENE_PANEL_SECTIONS, SCENE_TRANSFORM_SECTIONS, SCENE_GEOMETRY_SECTIONS,
  readSceneControl, scenePanelChrome, scenePanelControls, writeMaterialField, isNoOpTransformCommit,
} from '~/lib/scene3d/panelPresentation'
import { setByPath } from '~/lib/studio/path'
import { showIfVisible } from '~/lib/studio/sections'
import type { PostSettings } from '~/lib/spacetype/post'

const props = withDefaults(defineProps<{ nodeId: string; nodes?: any[]; edges?: any[] }>(), {
  nodes: () => [], edges: () => [],
})
const emit = defineEmits<{ close: [] }>()

// Node widget access — same conventions as PoseEditorModal (widgetDefs/widgetsValues).
const node = computed(() => props.nodes.find((n: any) => String(n.id) === String(props.nodeId)))
function widgetIdx(name: string): number { return node.value?.data?.widgetDefs?.findIndex((w: any) => w.name === name) ?? -1 }
function widgetStr(name: string): string { const i = widgetIdx(name); return i >= 0 ? String(node.value?.data?.widgetsValues?.[i] ?? '') : '' }
function setWidget(name: string, value: any) {
  const i = widgetIdx(name)
  if (i >= 0 && node.value?.data?.widgetsValues) node.value.data.widgetsValues[i] = value
}

// ── Document state ────────────────────────────────────────────────────────────
const doc = reactive<SceneDoc>(parseDoc(widgetStr('scene_state')))
// Selection is an ORDERED list; the LAST entry is the primary (the anchor the
// properties panel titles itself after, and the object a single-selection gizmo
// attaches to). `selectedId` stays available as a computed so the dozen
// existing single-selection readers keep working unchanged — but note it is
// WRITABLE, and writing it REPLACES the selection. Any code that needs to add
// to the selection must go through `toggleSelected`.
const selectedIds = ref<string[]>([])
const selectedId = computed<string | null>({
  get: () => selectedIds.value[selectedIds.value.length - 1] ?? null,
  set: (id) => { selectedIds.value = id ? [id] : [] },
})
const selectedObjects = computed<SceneObject[]>(() =>
  selectedIds.value
    .map((id) => doc.objects.find((o) => o.id === id))
    .filter((o): o is SceneObject => !!o))
// A one-object "group" is a legal state groupObjects would happily create, but
// it is pointless (nothing to keep together) and the toolbar deliberately
// doesn't offer it — hence >= 2, not >= 1.
// Decals are never groupable: `groupObjects` re-parents members under the new
// group and rebases their position/rotation into it, but a decal's position and
// rotation are the projection point and projector orientation in its TARGET'S
// local space — rebasing them re-projects the sticker to a meaningless pose, and
// the moved parentId would also drop it out of its target's delete cascade
// (which is parentId-based, see removeObject/descendantIds). Grouping a decal's
// TARGET already carries the sticker along, since the engine parents decal
// geometry under the target's root. Derived once so the button and the action
// (and the Cmd+G shortcut behind it) can never disagree about what will group.
const groupableIds = computed(() =>
  selectedIds.value.filter((id) => doc.objects.find((o) => o.id === id)?.kind !== 'decal'))
const canGroup = computed(() => groupableIds.value.length >= 2)
const canUngroup = computed(() => selectedObjects.value.some((o) => o.kind === 'group'))
const canConvertToMesh = computed(() =>
  selectedObjects.value.length === 1
  && selectedObjects.value[0]!.kind === 'primitive'
  && (selectedObjects.value[0] as PrimitiveObject).primitive !== 'mesh')
// Sculpt: exactly one `mesh` primitive selected (Task 13).
const canSculpt = computed(() =>
  selectedObjects.value.length === 1
  && selectedObjects.value[0]!.kind === 'primitive'
  && (selectedObjects.value[0] as PrimitiveObject).primitive === 'mesh')
// Merge (Task 16): 2+ primitives — any kind, `mesh` included, so a merge result
// can itself be folded into a further merge. Groups/GLBs/lights have no single
// geometry to sample into the voxel field, so they sit this action out.
const canMerge = computed(() =>
  selectedObjects.value.length >= 2
  && selectedObjects.value.every((o) => o.kind === 'primitive'))
// The object list renders this tree rather than `doc.objects` directly — the
// doc itself stays a flat array plus `parentId`; only the render is nested.
const rootObjectList = computed(() => rootObjects(doc.objects))

// ── Treatments: per-object effects, managed from the tree (design spec §2).
// A treatment selection is a SEPARATE concept from the object selection: picking a
// treatment row clears `selectedIds` (which detaches the gizmo through the selection
// watch) and the inspector shows only that treatment's dials.
const selectedTreatment = ref<{ objectId: string; treatmentId: string } | null>(null)
const activeTreatment = computed(() =>
  selectedTreatment.value ? findTreatment(doc, selectedTreatment.value.objectId, selectedTreatment.value.treatmentId) : null)
/** Treatment ids this frame's plan will not draw — the tree marks them "Not rendered". */
const unrenderedTreatments = computed(() => unrenderedTreatmentIds(maskedTreatmentPlan(doc)))

function selectTreatment(objectId: string, treatmentId: string): void {
  if (sculpting.value) return // same guard as toggleSelected: never re-point a live sculpt session
  selectedIds.value = []
  selectedModifier.value = null // treatment / modifier / object selection are mutually exclusive
  selectedTreatment.value = { objectId, treatmentId }
}
function addTreatment(objectId: string, kind: TreatmentKind): void {
  const o = doc.objects.find((x) => x.id === objectId)
  if (!o || !isTreatmentHost(o)) return
  const t = createTreatment(kind)
  o.treatments = [...treatmentsOf(o), t]
  selectTreatment(objectId, t.id)
}
function removeTreatment(objectId: string, treatmentId: string): void {
  const o = doc.objects.find((x) => x.id === objectId)
  if (!o) return
  const next = treatmentsOf(o).filter((t) => t.id !== treatmentId)
  if (next.length) o.treatments = next
  else delete o.treatments // absent, never [] — keeps the saved doc byte-identical to before
  if (selectedTreatment.value?.treatmentId === treatmentId) selectedTreatment.value = null
}
function duplicateTreatment(objectId: string, treatmentId: string): void {
  const hit = findTreatment(doc, objectId, treatmentId)
  if (!hit) return
  const copy = { ...hit.treatment, id: newTreatmentId() } as Treatment
  const list = [...treatmentsOf(hit.obj)]
  list.splice(hit.index + 1, 0, copy)
  hit.obj.treatments = list
  selectTreatment(objectId, copy.id)
}
function toggleTreatment(objectId: string, treatmentId: string): void {
  const hit = findTreatment(doc, objectId, treatmentId)
  if (hit) hit.treatment.enabled = !hit.treatment.enabled
}
function reorderTreatment(objectId: string, fromId: string, toId: string): void {
  const o = doc.objects.find((x) => x.id === objectId)
  if (!o) return
  const list = [...treatmentsOf(o)]
  const from = list.findIndex((t) => t.id === fromId)
  const to = list.findIndex((t) => t.id === toId)
  if (from < 0 || to < 0 || from === to) return
  const [moved] = list.splice(from, 1)
  list.splice(to, 0, moved!)
  o.treatments = list
}

// ── Modifiers: per-primitive geometry stack, managed from the tree the same way treatments
// are (S1 Task 5). A modifier selection is a SEPARATE concept from the object / treatment
// selection: picking a modifier row clears both. EVERY mutation runs through the read-through —
// modifierStackOf(o) → list op → Object.assign(o, writeModifierStack(next)) — never a raw write
// to o.modifierStack. writeModifierStack KEEPS the legacy `modifiers` bag, which still holds the
// Cloner Vary uniform (varyMode/…/varyColorStrength), so a stack edit never strips Vary.
const selectedModifier = ref<{ objectId: string; modifierId: string } | null>(null)
const activeModifier = computed(() => {
  const sel = selectedModifier.value
  if (!sel) return null
  const o = doc.objects.find((x) => x.id === sel.objectId)
  if (!o || o.kind !== 'primitive') return null
  const mo = modifierStackOf(o).find((m) => m.id === sel.modifierId)
  return mo ? { obj: o, modifier: mo } : null
})

function selectModifier(objectId: string, modifierId: string): void {
  if (sculpting.value) return // same guard as selectTreatment: never re-point a live sculpt session
  selectedIds.value = []
  selectedTreatment.value = null
  selectedModifier.value = { objectId, modifierId }
}
function addModifier(objectId: string, kind: ModifierKind): void {
  const o = doc.objects.find((x) => x.id === objectId)
  if (!o || o.kind !== 'primitive') return
  const before = modifierStackOf(o)
  const next = addModifierOp(before, kind)
  if (next === before) return // a second pinned kind (subdivide / cloner) is refused
  Object.assign(o, writeModifierStack(next))
  const added = next.find((m) => !before.some((b) => b.id === m.id))
  if (added) selectModifier(objectId, added.id)
}
function removeModifier(objectId: string, modifierId: string): void {
  const o = doc.objects.find((x) => x.id === objectId)
  if (!o || o.kind !== 'primitive') return
  Object.assign(o, writeModifierStack(removeModifierOp(modifierStackOf(o), modifierId)))
  if (selectedModifier.value?.modifierId === modifierId) selectedModifier.value = null
}
function duplicateModifier(objectId: string, modifierId: string): void {
  const o = doc.objects.find((x) => x.id === objectId)
  if (!o || o.kind !== 'primitive') return
  const before = modifierStackOf(o)
  const next = duplicateModifierOp(before, modifierId)
  if (next === before) return
  Object.assign(o, writeModifierStack(next))
  const copy = next.find((m) => !before.some((b) => b.id === m.id))
  if (copy) selectModifier(objectId, copy.id)
}
function toggleModifier(objectId: string, modifierId: string): void {
  const o = doc.objects.find((x) => x.id === objectId)
  if (!o || o.kind !== 'primitive') return
  const next = modifierStackOf(o).map((m) => (m.id === modifierId ? { ...m, enabled: !m.enabled } as ModifierInstance : m))
  Object.assign(o, writeModifierStack(next))
}
function reorderModifier(objectId: string, fromId: string, toId: string): void {
  const o = doc.objects.find((x) => x.id === objectId)
  if (!o || o.kind !== 'primitive') return
  const stack = modifierStackOf(o)
  if (!canReorderModifier(stack, fromId, toId)) return // pinned rows can't move, nothing crosses a pin
  Object.assign(o, writeModifierStack(reorderModifierOp(stack, fromId, toId)))
}

// The treatment inspector: ONE card from treatmentControls(kind), read/written straight
// on the selected Treatment. Colour rows arrive as 8-digit #rrggbbaa from StudioColor;
// stored as-is, stripped by every three consumer (treatmentShells.ts / treatmentStage.ts).
const treatmentPanelControls = computed(() => activeTreatment.value ? treatmentControls(activeTreatment.value.treatment.kind) : [])
const treatmentPanelOrder = computed(() => activeTreatment.value ? [TREATMENT_LABELS[activeTreatment.value.treatment.kind]] : [])
function readTreatmentControl(key: string): string | number | boolean {
  const t = activeTreatment.value?.treatment as unknown as Record<string, string | number | boolean> | undefined
  const v = t?.[treatmentField(key)]
  return v === undefined ? '' : v
}
function setTreatmentControl(key: string, value: string | number | boolean): void {
  const t = activeTreatment.value?.treatment as unknown as Record<string, unknown> | undefined
  if (t) t[treatmentField(key)] = value
}
// `showIf` on a treatment row does nothing unless the panel is handed a predicate —
// StudioControlPanel's `visible` prop is that seam. Without this the ramp rows would
// show even with Progressive off, which is the classic silently-inert gate.
function treatmentControlVisible(c: ControlSpec): boolean {
  return showIfVisible(c, (key) => readTreatmentControl(key))
}

// The modifier inspector: ONE card from modifierControls(kind), read/written straight on the
// SELECTED instance (activeModifier.modifier) — never the legacy bag, which a stored stack has
// left stale. Its option-valued rows (taper/twist/bend axis, jitter mode, clone mode/axis) store
// the option's INDEX in the flat instance, so a `select` here surfaces the option words but must
// coerce label→index on write and index→label on read — the same word↔index mapping `optionOf` /
// `setOption` do for the bag, done here against the instance. Every edit persists through the
// read-through: modifierStackOf(o) → map the one row → Object.assign(o, writeModifierStack(next)),
// which keeps the vary bag alive (Task 3b).
const modifierPanelControls = computed(() => activeModifier.value ? modifierControls(activeModifier.value.modifier.kind) : [])
const modifierPanelOrder = computed(() => activeModifier.value ? [MODIFIER_LABELS[activeModifier.value.modifier.kind]] : [])
function readModifierControl(key: string): string | number | boolean {
  const am = activeModifier.value
  if (!am) return ''
  const field = modifierField(key)
  const spec = MODIFIER_SPECS.find((s) => s.key === field)
  const raw = (am.modifier as unknown as Record<string, number>)[field]
  const v = raw === undefined ? (spec?.default ?? 0) : raw
  if (spec?.control === 'options') return (spec.options ?? [])[Math.round(v)] ?? (spec.options ?? [])[0] ?? ''
  if (spec?.control === 'toggle') return Math.round(v) === 1
  return v
}
function setModifierControl(key: string, value: string | number | boolean): void {
  const sel = selectedModifier.value
  if (!sel) return
  const o = doc.objects.find((x) => x.id === sel.objectId)
  if (!o || o.kind !== 'primitive') return
  const field = modifierField(key)
  const spec = MODIFIER_SPECS.find((s) => s.key === field)
  if (!spec) return
  let stored: number
  if (spec.control === 'options') {
    const i = (spec.options ?? []).indexOf(String(value)) // label→index; a select emits the option word
    if (i < 0) return
    stored = i
  } else if (spec.control === 'toggle') {
    stored = value ? 1 : 0
  } else {
    stored = Number(value)
  }
  const next = modifierStackOf(o).map((m) => (m.id === sel.modifierId ? { ...m, [field]: stored } as ModifierInstance : m))
  Object.assign(o, writeModifierStack(next))
}
// The Boolean modifier's "Combine with" picker: a DYNAMIC select sourced from the LIVE scene, so
// it cannot live in static MODIFIER_SPECS (those are numeric dials only). It lists every OTHER
// primitive object by name — groups, lights and decals are excluded because a boolean can only
// combine solid geometry, and self is excluded — and writes the chosen object's id into the
// selected boolean instance's `refObjectId` (a STRING field the engine reads to resolve the sibling
// geometry) through the SAME read-through every other dial uses. An empty pick clears it, and the
// boolean then no-ops. NOT a dead control: booleanOp/blend/resolution come from the panel above,
// the sibling comes from here, and applyBoolean reads all four.
const BOOLEAN_NONE = ''
const booleanSiblings = computed<PrimitiveObject[]>(() => {
  const am = activeModifier.value
  if (!am || am.modifier.kind !== 'boolean') return []
  return doc.objects.filter((o): o is PrimitiveObject => o.kind === 'primitive' && o.id !== am.obj.id)
})
const booleanSiblingOptions = computed<string[]>(() => [BOOLEAN_NONE, ...booleanSiblings.value.map((o) => o.id)])
const booleanSiblingLabels = computed<string[]>(() => ['None', ...booleanSiblings.value.map((o) => o.name)])
const booleanRefId = computed<string>({
  get() {
    const am = activeModifier.value
    const ref = am?.modifier.kind === 'boolean' ? am.modifier.refObjectId : undefined
    // Only surface a ref that still points at a listable sibling; a stale or self id reads as None.
    return ref && booleanSiblings.value.some((o) => o.id === ref) ? ref : BOOLEAN_NONE
  },
  set(value: string) {
    const sel = selectedModifier.value
    if (!sel) return
    const o = doc.objects.find((x) => x.id === sel.objectId)
    if (!o || o.kind !== 'primitive') return
    const next = modifierStackOf(o).map((m) => {
      if (m.id !== sel.modifierId) return m
      const patched = { ...m } as ModifierInstance
      if (value) patched.refObjectId = value
      else delete patched.refObjectId
      return patched
    })
    Object.assign(o, writeModifierStack(next))
  },
})
// The Cloner's placement rows swap with its mode exactly as the shipped Cloner card did (grid
// drops the linear/radial rows for its per-axis counts), so a row that does nothing in the
// current mode is hidden rather than left as a dead control. Mode/step rows show in every mode.
const CLONER_ALWAYS_KEYS = new Set(['cloneMode', 'cloneStepRotX', 'cloneStepRotY', 'cloneStepRotZ', 'cloneStepScale'])
const CLONER_MODE_KEYS: Record<number, Set<string>> = {
  0: new Set(['cloneCount', 'cloneOffsetX', 'cloneOffsetY', 'cloneOffsetZ']),
  1: new Set(['cloneCount', 'cloneRadius', 'cloneAxis']),
  2: new Set(['cloneCountX', 'cloneCountY', 'cloneCountZ', 'cloneSpacingX', 'cloneSpacingY', 'cloneSpacingZ']),
}
const activeCloneMode = computed(() => {
  const am = activeModifier.value
  if (!am || am.modifier.kind !== 'cloner') return 0
  return Math.round((am.modifier as unknown as Record<string, number>).cloneMode ?? 0)
})
function modifierControlVisible(c: ControlSpec): boolean {
  const am = activeModifier.value
  if (!am) return false
  if (am.modifier.kind !== 'cloner') return true
  const field = modifierField(c.key)
  if (!field.startsWith('clone') || CLONER_ALWAYS_KEYS.has(field)) return true
  return (CLONER_MODE_KEYS[activeCloneMode.value] ?? CLONER_MODE_KEYS[0]!).has(field)
}
// Vary lives under the Cloner row's inspector but is NOT a stack field (constraint): its dials
// (varyMode/seed/falloff/varyColor/spread/varyColorStrength) and its palette stay in the legacy
// `modifiers` bag, read/written by modOf/setMod/varyPaletteOf below. `varyObject` is the primitive
// that owns the selected cloner — the object modOf/setMod target while a modifier row is selected
// (the ordinary object `selected` is null then, its selection having moved to the row).
const varyObject = computed<PrimitiveObject | null>(() => {
  const am = activeModifier.value
  return am && am.modifier.kind === 'cloner' && am.obj.kind === 'primitive' ? (am.obj as PrimitiveObject) : null
})
// The Vary gates read the cloner's clone count from the STACK instance (the bag's count is stale
// once the stack is edited), and its colour half additionally needs a material with a base colour.
const varyClones = computed(() => {
  const am = activeModifier.value
  if (!am || am.modifier.kind !== 'cloner' || am.modifier.enabled === false) return 0
  return totalClones(am.modifier as unknown as Record<string, number>)
})
const varyBlockVisible = computed(() => varyClones.value > 1)
const varyModeNow = computed(() => Math.round(modOf('varyMode')))
const varyColorableNow = computed(() =>
  varyBlockVisible.value && !!varyObject.value && !NO_BASE_COLOR.has(varyObject.value.material.type))
const varyColorOnNow = computed(() => varyColorableNow.value && Math.round(modOf('varyColor')) === 1)

function toggleSelected(id: string, additive: boolean): void {
  // A stray click (viewport or the Objects list) must never re-point the
  // selection away from the object a live sculpt session is bound to — the
  // inspector column is showing the sculpt panel regardless of `selectedIds`,
  // so a reselect here would just desync the two with nothing to show for it.
  if (sculpting.value) return
  if (!additive) { selectedIds.value = [id]; return }
  const i = selectedIds.value.indexOf(id)
  // Re-selecting an already-selected object promotes it to primary rather than
  // deselecting it when it is the only member — deselecting the last object via
  // a modifier-click is a dead end the user has to undo with another click.
  if (i < 0) selectedIds.value = [...selectedIds.value, id]
  else if (selectedIds.value.length > 1) selectedIds.value = selectedIds.value.filter((x) => x !== id)
}
const selected = computed<SceneObject | null>(() => doc.objects.find((o) => o.id === selectedId.value) ?? null)
const selectedIsPrimitive = computed(() => selected.value?.kind === 'primitive')
// GLBs render their imported materials until the override switch is on; the
// material editor's controls only appear (and bind) when they'd have an effect.
const matOverride = computed<boolean>({
  get: () => selected.value?.kind === 'glb' && selected.value.materialOverride === true,
  set: (v) => { const o = selected.value; if (o?.kind === 'glb') o.materialOverride = v },
})
const selectedDecal = computed<DecalObject | null>(() => (selected.value?.kind === 'decal' ? selected.value : null))
const activeTab = ref<'build' | 'motion'>('build')  // inspector tab: Build (existing sections) vs Motion (Task 5)

// ── Motion panel state (Task 5) ──────────────────────────────────────────────
const motionOn = computed({
  get: () => sceneHasMotion(doc),
  set: (on: boolean) => {
    if (on) animateSceneDefaults(doc)
    else { doc.objects.forEach((o) => (o.motion = undefined)); doc.camera.motion = undefined }
  },
})
function applyTemplate(name: 'showcase' | 'reveal' | 'loop') { SCENE_TEMPLATES[name](doc) }

const DIRECTION_OPTIONS: Direction[] = ['left', 'right', 'top', 'bottom']
// Ease picker options: preset KEYS (StudioSelect displays/binds the string key itself) + 'custom'.
const EASE_KEY_OPTIONS: string[] = [...EASE_PRESETS.map((p) => p.key), 'custom']

// Ease picker proxy for a transition slot ('in'|'out') on the currently selected object.
function easeKey(slot: 'in' | 'out'): string {
  const t = selected.value?.motion?.[slot]
  return t ? presetKeyForEaseRef(t.ease) : 'ease-out'
}
function setEaseKey(slot: 'in' | 'out', key: string) {
  const t = selected.value?.motion?.[slot]
  if (!t || key === 'custom') return
  t.ease = easeRefForPresetKey(key)
}
function curveProxy(slot: 'in' | 'out'): string | null {
  const t = selected.value?.motion?.[slot]
  if (!t) return null
  return easeRefToCurveString(t.ease)
}
function setCurve(slot: 'in' | 'out', v: string) {
  const t = selected.value?.motion?.[slot]
  if (t) t.ease = curveStringToEaseRef(v)
}

// ── Transport / playback (Task 6) ────────────────────────────────────────────
const playing = ref(false)
const playhead = ref(0)     // seconds
let playStart = 0           // performance.now anchor
function togglePlay() {
  if (!sceneHasMotion(doc)) return
  playing.value = !playing.value
  if (playing.value) playStart = performance.now() - playhead.value * 1000
}
// Bake the Motion timeline to an encoded file (reuses the studios' bake→encode
// pipeline — same renderMotionFrame path the live preview uses, so the clip matches
// playback exactly). Renders N = fps*duration frames off-screen at the output
// resolution, bakes/encodes server-side, and lands a file under input/ — it does NOT
// download or dispatch anything; that's each caller's job (exportVideo downloads,
// renderVideoToCanvas dispatches a Video node). Playback is paused for the duration
// so it can't interleave renders with the export loop, and the viewport render size
// + Build pose are restored in `finally` regardless of outcome.
async function bakeSceneVideo(): Promise<{ filename: string; ext: 'mp4' | 'webm' } | null> {
  if (!engine || !sceneHasMotion(doc)) return null
  if (videoBaking.value) return null
  videoBaking.value = true
  const wasPlaying = playing.value; playing.value = false
  try {
    const W = doc.output.width, H = doc.output.height
    const fps = doc.motion.fps, dur = doc.motion.duration
    const total = Math.max(1, Math.round(fps * dur))
    engine.setSize(W, H)
    const { ensureSpaceTypeBake } = await import('~/lib/spacetype/bake')
    const cfg = { fps, loopDuration: dur, W, H, seed: 'scene3d', sig: JSON.stringify({ id: props.nodeId, n: total, w: W, h: H, s: serializeDoc(doc) }) }
    const bake = await ensureSpaceTypeBake(cfg as any, undefined, {
      renderFrame: async (i) => {
        const cv = renderMotionFrame(engine!, doc, total > 1 ? i / total : 0)
        return await new Promise<Blob>((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/png'))
      },
    })
    try {
      return await encodeFrames({ frames: bake.frames, fps, width: W, height: H })
    } catch {
      bakeError.value = 'Video encode failed'
      return null
    }
  } catch (err) {
    bakeError.value = 'Video export failed'
    console.error('[Scene3D] video export failed:', err)
    return null
  } finally {
    // restore the viewport render size and Build pose
    engine?.setSize(canvasEl.value?.clientWidth ?? doc.output.width, canvasEl.value?.clientHeight ?? doc.output.height)
    engine?.syncFromDoc(doc); engine?.applyObjectOpacities({})
    playing.value = wasPlaying
    videoBaking.value = false
  }
}
// Download video: bake, then fetch the encoded file back and save it locally.
// NOTE: no tab store here (unlike ArtifactFrameNode), so this does not record the
// export to the Assets panel — follow-up for 2b if that's wanted from this surface.
async function exportVideo() {
  const encoded = await bakeSceneVideo()
  if (!encoded) return
  const vres = await fetch(`/view?${new URLSearchParams({ filename: encoded.filename, type: 'input' })}`)
  if (!vres.ok) throw new Error(`/view returned ${vres.status}`)
  const blob = await vres.blob()
  const obj = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = obj; a.download = `scene3d-${props.nodeId}.${encoded.ext}`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(obj)
}
// As video (canvas): bake, then dispatch a Video node onto the canvas instead of
// downloading — mirrors exportToCanvas's dispatch/close exactly (same event name,
// same commitSculptIfNeeded guard so a live sculpt session isn't left uncommitted),
// just with a Video node + the encoded filename instead of the beauty image.
async function renderVideoToCanvas() {
  if (!(await commitSculptIfNeeded())) return
  const encoded = await bakeSceneVideo()
  if (!encoded) return
  window.dispatchEvent(new CustomEvent('sailor:scene3dStudioOutput', {
    detail: { sourceNodeId: props.nodeId, nodeType: 'Video', widgetOverrides: { file: encoded.filename } },
  }))
  emit('close')
}
watch(playing, (v) => {
  if (!v && engine) { engine.syncFromDoc(doc); engine.applyObjectOpacities({}) }
})

const snap = ref(false)
const lightView = ref(false)  // clay + light-widget preview mode (Task 1/3 engine support)
const baking = ref(false)
const videoBaking = ref(false)  // reentrancy guard for bakeSceneVideo (separate from `baking`, the image-bake guard — footer video actions + the Motion panel's Export video button all funnel through bakeSceneVideo)
const bakeError = ref('')       // last export failure message (inline "retry")
const glbError = reactive<Record<string, boolean>>({})
const webglOk = ref(true)
const uploading = ref(false)    // GLB file upload in flight
const uploadError = ref('')     // inline error for the Upload GLB control
const glbFileInput = ref<HTMLInputElement | null>(null)

// ── SVG import ────────────────────────────────────────────────────────────────
const svgFileInput = ref<HTMLInputElement | null>(null)
const svgPasteOpen = ref(false)
const svgPasteText = ref('')
const svgError = ref<string | null>(null)
/** Set when a source exceeds SVG_SPLIT_THRESHOLD: the user picks split or merged
 *  before anything is added, so a 247-path map can never silently flood the
 *  scene AND we never silently truncate their artwork. */
const svgPending = ref<{ paths: SvgLeafPath[]; name: string } | null>(null)
/** True while a parse or an outline is in flight. Both stages are synchronous
 *  main-thread work with no progress of their own, so without this a second
 *  click on Add (or on a choice button) starts a SECOND import over the same
 *  frozen frame and lands two copies of the artwork in the scene. */
const svgBusy = ref(false)

// ── Add-pill menus: face + caret ────────────────────────────────────────────
// The Frame toolbar's grammar (see lib/compositor/toolbarMenus.ts and
// CompositorModal's shapes-face/shapes-menu-toggle pair), adapted to this pill's
// labelled style: each of Primitive/Light/Decal is TWO real buttons — a face
// that repeats the last-used entry in one click, and a slim caret that opens the
// unchanged menu. Faces are plain refs: they reset per studio session, exactly
// as the Frame's do, so no last-used state ever outlives the modal.
const primMenuOpen = ref(false)
const lightMenuOpen = ref(false)
const decalMenuOpen = ref(false)
/** The shape-library picker opened from the primitives menu's "Shape library…" row.
 *  Not a face: a library shape is not a PrimitiveKind, so the last-used face keeps
 *  pointing at a real primitive. */
const libraryPickerOpen = ref(false)
const libraryPickerAnchor = ref({ x: 0, y: 0 })
const primClusterRef = ref<HTMLElement | null>(null)
function openLibraryPicker() {
  libraryPickerAnchor.value = anchorAbove(primClusterRef.value?.getBoundingClientRect())
  closeAddMenus()
  libraryPickerOpen.value = true
}
async function onLibraryPick(id: string) {
  const s = shapeById(id)
  if (!s) return
  await importSvgSource(shapeToSvg(s), s.name)
  if (svgError.value) uploadError.value = svgError.value
}
// Generate's own open flag lives HERE, with its three siblings, rather than down
// in the Generate-panel block: the shared outside-click watch below takes all
// four refs as an eagerly-evaluated source array, so a later `const genOpen`
// would be read inside its own temporal dead zone during setup.
const genOpen = ref(false)
const primFace = ref<PrimitiveKind>(DEFAULT_PRIM_FACE)
const lightFace = ref<LightKind>(DEFAULT_LIGHT_FACE)
const decalFace = ref<DecalEntryId>(DEFAULT_DECAL_FACE)

/** The one closer for all four popups (Generate included). Every toggle goes
 *  close-then-open through it, so two can never be open at once, and the
 *  outside-pointerdown and Escape closers route through it too — replacing the
 *  four hand-rolled `x = false; y = false; …` chains the pill used to carry. */
function closeAddMenus() {
  primMenuOpen.value = false
  lightMenuOpen.value = false
  decalMenuOpen.value = false
  genOpen.value = false
  libraryPickerOpen.value = false
}
function togglePrimMenu() { const next = !primMenuOpen.value; closeAddMenus(); primMenuOpen.value = next }
function toggleLightMenu() { const next = !lightMenuOpen.value; closeAddMenus(); lightMenuOpen.value = next }
function toggleDecalMenu() { const next = !decalMenuOpen.value; closeAddMenus(); decalMenuOpen.value = next }
function toggleGenMenu() { const next = !genOpen.value; closeAddMenus(); genOpen.value = next }

/** Menu row → add it now AND wear it, so repeating is one click. */
function pickPrimitive(kind: PrimitiveKind) {
  primFace.value = kind
  primMenuOpen.value = false
  addPrimitive(kind)
}
/** The face button: add the worn primitive without opening anything. */
function addFacePrimitive() { closeAddMenus(); addPrimitive(resolvePrimFace(primFace.value)) }

function pickLight(kind: LightKind) {
  lightFace.value = kind
  addLight(kind)
}
function addFaceLight() { closeAddMenus(); addLight(resolveLightFace(lightFace.value)) }

/** Decal entries ARM a viewport placement rather than adding an object, so
 *  "repeat the last-used entry" means re-arming the same placement. */
function runDecalEntry(id: DecalEntryId) {
  if (id === 'image') triggerDecalImageAdd()
  else addTextDecal()
}
function pickDecalEntry(id: DecalEntryId) {
  decalFace.value = id
  decalMenuOpen.value = false
  runDecalEntry(id)
}
function runDecalFace() {
  const face = resolveDecalFace(decalFace.value)
  closeAddMenus()
  runDecalEntry(face)
}

// Outside click closes whichever popup is open (listener registered only while
// one is). The `[data-prim-menu]` hit test is the whole bottom pill, shared by
// all four popups.
function onAddMenuOutside(e: PointerEvent) {
  if (!(e.target as HTMLElement)?.closest?.('[data-prim-menu]')) closeAddMenus()
}
watch([primMenuOpen, lightMenuOpen, decalMenuOpen, genOpen], (open) => {
  if (open.some(Boolean)) window.addEventListener('pointerdown', onAddMenuOutside, true)
  else window.removeEventListener('pointerdown', onAddMenuOutside, true)
})

// ── Generate panel (text → image review → make 3D → insert) ────────────────
const GEN_3D_MODELS = ['hunyuan3d-v2', 'trellis-2', 'tripo-v2.5', 'triposr']
// (`genOpen` is declared with the other add-pill menu flags above.)
const genPrompt = ref('')
const genImageUrl = ref<string | null>(null)
const genSeed = ref(Math.floor(Math.random() * 2e9))
const gen3dModel = ref('hunyuan3d-v2')
const genTextured = ref(false)
const genStage = ref<'idle' | 'image' | 'review' | 'making' | 'error'>('idle')
const genError = ref('')

// (Generate's outside-click closer is the pill's shared one — see the
// onAddMenuOutside watch above, which lists genOpen alongside the other three.)

async function genImage() {
  genStage.value = 'image'
  genError.value = ''
  try {
    const r = await $fetch('/api/scene3d/gen-image', { method: 'POST', body: { prompt: genPrompt.value, seed: genSeed.value } })
    genImageUrl.value = r.imageUrl
    genSeed.value = r.seed
    genStage.value = 'review'
  } catch (err) {
    console.error('[scene3d-studio] gen-image failed', err)
    genError.value = 'Image generation failed — try again.'
    genStage.value = 'error'
  }
}
function reroll() {
  genSeed.value = Math.floor(Math.random() * 2e9)
  genImage()
}
// Make 3D: fal image→3D, then insert the result with the auto-fit BAKED INTO
// the object's own transform (position/scale) rather than applied generically
// in loadGlb/addGlb — that would re-scale every GLB, including ones already
// placed and sized in saved scenes. Mirrors addGlb's create+push+warm-up shape.
async function make3d() {
  if (!genImageUrl.value) return
  genStage.value = 'making'
  genError.value = ''
  try {
    const r = await $fetch('/api/scene3d/gen-3d', {
      method: 'POST',
      body: { imageUrl: genImageUrl.value, model: gen3dModel.value, textured: genTextured.value },
    })
    const group = await loadGlb(r.glbUrl)
    fitGlbGroup(group)
    const o = createGlbObject(r.glbUrl, doc.objects)
    o.position = [group.position.x, group.position.y, group.position.z]
    o.scale = [group.scale.x, group.scale.y, group.scale.z]
    doc.objects.push(o)
    selectedId.value = o.id
    genOpen.value = false
    genStage.value = 'idle'
    genImageUrl.value = null
  } catch (err) {
    console.error('[scene3d-studio] gen-3d failed', err)
    genError.value = '3D generation failed — try again.'
    genStage.value = 'error'
  }
}

// Wired glb_url (from a Model3D / Text node), if any — offered as an import
// shortcut. glb_url is a STRING *widget*, so it never appears in data.inputs
// (the link-slot list); the node card renders its wiring handle at the fallback
// index 0 (Scene3DStudioNode.glbInIdx). Mirror that fallback here so an upstream
// URL edge — anchored to `input-0` — is actually detected. Ids are coerced with
// String() because edge/node ids can be numbers or strings depending on source.
const wiredGlbUrl = computed<string>(() => {
  const found = node.value?.data?.inputs?.findIndex((i: any) => i.name === 'glb_url') ?? -1
  const idx = found >= 0 ? found : 0
  const edge = props.edges.find((e: any) => String(e.target) === String(props.nodeId) && e.targetHandle === `input-${idx}`)
  const src = edge ? props.nodes.find((n: any) => String(n.id) === String(edge.source)) : null
  const t = src?.data?.text
  // Only accept strings that actually reference a .glb file (optionally followed by
  // a query/hash) — no bare "any http URL" acceptance, which would offer to import
  // non-model links wired into the slot.
  return typeof t === 'string' && /\.glb(\?|#|$)/i.test(t) ? t : ''
})

// ── Enum / composite field proxies (StudioSegmented/StudioSelect models are string) ─────
function enumProxy<T extends string>(get: () => T, set: (v: T) => void) {
  return computed<string>({ get, set: (v: string) => set(v as T) })
}
const OUTPUT_OPTIONS = ['1024×1024', '1344×768', '768×1344']
const outputProxy = computed<string>({
  get: () => `${doc.output.width}×${doc.output.height}`,
  set: (v) => { const [w, h] = v.split('×').map(Number); doc.output.width = w ?? 1024; doc.output.height = h ?? 1024 },
})

// Background transparency toggle — remember the last real color so toggling back
// restores it instead of landing on black.
// `background` is a hex colour, or one of two sentinels: 'transparent' (no backdrop) and
// 'environment' (show the reflected world — the backdrop that makes glass dispersion
// visible, see applyPrismPreset). lastBgColor remembers the real colour so toggling either
// sentinel off restores it instead of landing on black.
const isBgSentinel = (v: string) => v === 'transparent' || v === 'environment'
const lastBgColor = ref(isBgSentinel(doc.background) ? '#1b1e24' : doc.background)
const bgTransparent = computed<boolean>({
  get: () => doc.background === 'transparent',
  set: (v) => {
    if (v) { if (!isBgSentinel(doc.background)) lastBgColor.value = doc.background; doc.background = 'transparent' }
    else { doc.background = lastBgColor.value }
  },
})
const bgShowWorld = computed<boolean>({
  get: () => doc.background === 'environment',
  set: (v) => {
    if (v) { if (!isBgSentinel(doc.background)) lastBgColor.value = doc.background; doc.background = 'environment' }
    else { doc.background = lastBgColor.value }
  },
})
// The Background card's three bespoke rows, drawn through the shared StudioRow so they
// carry the same 28px row chrome as Floor (they were bare label + switch/colour before).
// Bespoke — slot-rendered, NOT schema controls — because `background` is a colour-or-
// sentinel string with a remembered last colour, so these bind to the proxies above
// rather than to a doc leaf; that also keeps them out of the agent's path-writer.
const BG_WORLD_SPEC: ControlSpec = { key: 'ui.background.world', label: 'Show world', kind: 'switch', default: false, group: 'Background' }
const BG_TRANSPARENT_SPEC: ControlSpec = { key: 'ui.background.transparent', label: 'Transparent', kind: 'switch', default: false, group: 'Background' }
const BG_COLOR_SPEC: ControlSpec = { key: 'ui.background.color', label: 'Color', kind: 'color', default: '#1b1e24', group: 'Background' }
const bgColorProxy = computed<string>({
  get: () => (isBgSentinel(doc.background) ? lastBgColor.value : doc.background),
  set: (v) => { doc.background = v; lastBgColor.value = v },
})

// ── Post/Effects panel — StudioControlPanel driven by the shared manifest
// (postControls({ host: 'three-depth' })), replacing the old hand-written Effects
// section. Panel keys are `post.<field>`; doc.post is a plain PostSettings object
// (no makeConfigParams proxy exists for this surface yet — see scene3d/controls.ts's
// doc), so these two functions ARE the path resolver `readControl`/`setControl` delegate
// to for the `post.*` half of the panel's key space.
function postField(key: string): keyof PostSettings {
  return key.slice('post.'.length) as keyof PostSettings
}
function readPost(key: string): string | number | boolean {
  return doc.post[postField(key)] as string | number | boolean
}
function setPost(key: string, value: string | number | boolean): void {
  ;(doc.post as Record<string, unknown>)[postField(key)] = value
}

/** Material edits apply to EVERY selected object — this is what makes "select
 *  the logo's paths, pick gold" one action instead of twelve. Each object keeps
 *  its own material afterward, so a single path can still be tweaked alone.
 *  Groups and lights carry a dummy `DEFAULT_MATERIAL` that is never rendered
 *  (see their `create*` doc comments in config.ts) — mutating it would be a
 *  silent no-op at best, so both kinds are skipped rather than included.
 *
 *  A GLB without `materialOverride` is skipped for the same reason and one
 *  worse: its `material` isn't rendered either (the imported materials are),
 *  but it IS kept, so a GLB sitting in a multi-selection would silently bank
 *  every edit made while it was there and dump them all on the scene the day
 *  someone flips the override switch. This mirrors `isEditableMaterial` in
 *  controls.ts, which already draws the line in the same place. */
function applyMaterial(mutate: (m: SceneMaterial) => void) {
  for (const o of selectedObjects.value) {
    // Decals join lights and groups: a decal's own `material` is never rendered
    // (buildDecalMesh builds its material from the texture + opacity), so an
    // edit made while one sits in a multi-selection would be banked invisibly.
    if (o.kind === 'light' || o.kind === 'group' || o.kind === 'decal') continue
    if (o.kind === 'glb' && o.materialOverride !== true) continue
    mutate(o.material)
  }
}

/** One-click prism look: tuned glass + the dark-strips environment + black bg.
 *  Apply-values action, not a mode — every slider stays live afterwards. */
function applyPrismPreset(): void {
  applyMaterial((m) => {
    m.type = 'glass'
    m.color = '#ffffff'
    m.roughness = 0
    m.metalness = 0
    m.transmission = 1
    m.ior = 1.55
    m.thickness = 1.5
    m.dispersion = 3.5
    m.attenuationDistance = 0
  })
  doc.lighting.environment = 'darkStrips'
  // Show the world as the backdrop — NOT a flat black. Dispersion splits REFRACTED light,
  // and three renders scene.background into the transmission backdrop, so the glass has to
  // refract the bright strips to fan them into rainbow. Against solid black there is nothing
  // to split and the dispersion slider looks dead (the reflected strips alone never disperse).
  doc.background = 'environment'
}

// Selection field proxies for the inspector's BESPOKE blocks — the matcap grid, the
// harmony scheme picker, the two ramp editors and the shader-fill editors. Every other
// material row is a schema row now and writes through `setMaterialControl` below, which
// is the same `applyMaterial` fan-out these use: get() reads the PRIMARY selection only
// (what the panel displays), set() edits every selected object.
const matType = computed<MaterialType>(() => selected.value?.material.type ?? 'standard')
function matParam<K extends keyof typeof MATERIAL_DEFAULTS>(key: K) {
  return computed<any>({
    get: () => (selected.value?.material as any)?.[key] ?? MATERIAL_DEFAULTS[key],
    set: (v) => applyMaterial((m) => { (m as any)[key] = v }),
  })
}
const matMatcap = matParam('matcap')
// ambientCG surface: the row is bespoke (thumbnail + picker); `''` clears the field outright
// rather than leaving an empty string on the doc. `matParam` is keyed on MATERIAL_DEFAULTS,
// which has no `texture` entry, hence the hand-written proxy.
const matTexture = computed<string | undefined>({
  get: () => selected.value?.material.texture,
  set: (v) => applyMaterial((m) => { if (v) m.texture = v; else delete m.texture }),
})
// Palette: when paletteMode is 'harmony' the ramp is GENERATED from hue/sat/light + this
// scheme (see rampStopsOf in config.ts) instead of the authored gradientStops the ramp
// editor writes.
const matPaletteHarmony = matParam('paletteHarmony')

// The X/Y/Z presets must write the ANGLES, not `gradientAxis` — once explicit
// angles exist on the material the axis field is only a seed and would look dead.
const AXIS_PRESETS = { x: { yaw: 90, pitch: 0 }, y: { yaw: 0, pitch: 90 }, z: { yaw: 0, pitch: 0 } } as const
function applyAxisPreset(axis: 'x' | 'y' | 'z') {
  const p = AXIS_PRESETS[axis]
  applyMaterial((m) => { m.gradientYaw = p.yaw; m.gradientPitch = p.pitch })
}
function isAxisPreset(axis: 'x' | 'y' | 'z') {
  const p = AXIS_PRESETS[axis]
  // Through gradientAngles(), so an untouched material still matches on its legacy
  // `gradientAxis` seed — the same read the Yaw/Pitch rows resolve through.
  const now = selected.value ? gradientAngles(selected.value.material) : { yaw: MATERIAL_DEFAULTS.gradientYaw, pitch: MATERIAL_DEFAULTS.gradientPitch }
  return now.yaw === p.yaw && now.pitch === p.pitch
}

// Stops: read through gradientStopsOf() so an untouched material shows the pair
// synthesized from `color` + `gradientB`; the array materializes on first edit.
const matGradientStops = computed<GradientStop[]>({
  get: () => (selected.value ? gradientStopsOf(selected.value.material) : []),
  // Cloned per object rather than assigning the same `v` array to every
  // selected material — the array (and its stop objects) must not become one
  // mutable reference shared across objects, same hazard cloneMaterial's fix
  // above documents for `relief`/`shader`.
  set: (v) => applyMaterial((m) => { m.gradientStops = v.map((s) => ({ ...s })) }),
})
// Opalescent reads the SAME `gradientStops` field but falls back to the vivid cyclic default
// (opalStopsOf), never the grey color→gradientB pair — so a fresh opal shows a rainbow, and the
// ramp editor is populated for editing. Writes land on `gradientStops` exactly like the gradient
// editor, so switching between the two material types carries the palette across.
const matOpalStops = computed<GradientStop[]>({
  get: () => (selected.value ? opalStopsOf(selected.value.material) : []),
  set: (v) => applyMaterial((m) => { m.gradientStops = v.map((s) => ({ ...s })) }),
})

/** Seed-engine palette (PalettePicker's "Seed engine" shelf, literal or cooked) applied to
 *  every selected material — routes through applyMaterial like the setters above so a
 *  multi-selection fans out, and through applySeedStopsToMaterial so paletteMode flips to
 *  'manual' (a material caught in 'harmony' mode must show the applied stops immediately,
 *  not the generated ramp — see rampStopsOf in config.ts). */
function applySeedPaletteStops(stops: GradientStop[]): void {
  applyMaterial((m) => applySeedStopsToMaterial(m, stops))
}

// ── shaderFill (object anchor only — Task 7) ─────────────────────────────────
// Hand-wired: Scene3D has no control-schema/agent path (unlike Space Type/Shape Studio's
// declarative control schema), so effect/speed/unlit/input-colour live here as plain proxies
// rather than derived from a shared descriptor list. A known, deliberate gap — see the task
// report.
const matShader = computed<ShaderSpec>({
  get: () => selected.value?.material.shader ?? DEFAULT_SHADER_SPEC,
  // Deep-cloned per object (JSON round-trip, same as cloneMaterial's own shader
  // handling) rather than assigning `v` to every selected material — a shared
  // spec object would mean editing one object's shaderFill silently edits them
  // all, the same hazard as material.relief's documented shallow-copy bug.
  set: (v) => applyMaterial((m) => { m.shader = JSON.parse(JSON.stringify(v)) }),
})

// ── Surface relief (Task 5) — orthogonal to material type, so its proxies read/write
// `material.relief`/`material.normalImage` directly rather than going through matParam.
// Mirrors the shaderFill proxies' shape: get() falls back to a default, set() only writes
// once a `relief` object exists (`setReliefSource` is what creates it).
/** The Relief source row's write. Not a plain field assignment, which is why it is a
 *  function of its own rather than a line in `setMaterialControl`. */
function setReliefSource(v: 'none' | 'shader' | 'image'): void {
  {
    applyMaterial((mat) => {
      const relief: ReliefSpec = { ...(mat.relief ?? { scale: MATERIAL_DEFAULTS.reliefScale }), source: v }
      // Selecting 'shader' must SEED relief.spec, not just switch the source: matReliefSpec's
      // getter falls back to DEFAULT_SHADER_SPEC for display, so without this the editor shows
      // a fully-configured effect while the persisted state has no spec at all — materials.ts's
      // getShaderHeightTexture then has neither `spec` nor `mat.shader` to render from and
      // returns null, so the relief silently never renders (Task 5 bug). Deep-clone via
      // normalizeShaderSpec (same helper parseDoc uses for this exact field) rather than
      // assigning the shared DEFAULT_SHADER_SPEC constant directly — that would let every
      // shader-relief material alias one mutable spec object, so editing one object's effect
      // would silently edit them all. Called once PER selected object (inside this loop) for
      // the same reason: a fan-out across a multi-selection must not let them alias each
      // other's spec either.
      // Deliberately NOT clearing `spec` when switching to 'none'/'image': keeping it lets a
      // user bounce between sources without losing their configured effect, which reads as
      // kinder than punishing an exploratory toggle.
      // Seed voronoi_cells instead of fbm_warp: bump responds to local gradient, not range.
      // fbm_warp gradient ≈5.4 (invisible), voronoi_cells ≈36.8 (reads as material surface).
      if (v === 'shader' && !relief.spec) relief.spec = normalizeShaderSpec({ effectId: 'voronoi_cells' }, 0)
      mat.relief = relief
    })
  }
}
/**
 * Every other `relief.*` row is a plain field on an EXISTING ReliefSpec — the guard is
 * load-bearing: a write must not fabricate a relief block, only `setReliefSource` creates
 * one. Scale and tiling update the bump texture in place (materials.ts's updateMaterial),
 * and contrast is applied at texture-build time alongside invert rather than at
 * upload/conversion time, so all four are live knobs a drag never rebuilds through.
 */
function setReliefField(sub: string, value: string | number | boolean): void {
  applyMaterial((mat) => { if (mat.relief) (mat.relief as unknown as Record<string, unknown>)[sub] = value })
  // The flatness warning is measured ONCE, on the pre-contrast pixels, at upload/generate
  // time — raising Contrast can genuinely fix a flat-reading map, but the warning (and its
  // "raise Contrast" copy) never re-evaluated, so it sat there contradicting a surface that
  // now reads fine. Cleared on any contrast edit rather than re-measured: re-decoding the
  // whole source image on every tick of a live slider would be real, avoidable cost. Per
  // OBJECT, so it clears for everything the fan-out above just touched, not just the primary.
  if (sub === 'contrast') for (const o of selectedObjects.value) delete reliefFlatWarning[o.id]
}
const matReliefSpec = computed<ShaderSpec>({
  get: () => selected.value?.material.relief?.spec ?? DEFAULT_SHADER_SPEC,
  // Deep-cloned per object, same reasoning as matShader above — a relief spec
  // is a nested object too, and the ShaderFillEditor emits one fresh `v` shared
  // across this whole fan-out unless each object gets its own copy.
  set: (v) => applyMaterial((mat) => { if (mat.relief) mat.relief.spec = JSON.parse(JSON.stringify(v)) }),
})
// The uploaded/converted image, whichever channel currently holds it: relief.image
// (bump path) normally, or normalImage once "Already a normal map" moved it there.
// Read-only: writes go through the upload handler / matIsNormalMap below.
const matReliefImage = computed<string | undefined>(() => selected.value?.material.relief?.image ?? selected.value?.material.normalImage)
/** Whether the chosen relief image is a real tangent-space normal map (→ `.normalMap`)
 *  rather than a height field (→ `.bumpMap`). Toggling MOVES the filename between the
 *  two fields rather than gating a shared one, since they are genuinely different
 *  textures read by materials.ts — see SceneMaterial.normalImage's doc in config.ts. */
const matIsNormalMap = computed<boolean>({
  get: () => !!selected.value?.material.normalImage,
  set: (v) => {
    applyMaterial((mat) => {
      if (v) {
        const img = mat.relief?.image
        if (img) {
          mat.normalImage = img
          if (mat.relief) mat.relief.image = undefined
        }
      } else {
        const img = mat.normalImage
        if (img) {
          if (!mat.relief) mat.relief = { source: 'image', scale: MATERIAL_DEFAULTS.reliefScale }
          mat.relief.image = img
          mat.normalImage = undefined
        }
      }
    })
  },
})
// I3 fix (final review): `normalImage` is a field independent of `relief.source` (see its doc
// in config.ts) — materials.ts correctly keeps applying it no matter what Relief is set to,
// but the ONLY control that could touch it ("Already a normal map") used to render solely
// under an Image relief source. Switching Relief to None/Effect after checking that box
// left the normal shading bound with no way to clear it. This is a plain discard, independent
// of matIsNormalMap's move-between-fields dance above (there is no relief.image to move it
// back to once the user has explicitly walked away from Image source).
function removeNormalMap() {
  applyMaterial((mat) => { mat.normalImage = undefined })
}

const decalText = computed<string>({
  get: () => (selectedDecal.value?.content.type === 'text' ? selectedDecal.value.content.text : ''),
  set: (v) => { const c = selectedDecal.value?.content; if (c?.type === 'text') c.text = v },
})
const decalFont = computed<string>(() =>
  selectedDecal.value?.content.type === 'text' ? selectedDecal.value.content.font : DECAL_DEFAULTS.font)
// Decal text is rasterised to a canvas by decals.ts, which routes every token
// kind: google → css2 stylesheet, library/pinned → FontFace from the font
// file (canvasFontPlanFor). Mirrors onFontPick's per-kind handling so the
// decal Font control accepts exactly what the 3D Text one does.
function onDecalFontPick(payload: { kind: 'google'; family: string } | { kind: 'pinned'; value: string } | { kind: 'library'; family: string; foundry: string }) {
  const c = selectedDecal.value?.content
  if (c?.type !== 'text') return
  if (payload.kind === 'library') {
    // Same keep-the-weight rule as onFontPick: a re-pick of the same family
    // keeps the chosen weight; resolveLibraryFace snaps to a real face.
    const existing = parseLibraryFontValue(c.font)
    const face = resolveLibraryFace(payload.family, existing?.weight ?? 400, existing?.italic ?? false)
    c.font = libraryToken(payload.family, face?.weight, face?.italic)
    return
  }
  if (payload.kind === 'pinned') {
    c.font = payload.value
    return
  }
  // Same keep-the-weight-on-a-re-pick rule as onFontPick above.
  const existing = parseGoogleFontValue(c.font)
  c.font = existing && existing.family === payload.family && existing.weight !== undefined
    ? `google:${payload.family}@${existing.weight}`
    : `google:${payload.family}`
}

// Decal Weight selects — the sticker's font token embeds the weight (`google:Fam@W`),
// but the decal panel had only a family picker, so weight was frozen at whatever the
// token carried. These mirror the 3D-Text `fontWeight`/`libraryFontWeight` computeds
// exactly (same catalog, same keep-the-italic rule), writing the new weight back into
// the decal content's font token — the engine rebuilds the sticker texture because
// `decalKeyFor` includes `content`.
const selectedDecalGoogleFont = computed(() => {
  const c = selectedDecal.value?.content
  return c?.type === 'text' ? parseGoogleFontValue(c.font) : null
})
const decalFontWeightOptions = computed<string[]>(() => {
  const parsed = selectedDecalGoogleFont.value
  if (!parsed) return []
  const entry = fontCatalog.value.find((f) => f.family === parsed.family)
  const weights = entry?.weights.length ? entry.weights : [400]
  return weights.map(String)
})
const decalFontWeight = computed<string>({
  get: () => String(selectedDecalGoogleFont.value?.weight ?? 400),
  set: (w) => {
    const c = selectedDecal.value?.content
    const parsed = selectedDecalGoogleFont.value
    if (c?.type !== 'text' || !parsed) return
    c.font = `google:${parsed.family}@${w}`
  },
})
const selectedDecalLibraryFont = computed(() => {
  const c = selectedDecal.value?.content
  return c?.type === 'text' ? parseLibraryFontValue(c.font) : null
})
const decalLibraryWeightOptions = computed<string[]>(() => {
  const parsed = selectedDecalLibraryFont.value
  if (!parsed) return []
  const fam = libraryFamily(parsed.family)
  const weights = fam?.faces.length ? [...new Set(fam.faces.map((f) => f.weight))].sort((a, b) => a - b) : [400]
  return weights.map(String)
})
const decalLibraryFontWeight = computed<string>({
  get: () => String(selectedDecalLibraryFont.value?.weight ?? 400),
  set: (w) => {
    const c = selectedDecal.value?.content
    const parsed = selectedDecalLibraryFont.value
    if (c?.type !== 'text' || !parsed) return
    c.font = libraryToken(parsed.family, Number(w), parsed.italic)
  },
})

// Image-material upload: file → dataURL → ComfyUI input dir → material.image.
// State is scoped to the object the upload was started FOR (not "whatever is
// selected when it finishes"): texUploading holds that object's id so the
// spinner only shows on it, and upload failures are keyed by object id
// (texUploadError) while engine-side load failures stay keyed by filename
// (texLoadError) — a failed replace must not smear the old, still-working file.
// Deliberately NOT routed through applyMaterial (Task 9): the spinner/error refs
// above are single-id, not sets, so fanning an upload across a multi-selection
// would need its own per-id async state, not a one-line change — a materially
// bigger change than the panel's synchronous sliders/colours below, and outside
// what this task's material fan-out targets.
const texFileInput = ref<HTMLInputElement | null>(null)
const texUploading = ref<string | null>(null)
const texUploadError = reactive<Record<string, boolean>>({})
const texLoadError = reactive<Record<string, boolean>>({})
function triggerTexUpload() { texFileInput.value?.click() }
// Same-origin /view URL for an uploaded input-dir file (used by the image preview).
function texViewUrl(filename: string) {
  return `/view?${new URLSearchParams({ filename, type: 'input' }).toString()}`
}
// Shared transport behind BOTH image pickers on this surface (material texture
// below, decal sticker in the Decal section): file → dataURL → ComfyUI input dir,
// resolving to the stored filename or `null` if anything in that chain failed.
// Deliberately owns no UI state — each caller keeps its own spinner/error
// treatment, which is the only thing the two differ on.
async function uploadInputImage(file: File): Promise<string | null> {
  try {
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(String(r.result))
      r.onerror = () => rej(new Error('read failed'))
      r.readAsDataURL(file)
    })
    return await inpaint.uploadDataUrl(dataUrl, `scene3d_tex_${props.nodeId}`)
  } catch {
    return null
  }
}
async function onTexFilePicked(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  // Capture the target BEFORE any await: reselecting mid-upload must not land
  // the texture (or the error) on the newly selected object.
  const target = selected.value
  if (!file || !target || target.kind === 'light') return
  texUploading.value = target.id
  delete texUploadError[target.id]
  try {
    const filename = await uploadInputImage(file)
    if (filename === null) throw new Error('upload failed')
    delete texLoadError[filename]
    target.material.image = filename
  } catch {
    texUploadError[target.id] = true
  } finally {
    if (texUploading.value === target.id) texUploading.value = null
  }
}
// Engine-side texture load failures (e.g. restored doc referencing a deleted
// file) surface the same inline note, keyed by filename.
let offTexError: (() => void) | null = null
onMounted(() => { offTexError = onTextureError((f) => { texLoadError[f] = true }) })
onBeforeUnmount(() => { offTexError?.() })

// Texture generation: prompt → fal → the ComfyUI input directory → material.image. Scoped
// to the object it was started FOR, exactly like the upload above — reselecting mid-request
// must not land the texture on the newly selected object.
const texGenPrompt = ref('')
const texGenerating = ref<string | null>(null)
const texGenError = reactive<Record<string, boolean>>({})

async function generateTexture() {
  const target = selected.value
  const prompt = texGenPrompt.value.trim()
  if (!prompt || !target || target.kind === 'light' || texGenerating.value) return
  texGenerating.value = target.id
  delete texGenError[target.id]
  try {
    const gen = await $fetch<{ imageUrl: string, seed: number }>('/api/scene3d/gen-texture', { method: 'POST', body: { prompt } })
    // The fal URL is public but temporary; /api/image-fetch copies the bytes into ComfyUI's
    // input directory and returns the stored filename, which is what the material holds.
    const stored = await $fetch<{ name?: string }>('/api/image-fetch', { method: 'POST', body: { url: gen.imageUrl } })
    const filename = stored?.name
    if (!filename) throw new Error('no filename')
    delete texLoadError[filename]
    target.material.image = filename
  } catch (err) {
    console.error('[scene3d-studio] gen-texture failed', err)
    texGenError[target.id] = true
  } finally {
    if (texGenerating.value === target.id) texGenerating.value = null
  }
}

// Relief image upload: same object-scoped-spinner / capture-before-await shape as the
// texture upload above (texUploading/onTexFilePicked). C2 fix (final review): `relief.image`
// now stores the user's ORIGINAL uploaded bytes, unconverted — the client used to run the SAME
// luminance→height transform materials.ts's getHeightTexture already runs at build time, so
// (a) "Brightness" and "Use as-is" produced byte-identical output (toHeightPixels is idempotent
// on grayscale — Use-as-is did nothing) and (b) a real Blender/game-asset normal map uploaded
// through the default Brightness path got flattened to gray BEFORE it ever reached storage,
// unrecoverably — routing it to normalImage afterwards just bound a uniformly-tilted flat gray
// square. Conversion now happens exactly once, in materials.ts, at texture-build time — see its
// relief-section doc.
const reliefFileInput = ref<HTMLInputElement | null>(null)
const reliefUploading = ref<string | null>(null)
const reliefUploadError = reactive<Record<string, boolean>>({})
// Set once a relief image's local gradient is measured (upload path or generate path,
// below). true means the map is suspiciously flat and bump mapping will show ~nothing —
// see heightGradient/RELIEF_FLAT_THRESHOLD in lib/scene3d/relief.ts. Advisory only: the
// map is still applied, this just tells the user why they might not see anything.
const reliefFlatWarning = reactive<Record<string, boolean>>({})
function triggerReliefUpload() { reliefFileInput.value?.click() }
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => rej(new Error('read failed'))
    r.readAsDataURL(file)
  })
}
/** Decode a data URL, run the SAME default luminance conversion materials.ts applies at
 *  texture-build time (invert/contrast are per-material picks made AFTER upload, so there is
 *  no live value to measure against here — a genuinely smooth source reads as flat regardless
 *  of what the user later dials in), and measure its local gradient. The one guard shared by
 *  both the upload path and the generate path below. Measurement is advisory: callers should
 *  treat a rejection as "unknown" rather than a hard failure. */
function measureReliefFlatness(dataUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const ctx = c.getContext('2d')
      if (!ctx) { reject(new Error('no 2d context')); return }
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, c.width, c.height)
      resolve(heightGradient(toHeightPixels(data.data, false, 1), c.width, c.height))
    }
    img.onerror = () => reject(new Error('decode failed'))
    img.src = dataUrl
  })
}
async function onReliefFilePicked(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  // Capture the target BEFORE any await: reselecting mid-upload must not land
  // the texture (or the error) on the newly selected object.
  const target = selected.value
  if (!file || !target || target.kind === 'light') return
  reliefUploading.value = target.id
  delete reliefUploadError[target.id]
  delete reliefFlatWarning[target.id]
  try {
    const rawUrl = await readAsDataUrl(file)
    const filename = await inpaint.uploadDataUrl(rawUrl, `scene3d_relief_${props.nodeId}`)
    delete texLoadError[filename]
    if (!target.material.relief) target.material.relief = { source: 'image', scale: MATERIAL_DEFAULTS.reliefScale }
    target.material.relief.source = 'image'
    target.material.relief.image = filename
    try {
      reliefFlatWarning[target.id] = (await measureReliefFlatness(rawUrl)) < RELIEF_FLAT_THRESHOLD
    } catch { /* measurement is advisory only — a failure here must not fail the upload */ }
  } catch {
    reliefUploadError[target.id] = true
  } finally {
    if (reliefUploading.value === target.id) reliefUploading.value = null
  }
}

// Relief generation: text prompt → /api/scene3d/gen-map (fal FLUX tile) → uploaded colour
// tile, converted once at build time by materials.ts exactly like an uploaded image (C2 fix —
// no client-side pre-conversion here either; see onReliefFilePicked's doc above). (A fal
// depth-model second stage used to run here; removed — depth reports scene distance, which is
// flat on a straight-on material photo, so it was a wasted paid call. See
// server/utils/scene3dRelief.ts.) Explicit button ONLY — this costs money and takes seconds, so
// it must never fire on a parameter change. Same object-id-keyed spinner/error shape as the
// upload above (reliefUploading/reliefUploadError), so a busy or failed generation on one
// object can't bleed onto another after reselecting.
const reliefGenOpen = ref(false)
const reliefGenPrompt = ref('')
const reliefGenBusy = ref<string | null>(null)
const reliefGenError = reactive<Record<string, boolean>>({})
function toggleReliefGen() {
  reliefGenOpen.value = !reliefGenOpen.value
}
/** fal's colour tile comes back as a remote CDN URL; inpaint.uploadDataUrl (like the
 *  file-picker path above) needs a data: URL to hand ComfyUI's /upload/image, so fetch
 *  it client-side and re-encode before handing it off. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('read failed'))
    r.readAsDataURL(blob)
  })
}
async function generateReliefFromPrompt() {
  const target = selected.value
  const prompt = reliefGenPrompt.value.trim()
  if (!target || target.kind === 'light' || !prompt || reliefGenBusy.value) return
  reliefGenBusy.value = target.id
  delete reliefGenError[target.id]
  delete reliefFlatWarning[target.id]
  try {
    const r = await $fetch<{ imageUrl: string, seed: number }>('/api/scene3d/gen-map', {
      method: 'POST',
      body: { prompt },
    })
    const res = await fetch(r.imageUrl)
    if (!res.ok) throw new Error(`fetch ${res.status}`)
    const rawUrl = await blobToDataUrl(await res.blob())
    const filename = await inpaint.uploadDataUrl(rawUrl, `scene3d_relief_gen_${props.nodeId}`)
    delete texLoadError[filename]
    if (!target.material.relief) target.material.relief = { source: 'image', scale: MATERIAL_DEFAULTS.reliefScale }
    target.material.relief.source = 'image'
    target.material.relief.image = filename
    reliefGenOpen.value = false
    reliefGenPrompt.value = ''
    try {
      reliefFlatWarning[target.id] = (await measureReliefFlatness(rawUrl)) < RELIEF_FLAT_THRESHOLD
    } catch { /* measurement is advisory only — a failure here must not fail the generation */ }
  } catch (err) {
    console.error('[scene3d-studio] gen-map failed', err)
    reliefGenError[target.id] = true
  } finally {
    if (reliefGenBusy.value === target.id) reliefGenBusy.value = null
  }
}

// Numeric transform fields (per-axis) — position/scale stored & shown raw, rotation
// stored in radians but edited in degrees (the read half lives in panelPresentation.ts's
// readSceneControl). Writes replace the whole array so the deep doc watcher fires (engine
// syncs); gizmo drags mutate the same arrays, so the rows re-read — two-way, no extra wiring.
const DEG2RAD = Math.PI / 180
/** Apply one transform-row edit across the WHOLE selection, as the spec's
 *  multi-select rule requires: the typed number lands on the primary and every
 *  other selected object shifts by the same DELTA. Absolute fan-out would stack
 *  three selected objects on one another the moment you typed a position, which
 *  is why `axisDeltaWrites` (unit-tested in scene3d-hierarchy.unit.spec.ts) owns
 *  the arithmetic — including the rule that a selected object inside another
 *  selected object does NOT get the delta, since its ancestor already carries it
 *  through the scene graph.
 *
 *  Without this, the panel was incoherent: with three objects selected, Color
 *  changed three, Position X changed one, and the gizmo moved all three.
 *
 *  `v` is in DOC units — the rotation row converts to radians before calling. */
function writeAxis(prop: 'position' | 'rotation' | 'scale', axis: 0 | 1 | 2, v: number): void {
  for (const { id, value } of axisDeltaWrites(doc.objects, selectedIds.value, prop, axis, v)) {
    const o = doc.objects.find((x) => x.id === id)
    if (!o) continue
    // Replace the whole array so the deep doc watcher fires (engine syncs) —
    // same reason the single-selection path always did.
    const next = [...o[prop]] as [number, number, number]
    next[axis] = value
    o[prop] = next
  }
}
/** One Transform row's write, in the units the ROW shows: degrees for rotation, world
 *  Size (scale × the object's un-scaled extent) for scale. `readSceneControl` does the
 *  same two conversions in the read direction — see panelPresentation.ts. */
function writeTransform(prop: 'position' | 'rotation' | 'scale', axis: 0 | 1 | 2, v: number): void {
  if (!selected.value || !Number.isFinite(v)) return
  // A commit carrying exactly what the row is already SHOWING is not an edit, and must not
  // touch the document — see isNoOpTransformCommit for why rounding the read cannot do
  // this on its own. A real edit differs from the reading by at least one step and falls
  // straight through.
  if (isNoOpTransformCommit(doc, selected.value, prop, axis, v, { baseSize: baseSize.value })) return
  if (prop === 'rotation') { writeAxis('rotation', axis, v * DEG2RAD); return }
  if (prop === 'scale') {
    const base = baseSize.value[axis] || 1
    if (!base) return
    writeAxis('scale', axis, v / base)
    return
  }
  writeAxis('position', axis, v)
}

// Geometry params for the selected primitive. Reads live in panelPresentation.ts (the
// panel, the parity spec and the write path share one description of them); this is the
// write half — it creates the params bag on first touch. Toggles store 0 | 1 so `params`
// stays a flat number map, which is what `resolveParam` and the geometry factory expect.
function setParam(key: string, v: number): void {
  const o = selected.value
  if (!o || o.kind !== 'primitive') return
  if (!o.params) o.params = {}
  o.params[key] = v
}

// The Cloner Vary bag: varyMode/seed/falloff/varyColor/spread/varyColorStrength are a MATERIAL
// uniform, not a modifier row, so they stay in the legacy `modifiers` bag (writeModifierStack keeps
// it) and never enter the stack. Vary only shows under the selected Cloner row, so these target
// `varyObject` — the primitive that owns that cloner — rather than `selected`, which is null while
// a modifier row holds the selection.
function modOf(key: string): number {
  const o = varyObject.value
  return o ? modifierValue(o.modifiers, key) : 0
}
function setMod(key: string, v: number): void {
  const o = varyObject.value
  if (!o) return
  if (!o.modifiers) o.modifiers = {}
  o.modifiers[key] = v
}
const modSpec = (key: string) => MODIFIER_SPECS.find((s) => s.key === key)!
/** A shared-row `select` spec for an index-valued Vary picker (Pattern / Vary colour / Spread).
 *  Built from the MODIFIER_SPEC so the option row draws with the same 28px chrome as the sliders
 *  beside it. These stay bespoke (not schema controls) because they store the option's INDEX in the
 *  numeric Vary bag; `optionOf` / `setOption` do that word ↔ index mapping. Values are the spec's
 *  own words; the row shows them sentence-cased. (The deformation-axis / clone-mode pickers moved
 *  onto the per-modifier inspector, coerced there straight on the instance.) */
function optionRowSpec(key: string, anchor: string): ControlSpec {
  const spec = modSpec(key)
  const options = spec.options ?? []
  return {
    key: anchor, label: spec.label, kind: 'select', options,
    optionLabels: options.map((o) => o[0]!.toUpperCase() + o.slice(1)),
    default: options[0] ?? '', group: 'Geometry', hint: spec.hint,
  }
}
// Option controls store the option's index; the segmented control speaks labels.
function optionOf(key: string): string {
  const spec = modSpec(key)
  return spec.options![Math.round(modOf(key))] ?? spec.options![0]!
}
function setOption(key: string, label: string): void {
  const i = modSpec(key).options!.indexOf(label)
  if (i >= 0) setMod(key, i)
}
/** A bag-backed slider spec for one of Vary's numeric dials (seed, the two falloff dials, colour
 *  strength), from the MODIFIER_SPEC. Drawn through StudioRow with `modOf` / `setMod`. */
function varySliderSpec(key: string): ControlSpec {
  const spec = modSpec(key)
  return { key, label: spec.label, kind: 'slider', min: spec.min, max: spec.max, step: spec.step, default: spec.default, group: 'Vary', hint: spec.hint }
}

/** Vary's palette is a `string[]` on the OBJECT (`PrimitiveObject.varyPalette`), not a
 *  number in the modifier bag, so it never goes through `setMod`. `undefined` here means
 *  "untouched" and VaryPalette falls back to the shared DEFAULT_VARY swatches — writing
 *  those defaults in on first render would put a palette on every scene that never asked
 *  for one. */
const varyPaletteOf = computed<string[] | undefined>(() => varyObject.value?.varyPalette)
function setVaryPalette(palette: string[]): void {
  const o = varyObject.value
  if (!o) return
  // Direct assignment onto the reactive doc, the same commit path `setParam` / the text
  // `content` writer use on this surface — there is no store action in between.
  o.varyPalette = palette
}
// Cost readout. The philosophy here is disclose, don't clamp: detail and counts
// are user-visible slider values, so silently reducing them would make the
// readout lie. Instead the totals are shown while dragging.
// Measured on this machine: rebuilds are synchronous and roughly linear in
// vertex count — ~390ms/tick at 274k, ~1080ms at 1.1M. The warning has to land
// before the drag starts hurting, so it trips at 200k rather than at the point
// where it is already unusable.
const AMBER_VERTS = 200_000
const cloneCost = computed(() => {
  const o = selected.value
  if (!o || o.kind !== 'primitive') return null
  // Clone COUNT comes from the STACK's cloner row, not the legacy bag: once the stack has been
  // edited the bag's cloneCount is stale (writeModifierStack keeps the bag only for the Vary
  // uniform). The cloner instance is bag-shaped, so totalClones/clampedClones read it directly.
  // The per-copy base vertex count is invariant to the stack (Task 3b), so it still reads the bag.
  const cloner = modifierStackOf(o).find((m) => m.kind === 'cloner' && m.enabled !== false)
  const clonerBag = cloner as unknown as Record<string, number> | undefined
  const copies = clonerBag ? totalClones(clonerBag) : 0
  if (copies <= 1) return null
  const base = baseVertexCountFor(o.primitive, o.params, o.modifiers, o.content)
  const verts = base * copies
  // The render-time vertex-budget guard (Task 4): cloneCount itself is never
  // reduced in the doc, but applyModifiers clamps the actual clone count
  // against the shaped (post-subdivision) base vertex count, same as `base`
  // here. Surfaced so a clamp never reads as a silent rendering bug.
  const clamp = clampedClones(clonerBag, base)
  return { copies, verts, heavy: verts > AMBER_VERTS, clamp }
})
// A boolean row with a RESOLVED sibling, or an enabled voxelise row, is heavy
// even when the object has no clones (cloneCost returns null at ≤1 copy). Both
// rebuild through the synchronous SDF/voxel merge — ~9s per tick at res 32³ —
// so a bare Resolution-slider drag on such an object would freeze the tab. This
// mirrors booleanRefKeys' resolution rule (ref set, not self, resolves to a
// sibling primitive) so the "heavy" verdict matches what actually rebuilds.
function objectHasHeavyProducer(o: PrimitiveObject): boolean {
  return modifierStackOf(o).some((r) => {
    if (r.enabled === false) return false
    if (r.kind === 'voxelise') return true
    if (r.kind !== 'boolean') return false
    const refId = r.refObjectId
    if (!refId || refId === o.id) return false
    const sib = doc.objects.find((x) => x.id === refId)
    return !!sib && sib.kind === 'primitive'
  })
}
// The pointerdown-sampled "is this drag heavy?" verdict: a heavy clone set OR a
// boolean/voxelise producer on the selected object. Any of these makes a
// per-tick geometry rebuild block the main thread long enough that the slider
// stops tracking the pointer.
const heavyGeometry = computed(() => {
  if (cloneCost.value?.heavy) return true
  const o = selected.value
  return !!o && o.kind === 'primitive' && objectHasHeavyProducer(o)
})
// True when SOME object in the scene booleans against another: moving any object
// then changes a booleaning sibling's relative transform every frame → its
// booleanRefKeys (hence geoKey) churns → a synchronous merge per drag frame.
// Booleans are rare, so "any boolean dependency anywhere" is a cheap, safe gate
// to defer geometry for the whole transform drag and catch up once on release.
const sceneHasBooleanDependency = computed(() =>
  doc.objects.some((o) => o.kind === 'primitive' && objectHasHeavyProducer(o) &&
    modifierStackOf(o).some((r) => r.kind === 'boolean' && r.enabled !== false && !!r.refObjectId && r.refObjectId !== o.id)))
// Heavy-drag deferral. A rebuild at 300k+ verts blocks the main thread long
// enough that the slider itself stops tracking the pointer, so for the duration
// of a drag on a heavy object the engine skips geometry rebuilds and catches up
// once on release. Nothing is clamped: the released value is what gets built.
// Heaviness is sampled once at pointerdown so a drag never changes mode midway.
const deferringGeometry = ref(false)
function onControlsPointerDown() {
  if (!engine || deferringGeometry.value || !heavyGeometry.value) return
  deferringGeometry.value = true
  engine.deferGeometry = true
}
// A gizmo/pivot transform drag on ANY object churns a booleaning sibling's
// geometry per frame when a boolean dependency exists in the scene. Raise
// deferGeometry for the whole drag (sampled at drag start) and catch up on
// release — the same defer-then-rebuild-once contract as the dial-drag path.
const deferringForGizmo = ref(false)
function onGizmoDragChange(dragging: boolean) {
  if (!engine) return
  if (dragging) {
    if (deferringForGizmo.value || !sceneHasBooleanDependency.value) return
    deferringForGizmo.value = true
    engine.deferGeometry = true
  } else {
    if (!deferringForGizmo.value) return
    deferringForGizmo.value = false
    engine.deferGeometry = false
    // The catch-up sync runs from the drag-end release hooks (onPivotDragEnd for
    // a pivot drag; the doc watcher for a single-object drag once this flag is
    // down), so the geometry rebuilds once at the final transform.
    engine.syncFromDoc(doc)
  }
}
// On window, not the panel: the pointer routinely leaves the controls column
// mid-drag, and a missed release would leave the viewport permanently stale.
function onGeometryDragRelease() {
  if (!deferringGeometry.value) return
  deferringGeometry.value = false
  if (!engine) return
  engine.deferGeometry = false
  engine.syncFromDoc(doc) // one rebuild, at the final slider values
}

/** Compact vertex figure: 4200 → "4.2k", 331_000 → "331k", 1_060_000 → "1.1M". */
function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

// Size = scale expressed in scene units. Base dimensions come from the geometry
// itself (rebuilt from the doc, so they follow parameter changes — a fatter torus
// tube is a bigger torus). GLBs fall back to the engine's measured bounds.
// Measuring a primitive means BUILDING it (with the cloner — an array really is
// wider), so this is as expensive as the engine's own rebuild. It therefore
// freezes with the mesh during a deferred drag: the Size row shows what is on
// screen, and both catch up together on release.
let lastBaseSize: [number, number, number] = [1, 1, 1]
const baseSize = computed<[number, number, number]>(() => {
  void fontGen.value // font loads aren't reactive; this re-measures when a font resolves
  void meshGen.value // ditto for mesh decodes — same non-reactive cache, same stale-Size bug
  const o = selected.value
  if (!o) return [1, 1, 1]
  if (deferringGeometry.value) return lastBaseSize
  lastBaseSize = o.kind === 'primitive'
    ? baseSizeFor(o.primitive, o.params, o.modifiers, o.content, varySettingsFor(o), modifierStackOf(o))
    : engine?.baseSizeOf(o.id) ?? [1, 1, 1]
  return lastBaseSize
})
// ── Text primitive controls (Geometry panel, above the schema-driven sliders) ──
// Not schema-driven like the sliders above: `content` only exists on `text`
// objects and holds a string + a font URL, not a numeric param.
const selectedText = computed<PrimitiveObject | null>(() => {
  const o = selected.value
  return o && o.kind === 'primitive' && o.primitive === 'text' ? o : null
})
const textValue = computed<string>({
  get: () => selectedText.value?.content?.text ?? '',
  set: (v) => {
    const o = selectedText.value
    if (!o) return
    if (o.content) o.content.text = v
    else o.content = { text: v, font: DEFAULT_FONT_URL } // defensive: content is always seeded by createPrimitive
  },
})
// FontPicker emits a discriminated payload (mirrors SpaceTypeSurface's usage):
// a pinned pick is one of our local AVAILABLE_FONTS urls (today's behavior,
// unchanged); a google pick writes the bare `google:Family` token — no weight
// suffix on first pick, matching the plan; a library pick writes a `local:Family`
// token seeded to the family's nearest-regular face weight (real weight present
// for the Weight select below, same reasoning as SpaceTypeSurface's onFontSelect).
function onFontPick(payload: { kind: 'google'; family: string } | { kind: 'pinned'; value: string } | { kind: 'library'; family: string; foundry: string }) {
  const o = selectedText.value
  if (!o) return
  if (payload.kind === 'library') {
    const existing = parseLibraryFontValue(o.content?.font ?? '')
    const face = resolveLibraryFace(payload.family, existing?.weight ?? 400, existing?.italic ?? false)
    const font = libraryToken(payload.family, face?.weight, face?.italic)
    if (o.content) o.content.font = font
    else o.content = { text: 'Text', font }
    return
  }
  let font: string
  if (payload.kind === 'pinned') {
    font = payload.value
  } else {
    // Weights are per-family: re-picking the SAME family (e.g. from the
    // catalog dropdown after already having chosen a weight) keeps that
    // weight instead of silently resetting it to the default; picking a
    // DIFFERENT family still resets, since its weight has no meaning there.
    const existing = parseGoogleFontValue(o.content?.font ?? '')
    font = existing && existing.family === payload.family && existing.weight !== undefined
      ? `google:${payload.family}@${existing.weight}`
      : `google:${payload.family}`
  }
  if (o.content) o.content.font = font
  else o.content = { text: 'Text', font }
}
// Local copy of the Google Fonts catalog, used only to resolve the selected
// family's available weights for the Weight select below (FontPicker owns its
// own copy for the searchable dropdown; loadGoogleCatalog is module-cached so
// this is a no-op refetch, same pattern as SpaceTypeSurface).
const fontCatalog = ref<GoogleFont[]>([])
loadGoogleCatalog().then((c) => { fontCatalog.value = c })
// Non-null only when the selected text's font is a `google:` token — drives
// the Weight select's visibility (hidden for local fonts).
const selectedGoogleFont = computed(() => {
  const font = selectedText.value?.content?.font
  return font ? parseGoogleFontValue(font) : null
})
// The family's catalog weights, or [400] until the catalog resolves (or if
// the family isn't found in it).
const fontWeightOptions = computed<string[]>(() => {
  const parsed = selectedGoogleFont.value
  if (!parsed) return []
  const entry = fontCatalog.value.find((f) => f.family === parsed.family)
  const weights = entry?.weights.length ? entry.weights : [400]
  return weights.map(String)
})
const fontWeight = computed<string>({
  get: () => String(selectedGoogleFont.value?.weight ?? 400),
  set: (w) => {
    const o = selectedText.value
    const parsed = selectedGoogleFont.value
    if (!o || !parsed) return
    const font = `google:${parsed.family}@${w}`
    if (o.content) o.content.font = font
    else o.content = { text: 'Text', font }
  },
})
// Parallel to selectedGoogleFont/fontWeightOptions/fontWeight above, for the licensed
// library scheme — non-null only when the selected text's font is a `local:` token.
// The library is static committed data (no catalog fetch needed): weights come
// straight from the manifest's faces for the family, unique + sorted ascending.
const selectedLibraryFont = computed(() => {
  const font = selectedText.value?.content?.font
  return font ? parseLibraryFontValue(font) : null
})
const libraryWeightOptions = computed<string[]>(() => {
  const parsed = selectedLibraryFont.value
  if (!parsed) return []
  const fam = libraryFamily(parsed.family)
  const weights = fam?.faces.length ? [...new Set(fam.faces.map((f) => f.weight))].sort((a, b) => a - b) : [400]
  return weights.map(String)
})
const libraryFontWeight = computed<string>({
  get: () => String(selectedLibraryFont.value?.weight ?? 400),
  set: (w) => {
    const o = selectedText.value
    const parsed = selectedLibraryFont.value
    if (!o || !parsed) return
    const font = libraryToken(parsed.family, Number(w), parsed.italic)
    if (o.content) o.content.font = font
    else o.content = { text: 'Text', font }
  },
})
// Inline load-error line, mirroring the GLB list's glbError convention but kept
// local (no id-keyed map needed — only the selected object's font is shown).
// loadFont caches by url, so switching back to an already-resolved font never
// re-fetches; a resolved load always clears the flag.
const fontError = ref(false)
// Bumped on a successful load so `baseSize` (which peeks the font cache but
// isn't reactive to it) re-measures once the font resolves.
const fontGen = ref(0)
watch(() => selectedText.value?.content?.font, (url) => {
  fontError.value = false
  if (!url) return
  loadFont(url).then(() => {
    // The selection (or its font) may have moved on while this load was in
    // flight — a stale success must not clear today's error or refresh a
    // mesh that isn't even showing this font anymore.
    if (selectedText.value?.content?.font !== url) return
    fontError.value = false
    fontGen.value++
    // loadFont doesn't cache failures, so a failed load never gets retried by
    // the engine itself — this watch firing again (on an unrelated doc edit,
    // a Retry click, whatever) IS the retry. On success, heal the mesh that's
    // been stuck on the placeholder cube since the failure, not just the Size
    // row (fontGen only re-measures; it doesn't touch geometry).
    engine?.refreshTextGeometry(url)
  }).catch(() => {
    if (selectedText.value?.content?.font !== url) return
    fontError.value = true
  })
}, { immediate: true })
// Exactly the fontGen story above, for meshes. `meshCache` is the same shape of
// non-reactive Map as the font cache, and `baseSize` peeks it through
// baseSizeFor → buildGeometry. A freshly converted (or freshly loaded) mesh
// therefore measures the 0.3 placeholder cube until its decode lands, and
// nothing reactive changes when it does — the viewport heals (the engine
// re-syncs itself) while the Size row stays stuck. Bumping this on a landed
// decode is what re-triggers the computed.
//
// loadMesh de-dupes by key, so calling it here shares the engine's own in-flight
// decode rather than inflating the buffer a second time.
const meshGen = ref(0)
// I4 fix (final review): mirrors `fontError` above exactly — before this, a
// corrupt/truncated mesh buffer failed completely silently. The viewport kept
// showing the 0.3 placeholder cube forever, the Remesh panel's vertex count
// read against the (stale, cached) placeholder while its KB figure read the
// real (larger) payload size, so the two disagreed with no explanation, and
// Sculpt's "Could not enter sculpt mode — try again" could never actually
// succeed on a retry. Cleared whenever the selection/meshKey changes so a
// stale error never lingers onto a different (healthy) object.
const meshError = ref(false)
watch(() => {
  const o = selected.value
  return o?.kind === 'primitive' && o.primitive === 'mesh' ? o.content?.meshKey : undefined
}, (key) => {
  meshError.value = false
  if (!key || meshCacheGet(key)) return // already decoded: the computed measured the real mesh
  const o = selected.value
  const encoded = o?.kind === 'primitive' ? o.content?.mesh : undefined
  if (!encoded) return
  loadMesh(encoded, key).then(() => {
    // The selection may have moved on mid-decode — a stale success must not
    // re-measure against an object that isn't showing this mesh.
    const now = selected.value
    if (now?.kind !== 'primitive' || now.content?.meshKey !== key) return
    meshError.value = false
    meshGen.value++
  }).catch(() => {
    // The selection may have moved on mid-decode — a stale failure must not
    // flag an object that isn't even showing this mesh anymore.
    const now = selected.value
    if (now?.kind !== 'primitive' || now.content?.meshKey !== key) return
    meshError.value = true
  })
}, { immediate: true })
// ── The schema-driven inspector panel ────────────────────────────────────────
// Transform / Material / Camera / Lighting / Background are drawn from SCENE_CONTROLS via
// the presentation remap in lib/scene3d/panelPresentation.ts (see its doc for why a remap
// rather than the schema itself). The third argument stays `undefined` — it exists only so
// a test can append a novel control to a COPY of SCENE_CONTROLS. `baseSize` is the fourth
// because the Size rows show world units, which only the built geometry knows.
const panelControls = computed(() => scenePanelControls(doc, selected.value, undefined, { baseSize: baseSize.value }))
const panelChrome = computed(() => scenePanelChrome(selected.value ? matType.value : null))

/** The panel's `value` prop. `post.*` keeps its own resolver (doc.post is a plain
 *  PostSettings object, not part of the object/doc path space); everything else goes
 *  through the one reader the parity spec and the visibility gates also use. */
function readControl(key: string): string | number | boolean {
  if (key.startsWith('post.')) return readPost(key)
  return readSceneControl(doc, selected.value, key, { baseSize: baseSize.value }) as string | number | boolean
}

/** Plain material fields — the generic half of what the deleted `matParam` proxies did,
 *  including the multi-selection fan-out that makes "select the logo's paths, pick gold"
 *  one action instead of twelve. */
function setMaterialControl(field: string, value: string | number | boolean): void {
  if (field === 'relief.source') { setReliefSource(value as 'none' | 'shader' | 'image'); return }
  if (field.startsWith('relief.')) { setReliefField(field.slice('relief.'.length), value); return }
  // Screen: always write a FULL block (every field filled from defaults) so a first dial
  // write from a screen-less material creates a valid ScreenSpec rather than a bare
  // `{ density: 60 }` the parser would read as pattern none.
  if (field.startsWith('screen.')) {
    const sub = field.slice('screen.'.length)
    // Glass is skipped in the fan-out: the row is only offered because the PRIMARY
    // selection can take a screen, but a multi-selection may include glass, and
    // buildMaterial ignores `screen` there — writing it would leave a spec on the doc
    // that nothing renders and that would come alive if the material type ever changed.
    applyMaterial((m) => {
      if (m.type === 'glass') return
      m.screen = { ...screenOf(m), [sub]: value } as ScreenSpec
    })
    return
  }
  applyMaterial((m) => writeMaterialField(m, field, value))
}

/** The panel's `@set`. One dispatch over the same dotted keys `readControl` resolves. */
function setControl(key: string, value: string | number | boolean): void {
  if (key.startsWith('post.')) { setPost(key, value); return }
  if (key === 'showFloor') { doc.showFloor = value === true; return }
  if (key === 'camera.fov') { doc.camera.fov = Number(value); return }
  if (key === 'lighting.preset') { doc.lighting.preset = String(value) as SceneDoc['lighting']['preset']; return }
  // The row offers the segmented control's SHORT labels, not the EnvironmentKind values.
  if (key === 'lighting.environment') { doc.lighting.environment = ENV_BY_LABEL[String(value)] ?? 'room'; return }
  // Gel string/boolean fields must bypass the numeric coercion below: the four gel colours
  // (hex strings) and the rim toggle (boolean). Everything else under lighting.* is numeric.
  if (key === 'lighting.gelColorA' || key === 'lighting.gelColorB'
    || key === 'lighting.gelRimColor' || key === 'lighting.gelBackground') {
    ;(doc.lighting as Record<string, unknown>)[key.slice('lighting.'.length)] = String(value)
    return
  }
  if (key === 'lighting.gelRim') { doc.lighting.gelRim = value === true; return }
  // Simple-lighting non-numeric fields must also bypass the numeric coercion below:
  // `look` is a recipe id (string) and `advanced` is a boolean. Without this,
  // Number('softbox-beauty') → NaN and the Look select never sticks.
  if (key === 'lighting.look') { doc.lighting.look = String(value); return }
  if (key === 'lighting.advanced') { doc.lighting.advanced = value === true; return }
  if (key.startsWith('lighting.')) {
    ;(doc.lighting as Record<string, unknown>)[key.slice('lighting.'.length)] = Number(value)
    return
  }
  if (key.startsWith('object.material.')) { setMaterialControl(key.slice('object.material.'.length), value); return }
  // The three Transform branches. They come BEFORE the generic `setByPath` fallback and
  // must: the rows show degrees and world Size, so writing their values straight onto
  // `object.rotation.0` / `object.scale.0` would store a degree as a radian and a world
  // extent as a multiplier — and would skip `axisDeltaWrites`, which is what keeps a
  // multi-selection edit a DELTA instead of stacking every selected object on one spot.
  const axis = Number(key.slice(-1)) as 0 | 1 | 2
  if (key.startsWith('object.position.')) { writeTransform('position', axis, Number(value)); return }
  if (key.startsWith('object.rotation.')) { writeTransform('rotation', axis, Number(value)); return }
  if (key.startsWith('object.scale.')) { writeTransform('scale', axis, Number(value)); return }
  // Geometry: both bags are FLAT NUMBER MAPS the engine reads by key (primParams.ts), so
  // a `switch` row's boolean is stored as 0 | 1 — `readSceneControl`'s toggle branch is
  // the exact inverse. Writing `true` in there would make `resolveParam` fall straight
  // back to the default and the checkbox would appear to do nothing.
  if (key.startsWith('object.params.')) {
    setParam(key.slice('object.params.'.length), typeof value === 'boolean' ? (value ? 1 : 0) : Number(value))
    return
  }
  if (key.startsWith('object.modifiers.')) { setMod(key.slice('object.modifiers.'.length), Number(value)); return }
  // Light fields sit FLAT on the LightObject — `object.light` is already taken, it holds
  // the KIND — and a decal's projection fields sit flat on the DecalObject (see
  // controls.ts). Both write onto the PRIMARY selection only, exactly as the deleted
  // `lightParam`/`decalParam` proxies did: unlike a material edit there has never been a
  // multi-selection fan-out here. This branch also keeps a stray `object.*` key OUT of
  // the doc-level fallback below, which would otherwise invent a `doc.object` bag that
  // nothing reads.
  if (key.startsWith('object.')) {
    const o = selected.value
    if (!o) return
    // A decal's spin is degrees on screen and radians on disk — the same split
    // `object.rotation.*` has, and `readSceneControl` is this line's exact inverse.
    setByPath(o, key.slice('object.'.length), key === 'object.spin' ? (Number(value) * Math.PI) / 180 : value)
    return
  }
  // Generic fallback: any key the branches above don't special-case (a novel Camera/
  // Background/doc-level control the panel now draws via panelPresentation.ts's
  // permissive `panelCardOf`) still has to write somewhere. Mirrors `setPost`'s own
  // generic write into `doc.post` above, just over the whole doc instead of one
  // sub-object. The relief seeding, degree conversion and material multi-select fan-out
  // above stay special-cased for their own keys; this only catches what they don't.
  // No explicit undo call needed — the deep `watch(doc, …, { deep: true })` below
  // schedules history for every doc mutation, this one included.
  setByPath(doc, key, value)
}

// ── Engine lifecycle ──────────────────────────────────────────────────────────
const canvasEl = ref<HTMLCanvasElement | null>(null)
const viewportEl = ref<HTMLDivElement | null>(null)
let engine: SceneEngine | null = null
let interaction: SceneInteraction | null = null
let raf = 0
let ro: ResizeObserver | null = null
// Wall-clock start of this surface's rAF loop — a shaderFill field's animation clock runs off
// elapsed real time, same as ShapeStudioSurface.vue's `mountedAt` (Scene3D's own playhead
// governs object motion, not this). Set once in onMounted, read every loop() tick.
let scene3dMountedAt = 0
// Frozen-field hint, mirroring ShapeStudioSurface.vue's frozenFieldCount exactly (same design
// rule: no silent caps on any surface). Reset to 0 whenever the doc has no shaderFill material
// so it doesn't show a stale count after switching a material away from shaderFill.
const shaderFrozenCount = ref(0)

// Light View HTML labels: a chip per light (color dot + name + live intensity)
// at its projected screen position. Reprojected every frame in the rAF loop
// since the camera orbits — cheap for the ≤MAX_LIGHTS-sized array.
const lightLabels = ref<{ id: string; name: string; intensity: number; color: string; x: number; y: number; show: boolean }[]>([])
function updateLightLabels() {
  if (!lightView.value || !engine || !viewportEl.value) { lightLabels.value = []; return }
  const rect = viewportEl.value.getBoundingClientRect()
  const w = rect.width, h = rect.height
  lightLabels.value = doc.objects.filter((o) => o.kind === 'light').map((o) => {
    const light = o as LightObject
    const ndc = new THREE.Vector3(...light.position).project(engine!.camera)
    return {
      id: light.id,
      name: light.name,
      intensity: light.intensity,
      color: light.color,
      x: (ndc.x * 0.5 + 0.5) * w,
      y: (-ndc.y * 0.5 + 0.5) * h,
      show: ndc.z < 1,
    }
  })
}

/**
 * Document truth for end-to-end tests, and ONLY for them.
 *
 * The panel rows read at the precision they display (one decimal for Position, whole
 * degrees for Rotation — see panelPresentation.ts), which is right for a control and wrong
 * for an assertion about geometry: grouping puts a group at its children's centroid, which
 * lands off the 0.1 grid, so a rounded row reading cannot add back to the exact world
 * position. `tests/scene3d-grouping.spec.ts` used to measure that invariant through
 * `aria-valuenow` and only passed because the read was raw. It reads this instead — the
 * document itself, at full precision — and keeps the row reads for what rows are actually
 * evidence of: what the user sees and types.
 *
 * A getter, not a reactive mirror: it costs nothing until a test calls it, and it cannot
 * drift from `doc` because it IS `doc`. Serialised through the same `serializeDoc` the
 * persistence path uses, so a test can never accidentally hold a live reactive proxy.
 * Removed on unmount, like every other `window.__*` harness hook in this repo.
 */
onMounted(() => {
  ;(window as any).__scene3dDoc = () => JSON.parse(serializeDoc(doc))
  // Camera truth, same contract, for the tests that assert whether a drag
  // orbited: the doc carries no live camera, and comparing rendered pixels
  // cannot tell "the camera moved" from "a frame differed".
  ;(window as any).__scene3dCamera = () => {
    if (!engine) return null
    const p = engine.camera.position, t = interaction?.orbit.target
    return { x: p.x, y: p.y, z: p.z, tx: t?.x ?? 0, ty: t?.y ?? 0, tz: t?.z ?? 0 }
  }
  ;(window as any).__scene3dTreatmentStats = () => engine ? { ...engine.treatmentStats } : null
  ;(window as any).__scene3dSnapshot = () => engine?.snapshot() ?? ''
  ;(window as any).__scene3dBeauty = async () => engine ? (await renderPasses(engine, doc, 0)).beauty : ''
  // A deterministic MOVING-frame oracle for the S6 motion tests: the existing __scene3d* hooks
  // render at t=0 (still), where velocity blur / ghost trails have nothing to show. This runs the
  // full sample → velocity/ghost push → render path at an arbitrary t01 (renderMotionFrame does
  // all of it) and returns the data-URL, so a Playwright test gets a frame at a chosen moment
  // without racing the playhead.
  ;(window as any).__scene3dSnapshotAt = (t01: number) =>
    engine ? (renderMotionFrame(engine, doc, t01) as HTMLCanvasElement).toDataURL('image/png') : ''
})
onBeforeUnmount(() => {
  for (const k of ['__scene3dDoc', '__scene3dCamera', '__scene3dTreatmentStats', '__scene3dSnapshot', '__scene3dBeauty', '__scene3dSnapshotAt']) delete (window as any)[k]
})

onMounted(() => {
  webglOk.value = detectWebGL()
  if (!webglOk.value || !canvasEl.value || !viewportEl.value) return
  const rect = viewportEl.value.getBoundingClientRect()
  engine = new SceneEngine(canvasEl.value, rect.width, rect.height)
  engine.applyCameraFromDoc(doc)
  interaction = new SceneInteraction(engine, viewportEl.value, {
    onSelect: (id, additive) => {
      // Gap 3 fix: a miss must not touch selection while sculpting either — this
      // branch used to bypass toggleSelected's `if (sculpting.value) return`
      // guard entirely, so a stray click that missed the sculpted mesh (picked
      // up by the ordinary object picker once the sculpt pointerdown handler
      // itself declined it) silently cleared selectedIds. That was harmless
      // before this task: the sculpt panel used to render off `sculpting` alone,
      // so it stayed on screen regardless. Now that it renders off
      // `sculpting && selectedMesh` (so it can sit beside a live Material/
      // Transform instead of replacing the whole column), losing selectedIds
      // mid-session hid the panel entirely — including Apply/Exit — while the
      // engine override and orbit lock stayed live underneath, stranding the
      // user with no visible way out. Same invariant toggleSelected already
      // enforces, just applied to the miss path too.
      if (sculpting.value) return
      // A miss with a modifier held leaves the selection alone. Shift-clicking is
      // how you BUILD a multi-selection, so one shift-click that lands a few
      // pixels off an object must not throw away everything picked up so far —
      // the gesture that adds must never be the gesture that wipes.
      if (!id) { if (!additive) selectedIds.value = []; return }
      toggleSelected(id, additive)
    },
    onTransform: (id, t) => {
      const o = doc.objects.find((x) => x.id === id)
      if (o) { o.position = t.position; o.rotation = t.rotation; o.scale = t.scale }
    },
    onTransformMany: (entries) => {
      // Entries carry WORLD transforms (under the gizmo pivot a root's local TRS
      // is pivot-relative), so rebaseMany turns each one back into a local under
      // its real parent — the doc stores LOCAL transforms. The parents-before-
      // children ordering that a parent+descendant selection depends on lives in
      // there too, where it is unit-tested (scene3d-hierarchy.unit.spec.ts).
      for (const { id, t } of rebaseMany(doc.objects, entries)) {
        const o = doc.objects.find((x) => x.id === id)
        if (o) { o.position = t.position; o.rotation = t.rotation; o.scale = t.scale }
      }
    },
    // The drag suppressed every syncFromDoc it triggered (see the doc watcher);
    // run the one that was owed now that the roots are back in the scene, so
    // they land under their real parents again.
    onPivotDragEnd: () => { engine?.syncFromDoc(doc) },
    onGizmoDragChange,
    // A right-click in the viewport dropped the armed placement — clear the
    // surface's half of that mode (crosshair, hint banner, "Click a surface…").
    onPlacementCancelled: () => { placingDecal.value = null },
    // Grab-to-move a sticker: a decal is draggable, and its surface is its own target.
    decalTargetFor: (id) => {
      const o = doc.objects.find((x) => x.id === id)
      return o?.kind === 'decal' ? o.targetId : null
    },
    // Live reposition during a drag — same write as onDecalPlaced's reposition branch, minus
    // the target swap (a drag stays on the original solid). The engine re-projects the sticker
    // because decalKeyFor includes position/rotation.
    onDecalReposition: (decalId, hit) => {
      const d = doc.objects.find((x) => x.id === decalId)
      if (d?.kind === 'decal') { d.position = hit.localPoint; d.rotation = eulerFromNormal(hit.localNormal) }
    },
  })
  interaction.orbit.target.set(...doc.camera.target)
  engine.syncFromDoc(doc)
  scene3dMountedAt = performance.now()
  // Catalog fetch is cached module-wide (catalog.ts) — a no-op if another already-open
  // studio surface pulled it this page load. Priming it here (rather than waiting for the
  // material panel's ShaderFillEditor to mount) means it's usually already warm by the time
  // a user picks the shaderFill material type. Sync reads (getEffectSync, inside resolveField)
  // work before this resolves too; they just render nothing until it does.
  fetchShaderFxCatalog().catch(() => { /* ShaderFillEditor's own picker falls back to the raw id and offers a Retry */ })
  // Warm-up every restored GLB so a scene loaded from scene_state surfaces load
  // failures in the list too (the engine's own load leaves an empty group silently;
  // addGlb/duplicateObject only warm the ones created this session).
  for (const o of doc.objects) {
    if (o.kind === 'glb') loadGlb(o.url).catch(() => { glbError[o.id] = true })
  }
  const loop = () => {
    // Only touch the shader-field refresh path when the doc actually has a shaderFill
    // material — see SceneEngine.refreshShaderFields's doc: this isn't needed for correctness
    // (an owner with no shaderFill materials is a cheap no-op inside refreshSceneShaderFields),
    // it's so an ordinary scene's frame loop never starts paying new per-frame cost it never
    // paid before.
    if (engine) {
      const hasShaderFill = sceneHasShaderFill(doc)
      if (hasShaderFill) engine.refreshShaderFields((performance.now() - scene3dMountedAt) / 1000)
      shaderFrozenCount.value = hasShaderFill ? engine.frozenFieldCount : 0
      // Same gate shape as shaderFill: only a flowing opal (opalFlowSpeed > 0) needs a per-frame
      // uTime write; a still opal or an opal-free scene skips it entirely.
      if (sceneHasOpalFlow(doc)) engine.refreshOpal((performance.now() - scene3dMountedAt) / 1000)
    }
    if (playing.value && engine) {
      const dur = doc.motion.duration
      const elapsed = (performance.now() - playStart) / 1000
      playhead.value = doc.motion.loop ? elapsed % dur : Math.min(elapsed, dur)
      const t01 = dur > 0 ? playhead.value / dur : 0
      const { doc: sampled, opacities } = applyMotionToDoc(doc, t01)
      // Lock orbit while the camera is animated so it can't fight the motion.
      // Must go through setCameraLocked, not a direct `orbit.enabled =` write:
      // a gizmo drag also owns that flag (SceneInteraction's dragging-changed
      // listener), and this runs every frame — a raw per-frame write here would
      // silently stomp the gizmo's lock the instant a drag starts (this exact
      // bug shipped once already; see interaction.ts's orbitShouldBeEnabled).
      interaction?.setCameraLocked(!!(doc.camera.motion && doc.camera.motion.preset !== 'none'))
      // Refuse gizmo grabs for as long as playback runs. Dragging against a
      // per-frame re-sync from a SAMPLED doc is incoherent for a single
      // selection and destructive for a multi-selection: the sync tears the
      // roots out of the pivot, which keeps emitting, so each object's
      // motion-sampled world transform gets written back as its BASE local and
      // the animation's offsets are baked in permanently.
      interaction?.setPlaybackLocked(true)
      // Second line of defence for the one way a drag can still be live here —
      // playback started (keyboard, or the button on a second pointer) with the
      // pointer already down, which the lock above deliberately does not
      // interrupt. Sampled state is throwaway; the pivot's roots are not.
      if (!interaction?.pivotDragActive) engine.syncFromDoc(sampled)
      engine.applyCameraFromDoc(sampled)
      engine.applyObjectOpacities(opacities)
      interaction?.orbit.update()
      // S6 motion treatments: sample the per-object screen velocity / past poses from the
      // ORIGINAL doc + t01 (the sampled doc has motion already baked into its transforms) and
      // push them into the engine so the stage can smear / trail the object. Camera-at-t viewProj
      // (object-only velocity — an orbiting camera does not blur a static object). Cleared to
      // empty otherwise, so a scene with no motion treatment pays nothing and stays byte-identical.
      if (docHasMotionTreatment(doc)) {
        engine.camera.updateMatrixWorld()
        const viewProj = new THREE.Matrix4().multiplyMatrices(engine.camera.projectionMatrix, engine.camera.matrixWorldInverse)
        engine.setMotionVelocities(sceneScreenVelocities(doc, t01, viewProj))
        engine.setGhostPoses(collectGhostPoses(doc, t01))
      } else {
        engine.setMotionVelocities(new Map())
        engine.setGhostPoses(new Map())
      }
      engine.render((performance.now() - scene3dMountedAt) / 1000)
      updateLightLabels()
    } else {
      interaction?.setCameraLocked(false)
      interaction?.setPlaybackLocked(false)
      interaction?.orbit.update()
      // A paused (not-playing) frame is still: clear the motion maps so velocityBlur no-ops and
      // ghost trails collapse — "none when still" holds for a paused clip.
      engine?.setMotionVelocities(new Map())
      engine?.setGhostPoses(new Map())
      engine?.render((performance.now() - scene3dMountedAt) / 1000)
      updateLightLabels()
    }
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)
  ro = new ResizeObserver(() => {
    const r = viewportEl.value?.getBoundingClientRect()
    if (r && engine) engine.setSize(r.width, r.height)
  })
  ro.observe(viewportEl.value)
  // Capture phase: StudioModalShell (a child, so its onMounted runs first)
  // registered its Escape→close keydown on window (bubble) BEFORE ours, and
  // stopPropagation can't stop already-queued same-node listeners. Capturing
  // lets Esc-with-selection deselect first and suppress the shell's close via
  // stopImmediatePropagation + preventDefault (the shell also early-returns on
  // e.defaultPrevented). Same technique as StudioColor's popover.
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('pointerup', onGeometryDragRelease)
  window.addEventListener('pointercancel', onGeometryDragRelease)
  // Sculpt pointer loop: pointerdown is scoped to the viewport (mirrors
  // SceneInteraction's own domElement listeners); move/up sit on window so a
  // drag that leaves the canvas mid-stroke still ends cleanly, same as the
  // gizmo-drag release convention above. Every handler no-ops via
  // `sculpting.value`/`sculptStrokeDown` guards when not actually sculpting,
  // so these are safe to leave attached for the surface's whole lifetime.
  viewportEl.value.addEventListener('pointerdown', onSculptPointerDown)
  window.addEventListener('pointermove', onSculptPointerMove)
  window.addEventListener('pointerup', onSculptPointerUp)
  window.addEventListener('pointercancel', onSculptPointerUp)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('pointerup', onGeometryDragRelease)
  window.removeEventListener('pointercancel', onGeometryDragRelease)
  window.removeEventListener('pointerdown', onAddMenuOutside, true)
  viewportEl.value?.removeEventListener('pointerdown', onSculptPointerDown)
  window.removeEventListener('pointermove', onSculptPointerMove)
  window.removeEventListener('pointerup', onSculptPointerUp)
  window.removeEventListener('pointercancel', onSculptPointerUp)
  cancelAnimationFrame(raf)
  ro?.disconnect()
  interaction?.dispose()
  engine?.dispose()
})

// Any edit re-dirties and clears a stale bake failure so the amber "unbaked
// changes" indicator isn't masked by an old red "Bake failed — retry".
watch(doc, () => {
  bakeError.value = ''
  // A multi-selection drag has the selected roots temporarily re-parented under
  // the gizmo pivot, and syncObject re-parents EVERY root to its doc parent on
  // every sync — syncing here (from the drag's own per-move doc writes) would
  // rip them out of the pivot after the first delta and leave the rest of the
  // gesture moving nothing. The viewport is already live during that window
  // (the pivot moves the roots directly), and onPivotDragEnd runs the sync.
  if (!interaction?.pivotDragActive) engine?.syncFromDoc(doc)
  scheduleHistory()
}, { deep: true })
// Look change → apply the whole recipe (direction, env, preset, default dials),
// then recompute the dial-driven fields from those defaults.
watch(() => doc.lighting.look, (id) => {
  const recipe = getLook(id)
  const p = resolveLook(recipe)
  doc.lighting.sunAzimuth = p.sunAzimuth
  doc.lighting.sunElevation = p.sunElevation
  doc.lighting.environment = p.environment
  doc.lighting.preset = p.preset
  doc.lighting.softness = p.softness
  doc.lighting.warmth = p.warmth
  const d = resolveDials(recipe, { softness: p.softness, warmth: p.warmth, brightness: doc.lighting.brightness })
  doc.lighting.sunIntensity = d.sunIntensity
  doc.lighting.ambient = d.ambient
  doc.lighting.sunColor = d.sunColor
  doc.lighting.shadowSoftness = d.shadowSoftness
})
// Dial change → recompute ONLY the dial-driven fields; direction/env/preset untouched.
watch(() => [doc.lighting.softness, doc.lighting.warmth, doc.lighting.brightness], () => {
  const recipe = getLook(doc.lighting.look)
  const d = resolveDials(recipe, {
    softness: doc.lighting.softness, warmth: doc.lighting.warmth, brightness: doc.lighting.brightness,
  })
  doc.lighting.sunIntensity = d.sunIntensity
  doc.lighting.ambient = d.ambient
  doc.lighting.sunColor = d.sunColor
  doc.lighting.shadowSoftness = d.shadowSoftness
})
// Watches the whole ORDERED selection, not just the primary: a modifier-click
// that only extends the list leaves `selectedId` unchanged but still has to
// rebuild the gizmo around a pivot.
watch(selectedIds, (ids) => {
  if (ids.length) { selectedTreatment.value = null; selectedModifier.value = null } // an object selection replaces a treatment/modifier selection
  // ANY light in the selection suppresses the scale gizmo, not just the primary:
  // LightObject's scale is never read, so scaling a light in a mixed selection
  // writes a number nothing honours — and a light that resists scaling alone but
  // accepts it next to a cube is the more confusing of the two behaviours.
  // A decal in the selection suppresses the gizmo entirely: its `position`/
  // `rotation` are the projection point and projector orientation in the
  // TARGET'S local space, so a world-space gizmo drag would write numbers that
  // mean something else — repositioning goes through click-to-place instead.
  const kinds = new Set(ids.map((id) => doc.objects.find((o) => o.id === id)?.kind))
  interaction?.selectMany([...ids], { noScale: kinds.has('light'), noGizmo: kinds.has('decal') })
  engine?.setSelected(ids[ids.length - 1] ?? null)
  // Minor 4 fix (final review): an open Generate panel stays bound to whichever object it was
  // opened for via reliefGenBusy/reliefGenPrompt's shared id-keying, but its BUTTON just reads
  // `selected.id` at click time — leaving the panel open across a reselect would bill the
  // newly-selected object for a prompt the user wrote while looking at a different one. The
  // prompt text itself carrying over is harmless (Minor, not Critical); only the panel's
  // visibility needs resetting.
  reliefGenOpen.value = false
})
watch(snap, (s) => interaction?.setSnap(s))
watch(lightView, (on) => engine?.setLightView(on))

// ── Undo / redo ──────────────────────────────────────────────────────────────
// History is a stack of serialized doc snapshots, coalesced by a short debounce so
// a whole slider drag collapses into ONE step. A restore mutates the doc in place;
// `restoring` suppresses the history push that its own change would otherwise queue.
const undoStack: string[] = []
const redoStack: string[] = []
let lastSnapshot = serializeDoc(doc)
let restoring = false
let histTimer: ReturnType<typeof setTimeout> | null = null
function commitHistory() {
  histTimer = null
  const cur = serializeDoc(doc)
  if (cur === lastSnapshot) return
  undoStack.push(lastSnapshot)
  if (undoStack.length > 100) undoStack.shift()
  redoStack.length = 0
  lastSnapshot = cur
}
function scheduleHistory() {
  if (restoring) return
  if (histTimer) clearTimeout(histTimer)
  histTimer = setTimeout(commitHistory, 350)
}
function applySnapshot(snap: string) {
  const p = parseDoc(snap)
  restoring = true
  doc.objects = p.objects
  doc.camera = p.camera
  doc.lighting = p.lighting
  doc.background = p.background
  doc.showFloor = p.showFloor
  doc.post = p.post
  doc.output = p.output
  doc.motion = p.motion
  // A restored snapshot may not contain the selected object anymore.
  selectedIds.value = selectedIds.value.filter((id) => doc.objects.some((o) => o.id === id))
  lastSnapshot = snap
  nextTick(() => { restoring = false })
}
function undo() {
  if (histTimer) { clearTimeout(histTimer); commitHistory() } // flush a pending in-progress edit first
  const snap = undoStack.pop()
  if (snap === undefined) return
  redoStack.push(serializeDoc(doc))
  applySnapshot(snap)
}
function redo() {
  const snap = redoStack.pop()
  if (snap === undefined) return
  undoStack.push(serializeDoc(doc))
  applySnapshot(snap)
}

function onKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  const inField = tag === 'INPUT' || tag === 'TEXTAREA' || !!(e.target as HTMLElement)?.isContentEditable
  // Own Cmd/Ctrl+Z (Shift = redo; Cmd+Y = redo) so the canvas graph's undo doesn't
  // fire while the studio is open. Skipped while typing in a field (its native undo wins).
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !inField) {
    const k = e.key.toLowerCase()
    if (k === 'z') {
      e.preventDefault(); e.stopImmediatePropagation()
      // Sculpt mode owns undo while active — see sculptUndo's doc. Must
      // return here unconditionally so this never falls through to the
      // studio's own doc-level undo/redo below (rule #3 of Task 13's brief).
      if (sculpting.value) { sculptUndo(); return }
      if (e.shiftKey) redo(); else undo()
      return
    }
    if (k === 'y') { e.preventDefault(); e.stopImmediatePropagation(); redo(); return }
    // Cmd/Ctrl+G groups, +Shift ungroups. Handled here (not down by Escape, as
    // the brief first sketched) because the very next line unconditionally
    // returns on ANY modified key — a branch placed after it would never run.
    if (k === 'g') { e.preventDefault(); e.stopImmediatePropagation(); if (e.shiftKey) ungroupSelection(); else groupSelection(); return }
  }
  // Never hijack other modified chords (Cmd+R reload, Ctrl/Alt combos).
  if (e.metaKey || e.ctrlKey || e.altKey) return
  // An armed decal placement owns Esc first — it is the most transient mode on
  // the surface, and leaving it armed after an Escape would consume the user's
  // next click somewhere they didn't intend. Deliberately ABOVE the `inField`
  // bail: placement is armed straight from the decal panel, so the focus is
  // very often still in the Label input, and Escape there has no native
  // meaning worth protecting.
  if (e.key === 'Escape' && placingDecal.value) {
    e.preventDefault()
    e.stopImmediatePropagation()
    cancelDecalPlacement()
    return
  }
  if (inField) return
  // (No W/E/R mode shortcuts — the combined gizmo moves/rotates/scales at once.)
  if (e.key === 'Escape') {
    // The shape-library picker owns Escape while open. Our capture listener runs
    // BEFORE the picker's (it registered later), so yielding here lets the picker
    // close itself and preventDefault, which the shell already honours.
    if (libraryPickerOpen.value) return
    // The Look library picker (RowLook → LookPicker) owns Escape while open, the same
    // way StudioColor does below: it's a generic row renderer that can't reach our
    // state, so it marks its root `data-look-picker` and we yield on that marker. It
    // registered its capture listener after us, so yielding lets it close itself and
    // preventDefault, which the shell honours — otherwise Escape would close the editor.
    if (document.querySelector('[data-look-picker]')) return
    // Open primitive/light/decal/generate menu owns Esc: close it, never the modal.
    if (primMenuOpen.value || lightMenuOpen.value || decalMenuOpen.value || genOpen.value) {
      e.preventDefault()
      e.stopImmediatePropagation()
      closeAddMenus()
      return
    }
    // An open StudioColor popover owns Escape (its own capture listener closes
    // it); it registered after us so we'd fire first — yield to it.
    if (document.querySelector('[data-studio-color-pop]')) return
    // Escape must not touch selection at all while sculpting — the sculpted
    // object stays the (sole) selection for the whole session, and either
    // mutation below (ascend to parent group, or deselect) would desync the
    // Objects-list highlight from the live sculpt target for no functional
    // reason (finding 4, Task 13 review). Still swallow the key (preventDefault
    // + stop) rather than falling through — before this fix a selection was
    // always present while sculpting, so Escape never reached the shell; an
    // untouched-selection no-op must not suddenly let it close the modal.
    if (sculpting.value) {
      e.preventDefault()
      e.stopImmediatePropagation()
      return
    }
    const primary = selectedId.value ? doc.objects.find((o) => o.id === selectedId.value) : null
    if (primary?.parentId) {
      // Step up to the containing group rather than clearing — the only
      // traversal in the model, and the way a group gets selected from the
      // viewport (clicking always picks the child).
      e.preventDefault()
      e.stopImmediatePropagation()
      selectedIds.value = [primary.parentId]
      return
    }
    if (selectedId.value) {
      // Deselect only: preventDefault + stopImmediatePropagation keep the
      // shell's window keydown (and anything else) from closing the modal.
      e.preventDefault()
      e.stopImmediatePropagation()
      selectedId.value = null
    }
    // No selection → fall through untouched; the shell's Escape closes.
  }
  else if (e.key === 'Backspace' && selectedIds.value.length && !sculpting.value) {
    // Snapshot before looping: removeObject mutates selectedIds as it goes (a
    // cascade can remove a later id in this same batch as somebody else's
    // descendant), and iterating the live ref would skip or re-visit entries.
    for (const id of [...selectedIds.value]) removeObject(id)
  }
}

// ── Grouping ──────────────────────────────────────────────────────────────────
/** Wrap the selection in a new group. The group is parented wherever the
 *  PRIMARY selection lives, so grouping inside an existing group nests rather
 *  than escaping to the root. */
function groupSelection() {
  // Decal-free (see groupableIds) — a decal in the selection is skipped, not a
  // reason to refuse the whole group.
  const ids = groupableIds.value
  if (ids.length < 2) return
  const primary = doc.objects.find((o) => o.id === ids[ids.length - 1]!)
  const group = createGroup(doc.objects)
  if (primary?.parentId) group.parentId = primary.parentId
  doc.objects = groupObjects(doc.objects, ids, group)
  selectedIds.value = [group.id]
}

/** Dissolve every selected group, freeing its children in place. The actual
 *  dissolve-and-collect logic lives in `ungroupMany` (hierarchy.ts) — it has to
 *  handle a selection containing both a group and its own descendant group,
 *  which isn't safe to get right in a component with no unit test coverage. */
function ungroupSelection() {
  const groupIds = selectedObjects.value.filter((o) => o.kind === 'group').map((o) => o.id)
  if (!groupIds.length) return
  const { objects, freedIds } = ungroupMany(doc.objects, groupIds)
  doc.objects = objects
  selectedIds.value = freedIds
}

// ── Object operations ─────────────────────────────────────────────────────────
function addPrimitive(kind: PrimitiveKind) {
  const o = createPrimitive(kind, doc.objects)
  doc.objects.push(o)
  selectedId.value = o.id
}

// ── Convert to mesh ───────────────────────────────────────────────────────────
/** Freeze the selection's CURRENT geometry (modifiers included) into a `mesh`
 *  primitive. Irreversible in the object itself — the frozen vertices carry no
 *  record of the params and modifiers they were built from, so there is nothing
 *  to convert back to — and the studio's doc-level undo is the way back. It runs
 *  straight off the click, with no confirm: no other destructive action on this
 *  surface has one either. */
const converting = ref(false)
// Inline failure line under the To mesh button. Both of this action's refusals
// (unresolved font, over the vertex cap) were console-only, so a click on a
// too-dense object looked like the button was simply broken. Same convention as
// uploadError above: a short plain sentence, cleared on the next attempt.
const convertError = ref('')
async function convertSelectionToMesh() {
  const src = selectedObjects.value[0] as PrimitiveObject | undefined
  if (!src || converting.value) return
  convertError.value = ''
  // A `text` object builds real glyph geometry only once its font is resolved
  // in the cache; before that, buildGeometry falls back to the 0.3 placeholder
  // cube (see baseSizeFor's note above). Converting in that state would freeze
  // the placeholder permanently, so refuse and leave the object untouched.
  if (src.primitive === 'text' && !fontCacheGet(src.content?.font ?? DEFAULT_FONT_URL)) {
    convertError.value = 'Still loading the font — try again in a moment.'
    return
  }
  converting.value = true
  const font = src.primitive === 'text' ? fontCacheGet(src.content?.font ?? DEFAULT_FONT_URL) : null
  // Vary is passed so the frozen mesh matches what is on screen — in random and
  // falloff modes it damps each copy's step rotate/scale, so omitting it would bake
  // clone placements the user never saw.
  //
  // Per-copy COLOUR does not survive this bake: `meshDataFromGeometry` carries
  // positions and indices only, so the `color` attribute AND the `varyTint` stamp are
  // both dropped. That degrades safely rather than lying — with no stamp, materials.ts
  // builds a plain material and the mesh renders in the material's own colour, instead
  // of keeping vertexColors on over an attribute that is no longer there. A converted
  // object also loses `params`/`modifiers` by design (see convertToMesh), so there is
  // no cloner left to re-derive the colours from either.
  //
  // colorEnabled: false, same precedent as baseSizeFor in engine.ts — colour is
  // discarded one line below by meshDataFromGeometry regardless, so building it here
  // would only pay for a Float32Array of per-vertex colour plus a THREE.Color per
  // copy that nothing ever reads. Positions are untouched by colour, so no behaviour
  // changes.
  const geo = buildGeometry(src.primitive, src.params, src.modifiers, 'smooth', src.content, font, { ...varySettingsFor(src), colorEnabled: false }, modifierStackOf(src))
  try {
    // Counted here rather than left to encodeMesh's throw so the message can
    // name the real figures in plain words; encodeMesh still guards the library
    // path for every other caller.
    const verts = geo.getAttribute('position')?.count ?? 0
    if (verts > MESH_VERTEX_CAP) {
      convertError.value = `Too detailed to convert — ${verts.toLocaleString('en-US')} vertices, the limit is ${MESH_VERTEX_CAP.toLocaleString('en-US')}.`
      return
    }
    const next = await convertToMesh(src, geo)
    const i = doc.objects.findIndex((o) => o.id === src.id)
    if (i >= 0) doc.objects[i] = next
  } catch (err) {
    console.warn('[scene3d-studio] convert to mesh failed', err)
    convertError.value = 'Could not convert this object — try again.'
  } finally {
    // In the finally, not after the await: the cap bail and any encode failure
    // both used to skip it and leak the BufferGeometry, and the cap bail is a
    // normal-use path for this button, not an edge case.
    geo.dispose()
    converting.value = false
  }
}
// A refusal is about the object that was selected when it happened; leaving it
// under the button after the user moves on would read as a fresh failure.
watch(selectedId, () => { convertError.value = '' })

// ── Remesh / Solidify (mesh primitives only) ──────────────────────────────────
// The Geometry panel's schema-driven sliders (geoSpecs) are empty for `mesh` —
// PRIMITIVE_PARAMS.mesh is `[]` — so this is what fills that space.
const selectedMesh = computed<PrimitiveObject | null>(() => {
  const o = selected.value
  return o && o.kind === 'primitive' && o.primitive === 'mesh' ? o : null
})
// Decoded via the SAME cache the engine reads (meshCache), not a private
// decode — `meshGen` (already bumped by the watch above once a fresh decode
// lands) is what re-measures this after a remesh/solidify writes new content.
const selectedMeshData = computed<MeshData | null>(() => {
  void meshGen.value
  const o = selectedMesh.value
  return o ? meshCacheGet(o.content?.meshKey) : null
})
const meshVertexCount = computed<number>(() => (selectedMeshData.value?.positions.length ?? 0) / 3)
const meshEncodedKB = computed<string>(() => {
  const encoded = selectedMesh.value?.content?.mesh
  return encoded ? (encoded.length / 1024).toFixed(1) : '0.0'
})

const remeshResolution = ref(64)
const remeshBusy = ref(false)
const solidifyThickness = ref(0.05)
// Set once per selected mesh object (keyed on id, not on content) — a
// successful Remesh replaces `selectedMesh` with a new object reference, and
// re-deriving the default from THAT would silently reset the slider the user
// just chose right after they used it.
const remeshDefaultedFor = ref<string | null>(null)
// True once a Remesh on the current selection has refused an open surface —
// swaps the Remesh button for the open notice + Solidify path until the next
// selection change or a successful Solidify.
const remeshOpen = ref(false)
watch(() => selectedMesh.value?.id ?? null, () => { remeshOpen.value = false })
watch(selectedMeshData, (data) => {
  const id = selectedMesh.value?.id ?? null
  if (!data || !id || remeshDefaultedFor.value === id) return
  remeshResolution.value = resolutionForTarget(data, MESH_DEFAULT_TARGET)
  remeshDefaultedFor.value = id
}, { immediate: true })
// Both actions below run genuinely heavy, fully synchronous work once their
// single `await` resolves (buildTriGrid + buildSdf + surfaceNets, potentially
// several times over for remesh's over-cap retry ladder) — tens of ms to over
// ten seconds at the slider's high end. `decodeMesh`'s own await only defers
// to the microtask queue, which drains before the browser gets a chance to
// paint, so setting `remeshBusy` alone is not enough: without this, the
// button visually does nothing until the whole computation is already done.
// `nextTick` flushes Vue's queued DOM patch (the busy label/spinner) and the
// rAF round-trip after it guarantees the browser has actually painted that
// patch before the blocking call starts — a disabled button that never
// repaints reads as a hang, not as "working".
async function paintPendingState(): Promise<void> {
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}
async function remeshSelection() {
  const obj = selectedMesh.value
  if (!obj || remeshBusy.value) return
  const startId = obj.id
  remeshBusy.value = true
  convertError.value = ''
  await paintPendingState()
  try {
    const out = await remeshObject(obj, remeshResolution.value)
    // The selection may have moved on during the remesh — a stale result must
    // not overwrite whatever the user is looking at now (same hazard, same
    // fix, as the `meshGen` watch above).
    if (selectedMesh.value?.id !== startId) return
    remeshOpen.value = out.open
    if (!out.open) {
      const i = doc.objects.findIndex((o) => o.id === obj.id)
      if (i >= 0) doc.objects[i] = out.obj
    }
  } catch (err) {
    if (selectedMesh.value?.id === startId) {
      console.warn('[scene3d-studio] remesh failed', err)
      convertError.value = 'Could not remesh this object — try again.'
    }
  } finally {
    remeshBusy.value = false
  }
}
async function solidifySelection() {
  const obj = selectedMesh.value
  if (!obj || remeshBusy.value) return
  const startId = obj.id
  remeshBusy.value = true
  convertError.value = ''
  await paintPendingState()
  try {
    const next = await solidifyObject(obj, solidifyThickness.value)
    // Same stale-selection guard as remeshSelection above.
    if (selectedMesh.value?.id !== startId) return
    const i = doc.objects.findIndex((o) => o.id === obj.id)
    if (i >= 0) doc.objects[i] = next
    remeshOpen.value = false // give Remesh another try on the closed shell
  } catch (err) {
    if (selectedMesh.value?.id === startId) {
      console.warn('[scene3d-studio] solidify failed', err)
      convertError.value = 'Could not solidify this object — try again.'
    }
  } finally {
    remeshBusy.value = false
  }
}

// ── Merge (Task 16) ────────────────────────────────────────────────────────────
// Booleans through the shared voxel field — see merge.ts's own header for why
// that beats exact mesh CSG here: the result is already a clean uniform mesh,
// ready for Sculpt with no remesh step, at the cost of sharp edges softening to
// grid resolution.
const mergeOp = ref<MergeOp>('union')
const mergeOpProxy = enumProxy<MergeOp>(() => mergeOp.value, (v) => { mergeOp.value = v })
const mergeBlend = ref(0)
const mergeResolution = ref(48)
const mergeBusy = ref(false)

/** This object's OWN geometry, in its OWN local space — the same source
 *  `convertSelectionToMesh` freezes for a fresh primitive, and the same
 *  encoded buffer `selectedMeshData` decodes for an existing `mesh` one.
 *  Null only for a `text` object whose font hasn't resolved yet (same
 *  refusal `convertSelectionToMesh` makes, so a merge can't freeze the
 *  placeholder cube in permanently). */
async function localMeshDataFor(obj: PrimitiveObject): Promise<MeshData | null> {
  if (obj.primitive === 'mesh') {
    const encoded = obj.content?.mesh
    return encoded ? decodeMesh(encoded) : null
  }
  if (obj.primitive === 'text' && !fontCacheGet(obj.content?.font ?? DEFAULT_FONT_URL)) return null
  const font = obj.primitive === 'text' ? fontCacheGet(obj.content?.font ?? DEFAULT_FONT_URL) : null
  // Same two notes as convertSelectionToMesh above: vary is passed so the geometry
  // that goes into the boolean is the one on screen, and per-copy colour does not
  // survive `meshDataFromGeometry` (positions and indices only) — a merge result is a
  // plain mesh in the material's own colour, stamp and all dropped together.
  //
  // colorEnabled: false, same precedent as baseSizeFor in engine.ts — colour is
  // discarded two lines below by meshDataFromGeometry regardless, so building it here
  // would only pay for a Float32Array of per-vertex colour plus a THREE.Color per
  // copy that nothing ever reads. Positions are untouched by colour, so no behaviour
  // changes.
  const geo = buildGeometry(obj.primitive, obj.params, obj.modifiers, 'smooth', obj.content, font, { ...varySettingsFor(obj), colorEnabled: false }, modifierStackOf(obj))
  const data = meshDataFromGeometry(geo)
  geo.dispose()
  return data
}

/** `data`'s vertices carried into WORLD space by `m` — objects at different
 *  positions/rotations/scales must combine where they visually sit, not where
 *  their local origins are. Indices are untouched; only positions move. */
function bakedIntoWorld(data: MeshData, m: THREE.Matrix4): MeshData {
  const positions = new Float32Array(data.positions.length)
  const v = new THREE.Vector3()
  for (let i = 0; i < data.positions.length; i += 3) {
    v.set(data.positions[i]!, data.positions[i + 1]!, data.positions[i + 2]!).applyMatrix4(m)
    positions[i] = v.x
    positions[i + 1] = v.y
    positions[i + 2] = v.z
  }
  return { positions, indices: data.indices }
}

/** Decompose a world matrix into the position/rotation/scale triple
 *  `rebaseMany` wants for its `t` field — same XYZ Euler order as
 *  `hierarchy.ts`'s own (private) `rebase`, which is what this stands in for
 *  here: reparenting the children of a merged-away object needs their CURRENT
 *  world transform captured before the parent disappears, and this is the only
 *  piece `rebaseMany` doesn't already do for the caller. */
function worldTransformOf(m: THREE.Matrix4): { position: Vec3; rotation: Vec3; scale: Vec3 } {
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  m.decompose(p, q, s)
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ')
  return { position: [p.x, p.y, p.z], rotation: [e.x, e.y, e.z], scale: [s.x, s.y, s.z] }
}

async function mergeSelection() {
  const objs = selectedObjects.value.filter((o): o is PrimitiveObject => o.kind === 'primitive')
  if (objs.length < 2 || mergeBusy.value) return
  mergeBusy.value = true
  convertError.value = ''
  await paintPendingState()
  try {
    const inputs: MeshData[] = []
    for (const obj of objs) {
      const local = await localMeshDataFor(obj)
      if (!local) {
        convertError.value = obj.primitive === 'text'
          ? 'Still loading a font — try again in a moment.'
          : `Could not read the geometry of "${obj.name}" — try again.`
        return
      }
      inputs.push(bakedIntoWorld(local, worldMatrixOf(doc.objects, obj.id)))
    }
    // Refuse up front and NAME the offender — mergeMeshes itself only reports
    // open as a bare boolean (see its own comment on why: the caller here is
    // the one place that can say WHICH input, since it still has the names).
    for (let i = 0; i < inputs.length; i++) {
      if (remesh(inputs[i]!, mergeResolution.value).open) {
        convertError.value = `"${objs[i]!.name}" is an open surface, so it has no inside to merge. Solidify it first.`
        return
      }
    }
    const out = mergeMeshes(inputs, mergeOp.value, mergeBlend.value, mergeResolution.value)
    if (out.open) {
      convertError.value = 'Could not merge these shapes — one of them is open.'
      return
    }
    if (out.failed) {
      // The retry ladder reached the resolution floor and the combined field
      // is STILL over the vertex cap — a real merge, just too dense to keep.
      // merge.ts refuses to hand back a coarse single-input substitute dressed
      // up as success (Finding 4, Task 16 review), so this is a genuine
      // refusal: say so and stop, same as every other refusal on this button.
      convertError.value = 'Too complex to merge — lower the resolution and try again.'
      return
    }
    // Recentre on the merged bbox, exactly like groupObjects centres a new
    // group on its members' bounds — the new object's local origin should sit
    // inside the shape it now owns, not wherever the first input's did.
    const { lo, hi } = boundsOf(out.data)
    const centreWorld = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)
    const src = out.data.positions
    const positions = new Float32Array(src.length)
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = src[i]! - centreWorld.x
      positions[i + 1] = src[i + 1]! - centreWorld.y
      positions[i + 2] = src[i + 2]! - centreWorld.z
    }
    const geo = geometryFromMeshData({ positions, indices: out.data.indices })
    const placeholder = createPrimitive('mesh', doc.objects)
    try {
      // Finding 1 (Task 16 review): parent the result wherever the PRIMARY
      // selection lives — same precedent as groupSelection — so merging inside
      // a group nests the result instead of ejecting it to the root.
      const primary = objs[objs.length - 1]!
      const parentId = primary.parentId
      const parentWorld = parentId ? worldMatrixOf(doc.objects, parentId) : new THREE.Matrix4()
      const localCentre = centreWorld.clone().applyMatrix4(new THREE.Matrix4().copy(parentWorld).invert())
      const merged = await convertToMesh(
        {
          ...placeholder,
          position: [localCentre.x, localCentre.y, localCentre.z],
          material: cloneMaterial(objs[0]!.material),
          ...(parentId ? { parentId } : {}),
        },
        geo,
      )
      const removed = new Set(objs.map((o) => o.id))
      // Finding 2 (Task 16 review): a child whose parent is one of the
      // merged-away objects is reparented onto the merge result rather than
      // cascade-deleted — the merge is a shape operation on the SELECTED
      // objects only, and the user nested this child on purpose. Its world
      // transform is captured now, before the old parent disappears, so
      // `rebaseMany` below can put it back exactly where it visually sat.
      const orphaned = doc.objects.filter((o) => o.parentId && removed.has(o.parentId) && !removed.has(o.id))
      const orphanEntries = orphaned.map((o) => ({ id: o.id, t: worldTransformOf(worldMatrixOf(doc.objects, o.id)) }))
      const reparented = orphaned.map((o) => ({ ...o, parentId: merged.id }))
      const reparentedIds = new Set(reparented.map((o) => o.id))
      const survivors = doc.objects.filter((o) => !removed.has(o.id) && !reparentedIds.has(o.id))
      const nextTopology = [...survivors, merged, ...reparented]
      const rebasedById = new Map(rebaseMany(nextTopology, orphanEntries).map((e) => [e.id, e.t]))
      doc.objects = nextTopology.map((o) => {
        const t = rebasedById.get(o.id)
        return t ? { ...o, ...t } : o
      })
      selectedIds.value = [merged.id]
    } finally {
      geo.dispose()
    }
  } catch (err) {
    console.warn('[scene3d-studio] merge failed', err)
    convertError.value = 'Could not merge these shapes — try again.'
  } finally {
    mergeBusy.value = false
  }
}

// ── Sculpt mode (Task 13) ─────────────────────────────────────────────────────
// The session (Tasks 10–12) holds the working vertex buffer; NOTHING here ever
// writes `doc.objects` mid-session — see `commitAndExitSculpt`, the only place
// that does, and only once. Gizmo lock is session-long, via
// `interaction.setSculptMode`; orbit lock is narrower — only while a stroke is
// live or the cursor hovers the mesh, via `interaction.setSculpting` — and
// NEITHER ever writes `orbit.enabled` directly (see interaction.ts).
const sculpting = ref(false)
// Guards commitAndExitSculpt's await window (encodeMesh inside session.commit(),
// then loadMesh's cache warm-up) — same convention as `converting` above for the
// To-mesh button. Without it a fast double-click on Apply/Exit re-enters the
// function before the first call's commit resolves and encodes the same working
// buffer twice; idempotent, so nothing corrupts, but it's wasted work
// (finding 3, Task 13 review).
const committing = ref(false)
const sculptBrush = ref<BrushKind>('draw')
const sculptSize = ref(0.15)
const sculptStrength = ref(0.5)
const sculptSymmetry = ref<SymmetryMode>('none')
// Radial-only (see symmetry.ts's SymmetrySpec) — Task 15 defaults: count 6
// about Y.
const sculptSymmetryAxis = ref<0 | 1 | 2>(1)
const sculptSymmetryCount = ref(6)
// In-panel Remesh (Gap 4): separate state from remeshResolution/meshVertexCount/
// meshEncodedKB above — those read `doc.objects`' COMMITTED content, which is
// stale while a sculpt session is live; these read the session's own LIVE
// working buffer instead (see `remeshSculptSession`).
const sculptRemeshResolution = ref(64)
const sculptRemeshBusy = ref(false)
// Bumped whenever `sculptSession` is reassigned (enterSculpt, or an in-panel
// remesh rebuilding it) so `sculptVertexCount` re-derives — `sculptSession` is
// a plain (non-reactive) module-level variable, same convention `meshGen`
// already uses for the doc-backed mesh watchers above.
const sculptSessionVersion = ref(0)
const sculptVertexCount = computed<number>(() => {
  void sculptSessionVersion.value
  return sculptSession ? sculptSession.positions.length / 3 : 0
})
// Snapshotted at sculpt entry (from the doc's own encoded size — nothing has
// diverged yet) and refreshed after each in-panel remesh. Not kept live per
// stroke: encoding is a real deflate pass, and a stroke must stay cheap.
const sculptMeshKB = ref('0.0')
let sculptSession: SculptSession | null = null
let sculptObjId: string | null = null
let sculptStrokeDown = false
// True from the last pointermove's pick — the HOVER half of the orbit lock
// (see `setSculptOrbitLock`). Tracked separately from the pick itself because
// `onSculptPointerUp` has no pointer position of its own to re-pick with.
let sculptHovering = false
// Mirrors `interaction`'s own orbit-lock field — compared against on every
// candidate change so `interaction.setSculpting` is called ONLY when the
// held/not-held boolean actually flips, never once per pointermove. A
// per-move reassertion of an unchanged lock is exactly the per-frame-writer
// pattern interaction.ts's header comment records as having shipped a real
// bug already.
let sculptOrbitLocked = false
// Scratch instances reused across pointermoves — a drag is the one place in
// this file where per-frame allocation would actually be paid for (same
// rationale as interaction.ts's module-scope `_p`/`_q`/`_s`/`_e`).
const _sculptRay = new THREE.Raycaster()
const _sculptInv = new THREE.Matrix4()
const _sculptOrigin = new THREE.Vector3()
const _sculptDir = new THREE.Vector3()
// The previous move's surface intersection (mesh object space, same space as
// BrushStamp.centre), used only to derive `grab`'s drag vector. Reset to null
// whenever a stroke starts or the active brush isn't `grab`, so grab's first
// dab in a stroke carries no drag (nothing to diff against yet) rather than
// jumping from an arbitrary prior point.
let _sculptLastGrabPoint: [number, number, number] | null = null

// Brush cursor ring (Task 13, gap 2): a flat circle on the tangent plane at
// the hovered pick point, oriented to the surface normal there, radius
// tracking Size. A thin action-blue ring over a soft dark halo so it reads
// against both light and dark geometry — action blue is this project's only
// accent (CLAUDE.md's colour convention; purple is banned).
//
// Parented directly to the sculpted mesh's THREE.Object3D, which IS
// `content.mesh`'s vertex-position space (SculptSession.pick's contract, the
// same space applyBrush works in) — so the ring's local position/scale ARE
// brush-radius units with no unit conversion, correct even under a
// non-uniform object scale. `mesh.geometry` is swapped in place on
// commit/undo (SceneEngine.syncObject) — the Mesh node itself is stable — but
// `updateSculptRing`'s reparent guard is a cheap defensive no-op if that ever
// changes, and lets the ring follow if sculpting is re-entered on a different
// mesh without leaking the old one.
//
// Tagged `isGizmoHelper` — the SAME mechanism the TransformControls gizmo and
// the multi-select pivot use (interaction.ts; passes.ts's
// `collectEditorHelpers`) to stay out of every baked/exported pass.
let sculptRing: THREE.Group | null = null
const _sculptRingNormal = new THREE.Vector3()
const SCULPT_RING_UP = new THREE.Vector3(0, 0, 1) // RingGeometry's own default facing

function ensureSculptRing(): THREE.Group {
  if (sculptRing) return sculptRing
  const group = new THREE.Group()
  group.name = 'sculptCursorRing'
  group.userData.isGizmoHelper = true
  group.visible = false
  group.renderOrder = 999
  const segments = 48
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.92, 1.02, segments),
    new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.3, side: THREE.DoubleSide,
      depthWrite: false, toneMapped: false,
    }),
  )
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.96, 1.0, segments),
    new THREE.MeshBasicMaterial({
      color: 0x3b82f6, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
      depthWrite: false, toneMapped: false,
    }),
  )
  group.add(halo, ring)
  sculptRing = group
  return group
}

function hideSculptRing() {
  if (sculptRing) sculptRing.visible = false
}

function updateSculptRing(mesh: THREE.Object3D, hit: { point: [number, number, number]; normal: [number, number, number] }) {
  const group = ensureSculptRing()
  if (group.parent !== mesh) mesh.add(group)
  group.position.set(hit.point[0], hit.point[1], hit.point[2])
  _sculptRingNormal.set(hit.normal[0], hit.normal[1], hit.normal[2])
  if (_sculptRingNormal.lengthSq() > 1e-8) {
    group.quaternion.setFromUnitVectors(SCULPT_RING_UP, _sculptRingNormal.normalize())
  }
  group.scale.setScalar(Math.max(sculptSize.value, 0.001))
  group.visible = true
}
// Keep the ring's radius live against the Size slider even without a fresh
// pointermove — dragging the slider while the pointer sits still over the
// mesh must not require a nudge before the new radius is visible.
watch(sculptSize, (v) => { if (sculptRing?.visible) sculptRing.scale.setScalar(Math.max(v, 0.001)) })

/** Single authority for the ORBIT-lock half of sculpting (interaction.ts's
 *  `setSculpting`, distinct from the mode-long `setSculptMode`): held while a
 *  stroke is live OR the cursor hovers the sculpted mesh, free over empty
 *  space. Compares against the last value it actually sent so an unchanged
 *  lock state never re-triggers `interaction.setSculpting` — see the
 *  `sculptOrbitLocked` field doc. */
function setSculptOrbitLock(locked: boolean) {
  if (sculptOrbitLocked === locked) return
  sculptOrbitLocked = locked
  interaction?.setSculpting(locked)
}

async function enterSculpt() {
  if (sculpting.value) return
  const obj = selectedObjects.value[0] as PrimitiveObject | undefined
  if (!obj || obj.kind !== 'primitive' || obj.primitive !== 'mesh') return
  const encoded = obj.content?.mesh
  const key = obj.content?.meshKey
  if (!encoded || !key) return
  convertError.value = ''
  try {
    const data = meshCacheGet(key) ?? await loadMesh(encoded, key)
    // The object may have moved on while the decode was in flight.
    if (selectedObjects.value.length !== 1 || selectedObjects.value[0]!.id !== obj.id) return
    sculptSession = new SculptSession(data)
    sculptObjId = obj.id
    // Same default-once-per-selection convention as the inspector's own
    // remeshResolution watch (line ~1688) — a target near the mesh's current
    // density, not a fixed constant that's wildly wrong for a dense import.
    sculptRemeshResolution.value = resolutionForTarget(data, MESH_DEFAULT_TARGET)
    sculptMeshKB.value = meshEncodedKB.value // nothing has diverged from the doc yet
    sculptSessionVersion.value++
    engine?.setSculptOverride(obj.id, sculptSession.positions, sculptSession.indices)
    // Gizmo hidden for the whole session — orbit is NOT locked here (Gap 1):
    // it only locks once a pointermove finds the cursor over the mesh, or a
    // stroke begins. See interaction.ts's `setSculptMode` vs `setSculpting`.
    interaction?.setSculptMode(true)
    // Fix 1 (dock exclusivity): sculpt owns the bottom-center dock, and the
    // Motion timeline claims that same spot for activeTab === 'motion' — force
    // Build here (and the tab buttons below lock while sculpting.value is
    // true) so the two docked panels can never both satisfy their v-if at once.
    activeTab.value = 'build'
    sculpting.value = true
    sculptHovering = false
  } catch (err) {
    console.warn('[scene3d-studio] enter sculpt failed', err)
    convertError.value = 'Could not enter sculpt mode — try again.'
  }
}

// Unified Sculpt verb: a mesh sculpts directly; a non-mesh primitive is frozen
// to a mesh first (irreversible), gated behind a one-time confirm the user can
// suppress for the session. `canEnterSculpt` merges the two existing gates.
const sculptConfirmSuppressed = ref(false)
const canEnterSculpt = computed(() => canSculpt.value || canConvertToMesh.value)
const sculptConfirmNeeded = computed(() =>
  canEnterSculpt.value && sculptDecision(canSculpt.value, sculptConfirmSuppressed.value) === 'confirm')
const selectedKindLabel = computed(() => {
  const o = selected.value
  return o && o.kind === 'primitive' ? (o as PrimitiveObject).primitive : 'shape'
})

async function sculptSelection() {
  const o = selected.value
  if (!o || o.kind !== 'primitive') return
  if ((o as PrimitiveObject).primitive !== 'mesh') {
    await convertSelectionToMesh()
    if (convertError.value) return
  }
  // convertSelectionToMesh replaces the object in place and reselects it; if
  // the selection somehow isn't a mesh now, bail rather than enter a bad state.
  if (!selectedMesh.value) return
  await enterSculpt()
}

/** Ray-pick under the pointer, in the sculpted mesh's own object space —
 *  SculptSession.pick's contract. The ONE raycast path shared by hover/ring
 *  tracking and by brush application, so there is never a second picker to
 *  keep in sync with the session's spatial hash. */
function pickSculptHit(
  e: PointerEvent,
): { mesh: THREE.Mesh; hit: { point: [number, number, number]; normal: [number, number, number] } } | null {
  if (!engine || !sculptSession || !sculptObjId || !viewportEl.value) return null
  const mesh = engine.objectRoots.get(sculptObjId) as THREE.Mesh | undefined
  if (!mesh) return null
  const rect = viewportEl.value.getBoundingClientRect()
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  )
  _sculptRay.setFromCamera(ndc, engine.camera)
  // The ray is in WORLD space; SculptSession.pick expects the mesh's OWN
  // object space (its positions/indices are never transformed by the root's
  // TRS), so both origin and direction are carried through the inverse world
  // matrix — transformDirection (not applyMatrix4) for the direction, since a
  // direction must not pick up translation.
  _sculptInv.copy(mesh.matrixWorld).invert()
  _sculptOrigin.copy(_sculptRay.ray.origin).applyMatrix4(_sculptInv)
  _sculptDir.copy(_sculptRay.ray.direction).transformDirection(_sculptInv).normalize()
  const hit = sculptSession.pick(
    [_sculptOrigin.x, _sculptOrigin.y, _sculptOrigin.z],
    [_sculptDir.x, _sculptDir.y, _sculptDir.z],
  )
  if (!hit) return null
  return { mesh, hit }
}

/** Expand for symmetry and apply the current brush at an already-picked hit.
 *  Called from pointerdown too (so a stationary dab paints without requiring
 *  movement) — `pickSculptHit` runs once per event and both the gate check
 *  and the paint share its result. */
function applyBrushAtHit(
  mesh: THREE.Mesh,
  hit: { point: [number, number, number]; normal: [number, number, number] },
  e: PointerEvent,
) {
  if (!sculptSession) return
  // `grab` carries the surface with the pointer rather than pushing along a
  // normal, so it alone needs the delta between this move's intersection and
  // the last one. Every other brush leaves `drag` undefined — `applyBrush`
  // ignores it for them regardless, but not tracking `_sculptLastGrabPoint`
  // while a different brush is active means switching brushes mid-stroke
  // (Alt-key aside, brush choice doesn't change mid-stroke today, but this
  // keeps the invariant honest) never leaves a stale point to diff against.
  let drag: [number, number, number] | undefined
  if (sculptBrush.value === 'grab') {
    if (_sculptLastGrabPoint) {
      drag = [
        hit.point[0] - _sculptLastGrabPoint[0],
        hit.point[1] - _sculptLastGrabPoint[1],
        hit.point[2] - _sculptLastGrabPoint[2],
      ]
    }
    _sculptLastGrabPoint = hit.point
  } else {
    _sculptLastGrabPoint = null
  }
  const stamp: BrushStamp = {
    centre: hit.point,
    normal: hit.normal,
    radius: sculptSize.value,
    strength: sculptStrength.value,
    invert: e.altKey,
    ...(drag ? { drag } : {}),
  }
  const spec: SymmetrySpec = { mode: sculptSymmetry.value, axis: sculptSymmetryAxis.value, count: sculptSymmetryCount.value }
  // Stamps are treated as immutable here — expandStamp can return the SAME
  // object back by reference (mode 'none', and mirror's first entry), so
  // mutating one in place would corrupt the next brush's read of it.
  for (const s of expandStamp(stamp, spec)) applyBrush(sculptSession, sculptBrush.value, s)
  // Between strokes: mutate the live mesh's position attribute IN PLACE. Its
  // backing array IS sculptSession.positions (set by reference in
  // engine.setSculptOverride), so applyBrush's writes above already landed in
  // it — marking needsUpdate is the entire cost of this, no rebuild, no copy.
  const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  if (posAttr) posAttr.needsUpdate = true
}

function onSculptPointerDown(e: PointerEvent) {
  if (!sculpting.value || e.button !== 0 || !sculptSession) return
  const picked = pickSculptHit(e)
  // Gap 1's second rule: a pointerdown that MISSES the mesh must not begin a
  // stroke — it belongs to the camera (orbit's own pointerdown handler is
  // free to run since orbit isn't locked over empty space).
  if (!picked) return
  // Same as OrbitControls' own pointerdown handler: without this, a mouse
  // (non-touch) drag across the canvas falls through to the browser's native
  // drag-select, which highlights the whole page's text instead of painting.
  e.preventDefault()
  sculptStrokeDown = true
  // Redundant with the hover lock the preceding pointermove already set in
  // the overwhelming majority of cases (mousemove precedes pointerdown at the
  // same screen position), but asserted explicitly here too so a stroke can
  // never begin orbit-unlocked regardless of event ordering.
  setSculptOrbitLock(true)
  sculptSession.beginStroke()
  // A new stroke's first dab must never diff against a point left over from
  // the PREVIOUS stroke — that would read as a teleporting jump the instant
  // grab touches down.
  _sculptLastGrabPoint = null
  applyBrushAtHit(picked.mesh, picked.hit, e)
  updateSculptRing(picked.mesh, picked.hit)
}
function onSculptPointerMove(e: PointerEvent) {
  if (!sculpting.value || !sculptSession) { sculptHovering = false; return }
  const picked = pickSculptHit(e)
  sculptHovering = !!picked
  // Gap 1's first rule: the orbit lock is held while EITHER a stroke is live
  // OR the cursor is over the mesh, never for the whole sculpt-mode session —
  // routed through `setSculptOrbitLock` so it's only asserted on change.
  setSculptOrbitLock(sculptStrokeDown || sculptHovering)
  if (picked) updateSculptRing(picked.mesh, picked.hit)
  else hideSculptRing()
  if (!sculptStrokeDown) return
  // Gap 1's third rule: dragging OFF the mesh mid-stroke keeps the lock held
  // (via `sculptStrokeDown` alone, above) so orbit never sneaks in — but
  // there's no valid pick to paint with here, so skip this dab rather than
  // fabricate one.
  if (!picked) return
  applyBrushAtHit(picked.mesh, picked.hit, e)
}
function onSculptPointerUp() {
  if (!sculptStrokeDown) return
  sculptStrokeDown = false
  // The stroke's own share of the lock is released; the hover share (set by
  // the last pointermove) still applies if the cursor is still over the mesh.
  setSculptOrbitLock(sculptHovering)
  if (!sculptSession || !sculptObjId) return
  // endStroke() already recomputes normals and rebuilds the pick structure —
  // exactly once, here, not per pointermove (a stroke must never rebuild).
  sculptSession.endStroke()
  engine?.setSculptOverride(sculptObjId, sculptSession.positions, sculptSession.indices)
}

/** Cmd+Z / Ctrl+Z while sculpting — called from onKey BEFORE the doc-level
 *  undo branch, and returns unconditionally so it never falls through to it
 *  (rule #3 of this task's brief: one keystroke must not both undo a stroke
 *  and revert an unrelated document change). Redo has no meaning here
 *  (SculptSession keeps no redo stack), so Shift+Cmd+Z is swallowed too rather
 *  than falling through to the doc's redo. */
function sculptUndo() {
  if (!sculptSession || !sculptObjId) return
  sculptSession.undo()
  engine?.setSculptOverride(sculptObjId, sculptSession.positions, sculptSession.indices)
}

/** In-panel Remesh (Gap 4): rebuilds the CURRENT sculpted buffer, not the
 *  stale mesh sitting in `doc.objects` — `session.toMeshData()` is the live
 *  truth while sculpting (same rule `commitSculptSession` below follows for
 *  the same reason).
 *
 *  Three correctness hazards this must get right:
 *  1. Remesh the SESSION's buffer (toMeshData()), never obj.content.mesh.
 *  2. The undo ring MUST NOT survive: its entries are {vertexIndex,
 *     oldPosition} pairs against the OLD topology, and would scatter the mesh
 *     into garbage if replayed against the new one. A brand new SculptSession
 *     is constructed below rather than mutated in place — its undo ring starts
 *     empty by construction, so the old one is simply discarded with the old
 *     instance, never "cleared" in place because there is nothing left to
 *     clear it FROM.
 *  3. The session is rebuilt wholesale — new positions/indices/adjacency/
 *     spatial hash/pick grid all fall out of `new SculptSession(...)` — and
 *     the engine's sculpt override is re-pointed at the NEW buffers, or the
 *     viewport keeps drawing the old topology.
 *
 *  `markDirty()` is required (not incidental): a fresh SculptSession starts
 *  clean (editVersion === committedVersion, both 0), but this buffer already
 *  differs from `doc.objects` — it's a new topology, not an edited old one —
 *  so `dirty` must read true immediately or a bare Exit right after Remesh
 *  would silently discard it.
 *
 *  Same synchronous-cost shape as the inspector's own Remesh (buildTriGrid +
 *  buildSdf + surfaceNets, ~2s at typical resolutions) — same `paintPendingState`
 *  precedent so the busy label actually paints before the block starts. */
async function remeshSculptSession() {
  if (!sculptSession || !sculptObjId || sculptRemeshBusy.value || committing.value) return
  // Captured for the staleness check below — see its comment for why this
  // must be the SESSION INSTANCE, not just the object id.
  const targetSession = sculptSession
  const targetId = sculptObjId
  sculptRemeshBusy.value = true
  convertError.value = ''
  await paintPendingState()
  try {
    const data = sculptSession.toMeshData()
    const out = await remeshMeshData(data, sculptRemeshResolution.value)
    // Finding 2 (Task 13 review): the modal's ✕ was not gated against
    // `sculptRemeshBusy` (fixed below, in `commitAndExitSculpt`), so before
    // that fix a close-then-reopen on the SAME object during this await
    // built a brand-new SculptSession sharing the OLD session's obj id — an
    // `sculptObjId !== targetId` check alone couldn't tell the two sessions
    // apart and let a stale remesh clobber the fresh one. Compare the
    // SESSION INSTANCE instead: `enterSculpt` and this function both always
    // mint a fresh `new SculptSession(...)`, so reference identity is a
    // token that's unique per session lifecycle even when the underlying
    // object id repeats. This also still catches the case the id check was
    // originally written for (a different object entirely).
    if (sculptSession !== targetSession) return
    if (out.open) {
      // Spec: the object was already closed to enter sculpt in the first
      // place, so this should be unreachable — but never assume. Refuse
      // rather than let a bad result corrupt the working buffer; `data` (the
      // pre-remesh session buffer) is untouched either way.
      convertError.value = 'This came back open from the remesh — exit sculpt and Solidify it first.'
      return
    }
    const next = new SculptSession(out.data)
    next.markDirty()
    sculptSession = next
    engine?.setSculptOverride(targetId, next.positions, next.indices)
    sculptSessionVersion.value++
    // For display only — never written to the doc; commit() re-encodes the
    // committed copy separately. A single extra deflate pass is negligible
    // next to the SDF/surface-nets work this function already pays for.
    try { sculptMeshKB.value = ((await encodeMesh(out.data)).length / 1024).toFixed(1) } catch { /* keep the prior reading */ }
  } catch (err) {
    console.warn('[scene3d-studio] in-sculpt remesh failed', err)
    convertError.value = 'Could not remesh — try again.'
  } finally {
    sculptRemeshBusy.value = false
  }
}

/** The ONLY place the session's working buffer turns into a `doc.objects`
 *  write. Used by Apply/Exit (via `commitAndExitSculpt`) AND by any
 *  doc-writing action taken while a sculpt session is still open — Save and
 *  Export to Canvas (`commitSculptIfNeeded` below). The session's buffer is
 *  the live truth while sculpting; `doc.objects` still holds the pre-sculpt
 *  mesh until this runs, so nothing may serialize `scene_state` without
 *  calling this first (or the write silently persists the PRE-sculpt mesh and
 *  discards the strokes — the exact bug the shell's close button was fixed
 *  for, see `onClose` below).
 *
 *  Deliberately does NOT touch the engine override, orbit lock, or the
 *  `sculpting`/`sculptSession` state — unlike `commitAndExitSculpt`, sculpting
 *  continues uninterrupted afterward (a mid-session Save must not kick the
 *  user out of the mode they were just in).
 *
 *  Returns false (and sets `convertError`) on failure, so a caller can refuse
 *  to persist a document that never got the sculpt's strokes. No-op success
 *  (`true`) when there is no live session, or the session isn't dirty.
 *
 *  Goes through `commitSculptToDoc` (session.ts) rather than calling
 *  `session.commit()` directly: that wrapper re-dirties the session on ANY
 *  failure downstream of encoding — including `write` below returning
 *  `false` when the object was removed from `doc.objects` mid-sculpt — so a
 *  failed commit never leaves the session looking clean while the document
 *  still holds the pre-sculpt mesh (Task 13 review, finding 1; the
 *  removed-object case was its accompanying Minor, same root cause). Without
 *  this, a transient failure here would permanently wedge the NEXT
 *  Save/Apply/Exit: `commitSculptSession`'s `!session.dirty` guard above
 *  would see "clean" and skip re-encoding, so Save would flash success while
 *  silently persisting the stale doc forever. */
async function commitSculptSession(): Promise<boolean> {
  const session = sculptSession
  const id = sculptObjId
  if (!session || !id || !session.dirty) return true
  try {
    const ok = await commitSculptToDoc(session, async (mesh, meshKey) => {
      // Warm the shared mesh cache BEFORE the doc write triggers the normal
      // geoKey-gated resync, so that resync is a cache hit — no placeholder
      // cube flash while it decodes what we already have in hand.
      await loadMesh(mesh, meshKey)
      const i = doc.objects.findIndex((o) => o.id === id)
      if (i < 0) return false // object removed from the doc mid-sculpt — nowhere to write
      const obj = doc.objects[i] as PrimitiveObject
      doc.objects[i] = { ...obj, content: { ...obj.content, mesh, meshKey } }
      return true
    })
    if (!ok) {
      convertError.value = 'Could not save the sculpt — try again.'
      return false
    }
    meshGen.value++ // same convention as the remesh/solidify paths: re-measure Size/vertex count
    return true
  } catch (err) {
    console.warn('[scene3d-studio] sculpt commit failed', err)
    convertError.value = 'Could not save the sculpt — try again.'
    return false
  }
}

/** Guarded wrapper for callers that must not proceed with a stale (pre-sculpt)
 *  document if the commit fails or is already busy — Save and Export to
 *  Canvas. `committing` is the SAME reentrancy flag `commitAndExitSculpt` uses
 *  (and the panel's Apply/Exit buttons disable on): a Save that raced an
 *  in-flight Apply/Exit (or another Save) must not double-encode the same
 *  working buffer, so this simply defers to whichever commit is already
 *  running rather than starting a second one. Returns true immediately (no
 *  work needed) when sculpting isn't even active. */
async function commitSculptIfNeeded(): Promise<boolean> {
  if (!sculpting.value) return true
  if (committing.value || sculptRemeshBusy.value) return false
  committing.value = true
  convertError.value = ''
  try {
    return await commitSculptSession()
  } finally {
    committing.value = false
  }
}

/** Apply and Exit are the same action for Task 13 (see Scene3DSculptPanel's
 *  header comment): commit the session's working buffer to the doc via
 *  `commitSculptSession` above — the only OTHER thing this adds is leaving
 *  sculpt mode afterward. Skipped entirely when the session was never
 *  dirtied, so an accidental Sculpt-then-Exit doesn't pollute undo history or
 *  the "unexported changes" indicator.
 *
 *  The exit cleanup (engine override, orbit lock, sculpting flag/session) runs
 *  in `finally` so it happens on EVERY path, including a throw out of
 *  `commitSculptSession`. Without this a failed commit left the camera
 *  orbit-locked and the panel stuck open with no way out (finding 2, Task 13
 *  review); a failure is now surfaced through the existing `convertError` line
 *  instead of swallowed, and the session still exits so the user is never left
 *  locked without being told why. */
async function commitAndExitSculpt() {
  const session = sculptSession
  const id = sculptObjId
  if (!session || !id || committing.value) return
  if (sculptRemeshBusy.value) {
    // Finding 2 (Task 13 review): the panel's own Apply/Exit buttons already
    // fold `remeshBusy` into their `busy` computed (Scene3DSculptPanel.vue)
    // and disable themselves, so this function normally can't be reached
    // while a remesh is in flight through THAT path. But the modal shell's ✕
    // (StudioModalShell.vue) lives outside the panel and calls `onClose` →
    // this function directly, with no such gate. Committing here while the
    // remesh promise is still in flight would race it — whichever of "commit
    // the pre-remesh buffer" and the remesh's own stale-session guard lands
    // second wins, and either ordering can clobber real work (see
    // `remeshSculptSession`'s staleness-check comment for the exact
    // scenario this closes). Refuse deliberately instead: `onClose`'s
    // existing `if (convertError.value) return` already keeps the modal
    // open for this, same as a genuine commit failure.
    convertError.value = 'Remesh in progress — wait for it to finish, then close.'
    return
  }
  committing.value = true
  convertError.value = ''
  try {
    // Failure is already surfaced via `convertError` inside commitSculptSession
    // itself; nothing more to do with the return value here besides letting
    // `finally` run the exit cleanup regardless.
    await commitSculptSession()
  } finally {
    engine?.setSculptOverride(null, null, null)
    // setSculptMode(false) also force-clears the orbit lock itself (belt and
    // braces — see interaction.ts's doc), but reset the surface's own mirror
    // too so a re-entry starts from a known unlocked/unhovered state rather
    // than trusting the last stroke/hover this session happened to end on.
    interaction?.setSculptMode(false)
    sculptOrbitLocked = false
    sculptHovering = false
    sculptStrokeDown = false
    hideSculptRing()
    sculpting.value = false
    sculptSession = null
    sculptObjId = null
    committing.value = false
  }
}

// Scenes render every light as a real Three.js light — an unbounded count would
// tank frame time, so the UI caps additions rather than letting the doc silently
// grow into something the engine chokes on.
const MAX_LIGHTS = 8
function addLight(kind: LightKind) {
  const count = doc.objects.filter((o) => o.kind === 'light').length
  if (count >= MAX_LIGHTS) { console.warn(`[scene3d-studio] light cap reached (${MAX_LIGHTS})`); return }
  const o = createLight(kind, doc.objects)
  doc.objects.push(o)
  selectedId.value = o.id
  lightMenuOpen.value = false
  // First light in the scene: auto-enter Light View so its widget is visible
  // immediately instead of leaving the user to find the toggle.
  if (doc.objects.filter((obj) => obj.kind === 'light').length === 1) lightView.value = true
}
// ── Decals: click-to-place flow ──────────────────────────────────────────────
// A decal has no meaningful default pose (it lives on a surface, in that
// surface's local space), so adding one arms a one-shot placement on the
// viewport instead of pushing an object straight into the doc. `null` = not
// placing; `content` set = placing a NEW decal; `decalId` set = repositioning an
// existing one.
const placingDecal = ref<null | { content?: DecalContent; decalId?: string }>(null)
const decalFileInput = ref<HTMLInputElement | null>(null)
// Non-null while a "Replace image" pick is in flight — tells onDecalFilePicked to
// swap the content of THAT decal in place rather than starting a new placement.
// Holds the id, not the object, for the same capture-before-await reason
// onTexFilePicked captures `selected`.
const decalReplaceTarget = ref<string | null>(null)

// Only solids can carry a sticker: groups have no geometry, lights aren't
// pickable, and a decal-on-a-decal has no surface to project onto. (GLBs are out
// too — the engine bakes decal geometry from a primitive's own buffer geometry.)
function isDecalTarget(id: string): boolean {
  return doc.objects.find((o) => o.id === id)?.kind === 'primitive'
}
function beginDecalPlacement(spec: { content?: DecalContent; decalId?: string }) {
  // Without a live interaction (WebGL unavailable, or before onMounted) nothing
  // can ever consume the placement — arming `placingDecal` would strand the
  // surface in crosshair-and-hint mode with no click that could clear it.
  if (!interaction) return
  // Any armed replace is stale by now: a placement and a content-swap are
  // mutually exclusive modes, and this is the last point where both could be set.
  decalReplaceTarget.value = null
  placingDecal.value = spec
  decalMenuOpen.value = false
  interaction.beginPlacement(isDecalTarget, onDecalPlaced)
}
function cancelDecalPlacement() {
  interaction?.cancelPlacement()
  placingDecal.value = null
}
function onDecalPlaced(hit: PlacementHit) {
  const spec = placingDecal.value
  placingDecal.value = null
  if (!spec) return
  const pose = { position: hit.localPoint, rotation: eulerFromNormal(hit.localNormal) }
  if (spec.decalId) {
    const d = doc.objects.find((o) => o.id === spec.decalId)
    // Repositioning can land on a DIFFERENT target, so targetId/parentId move
    // together — the invariant createDecal establishes (the engine follows
    // targetId, the hierarchy follows parentId; they must never diverge).
    if (d?.kind === 'decal') {
      d.targetId = hit.targetId
      d.parentId = hit.targetId
      d.position = pose.position
      d.rotation = pose.rotation
    }
    return
  }
  const o = createDecal(hit.targetId, pose, spec.content!, doc.objects)
  doc.objects.push(o)
  selectedId.value = o.id
}
function addTextDecal() {
  beginDecalPlacement({ content: { type: 'text', text: DECAL_DEFAULTS.text, font: DECAL_DEFAULTS.font, color: DECAL_DEFAULTS.color } })
}
function triggerDecalReplace() {
  const d = selectedDecal.value
  if (!d || d.content.type !== 'image') return
  decalReplaceTarget.value = d.id
  decalFileInput.value?.click()
}
// Toolbar ▸ "Image sticker". Clears any replace flag first: dismissing the OS file
// dialog fires no event at all, so a cancelled "Replace image" leaves
// decalReplaceTarget set — without this reset the next ADD would silently swap
// that older decal's image instead of placing a new sticker.
function triggerDecalImageAdd() {
  decalReplaceTarget.value = null
  decalMenuOpen.value = false
  decalFileInput.value?.click()
}
async function onDecalFilePicked(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  // Read (and clear) the replace mode BEFORE the await — the same input element
  // serves both the toolbar's "Image sticker" and the section's "Replace image".
  const replaceId = decalReplaceTarget.value
  decalReplaceTarget.value = null
  if (!file) return
  const filename = await uploadInputImage(file)
  if (!filename) {
    // No inline error surface here (unlike the material texture, which has a
    // selected object to hang one on) — a failed upload simply arms nothing.
    console.warn('[scene3d-studio] decal image upload failed')
    return
  }
  if (replaceId) {
    const d = doc.objects.find((o) => o.id === replaceId)
    if (d?.kind === 'decal') d.content = { type: 'image', image: filename }
    return
  }
  beginDecalPlacement({ content: { type: 'image', image: filename } })
}

function addGlb(url: string) {
  if (!url) return
  const o = createGlbObject(url, doc.objects)
  doc.objects.push(o)
  selectedId.value = o.id
  // Eager warm-up so the object list can surface a load failure (the engine's own
  // load silently leaves an empty group; this catch flags it in the list).
  loadGlb(url).catch(() => { glbError[o.id] = true })
}
function removeObject(id: string) {
  // A group's children are independent doc objects; deleting only the group
  // would leave them orphaned at the root — visually "escaping" the delete.
  const doomed = new Set([id, ...descendantIds(doc.objects, id)])
  // Mirrors the Backspace guard below: refuse to delete the object currently
  // under the sculpt brush — directly, or as an ancestor group whose cascade
  // would take it with it — since nothing here tears the sculpt session down
  // (engine override, orbit lock, panel), and the object it points at would
  // be gone out from under it (finding 1, Task 13 review). A DIFFERENT object
  // (e.g. via the row's trash icon) is still deletable while sculpting.
  if (sculpting.value && sculptObjId && doomed.has(sculptObjId)) return
  doc.objects = doc.objects.filter((o) => !doomed.has(o.id))
  // Remove every doomed id from the selection without going through the replace-setter,
  // which would discard any other selected objects when multi-selection is active.
  selectedIds.value = selectedIds.value.filter((x) => !doomed.has(x))
  if (selectedTreatment.value && doomed.has(selectedTreatment.value.objectId)) selectedTreatment.value = null
  if (selectedModifier.value && doomed.has(selectedModifier.value.objectId)) selectedModifier.value = null
  for (const gone of doomed) delete glbError[gone]
}
// C3 fix (final review): `{ ...src.material }` is a SHALLOW copy — `material.relief` (and
// `material.relief.spec`/`material.shader`, same hazard) is a nested object, so the shallow
// copy left both objects' materials pointing at the SAME `relief` object. Duplicate a box with
// relief, drag the copy's Depth, and the ORIGINAL's Depth moved too — it looked like it fixed
// itself after save+reload only because serializeDoc writes two independent copies to JSON.
// duplicateObject's very next line already deep-clones params/modifiers with a comment about
// exactly this hazard; material just never got the same treatment.
// Fold an angle into [-π, π] so the Spin slider (-180°..180°) can still represent
// it. Uses the sign-safe double-modulo rather than a bare `%`: JS's `%` keeps the
// SIGN OF THE DIVIDEND, so `((v + π) % 2π) - π` returns values below -π for
// negative angles — exactly the range the slider would clamp away, silently
// changing the duplicate's rotation on the first drag.
const TAU = Math.PI * 2
function wrapAngle(v: number): number {
  return (((v + Math.PI) % TAU) + TAU) % TAU - Math.PI
}
function cloneMaterial(mat: SceneMaterial): SceneMaterial {
  const copy: SceneMaterial = { ...mat }
  if (mat.relief) {
    copy.relief = { ...mat.relief }
    if (mat.relief.spec) copy.relief.spec = JSON.parse(JSON.stringify(mat.relief.spec))
  }
  if (mat.shader) copy.shader = JSON.parse(JSON.stringify(mat.shader))
  return copy
}
// Shared body behind duplicateObject's single-object copy AND its subtree clones
// below (Task 9) — pulled out so both call sites share one deep-clone instead of
// growing two copies of the material/params/modifiers hazard the comment above
// documents. Position/rotation/scale/parentId travel VERBATIM (not offset) —
// duplicateObject applies its own +0.5 nudge only to the object the user
// actually clicked "duplicate" on; a descendant's local TRS is relative to its
// (also-cloned) parent, so leaving it untouched is what keeps the whole
// subtree's shape intact.
//
// `visible`/`content`/`motion` are carried too (review fix, post-Task-9):
// `Object.assign` here used to only reach position/rotation/scale/material/
// params/modifiers/materialOverride/light fields/parentId, silently dropping
// SceneObjectBase.visible and PrimitiveObject.content along with ObjectMotion
// entirely. Duplicating a hidden object made the copy visible (nobody asked
// for that), and duplicating an animated Text object — now routine since
// subtree duplication clones every descendant — produced N children that all
// read the default "Text" with no animation at all. `content` and `motion`
// are both nested objects (motion's `in`/`out`.ease.cps is itself an array
// inside a nested TransitionSpec), so both are JSON-round-tripped rather than
// spread one level — a shallow `{ ...src.motion }` would still alias `cps`
// between original and copy, exactly the `material.relief` aliasing class
// cloneMaterial's C3 fix already exists to prevent, just reintroduced here.
//
// Switches on `src.kind` (rather than an if/else-if chain) so the `default`
// branch can assign `src` to a `never` — the moment SceneObject grows a fifth
// member, that assignment stops compiling instead of silently falling through
// to whichever branch happened to be last. That silent-fallthrough failure
// mode is exactly what bit 'group': it used to be the ternary's unconditional
// `else`, so a GroupObject was constructed via `createLight(src.light, ...)` —
// a type error (`src.light` doesn't exist on GroupObject) that also described
// a real runtime bug, fabricating a light-shaped object instead of a group.
// `existing` defaults to the live doc for the single-object call site, but the
// subtree loop below passes an ACCUMULATING array instead — createPrimitive/
// createGlbObject/createLight/createGroup number the copy's name against
// `existing`, and cloning several children before any of them are pushed to
// `doc.objects` would otherwise have every clone numbered against the same
// stale snapshot, handing two of them the identical next-available name.
function cloneObject(src: SceneObject, existing: SceneObject[] = doc.objects): SceneObject {
  let copy: SceneObject
  switch (src.kind) {
    case 'primitive': copy = createPrimitive(src.primitive, existing); break
    case 'glb': copy = createGlbObject(src.url, existing); break
    case 'light': copy = createLight(src.light, existing); break
    case 'group': copy = createGroup(existing); break
    // Pose/content are re-supplied by the Object.assign + spread below; passing
    // them here only so createDecal can name the copy ("Sticker 2" vs "Text decal 2").
    case 'decal': copy = createDecal(src.targetId, { position: [...src.position] as Vec3, rotation: [...src.rotation] as Vec3 }, JSON.parse(JSON.stringify(src.content)), existing); break
    default: {
      const _exhaustive: never = src
      throw new Error(`cloneObject: unhandled kind ${(_exhaustive as SceneObject).kind}`)
    }
  }
  Object.assign(copy, {
    position: [...src.position], rotation: [...src.rotation], scale: [...src.scale], material: cloneMaterial(src.material),
    visible: src.visible,
    // Geometry params travel with the copy, cloned not aliased — a shared bag
    // would make both objects' shapes move together on any later edit.
    ...(src.kind === 'primitive' && src.params ? { params: { ...src.params } } : {}),
    ...(src.kind === 'primitive' && src.modifiers ? { modifiers: { ...src.modifiers } } : {}),
    // The modifier stack travels with the copy under FRESH ids — a shared id would let one
    // motion track drive both copies' geometry (the same hazard cloneTreatments guards, and
    // cloneModifierStack mints new ids for exactly this). Absent ⇒ omitted, so a legacy-bag
    // object (no stored stack) still duplicates byte-identically.
    ...(src.kind === 'primitive' && src.modifierStack?.length ? { modifierStack: cloneModifierStack(src.modifierStack) } : {}),
    // Vary palette travels with the copy the same defensive way as params/modifiers —
    // a shared array would let editing one copy's swatches mutate the other's.
    ...(src.kind === 'primitive' && src.varyPalette ? { varyPalette: [...src.varyPalette] } : {}),
    // Deep-copied: a shallow `{ ...src.content }` is safe today (both fields
    // are strings) but this is the same nested-bag shape as params/modifiers
    // above, so it's cloned the same defensive way rather than relying on
    // "happens to be flat right now."
    ...(src.kind === 'primitive' && src.content ? { content: { ...src.content } } : {}),
    // motion is a nested structure (loop/in/out, and in/out's ease can itself
    // carry a `cps` array) — JSON round-tripped rather than spread, matching
    // cloneMaterial's own treatment of relief.spec/shader for the identical
    // aliasing reason.
    ...(src.motion ? { motion: JSON.parse(JSON.stringify(src.motion)) } : {}),
    // Treatments travel with the copy under FRESH ids — a shared id would let one motion
    // track drive both copies (cloneTreatments's own doc).
    ...(src.treatments?.length ? { treatments: cloneTreatments(src.treatments) } : {}),
    ...(src.kind === 'glb' && src.materialOverride ? { materialOverride: true } : {}),
    // Light fields likewise travel with the copy — same discriminated-union
    // shape as material/params above, just flat on the object instead of nested.
    ...(src.kind === 'light' ? {
      color: src.color, intensity: src.intensity, distance: src.distance, decay: src.decay,
      angle: src.angle, penumbra: src.penumbra, width: src.width, height: src.height, castShadow: src.castShadow,
    } : {}),
    // Decal fields, same flat-on-the-object shape as the light fields above.
    // `content` is JSON round-tripped for the aliasing reason params/motion are.
    // The +15° spin offset is what makes the copy VISIBLE: a decal duplicated at
    // its source's exact pose is coplanar with it and z-fights instead of
    // appearing (duplicateObject's usual +0.5 position nudge is no help — a
    // decal's position is a point on the target's surface, and offsetting it
    // would slide the sticker somewhere arbitrary).
    ...(src.kind === 'decal' ? {
      targetId: src.targetId, content: JSON.parse(JSON.stringify(src.content)),
      size: src.size, depth: src.depth, spin: wrapAngle(src.spin + Math.PI / 12), opacity: src.opacity,
    } : {}),
    // Preserve containment: a duplicate should land beside its source, not
    // escape to the root — the same "escaping" failure mode Step 1's delete
    // cascade guards against, just for duplicate instead of delete. (Not in the
    // task's original pseudocode, but duplicateObject predates `parentId` and
    // this is exactly the kind of gap "make per-object operations
    // hierarchy-aware" calls out — see task report.)
    ...(src.parentId ? { parentId: src.parentId } : {}),
  })
  return copy
}
function duplicateObject(id: string) {
  const src = doc.objects.find((o) => o.id === id)
  if (!src) return
  // Clone the whole subtree (a group with no children copied is an empty box)
  // via hierarchy.ts's cloneSubtree, which owns the id-remapping and the
  // batch-numbering-scope accumulation — see its doc comment for the naming
  // collision that scope-accumulation exists to prevent. `cloneObject` is
  // passed straight through as the `make` factory.
  const clones = cloneSubtree(doc.objects, id, (s, existing) => cloneObject(s, existing))
  const copy = clones[0]!
  // A decal's `position` is a point ON the target's surface, not a free
  // transform — nudging it would slide the sticker off the face it was placed
  // on. Its copy is separated by the spin offset in cloneObject instead.
  if (copy.kind !== 'decal') copy.position = [src.position[0] + 0.5, src.position[1], src.position[2] + 0.5]
  // cloneSubtree remaps `parentId` through its id map but knows nothing about a
  // decal's `targetId` — without this, duplicating a PRIMITIVE would hand its
  // sticker copies a parentId pointing at the new solid and a targetId still
  // pointing at the old one, and the engine (which follows targetId) would
  // project them onto the original. createDecal's invariant is that the two are
  // equal, so re-deriving targetId from the already-remapped parentId restores it
  // for both cases: duplicating the decal itself (root parentId untouched → same
  // target, correct) and duplicating its target (remapped → new target).
  for (const clone of clones) if (clone.kind === 'decal' && clone.parentId) clone.targetId = clone.parentId
  doc.objects.push(...clones)
  selectedId.value = copy.id
  // Same eager warm-up as addGlb so a failing GLB source flags the duplicate too.
  if (copy.kind === 'glb') loadGlb(copy.url).catch(() => { glbError[copy.id] = true })
}

// Retry an errored GLB: clear the flag, then recreate the object with the same
// fields but a fresh id so the engine (which diffs syncFromDoc by id) treats it as
// a new source and actually reloads — reusing the id would be a no-op. loadGlb never
// caches failures, so the re-fetch genuinely retries.
function retryGlb(id: string) {
  const idx = doc.objects.findIndex((o) => o.id === id)
  const o = doc.objects[idx]
  if (!o || o.kind !== 'glb') return
  delete glbError[id]
  const fresh = createGlbObject(o.url, doc.objects.filter((x) => x.id !== id))
  Object.assign(fresh, {
    name: o.name, visible: o.visible,
    position: [...o.position], rotation: [...o.rotation], scale: [...o.scale],
    material: { ...o.material },
    ...(o.materialOverride ? { materialOverride: true } : {}),
    // Carry the parent across too, for the same reason `cloneObject` does: the
    // retried object's TRS is a LOCAL transform under that parent. Dropping
    // parentId here re-reads those same numbers as world coordinates, so a
    // failed GLB inside a group at [5,0,0] jumps to the origin and leaves the
    // group the instant the user clicks Retry.
    ...(o.parentId ? { parentId: o.parentId } : {}),
    // Treatments and motion travel too, for the same reason parentId does: Retry rebuilds
    // the SAME object under a fresh id, so anything the rebuild does not copy is silently
    // deleted from the user's scene by a button labelled "Retry". Ids are kept as they are
    // (unlike cloneObject's fresh ones) — this is one object, not two.
    ...(o.treatments ? { treatments: o.treatments } : {}),
    ...(o.motion ? { motion: o.motion } : {}),
  })
  doc.objects.splice(idx, 1, fresh)
  if (selectedId.value === id) selectedId.value = fresh.id
  loadGlb(fresh.url).catch(() => { glbError[fresh.id] = true })
}

// Upload a local .glb into ComfyUI's input dir, then add it as a scene object. The
// server's /upload/image endpoint accepts arbitrary files; the returned filename is
// served back same-origin via /view (so loadGlb's fetch works without CORS).
function triggerGlbUpload() { glbFileInput.value?.click() }
async function onGlbFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // reset so re-picking the same file re-fires change
  if (!file) return
  uploadError.value = ''
  if (file.size > GLB_SIZE_CAP_BYTES) {
    uploadError.value = `File too large — ${Math.round(GLB_SIZE_CAP_BYTES / (1024 * 1024))}MB max.`
    return
  }
  uploading.value = true
  try {
    const fd = new FormData()
    fd.append('image', file, file.name) // ComfyUI's field name is "image" for any file
    fd.append('overwrite', 'true')
    const res = await fetch('/upload/image', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`upload ${res.status}`)
    const filename = (await res.json())?.name || file.name
    addGlb(`/view?${new URLSearchParams({ filename, type: 'input' }).toString()}`)
  } catch (err) {
    console.error('[scene3d-studio] glb upload failed', err)
    uploadError.value = 'Upload failed — try again.'
  } finally {
    uploading.value = false
  }
}

// Both the file picker and the paste box funnel through here — everything past
// parsing (split/merge choice, group naming, selection) is identical either way,
// so the second entry point costs almost nothing.
async function importSvgSource(source: string, name: string) {
  if (svgBusy.value) return
  svgError.value = null
  svgBusy.value = true
  try {
    let res: Awaited<ReturnType<typeof svgToLeafPaths>>
    try {
      res = await svgToLeafPaths(source, { targetWidth: 1.5 })
    } catch (err) {
      // The real failure mode here is the paper.js dynamic import itself failing
      // (network/build issue), not a bad SVG — svgToLeafPaths swallows those.
      console.error('[scene3d-studio] svg import failed', err)
      svgError.value = 'Could not read that SVG.'
      return
    }
    // svgToLeafPaths never throws for bad input — it swallows its own parse
    // failure and resolves to an empty result — so the distinction has to be
    // read off `parseFailed`, not caught here. Conflating the two would tell
    // someone who pasted garbage that their SVG was fine but empty.
    if (res.parseFailed) {
      svgError.value = 'Could not read that SVG.'
      return
    }
    if (!res.paths.length) {
      svgError.value = 'That SVG had nothing to extrude — no filled or stroked paths.'
      return
    }
    // Gate on the PRE-OUTLINE count, BEFORE any stroke outlining. Sound because
    // outlining never GROWS the set: it replaces each stroked path with its
    // outlined solid one-for-one and only ever drops degenerate ones, so this
    // count can over-state but never under-state the object count the user is
    // being asked about. And it is the whole point — outlining is a sequential
    // boolean union per path, so running it first made the 247-path flood (the
    // exact case this dialog defends against) freeze the main thread before
    // anyone was even asked whether they wanted 247 objects.
    if (res.paths.length > SVG_SPLIT_THRESHOLD) { svgPending.value = { paths: res.paths, name }; return }
    await finishSvgImport(res.paths, name, false)
  } finally {
    svgBusy.value = false
  }
}

/** The split/merge choice buttons land here; importSvgSource skips it and calls
 *  finishSvgImport directly, because it already holds the busy flag. */
async function commitSvg(paths: SvgLeafPath[], name: string, merged: boolean) {
  if (svgBusy.value) return
  svgBusy.value = true
  try {
    await finishSvgImport(paths, name, merged)
  } finally {
    svgBusy.value = false
  }
}

/** Outline strokes (deferred until the mode is settled — see the gate above),
 *  then build the objects. Callers own the busy flag. */
async function finishSvgImport(paths: SvgLeafPath[], name: string, merged: boolean) {
  let outlined: SvgLeafPath[]
  try {
    outlined = await outlineStrokes(paths)
  } catch (err) {
    console.error('[scene3d-studio] svg stroke outlining failed', err)
    svgError.value = 'Could not read that SVG.'
    return
  }
  if (!outlined.length) {
    svgError.value = 'That SVG had nothing to extrude — no filled or stroked paths.'
    return
  }
  const objs = buildSvgObjects(outlined, doc.objects, {
    name, merged, ...(selected.value?.parentId ? { parentId: selected.value.parentId } : {}),
  })
  doc.objects.push(...objs)
  selectedIds.value = [objs[0]!.id] // buildSvgObjects returns the group first
  svgPending.value = null
  svgPasteOpen.value = false
  svgPasteText.value = ''
}

async function onSvgFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // reset so re-picking the same file re-fires change
  if (!file) return
  const base = file.name.replace(/\.svg$/i, '') || 'SVG'
  await importSvgSource(await file.text(), base)
}

// Persist the live viewport camera into the doc so it serializes with the scene
// (reopening restores your exact view). Called before every serialize/bake — the
// bake itself renders from the live engine camera, so what you see is what exports.
function syncDocCamera() {
  if (!engine || !interaction) return
  doc.camera.position = engine.camera.position.toArray() as [number, number, number]
  doc.camera.target = interaction.orbit.target.toArray() as [number, number, number]
  doc.camera.fov = engine.camera.fov
}

// ── Bake ──────────────────────────────────────────────────────────────────────
const inpaint = useInpaint()
async function bake(): Promise<void> {
  if (!engine || baking.value) return
  baking.value = true
  bakeError.value = ''
  syncDocCamera() // persist the live view before it serializes into scene_state
  // Light View swaps in clay + widgets for the live preview, but export must
  // always render the real materials — force it off for the passes, then
  // restore whatever the user had regardless of success or failure.
  const wasLightView = lightView.value
  if (wasLightView) engine?.setLightView(false)
  try {
    try {
      // Item 5 (final review): pass the SAME live elapsed-seconds value the rAF loop
      // above feeds `engine.refreshShaderFields` (`(performance.now() - scene3dMountedAt)
      // / 1000`), so a still export bakes a shaderFill field at whatever moment the live
      // view was actually showing, not always frozen at its very first frame (t=0).
      const passes = await renderPasses(engine, doc, (performance.now() - scene3dMountedAt) / 1000)
      // Upload all three passes BEFORE touching any widget so a mid-bake failure
      // never leaves a mismatched pass set (e.g. fresh beauty + stale depth).
      const [beauty, depth, normal] = await Promise.all([
        inpaint.uploadDataUrl(passes.beauty, `scene3d_beauty_${props.nodeId}`),
        inpaint.uploadDataUrl(passes.depth, `scene3d_depth_${props.nodeId}`),
        inpaint.uploadDataUrl(passes.normal, `scene3d_normal_${props.nodeId}`),
      ])
      setWidget('beauty_image', beauty)
      setWidget('depth_image', depth)
      setWidget('normal_image', normal)
      setWidget('scene_state', serializeDoc(doc))
    } finally {
      if (wasLightView) engine?.setLightView(true)
    }
  } catch (e) {
    // Swallow (no rethrow): the Bake button gets an inline error instead of an
    // unhandled rejection, and onClose's auto-bake can never block closing.
    console.error('[scene3d-studio] bake failed', e)
    bakeError.value = 'Bake failed — retry'
  } finally {
    baking.value = false
  }
}

// persistSceneState: write just the scene document onto the node widget (no
// render/upload) — the persist half of the old explicit Save button. Driven
// automatically now by useStudioAutosave below (debounced on real doc edits), and
// called directly by onClose (after its own syncDocCamera) so the final edit
// before closing is never left stranded in the debounce (same convention as
// SpaceTypeSurface's closeEditor).
//
// Deliberately does NOT call syncDocCamera() itself, unlike the old saveScene:
// syncDocCamera WRITES doc.camera, and this function is now invoked reactively
// off a watch(doc) signature (via useStudioAutosave) rather than only on an
// explicit user click. OrbitControls damping means the live camera keeps
// settling by sub-pixel amounts for a while after the user lets go, so syncing
// it here would re-mutate `doc` on every debounced persist, which changes the
// watched signature again, which reschedules another persist — a self-feeding
// loop that pinned the footer on "Saving…" forever in live testing (verified:
// removing the sync here fixed it). The camera still gets captured at every
// real checkpoint — bake() (Export/Download paths) and onClose below each call
// syncDocCamera() themselves — so nothing is lost, just no longer sampled by
// autosave's debounce tick.
//
// Gap 3 (Sculpt-and-Merge spec §6): a stroke deliberately never writes `doc` (see
// setSculptOverride's header) — only commitSculptSession does, when a stroke is
// committed. So the autosave signature below (`serializeDoc(doc)`) can only change
// on a genuine doc edit, never mid-stroke, meaning autosave correctly can't fire
// while a sculpt stroke is in progress — this function does NOT call
// commitSculptIfNeeded itself. onClose still commits any in-flight sculpt session
// (via commitAndExitSculpt) BEFORE calling this, so the pre-close write always
// includes the final strokes; the old saveScene's explicit commit-first guard only
// mattered for a user-triggered Save mid-sculpt, which no longer exists.
function persistSceneState() {
  setWidget('scene_state', serializeDoc(doc))
}
// Sticky footer status (StudioActionsFooter): real Saving…/Saved ✓ driven by the
// doc's serialized signature — a string, so it changes only on a real edit (deep
// watch is a no-op on a primitive but harmless).
const { saving: autoSaving, saved: autoSaved } = useStudioAutosave(() => serializeDoc(doc), persistSceneState)

// Export to Canvas: bake the three passes onto the node's outputs, drop the
// beauty render onto the canvas as an Image node (wired from the beauty output,
// like the other studios' "generate" flow), then return to the canvas. Stays
// open on failure so the inline error is visible.
//
// Same Gap 3 hazard as persistSceneState above: bake() renders from `doc`, and
// writes scene_state itself — both would see the pre-sculpt mesh without this.
async function exportToCanvas() {
  if (!(await commitSculptIfNeeded())) return
  await bake()
  if (bakeError.value) return
  const beauty = widgetStr('beauty_image')
  if (beauty) {
    window.dispatchEvent(new CustomEvent('sailor:scene3dStudioOutput', {
      detail: { sourceNodeId: props.nodeId, nodeType: 'Image', widgetOverrides: { image: beauty } },
    }))
  }
  emit('close')
}

// Download PNG: same bake as "As image" above (so sculpt strokes/live camera are
// captured), but saves the uploaded beauty pass locally instead of dispatching a
// node — and, unlike the canvas actions, does not close the studio.
async function downloadPng() {
  if (!(await commitSculptIfNeeded())) return
  await bake()
  if (bakeError.value) return
  const beauty = widgetStr('beauty_image')
  if (!beauty) return
  const res = await fetch(`/view?${new URLSearchParams({ filename: beauty, type: 'input' })}`)
  if (!res.ok) throw new Error(`/view returned ${res.status}`)
  const blob = await res.blob()
  downloadBlobAsFile(blob, `scene3d-${props.nodeId}.png`)
}

// Esc / ✕: persist the scene (implicit save) and leave — export is explicit now,
// so closing never re-renders.
//
// C1 fix (final review): a stroke never writes the doc by design (see
// setSculptOverride's header — a stroke must never rebuild, let alone
// serialize), so `dirty` was never set while sculpting either. Before this
// fix, closing mid-sculpt serialized the PRE-sculpt doc and threw the whole
// session away with no prompt: Escape and `removeObject` were guarded (Task
// 13), but the shell's ✕ button lives outside this surface and calls
// `onClose` directly, so it slipped through. Commit the live session first —
// same `commitAndExitSculpt` the Apply/Exit button uses — so the strokes land
// in `doc.objects` BEFORE `serializeDoc` runs. If the commit throws,
// `commitAndExitSculpt` already surfaces it via `convertError` (and still
// tears down the session/orbit-lock in its own `finally`, same as every other
// caller) — this must NOT also emit `close`, or the error would flash and
// vanish behind a closed modal instead of staying visible.
async function onClose() {
  if (sculpting.value) {
    await commitAndExitSculpt()
    if (convertError.value) return // commit failed — stay open, error is visible in the Objects aside
  }
  syncDocCamera() // persistSceneState deliberately doesn't (see its header) — do it here instead
  persistSceneState()
  emit('close')
}
</script>

<template>
  <!-- Full-bleed: the viewport IS the modal body; the Objects list and the
       inspector float over it as glass panels (⌘\ hides both). The bottom offset
       lifts the shell's agent/takes cluster clear of the add-pill below.
       `panelsVisible` comes down as a slot prop so the in-viewport overlays that
       sit in a panel's corner can step inside it — and step back when it hides. -->
  <StudioModalShell title="3D Studio" full-bleed :full-bleed-bottom-offset="72" @close="onClose">
    <template #preview="{ panelsVisible = true }">
      <div ref="viewportEl" class="relative h-full w-full min-h-0" :class="placingDecal ? 'cursor-crosshair' : ''">
        <!-- NOTHING may be inserted between these two: they are one v-if/v-else pair
             (a sibling with its own v-if in the gap would steal the v-else). -->
        <canvas v-if="webglOk" ref="canvasEl" data-scene3d class="h-full w-full" />
        <div v-else class="flex h-full items-center justify-center text-sm text-white/50">
          WebGL is unavailable — the 3D Studio needs a WebGL-capable browser.
        </div>
        <!-- Decal image picker. Lives here, OUTSIDE the bottom toolbar's v-if, because
             both callers need it: the toolbar's "Image sticker" and the Decal section's
             "Replace image" (which is reachable in Motion mode, where the toolbar is
             replaced by the timeline). -->
        <input ref="decalFileInput" type="file" accept="image/*" class="hidden" @change="onDecalFilePicked" />
        <!-- Placement mode hint: the armed state is otherwise invisible apart from
             the crosshair cursor, and the click it consumes is destructive-feeling. -->
        <div v-if="placingDecal"
             class="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-[11px] text-white/85">
          Click a surface to place — Esc to cancel
        </div>
        <!-- Overlay toolbar: snap only — the combined gizmo (Spline-style) moves,
             rotates, and scales without mode switching, so no mode buttons.
             (No "Set camera" either — the export always renders your live view.)
             @pointerdown.stop: these overlays sit inside the viewport element that
             OrbitControls binds to. Without this, a press on a button bubbles to
             OrbitControls, which setPointerCapture()s the pointer on the viewport —
             retargeting pointerup/click to the viewport so the button's @click never
             fires (and a stray orbit-drag starts). Stop it at the overlay boundary. -->
        <!-- var(--studio-panel-inset) (set by the shell in full-bleed) clears the floating panels;
             back to left-3 the moment ⌘\ takes the panel away. -->
        <div v-if="webglOk" class="absolute top-3 flex items-center gap-2 rounded-lg bg-black/60 p-1.5 backdrop-blur transition-opacity"
             :class="[panelsVisible ? 'left-[var(--studio-panel-inset)]' : 'left-3', sculpting ? 'pointer-events-none opacity-40' : '']" @pointerdown.stop>
          <button type="button" class="rounded px-2 py-1 text-xs"
            :class="snap ? 'bg-white/25 text-white' : 'bg-white/10 text-white/70 hover:bg-white/15'"
            @click="snap = !snap">snap</button>
          <button type="button" class="flex items-center gap-1 rounded px-2 py-1 text-xs"
            :class="lightView ? 'bg-white/25 text-white' : 'bg-white/10 text-white/70 hover:bg-white/15'"
            @click="lightView = !lightView"><Lightbulb class="size-3.5" /> Light</button>
        </div>

        <!-- Contextual selection actions, top-center. Only while not sculpting and the
             selection has an applicable verb. Clears the top-left snap toggles and the
             top-right shader-frozen hint. @pointerdown.stop so chip clicks don't reach
             OrbitControls. -->
        <div v-if="webglOk && !sculpting && (canGroup || canUngroup || canEnterSculpt || canMerge)"
             class="absolute top-3 left-1/2 -translate-x-1/2 z-10" @pointerdown.stop>
          <Scene3DViewportActions
            :can-group="canGroup"
            :can-ungroup="canUngroup"
            :can-enter-sculpt="canEnterSculpt"
            :can-convert-to-mesh="canConvertToMesh"
            :can-merge="canMerge"
            :sculpt-confirm-needed="sculptConfirmNeeded"
            :selected-kind-label="selectedKindLabel"
            :merge-busy="mergeBusy"
            :converting="converting"
            v-model:mergeOp="mergeOpProxy"
            v-model:mergeBlend="mergeBlend"
            v-model:mergeResolution="mergeResolution"
            @group="groupSelection"
            @ungroup="ungroupSelection"
            @convert="convertSelectionToMesh"
            @sculpt="sculptSelection"
            @merge="mergeSelection"
            @suppress-confirm="sculptConfirmSuppressed = true"
          />
        </div>

        <!-- Shader-fill frozen hint: mirrors ShapeStudioSurface.vue's — no silent caps on any
             surface. Opposite corner from the snap/light toolbar so the two never collide. -->
        <div v-if="webglOk && shaderFrozenCount > 0"
             class="pointer-events-none absolute top-3 max-w-[280px] rounded-md border border-amber-400/30 bg-black/70 px-3 py-2 text-[11px] text-amber-200/90"
             :class="panelsVisible ? 'right-[var(--studio-panel-inset)]' : 'right-3'">
          {{ shaderFrozenCount }} shader fill{{ shaderFrozenCount > 1 ? 's' : '' }} frozen — too many live shader
          fields at once (limit {{ LIVE_FIELD_CEILING }}). Remove a shader fill for full motion.
        </div>

        <!-- Motion timeline panel: docks full-width over the add-toolbar's spot in
             Motion mode (a timeline wants horizontal room — the narrow right panel
             cramped it). Transport header + the band tracks, video-editor style. -->
        <div v-if="webglOk && activeTab === 'motion'"
             class="absolute bottom-3 z-10 rounded-[12px] border border-[#2a2a2a] bg-[#1a1a1a]/95 p-2.5 shadow-lg"
             :class="panelsVisible ? 'left-[var(--studio-panel-inset)] right-[var(--studio-panel-inset)]' : 'left-3 right-3'" @pointerdown.stop>
          <div class="mb-2 flex items-center gap-2 text-[11px] text-white/60">
            <StudioButton @click="togglePlay">{{ playing ? 'Pause' : 'Play' }}</StudioButton>
            <span class="tabular-nums">{{ playhead.toFixed(2) }} / {{ doc.motion.duration.toFixed(1) }}s</span>
            <div class="flex-1"></div>
            <StudioButton @click="exportVideo">Export video</StudioButton>
          </div>
          <div v-if="motionOn" class="max-h-[32vh] overflow-y-auto pr-1">
            <Scene3DMotionTimeline :doc="doc" :selected-id="selectedId" :playhead="playhead"
              @select="(id: string) => (selectedId = id)" />
          </div>
          <p v-else class="py-1.5 text-center text-[11px] text-white/40">Turn on “Animate scene” to add motion.</p>
        </div>

        <!-- Bottom add-toolbar (Grid editor pill style): Primitive · Upload GLB ·
             Light · Decal · Generate. Primitive/Light/Decal wear the Frame
             toolbar's face+caret grammar — the face repeats the last-used entry
             in one click, the slim caret beside it opens the unchanged menu.
             Hidden in Motion mode — the timeline panel above takes its place. -->
        <div v-if="webglOk && activeTab !== 'motion' && !sculpting" class="absolute bottom-3 left-1/2 -translate-x-1/2 z-10" data-prim-menu @pointerdown.stop>
          <p v-if="uploadError" class="mb-2 text-center text-[11px] text-red-400/90">{{ uploadError }}</p>
          <div class="relative flex items-center gap-1 rounded-[12px] border border-[#2a2a2a] bg-[#1a1a1a]/95 p-1.5 shadow-lg">
            <!-- Two real buttons rather than hit-test zones inside one, so the
                 narrow caret is still a real target (Frame toolbar's rule).
                 Each group is `relative` so its popup anchors ABOVE ITS OWN
                 trigger, not the pill's far edge. -->
            <div ref="primClusterRef" class="relative flex items-center">
              <button
                type="button"
                class="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-l px-2.5 text-[12px] text-white/70 transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
                data-testid="prim-face"
                :title="'Add ' + primFaceLabel(primFace).toLowerCase()"
                @click="addFacePrimitive()"
              >
                <component :is="primFaceIcon(primFace)" class="size-4" /> {{ primFaceLabel(primFace) }}
              </button>
              <button
                type="button"
                class="flex h-8 w-4 items-center justify-center rounded-r transition-colors cursor-pointer"
                :class="primMenuOpen ? 'bg-white/15 text-white' : 'text-white/50 hover:bg-white/10 hover:text-white'"
                data-testid="prim-menu-toggle"
                title="Primitives"
                @click="togglePrimMenu()"
              >
                <ChevronUp class="size-3" />
              </button>
              <!-- Primitive menu: popup card above its own group (Brand-panel mechanic) -->
              <div
                v-if="primMenuOpen"
                data-testid="prim-menu"
                class="absolute bottom-full left-0 z-30 mb-3 w-64 rounded-lg border border-white/10 bg-[#161616] p-2 shadow-2xl"
              >
                <div v-for="group in PRIM_GROUPS" :key="group.label" class="mb-1.5 last:mb-0">
                  <p class="mb-1 px-1 text-[10px] uppercase tracking-[0.12em] text-white/35">{{ group.label }}</p>
                  <div class="grid grid-cols-2 gap-0.5">
                    <button
                      v-for="p in group.kinds"
                      :key="p.kind"
                      type="button"
                      class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
                      :class="p.kind === primFace ? 'bg-white/10 text-white' : 'text-white/80'"
                      :data-testid="'prim-menu-' + p.kind"
                      @click="pickPrimitive(p.kind)"
                    >
                      <component :is="p.icon" class="size-4 shrink-0 opacity-70" />
                      {{ p.label }}
                    </button>
                  </div>
                </div>
                <div class="mb-1.5 last:mb-0">
                  <p class="mb-1 px-1 text-[10px] uppercase tracking-[0.12em] text-white/35">Library</p>
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
                    data-testid="prim-menu-library"
                    @click="openLibraryPicker()"
                  >
                    <Shapes class="size-4 shrink-0 opacity-70" />
                    Shape library…
                  </button>
                </div>
              </div>
              <ShapePicker
                v-if="libraryPickerOpen"
                model-value="none"
                :allow-none="false"
                :anchor="libraryPickerAnchor"
                :ignore="primClusterRef"
                @update:model-value="onLibraryPick"
                @close="libraryPickerOpen = false"
              />
            </div>
            <div class="mx-0.5 h-5 w-px bg-white/10" />
            <button
              type="button"
              :disabled="uploading"
              class="flex h-8 items-center gap-1.5 whitespace-nowrap rounded px-2.5 text-[12px] text-white/70 transition-colors hover:bg-white/10 hover:text-white cursor-pointer disabled:opacity-50"
              data-testid="glb-upload"
              @click="triggerGlbUpload"
            >
              <Loader2 v-if="uploading" class="size-4 animate-spin" />
              <Upload v-else class="size-4" />
              {{ uploading ? 'Uploading…' : 'Upload GLB' }}
            </button>
            <div class="mx-0.5 h-5 w-px bg-white/10" />
            <div class="relative flex items-center">
              <button
                type="button"
                class="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-l px-2.5 text-[12px] text-white/70 transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
                data-testid="light-face"
                :title="'Add ' + lightFaceLabel(lightFace).toLowerCase() + ' light'"
                @click="addFaceLight()"
              >
                <Lightbulb class="size-4" /> {{ lightFaceLabel(lightFace) }}
              </button>
              <button
                type="button"
                class="flex h-8 w-4 items-center justify-center rounded-r transition-colors cursor-pointer"
                :class="lightMenuOpen ? 'bg-white/15 text-white' : 'text-white/50 hover:bg-white/10 hover:text-white'"
                data-testid="light-menu-toggle"
                title="Lights"
                @click="toggleLightMenu()"
              >
                <ChevronUp class="size-3" />
              </button>
              <!-- Light menu: same popup mechanic, anchored to its own group. -->
              <div
                v-if="lightMenuOpen"
                data-testid="light-menu"
                class="absolute bottom-full left-0 z-30 mb-3 w-36 rounded-lg border border-white/10 bg-[#161616] p-2 shadow-2xl"
              >
                <button
                  v-for="k in LIGHT_KINDS"
                  :key="k"
                  type="button"
                  class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
                  :class="k === lightFace ? 'bg-white/10 text-white' : 'text-white/80'"
                  :data-testid="'light-menu-' + k"
                  @click="pickLight(k)"
                >
                  <Lightbulb class="size-4 shrink-0 opacity-70" />
                  {{ LIGHT_KIND_LABELS[k] }}
                </button>
              </div>
            </div>
            <div class="mx-0.5 h-5 w-px bg-white/10" />
            <div class="relative flex items-center">
              <button
                type="button"
                class="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-l px-2.5 text-[12px] text-white/70 transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
                data-testid="decal-face"
                :title="decalFaceLabel(decalFace) + ' — click a solid to place it'"
                @click="runDecalFace()"
              >
                <component :is="decalFaceIcon(decalFace)" class="size-4" /> {{ decalFaceLabel(decalFace) }}
              </button>
              <button
                type="button"
                class="flex h-8 w-4 items-center justify-center rounded-r transition-colors cursor-pointer"
                :class="decalMenuOpen ? 'bg-white/15 text-white' : 'text-white/50 hover:bg-white/10 hover:text-white'"
                data-testid="decal-menu-toggle"
                title="Decals"
                @click="toggleDecalMenu()"
              >
                <ChevronUp class="size-3" />
              </button>
              <!-- Decal menu: same popup mechanic. Both entries ARM a placement
                   rather than adding an object — the click on the viewport is
                   what creates the decal. -->
              <div
                v-if="decalMenuOpen"
                data-testid="decal-menu"
                class="absolute bottom-full left-0 z-30 mb-3 w-44 rounded-lg border border-white/10 bg-[#161616] p-2 shadow-2xl"
              >
                <button
                  v-for="row in DECAL_ENTRIES"
                  :key="row.id"
                  type="button"
                  class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-white/10 hover:text-white cursor-pointer"
                  :class="row.id === decalFace ? 'bg-white/10 text-white' : 'text-white/80'"
                  :data-testid="'decal-menu-' + row.id"
                  @click="pickDecalEntry(row.id)"
                >
                  <component :is="row.icon" class="size-4 shrink-0 opacity-70" /> {{ row.label }}
                </button>
              </div>
            </div>
            <div class="mx-0.5 h-5 w-px bg-white/10" />
            <!-- Generate stays a plain toggle: it opens a flow panel, not a pick
                 list, so there is nothing for a face to repeat. Wrapped `relative`
                 so its panel anchors to it like the other groups. -->
            <div class="relative flex items-center">
              <button
                type="button"
                class="flex h-8 items-center gap-1.5 whitespace-nowrap rounded px-2.5 text-[12px] transition-colors cursor-pointer"
                :class="genOpen ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'"
                data-testid="gen-toggle"
                @click="toggleGenMenu()"
              >
                <Sparkles class="size-4" /> Generate
              </button>

            <!-- Generate menu: text → image review → make 3D. Right-aligned to
                 its own wrapper so it hugs the trigger. -->
            <div
              v-if="genOpen"
              class="absolute bottom-full right-0 z-30 mb-3 w-72 rounded-lg border border-white/10 bg-[#161616] p-3 shadow-2xl"
            >
              <p class="mb-1.5 text-[10px] uppercase tracking-[0.12em] text-white/35">Generate 3D model</p>
              <textarea
                v-model="genPrompt"
                rows="2"
                placeholder="A weathered leather armchair…"
                class="mb-2 w-full resize-none rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[12px] text-white/85 placeholder:text-white/30 outline-none focus:border-white/25"
              />
              <StudioButton
                variant="primary"
                :disabled="!genPrompt.trim() || genStage === 'image' || genStage === 'making'"
                @click="genImage"
              >
                <span class="flex items-center gap-1.5">
                  <Loader2 v-if="genStage === 'image'" class="h-3.5 w-3.5 animate-spin" />
                  <Sparkles v-else class="h-3.5 w-3.5" />
                  {{ genStage === 'image' ? 'Generating image…' : 'Generate' }}
                </span>
              </StudioButton>

              <template v-if="genImageUrl && genStage !== 'idle'">
                <div class="mt-3 space-y-2">
                  <img :src="genImageUrl!" alt="" class="h-32 w-full rounded object-cover" />
                  <div class="flex items-center gap-1.5">
                    <StudioButton variant="secondary" :disabled="genStage === 'making'" @click="reroll">
                      <span class="flex items-center gap-1.5"><Shuffle class="h-3.5 w-3.5" /> Re-roll</span>
                    </StudioButton>
                  </div>
                  <div>
                    <label class="mb-1 block text-[11px] text-white/55">3D model</label>
                    <select
                      v-model="gen3dModel"
                      class="w-full rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[12px] text-white/85 outline-none focus:border-white/25"
                    >
                      <option v-for="m in GEN_3D_MODELS" :key="m" :value="m">{{ m }}</option>
                    </select>
                  </div>
                  <label class="flex cursor-pointer items-center justify-between text-[11px] text-white/55">
                    <span>Textured</span>
                    <input v-model="genTextured" type="checkbox" class="h-3.5 w-3.5 accent-white/70" />
                  </label>
                  <StudioButton variant="primary" :disabled="genStage === 'making'" @click="make3d">
                    <span class="flex items-center gap-1.5">
                      <Loader2 v-if="genStage === 'making'" class="h-3.5 w-3.5 animate-spin" />
                      <Box v-else class="h-3.5 w-3.5" />
                      {{ genStage === 'making' ? 'Making 3D…' : 'Make 3D' }}
                    </span>
                  </StudioButton>
                </div>
              </template>

              <p v-if="genStage === 'error' && genError" class="mt-2 text-[11px] text-red-400/90">{{ genError }}</p>
            </div>
            </div>
          </div>
        </div>

        <!-- Sculpt bottom-dock toolbar: occupies the same bottom-center spot as the
             add-toolbar while a sculpt session is open (add-toolbar is gated off by
             `!sculpting` above). @pointerdown.stop so brush clicks don't reach
             OrbitControls; the pill itself is pointer-events-auto. -->
        <div v-if="webglOk && sculpting" class="absolute bottom-3 left-1/2 -translate-x-1/2 z-10" @pointerdown.stop>
          <Scene3DSculptToolbar
            v-model:brush="sculptBrush"
            v-model:size="sculptSize"
            v-model:strength="sculptStrength"
            v-model:symmetry="sculptSymmetry"
            v-model:symmetryAxis="sculptSymmetryAxis"
            v-model:symmetryCount="sculptSymmetryCount"
            v-model:remeshResolution="sculptRemeshResolution"
            :remesh-vertex-count="sculptVertexCount"
            :remesh-kb="sculptMeshKB"
            :remesh-busy="sculptRemeshBusy"
            :remesh-error="convertError"
            :committing="committing"
            @apply="commitAndExitSculpt"
            @exit="commitAndExitSculpt"
            @remesh="remeshSculptSession"
          />
        </div>

        <!-- Light View labels: HTML chips (color dot + name + live intensity) at
             each light's projected screen position. pointer-events-none root so
             the viewport stays orbit/select-driven; @pointerdown.stop guards the
             (empty) root anyway, matching the other overlay containers here. -->
        <div class="pointer-events-none absolute inset-0" @pointerdown.stop>
          <div
            v-for="l in lightLabels"
            :key="l.id"
            v-show="l.show"
            class="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white"
            :style="{ left: l.x + 'px', top: l.y + 'px' }"
          >
            <span class="size-2 shrink-0 rounded-full" :style="{ background: l.color }" />
            {{ l.name }} · {{ l.intensity.toFixed(1) }}
          </div>
        </div>
      </div>
    </template>

    <!-- Object list: its own dedicated panel (like Smart Layout / Frame), separate
         from the inspector column at right. -->
    <template #aside>
      <!-- No border/background of its own any more: the shell's floating glass
           panel already frames this column, and a second frame inside it read as
           a panel-in-a-panel. -->
      <div class="flex h-full w-full flex-col overflow-hidden">
        <div class="shrink-0 px-3 py-2.5 text-[11px] font-medium text-white/50">Objects</div>
        <p v-if="convertError" class="shrink-0 px-2 pb-2 text-[11px] leading-snug text-red-400/90">{{ convertError }}</p>
        <div class="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          <div v-if="!doc.objects.length" class="px-1 text-xs leading-relaxed text-white/40">
            Empty scene — add a primitive or upload a GLB from the toolbar below<span v-if="wiredGlbUrl">, or import the wired model</span>.
          </div>
          <Scene3DObjectRow v-for="o in rootObjectList" :key="o.id"
            :object="o" :objects="doc.objects" :selected-ids="selectedIds" :glb-error="glbError" :depth="0"
            :selected-treatment="selectedTreatment" :not-rendered="unrenderedTreatments" :selected-modifier="selectedModifier"
            @select="toggleSelected"
            @remove="removeObject"
            @duplicate="duplicateObject"
            @retry="retryGlb"
            @toggle-visible="(id) => { const found = doc.objects.find((x) => x.id === id); if (found) found.visible = !found.visible }"
            @add-treatment="addTreatment"
            @select-treatment="selectTreatment"
            @remove-treatment="removeTreatment"
            @duplicate-treatment="duplicateTreatment"
            @toggle-treatment="toggleTreatment"
            @reorder-treatment="reorderTreatment"
            @add-modifier="addModifier"
            @select-modifier="selectModifier"
            @remove-modifier="removeModifier"
            @duplicate-modifier="duplicateModifier"
            @toggle-modifier="toggleModifier"
            @reorder-modifier="reorderModifier" />
        </div>
        <div v-if="wiredGlbUrl" class="shrink-0 border-t border-white/[0.08] p-2">
          <StudioButton @click="addGlb(wiredGlbUrl)">
            <span class="flex items-center gap-1.5"><Plus class="h-3.5 w-3.5" /> Import wired model</span>
          </StudioButton>
        </div>
        <input ref="glbFileInput" type="file" accept=".glb,model/gltf-binary" class="hidden" @change="onGlbFilePicked" />

        <!-- SVG import: same file-import spot as the GLB upload above. Two doors
             (file picker, paste box) into one importSvgSource — see its comment. -->
        <div class="shrink-0 space-y-1 border-t border-white/[0.08] p-2">
          <StudioButton @click="svgFileInput?.click()">
            <span class="flex items-center gap-1.5"><Upload class="h-3.5 w-3.5" /> Import SVG</span>
          </StudioButton>
          <StudioButton @click="svgPasteOpen = !svgPasteOpen">
            <span class="flex items-center gap-1.5"><ClipboardPaste class="h-3.5 w-3.5" /> Paste SVG</span>
          </StudioButton>
          <div v-if="svgPasteOpen" class="space-y-1">
            <textarea v-model="svgPasteText" rows="4" placeholder="Paste <svg>…</svg>"
              class="w-full rounded bg-black/30 p-2 text-[11px] text-white/80" @pointerdown.stop />
            <StudioButton :disabled="!svgPasteText.trim() || svgBusy" @click="importSvgSource(svgPasteText, 'SVG')">Add</StudioButton>
          </div>
          <p v-if="svgError" class="text-[11px] text-red-400">{{ svgError }}</p>
          <div v-if="svgPending" class="space-y-1 rounded border border-white/15 p-2 text-[11px]">
            <p class="text-white/70">This SVG has {{ svgPending.paths.length }} paths.</p>
            <div class="flex gap-1">
              <StudioButton :disabled="svgBusy" @click="commitSvg(svgPending.paths, svgPending.name, false)">Separate objects</StudioButton>
              <StudioButton :disabled="svgBusy" @click="commitSvg(svgPending.paths, svgPending.name, true)">One merged object</StudioButton>
            </div>
          </div>
          <input ref="svgFileInput" type="file" accept=".svg,image/svg+xml" class="hidden" @change="onSvgFilePicked" />
        </div>
      </div>
    </template>

    <template #controls>
      <!-- Sculpt mode (Gap 3 fix): the sculpt panel now replaces ONLY the
           Geometry section below (where the Remesh control already lived for
           a mesh primitive) — everything else in this column (Transform,
           Material, the Build/Motion tabs, Motion, and the Save/Export
           footer) stays live and editable while a stroke session is open, per
           spec §6. Save/Export commit the live session first — see
           `commitSculptIfNeeded` — so neither one can persist the pre-sculpt
           mesh out from under an open sculpt session. -->
      <div class="mb-2 flex gap-1 rounded-lg bg-white/[0.04] p-1 text-[11px]">
        <button type="button" class="nodrag flex-1 rounded px-2 py-1 disabled:opacity-40 disabled:pointer-events-none"
                :disabled="sculpting"
                :class="activeTab === 'build' ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white/80'"
                @click="activeTab = 'build'">Build</button>
        <button type="button" class="nodrag flex-1 rounded px-2 py-1 disabled:opacity-40 disabled:pointer-events-none"
                :disabled="sculpting"
                :class="activeTab === 'motion' ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white/80'"
                @click="activeTab = 'motion'">Motion</button>
      </div>

      <!-- Treatment inspector (design spec §2): a treatment row is selected in the tree, so
           this column shows ONLY that treatment's dials under a breadcrumb naming its object.
           Selecting a treatment cleared the object selection, so none of the object cards
           below apply; clicking the object name in the breadcrumb selects the object again. -->
      <template v-if="activeTab === 'build' && activeTreatment">
        <div class="mb-2 flex items-center gap-1.5 px-1 text-[11px] text-white/50" data-testid="treatment-breadcrumb">
          <button type="button" class="truncate hover:text-white/80" @click="selectedIds = [activeTreatment.obj.id]">{{ activeTreatment.obj.name }}</button>
          <ChevronRight class="h-3 w-3 shrink-0 opacity-60" />
          <span class="truncate text-white/80">{{ TREATMENT_LABELS[activeTreatment.treatment.kind] }}</span>
        </div>
        <div class="flex flex-col gap-2" @pointerdown.capture="onControlsPointerDown">
          <StudioControlPanel
            :controls="treatmentPanelControls"
            :order="treatmentPanelOrder"
            :value="readTreatmentControl"
            :visible="treatmentControlVisible"
            @set="setTreatmentControl"
          />
        </div>
      </template>

      <!-- Modifier inspector (S1 Task 6): a modifier row is selected in the tree, so this column
           shows ONLY that modifier's dials under a breadcrumb naming its object. The dials come
           from modifierControls(kind) and read/write the SELECTED instance — the axis / mode
           selects coerce label↔index on the instance (readModifierControl / setModifierControl),
           and every edit persists through writeModifierStack (keeping the Vary bag). The Cloner
           additionally shows the bag-backed Vary section below its placement dials. -->
      <template v-if="activeTab === 'build' && activeModifier">
        <div class="mb-2 flex items-center gap-1.5 px-1 text-[11px] text-white/50" data-testid="modifier-breadcrumb">
          <button type="button" class="truncate hover:text-white/80" @click="selectedIds = [activeModifier.obj.id]">{{ activeModifier.obj.name }}</button>
          <ChevronRight class="h-3 w-3 shrink-0 opacity-60" />
          <span class="truncate text-white/80">{{ MODIFIER_LABELS[activeModifier.modifier.kind] }}</span>
        </div>
        <div class="flex flex-col gap-2" @pointerdown.capture="onControlsPointerDown">
          <!-- Boolean — the "Combine with" object picker, sourced from the live scene (a dynamic
               select can't live in static MODIFIER_SPECS). Sits above the operation/blend/resolution
               dials so you choose the sibling first. Writes the object's id into refObjectId. -->
          <div v-if="activeModifier.modifier.kind === 'boolean'" data-testid="boolean-combine-with">
            <label class="mb-1 block text-[11px] text-white/55">Combine with</label>
            <StudioSelect
              v-model="booleanRefId"
              :options="booleanSiblingOptions"
              :option-labels="booleanSiblingLabels"
            />
            <p v-if="booleanSiblingOptions.length <= 1" class="mt-1 text-[11px] text-white/45">
              Add another object to combine this one with.
            </p>
          </div>
          <StudioControlPanel
            :controls="modifierPanelControls"
            :order="modifierPanelOrder"
            :value="readModifierControl"
            :visible="modifierControlVisible"
            @set="setModifierControl"
          />
          <!-- Vary — bag-backed (NOT a stack field): how a property changes from one copy to the
               next. Only the Cloner has it, and only with more than one copy. -->
          <div v-if="activeModifier.modifier.kind === 'cloner' && varyBlockVisible" class="flex flex-col gap-2" data-testid="modifier-vary">
            <div class="text-[10px] uppercase tracking-[0.12em] text-white/25">Vary</div>
            <StudioRow :spec="optionRowSpec('varyMode', 'ui.cloner.varyMode')" :model-value="optionOf('varyMode')" :bindable="false"
              @update:model-value="(v: string | number | boolean) => setOption('varyMode', String(v))" />
            <StudioRow v-if="varyModeNow === 1" :spec="varySliderSpec('varySeed')" :model-value="modOf('varySeed')" :bindable="false"
              @update:model-value="(v: string | number | boolean) => setMod('varySeed', Number(v))" />
            <template v-if="varyModeNow === 2">
              <StudioRow :spec="varySliderSpec('varyFalloffCenter')" :model-value="modOf('varyFalloffCenter')" :bindable="false"
                @update:model-value="(v: string | number | boolean) => setMod('varyFalloffCenter', Number(v))" />
              <StudioRow :spec="varySliderSpec('varyFalloffRadius')" :model-value="modOf('varyFalloffRadius')" :bindable="false"
                @update:model-value="(v: string | number | boolean) => setMod('varyFalloffRadius', Number(v))" />
            </template>
            <StudioRow v-if="varyColorableNow" :spec="optionRowSpec('varyColor', 'ui.cloner.varyColor')" :model-value="optionOf('varyColor')" :bindable="false"
              @update:model-value="(v: string | number | boolean) => setOption('varyColor', String(v))" />
            <template v-if="varyColorOnNow">
              <VaryPalette :model-value="varyPaletteOf" @update:model-value="setVaryPalette" />
              <StudioRow :spec="optionRowSpec('varyColorSpread', 'ui.cloner.varyColorSpread')" :model-value="optionOf('varyColorSpread')" :bindable="false"
                @update:model-value="(v: string | number | boolean) => setOption('varyColorSpread', String(v))" />
              <StudioRow :spec="varySliderSpec('varyColorStrength')" :model-value="modOf('varyColorStrength')" :bindable="false"
                @update:model-value="(v: string | number | boolean) => setMod('varyColorStrength', Number(v))" />
            </template>
          </div>
        </div>
      </template>

      <template v-if="activeTab === 'build' && !activeTreatment && !activeModifier">
      <!-- Multi-selection indicator. Every row below reads the PRIMARY's value
           but writes to the whole selection, so without this the panel looks
           like an ordinary single-object inspector right up until one edit
           changes N objects. Action blue is Sailor's only accent. -->
      <div v-if="selectedIds.length > 1" data-testid="multi-select-badge"
           class="mb-2 flex items-center gap-1.5 rounded-lg border border-[#4f8cff]/35 bg-[#4f8cff]/10 px-2.5 py-1.5 text-[11px] text-[#4f8cff]">
        <Boxes class="h-3.5 w-3.5 shrink-0" />
        <span class="tabular-nums">{{ selectedIds.length }} objects selected</span>
        <span class="ml-auto shrink-0 text-[10px] text-[#4f8cff]/60">edits apply to all</span>
      </div>
      <!-- Transform, drawn from SCENE_CONTROLS' Transform group. Its own panel because the
           hand-written Geometry section (and the sculpt panel that replaces it) sits between
           it and the Material card below, and one panel cannot interleave a hand-written
           section. Rotation rows are degrees and Size rows are world units — the conversions
           the old rotX/sizeX proxies did now live in panelPresentation.ts, once, shared with
           the write path. All nine carry `entry: 'unclamped'`, so the declared ranges paint
           the row without gating what you may type into it: the gizmo puts an object at
           x = 35 and the row has to keep it there (see the schema's own note). -->
      <div class="flex flex-col gap-2" @pointerdown.capture="onControlsPointerDown">
        <StudioControlPanel
          :controls="panelControls"
          :order="SCENE_TRANSFORM_SECTIONS"
          :value="readControl"
          @set="setControl"
        />
      </div>

      <!-- Geometry — DRAWN FROM SCENE_CONTROLS, from the same `panelControls` row list the
           Transform panel above and the Material panel below use. Its own StudioControlPanel
           because the sculpt panel above replaces exactly this card and nothing else in the
           column (see SCENE_GEOMETRY_SECTIONS' own note); the parameter rows come from
           PRIMITIVE_PARAMS[kind]. The Modifiers and Cloner cards are GONE (S1 Task 6): a
           modifier's dials now live on the per-row inspector, read/written on the stack instance,
           so the always-on cards that read the now-dead legacy bag are removed. What stays bespoke
           below is what was never a parameter: the text primitive's string + font pickers, the mesh
           remesh/solidify block, and the Cloner's live cost readout (its clone COUNT sourced from
           the stack). -->
      <div v-if="selectedIsPrimitive && !sculpting" class="flex flex-col gap-2" @pointerdown.capture="onControlsPointerDown">
        <StudioControlPanel
          :controls="panelControls"
          :order="SCENE_GEOMETRY_SECTIONS"
          :sections="panelChrome"
          :value="readControl"
          @set="setControl"
        >
        <!-- Text controls: not schema-driven (content is {text?,font?}, only
             carried by `text` objects). -->
        <template #control-ui.geometry.text>
        <div class="space-y-3">
          <div>
            <label class="mb-1 block text-[11px] text-white/55">Text</label>
            <input v-model="textValue" type="text" aria-label="Text content" class="studio-num" style="text-align: left" />
          </div>
          <div>
            <label class="mb-1 block text-[11px] text-white/55">Font</label>
            <FontPicker
              :model-value="fontDisplayName(selectedText?.content?.font ?? DEFAULT_FONT_URL)"
              :pinned="AVAILABLE_FONTS.map((f) => ({ label: f.label, value: f.url }))"
              :show-variable-toggle="false"
              @select="onFontPick"
            />
            <p v-if="fontError" class="mt-1 text-[11px] text-red-400">Font failed to load — showing placeholder.</p>
          </div>
          <div v-if="selectedGoogleFont">
            <StudioSelect label="Weight" v-model="fontWeight" :options="fontWeightOptions" />
          </div>
          <div v-if="selectedLibraryFont">
            <StudioSelect label="Weight" v-model="libraryFontWeight" :options="libraryWeightOptions" />
          </div>
        </div>
        </template>

        <!-- Remesh / Solidify: PRIMITIVE_PARAMS.mesh is `[]`, so a mesh object has no
             parametric geometry at all — this fills that space instead. -->
        <template #control-ui.geometry.mesh>
        <div class="space-y-3">
          <StudioSlider
            v-model="remeshResolution"
            label="Resolution"
            :min="16" :max="REMESH_RESOLUTION_MAX" :step="1"
          />
          <p class="text-[11px] text-white/45">{{ meshVertexCount.toLocaleString('en-US') }} vertices · {{ meshEncodedKB }} KB</p>
          <p v-if="meshError" class="text-[11px] text-red-400">Mesh failed to load — showing placeholder.</p>
          <StudioButton v-if="!remeshOpen" :disabled="remeshBusy" @click="remeshSelection">
            <span class="flex items-center gap-1.5">
              <Loader2 v-if="remeshBusy" class="h-3.5 w-3.5 animate-spin" />
              {{ remeshBusy ? 'Remeshing…' : 'Remesh' }}
            </span>
          </StudioButton>
          <template v-else>
            <p class="text-[11px] leading-snug text-white/55">This shape is open, so it has no inside to rebuild. Give it a thickness first.</p>
            <StudioSlider
              v-model="solidifyThickness"
              label="Thickness"
              :min="0.005" :max="0.2" :step="0.005"
            />
            <StudioButton :disabled="remeshBusy" @click="solidifySelection">
              <span class="flex items-center gap-1.5">
                <Loader2 v-if="remeshBusy" class="h-3.5 w-3.5 animate-spin" />
                {{ remeshBusy ? 'Solidifying…' : 'Solidify' }}
              </span>
            </StudioButton>
          </template>
          <!-- I5 fix (final review): `convertError` also carries Remesh/Solidify
               failures, but its only render site lived in the Objects aside next
               to the To-mesh/Merge buttons — clear across the viewport from
               these controls, which live in this inspector column. Rather than
               stand up a second error ref+presentation for the same string, this
               renders the SAME ref right next to the control that actually wrote
               it, so a Remesh/Solidify failure is visible where it happened. -->
          <p v-if="convertError" class="text-[11px] leading-snug text-red-400/90">{{ convertError }}</p>
        </div>
        </template>

        <!-- Cost disclosure: what this clone set actually costs, live while dragging.
             Amber past the point where rebuilds start to hitch. The clone COUNT reads the STACK's
             cloner row (cloneCost), not the legacy bag. The Modifiers and Cloner dials themselves
             now live on the per-modifier inspector (S1 Task 6), one row at a time. -->
        <template #control-ui.cloner.cost>
          <div>
            <div
              v-if="cloneCost"
              class="text-[10px] tabular-nums"
              :class="cloneCost.heavy ? 'text-amber-400/80' : 'text-white/35'"
            >
              {{ cloneCost.copies }} copies · ~{{ compactCount(cloneCost.verts) }} verts<template v-if="deferringGeometry"> · updates on release</template>
            </div>
            <div
              v-if="cloneCost?.clamp.clamped"
              class="pt-0.5 text-[10px] tabular-nums text-amber-400/80"
            >
              Clone count reduced to {{ cloneCost.clamp.count }} to stay inside the vertex budget.
            </div>
          </div>
        </template>
        </StudioControlPanel>
      </div>

      <!-- Material / Camera / Lighting / Background — DRAWN FROM SCENE_CONTROLS, not
           hand-written. `panelControls` is the presentation-remapped copy built by
           lib/scene3d/panelPresentation.ts: same rows, same order, same captions the
           hand-written sections had, re-grouped into the cards they were drawn in
           (including the five sub-blocks that were bare <details> inside Material) and
           with an inert `ui.*` anchor row wherever a bespoke widget sat, so its slot
           below lands in the shipped position. The shared post stack's own cards follow
           in POST_SECTIONS order — one panel, not two.
           The Material card sits BELOW the hand-written Light/Decal cards rather than
           above them, as it did: a light or a decal is never a primitive or a GLB, so the
           two can never be on screen together and the move is invisible.
           The capture wrapper reproduces the `@pointerdown.capture` the Transform/
           Geometry/Material StudioSections carried — StudioControlPanel has no such hook,
           and a capture listener on an ancestor has the same effect. `flex flex-col
           gap-2` reproduces the controls column's own gap inside the wrapper. -->
      <div class="flex flex-col gap-2" @pointerdown.capture="onControlsPointerDown">
        <StudioControlPanel
          :controls="panelControls"
          :order="SCENE_PANEL_SECTIONS"
          :sections="panelChrome"
          :value="readControl"
          @set="setControl"
        >
          <!-- Decal content. There is no gizmo for a decal (see the selection watch), so
               "Reposition" re-arms the same click-to-place flow the toolbar uses. -->
          <template #control-ui.decal.text>
            <div class="space-y-3">
              <div>
                <label class="mb-1 block text-[11px] text-white/55">Label</label>
                <input v-model="decalText" type="text" placeholder="Label" aria-label="Decal label"
                  class="w-full rounded border border-white/10 bg-white/5 px-2 py-1.5 text-[12px] text-white/85 outline-none focus:border-white/25" />
              </div>
              <div>
                <label class="mb-1 block text-[11px] text-white/55">Font</label>
                <FontPicker
                  :model-value="fontDisplayName(decalFont)"
                  :show-variable-toggle="false"
                  @select="onDecalFontPick"
                />
              </div>
              <div v-if="selectedDecalGoogleFont">
                <StudioSelect label="Weight" v-model="decalFontWeight" :options="decalFontWeightOptions" />
              </div>
              <div v-if="selectedDecalLibraryFont">
                <StudioSelect label="Weight" v-model="decalLibraryFontWeight" :options="decalLibraryWeightOptions" />
              </div>
            </div>
          </template>

          <template #control-ui.decal.image>
            <div class="space-y-3">
              <img v-if="selectedDecal?.content.type === 'image'" :src="texViewUrl(selectedDecal.content.image)" alt=""
                class="h-16 w-full rounded bg-white/5 object-contain" />
              <StudioButton class="w-full" @click="triggerDecalReplace">Replace image</StudioButton>
            </div>
          </template>

          <template #control-ui.decal.reposition>
            <StudioButton class="w-full" :disabled="!!placingDecal" @click="beginDecalPlacement({ decalId: selectedDecal!.id })">
              {{ placingDecal ? 'Click a surface…' : 'Reposition' }}
            </StudioButton>
            <p class="mt-1 text-[10px] text-white/35">Or drag the sticker on the canvas</p>
          </template>

          <!-- Imported models keep their baked materials until overridden. -->
          <template #control-ui.material.override>
            <div class="flex items-center justify-between">
              <div>
                <span class="text-[11px] text-white/55">Override materials</span>
                <p class="text-[10px] text-white/35">Replace the model's built-in look</p>
              </div>
              <StudioSwitch v-model="matOverride" />
            </div>
          </template>

          <template #control-ui.material.surface>
            <p class="text-[10px] uppercase tracking-[0.12em] text-white/35">Surface</p>
          </template>

          <template #control-ui.material.prism>
            <div class="flex items-center justify-between">
              <span class="text-[11px] text-white/55">Prism look</span>
              <StudioButton variant="secondary" @click="applyPrismPreset">Prism</StudioButton>
            </div>
          </template>

          <template #control-ui.material.matcap>
            <div>
              <label class="mb-1 block text-[11px] text-white/55">Matcap</label>
              <div class="flex items-center gap-1.5">
                <button v-for="id in MATCAP_IDS" :key="id" type="button" :title="id"
                  class="size-8 overflow-hidden rounded-full border transition-colors"
                  :class="matMatcap === id ? 'border-white/80' : 'border-white/15 hover:border-white/40'"
                  @click="matMatcap = id">
                  <img :src="matcapThumb(id)" class="size-full" alt="" />
                </button>
              </div>
            </div>
          </template>

          <!-- Real-world PBR surfaces from ambientCG. The picker fetches the set before it
               writes the id, so a failed download leaves the material as it was. -->
          <template #control-ui.material.textureSet>
            <TexturePicker v-model="matTexture" />
          </template>

          <!-- Palette: Manual keeps the authored ramp editor; Harmony instead GENERATES the
               ramp from hue/sat/light + a scheme (rampStopsOf in config.ts) — the two are
               mutually exclusive views onto the same `gradientStops` field, so only one
               editor is ever visible. The scheme picker stays bespoke because its options
               carry display labels (HARMONY_LABELS) a bare select row cannot show. -->
          <template #control-ui.material.harmony>
            <div>
              <label class="mb-1 block text-[11px] text-white/55">Harmony</label>
              <select
                v-model="matPaletteHarmony"
                class="w-full rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[12px] text-white/85 outline-none focus:border-white/25"
              >
                <option v-for="h in HARMONY_TYPES" :key="h" :value="h">{{ HARMONY_LABELS[h] }}</option>
              </select>
            </div>
          </template>

          <template #control-ui.material.gradientStops>
            <StudioGradientRamp v-model="matGradientStops" />
            <PalettePicker
              mode="stops"
              :stop-count="matGradientStops.length"
              :seed="matGradientStops[0]?.color ?? '#4f8ad9'"
              class="mt-2"
              @apply-stops="applySeedPaletteStops"
              @apply-literal-stops="applySeedPaletteStops"
            />
          </template>

          <template #control-ui.material.gradientDirection>
            <div>
              <label class="mb-1 block text-[11px] text-white/55">Direction</label>
              <div class="flex items-center gap-1.5">
                <button v-for="ax in (['x', 'y', 'z'] as const)" :key="ax" type="button"
                  class="flex-1 rounded border px-2 py-1 text-[11px] uppercase transition-colors"
                  :class="isAxisPreset(ax) ? 'border-white/70 bg-white/[0.10] text-white' : 'border-white/[0.10] bg-white/[0.04] text-white/55 hover:text-white/85'"
                  @click="applyAxisPreset(ax)">{{ ax }}</button>
              </div>
            </div>
          </template>

          <!-- Opalescent reuses the SAME gradient-stop field, falling back to the vivid
               cyclic default (opalStopsOf) rather than the grey color→gradientB pair, so a
               fresh opal shows a rainbow and switching types carries the palette across. -->
          <template #control-ui.material.opalStops>
            <StudioGradientRamp v-model="matOpalStops" />
          </template>

          <template #control-ui.material.image>
            <div v-if="selected" class="space-y-3">
              <input ref="texFileInput" type="file" accept="image/*" class="hidden" @change="onTexFilePicked" />
              <div class="flex items-center gap-2">
                <img v-if="selected.material.image" class="size-12 rounded object-cover"
                  :src="texViewUrl(selected.material.image)" alt="" />
                <StudioButton :disabled="texUploading === selected.id" @click="triggerTexUpload">
                  <span class="flex items-center gap-1.5">
                    <Loader2 v-if="texUploading === selected.id" class="h-3.5 w-3.5 animate-spin" />
                    <Upload v-else class="h-3.5 w-3.5" />
                    {{ texUploading === selected.id ? 'Uploading…' : selected.material.image ? 'Replace image' : 'Upload image' }}
                  </span>
                </StudioButton>
              </div>
              <p v-if="texUploadError[selected.id] || (selected.material.image && texLoadError[selected.material.image])"
                class="text-[11px] text-red-400/90">texture failed</p>
              <div class="space-y-1.5">
                <input
                  v-model="texGenPrompt"
                  type="text"
                  placeholder="Describe a surface, such as brushed copper"
                  class="w-full rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[12px] text-white/85 outline-none placeholder:text-white/30 focus:border-white/25"
                  @keydown.enter.prevent="generateTexture"
                />
                <StudioButton variant="primary" :disabled="!texGenPrompt.trim() || texGenerating === selected.id" @click="generateTexture">
                  <span class="flex items-center gap-1.5">
                    <Loader2 v-if="texGenerating === selected.id" class="h-3.5 w-3.5 animate-spin" />
                    <Sparkles v-else class="h-3.5 w-3.5" />
                    {{ texGenerating === selected.id ? 'Generating…' : 'Generate a texture' }}
                  </span>
                </StudioButton>
                <p v-if="texGenError[selected.id]" class="text-[11px] text-red-400/90">Texture generation failed — try again.</p>
              </div>
            </div>
          </template>

          <!-- shaderFill: a catalog effect wrapped onto the mesh's own UVs (object anchor
               only — materials.ts never reads `shader.anchor`, see SceneMaterial.shader's
               doc in config.ts). Same component Space Type, Shape Studio and the Compositor
               mount; `show-anchor="false"` hides the anchor toggle rather than leaving it
               offered-but-inert. -->
          <template #control-ui.material.shader>
            <ShaderFillEditor v-model="matShader" :show-anchor="false" />
          </template>

          <!-- Surface relief: a grayscale height texture perturbing .bumpMap, orthogonal to
               material type. NB: never call this a "normal pass" in copy — passes.ts already
               emits a screen-space `normal` G-buffer for ControlNet, a completely different
               thing. -->
          <template #control-ui.relief.unavailable>
            <p class="text-[10px] text-white/35">
              Unlit materials have no lighting to catch relief. Turn off Unlit to use it.
            </p>
          </template>

          <!-- `normalImage` is independent of the Relief source (see config.ts's doc):
               materials.ts keeps applying it whatever Relief is set to, so the control that
               clears it has to be visible whenever one is bound, not only inside the Image
               branch. -->
          <template #control-ui.relief.normalMapBound>
            <div class="flex items-center justify-between rounded border border-white/10 bg-white/[0.03] px-2 py-1.5">
              <div>
                <span class="text-[11px] text-white/55">Normal map bound</span>
                <p class="text-[10px] text-white/35">Applied regardless of the Relief source above</p>
              </div>
              <button type="button" class="text-[11px] text-white/55 underline hover:text-white/85" @click="removeNormalMap">Remove</button>
            </div>
          </template>

          <!-- image: the uploaded file's ORIGINAL bytes are stored as-is; materials.ts
               converts to a height field exactly once, at texture-build time. -->
          <template #control-ui.relief.image>
            <div v-if="selected" class="space-y-3">
              <input ref="reliefFileInput" type="file" accept="image/*" class="hidden" @change="onReliefFilePicked" />
              <div class="flex items-center gap-2">
                <img v-if="matReliefImage" class="size-12 rounded object-cover"
                  :src="texViewUrl(matReliefImage)" alt="" />
                <StudioButton :disabled="reliefUploading === selected.id" @click="triggerReliefUpload">
                  <span class="flex items-center gap-1.5">
                    <Loader2 v-if="reliefUploading === selected.id" class="h-3.5 w-3.5 animate-spin" />
                    <Upload v-else class="h-3.5 w-3.5" />
                    {{ reliefUploading === selected.id ? 'Uploading…' : matReliefImage ? 'Replace image' : 'Upload image' }}
                  </span>
                </StudioButton>
                <!-- AI height generation: text → fal FLUX tile → fal depth model, via
                     /api/scene3d/gen-map. Explicit button — never automatic, it costs money. -->
                <StudioButton :disabled="reliefGenBusy === selected.id" @click="toggleReliefGen">
                  <span class="flex items-center gap-1.5">
                    <Loader2 v-if="reliefGenBusy === selected.id" class="h-3.5 w-3.5 animate-spin" />
                    <Sparkles v-else class="h-3.5 w-3.5" />
                    {{ reliefGenBusy === selected.id ? 'Generating…' : 'Generate…' }}
                  </span>
                </StudioButton>
              </div>
              <p v-if="reliefUploadError[selected.id] || (matReliefImage && texLoadError[matReliefImage])"
                class="text-[11px] text-red-400/90">texture failed</p>
              <p v-else-if="reliefFlatWarning[selected.id]" class="text-[11px] text-amber-400/80">
                This image is very smooth — raise Contrast, or try one with finer detail.
              </p>
              <div v-if="reliefGenOpen" class="space-y-1.5 rounded border border-white/10 bg-white/[0.03] p-2">
                <textarea
                  v-model="reliefGenPrompt"
                  rows="2"
                  placeholder="Hammered copper, worn oak planks…"
                  :disabled="reliefGenBusy === selected.id"
                  class="w-full resize-none rounded border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[12px] text-white/85 placeholder:text-white/30 outline-none focus:border-white/25"
                />
                <StudioButton
                  variant="primary"
                  :disabled="!reliefGenPrompt.trim() || reliefGenBusy === selected.id"
                  @click="generateReliefFromPrompt"
                >
                  <span class="flex items-center gap-1.5">
                    <Loader2 v-if="reliefGenBusy === selected.id" class="h-3.5 w-3.5 animate-spin" />
                    <Sparkles v-else class="h-3.5 w-3.5" />
                    {{ reliefGenBusy === selected.id ? 'Generating height map…' : 'Generate' }}
                  </span>
                </StudioButton>
              </div>
              <p v-if="reliefGenError[selected.id]" class="text-[11px] text-red-400/90">
                Height generation failed — try again.
              </p>
              <div v-if="matReliefImage" class="flex items-center justify-between">
                <div>
                  <span class="text-[11px] text-white/55">Already a normal map</span>
                  <p class="text-[10px] text-white/35">For maps baked in Blender or from a game asset</p>
                </div>
                <StudioSwitch v-model="matIsNormalMap" />
              </div>
            </div>
          </template>

          <!-- shader: the same ShaderFillEditor binding as the shaderFill branch above,
               just pointed at relief.spec instead of material.shader. -->
          <template #control-ui.relief.shader>
            <ShaderFillEditor v-model="matReliefSpec" :show-anchor="false" />
          </template>

          <template #control-ui.camera.output>
            <div>
              <label class="mb-1 block text-[11px] text-white/55">Output</label>
              <StudioSegmented v-model="outputProxy" :options="OUTPUT_OPTIONS" />
            </div>
          </template>

          <!-- Background transparency remembers the last real colour, so toggling back
               restores it instead of landing on black — which is why the colour is a
               stateful proxy and not a plain doc leaf, and therefore not in the schema. -->
          <template #control-ui.background.transparent>
            <!-- Drawn through StudioRow — not bare label + switch — so these two carry the
                 same 28px row chrome as Floor above them. World backdrop: shows the
                 reflected environment behind the geometry, which is what makes glass
                 dispersion fan into rainbow (the strips have to be IN the refraction
                 backdrop, not just the reflection map). -->
            <div class="flex flex-col gap-1.5">
              <StudioRow :spec="BG_WORLD_SPEC" :model-value="bgShowWorld" :bindable="false"
                @update:model-value="(v: string | number | boolean) => (bgShowWorld = v === true)" />
              <StudioRow :spec="BG_TRANSPARENT_SPEC" :model-value="bgTransparent" :bindable="false"
                @update:model-value="(v: string | number | boolean) => (bgTransparent = v === true)" />
            </div>
          </template>

          <template #control-ui.background.color>
            <!-- Same shared row as the two switches above, so the whole card reads as one. -->
            <StudioRow :spec="BG_COLOR_SPEC" :model-value="bgColorProxy" :bindable="false"
              @update:model-value="(v: string | number | boolean) => (bgColorProxy = String(v))" />
          </template>
        </StudioControlPanel>
      </div>
      </template>
      <template v-else>
        <StudioSection title="Motion">
          <div class="flex items-center justify-between">
            <span class="text-[11px] text-white/55">Animate scene</span>
            <StudioSwitch v-model="motionOn" />
          </div>
          <template v-if="motionOn">
            <StudioSlider v-model="doc.motion.duration" label="Duration (s)" :min="1" :max="60" :step="0.5"
                          hint="Scene length. Video export renders FPS × Duration frames — a 60s clip at 30fps is 1800." />
            <StudioSlider v-model="doc.motion.fps" label="FPS" :min="12" :max="60" :step="1" />
            <div class="grid grid-cols-3 gap-1">
              <button v-for="key in (['showcase', 'reveal', 'loop'] as const)" :key="key" type="button"
                      class="nodrag rounded-lg border border-white/10 bg-white/[0.04] px-2 py-2 text-[11px] text-white/70 hover:bg-white/10"
                      :class="{ 'border-sky-400/60 text-white': doc.motion.template === key }"
                      @click="applyTemplate(key)">
                {{ key === 'showcase' ? 'Showcase' : key === 'reveal' ? 'Reveal' : 'Loop' }}
              </button>
            </div>
            <div>
              <StudioSelect label="Camera" :model-value="doc.camera.motion?.preset ?? 'none'" :options="CAMERA_OPTIONS"
                @update:model-value="(v: string) => doc.camera.motion = v === 'none' ? undefined : { preset: v as CameraMotion['preset'], speed: doc.camera.motion?.speed ?? 1, amount: doc.camera.motion?.amount ?? 1 }" />
            </div>
            <template v-if="doc.camera.motion">
              <StudioSlider v-if="CAMERA_USES_CYCLES.includes(doc.camera.motion.preset)"
                            v-model="doc.camera.motion.speed" label="Camera cycles" :min="1" :max="20" :step="1"
                            hint="How many times the camera move repeats across the scene." />
              <StudioSlider v-if="CAMERA_USES_AMOUNT.includes(doc.camera.motion.preset)"
                            v-model="doc.camera.motion.amount" label="Camera amount" :min="0" :max="3" :step="0.1" />
            </template>
          </template>
        </StudioSection>

        <!-- Decals excluded: the engine pins a decal root to identity under its
             target (the projection is baked in target-local space), so it rides
             the target's motion and has no transform of its own to animate —
             offering the controls would write a clip nothing ever plays. Same
             exclusion the motion timeline's rows make. -->
        <StudioSection v-if="motionOn && selected && selected.kind !== 'decal'" title="Object motion">
          <div>
            <StudioSelect label="Loop" :model-value="selected.motion?.loop?.kind ?? 'none'" :options="LOOP_OPTIONS"
              @update:model-value="(v: string) => setObjectLoop(selected!, v as LoopKind)" />
          </div>
          <template v-if="selected.motion?.loop">
            <StudioSlider v-model="selected.motion.loop.speed" label="Cycles" :min="1" :max="20" :step="1"
                          hint="How many times the loop repeats across the scene. Whole numbers only, so it closes seamlessly at the end." />
            <StudioSlider v-if="LOOP_USES_AMOUNT.includes(selected.motion.loop.kind)"
                          v-model="selected.motion.loop.amount" label="Amount" :min="0" :max="3" :step="0.1" />
          </template>
          <div>
            <StudioSelect label="In" :model-value="selected.motion?.in?.preset ?? 'none'" :options="IN_OPTIONS"
              @update:model-value="(v: string) => setObjectTransition(selected!, 'in', v as TransitionPreset | 'none')" />
          </div>
          <template v-if="selected?.motion?.in">
            <div v-if="['move', 'rise'].includes(selected.motion.in.preset)">
              <StudioSelect label="In direction" :model-value="selected.motion.in.direction ?? 'left'" :options="DIRECTION_OPTIONS"
                @update:model-value="(v: string) => setObjectDirection(selected!, 'in', v as Direction)" />
            </div>
            <div>
              <StudioSelect label="In ease" :model-value="easeKey('in')" :options="EASE_KEY_OPTIONS"
                @update:model-value="(v: string) => setEaseKey('in', v)" />
              <CurveEditor v-if="curveProxy('in') !== null" class="mt-1"
                :model-value="curveProxy('in')!" @update:model-value="(v: string) => setCurve('in', v)" />
            </div>
          </template>
          <div>
            <StudioSelect label="Out" :model-value="selected.motion?.out?.preset ?? 'none'" :options="OUT_OPTIONS"
              @update:model-value="(v: string) => setObjectTransition(selected!, 'out', v as TransitionPreset | 'none')" />
          </div>
          <template v-if="selected?.motion?.out">
            <div v-if="['move', 'rise'].includes(selected.motion.out.preset)">
              <StudioSelect label="Out direction" :model-value="selected.motion.out.direction ?? 'left'" :options="DIRECTION_OPTIONS"
                @update:model-value="(v: string) => setObjectDirection(selected!, 'out', v as Direction)" />
            </div>
            <div>
              <StudioSelect label="Out ease" :model-value="easeKey('out')" :options="EASE_KEY_OPTIONS"
                @update:model-value="(v: string) => setEaseKey('out', v)" />
              <CurveEditor v-if="curveProxy('out') !== null" class="mt-1"
                :model-value="curveProxy('out')!" @update:model-value="(v: string) => setCurve('out', v)" />
            </div>
          </template>
        </StudioSection>

      </template>

    </template>
    <!-- StudioActionsFooter lives in the modal's reserved bottom-right actions footer
         (shell #actions), like every other studio — there is no Save button; saving is
         automatic and debounced (see useStudioAutosave/persistSceneState above). The old
         pointer-events-none/auto workaround is gone with the move to a footer: it's its
         own row now, so it no longer overlaps the scrolling column (the sculpt panel's
         Remesh button that it used to eat is no longer underneath it). `committing` still
         disables the canvas actions for the length of a sculpt commit, as before. -->
    <template #actions>
      <StudioActionsFooter :spec="{
        status: { saving: autoSaving, saved: autoSaved, error: (bakeError && !baking) ? bakeError : null },
        downloads: [
          { label: 'Download PNG', onClick: downloadPng, busy: baking, disabled: !doc.objects.length },
          { label: 'Download video', onClick: exportVideo, busy: videoBaking },
        ],
        canvas: [
          { label: 'As image', onClick: exportToCanvas, busy: baking, disabled: committing || !doc.objects.length },
          { label: 'As video', onClick: renderVideoToCanvas, busy: videoBaking, disabled: committing || !doc.objects.length },
        ],
      }" />
    </template>
  </StudioModalShell>
</template>

<style scoped>
/* Compact numeric transform input — matches the studio kit's mono/muted language. */
.studio-num {
  width: 100%;
  border-radius: 0.25rem;
  background: rgba(255, 255, 255, 0.05);
  padding: 0.25rem 0.375rem;
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.85);
  outline: none;
  -moz-appearance: textfield;
}
.studio-num:focus {
  background: rgba(255, 255, 255, 0.1);
}
.studio-num::-webkit-outer-spin-button,
.studio-num::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
</style>
