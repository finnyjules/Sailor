import { describe, expect, it } from 'vitest'
import { recraftGenerateInput, recraftVectorizeInput } from '../../server/utils/recraftFalInputs'

describe('recraftGenerateInput', () => {
  it('maps the default "any" style and the default size to fal presets', () => {
    expect(recraftGenerateInput('a fox', 'any', '1024x1024')).toEqual({
      prompt: 'a fox',
      style: 'vector_illustration',
      image_size: 'square_hd',
    })
  })

  it('maps a recraft-v3-svg sub-style onto the vector_illustration family', () => {
    expect(recraftGenerateInput('a fox', 'engraving', '1024x1024')).toEqual({
      prompt: 'a fox',
      style: 'vector_illustration/engraving',
      image_size: 'square_hd',
    })
    expect(recraftGenerateInput('a fox', 'line_art', '1024x1024')).toEqual({
      prompt: 'a fox',
      style: 'vector_illustration/line_art',
      image_size: 'square_hd',
    })
    expect(recraftGenerateInput('a fox', 'linocut', '1024x1024')).toEqual({
      prompt: 'a fox',
      style: 'vector_illustration/linocut',
      image_size: 'square_hd',
    })
  })

  it('falls back to the bare vector_illustration family for a style with no fal sub-style', () => {
    expect(recraftGenerateInput('a fox', 'line_circuit', '1024x1024')).toEqual({
      prompt: 'a fox',
      style: 'vector_illustration',
      image_size: 'square_hd',
    })
  })

  it('passes an already fal-native style straight through', () => {
    expect(recraftGenerateInput('a fox', 'vector_illustration/bold_stroke', '1024x1024')).toEqual({
      prompt: 'a fox',
      style: 'vector_illustration/bold_stroke',
      image_size: 'square_hd',
    })
    expect(recraftGenerateInput('a fox', 'vector_illustration', '1024x1024')).toEqual({
      prompt: 'a fox',
      style: 'vector_illustration',
      image_size: 'square_hd',
    })
  })

  it('maps a non-square WxH size to an explicit 16-aligned box', () => {
    expect(recraftGenerateInput('a fox', 'any', '1200x800')).toEqual({
      prompt: 'a fox',
      style: 'vector_illustration',
      image_size: { width: 1200, height: 800 },
    })
  })

  it('treats an unrecognized style as "any" and a missing/garbage size as the default square', () => {
    expect(recraftGenerateInput('a fox', undefined, undefined)).toEqual({
      prompt: 'a fox',
      style: 'vector_illustration',
      image_size: 'square_hd',
    })
    expect(recraftGenerateInput('a fox', 'not-a-style', 'garbage')).toEqual({
      prompt: 'a fox',
      style: 'vector_illustration',
      image_size: 'square_hd',
    })
  })
})

describe('recraftVectorizeInput', () => {
  it('wraps the image as image_url', () => {
    expect(recraftVectorizeInput('data:image/png;base64,AAAA')).toEqual({
      image_url: 'data:image/png;base64,AAAA',
    })
    expect(recraftVectorizeInput('https://example.com/cat.png')).toEqual({
      image_url: 'https://example.com/cat.png',
    })
  })
})
