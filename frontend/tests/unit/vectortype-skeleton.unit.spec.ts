/**
 * Vector Type — STROKE-VECTOR SKELETON SPIKE, Stage-1 round-trip MEASUREMENT.
 *
 * This is a MEASUREMENT harness, not a pass/fail regression. For each fixture
 * font × glyph it extracts a medial-axis skeleton + thickness, re-inflates it,
 * and prints how far the re-inflation drifts from the drawn glyph — at grid 96
 * AND grid 192, so we can see whether the error is discretisation (shrinks with
 * the finer grid → fixable) or structural (does not → fatal). It asserts only
 * the loosest sanity floors so the harness cannot silently rot but does not
 * encode a verdict. The verdict lives in the report the charter asks for.
 *
 * See docs/superpowers/spikes/2026-09-03-stroke-vector-skeleton-spike.md
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import { textOutlines, type GlyphOutline } from '~/lib/vectortype/outline'
import { analyzeGrid } from '~/lib/vectortype/stretch'
import {
  skeletonize,
  inflateMask,
  inkMask,
  roundTripError,
  _debugField,
} from '~/lib/vectortype/skeleton'

const RES = 256
const TEXT = 'Saeogilr'
const FONTS = [
  { id: 'inter', file: 'inter-skel-spike.ttf' },
  { id: 'source-serif', file: 'source-serif-skel-spike.ttf' },
  { id: 'fraunces', file: 'fraunces-skel-spike.ttf' },
  { id: 'unbounded', file: 'unbounded-skel-spike.ttf' },
]

function loadFont(file: string, id: string): VtFont {
  const path = fileURLToPath(new URL(`../fixtures/${file}`, import.meta.url))
  const raw: any = (fontkit as any).create(new Uint8Array(readFileSync(path)))
  return { id, axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}

function glyphsFor(font: VtFont): { ch: string; glyph: GlyphOutline; upem: number }[] {
  const out = textOutlines(font, TEXT)
  const upem = out.unitsPerEm
  return out.glyphs.map((glyph, i) => ({ ch: TEXT[i]!, glyph, upem }))
}

interface Row {
  font: string
  ch: string
  m96: number
  d96: number
  m192: number
  d192: number
  strokes96: number
  junc96: number
  strokes192: number
  junc192: number
}

function measure(glyph: GlyphOutline, upem: number, grid: number) {
  const skel = skeletonize(glyph, { grid, unitsPerEm: upem })
  const inflated = inflateMask(skel, glyph.bbox, RES)
  const ink = inkMask(glyph, glyph.bbox, RES)
  const err = roundTripError(ink, inflated, RES, glyph.bbox, upem)
  return { skel, err }
}

describe('stroke-vector skeleton spike — round-trip measurement', () => {
  const rows: Row[] = []

  for (const fdef of FONTS) {
    const font = loadFont(fdef.file, fdef.id)
    const glyphs = glyphsFor(font)

    it(`${fdef.id}: every glyph produces a skeleton that re-inflates sanely`, () => {
      for (const { ch, glyph, upem } of glyphs) {
        if (!glyph.commands.length) continue // blanks
        const a = measure(glyph, upem, 96)
        const b = measure(glyph, upem, 192)
        rows.push({
          font: fdef.id,
          ch,
          m96: a.err.mismatch,
          d96: a.err.maxDevEm,
          m192: b.err.mismatch,
          d192: b.err.maxDevEm,
          strokes96: a.skel.strokes.length,
          junc96: a.skel.meta.junctionCount,
          strokes192: b.skel.strokes.length,
          junc192: b.skel.meta.junctionCount,
        })
        // Loosest sanity floors only — not a verdict.
        expect(a.skel.strokes.length, `${fdef.id} '${ch}' 96 strokes`).toBeGreaterThanOrEqual(1)
        expect(b.skel.strokes.length, `${fdef.id} '${ch}' 192 strokes`).toBeGreaterThanOrEqual(1)
        expect(a.err.mismatch, `${fdef.id} '${ch}' 96 mismatch`).toBeLessThan(0.5)
        expect(b.err.mismatch, `${fdef.id} '${ch}' 192 mismatch`).toBeLessThan(0.5)
      }
    })
  }

  it('cross-check: local field dist ≈ analyzeGrid.dist at grid 96 (Inter a)', () => {
    const font = loadFont('inter-skel-spike.ttf', 'inter')
    const a = glyphsFor(font).find(g => g.ch === 'a')!
    const local = _debugField(a.glyph, 96)
    const shipped = analyzeGrid(a.glyph.commands, a.glyph.bbox)
    let maxDiff = 0
    for (let j = 0; j < local.dist.length; j++) {
      if (!shipped.ink[j]) continue
      const d = Math.abs(local.dist[j]! - shipped.dist[j]!)
      if (d > maxDiff) maxDiff = d
    }
    // eslint-disable-next-line no-console
    console.log(`\n[cross-check] Inter 'a' grid-96 max |localDist − analyzeGrid.dist| over ink = ${maxDiff.toFixed(3)} font units (cw=${local.cw.toFixed(1)})`)
    // Same chamfer, same flatten → should be identical (allow FP slack).
    expect(maxDiff).toBeLessThan(1e-6)
  })

  it('prints the per-glyph round-trip table', () => {
    const pct = (v: number) => (v * 100).toFixed(2).padStart(6)
    const header =
      'font          ch |  mis96%  dev96% |  mis192%  dev192% | strk96 j96 strk192 j192'
    const lines = [header, '-'.repeat(header.length)]
    for (const r of rows) {
      lines.push(
        `${r.font.padEnd(13)} ${r.ch}  | ${pct(r.m96)} ${pct(r.d96)} | ${pct(r.m192)}  ${pct(r.d192)} |` +
          `  ${String(r.strokes96).padStart(4)} ${String(r.junc96).padStart(3)}  ${String(r.strokes192).padStart(4)}  ${String(r.junc192).padStart(3)}`,
      )
    }
    // Per-font 96→192 trend on maxDevEm.
    lines.push('-'.repeat(header.length))
    for (const fdef of FONTS) {
      const fr = rows.filter(r => r.font === fdef.id)
      if (!fr.length) continue
      const avg = (sel: (r: Row) => number) => fr.reduce((s, r) => s + sel(r), 0) / fr.length
      lines.push(
        `${fdef.id.padEnd(13)}    avg dev96%=${(avg(r => r.d96) * 100).toFixed(2)}  dev192%=${(avg(r => r.d192) * 100).toFixed(2)}  ` +
          `avg mis96%=${(avg(r => r.m96) * 100).toFixed(2)}  mis192%=${(avg(r => r.m192) * 100).toFixed(2)}`,
      )
    }
    // eslint-disable-next-line no-console
    console.log('\n' + lines.join('\n') + '\n')
    expect(rows.length).toBeGreaterThan(0)
  })
})
