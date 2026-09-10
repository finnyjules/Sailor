import { describe, it, expect } from 'vitest'
import {
  TOOLBAR_SHAPES, TOOLBAR_INSERT,
  DEFAULT_SHAPE_FACE, DEFAULT_INSERT_FACE,
  resolveShapeFace, shapeFaceLabel,
  resolveInsertFace, insertFaceLabel,
} from '~/lib/compositor/toolbarMenus'

describe('compositor toolbar menus', () => {
  it('pins the shapes menu contents and order', () => {
    expect(TOOLBAR_SHAPES.map(s => s.id)).toEqual(['rect', 'ellipse', 'line', 'polygon', 'star', 'mosaic', 'scatter', 'library'])
    expect(TOOLBAR_SHAPES.map(s => s.label)).toEqual(['Rectangle', 'Ellipse', 'Line', 'Polygon', 'Star', 'Mosaic', 'Scatter', 'Shape library…'])
  })

  it('defaults the face to Rectangle', () => {
    expect(DEFAULT_SHAPE_FACE).toBe('rect')
    expect(resolveShapeFace(null)).toBe('rect')
    expect(resolveShapeFace(undefined)).toBe('rect')
    expect(resolveShapeFace('nope')).toBe('rect')
    expect(shapeFaceLabel(null)).toBe('Rectangle')
  })

  it('keeps a picked shape as the face', () => {
    // library is gated on hasLibraryShape (see below); pass it here so this
    // loop still expresses "once picked, id is kept as the face" for every row.
    for (const s of TOOLBAR_SHAPES) expect(resolveShapeFace(s.id, true)).toBe(s.id)
    expect(shapeFaceLabel('star')).toBe('Star')
  })

  it('wears the library face only once a library shape is known', () => {
    expect(resolveShapeFace('library')).toBe('rect')
    expect(resolveShapeFace('library', false)).toBe('rect')
    expect(resolveShapeFace('library', true)).toBe('library')
    expect(shapeFaceLabel('library', true)).toBe('Shape library…')
    expect(shapeFaceLabel('library')).toBe('Rectangle')
  })

  it('pins the Insert menu contents and order', () => {
    expect(TOOLBAR_INSERT.map(r => r.id)).toEqual(['upload', 'canvas', 'svg'])
    expect(TOOLBAR_INSERT.map(r => r.label)).toEqual(['Upload image', 'Pick from canvas…', 'Import SVG'])
    // Only the canvas picker is a second hop; the other two act immediately.
    expect(TOOLBAR_INSERT.filter(r => r.secondHop).map(r => r.id)).toEqual(['canvas'])
  })

  it('defaults the Insert face to Upload and keeps the last-used one', () => {
    expect(DEFAULT_INSERT_FACE).toBe('upload')
    expect(resolveInsertFace(null)).toBe('upload')
    expect(resolveInsertFace(undefined)).toBe('upload')
    expect(resolveInsertFace('nope')).toBe('upload')
    expect(insertFaceLabel(null)).toBe('Upload image')
    for (const r of TOOLBAR_INSERT) expect(resolveInsertFace(r.id)).toBe(r.id)
    expect(insertFaceLabel('canvas')).toBe('Pick from canvas…')
    expect(insertFaceLabel('svg')).toBe('Import SVG')
  })
})
