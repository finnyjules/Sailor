/**
 * What a Frame needs in order to play on its own, and what the export sheet will say about it.
 * Pure: no fetching, no DOM. The gatherer (gather.ts) turns this plan into a snapshot.
 *
 * The walk that lists assets is the walk that writes the notices, so the sheet cannot disagree
 * with the file.
 */
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { collectFillImageSrcs, textDrawsFromOutlines, transformCase } from '~/composables/useCompositorLayers'
import { effectStackOf, isGeometryKind } from '~/lib/compositor/effectStack'
import { depthSourceFromViewUrl, type DepthRef } from '~/lib/compositor/depthRegistry'
import { revealEffectIdsFor } from '~/lib/motionx/reveal/params'
import { resolveEffectId } from '~/lib/shaderfx/catalogStore'
import { clipPlayedSeconds, type ImageClip } from '~/lib/compositor/clip'
import { deriveMasterClock } from '~/lib/compositor/masterClock'
import type { FrameFit, FrameNotice, FrameVariant } from './types'
import { wiredSourceLongSide, type WiredDrawLayer } from './wiredDraw'

/** The longest side a wired slot's pre-rendered pictures are made at — the live player's own
 *  ceiling (nested.ts). An extreme cover crop (a very wide source in a tall box) would otherwise
 *  ask for frames far past what a canvas or a WebP can hold. */
export const MAX_WIRED_PX = 4096

/** `fps`/`duration`: the slot's live frame source's clock, when it has one. An animated slot
 *  with both plays as pre-rendered frames; one without stays a still. */
