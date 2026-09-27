import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LORA_RANK } from '~~/shared/lora-defaults'

/**
 * The default LoRA rank ("LoRA size" in the trainer) had FOUR independent
 * literals — the form default plus a `?? 16` in each of two server routes and
 * the provider builder. Changing the default meant finding all four, and a
 * missed one silently trains at a different capacity than the UI promises.
 * They all derive from one constant now; this guard keeps it that way.
 */
const abs = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url))

const CONSUMERS = [
  'app/components/LoraTrainerSurface.vue',
  'server/utils/trainingProviders.ts',
  'server/api/cloud-train/start.post.ts',
]

describe('default LoRA rank', () => {
  it('is 32', () => {
    expect(DEFAULT_LORA_RANK).toBe(32)
  })

  for (const file of CONSUMERS) {
    it(`${file} derives its default from the shared constant`, () => {
      const src = readFileSync(abs(file), 'utf8')
      expect(src).toContain('DEFAULT_LORA_RANK')
    })

    it(`${file} has no hardcoded rank fallback left`, () => {
      const src = readFileSync(abs(file), 'utf8')
      expect(src).not.toMatch(/loraRank\s*\?\?\s*\d+/)
      expect(src).not.toMatch(/\brank:\s*\d+/)
    })
  }

  it('the trainer help text does not still advertise a stale default', () => {
    const src = readFileSync(abs('app/components/LoraTrainerSurface.vue'), 'utf8')
    const help = src.slice(src.indexOf('LoRA size'), src.indexOf('LoRA size') + 700)
    expect(help).toContain(String(DEFAULT_LORA_RANK))
    expect(help).not.toMatch(/>16<\/span>\s*is the sweet spot/)
  })
})
