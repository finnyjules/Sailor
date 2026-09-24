import { buildEmbedHtml, externalRefs } from './bundle'
import { bundleNamesFor, loadEmbedSurface } from './surfaces'
import { nestedRegistrationJs, setNestedSurfaceLoader } from './nested'
import type { EmbedSnapshot, EmbedSurface } from './contract'

// The poster bake runs the Frame adapter INSIDE the app, where no exported file has filed its
// nested players under __SAILOR_NESTED__ — so the Frame's live layers resolve from the app
// registry instead. Every Space Type bundle name maps to the one app-side Space Type surface
// (it carries every effect); every other bundle name is its surface kind.
setNestedSurfaceLoader(name => loadEmbedSurface(name.startsWith('spacetype-') ? 'spacetype' : name))

export interface ExportEmbedOptions {
  kind: string
  config: unknown
  duration: number
  width: number
  height: number
  transparent?: boolean
  /** Loop position the still frame is baked from. */
  posterT01?: number
  /** 'box' hands the adapter the page's whole box; it frames the piece itself. */
  framing?: 'contain' | 'box'
  /** How the fallback poster image fits its box. */
  posterFit?: 'contain' | 'cover'
  /** Nothing moves: render one frame, never start the clock. */
  still?: boolean
  /** A #hex colour behind the stage when not transparent. */
  backdrop?: string
  /** Whether the fallback poster keeps an alpha channel (a lossless PNG) or is a JPEG. Default:
   *  whenever the surface can render alpha (`caps.alpha`). A surface that only has alpha when
   *  the export is transparent — the pre-rendered `frames` player, whose frames are opaque
   *  otherwise — passes `transparent` here, so an opaque export gets the smaller JPEG. Never
   *  turns alpha on for a surface without it. */
  posterAlpha?: boolean
}

/**
 * Bakes the poster using the EMBED adapter rather than the studio's own bake
 * path, so the fallback frame is guaranteed to match what the embed renders.
 */
async function bakePoster(
  surface: EmbedSurface, config: unknown, width: number, height: number, t01: number,
  alpha: boolean,
): Promise<string> {
  const box = document.createElement('div')
  box.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px;height:${height}px`
  document.body.appendChild(box)
  try {
    const handle = await surface.mount(box, config)
    // Own try/finally, nested inside the box-removal one: destroy() is the only
    // caller of renderer.dispose() → loseContext(). If setSize/setTime throws (a
    // shader compile/runtime error), or the canvas lookup or toDataURL below
    // throws, a bare `handle.destroy()` after those lines would be skipped and
    // the WebGL context would leak — Chrome caps live contexts around 16, so a
    // few failed export retries would start breaking unrelated live previews
    // (e.g. Shader Studio's own) with no error pointing back at this function.
    try {
      handle.setSize(width, height)
      handle.setTime(t01)
      const canvas = box.querySelector('canvas') as HTMLCanvasElement | null
      if (!canvas) throw new Error('embed: adapter produced no canvas')
      // The poster is a fallback still, not a master — a lossless full-res PNG
      // of a photographic frame is routinely 4MB of base64 in a file the user
      // has to load over the wire. JPEG only where the surface has declared it
      // does not render alpha; PNG is the only correct choice when it does,
      // since JPEG would composite the transparent area as black.
      return alpha
        ? canvas.toDataURL('image/png')
        : canvas.toDataURL('image/jpeg', 0.85)
    } finally {
      handle.destroy()
    }
  } finally {
    box.remove()
  }
}

export async function exportEmbedHtml(opts: ExportEmbedOptions): Promise<string> {
  const surface = await loadEmbedSurface(opts.kind)
  if (!surface) throw new Error(`embed: unknown surface kind "${opts.kind}"`)

  const transparent = !!opts.transparent && surface.caps.alpha

  // bundleNamesFor derives which built files this export needs — one for most kinds (the
  // identity mapping, or e.g. 'spacetype-ball' for a Space Type piece using the 'ball' effect —
  // see surfaces.ts's doc), and for a Frame with live wired layers, each nested studio player
  // first and the Frame's own bundle last. Deliberately the only surface-specific fact in this
  // function; everything else here is generic across every embeddable kind.
  const bundles = bundleNamesFor(opts.kind, opts.config)

  // Fetched BEFORE the poster bake, deliberately. A missing bundle is a build
  // problem, not a render problem: failing here costs milliseconds, whereas
  // failing after the bake means the user waits out a full-resolution GL render
  // only to be told to run a build script.
  const sources = await Promise.all(bundles.map(async (bundle) => {
    const res = await fetch(`/embed/${bundle}.js`)
    if (!res.ok) {
      throw new Error(`embed: /embed/${bundle}.js missing — run \`npm run build:embed\``)
    }
    return res.text()
  }))
  // One inline script: each nested bundle (an IIFE that assigns __SAILOR_SURFACE__) followed by
  // the JS that files it under its name and clears the global, then the main bundle, whose
  // assignment is the one the runtime mounts. buildEmbedHtml's "</script" check runs on the
  // whole joined string.
  const last = sources.length - 1
  const adapterJs = sources.map((js, i) => (i < last ? js + nestedRegistrationJs(bundles[i]!) : js)).join('')

  const posterDataUrl = await bakePoster(
    surface, opts.config, opts.width, opts.height, opts.posterT01 ?? 0,
    surface.caps.alpha && (opts.posterAlpha ?? true),
  )

  const snapshot: EmbedSnapshot = {
    kind: opts.kind,
    config: opts.config,
    duration: opts.duration,
    width: opts.width,
    height: opts.height,
    posterDataUrl,
    transparent,
  }
  if (opts.framing !== undefined) snapshot.framing = opts.framing
  if (opts.posterFit !== undefined) snapshot.posterFit = opts.posterFit
  if (opts.still !== undefined) snapshot.still = opts.still
  if (opts.backdrop !== undefined) snapshot.backdrop = opts.backdrop

  const html = buildEmbedHtml(snapshot, adapterJs)

  // The self-containment guarantee has to hold for real user configs, not just
  // for the test fixture. externalRefs was previously only ever called from
  // tests, so an asset URL that made it into a config — or a future adapter
  // that reached the network — would have shipped unnoticed. It is a string
  // scan over a string we already have; run it on every export.
  const refs = externalRefs(html)
  if (refs.length) {
    throw new Error(
      `embed: export would reach the network — ${refs.slice(0, 3).join(', ')}` +
        (refs.length > 3 ? ` (+${refs.length - 3} more)` : ''),
    )
  }
  return html
}

export function downloadEmbed(filename: string, html: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
