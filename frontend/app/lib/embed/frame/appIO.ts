/** The app's real IO for buildFrameSnapshot. App-side only — never imported by the embed bundle. */
import { compositorFontToken } from '~/lib/compositor/textOutline'
import { parseVtFontToken, vtFontFileUrl } from '~/lib/vectortype/fontToken'
import { VARIABLE_FONTS_BY_ID } from '~/data/variable-fonts'
import { depthImageFor } from '~/lib/compositor/depthRegistry'
import type { UploadedFontEntry } from '~/composables/useUploadedFonts'
import type { EffectDef } from '~/lib/shaderfx/types'
import { StudioExportFailed, type StudioFrameSource } from '~/lib/studio/frameSource'
import { bufferToBase64, subsetFontBase64 } from '../fontBytes'
import type { FontSource, FrameExportIO, WiredFrames } from './gather'

export function makeFontSource(uploaded: UploadedFontEntry[]) {
  return (family: string, weight: number): FontSource | null => {
    const up = uploaded.find(f => f.family === family)
    if (up) {
      const w: '400' | '700' | null = weight >= 550
        ? (up.weights['700'] ? '700' : up.weights['400'] ? '400' : null)
        : (up.weights['400'] ? '400' : up.weights['700'] ? '700' : null)
      if (w) return { url: `/api/template-fonts/file/${encodeURIComponent(up.weights[w]!)}`, origin: 'uploaded', weight: Number(w) }
    }
    const token = compositorFontToken({ fontFamily: family, fontWeight: weight })
    if (!token) return null
    const ref = parseVtFontToken(token)
    if (!ref) return null
    const url = vtFontFileUrl(ref)
    if (!url) return null
    if (ref.kind === 'catalog') {
      const ax = VARIABLE_FONTS_BY_ID[ref.id]?.axes.find(a => a.tag === 'wght')
      return { url, origin: 'variable', weight: ax ? [ax.min, ax.max] : [100, 900] }
    }
    return { url, origin: ref.kind === 'local' ? 'library' : 'google', weight }
  }
}

function sizeOf(img: CanvasImageSource): { w: number; h: number } {
  const a = img as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number }
  return { w: a.naturalWidth || Number(a.width) || 1, h: a.naturalHeight || Number(a.height) || 1 }
}

/** Copies one pulled surface at the pull size into ONE reused canvas, so the frame's picture is
 *  exactly what it always was (the surface drawn at w×h) whatever size the source hands back.
 *  Encoded before the next pull, so nothing past the current frame is held as pixels. */
function scratchCopier(): (surface: TexImageSource, w: number, h: number) => CanvasImageSource {
  let c: HTMLCanvasElement | null = null
  return (surface, w, h) => {
    if (!c) c = document.createElement('canvas')
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
    const g = c.getContext('2d')!
    g.clearRect(0, 0, w, h)
    g.drawImage(surface as CanvasImageSource, 0, 0, w, h)
    return c
  }
}

/** One pull at a time per source: two exports in flight (a rebuild overtaking an older build)
 *  must not interleave on a source's shared canvas. */
const pulling = new WeakMap<StudioFrameSource, Promise<unknown>>()

/**
 * `count` frames of a wired slot's live source — frame `i` at `t01 = i / count`, the editor's
 * `slotPhase01` timing — each rendered at the source's aspect to fit `maxPx` on its long side,
 * and each handed to `encode` (the gatherer's WebP encode) as it arrives, so a long clip is held
 * as encoded strings, never as pixels.
 *
 * A source with `openExport` (3D) is pulled through an export session of its own at the pull
 * size — its own engine, every asset waited for — and the session is ALWAYS closed. A session
 * that names failures is not pulled at all, and a frame that finds one (`StudioExportFailed`)
 * stops the pull: either way its failures come back for the gatherer to block with. A source
 * without one is pulled through `getFrame`.
 *
 * The source's surface is only valid until its next render, so each is copied (`copy`) and
 * encoded before the next is asked for. `stale` is asked before every frame and abandons a pull
 * nobody wants any more (a newer build overtook it, or the modal closed); `copy` is injectable
 * for the unit test.
 */
