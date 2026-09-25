// frontend/tests/unit/shaderstudio-take-lock.unit.spec.ts
// The Shader studio's layer lock while an effect-take set is open (stage 5 Task 9).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { takeLayerLocked, takeOutputsLocked, takeStackLocked } from '~/lib/shaderstudio/takeLock'

describe('Shader studio take lock', () => {
  it('locks the layer the open set previews on, and only that one', () => {
    expect(takeLayerLocked({ setOpen: true, activeLayerId: 'L1', takeLayerId: 'L1' })).toBe(true)
    expect(takeLayerLocked({ setOpen: true, activeLayerId: 'L2', takeLayerId: 'L1' })).toBe(false)
  })
  it('is derived from the session: a closed set never leaves it locked, whatever id is left behind', () => {
    expect(takeLayerLocked({ setOpen: false, activeLayerId: 'L1', takeLayerId: 'L1' })).toBe(false)
    expect(takeLayerLocked({ setOpen: true, activeLayerId: 'L1', takeLayerId: null })).toBe(false)
    expect(takeLayerLocked({ setOpen: true, activeLayerId: undefined, takeLayerId: null })).toBe(false)
  })
  it('the stack holds still while any set is open', () => {
    expect(takeStackLocked({ setOpen: true })).toBe(true)
    expect(takeStackLocked({ setOpen: false })).toBe(false)
  })
  it('exports and outputs wait while any set is open (a previewed take is never delivered)', () => {
    expect(takeOutputsLocked({ setOpen: true })).toBe(true)
    expect(takeOutputsLocked({ setOpen: false })).toBe(false)
  })
})

// Source-level on purpose: the surface is thousands of lines of WebGL (see studio-surfaces-prompt).
describe('Shader studio footer while a set is open (stage 5 final fix #3)', () => {
  const s = readFileSync(fileURLToPath(new URL('../../app/components/vue-canvas/ShaderStudioSurface.vue', import.meta.url)), 'utf8')
  it('every download and canvas output is disabled by the derived lock, and refuses when called', () => {
    expect(s).toMatch(/const outputsLocked = computed\(\(\) => takeOutputsLocked\(\{ setOpen: effectSetOpen\.value \}\)\)/)
    for (const label of ['Download PNG', 'Download video', 'Export embed', 'As image', 'As video'])
      expect(s).toMatch(new RegExp(`\\{ label: '${label}'[^}]*disabled: outputsLocked`))
    for (const fn of ['generateImage', 'generateVideo', 'downloadPng', 'downloadVideoFile', 'exportWebEmbed'])
      expect(s).toMatch(new RegExp(`async function ${fn}\\(\\) \\{\\s*if \\(outputsLocked\\.value\\) return`))
  })
  it('closing ends an open set before saving, so edits made meanwhile are saved, not skipped as a preview', () => {
    expect(s).toMatch(/function closeEditor\(\) \{ shellRef\.value\?\.prompt\.endEffects\(\); try \{ saveConfig\(\)/)
  })
})
