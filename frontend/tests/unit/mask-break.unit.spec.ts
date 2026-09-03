import { describe, it, expect } from 'vitest'
import { paintMaskRelease, maskBreakFromEdge, type MaskBreak } from '../../app/lib/compositor/maskBreak'

class RecCtx {
  ops: string[] = []
  save() { this.ops.push('save') }
  restore() { this.ops.push('restore') }
  beginPath() { this.ops.push('beginPath') }
  moveTo(x: number, y: number) { this.ops.push(`moveTo ${x} ${y}`) }
  lineTo(x: number, y: number) { this.ops.push(`lineTo ${x} ${y}`) }
  closePath() { this.ops.push('closePath') }
  clip() { this.ops.push('clip') }
  fillRect(x: number, y: number, w: number, h: number) { this.ops.push(`fillRect ${x} ${y} ${w} ${h}`) }
  fillStyle = ''
  globalCompositeOperation = 'source-over'
}

const ctx = () => new RecCtx() as unknown as CanvasRenderingContext2D & { ops: string[] }

describe('paintMaskRelease', () => {
  it('is a no-op when there is no break', () => {
    const c = ctx() as any
    paintMaskRelease(c, null, 1000, 800)
    expect(c.ops).toEqual([])
  })
  it('clips to a half-plane and fills opaque white', () => {
    const c = ctx() as any
    paintMaskRelease(c, { x: 0.5, y: 0.4, angle: 0 }, 1000, 800)
    expect(c.ops[0]).toBe('save')
    expect(c.ops).toContain('clip')
    expect(c.ops).toContain('fillRect 0 0 1000 800' /* covers full canvas; the clip limits it */)
    expect(c.ops[c.ops.length - 1]).toBe('restore')
    expect(c.fillStyle).toBe('#ffffff')
    expect(c.globalCompositeOperation).toBe('source-over')
  })
  it('angle 0 releases the top: the clip polygon lies above the line y=0.4*H=320', () => {
    const c = ctx() as any
    paintMaskRelease(c, { x: 0.5, y: 0.4, angle: 0 }, 1000, 800)
    const ys = c.ops.filter((o: string) => o.startsWith('lineTo') || o.startsWith('moveTo')).map((o: string) => Number(o.split(' ')[2]))
    // every polygon vertex is on or above the line (y <= 320), extended past the top edge
    expect(Math.max(...ys)).toBeLessThanOrEqual(320.0001)
    expect(Math.min(...ys)).toBeLessThan(0) // extended past the canvas top so no seam
  })
})

describe('maskBreakFromEdge', () => {
  const box = { x: 0.5, y: 0.5, w: 0.4, h: 0.6 } // centre .5,.5; spans y 0.2..0.8
  it('top places a horizontal line at the shape top, offset moves it down into the shape', () => {
    const b = maskBreakFromEdge('top', box, 0) as MaskBreak
    expect(b.angle).toBe(0); expect(b.y).toBeCloseTo(0.2, 6)
    expect((maskBreakFromEdge('top', box, 0.5) as MaskBreak).y).toBeCloseTo(0.2 + 0.5 * 0.6, 6)
  })
  it('left is a vertical line at the shape left', () => {
    const b = maskBreakFromEdge('left', box, 0) as MaskBreak
    expect(b.angle).toBe(270); expect(b.x).toBeCloseTo(0.3, 6)
  })
  it('left break releases outward to the left: the clip polygon lies left of the line', () => {
    const W = 1000, H = 800
    const b = maskBreakFromEdge('left', box, 0) as MaskBreak
    const lineXpx = b.x * W // 0.3 * 1000 = 300
    const c = ctx() as any
    paintMaskRelease(c, b, W, H)
    const xs = c.ops.filter((o: string) => o.startsWith('lineTo') || o.startsWith('moveTo')).map((o: string) => Number(o.split(' ')[1]))
    // every polygon vertex is on or to the left of the line, extended past the canvas left edge
    expect(Math.max(...xs)).toBeLessThanOrEqual(lineXpx + 0.0001)
    expect(Math.min(...xs)).toBeLessThan(0)
  })
  it('right break releases outward to the right: the clip polygon lies right of the line', () => {
    const W = 1000, H = 800
    const b = maskBreakFromEdge('right', box, 0) as MaskBreak
    const lineXpx = b.x * W // 0.7 * 1000 = 700
    const c = ctx() as any
    paintMaskRelease(c, b, W, H)
    const xs = c.ops.filter((o: string) => o.startsWith('lineTo') || o.startsWith('moveTo')).map((o: string) => Number(o.split(' ')[1]))
    // every polygon vertex is on or to the right of the line, extended past the canvas right edge
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(lineXpx - 0.0001)
    expect(Math.max(...xs)).toBeGreaterThan(W)
  })
})
