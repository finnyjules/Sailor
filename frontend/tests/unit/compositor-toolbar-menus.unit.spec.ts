import { describe, it, expect } from 'vitest'
import {
  TOOLBAR_SHAPES, TOOLBAR_AI, TOOLBAR_INSERT,
  DEFAULT_SHAPE_FACE, DEFAULT_AI_FACE, DEFAULT_INSERT_FACE,
  resolveShapeFace, shapeFaceLabel, smartSelectRowState,
  resolveAiFace, aiFaceLabel, resolveInsertFace, insertFaceLabel,
} from '~/lib/compositor/toolbarMenus'

describe('compositor toolbar menus', () => {
  it('pins the shapes menu contents and order', () => {
    expect(TOOLBAR_SHAPES.map(s => s.id)).toEqual(['rect', 'ellipse', 'line', 'polygon', 'star', 'mosaic', 'library'])
    expect(TOOLBAR_SHAPES.map(s => s.label)).toEqual(['Rectangle', 'Ellipse', 'Line', 'Polygon', 'Star', 'Mosaic', 'Shape library…'])
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

  it('pins the AI menu contents and order', () => {
    expect(TOOLBAR_AI.map(r => r.id)).toEqual(['vector', 'region', 'smart'])
    expect(TOOLBAR_AI.map(r => r.label)).toEqual(['AI vector', 'Generate in region', 'Smart select'])
  })

  // The hints ARE the old buttons' tooltips, verbatim — the spec asks for them
  // to survive the regroup, so pin the strings and not just their length.
  it('pins the AI hint strings verbatim', () => {
    expect(TOOLBAR_AI.map(r => r.hint)).toEqual([
      'Generate from text or vectorize a selected image',
      'Mark an area (box, brush, or shape) and regenerate just that part of an image',
      'Scribble over an object, AI refines the selection',
    ])
  })

  it('defaults the AI face to AI vector and keeps the last-used one', () => {
    expect(DEFAULT_AI_FACE).toBe('vector')
    expect(resolveAiFace(null)).toBe('vector')
    expect(resolveAiFace(undefined)).toBe('vector')
    expect(resolveAiFace('nope')).toBe('vector')
    expect(aiFaceLabel(null)).toBe('AI vector')
    for (const r of TOOLBAR_AI) expect(resolveAiFace(r.id)).toBe(r.id)
    expect(aiFaceLabel('region')).toBe('Generate in region')
    expect(aiFaceLabel('smart')).toBe('Smart select')
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

  it('disables the Smart select row without an image selection', () => {
    const off = smartSelectRowState(false, false)
    expect(off.disabled).toBe(true)
    expect(off.hint).toBe('Select an image layer first')

    // With an image selected, or while smart select is already running (so it
    // can be switched off from the same row), it stays live.
    expect(smartSelectRowState(true, false).disabled).toBe(false)
    expect(smartSelectRowState(false, true).disabled).toBe(false)
    expect(smartSelectRowState(true, false).hint).toBe(TOOLBAR_AI[2]!.hint)
  })
})
