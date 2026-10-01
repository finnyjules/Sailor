import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultComputeMode, localTrainingAvailable, probeEngineUp, LOCAL_NEEDS_ENGINE } from '../../app/lib/lora/trainerCompute'

const read = (f: string) => readFileSync(resolve(__dirname, '../../app/components', f), 'utf8')
const voice = read('VoiceTrainerSurface.vue')
const lora = read('LoraTrainerSurface.vue')

describe('R8.5 trainers stay off the engine', () => {
  it('the Voice trainer never calls the engine', () => {
    expect(voice).not.toMatch(/['"`]\/prompt|['"`]\/history|\/object_info|\/queue\b|8188|comfy/i)
    expect(voice).toMatch(/\/api\/training-queue/)
  })

  it('the LoRA trainer calls /prompt and /history only in the local branch', () => {
    const start = lora.indexOf('async function startTraining()')
    const end = lora.indexOf('function extractComfyError')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const outside = lora.slice(0, start) + lora.slice(end)
    expect(outside).not.toMatch(/fetch\(\s*[`'"]\/(prompt|history)/)
    expect(lora.slice(start, end)).toMatch(/fetch\(\s*'\/prompt'/)
    // cloud mode is routed away before the local code is reached
    expect(lora).toMatch(/if \(computeMode\.value === 'cloud'\) startCloudTraining\(\)/)
  })

  it('opens on Cloud when the engine is down or hosted, Local otherwise', () => {
    expect(defaultComputeMode({ hosted: false, engineUp: true })).toBe('local')
    expect(defaultComputeMode({ hosted: false, engineUp: false })).toBe('cloud')
    expect(defaultComputeMode({ hosted: true, engineUp: true })).toBe('cloud')
    expect(localTrainingAvailable({ hosted: true, engineUp: true })).toBe(false)
    expect(localTrainingAvailable({ hosted: false, engineUp: false })).toBe(false)
    expect(LOCAL_NEEDS_ENGINE).toBe('Needs the local engine')
  })

  it('the trainer wires the default and disables Local', () => {
    expect(lora).toContain('defaultComputeMode(')
    expect(lora).toContain(':disabled="!localAvailable"')
    expect(lora).toContain('LOCAL_NEEDS_ENGINE')
  })

  it('reads engine health: only an "up" answer counts', async () => {
    const mk = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch
    expect(await probeEngineUp(mk({ engine: 'up' }))).toBe(true)
    expect(await probeEngineUp(mk({ engine: 'down' }))).toBe(false)
    expect(await probeEngineUp(mk({}, false))).toBe(false)
    expect(await probeEngineUp((async () => { throw new Error('x') }) as unknown as typeof fetch)).toBe(false)
  })
})
