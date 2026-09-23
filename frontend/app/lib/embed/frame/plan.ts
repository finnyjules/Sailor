/**
 * What a Frame needs in order to play on its own, and what the export sheet will say about it.
 * Pure: no fetching, no DOM. The gatherer (gather.ts) turns this plan into a snapshot.
 *
 * The walk that lists assets is the walk that writes the notices, so the sheet cannot disagree
 * with the file.
 */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { collectFillImageSrcs, textDrawsFromOutlines } from '~/composables/useCompositorLayers'
import { effectStackOf } from '~/lib/compositor/effectStack'
import { depthSourceFromViewUrl, type DepthRef } from '~/lib/compositor/depthRegistry'
import { revealEffectIdsFor } from '~/lib/motionx/reveal/params'
import { resolveEffectId } from '~/lib/shaderfx/catalogStore'
import type { ImageClip } from '~/lib/compositor/clip'
import type { FrameFit, FrameNotice, FrameVariant } from './types'

export interface WiredSlotInfo { slot: number; layerId: string; label: string; animated: boolean }
export interface FrameExportInput {
  variant: FrameVariant
  fit: FrameFit
  wiredSlots: WiredSlotInfo[]
  /** Every effect id in the loaded shader catalog. */
  catalogIds: ReadonlySet<string>
  /** The modal's own `hasMotion` (local animation, animated slot, motion bands or behaviours). */
  hasMotion: boolean
  /** `hasAnimatedShaderFill(items, background)` — a live shader fill with no other motion. */
  animatedFill: boolean
}
export interface FramePlan {
  fit: FrameFit
  duration: number
  still: boolean
  /** `optional`: a stand-in ("photo goes here") that names a file. The editor draws that file
   *  when it exists and its grey box when it does not, so a file that cannot be fetched is not a
   *  reason to block the export — the gatherer stores an undecodable copy instead (R12). */
  images: { filename: string; maxPx: number; optional?: boolean }[]
  clips: { clip: ImageClip; maxPx: number; layerId: string }[]
  fillImages: string[]
  fonts: { family: string; weight: number; text: string; outline: boolean }[]
  shaderIds: string[]
  depth: { ref: DepthRef; layerId: string; label: string }[]
  wiredStills: { slot: number; maxPx: number }[]
  notices: FrameNotice[]
}

/** A name for a layer in a sentence. */
export function layerLabel(l: LocalLayer): string {
  const named = (l as { name?: unknown }).name
  if (typeof named === 'string' && named.trim()) return named.trim()
  switch (l.kind) {
    case 'wired': return 'Wired layer'
    case 'image': return 'Image'
    case 'text': return 'Text'
    default: return 'Layer'
  }
}

/** True when the painter will draw this text from glyph outlines (fontkit), not fillText. Asks
 *  the painter's own `textDrawsFromOutlines` — the one statement of that rule — rather than
 *  mirroring it: an explicit outline or a visible geometry effect, and no decoration. Text
 *  following a path is still inked with fillText. */
export function textNeedsOutline(l: LocalLayer): boolean {
  return textDrawsFromOutlines(l)
}

function drawnLongSide(l: { w?: number; h?: number }, width: number): number {
  const w = Number(l.w) || 0
  const h = Number(l.h) || 0
  return Math.max(w, h) * width
}

/** Every string anywhere inside `value` — the robust way to find shader ids, which live in fills,
 *  strokes, layer effects, deal fills, backgrounds and motion alike. A string that happens to equal
 *  an id only costs one extra effect in the file. */
function collectStrings(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 40 || value == null) return
  if (typeof value === 'string') { out.add(value); return }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out, depth + 1); return }
  if (typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out, depth + 1)
}

