/**
 * Embed-build stand-in for ~/lib/compositor/textOutline, used ONLY for the `frame-lean` build
 * (aliased in vite.embed.config.ts, gated on SAILOR_EMBED_SURFACE === 'frame-lean').
 *
 * `frame-lean.js` is built when the gatherer determined a Frame's snapshot needs no outline text
 * (FrameSnapshot.needsOutlines === false — see gather.ts's computeNeedsOutlines and
 * bundleNameFor('frame', snap) in surfaces.ts). The real textOutline.ts is the ONE path that
 * reaches fontkit (via ~/lib/vectortype/font.ts's `loadVectorFont`) — by far the frame bundle's
 * largest dependency after paper.js (Task 6's report: ~232KB + a ~91KB brotli/WOFF2 decoder). This
 * stand-in never imports font.ts, so nothing here can pull fontkit into the lean bundle.
 *
 * Safe by construction, not just by convention: `getCompositorFont` is called only from
 * `collectTextOutline` (useCompositorLayers.ts), which the painter reaches two ways — the text
 * branch, gated on `textDrawsFromOutlines(layer)`, and the sibling resolver, which outlines a text
 * layer a boolean/morph effect names as its partner (`outlinePathData` → `textLayerOutline`) even
 * when that text itself draws with fillText. plan.ts sets a font's `outline` flag for BOTH
 * (`textNeedsOutline(l) || geometryPartnerIds(layers).has(l.id)`), and any boolean/morph forces
 * the full bundle anyway (`layersNeedPaper`). A snapshot with `needsOutlines: false` therefore has
 * no layer the painter would outline, so in the FULL bundle too `getCompositorFont`/
 * `runToCommands` are never invoked for it — every text layer draws with `ctx.fillText`. This
 * stand-in's always-null/always-empty answers are therefore not an approximation: they reproduce
 * the real module's observable behaviour for exactly the snapshots that select `frame-lean.js`.
 *
 * `compositorFontToken` still needs to exist and keep its real signature — gather.ts imports it
 * unconditionally and calls it while walking `plan.fonts`, gated per-font on that font's own
 * `outline` flag (dead code for a lean snapshot: by construction no font there carries
 * `outline: true`) — but the module must still export the name for Rollup to link against.
 */
import type {
  CompositorFontLayerLike, CompositorRunStyle, CompositorTextRun, VtFont as RealVtFont,
} from '~/lib/compositor/textOutline'

export type VtFont = RealVtFont

export function compositorFontToken(_layer: CompositorFontLayerLike): string | null {
  return null
}

// R14a: a one-time (not per-call — a redraw can call this every frame) diagnostic. `getCompositorFont`
// should be provably unreachable for any snapshot that selected the lean bundle (see the module doc
// above) — this warning existing at all means that proof failed somewhere: a `needsOutlines` gate
// regression, or a caller reaching this function through a path this module's doc did not account
// for. Always on (not gated behind `import.meta.dev`, unlike booleanGeometry.ts's own dev-only
// warm-failure log) — this needs to surface in the actual built bundle a real export runs, not just
// in a local dev server.
let warnedOnce = false
export function getCompositorFont(_layer: CompositorFontLayerLike): VtFont | null {
  if (!warnedOnce) {
    warnedOnce = true
    console.warn(
      '[sailor-embed] frame-lean.js: getCompositorFont was called, but this bundle ships no font outline '
      + 'engine — a Frame that needed outline text was exported with the lean bundle (a needsOutlines gate '
      + 'regression). Text drew as fillText instead of its glyph outlines.',
    )
  }
  return null
}

export function runToCommands(
  _font: VtFont,
  _run: CompositorTextRun,
  _style: CompositorRunStyle,
  _axes?: Record<string, number>,
): unknown[] {
  return []
}

/** The lean bundle has no outline engine, so it can never warm one: false, which makes the
 *  adapter's mount reject (the poster stays) — loud, never a silent fillText. The adapter only
 *  asks for the snapshot's `outlineFont|…` keys, and a snapshot that selected this bundle
 *  (`needsOutlines: false`) carries none, so reaching this is a gate regression. */
export async function warmCompositorFont(_token: string): Promise<boolean> {
  console.error('[sailor-embed] frame-lean.js: an outline font was requested, but this bundle ships no font outline engine (a needsOutlines gate regression).')
  return false
}

/** onCompositorFontReady has no caller in the frame embed cone (it wires a Compositor redraw the
 *  live editor needs, not an export), but is exported for shape-parity with the real module in
 *  case that ever changes — a no-op subscription that never fires. */
export function onCompositorFontReady(_cb: () => void): () => void {
  return () => {}
}
