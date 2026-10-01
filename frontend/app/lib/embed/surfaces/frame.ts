/**
 * The Frame as an embeddable surface. Ships the editor's own painter (paintLayerStack) unchanged;
 * everything it would fetch comes from the snapshot through the asset resolver chain
 * (~/lib/compositor/assetScope), which is registered for the life of the handle — so it also
 * covers the poster bake, which runs this adapter inside the app.
 *
 * Mount does every await: fonts, shaders and their textures, depth maps, images, clip frames and
 * the transitions' shaders. setTime is one synchronous paint. A font or shader that fails REJECTS
 * the mount — the runtime then keeps the poster, which is a correct still, never a wrong picture.
 *
 * Fit and bleed without touching the painter: the Frame is painted into an ARTBOARD-SIZED
 * offscreen canvas — its background, then its layers at the origin — so every effect that reads
 * the canvas behind a layer (backdrop shader, glass and displacement lenses, background blur, long
 * shadow) sees exactly the canvas the editor gives it, wherever Fit puts the Frame (R11). The
 * offscreen's own bounds crop the layers at the artboard edge, as the editor does (R7). The
 * visible canvas gets the background across the whole box (the bleed), the offscreen blitted at
 * the Frame's whole-pixel position, then the doc-level post chain over everything, so it covers
 * the bleed as well.
 *
 * A wired slot's picture is a still, a pre-rendered clip, or — `live` — a studio's own embed
 * player nested in this one (../nested.ts): mounted off-document here, timed and sized from the
 * paint, its canvas handed to the painter through the same provider.
 */
import type { EmbedHandle, EmbedSurface } from '../contract'
import { assetKey, type FrameSnapshot, type FrameVariant } from '../frame/types'
import { fitRect } from '../frame/fit'
import { clipFrameKey, type ImageClip } from '~/lib/compositor/clip'
import { fontFaceId, fontFaceRule } from '../fontFace'
import { registerAssetResolver } from '~/lib/compositor/assetScope'
import { addShaderFxEffects } from '~/lib/shaderfx/catalogStore'
import { whenFieldEffectReady } from '~/lib/shaderfill/field'
import { seedDepthImage } from '~/lib/compositor/depthRegistry'
import { ensureRevealShadersReady } from '~/lib/motionx/reveal/paintPixels'
import { warmPaperBoolean, isPaperWarm } from '~/lib/compositor/booleanGeometry'
import { warmCompositorFont } from '~/lib/compositor/textOutline'
import { layersNeedPaper } from '../frame/needs'
import {
  paintLayerStack, ensureLayerImages, withWiredContent, type LocalLayer, type StackItem,
} from '~/composables/useCompositorLayers'
import { applyStackPost, chainActive } from '~/lib/compositor/postEffects'
import '~/lib/motion/paint' // registers the per-layer animation painter paintLayerStack relies on
import { slotPhase01 } from '~/lib/compositor/masterClock'
import { readFrameLighting, visibleLights } from '~/lib/frame/lighting/settings'
import { lightingAvailable } from '~/lib/frame/lighting/lightingPass'
import { bleedAmbientAlpha } from '../frame/bleed'
import { resolveNestedSurface, nestedDeviceSize } from '../nested'
import { wiredSourceLongSide, type WiredDrawLayer } from '../frame/wiredDraw'

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image()
    im.onload = () => res(im)
    im.onerror = () => rej(new Error('embed: an inlined image failed to decode'))
    im.src = src
  })
}

/**
 * Which of a wired clip's frames shows at Frame time `tSec`: the clip loops on its OWN duration
 * inside the Frame's loop (the editor's `slotPhase01`), frame `i` covering `[i, i + 1) / count` of
 * it. The epsilon keeps a time computed as exactly a frame's start (0.1 × 3) from rounding down
 * into the frame before.
 */
