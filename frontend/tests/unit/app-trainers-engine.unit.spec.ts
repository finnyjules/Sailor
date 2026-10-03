import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (f: string) => readFileSync(resolve(__dirname, '../../app/components', f), 'utf8')
const voice = read('VoiceTrainerSurface.vue')
const lora = read('LoraTrainerSurface.vue')

// R8.5 kept the trainers off the engine; R10.7 (decision 6) makes the LoRA
// trainer cloud only, so neither trainer calls the engine at all.
describe('trainers stay off the engine', () => {
  it('the Voice trainer never calls the engine', () => {
    expect(voice).not.toMatch(/['"`]\/prompt|['"`]\/history|\/object_info|\/queue\b|8188|comfy/i)
    expect(voice).toMatch(/\/api\/training-queue/)
  })

  it('the LoRA trainer never calls /prompt or /history', () => {
    expect(lora).not.toMatch(/['"`]\/(prompt|history)\b/)
    expect(lora).not.toMatch(/\/object_info\/|\/queue\b|8188|extractComfyError|buildTrainingPrompt|pollForTrainingResult/)
  })

  it('the LoRA trainer is cloud only: no Local switch, no base checkpoints', () => {
    expect(lora).not.toMatch(/computeMode|localAvailable|trainerCompute|LOCAL_NEEDS_ENGINE|probeEngineUp/)
    expect(lora).not.toMatch(/models\/(status|download)|DOWNLOADABLE_CHECKPOINTS|CheckpointLoaderSimple/)
    expect(lora).not.toMatch(/save_captions/)
    expect(existsSync(resolve(__dirname, '../../app/lib/lora/trainerCompute.ts'))).toBe(false)
  })

  it('a training goes to the cloud queue', () => {
    expect(lora).toMatch(/fetch\('\/api\/cloud-train\/upload'/)
    expect(lora).toMatch(/fetch\('\/api\/training-queue'/)
    expect(lora).toContain('@click="startCloudTraining"')
  })
})
