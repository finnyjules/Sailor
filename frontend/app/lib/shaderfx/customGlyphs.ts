// The ASCII effect's "Custom" shape (`u_shape` = 14): the user types the characters the picture
// is built from. This rasterizes them into a 1-row glyph atlas (COLS glyphs at CW×CH, matching
// the shader's own consts), auto-sorted dark→bright by ink coverage — the same ramp logic as
// the baked character sets. Moved here VERBATIM from `ShaderStudioSurface.vue` (Task 15) so the
// Frame's shader path (`~/lib/shaderfill/field.ts`, on the Space Type embed's render path) can
// build the SAME atlas without that Vue file's private copy, and without `field.ts` importing
// anything DOM-heavy itself — its caller builds the atlas and hands it in as a plain value.
//
// Cached by string so the SAME canvas object is reused for the same characters: the renderer's
// extra-texture cache is keyed on the source object's IDENTITY (see `renderFieldWithBase`'s doc
// in field.ts / `extraTexCache` in `~/lib/shaderfx/renderer.ts`), so a fresh canvas per call
// would re-upload the atlas every frame and evict everything else. Bounded at 16 entries.
export const DEFAULT_CUSTOM_CHARS = ' .:-=+*#%@'

const CUSTOM_CW = 192, CUSTOM_CH = 288, CUSTOM_COLS = 10
const customAtlasCache = new Map<string, HTMLCanvasElement>()
export function buildCustomAtlas(raw: string): HTMLCanvasElement {
  const chars = raw && raw.length ? raw : DEFAULT_CUSTOM_CHARS
  const hit = customAtlasCache.get(chars)
  if (hit) return hit
  const px = Math.round(CUSTOM_CH * 0.9)
  const scored = [...new Set([...chars])].map((ch) => {
    const c = document.createElement('canvas'); c.width = CUSTOM_CW; c.height = CUSTOM_CH
    const x = c.getContext('2d')!
    x.fillStyle = '#000'; x.fillRect(0, 0, CUSTOM_CW, CUSTOM_CH)
    x.fillStyle = '#fff'; x.font = `${px}px Menlo, Monaco, "Courier New", monospace`
    x.textAlign = 'center'; x.textBaseline = 'middle'
    x.fillText(ch, CUSTOM_CW / 2, CUSTOM_CH / 2)
    const d = x.getImageData(0, 0, CUSTOM_CW, CUSTOM_CH).data
    // `d[i]` is always in-bounds (the loop's own guard) and so never actually undefined; the
    // `?? 0` is only to satisfy `noUncheckedIndexedAccess` now that this lives in a plain .ts
    // module (this project's tsconfig — a strictness this exact statement never tripped inside
    // the .vue file it moved from, whatever vue-tsc's reason for that was).
    let ink = 0; for (let i = 0; i < d.length; i += 4) ink += d[i] ?? 0
    return { ink, canvas: c }
  }).sort((a, b) => a.ink - b.ink)
  const atlas = document.createElement('canvas'); atlas.width = CUSTOM_COLS * CUSTOM_CW; atlas.height = CUSTOM_CH
  const ax = atlas.getContext('2d')!
  ax.fillStyle = '#000'; ax.fillRect(0, 0, atlas.width, atlas.height)
  for (let i = 0; i < CUSTOM_COLS; i++) {
    const idx = scored.length > 1 ? Math.round(i * (scored.length - 1) / (CUSTOM_COLS - 1)) : 0
    if (scored[idx]) ax.drawImage(scored[idx].canvas, i * CUSTOM_CW, 0)
  }
  customAtlasCache.set(chars, atlas)
  if (customAtlasCache.size > 16) customAtlasCache.delete(customAtlasCache.keys().next().value!)
  return atlas
}
