/**
 * Applying a moodboard to the Generate-an-image node (moodboards Plan B,
 * Tasks B2+B3). A moodboard pick on GenerateImageNode is WEIGHTLESS — no LoRA
 * loads — so the whole apply is node properties:
 *
 *   aesthetic        — the composed style block (moodboardStyleBlock over the
 *                      board's Fable reading). composeLoraStyle reads it at
 *                      submit time and the injector writes it into the node's
 *                      hidden `style_block` widget by NAME (see styleInject.ts).
 *   sailor_moodboard — the board's identity, so the chip on the node face can
 *                      show name + thumb and the ✕ knows what to clear.
 *   style_refs       — Task B3: `{folder, files[]}` JSON (input-dir-relative
 *                      paths, ≤3 files, never base64) when the model can take
 *                      reference images (the catalog's 'multi-image' tag);
 *                      EMPTY STRING otherwise. styleInject writes it into the
 *                      hidden `style_refs` widget by name at submit time; the
 *                      Python node reads the files and hands data URLs to the
 *                      ref-capable builder.
 *   sailor_moodboard_switched — Task B3's auto-switch marker: when the node's
 *                      current model can't take refs, the apply flips the model
 *                      widget to MOODBOARD_DEFAULT_MODEL and records the
 *                      PREVIOUS model id here. The chip shows a legible notice
 *                      with a one-click Revert (revertMoodboardSwitch). A
 *                      manual model pick clears the marker (ModelGalleryModal)
 *                      — and an applied board with NO marker means the user
 *                      chose that model on purpose, so re-applying never
 *                      switches over them (manual choice wins).
 *
 * Pure property writes, no DOM/canvas dependency — used by the chip picker
 * now and by Task B4's TASTE-wire materialization later. The model WIDGET
 * write itself stays with the caller (widgets are positional; callers own the
 * widgetDefs lookup) — the helper reports it via `writes.model`.
 */
import { moodboardStyleBlock } from '~/lib/taste/styleBlock'
import { IMAGE_MODELS, IMAGE_MODELS_BY_ID, IMAGE_MODEL_PREFERENCE, type ImageModel } from '~/data/image-models'
import type { MoodboardEntry } from '~~/shared/taste/moodboard'

/** The model an apply switches to when the current one can't take refs: the
 *  "Generate an image" class default (IMAGE_MODEL_PREFERENCE, model line-up
 *  H2), taking the first on that list that takes reference pictures and
 *  runs everywhere (not hidden, discontinued or runner-only); failing that,
 *  the first such model in the catalogue; failing that, it throws at load.
 *  Today that is
 *  Nano Banana 2, verified live (2026-08-07) to carry full pattern-level
 *  board transfer at roughly half Nano Banana Pro's price. */
export const MOODBOARD_DEFAULT_MODEL: string = moodboardDefaultModel()

/** The preference list first, then the catalogue; never a model that can't take references. */
export function moodboardDefaultModel(
  models: readonly ImageModel[] = IMAGE_MODELS,
  preference: readonly string[] = IMAGE_MODEL_PREFERENCE,
): string {
  const usable = (m: ImageModel | undefined): m is ImageModel =>
    !!m && !m.hidden && !m.discontinued && !m.runnerOnly && m.tags.includes('multi-image')
  const preferred = preference.find(id => usable(models.find(m => m.id === id)))
  if (preferred) return preferred
  const any = models.find(usable)
  if (!any) throw new Error('moodboardApply: no image model in the catalogue takes reference pictures')
  return any.id
}

/** Refs cap — lives in shared/taste/moodboard.ts since Task B5 (the flatten
 *  route enforces the same cap); re-exported so existing importers keep their
 *  path. Mirrored by the Python side (_MOODBOARD_MAX_REFS). */
export { MOODBOARD_MAX_REFS } from '~~/shared/taste/moodboard'
import { MOODBOARD_MAX_REFS } from '~~/shared/taste/moodboard'

/** The catalog tag that gates reference images. */
const REF_TAG = 'multi-image'

export interface MoodboardWireWrites {
  sailor_moodboard: string
  /** `{folder, files[]}` JSON when refs ride along; '' when the (final) model
   *  can't take them or the board has no readable files. */
  style_refs: string
  /** Model id the caller must write into the `model` widget, or null when no
   *  switch happened (already ref-capable, or manual choice wins). */
  model: string | null
  /** The marker value (previous model id) when this apply switched — mirrors
   *  properties.sailor_moodboard_switched. */
  switchedFrom: string | null
}

export interface MoodboardApplyWrites extends MoodboardWireWrites {
  aesthetic: string
}

/** Minimal node-data shape the apply touches — keeps the helper testable. */
export interface MoodboardApplyTarget {
  properties?: Record<string, any>
}

