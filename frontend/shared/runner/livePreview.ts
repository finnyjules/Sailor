/**
 * Live previews through the runner (step 3, R2.11): which nodes a preview
 * works out itself and which it pins by the files they last showed. One rule
 * for the browser's request (app/lib/runner/livePreview.ts) and the route
 * (server/runner/preview.ts), so the two never disagree about a node.
 *
 * A preview runs the target effect and the chain of local nodes behind it
 * (effects whose family is on, an Image card fed by a wire, an open Gate,
 * Empty image, Image to mask) on the files the canvas already shows for the
 * first node that isn't local on each path. It holds nothing, records
 * nothing and charges nothing.
 */
import { GATE_CLASS, isLink, linksOf, type ApiPrompt } from './graph'
import { familyOn, type RunnerFamily } from './families'
import { EFFECT_FAMILY_OF, effectFamilyOn, effectSchemaOf } from './effects'
import { outputKindsFor, runnerTakesNode, type RunnerEligibilityOptions } from './eligibility'
import { outputKind } from './values'

/** A file the canvas shows: never one of the runner's kept files. */
export interface PreviewFile { filename: string; subfolder: string; type: 'input' | 'output' | 'temp' }

/** What the browser sends (the route's body adds `canvasId`). */
export interface PreviewRequest {
  nodeId: string
  /** The target, the local nodes behind it, and the pinned nodes (with their real class). */
  prompt: ApiPrompt
  /** Each pinned node's last shown files. */
  pinned: Record<string, PreviewFile[]>
}

export const PREVIEW_NEEDS_FULL_RUN = 'This preview needs a full run'
/** `data.reason` of the 409 that tells the browser to run the node as before (the only 409 it falls back on). */
export const PREVIEW_NEEDS_FULL_RUN_REASON = 'needs-full-run'
export const PREVIEW_SUPERSEDED = 'A newer preview of this step took its place'
/** `data.reason` of the 409 an older preview gets when a newer one for the same node replaces it. */
export const PREVIEW_SUPERSEDED_REASON = 'superseded'
/** The most local nodes one preview works out. */
export const PREVIEW_MAX_NODES = 16
/** The most files one pinned node may bring. */
export const PREVIEW_MAX_PINNED_FILES = 16

/** Whether a node can be a preview's target: an effect that writes `live_preview_<id>.png` (Painter writes no such file). */
export function previewTarget(classType: string): boolean {
  return !!effectSchemaOf(classType) && classType !== 'Painter'
}

/**
 * Whether a preview works this node out itself: an effect whose family is on
 * (never the Shader effect, which needs the browser's bake), or a card the
 * runner computes with no provider (an Image card fed by a wire, an open
 * Gate, Empty image, Image to mask), and the runner's own rule takes it.
 */
export function previewComputes(prompt: ApiPrompt, id: string, families: ReadonlySet<RunnerFamily>, opts: RunnerEligibilityOptions = {}): boolean {
  const n = prompt[id]
  if (!n || !familyOn('cards', families)) return false
  const inputs = n.inputs ?? {}
  const cls = n.class_type
  const local = cls === 'ShaderEffect' ? false
    : effectSchemaOf(cls) ? effectFamilyOn(cls, families)
      : cls === 'Image' ? isLink(inputs.images)
        : cls === GATE_CLASS ? inputs.bypass === true
          : cls === 'EmptyImage' || cls === 'ImageToMask'
  return local && runnerTakesNode(prompt, id, families, opts)
}

/**
 * Whether a preview may pin this node by its last shown files: a node that
 * makes its own picture (a paid node, an Image card with its file, a
 * LoadImage…), read on its first output, which carries pictures. Never an
 * effect (one whose family is off leaves the preview to the old path), nor a
 * node that only hands on a picture from further up.
 */
export function previewPins(prompt: ApiPrompt, id: string, slot: number, families: ReadonlySet<RunnerFamily>): boolean {
  const n = prompt[id]
  if (!n || slot !== 0) return false
  const inputs = n.inputs ?? {}
  const cls = n.class_type
  if (cls === 'ShaderEffect' || Object.prototype.hasOwnProperty.call(EFFECT_FAMILY_OF, cls)) return false
  if (cls === GATE_CLASS || (cls === 'Image' && isLink(inputs.images)) || (cls === 'TextMask' && isLink(inputs.source))) return false
  return outputKind(prompt, [id, 0], outputKindsFor(families)) === 'files'
}

/**
 * The preview of `nodeId`: the local nodes it works out, in the order they
 * run (each after what it reads), and the nodes it pins. Null when the node
 * can't be previewed this way (the old path runs it).
 */
export function previewPlan(
  prompt: ApiPrompt, nodeId: string, families: ReadonlySet<RunnerFamily>, opts: RunnerEligibilityOptions = {},
): { order: string[]; pins: string[] } | null {
  const target = prompt[nodeId]
  if (!target || !previewTarget(target.class_type)) return null
  const order: string[] = []
  const pins = new Set<string>()
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): boolean => {
    const s = state.get(id)
    if (s === 'done') return true
    if (s === 'visiting' || !previewComputes(prompt, id, families, opts)) return false
    state.set(id, 'visiting')
    for (const l of linksOf(prompt[id])) {
      if (previewComputes(prompt, l.from, families, opts)) {
        if (!visit(l.from)) return false
      }
      else if (previewPins(prompt, l.from, l.slot, families)) pins.add(l.from)
      else return false
    }
    state.set(id, 'done')
    order.push(id)
    return order.length <= PREVIEW_MAX_NODES
  }
  if (!visit(nodeId)) return null
  return { order, pins: [...pins] }
}