export async function pullSourceFrames(
  src: StudioFrameSource | undefined, count: number, maxPx: number,
  opts: {
    encode: (frame: CanvasImageSource) => Promise<string>
    copy?: (surface: TexImageSource, w: number, h: number) => CanvasImageSource
    stale?: () => boolean
  },
): Promise<WiredFrames> {
  if (!src) throw new Error('wired slot has no live frame source')
  const source = src
  const copy = opts.copy ?? scratchCopier()
  const checkStale = () => { if (opts.stale?.()) throw new Error('wired frames: superseded') }
  const run = async (): Promise<WiredFrames> => {
    const sw = Math.max(1, source.width || 1024), sh = Math.max(1, source.height || 1024)
    const k = maxPx / Math.max(sw, sh)
    const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k))
    const frames: string[] = []
    if (source.openExport) {
      checkStale()
      const session = await source.openExport({ width: w, height: h })
      try {
        if (session.failures.length) return { frames: [], failures: session.failures }
        for (let i = 0; i < count; i++) {
          checkStale()
          frames.push(await opts.encode(copy(await session.frame(i / count), w, h)))
        }
      } catch (err) {
        // A frame whose sync started a load that failed (a decal rebuilt on that frame): named,
        // like a failure found before the first frame.
        if (err instanceof StudioExportFailed) return { frames: [], failures: err.failures }
        throw err
      } finally { session.close() }
      return { frames, failures: [] }
    }
    for (let i = 0; i < count; i++) {
      checkStale()
      frames.push(await opts.encode(copy(await source.getFrame(i / count, w, h), w, h)))
    }
    return { frames, failures: [] }
  }
  const prev = pulling.get(source) ?? Promise.resolve()
  const mine = prev.catch(() => {}).then(run)
  pulling.set(source, mine)
  try { return await mine } finally { if (pulling.get(source) === mine) pulling.delete(source) }
}

export function createAppFrameExportIO(opts: {
  uploaded: UploadedFontEntry[]
  wiredStill: (slot: number) => CanvasImageSource | null
  /** An animated wired slot's frames (usually `pullSourceFrames` over the slot's live source).
   *  Absent: no slot can play, and a planned clip blocks the export with its name. */
  wiredFrames?: FrameExportIO['wiredFrames']
  /** An animated wired slot's studio embed player (usually the slot's live source's `embed()`).
   *  Absent: no slot plays live — every animated slot takes the frames path. */
  wiredEmbed?: FrameExportIO['wiredEmbed']
  catalog: EffectDef[]
}): FrameExportIO {
  // One fetch per bundle per IO (one build): two live slots on one player measure it once.
  const bundleSizes = new Map<string, Promise<number>>()
  return {
    async fetchBlob(url) {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
      return res.blob()
    },
    blobToImage: blob => createImageBitmap(blob),
    async imageToDataUrl(img, maxPx, mime, quality) {
      const { w, h } = sizeOf(img)
      const k = Math.min(1, maxPx / Math.max(w, h))
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k))
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      return c.toDataURL(mime, quality ?? 0.9)
    },
    blobToDataUrl: blob => new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(blob)
    }),
    blobToBase64: async blob => bufferToBase64(await blob.arrayBuffer()),
    subsetFont: (b64, text) => subsetFontBase64(b64, text, '[frame] web export:'),
    fontSource: makeFontSource(opts.uploaded),
    wiredStill: opts.wiredStill,
    wiredFrames: opts.wiredFrames ?? (async () => { throw new Error('no wired frame source') }),
    depthImage: ref => depthImageFor(ref),
    shaderDefs: ids => opts.catalog.filter(d => ids.includes(d.id)),
    wiredEmbed: opts.wiredEmbed,
    // The bundle export.ts will inline (the same `/embed/{name}.js`), measured as the bytes it
    // adds to the file. A failed fetch is not kept, so it is not remembered as a size.
    bundleBytes(bundle) {
      let size = bundleSizes.get(bundle)
      if (!size) {
        size = (async () => {
          const res = await fetch(`/embed/${bundle}.js`)
          if (!res.ok) throw new Error(`/embed/${bundle}.js: HTTP ${res.status}`)
          return new Blob([await res.text()]).size
        })()
        bundleSizes.set(bundle, size)
        size.catch(() => { if (bundleSizes.get(bundle) === size) bundleSizes.delete(bundle) })
      }
      return size
    },
  }
}
