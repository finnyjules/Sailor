import type { TextSpec } from '~~/shared/timeline/types'

// Plain text clips, drawn in the browser the way the server's
// render_text_to_pil (comfy_extras/nodes_text.py) draws them: an opaque
// full-canvas card in bg_color, greedy word wrap inside a W×padding / H×padding
// inset, lines spaced by the "Ag" glyph height × line_spacing, block aligned
// top / middle / bottom and each line left / center / right. Fonts differ a
// little (Python uses system Helvetica/Arial TrueType), so this matches layout,
// not pixels.

export const PLAIN_TEXT_FONT_STACK = '"Helvetica Neue", Helvetica, Arial, sans-serif'

export interface PlainTextLayout {
  font: string
  color: string
  bg: string
  lineHeight: number
  lines: { text: string; x: number; y: number }[]
}

export function wrapPlainText(text: string, maxW: number, measure: (s: string) => number): string[] {
  let raw = text.split(/\r\n|\r|\n/)
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop()   // Python splitlines() drops a trailing break
  if (!text) raw = ['']
  const lines: string[] = []
  for (const rawLine of raw) {
    let cur = ''
    for (const w of rawLine.split(' ')) {
      const trial = cur + (cur ? ' ' : '') + w
      if (measure(trial) <= maxW || !cur) cur = trial
      else { lines.push(cur); cur = w }
    }
    lines.push(cur)
  }
  return lines
}

export function layoutPlainText(
  spec: Partial<TextSpec>, W: number, H: number, measure: (s: string) => number, glyphHeight: number,
): PlainTextLayout {
  const fontSize = Math.trunc(spec.font_size ?? 72)
  const padding = spec.padding ?? 0.06
  const lineSpacing = spec.line_spacing ?? 1.2
  const insetX = Math.trunc(W * padding)
  const insetY = Math.trunc(H * padding)
  const lines = wrapPlainText(spec.text ?? '', W - 2 * insetX, measure)
  const lineHeight = glyphHeight * lineSpacing
  const blockH = Math.max(1, lineHeight * lines.length)
  const vAlign = spec.v_align ?? 'middle'
  let y = vAlign === 'top' ? insetY : vAlign === 'bottom' ? H - insetY - blockH : (H - blockH) / 2
  const align = spec.align ?? 'center'
  const out: PlainTextLayout['lines'] = []
  for (const text of lines) {
    const tw = measure(text)
    const x = align === 'center' ? (W - tw) / 2 : align === 'right' ? W - insetX - tw : insetX
    out.push({ text, x, y })
    y += lineHeight
  }
  return {
    font: `${fontSize}px ${PLAIN_TEXT_FONT_STACK}`,
    color: spec.color ?? '#ffffff',
    bg: spec.bg_color ?? '#000000',
    lineHeight,
    lines: out,
  }
}

export function drawPlainTextClip(ctx: CanvasRenderingContext2D, spec: Partial<TextSpec>, W: number, H: number): void {
  ctx.save()
  ctx.font = `${Math.trunc(spec.font_size ?? 72)}px ${PLAIN_TEXT_FONT_STACK}`
  const ag = ctx.measureText('Ag')
  const glyphHeight = ag.actualBoundingBoxAscent + ag.actualBoundingBoxDescent
  const layout = layoutPlainText(spec, W, H, s => ctx.measureText(s).width, glyphHeight)
  ctx.fillStyle = layout.bg
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = layout.color
  ctx.textBaseline = 'top'
  for (const l of layout.lines) ctx.fillText(l.text, l.x, l.y)
  ctx.restore()
}
