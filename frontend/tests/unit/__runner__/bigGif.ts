/**
 * R11.9c fix round 5: a GIF whose header says a large animation while its file
 * stays small: frame 0 covers the whole canvas in one colour (LZW, a few KB),
 * every later frame is one pixel (each frame composited to the canvas's size,
 * as libvips and Pillow hand them on). For start-of-run checks that read the
 * header alone (frames × size), without encoding hundreds of megapixels.
 */

/** GIF's variable-width LZW of `pixels` (indices below 1 << minCode), in 255-byte sub-blocks. */
function lzw(minCode: number, pixels: Uint8Array | number[]): Uint8Array {
  const clear = 1 << minCode
  const eoi = clear + 1
  const out: number[] = []
  let acc = 0
  let bits = 0
  let width = minCode + 1
  const emit = (code: number) => {
    acc |= code << bits
    bits += width
    while (bits >= 8) { out.push(acc & 0xFF); acc >>>= 8; bits -= 8 }
  }
  const base = 1 << minCode
  let dict = new Int32Array(4096 * base).fill(-1)
  let next = eoi + 1
  emit(clear)
  let prefix = pixels[0]!
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i]!
    const at = prefix * base + k
    if (dict[at]! >= 0) { prefix = dict[at]!; continue }
    emit(prefix)
    if (next === 4096) {
      emit(clear)
      dict = new Int32Array(4096 * base).fill(-1)
      next = eoi + 1
      width = minCode + 1
    }
    else {
      if (next >= (1 << width)) width++
      dict[at] = next++
    }
    prefix = k
  }
  emit(prefix)
  emit(eoi)
  if (bits > 0) out.push(acc & 0xFF)
  const blocks: number[] = [minCode]
  for (let i = 0; i < out.length; i += 255) {
    const part = out.slice(i, i + 255)
    blocks.push(part.length, ...part)
  }
  blocks.push(0)
  return Uint8Array.from(blocks)
}

/** A `frames`-frame GIF of a `w` × `h` canvas (see the header): opaque, no transparent colour. */
export function bigGif(w: number, h: number, frames: number): Uint8Array {
  const parts: number[] = []
  const u16 = (n: number) => [n & 0xFF, (n >> 8) & 0xFF]
  parts.push(...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], ...u16(w), ...u16(h), 0xF1, 0, 0)
  // Global colour table, 4 colours.
  parts.push(200, 40, 40, 40, 200, 40, 40, 40, 200, 255, 255, 255)
  // NETSCAPE2.0 loop.
  parts.push(0x21, 0xFF, 11, ...Array.from('NETSCAPE2.0', c => c.charCodeAt(0)), 3, 1, 0, 0, 0)
  const frame = (x: number, y: number, fw: number, fh: number, colour: number) => {
    // Graphic Control Extension: dispose none (1), no transparency.
    parts.push(0x21, 0xF9, 4, 0x04, 4, 0, 0, 0)
    parts.push(0x2C, ...u16(x), ...u16(y), ...u16(fw), ...u16(fh), 0)
    const px = new Uint8Array(fw * fh).fill(colour)
    for (const b of lzw(2, px)) parts.push(b)
  }
  frame(0, 0, w, h, 0)
  for (let f = 1; f < frames; f++) frame(f % w, 0, 1, 1, 1 + (f % 3))
  parts.push(0x3B)
  return Uint8Array.from(parts)
}
