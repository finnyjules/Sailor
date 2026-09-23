import type { EditState, Clip, BlendMode } from '~~/shared/timeline/types'
import { interpolateClipAt } from '~~/shared/timeline/interpolate'
import { sourceFrameAt } from '~~/shared/timeline/sourceFrame'
import { resolveTransitionWindows, indexTransitionWindows, transitionModAt } from '~~/shared/timeline/transitions'
import { isIdentityFilters } from '~~/shared/timeline/filters'

// Pure draw-list derivation for the WebGL engine — the TS twin of the per-frame
// logic in comfy_extras/nodes_timeline.py::render_frame_np + _transform_and_alpha.
// Every quantization here exists to match the Python renderer's integer math;
// change them only together with the Python side (the golden gate enforces it).
//
// Known residual divergence (accepted, covered by the calibrated WebGL golden
// tolerance): PIL pastes at integer top-left corners, so odd-sized layers sit
// 0.5 px off a true center; PIL BILINEAR resampling ≠ GPU linear filtering on
// rotated/scaled edges.

const RENDERABLE_KINDS = new Set(['image', 'video', 'title', 'lower_third', 'motion', 'spacetype', 'text'])

export interface DrawEntry {
  clipId: string
  /** Fetchable source URL (the clip's `path` as provided in the state).
   *  Empty for canvas-rasterized sources (title/lower_third). */
  url: string
  /** Layer size in px after aspect-fit + scale, pre-rotation (Python dw/dh). */
  widthPx: number
  heightPx: number
  /** Layer center in canvas px (Python W//2 + round(x*W), H//2 + round(y*H)). */
  centerX: number
  centerY: number
  /** Degrees, positive = clockwise in screen coords (Python applies PIL rotate(-rotation)). */
  rotationDeg: number
  /** opacity × fade, clamped [0,1] (Python: tf.opacity * fade). */
  alpha: number
  blend: BlendMode
  /** Clip-local SOURCE frame (in_frame/speed/reverse applied — sourceFrameAt).
   *  Image layers ignore it; video/sequence sources index by it. */
  sourceFrame: number
  /** Horizontal wipe reveal for an incoming transition clip (null = none).
   *  Visible where normalized canvas x < w (left) / > 1-w (right). */
  wipe: { mode: 'left' | 'right'; w: number } | null
  /** Per-clip color adjust (null = identity). Semantics: shared/timeline/filters.ts. */
  filters: import('~~/shared/timeline/types').ClipFilters | null
}

/** Python round(): banker's rounding (half-to-even). The Python renderer uses
 *  it at every quantization site; Math.round (half-up) drifts by 1px on exact
 *  .5 inputs (e.g. fitting 1080×1920 into 640×360 → 202.5). */
function pyRound(v: number): number {
  const floor = Math.floor(v)
  const diff = v - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

export function hexToRgb(hex: string): [number, number, number] {
  let h = (hex ?? '').trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map(c => c + c).join('')
  if (!/^[0-9a-f]{6}$/i.test(h)) return [0, 0, 0]
  const v = parseInt(h, 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

/** Mirror of render_frame_np's fade math (nodes_timeline.py — fade_in: local/fi
 *  while local < fi; fade_out: (length-local)/fo while local > length-fo). */
function fadeAt(localF: number, length: number, fadeIn: number, fadeOut: number): number {
  let fade = 1
  if (fadeIn > 0 && localF < fadeIn) fade *= localF / fadeIn
  if (fadeOut > 0 && localF > length - fadeOut) fade *= (length - localF) / fadeOut
  return Math.max(0, Math.min(1, fade))
}

/** Mirror of _transform_and_alpha's aspect-fit + scale quantization. */
function fittedSize(srcW: number, srcH: number, W: number, H: number, scale: number): [number, number] {
  const cAspect = W / H
  const sAspect = srcW / srcH
  let fitW: number, fitH: number
  if (sAspect > cAspect) {
    fitW = W
    fitH = Math.max(1, pyRound(W / sAspect))
  } else {
    fitH = H
    fitW = Math.max(1, pyRound(H * sAspect))
  }
  const s = Math.max(0.01, scale)
  if (s === 1) return [fitW, fitH]
  return [Math.max(1, pyRound(fitW * s)), Math.max(1, pyRound(fitH * s))]
}

/**
 * Visible image layers at `frame`, in paint order (track order, clip order
 * within track — later entries on top), with all scalar math resolved.
 * `srcDims` maps clip id → natural source pixel size (known after load()).
 * Clips outside RENDERABLE_KINDS or without registered dims are skipped.
 */
export function buildDrawList(
  state: EditState,
  frame: number,
  srcDims: Map<string, { w: number; h: number }>,
): DrawEntry[] {
  const W = Math.max(1, Math.trunc(state.canvas.width))
  const H = Math.max(1, Math.trunc(state.canvas.height))
  const out: DrawEntry[] = []
  const drawAfterOf = new Map<string, string>()
  const transitionIdx = indexTransitionWindows(resolveTransitionWindows(state))

  for (const track of state.tracks) {
    if (track.muted || track.kind === 'audio') continue // Audio TRACKS skipped wholesale (Python skips audio CLIPS; an image clip hand-edited onto an audio track would render there — unreachable via the editor, divergence accepted).
    for (const clip of track.clips as Clip[]) {
      if (!RENDERABLE_KINDS.has(clip.kind)) continue // M3: media + animated text + plain text
      const url = 'path' in clip ? clip.path ?? '' : ''   // canvas-rasterized sources have no URL
      const dims = srcDims.get(clip.id)
      if (!dims) continue

      const length = Math.max(1, clip.length)
      const start = clip.start_frame
      const naturallyVisible = frame >= start && frame < start + length
      const mod = transitionModAt(transitionIdx, clip, frame, naturallyVisible)
      if (!mod.visible) continue
      const localF = mod.localFrame

      const tf = interpolateClipAt(clip, localF)
      const fade = fadeAt(localF, length, clip.fade_in ?? 0, clip.fade_out ?? 0)
      const [dw, dh] = fittedSize(dims.w, dims.h, W, H, tf.scale)

      const entry: DrawEntry = {
        clipId: clip.id,
        url,
        widthPx: dw,
        heightPx: dh,
        centerX: Math.floor(W / 2) + pyRound(tf.x * W),
        centerY: Math.floor(H / 2) + pyRound((tf.y + mod.dy) * H),
        rotationDeg: tf.rotation,
        alpha: Math.max(0, Math.min(1, tf.opacity * fade * mod.alphaMul)),
        blend: clip.blend ?? 'normal',
        sourceFrame: sourceFrameAt(clip, localF),
        wipe: mod.wipe,
        filters: isIdentityFilters(clip.filters) ? null : clip.filters!,
      }
      if (mod.drawAfter) drawAfterOf.set(clip.id, mod.drawAfter)
      out.push(entry)
    }
  }
  // Incoming transition clips must paint AFTER their outgoing partner,
  // regardless of clip array order: move each incoming entry to just after
  // its partner when it currently precedes it.
  for (const [clipId, partnerId] of drawAfterOf) {
    const i = out.findIndex(e => e.clipId === clipId)
    const p = out.findIndex(e => e.clipId === partnerId)
    if (i >= 0 && p >= 0 && i < p) {
      const [entry] = out.splice(i, 1)
      out.splice(p, 0, entry!) // p shifted left by the removal → lands just after partner
    }
  }
  return out
}