export function planFrameExport(input: FrameExportInput): FramePlan {
  const { variant: v, fit } = input
  const notices: FrameNotice[] = []
  const layers = v.layers

  if (v.stackOrder.some(k => k.startsWith('w:'))) {
    notices.push({ group: 'blocked', text: 'This Frame uses an older kind of wired layer. Close the Frame editor, open it again, then export.' })
  }

  const images: FramePlan['images'] = []
  const clips: FramePlan['clips'] = []
  const depth: FramePlan['depth'] = []
  const wiredStills: FramePlan['wiredStills'] = []
  const fontMap = new Map<string, FramePlan['fonts'][number]>()

  const addFont = (family: string | undefined, weight: number, text: string, outline: boolean) => {
    const fam = family?.trim()
    if (!fam) return
    const key = `${fam}|${weight}`
    const hit = fontMap.get(key)
    if (hit) { hit.text += text; hit.outline ||= outline }
    else fontMap.set(key, { family: fam, weight, text, outline })
  }

  for (const l of layers) {
    if (l.kind === 'image') {
      const img = l as LocalLayer & { filename: string; standIn?: boolean; clip?: ImageClip; w: number; h: number }
      const maxPx = Math.ceil(2 * drawnLongSide(img, v.width))
      if (img.filename) images.push(img.standIn ? { filename: img.filename, maxPx, optional: true } : { filename: img.filename, maxPx })
      if (img.clip && img.clip.frames > 0) clips.push({ clip: img.clip, maxPx, layerId: l.id })
    }
    if (l.kind === 'text') {
      const t = l as LocalLayer & { text: string; fontFamily: string; fontWeight: number; accentFace?: string }
      const weight = Number(t.fontWeight) || 400
      const outline = textNeedsOutline(l)
      addFont(t.fontFamily, weight, t.text ?? '', outline)
      if (t.accentFace) addFont(t.accentFace, weight, t.text ?? '', outline)
    }
    if (l.kind === 'wired') {
      const wl = l as LocalLayer & { slot: number; w: number; lastAspect: number }
      const w = Number(wl.w) || 0
      const aspect = Number(wl.lastAspect) || 1
      wiredStills.push({ slot: wl.slot, maxPx: Math.ceil(2 * Math.max(w, w * aspect) * v.width) })
      const info = input.wiredSlots.find(s => s.layerId === l.id)
      if (info?.animated) notices.push({ group: 'still', text: `${info.label} · shown as a still in this version`, layerId: l.id })
    }
    const hasDof = effectStackOf(l as any).some(e => e.type === 'dof' && (e as { visible?: boolean }).visible !== false)
      || (l.kind === 'wired' && !!v.wiredTreatments[`l:${l.id}`]?.dof)
    if (hasDof) {
      const ref: DepthRef | null = l.kind === 'image'
        ? (l as { filename: string }).filename
        : l.kind === 'wired' ? depthSourceFromViewUrl((l as { depthKey?: string }).depthKey) : null
      if (ref) depth.push({ ref, layerId: l.id, label: layerLabel(l) })
      else notices.push({ group: 'leftOut', text: `Depth blur on ${layerLabel(l)} · needs a depth map`, layerId: l.id })
    }
  }

  const strings = new Set<string>()
  collectStrings({ layers, background: v.background, post: v.post, motion: v.motion }, strings)
  const shaderIds = new Set<string>()
  for (const s of strings) {
    const id = resolveEffectId(s)
    if (input.catalogIds.has(id)) shaderIds.add(id)
  }
  for (const id of revealEffectIdsFor(v.motion?.behaviours)) shaderIds.add(id)

  const still = !input.hasMotion && !input.animatedFill && clips.length === 0
  if (input.hasMotion) notices.push({ group: 'live', text: 'Everything you animated in the Motion tab' })
  if (input.animatedFill) notices.push({ group: 'live', text: 'Moving shader fills' })
  const duration = still ? 1 : (v.motion && v.motion.duration > 0 ? v.motion.duration : 4)

  return {
    fit, duration, still, images, clips,
    fillImages: collectFillImageSrcs(layers),
    fonts: [...fontMap.values()],
    shaderIds: [...shaderIds],
    depth, wiredStills, notices,
  }
}