/**
 * The WIRE-path apply ("Applying IS wiring" amendment, 2026-08-07): every
 * side effect of applying a moodboard to the Generate-an-image node EXCEPT
 * the prose block — the TASTE wire (Moodboard.style → style_in) is the single
 * carrier of the block now, so `properties.aesthetic` is never written here
 * (a stale one from the pre-wire era is DELETED — leaving it would resurrect
 * the block through the property channel the moment the wire goes away, and
 * the submit-time injector would have two carriers to reconcile).
 *
 * Still written: `sailor_moodboard` (chip identity — the chip reads props,
 * never the graph), `style_refs` (property-carried file paths; refs don't
 * travel on the wire) and the legible auto-switch marker.
 *
 * `files` is the board's image file list (the guarded list route's `files`,
 * already sorted); `modelId`/`modelTags` describe the node's CURRENT model.
 * Returns the writes it performed so callers (and tests) can assert on them
 * without re-deriving — and so the caller can perform the positional `model`
 * widget write when it switched.
 */
export function applyMoodboardWireEffects(
  nodeData: MoodboardApplyTarget,
  entry: MoodboardEntry,
  files: string[],
  modelId: string,
  modelTags: string[],
): MoodboardWireWrites {
  if (!nodeData.properties) nodeData.properties = {}
  const props = nodeData.properties

  // Manual choice wins: a board already applied WITHOUT the auto-switch marker
  // means the current model is the user's own pick — never re-switch over it.
  const manualChoice = !!props.sailor_moodboard && !props.sailor_moodboard_switched
  const switching = !modelTags.includes(REF_TAG) && !manualChoice
  // Tags of the model the run will actually use — after a switch, the default
  // model's (from the catalog, so the gate can't drift from the source).
  const finalTags: readonly string[] = switching
    ? (IMAGE_MODELS_BY_ID[MOODBOARD_DEFAULT_MODEL]?.tags ?? [])
    : modelTags

  const refFiles = files.filter(f => typeof f === 'string' && f).slice(0, MOODBOARD_MAX_REFS)
  const styleRefs = finalTags.includes(REF_TAG) && refFiles.length > 0
    ? JSON.stringify({ folder: entry.folder, files: refFiles })
    : ''

  if (switching) {
    // Keep the ORIGINAL pre-switch model if a marker already exists — revert
    // must land on the user's true model, not an intermediate.
    props.sailor_moodboard_switched = String(props.sailor_moodboard_switched || modelId)
  }

  const writes: MoodboardWireWrites = {
    sailor_moodboard: entry.id,
    style_refs: styleRefs,
    model: switching ? MOODBOARD_DEFAULT_MODEL : null,
    switchedFrom: switching ? String(props.sailor_moodboard_switched) : null,
  }
  // Single-carrier rule: any pre-amendment property block goes.
  delete props.aesthetic
  props.sailor_moodboard = writes.sailor_moodboard
  props.style_refs = writes.style_refs
  return writes
}

/**
 * The PROPERTY-path apply (pre-amendment shape, kept for the FLUX slot-free
 * legacy path and for tests pinning the block composition): the wire effects
 * PLUS the prose block written into `properties.aesthetic`. The chip pick no
 * longer uses this for GenerateImageNode — applying IS wiring, so the canvas
 * runs `applyMoodboardWireEffects` and draws the real TASTE edge instead.
 */
export function applyMoodboardToGenerateNode(
  nodeData: MoodboardApplyTarget,
  entry: MoodboardEntry,
  files: string[],
  modelId: string,
  modelTags: string[],
): MoodboardApplyWrites {
  const wire = applyMoodboardWireEffects(nodeData, entry, files, modelId, modelTags)
  const aesthetic = moodboardStyleBlock(entry.reading)
  nodeData.properties!.aesthetic = aesthetic
  return { ...wire, aesthetic }
}

/**
 * The Moodboard node's own widget sync (Plan B, Task B4). The Python twin
 * (comfy_extras/nodes_moodboard.py) reads two hidden STRING widgets —
 * `reading_json` (the entry's reading as JSON) and `moodboard_id` — and
 * widgets_values is POSITIONAL, so the values are written by NAME against the
 * node's widgetDefs (the /object_info-derived order). When the defs don't
 * carry the name yet (backend not restarted since the twin landed, so
 * objectInfo lacks the Moodboard schema), fall back to the canonical schema
 * order below — it IS the twin's declared order, and the append-only schema
 * contract keeps it stable.
 *
 * Called on modal save AND whenever the node's referenced entry changes
 * (MoodboardNode.vue watches the entry). `entry` null/undefined clears both
 * widgets (reference removed).
 */