export interface WiredSlotInfo { slot: number; layerId: string; label: string; animated: boolean; fps?: number; duration?: number }
export interface FrameExportInput {
  variant: FrameVariant
  fit: FrameFit
  wiredSlots: WiredSlotInfo[]
  /** Every effect id in the loaded shader catalog. */
  catalogIds: ReadonlySet<string>
  /** The modal's own `hasMotion` (local animation, animated slot, motion bands or behaviours). */
  hasMotion: boolean
  /** The Frame's OWN motion — what the Motion tab animates (local animation, bands,
   *  behaviours) — without animated slots, which say for themselves that they play. Gates the
   *  "Everything you animated in the Motion tab" line. Absent: `hasMotion`. */
  ownMotion?: boolean
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
  /** Animated wired slots, baked at export into `round(duration × fps)` frames. */
  wiredClips: { slot: number; maxPx: number; fps: number; duration: number; label: string; layerId: string }[]
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

/** The ids of every layer a geometry effect (boolean, morph) names as its partner. The painter
 *  outlines a partner itself — `buildSiblingResolver` → `computedOutlineD` → the text's glyph
 *  outline — even when that text draws with fillText, so a text partner needs its outline font
 *  in the file too. Visibility is ignored, as `layersNeedPaper` ignores it (R14f): a stored
 *  `visible: false` is not a promise that no frame shows the effect. */
export function geometryPartnerIds(layers: readonly LocalLayer[]): Set<string> {
  const out = new Set<string>()
  for (const l of layers) {
    for (const e of effectStackOf(l as any)) {
      if (!isGeometryKind(e.type)) continue
      const ref = (e as { refLayerId?: unknown }).refLayerId
      if (typeof ref === 'string' && ref.startsWith('l:')) out.add(ref.slice(2))
    }
  }
  return out
}

/** Every layer the painter outlines on another's behalf: the geometry-effect partners above
 *  PLUS both ends of every Motion "Morph into" transition (the behaviour's own layer and its
 *  `params.target`) — `resolveMorphs` outlines both, and a text end without its outline font
 *  falls back to a cross-fade. The ONE statement of that set: `planFrameExport` (per-font
 *  `outline`) and gather.ts's `computeNeedsOutlines` (which bundle) both read it. Muted
 *  behaviours count too, for the same reason `visible` is ignored above. */
export function outlinePartnerIds(
  layers: readonly LocalLayer[],
  behaviours?: ReadonlyArray<{ kind?: unknown; layerId?: unknown; params?: Record<string, unknown> }> | null,
): Set<string> {
  const out = geometryPartnerIds(layers)
  for (const b of behaviours ?? []) {
    if (b?.kind !== 'morph') continue
    if (typeof b.layerId === 'string' && b.layerId) out.add(b.layerId)
    const target = b.params?.target
    if (typeof target === 'string' && target.startsWith('l:')) out.add(target.slice(2))
  }
  return out
}

/** The characters the font subset must hold for a text layer: the text as stored AND as the
 *  painter draws it (`transformCase` — "café" in uppercase draws "CAFÉ"). */
export function subsetTextOf(t: { text?: string; textTransform?: string }): string {
  const raw = t.text ?? ''
  if (!t.textTransform) return raw
  const drawn = transformCase(raw, t.textTransform as Parameters<typeof transformCase>[1])
  return drawn === raw ? raw : raw + drawn
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

/** The export's loop, in seconds (spec, "Time"): the Frame's own motion duration when it has
 *  motion; otherwise the nested loops' master clock — the editor's own `deriveMasterClock` over
 *  the image clips' played lengths (one clip: its length; several: the length they all complete
 *  whole cycles in, capped as the editor caps it). 4 s only when neither exists (a moving shader
 *  fill with no timeline of its own). A wired clip is one of those nested loops, on its source's
 *  own clock — as the editor's `liveMasterClock` counts it. */
function loopSeconds(v: FrameVariant, clips: FramePlan['clips'], wiredClips: FramePlan['wiredClips']): number {
  if (v.motion && v.motion.duration > 0) return v.motion.duration
  const clock = deriveMasterClock([
    ...clips.map(c => ({ duration: clipPlayedSeconds(c.clip), fps: c.clip.fps })),
    ...wiredClips.map(c => ({ duration: c.duration, fps: c.fps })),
  ])
  return clock && clock.duration > 0 ? clock.duration : 4
}

function dividesEvenly(loop: number, part: number): boolean {
  const r = loop / part
  return Math.abs(r - Math.round(r)) < 1e-3
}

/** "3s", "2.5s", "0.83s". */
function seconds(n: number): string {
  return `${Number(n.toFixed(2))}s`
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
  const wiredClips: FramePlan['wiredClips'] = []
  const fontMap = new Map<string, FramePlan['fonts'][number]>()

  const addFont = (family: string | undefined, weight: number, text: string, outline: boolean) => {
    const fam = family?.trim()
    if (!fam) return
    const key = `${fam}|${weight}`
    const hit = fontMap.get(key)
    if (hit) { hit.text += text; hit.outline ||= outline }
    else fontMap.set(key, { family: fam, weight, text, outline })
  }

  const partners = outlinePartnerIds(layers, v.motion?.behaviours)
  for (const l of layers) {
    if (l.kind === 'image') {
      const img = l as LocalLayer & { filename: string; standIn?: boolean; clip?: ImageClip; w: number; h: number }
      const maxPx = Math.ceil(2 * drawnLongSide(img, v.width))
      if (img.filename) images.push(img.standIn ? { filename: img.filename, maxPx, optional: true } : { filename: img.filename, maxPx })
      if (img.clip && img.clip.frames > 0) clips.push({ clip: img.clip, maxPx, layerId: l.id })
    }
    if (l.kind === 'text') {
      const t = l as LocalLayer & { text: string; fontFamily: string; fontWeight: number; accentFace?: string; textTransform?: string }
      const weight = Number(t.fontWeight) || 400
      const outline = textNeedsOutline(l) || partners.has(l.id)
      const text = subsetTextOf(t)
      addFont(t.fontFamily, weight, text, outline)
      if (t.accentFace) addFont(t.accentFace, weight, text, outline)
    }
    if (l.kind === 'wired') {
      const wl = l as LocalLayer & { slot: number } & WiredDrawLayer
      // 2× the size the painter draws the SOURCE at (its box and cover crop — wiredDraw.ts, the
      // rule the live player shares), not the layer's box: a 16:9 source cover-cropped into a
      // portrait box is drawn far wider than the box. `lastAspect` is the content's aspect here
      // (the host keeps it so for every layer that is not unlinked). Capped at MAX_WIRED_PX.
      const maxPx = Math.min(MAX_WIRED_PX, Math.ceil(2 * wiredSourceLongSide(wl, v.width)))
      const info = input.wiredSlots.find(s => s.layerId === l.id)
      const fps = Number(info?.fps), duration = Number(info?.duration)
      if (info?.animated && fps > 0 && duration > 0) {
        // Baked from the slot's live frame source. A cloned wired layer shows one picture per slot
        // per moment in the editor, so one clip per slot is what every copy draws.
        const same = wiredClips.find(c => c.slot === wl.slot)
        if (same) same.maxPx = Math.max(same.maxPx, maxPx)
        else wiredClips.push({ slot: wl.slot, maxPx, fps, duration, label: info.label, layerId: l.id })
        // No notice here: the gatherer says it once, with the frame count and what it adds
        // ("{label} · pre-rendered · {n} frames · adds {size}").
      } else {
        wiredStills.push({ slot: wl.slot, maxPx })
        if (info?.animated) notices.push({ group: 'still', text: `${info.label} · shown as a still in this version`, layerId: l.id })
      }
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

  const still = !input.hasMotion && !input.animatedFill && clips.length === 0 && wiredClips.length === 0
  if (input.ownMotion ?? input.hasMotion) notices.push({ group: 'live', text: 'Everything you animated in the Motion tab' })
  if (input.animatedFill) notices.push({ group: 'live', text: 'Moving shader fills and paint' })
  const duration = still ? 1 : loopSeconds(v, clips, wiredClips)
  // A clip whose played length does not divide the Frame's loop jumps at the wrap. Said in the
  // sheet (spec, "Time"), not hidden behind an elapsed-time counter that would break scrubbing.
  if (!still) {
    for (const c of clips) {
      const played = clipPlayedSeconds(c.clip)
      if (played <= 0 || dividesEvenly(duration, played)) continue
      const l = layers.find(x => x.id === c.layerId)
      const named = (l as { name?: unknown } | undefined)?.name
      const label = typeof named === 'string' && named.trim() ? named.trim() : 'Image clip'
      notices.push({
        group: 'live', layerId: c.layerId,
        text: `${label} loops every ${seconds(played)}, the Frame every ${seconds(duration)} — it restarts at the seam`,
      })
    }
    for (const c of wiredClips) {
      if (dividesEvenly(duration, c.duration)) continue
      notices.push({
        group: 'live', layerId: c.layerId,
        text: `${c.label} loops every ${seconds(c.duration)}, the Frame every ${seconds(duration)} — it restarts at the seam`,
      })
    }
  }

  return {
    fit, duration, still, images, clips,
    fillImages: collectFillImageSrcs(layers),
    fonts: [...fontMap.values()],
    shaderIds: [...shaderIds],
    depth, wiredStills, wiredClips, notices,
  }
}