export function wiredClipFrameAt(entry: { frames: ArrayLike<unknown>; duration: number }, tSec: number): number {
  const count = entry.frames.length
  const d = entry.duration
  if (!(count > 0) || !(d > 0) || !Number.isFinite(tSec)) return 0
  const t = ((tSec % d) + d) % d
  return Math.min(count - 1, Math.floor((t / d) * count + 1e-6))
}

/** The stack the painter draws, in the Frame's saved order. Only `l:` keys exist in a migrated
 *  Frame; the planner refuses a snapshot holding a legacy `w:` key. */
export function stackItemsFor(v: FrameVariant): StackItem[] {
  const byId = new Map(v.layers.map(l => [l.id, l]))
  const out: StackItem[] = []
  for (const key of v.stackOrder) {
    if (!key.startsWith('l:')) continue
    const layer = byId.get(key.slice(2))
    if (layer) out.push({ type: 'local', key, layer })
  }
  return out
}

/**
 * The longest side, in Frame (artboard) pixels, the SOURCE of each slot is drawn at by any wired
 * layer on it — the painter's box and cover crop (../frame/wiredDraw.ts, shared with the planner),
 * with the source's own size from `srcFor` (a live entry's width × height).
 */
export function wiredLongSides(v: FrameVariant, srcFor: (slot: number) => { w: number; h: number } | undefined = () => undefined): Map<number, number> {
  const out = new Map<number, number>()
  for (const l of v.layers) {
    if (l.kind !== 'wired') continue
    const wl = l as LocalLayer & { slot: number } & WiredDrawLayer
    const src = srcFor(wl.slot)
    const long = wiredSourceLongSide(wl, v.width, src?.w, src?.h)
    out.set(wl.slot, Math.max(out.get(wl.slot) ?? 0, long))
  }
  return out
}

/** A live wired slot: a studio's own embed player, mounted in a detached container. */
interface LiveSlot {
  handle: EmbedHandle
  canvas: HTMLCanvasElement
  duration: number
  srcW: number
  srcH: number
  /** The drawn long side in Frame pixels (wiredLongSides); times the fit scale → device px. */
  longPx: number
  /** The size last handed to the nested player's setSize — resized only when this changes. */
  size: { w: number; h: number } | null
}

/** True when an image layer or a clip frame the painter will ask for has no inlined copy. */
function missingInlinedAsset(v: FrameVariant, urls: Record<string, string>): boolean {
  for (const l of v.layers) {
    if (l.kind !== 'image') continue
    // A stand-in that names a file is checked too: the gatherer always stores its key (the file,
    // or an undecodable `data:,` when the file was not there — R12).
    const img = l as LocalLayer & { filename?: string; clip?: ImageClip }
    if (img.filename && !(assetKey('image', img.filename) in urls)) return true
    const clip = img.clip
    if (clip && clip.frames > 0) {
      for (let i = 0; i < clip.frames; i++) if (!(assetKey('clipFrame', clipFrameKey(clip, i)) in urls)) return true
    }
  }
  return false
}

/** The most device pixels one canvas may hold. Safari refuses a canvas past ~16.7 M pixels
 *  (4096 × 4096) — silently: it stays blank. A big Fill box on a HiDPI screen can ask for more. */
export const MAX_CANVAS_PX = 16_000_000

/**
 * The device size to give the visible canvas for a requested one: the request itself, or — when
 * it, or the artboard-sized offscreen it implies (under Fill the Frame can be larger than the box),
 * would pass MAX_CANVAS_PX — the same shape scaled down until both fit. The canvas is stretched
 * back to its box by CSS, so the page shows the Frame softer, never blank.
 */
export function capDeviceSize(w: number, h: number, art: { w: number; h: number }, fit: FrameSnapshot['fit']): { w: number; h: number } {
  const bw = Math.max(1, Math.round(w)), bh = Math.max(1, Math.round(h))
  const r = fitRect({ w: bw, h: bh }, art, fit)
  const area = Math.max(bw * bh, r.w * r.h)
  if (area <= MAX_CANVAS_PX) return { w: bw, h: bh }
  const k = Math.sqrt(MAX_CANVAS_PX / area)
  return { w: Math.max(1, Math.floor(bw * k)), h: Math.max(1, Math.floor(bh * k)) }
}

