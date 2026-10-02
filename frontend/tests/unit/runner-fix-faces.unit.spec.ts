/**
 * Task 1 (non-commercial face models replacement): Fix faces on Topaz, family
 * `fix-faces` (server/runner/generators/topazImage.ts): fal, no backup.
 *
 * FixFacesNode moves the whole node class (eligibility.ts
 * RunnerNodeRule.upgrade), the same pattern as Product shot on Bria: while
 * the family is on, every Fix faces node runs Topaz's image upscale with
 * face enhancement, in the runner only (Ruling 10). Off, the node's Python
 * definition (comfy_api_nodes/nodes_replicate.py) is definition-only:
 * CodeFormer (S-Lab licence, non-commercial) was removed, so there is no
 * ComfyUI call any more — the node always fails plainly there.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, classUpgradeOn, runnerTakesNode } from '#shared/runner/eligibility'
import { EDIT_RATES, editMaxUsd } from '#shared/pricing/editRates'
import { FIX_FACES_DEFAULTS, LARGEST_INPUT_PIXELS, TOPAZ_IMAGE_APP, editCalls, fixFacesSettings, sizePricedInput } from '#shared/pricing/editSettings'
import { topazFixFaces } from '~~/server/runner/generators/topazImage'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { FIX_FACES_TOO_LARGE, measuredInputProblem } from '~~/server/runner/requestRules'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit, ofType } from './__runner__/kit'
import type { OutputFile } from '~~/server/runner/types'
import sharp from 'sharp'

const ON: ReadonlySet<RunnerFamily> = new Set(['fix-faces'])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== 'fix-faces'))
const schema = loadProviderSchema('fal', TOPAZ_IMAGE_APP)

describe('Fix faces on Topaz (fix-faces)', () => {
  it('is a family, off by default', () => {
    expect(RUNNER_FAMILIES).toContain('fix-faces')
    expect(classUpgradeOn('FixFacesNode', NO_FAMILIES)).toBeNull()
    expect(classUpgradeOn('FixFacesNode', ON)).toMatchObject({ family: 'fix-faces' })
    expect(RUNNER_NODE_RULES.FixFacesNode?.upgrade?.family).toBe('fix-faces')
  })

  it('sends the node defaults, fitting the saved schema', () => {
    const call = topazFixFaces({ image: 'https://x/a.png', inputs: {} })
    expect(call).toEqual({
      provider: 'fal',
      endpoint: 'fal-ai/topaz/upscale/image',
      payload: {
        image_url: 'https://x/a.png',
        model: 'Standard V2',
        upscale_factor: 2,
        face_enhancement: true,
        face_enhancement_strength: 0.8,
        face_enhancement_creativity: 0,
        output_format: 'png',
      },
    })
    expect(checkPayload(schema, call.payload)).toEqual([])
  })

  it('clamps settings into the schema range', () => {
    expect(fixFacesSettings({ strength: 2, creativity: -1, upscale: 9 })).toEqual({ strength: 1, creativity: 0, upscale: 4 })
    expect(fixFacesSettings({ strength: 'x' })).toEqual(FIX_FACES_DEFAULTS)
    for (const upscale of [1, 2, 3, 4]) {
      expect(checkPayload(schema, topazFixFaces({ image: 'https://x/a.png', inputs: { upscale } }).payload)).toEqual([])
    }
  })

  it('is priced by output size, and at the cap when unmeasured', () => {
    const usd = (inputPixels: number | null, upscale = 2) => {
      const c = editCalls('FixFacesNode', { upscale }, { inputPixels, families: ON })
      if ('refused' in c) throw new Error(c.refused)
      return editMaxUsd(c.calls[0]!)
    }
    // 1024² × 2² = 4.2 MP → $0.08 tier; 3000 × 4000 × 2² = 48 MP → $0.16 tier; 12 MP × 4² = 192 MP → $1.36 tier
    expect(usd(1024 * 1024)).toBeLessThan(usd(3000 * 4000))
    expect(usd(12e6, 4)).toBeGreaterThan(usd(12e6, 2))
    expect(usd(null)).toBe(usd(LARGEST_INPUT_PIXELS))
    expect(EDIT_RATES['fal-ai/topaz/upscale/image']).toMatchObject({ unit: 'by_output_pixels', service: 'fal', confidence: 'verified' })
    expect(sizePricedInput('FixFacesNode', {})).toBe('image')
  })

  it('refuses a picture above the input cap', () => {
    expect(measuredInputProblem('FixFacesNode', LARGEST_INPUT_PIXELS + 1, ON)).toBe(FIX_FACES_TOO_LARGE)
    expect(measuredInputProblem('FixFacesNode', 1e6, ON)).toBeNull()
  })

  it('has no backup', () => {
    expect(RUNNER_ROUTES['FixFacesNode+fix-faces']).toMatchObject({ first: 'fal', backup: null })
  })

  it('takes a node fed by a LoadImage only while the family is on', () => {
    const prompt = {
      1: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
      2: { class_type: 'FixFacesNode', inputs: { image: ['1', 0], strength: 0.8, creativity: 0, upscale: 2 } },
    }
    expect(runnerTakesNode(prompt, '2', new Set(['cards', 'fix-faces']))).toBe(true)
    expect(runnerTakesNode(prompt, '2', new Set(['cards']))).toBe(false)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

const PNG = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).png().toBuffer()

describe('the runner engine', () => {
  const take: ApiPrompt = {
    11: { class_type: 'Image', inputs: { image: 'face.png' } },
    1: { class_type: 'FixFacesNode', inputs: { image: ['11', 0], strength: 0.9, creativity: 0.2, upscale: 3 } },
    2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  }
  const kit = (families: ReadonlySet<RunnerFamily>) => {
    const k = makeKit({ hosted: true, deps: { families: () => families } })
    fs.writeFileSync(path.join(k.root, 'input', 'face.png'), PNG)
    return k
  }
  const start = (k: ReturnType<typeof makeKit>) => k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  for (const [name, families] of [['the family alone', ON], ['every family', ALL]] as const) {
    it(`${name}: the family's own fal endpoint, held and charged`, async () => {
      const k = kit(families)
      const { runId } = await start(k)
      await k.engine.settled(runId)
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
      const submitted = k.fal.submitted()
      expect(submitted.map(r => r.endpoint)).toEqual([TOPAZ_IMAGE_APP])
      expect(submitted[0]!.payload).toEqual({
        image_url: 'https://fal.storage/face.png',
        model: 'Standard V2',
        upscale_factor: 3,
        face_enhancement: true,
        face_enhancement_strength: 0.9,
        face_enhancement_creativity: 0.2,
        output_format: 'png',
      })
      expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['settled'])
      expect((await k.store.get(runId))!.status).toBe('done')
    })
  }

  // LC4 (live5-fixfaces, 2026-10-02): a 512 × 512 portrait at upscale 2 was quoted $0.32 "up to" — the start of the
  // run did not size Fix faces' picture, so it priced the 18.9 MP input cap × 4 (the 96 MP tier). It is sized now.
  for (const hosted of [true, false]) {
    it(`a 512 × 512 picture at upscale 2 is quoted and held at the 24 MP tier ($0.08), not "up to" (${hosted ? 'hosted' : 'local'})`, async () => {
      const k = makeKit({ hosted, deps: { families: () => new Set<RunnerFamily>(['fix-faces', 'cards']) } })
      fs.writeFileSync(path.join(k.root, 'input', 'portrait.png'), await sharp({ create: { width: 512, height: 512, channels: 3, background: '#a07050' } }).png().toBuffer())
      const p: ApiPrompt = {
        l: { class_type: 'LoadImage', inputs: { image: 'portrait.png', upload: 'image' } },
        f: { class_type: 'FixFacesNode', inputs: { image: ['l', 0], strength: 0.8, creativity: 0, upscale: 2 } },
        s: { class_type: 'SaveImage', inputs: { images: ['f', 0], filename_prefix: 'fix' } },
      }
      const quoted = await k.engine.quoteRun({ userId: k.userId, takes: [p], workflow: null, canvasId: null, projectUuid: null, projectName: null })
      expect(quoted).toMatchObject({ usd: 0.08, upTo: false })
      // Unmeasured (the canvas), the cap: $0.32, the price the live check was quoted.
      expect(editMaxUsd(editCalls('FixFacesNode', { upscale: 2 }).calls[0]!)).toBe(0.32)
      if (!hosted) return
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], workflow: null, canvasId: null, projectUuid: null, projectName: null })
      await k.engine.settled(runId)
      expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([quoted.credits])
    })
  }

  it('off (every other family on): refused, nothing held or sent', async () => {
    const k = kit(ALL_BUT)
    await expect(start(k)).rejects.toMatchObject({ statusCode: 400 })
    expect(k.fal.reqs.size).toBe(0)
    expect(k.replicate.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })
})
