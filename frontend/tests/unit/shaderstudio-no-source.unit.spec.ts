// @vitest-environment happy-dom
// The Shader studio with no source image (fix: "i saw a take, selected it, but then nothing
// appears"). A take that reads its input was judged and thumbnailed over the neutral sample
// picture; the studio now renders it over that same picture instead of nothing.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { noSourceBase, noSourceMode, SAMPLE_PICTURE_HINT } from '~/lib/shaderstudio/noSource'
import { placeholderSource } from '~/lib/shadergen/productRequest'

const reads = { generative: false }
const gen = { generative: true }

describe('noSourceMode', () => {
  it('an effect that reads its input renders over the sample picture', () => {
    expect(noSourceMode([reads])).toBe('sample')
  })
  it('a generative effect renders on its own', () => {
    expect(noSourceMode([gen])).toBe('generative')
  })
  it('a stack with any input-reading layer needs the sample picture', () => {
    expect(noSourceMode([gen, reads])).toBe('sample')
  })
  it('no effect: nothing to render yet', () => {
    expect(noSourceMode([])).toBe('none')
    expect(noSourceMode([null, undefined])).toBe('none')
  })
})

describe('noSourceBase', () => {
  const generativeBase = document.createElement('canvas')
  it('the sample picture is the very one takes were judged on (placeholderSource), not a second one', () => {
    expect(noSourceBase('sample', generativeBase)).toBe(placeholderSource())
  })
  it('generative keeps its own neutral base', () => {
    expect(noSourceBase('generative', generativeBase)).toBe(generativeBase)
  })
})

describe('hint copy', () => {
  it('is one quiet sentence-case line', () => {
    expect(SAMPLE_PICTURE_HINT).toBe('Shown over a sample picture. Upload an image to see it on yours.')
  })
})

// Source-level on purpose: the surface is thousands of lines of WebGL (see studio-surfaces-prompt).
describe('Shader studio surface with no source', () => {
  const s = readFileSync(resolve(__dirname, '../../app/components/vue-canvas/ShaderStudioSurface.vue'), 'utf8')
  it('no guard still refuses an input-reading effect for lack of a source', () => {
    expect(s).not.toMatch(/!resolved(\.value)? && !isGenerative/)
  })
  it('the preview, outputs and embed all draw over the no-source base', () => {
    expect(s).not.toMatch(/: GENERATIVE_BASE\b/)
    expect((s.match(/noSourceBase\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
  it('shows the quiet hint while the sample stands in, and the old prompt only when there is no effect', () => {
    expect(s).toMatch(/v-if="showsSample"[^>]*>\{\{ SAMPLE_PICTURE_HINT \}\}/)
    expect(s).toMatch(/v-if="needsSource"[^>]*>Add a source image to begin/)
  })
})