const frameSurface: EmbedSurface = {
  kind: 'frame',
  // Genuinely true: with no background the painter never fills, so the canvas keeps its
  // transparent pixels. The sheet only offers a transparent export when the background is empty.
  caps: { alpha: true },

  async mount(container: HTMLElement, config: unknown): Promise<EmbedHandle> {
    const snap = config as FrameSnapshot
    const v = snap.variants?.[0]
    if (!v) throw new Error('embed: frame snapshot has no variant')
    const urls = snap.assets.urls
    // Defence in depth (the gatherer already blocks such an export): an image or clip frame the
    // snapshot does not carry would make the painter fall back to its server URL — a request, and
    // a wrong picture on a page that has no server. Refuse before anything is loaded.
    if (missingInlinedAsset(v, urls)) throw new Error('embed: frame snapshot is missing an inlined asset')
    const unregister = registerAssetResolver((kind, key) => urls[assetKey(kind, key)] ?? null)
    const styles: HTMLStyleElement[] = []
    // Declared outside the try so a mount that fails after the canvas went into the container
    // (the first paint throwing) takes it out again: a rejected mount leaves nothing behind.
    let appended: HTMLCanvasElement | null = null
    // Nested players mounted so far — destroyed with the handle, and by a mount that fails later
    // (a later nested player rejecting included), so a rejected mount leaves no GL context behind.
    const nested: EmbedHandle[] = []
    // A nested player's canvas losing its WebGL context (the browser's context cap, a GPU reset)
    // would paint an empty box inside a Frame that keeps playing. The runtime watches only the
    // stage's own canvas — the Frame's 2D one — so each nested canvas is watched here, and the
    // next paint THROWS: the runtime's catch then brings back the poster, as it does for the
    // Frame's own canvas. Never a half-drawn Frame.
    let nestedLost = false
    const unlisten: (() => void)[] = []
    const cleanup = () => {
      for (const off of unlisten.splice(0)) off()
      for (const h of nested.splice(0)) {
        try { h.destroy() } catch { /* one failing destroy must not keep the rest alive */ }
      }
      unregister()
      for (const s of styles) s.remove()
    }

    try {
      // R14c (fix round 1) / R14a second half (fix round 2): a Frame that needs paper.js must
      // have it WARM before the very first paint below, or that paint samples the geometry
      // effect's cold pass-through (unclipped) frame — the F3 doc in booleanGeometry.ts's own
      // "one-frame no-op, warm in background" design is fine for the LIVE editor (the compositor
      // subscribes `renderStack` to `onPaperBooleanReady` and simply repaints once it lands), but
      // an export has no such repaint: a still Frame's runtime calls `setTime` exactly ONCE
      // (bundle.ts), and even an animated one's first tick would ship one visibly wrong frame.
      //
      // `layersNeedPaper(v.layers)` (./needs.ts), NOT `snap.needsOutlines` alone: the snapshot's
      // own flag is a PRECOMPUTED, trusted-on-faith value — if `computeNeedsOutlines` (gather.ts)
      // ever under-counted (a bug in ITS logic), `needsOutlines` would be `false`, the export
      // would already have fetched `frame-lean.js`, and gating on that same wrong flag here would
      // never even ask the question. `layersNeedPaper` re-derives the answer from the ACTUAL
      // layers this mount is about to paint, independent of whatever the gatherer decided — so a
      // wrong `needsOutlines` cannot suppress this check. (`snap.needsOutlines` is still checked
      // too, `||`, purely so a `true` flag can't somehow skip the gate if `layersNeedPaper` were
      // ever wrong in the OTHER direction — belt and suspenders, not a functional requirement
      // today since `layersNeedPaper` is a superset check of what forces `needsOutlines: true`.)
      //
      // `warmPaperBoolean` never itself rejects (its own `.catch` swallows a failed
      // `import('paper')`, logging it via `console.error` once — see paperLean.embed.ts's doc for
      // why that specific channel matters for the lean bundle) — check `isPaperWarm()` afterwards
      // and THROW if it is still cold, so a paper failure (a real network hiccup on the full
      // bundle, or `paperLean.embed.ts`'s throwing stand-in on the lean one) rejects the mount
      // instead of silently shipping the unclipped shape. bundle.ts's runtime keeps the poster —
      // a correct still — on a rejected mount, and `export.ts`'s `bakePoster` runs this SAME
      // `mount()`, so the poster inherits this fix for free.
      if (snap.needsOutlines || layersNeedPaper(v.layers)) {
        await warmPaperBoolean()
        if (!isPaperWarm()) throw new Error('embed: paper.js failed to load for a Frame that needs it')
      }

      for (const f of snap.assets.fonts) {
        const el = document.createElement('style')
        el.dataset.sailorEmbedFont = fontFaceId(f.family, f.weight)
        el.textContent = fontFaceRule(f)
        document.head.appendChild(el)
        styles.push(el)
      }
      for (const f of snap.assets.fonts) {
        const w = typeof f.weight === 'number' ? f.weight : f.weight[0]
        const faces = await document.fonts.load(`${w} 16px '${f.family.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
        if (!faces.length) throw new Error(`embed: font "${f.family}" did not load`)
      }
      await document.fonts.ready

      // Outline fonts (C1): text drawn from glyph outlines — an explicit outline, a geometry
      // effect on text, or a text layer a boolean/morph uses as its partner — reads fontkit's font
      // SYNCHRONOUSLY from the same cache `getCompositorFont` fills. The editor draws fillText on
      // the first miss and repaints when the font lands; an export has no such repaint (a still
      // paints once), so every outline font the snapshot carries is loaded before the first
      // paint. A font that fails rejects the mount — the poster stays, never the wrong picture.
      const OUTLINE_PREFIX = assetKey('outlineFont', '')
      for (const key of Object.keys(urls)) {
        if (!key.startsWith(OUTLINE_PREFIX)) continue
        if (!(await warmCompositorFont(key.slice(OUTLINE_PREFIX.length)))) throw new Error('embed: an outline font did not load')
      }

      addShaderFxEffects(snap.assets.shaders)
      const ready = await Promise.all(snap.assets.shaders.map(d => whenFieldEffectReady(d.id)))
      if (!ready.every(Boolean)) throw new Error('embed: a shader did not become ready')

      for (const d of snap.assets.depth) seedDepthImage(d.ref, await loadImage(d.dataUrl))

      const stills = new Map<number, HTMLImageElement>()
      const clips = new Map<number, { frames: HTMLImageElement[]; duration: number }>()
      const lives = new Map<number, LiveSlot>()
      const longSides = wiredLongSides(v, (slot) => {
        const e = snap.wired?.[slot]
        return e?.kind === 'live' ? { w: e.width, h: e.height } : undefined
      })
      for (const [slot, entry] of Object.entries(snap.wired ?? {})) {
        if (entry.kind === 'clip') {
          // Every frame decodes at once (they are data URIs — no network), in order.
          const frames = await Promise.all(entry.frames.map(f => loadImage(f)))
          clips.set(Number(slot), { frames, duration: entry.duration })
        } else if (entry.kind === 'live') {
          // The studio's own player, found by bundle name (nested.ts): the exported file's
          // concatenated bundle, or the app registry during the poster bake. Mounted one at a time
          // into a container that never enters the document — only its canvas is read, as the
          // slot's picture. Its rejection rejects this mount (the runtime keeps the poster).
          const surface = await resolveNestedSurface(entry.bundle)
          if (!surface) throw new Error('embed: a live layer\'s player is missing')
          const holder = document.createElement('div')
          const handle = await surface.mount(holder, entry.config)
          nested.push(handle)
          const nestedCanvas = holder.querySelector('canvas')
          if (!nestedCanvas) throw new Error('embed: a live layer\'s player drew no canvas')
          const onLost = (e: Event) => { e.preventDefault(); nestedLost = true }
          nestedCanvas.addEventListener('webglcontextlost', onLost)
          unlisten.push(() => nestedCanvas.removeEventListener('webglcontextlost', onLost))
          lives.set(Number(slot), {
            handle, canvas: nestedCanvas, duration: entry.duration, srcW: entry.width, srcH: entry.height,
            longPx: longSides.get(Number(slot)) ?? 0, size: null,
          })
        } else stills.set(Number(slot), await loadImage(entry.dataUrl))
      }

      const layers = v.layers as LocalLayer[]
      // Light layers: the art is lit (ambient darkened by Darkness); the bleed outside it is the
      // background alone, so it gets the same ambient darkening or the artboard edge shows. Light
      // glow does not reach into the bleed (stage 1). 0 ⇒ nothing to do.
      const bleedDark = (() => {
        if (!visibleLights(layers).length) return 0
        const lighting = readFrameLighting({ sailor_localLighting: v.lighting })
        return lighting.backgroundLit && lightingAvailable() ? bleedAmbientAlpha(lighting.darkness) : 0
      })()
      await ensureLayerImages(layers, { keep: true })
      if (!(await ensureRevealShadersReady(v.motion?.behaviours))) throw new Error('embed: a transition shader did not become ready')

      const canvas = document.createElement('canvas')
      canvas.style.display = 'block'
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      const artSize = { w: v.width, h: v.height }
      const sizeTo = (w: number, h: number) => {
        const d = capDeviceSize(w, h, artSize, snap.fit)
        canvas.width = d.w
        canvas.height = d.h
      }
      sizeTo(v.width, v.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('embed: no 2D context')

      const items = stackItemsFor(v)
      // The Frame time (seconds) of the paint in progress: a wired clip's frame is picked from it,
      // so every read inside one paint (box sizing and drawing) gets the same picture.
      let paintSec = 0
      const clipFrame = (slot: number) => {
        const c = clips.get(slot)
        return c ? c.frames[wiredClipFrameAt(c, paintSec)] ?? null : null
      }
      const liveCanvas = (slot: number) => lives.get(slot)?.canvas ?? null
      const provider = (slot: number) => stills.get(slot) ?? clipFrame(slot) ?? liveCanvas(slot)
      let lastT = 0

      // The artboard-sized canvas the Frame is painted into (R11). One per handle, resized only
      // when the Frame's device size changes.
      const art = document.createElement('canvas')
      const artCtx = art.getContext('2d')
      if (!artCtx) throw new Error('embed: no 2D context')

      /** The background alone (a paintLayerStack call with no layers) across the UNION of the box
       *  and the Frame's rect, in device pixels [ux0, ux1] × [uy0, uy1], drawn on a canvas whose
       *  own origin sits at (ox, oy) in those coordinates. Both canvases paint it with this same
       *  geometry, so they meet without a seam. Under Fit the union is the box (the bleed, as
       *  before); under Fill it is the artboard — the offscreen's margins outside the box are
       *  never shown but ARE read by backdrop effects near the box edge, so they must hold the
       *  background the editor has there, not transparency. */
      const paintBackground = (g: CanvasRenderingContext2D, s: number, tSec: number,
        u: { x0: number; y0: number; x1: number; y1: number }, ox: number, oy: number) => {
        g.setTransform(s, 0, 0, s, u.x0 - ox, u.y0 - oy)
        paintLayerStack(g, (u.x1 - u.x0) / s, (u.y1 - u.y0) / s, [], [],
          undefined, tSec, undefined, undefined, v.background!, undefined, undefined, true)
      }

      // Every paint is a bake (`bake = true`: shader fields at full resolution, no editor
      // affordances such as the displacement map's ghost), the live loop included. Measured (I6,
      // the 'vector' harness Frame, GPU work included): 8.6 ms a frame at 1000×500 and 10.8 ms at
      // 2000×1000 — inside a 60 fps budget; the editor's live-field clamp would save ~4 ms but
      // soften any field over 512 px and, through the same flag, draw the displacement ghost.
      // The canvas cap above bounds the worst case instead.
      const paint = (t01: number) => {
        if (nestedLost) throw new Error('embed: a live layer lost its drawing context')
        lastT = t01
        const tSec = t01 * snap.duration
        paintSec = tSec
        const r = fitRect({ w: canvas.width, h: canvas.height }, { w: v.width, h: v.height }, snap.fit)
        const s = r.scale
        // 0. Live slots: each nested player draws the moment this paint shows, right before the
        //    painter reads its canvas in this same task (a WebGL canvas is a valid source then).
        //    Sized to the slot's drawn box in device px — only when that size changes (the Frame
        //    handle's setSize, a new fit), never per frame.
        for (const live of lives.values()) {
          const d = nestedDeviceSize(live.longPx * s, live.srcW, live.srcH)
          if (!live.size || live.size.w !== d.w || live.size.h !== d.h) {
            live.handle.setSize(d.w, d.h)
            live.size = d
          }
          live.handle.setTime(slotPhase01(tSec, live.duration))
        }
        // Whole device pixels, so the blit below never resamples the Frame.
        const rx = Math.round(r.x), ry = Math.round(r.y)
        const aw = Math.max(1, Math.round(r.w)), ah = Math.max(1, Math.round(r.h))
        if (art.width !== aw) art.width = aw
        if (art.height !== ah) art.height = ah
        const u = {
          x0: Math.min(0, rx), y0: Math.min(0, ry),
          x1: Math.max(canvas.width, rx + aw), y1: Math.max(canvas.height, ry + ah),
        }

        // 1. The Frame on its own canvas, at the origin — what the editor paints. The background
        //    goes under the layers (backdrop-reading effects read it), positioned as it is on the
        //    visible canvas so the two meet without a seam; the canvas's bounds crop the layers.
        artCtx.setTransform(1, 0, 0, 1, 0, 0)
        artCtx.clearRect(0, 0, aw, ah)
        if (v.background != null) paintBackground(artCtx, s, tSec, u, rx, ry)
        artCtx.setTransform(s, 0, 0, s, 0, 0)
        withWiredContent(provider, () => paintLayerStack(artCtx, v.width, v.height, items, layers,
          undefined, tSec, v.motion ?? undefined, v.wiredTreatments, undefined, v.groups, undefined, true, v.light, v.lighting))

        // 2. The visible canvas: the background across the whole box (the bleed), then the Frame.
        //    Its rect is cleared first so a background with any transparency is not laid twice.
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        if (v.background != null) {
          paintBackground(ctx, s, tSec, u, 0, 0)
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          if (bleedDark > 0) {
            ctx.fillStyle = `rgba(0,0,0,${bleedDark})`
            ctx.fillRect(0, 0, canvas.width, canvas.height)
          }
          ctx.clearRect(rx, ry, aw, ah)
        }
        ctx.drawImage(art, rx, ry)

        // 3. The doc-level post chain over the whole box: it must cover the bleed as well, or an
        //    Invert or a Duotone would leave a seam at the artboard edge. The painter would run this
        //    same call last (paintLayerStack's final step) under the Frame's transform — the same
        //    `scale` (t.a = s) — so when the box is the artboard, the pixels are the painter's own.
        ctx.setTransform(s, 0, 0, s, rx, ry)
        if (v.post && chainActive(v.post)) applyStackPost(ctx, v.post, v.width)
      }

      container.appendChild(canvas)
      appended = canvas
      paint(0)

      return {
        setTime: paint,
        setSize(w: number, h: number) {
          sizeTo(w, h)
          paint(lastT)
        },
        destroy() { canvas.remove(); cleanup() },
      }
    } catch (err) {
      appended?.remove()
      cleanup()
      throw err
    }
  },
}

export default frameSurface
