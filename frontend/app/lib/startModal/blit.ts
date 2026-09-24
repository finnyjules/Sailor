// Draw a rendered source into a start-modal tile canvas, scaled to COVER it
// (centred, overflow cropped). Shared by every still renderer.
export function blitCover(canvas: HTMLCanvasElement, src: CanvasImageSource, sw: number, sh: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2D context on the tile canvas')
  const s = Math.max(canvas.width / Math.max(1, sw), canvas.height / Math.max(1, sh))
  const w = sw * s, h = sh * s
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(src, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h)
}
