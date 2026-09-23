/** The iframe a designer pastes into their site to show an exported file. The aspect ratio is
 *  the export's own, so the box keeps the Frame's shape at any width. */
export function embedSnippet(filename: string, width: number, height: number): string {
  const src = filename.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  return `<iframe src="${src}" title="Sailor frame" loading="lazy" `
    + `style="width:100%;aspect-ratio:${w} / ${h};border:0;display:block"></iframe>`
}
