/**
 * Every frame batch's count and size through a workflow, before the run
 * (step 3, R6 rule 3), from the sources' probes and the widgets:
 *   - Get video components of a file: the file's header (pyFrameCount and the
 *     probe's size; an estimate, `exact: false`, since the decode is what
 *     counts); of a made video: the batch Create video named;
 *   - Load video frames: its pick (loadFramesPick), an upper bound, or its
 *     64 × 64 black frame when nothing would be picked;
 *   - a Gate hands on what reached it;
 *   - a ported video effect with its family on: its own `shape` (./table.ts).
 *
 * `batchesOf` also says which batches are new kept files and who reads each
 * one (through Gates, Create video, Video cards and Get video components of a
 * made video, which hand the same file on): the start pass reads it to bound
 * the run's kept total, batches let go after their last reader (ruling (j)).
 */
import { GATE_CLASS, isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { mediaEffectFamilyOn } from '#shared/runner/mediaEffects'
import { MEDIA_EFFECT_SCHEMAS } from '#shared/runner/mediaEffectSchemas.generated'
import type { OutputFile } from '../types'
import type { FileAccess } from '../fileAccess'
import { parseInputFileRef } from '../inputs'
import { loadFramesPick, settingsOf } from '../media/frameNodes'
import { probeVideoFile } from '../../media/values'
import { pyFrameCount } from '../../media/probe'
import { VIDEO_EFFECTS, mediaEffectParams, type FrameShape } from './table'

const key = (l: ApiLink) => `${l[0]}:${l[1]}`

/** The nodes in an order where each comes after everything it reads (the prompt has no cycles). */
export function topoOrder(prompt: ApiPrompt): string[] {
  const order: string[] = []
  const state = new Map<string, 1 | 2>()
  const visit = (id: string, depth: number) => {
    if (state.get(id) === 2 || depth > 10_000) return
    if (state.get(id) === 1) return
    state.set(id, 1)
    for (const v of Object.values(prompt[id]?.inputs ?? {})) {
      if (isLink(v) && v[0] in prompt) visit(v[0], depth + 1)
    }
    state.set(id, 2)
    order.push(id)
  }
  for (const id of Object.keys(prompt)) visit(id, 0)
  return order
}

/** A video effect the runner takes here: ported, with its family (and chain) on. */
export function takenVideoEffect(classType: string, families: ReadonlySet<RunnerFamily>): boolean {
  return Object.prototype.hasOwnProperty.call(VIDEO_EFFECTS, classType) && mediaEffectFamilyOn(classType, families)
}

/** A batch kept as a file of its own: the node that makes it, who reads it, and the order it is made in. */
export interface KeptBatch { maker: string; readers: Set<string> }

/**
 * Which slot carries which kept batch (by its maker's id), in prompt order:
 * a maker makes a new file; a Gate, Create video, a Video card, Get video
 * components of a made video and an effect that hands its input on carry the
 * same file on.
 */
export function batchesOf(prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>, shapes: ReadonlyMap<string, FrameShape>): { order: string[]; carried: Map<string, string>; batches: Map<string, KeptBatch> } {
  const order = topoOrder(prompt)
  const carried = new Map<string, string>()
  const batches = new Map<string, KeptBatch>()
  const from = (v: unknown) => (isLink(v) ? carried.get(key(v)) : undefined)
  for (const id of order) {
    const n = prompt[id]!
    const inputs = n.inputs ?? {}
    let on: string | undefined
    switch (n.class_type) {
      case GATE_CLASS: on = from(inputs.data_in); break
      case 'CreateVideo': on = from(inputs.images); break
      case 'Video': on = from(inputs.source); break
      case 'GetVideoComponents':
        on = from(inputs.video)
        if (!on && shapes.has(`${id}:0`)) { on = id; batches.set(id, { maker: id, readers: new Set() }) }
        break
      case 'LoadVideoFrames':
        if (shapes.has(`${id}:0`)) { on = id; batches.set(id, { maker: id, readers: new Set() }) }
        break
      default:
        if (takenVideoEffect(n.class_type, families) && shapes.has(`${id}:0`)) {
          const spec = VIDEO_EFFECTS[n.class_type]!
          const ins = spec.inputs.map(name => (isLink(inputs[name]) ? shapes.get(key(inputs[name] as ApiLink)) : undefined))
          const params = mediaEffectParams(MEDIA_EFFECT_SCHEMAS[n.class_type], inputs)
          if (ins.every(Boolean) && spec.passThrough?.(params, ins as FrameShape[])) on = from(inputs[spec.inputs[0]!])
          else { on = id; batches.set(id, { maker: id, readers: new Set() }) }
        }
    }
    if (on) carried.set(`${id}:0`, on)
  }
  // Every node reading a slot that carries a batch reads that batch.
  for (const [id, n] of Object.entries(prompt)) {
    for (const v of Object.values(n.inputs ?? {})) {
      const b = isLink(v) ? carried.get(key(v)) : undefined
      if (b) batches.get(b)?.readers.add(id)
    }
  }
  return { order, carried, batches }
}

/**
 * Every frame batch's shape through the workflow, keyed `${nodeId}:${slot}`,
 * from the sources' probes (`sourceShape`: Get video components of a file,
 * Load video frames) and the widgets. A shape that can't be known (a source
 * the build can't read, an effect whose input isn't known) is left out.
 */
export async function frameShapes(
  prompt: ApiPrompt, families: ReadonlySet<RunnerFamily>,
  sourceShape: (nodeId: string, classType: string) => Promise<FrameShape | null>,
): Promise<Map<string, FrameShape>> {
  const shapes = new Map<string, FrameShape>()
  const at = (v: unknown) => (isLink(v) ? shapes.get(key(v)) : undefined)
  for (const id of topoOrder(prompt)) {
    const n = prompt[id]!
    const inputs = n.inputs ?? {}
    let s: FrameShape | null | undefined
    switch (n.class_type) {
      case GATE_CLASS: s = at(inputs.data_in); break
      // A made video's frames are the batch Create video named; carried on by a Video card.
      case 'CreateVideo': s = at(inputs.images); break
      case 'Video': s = at(inputs.source); break
      case 'GetVideoComponents':
        s = at(inputs.video) ?? (isLink(inputs.video) && madeVideoLink(prompt, inputs.video) ? null : await sourceShape(id, n.class_type))
        break
      case 'LoadVideoFrames': s = await sourceShape(id, n.class_type); break
      default: {
        if (!takenVideoEffect(n.class_type, families)) break
        const spec = VIDEO_EFFECTS[n.class_type]!
        const ins = spec.inputs.map(name => at(inputs[name]))
        if (!ins.every(Boolean)) break
        s = spec.shape(mediaEffectParams(MEDIA_EFFECT_SCHEMAS[n.class_type], inputs), ins as FrameShape[])
      }
    }
    if (s) shapes.set(`${id}:0`, s)
  }
  return shapes
}

/** Whether a VIDEO wire brings a made video (Create video's, through Gates and Video cards' sources). */
function madeVideoLink(prompt: ApiPrompt, link: ApiLink, depth = 0): boolean {
  const from = prompt[link[0]]
  if (!from || depth > 64) return false
  if (from.class_type === 'CreateVideo') return true
  if (from.class_type === GATE_CLASS) return isLink(from.inputs?.data_in) && madeVideoLink(prompt, from.inputs.data_in as ApiLink, depth + 1)
  if (from.class_type === 'Video') return isLink(from.inputs?.source) && madeVideoLink(prompt, from.inputs.source as ApiLink, depth + 1)
  return false
}

/** The file a VIDEO wire brings where it is known before the run: a Load video's, or a Video card's (its source's first). */
function videoFileOf(prompt: ApiPrompt, link: ApiLink, depth = 0): OutputFile | null {
  const from = prompt[link[0]]
  if (!from || depth > 64 || link[1] !== 0) return null
  const inputs = from.inputs ?? {}
  if (from.class_type === 'LoadVideo') return isLink(inputs.file) ? null : parseInputFileRef(inputs.file)
  if (from.class_type === GATE_CLASS) return isLink(inputs.data_in) ? videoFileOf(prompt, inputs.data_in, depth + 1) : null
  if (from.class_type === 'Video') {
    if (isLink(inputs.source)) {
      const up = videoFileOf(prompt, inputs.source, depth + 1)
      if (up) return up
    }
    return typeof inputs.file === 'string' && inputs.file !== '' ? parseInputFileRef(inputs.file) : null
  }
  return null
}

/**
 * The start pass's sources in a run (engine.ts): the file each Get video
 * components or Load video frames reads, probed as the node will read it. Null
 * where it can't be known (the file isn't there, or the build can't read it:
 * the start checks before this one say which).
 */
export function videoSourceShapeOf(o: { prompt: ApiPrompt; access: FileAccess; userId: string | null; hosted: boolean; signal?: AbortSignal }): (nodeId: string, classType: string) => Promise<FrameShape | null> {
  return async (nodeId, classType) => {
    const n = o.prompt[nodeId]
    if (!n) return null
    const inputs = n.inputs ?? {}
    try {
      if (classType === 'GetVideoComponents') {
        const file = isLink(inputs.video) ? videoFileOf(o.prompt, inputs.video) : null
        if (!file || !(await o.access.exists(file))) return null
        const p = await probeVideoFile(file, o)
        const v = p.video[0]!
        const count = await pyFrameCount(p, p.path, { userId: o.userId, signal: o.signal })
        return { count, w: v.w, h: v.h, exact: false }
      }
      if (classType === 'LoadVideoFrames') {
        const file = isLink(inputs.file) ? null : parseInputFileRef(inputs.file)
        if (!file || !(await o.access.exists(file))) return null
        const p = await probeVideoFile(file, o)
        const v = p.video[0]!
        const pick = loadFramesPick({ w: v.w, h: v.h, rate: v.averageRate }, settingsOf(inputs))
        // The header's frames bound the pick (as planLoadVideoFrames' own check); none picked is Python's 64 × 64 black frame.
        const known = v.frames && v.frames > 0 ? Math.min(pick.count, Math.max(0, Math.ceil((v.frames - pick.start) / pick.stride))) : pick.count
        return known > 0 ? { count: known, w: pick.tw, h: pick.th, exact: false } : { count: 1, w: 64, h: 64, exact: false }
      }
    }
    catch { return null }
    return null
  }
}
