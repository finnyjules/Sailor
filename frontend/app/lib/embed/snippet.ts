/** The iframe a designer pastes into their site to show an exported file. The aspect ratio is
 *  the export's own, so the box keeps the Frame's shape at any width. `title` defaults to the
 *  Frame wording; a 3D scene passes its own so the embed doesn't call itself a "frame". */
export function embedSnippet(filename: string, width: number, height: number, title = 'Sailor frame'): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const src = esc(filename)
  const t = esc(title)
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  return `<iframe src="${src}" title="${t}" loading="lazy" `
    + `style="width:100%;aspect-ratio:${w} / ${h};border:0;display:block"></iframe>`
}