export const MOODBOARD_WIDGET_ORDER = ['reading_json', 'moodboard_id'] as const

export interface MoodboardWidgetTarget {
  widgetsValues?: any[]
  widgetDefs?: { name: string }[]
}

export function syncMoodboardWidgets(
  nodeData: MoodboardWidgetTarget,
  entry: Pick<MoodboardEntry, 'id' | 'reading'> | null | undefined,
): void {
  if (!Array.isArray(nodeData.widgetsValues)) nodeData.widgetsValues = []
  const wv = nodeData.widgetsValues
  const defs = Array.isArray(nodeData.widgetDefs) ? nodeData.widgetDefs : []
  const write = (name: (typeof MOODBOARD_WIDGET_ORDER)[number], value: string): void => {
    const defIdx = defs.findIndex(d => d?.name === name)
    const idx = defIdx >= 0 ? defIdx : MOODBOARD_WIDGET_ORDER.indexOf(name)
    while (wv.length <= idx) wv.push('')
    wv[idx] = value
  }
  write('reading_json', entry ? JSON.stringify(entry.reading) : '')
  write('moodboard_id', entry ? entry.id : '')
}

/**
 * The @refs exposure of a saved board (Plan B, Task B5): names + registry
 * entries for the board's flattened images. `flatFiles` is what POST
 * /api/moodboards/refs returned — input-ROOT filenames (`mb_<slug>_<i>.<ext>`),
 * flattened because the app's /view-based image widgets basename their
 * `filename` param (a `moodboard_<ms>/x.png` subpath 404s in every widget
 * preview even though the backend graph loader resolves it fine — verified
 * live 2026-08-07). Names follow the spec's `mb-<slug>-<i>` scheme, i from 0,
 * capped at MOODBOARD_MAX_REFS. Pure — the modal dispatches the result via
 * the layout's `sailor:createRef` batch handler.
 */
export function moodboardRefDescriptors(
  slug: string,
  flatFiles: string[],
): { name: string; entry: { filename: string } }[] {
  return flatFiles
    .filter(f => typeof f === 'string' && !!f)
    .slice(0, MOODBOARD_MAX_REFS)
    .map((filename, i) => ({ name: `mb-${slug}-${i}`, entry: { filename } }))
}

/**
 * The chip's one-click Revert on the auto-switch notice: clears the marker and
 * the refs payload, returns the model id the caller must restore into the
 * `model` widget (null when there is nothing to revert). The board itself
 * stays applied — revert is about the MODEL, not the style block.
 */
export function revertMoodboardSwitch(nodeData: MoodboardApplyTarget): string | null {
  const props = nodeData.properties
  const prev = props?.sailor_moodboard_switched
  if (!props || typeof prev !== 'string' || !prev) return null
  delete props.sailor_moodboard_switched
  delete props.style_refs
  return prev
}

/**
 * The chip's ✕ — removes the style block, the identity key, the refs payload
 * and the switch marker, so the node stops steering the prompt AND stops
 * reading as moodboard-filled. The model widget is left alone (no silent model
 * change on clear — the picker shows what you're on).
 */
export function clearMoodboardFromGenerateNode(nodeData: MoodboardApplyTarget): void {
  if (!nodeData.properties) return
  delete nodeData.properties.aesthetic
  delete nodeData.properties.sailor_moodboard
  delete nodeData.properties.style_refs
  delete nodeData.properties.sailor_moodboard_switched
}

/**
 * The RESTYLE path (2026-08-09): attach a moodboard as the style source to a
 * RestyleFromImageNode. Unlike the Generate helper this NEVER switches the
 * model or sets an auto-switch marker — restyle's engine defaults to Nano
 * Banana 2 (already multi-image) and its selector is not the shared image-model
 * catalog. The board's ≤3 images ride as style_refs; the prose taste block
 * travels on the TASTE wire (style_in), so it is not written here. Any stale
 * `aesthetic` is deleted (single-carrier rule).
 */
export function applyMoodboardToRestyleNode(
  nodeData: MoodboardApplyTarget,
  entry: MoodboardEntry,
  files: string[],
): { sailor_moodboard: string; style_refs: string } {
  if (!nodeData.properties) nodeData.properties = {}
  const props = nodeData.properties
  const refFiles = files.filter(f => typeof f === 'string' && f).slice(0, MOODBOARD_MAX_REFS)
  const styleRefs = refFiles.length > 0
    ? JSON.stringify({ folder: entry.folder, files: refFiles })
    : ''
  delete props.aesthetic
  props.sailor_moodboard = entry.id
  props.style_refs = styleRefs
  return { sailor_moodboard: entry.id, style_refs: styleRefs }
}
