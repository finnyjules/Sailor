/**
 * Ascii's glyph atlas (step 3, R2.6): the Ascii node draws its characters
 * with PIL text rendering (nodes_glsl_stylize.py `_ascii_bitmaps`), which
 * the runner can't reproduce, so the fixture script renders every (cell
 * 4–64, character) once with the node's own function and ships it as
 * ./asciiGlyphs.bin (scripts/runner_effects_fixtures.py --group cells, with
 * DejaVu Sans Mono: controller ruling (d)). The characters are those of
 * #shared/runner/asciiGlyphSet.generated.ts; a ramp with any other character
 * is left to the engine by eligibility ('ascii-glyphs').
 *
 * The file is gzip of 'SAG1', a u32 LE index length, the index (JSON: its
 * characters, cell range, font sha256, Pillow and FreeType versions), then
 * per cell and per character its cell × cell uint8 bitmap. It is read once,
 * lazily, on the main thread; each node gets one atlas for its cell and
 * ramp (the worker is handed only that).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { asciiRampOf } from '#shared/runner/effects'
import type { AsciiAtlas } from './core/cells'

export const ASCII_GLYPHS_MISSING = 'The runner’s character pictures for this effect are missing'
export const ASCII_CHARACTER_UNKNOWN = 'A character in this effect’s text can’t be drawn here'

export interface AsciiGlyphIndex {
  characters: string
  cell_min: number
  cell_max: number
  font: string
  font_sha256: string
  pillow: string
  freetype: string
}

interface Loaded { index: AsciiGlyphIndex; chars: string[]; data: Uint8Array; offsets: Map<number, number> }

let loaded: Loaded | null = null

/** Where the atlas is: beside this module (dev, tests), or under the server's folder from the working directory. */
function atlasFile(): string | null {
  const candidates = [
    process.env.SAILOR_ASCII_GLYPHS || null,
    (() => { try { return fileURLToPath(new URL('./asciiGlyphs.bin', import.meta.url)) } catch { return null } })(),
    join(process.cwd(), 'server', 'runner', 'effects', 'asciiGlyphs.bin'),
    join(process.cwd(), 'frontend', 'server', 'runner', 'effects', 'asciiGlyphs.bin'),
  ].filter((c): c is string => !!c)
  return candidates.find(c => existsSync(c)) ?? null
}

/** The atlas's index and bitmaps (read once). */
export function asciiGlyphs(): Loaded {
  if (loaded) return loaded
  const file = atlasFile()
  if (!file) throw new Error(ASCII_GLYPHS_MISSING)
  const raw = new Uint8Array(gunzipSync(readFileSync(file)))
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  if (raw.length < 8 || String.fromCharCode(...raw.subarray(0, 4)) !== 'SAG1') throw new Error(ASCII_GLYPHS_MISSING)
  const len = v.getUint32(4, true)
  const index = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + len))) as AsciiGlyphIndex
  const chars = [...index.characters]
  const data = raw.subarray(8 + len)
  const offsets = new Map<number, number>()
  let off = 0
  for (let cell = index.cell_min; cell <= index.cell_max; cell++) {
    offsets.set(cell, off)
    off += chars.length * cell * cell
  }
  if (off !== data.length) throw new Error(ASCII_GLYPHS_MISSING)
  loaded = { index, chars, data, offsets }
  return loaded
}

/** One character's cell × cell bitmap (a view into the atlas), or null when the atlas hasn't it. */
export function asciiGlyph(cell: number, ch: string): Uint8Array | null {
  const a = asciiGlyphs()
  const at = a.offsets.get(cell)
  const i = a.chars.indexOf(ch)
  if (at === undefined || i < 0) return null
  return a.data.subarray(at + i * cell * cell, at + (i + 1) * cell * cell)
}

/** The atlas one node needs: its cell's bitmaps for its ramp's distinct characters, and the ramp as glyph numbers. */
export function asciiAtlasFor(cell: number, ramp: readonly string[]): AsciiAtlas {
  const distinct: string[] = []
  const at = new Map<string, number>()
  const out = new Int32Array(ramp.length)
  ramp.forEach((ch, i) => {
    let j = at.get(ch)
    if (j === undefined) { j = distinct.length; distinct.push(ch); at.set(ch, j) }
    out[i] = j
  })
  const glyphs = new Uint8Array(distinct.length * cell * cell)
  distinct.forEach((ch, j) => {
    const g = asciiGlyph(cell, ch)
    if (!g) throw new Error(ASCII_CHARACTER_UNKNOWN)
    glyphs.set(g, j * cell * cell)
  })
  return { cell, glyphs, ramp: out }
}

/** Ascii's widgets as its core takes them: its atlas for (max(4, cell_size), the ramp the node uses). */
export function asciiPrepare(w: Record<string, unknown>): Record<string, unknown> {
  const ramp = asciiRampOf(w.preset, w.characters)
  if (!ramp) throw new Error(ASCII_CHARACTER_UNKNOWN)
  return { ...w, atlas: asciiAtlasFor(Math.max(4, Math.trunc(w.cell_size as number)), ramp) }
}
