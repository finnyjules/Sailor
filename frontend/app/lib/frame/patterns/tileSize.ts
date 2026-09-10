/** The largest integer box with the frame's aspect that fits inside maxW × maxH. */
export function tileSize(frameW: number, frameH: number, maxW: number, maxH: number): { w: number; h: number } {
  if (!(frameW > 0) || !(frameH > 0)) return { w: 1, h: 1 }
  const s = Math.min(maxW / frameW, maxH / frameH)
  return { w: Math.max(1, Math.round(frameW * s)), h: Math.max(1, Math.round(frameH * s)) }
}
