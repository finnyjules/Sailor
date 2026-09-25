// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { carriesImage, imageFileFrom, REFERENCE_ONLY_REQUEST } from '~/lib/prompt/referencePicture'

const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
const txt = new File([new Uint8Array([1])], 'a.txt', { type: 'text/plain' })
const dt = (files: File[], types: string[] = files.length ? ['Files'] : []) => ({
  types, files, items: files.map(f => ({ kind: 'file', type: f.type, getAsFile: () => f })),
}) as unknown as DataTransfer

describe('reference picture helpers', () => {
  it('the request for a picture with no words', () => {
    expect(REFERENCE_ONLY_REQUEST).toBe('Match the look of the reference picture')
  })
  it('finds the first image file; none for text or other files', () => {
    expect(imageFileFrom(dt([txt, png]))).toBe(png)
    expect(imageFileFrom(dt([txt]))).toBeNull()
    expect(imageFileFrom(dt([], ['text/plain']))).toBeNull()
    expect(imageFileFrom(null)).toBeNull()
  })
  it('a copied image that also carries markup is still an image', () => {
    expect(imageFileFrom(dt([png], ['text/html', 'Files']))).toBe(png)
  })
  it('a drag carries an image when one of its files is one', () => {
    expect(carriesImage(dt([png]))).toBe(true)
    expect(carriesImage(dt([txt]))).toBe(false)
    expect(carriesImage(dt([], ['text/plain']))).toBe(false)
  })
})
