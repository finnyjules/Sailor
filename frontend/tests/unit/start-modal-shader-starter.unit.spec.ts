// @vitest-environment happy-dom
// The Shader starter preset: the start tile and the new Shader node both start from
// starterShaderConfig(), so it must hold exactly one real, image-based, animated
// catalog effect. The catalog is read from shader_effects/manifest.json on disk —
// the same file the backend serves as /sailor/shader_effects — so no network.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { starterShaderConfig } from '../../app/lib/startModal/shaderStill'
import { hydrateConfig } from '../../app/lib/shaderstudio/types'
import { migrateShaderConfig } from '../../app/lib/shaderstudio/migrate'
import { resolveEffectId } from '../../app/lib/shaderfx/catalog'
import { effectWantsClock } from '../../app/lib/shaderstudio/clock'

const ROOT = resolve(__dirname, '../../../shader_effects')
const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'))
const effects: any[] = Array.isArray(manifest) ? manifest : manifest.effects

describe('starterShaderConfig', () => {
  it('holds exactly one enabled effect whose id resolves in the catalog', () => {
    const cfg = starterShaderConfig()
    expect(cfg.effects).toHaveLength(1)
    const layer = cfg.effects[0]!
    expect(layer.enabled).toBe(true)
    const def = effects.find(e => e.id === resolveEffectId(layer.id))
    expect(def, layer.id).toBeTruthy()
    expect(existsSync(resolve(ROOT, `${def.id}.frag`))).toBe(true)
  })

  it('works on the picture (not generative) and animates at its defaults', () => {
    const layer = starterShaderConfig().effects[0]!
    const def = effects.find(e => e.id === resolveEffectId(layer.id))
    expect(def.generative).toBe(false)
    expect(effectWantsClock(def, layer.params)).toBe(true)
  })

  it('is a valid saved config: survives the node load path unchanged', () => {
    const cfg = starterShaderConfig()
    const saved = JSON.parse(JSON.stringify(cfg))
    expect(hydrateConfig(migrateShaderConfig(saved))).toEqual(cfg)
  })

  it('returns a fresh object each call (the node owns its copy)', () => {
    expect(starterShaderConfig()).not.toBe(starterShaderConfig())
  })
})
