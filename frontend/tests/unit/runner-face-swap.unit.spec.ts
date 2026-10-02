/**
 * Task 2 (non-commercial face models replacement): Face swap on Easel, family
 * `face-swap` (server/runner/generators/easelFaceSwap.ts): fal, no backup.
 * LC1 (2026-10-01, ruling (b)): Easel answered 503 on three live checks, so
 * the family now calls fal's face swap (falFaceSwap.ts, $0.001 a picture);
 * Easel's request stays written and tested as the way back.
 *
 * FaceSwapNode moves the whole node class (eligibility.ts RunnerNodeRule.upgrade),
 * the same pattern as Fix faces on Topaz (Task 1): while the family is on, every
 * Face swap node runs Easel's advanced face swap, in the runner only (Ruling 10).
 * Off, the node's Python definition (comfy_extras/nodes_face.py) is definition-only:
 * InsightFace / inswapper (non-commercial licence) was removed, so there is no
 * ComfyUI call any more — the node always fails plainly there.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, classUpgradeOn, runnerTakesNode } from '#shared/runner/eligibility'
import { EDIT_RATES, editMaxUsd } from '#shared/pricing/editRates'
import { editCalls } from '#shared/pricing/editSettings'
import {
  FACE_SWAP_NEEDS_GENDER, FACE_SWAP_ONE_PICTURE, faceSwapGender, faceSwapWorkflow, EASEL_FACE_SWAP_APP, FAL_FACE_SWAP_APP,
  FACE_SWAP_GENDER_OPTIONS, FACE_SWAP_GENDER_DEFAULT, FACE_SWAP_HAIR_OPTIONS, FACE_SWAP_HAIR_DEFAULT,
} from '#shared/runner/faceSwap'
import { easelFaceSwap } from '~~/server/runner/generators/easelFaceSwap'
import { planNode } from '~~/server/runner/executors'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { requestProblems } from '~~/server/runner/requestRules'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'
import type { OutputFile } from '~~/server/runner/types'
import sharp from 'sharp'

const ON: ReadonlySet<RunnerFamily> = new Set(['face-swap'])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== 'face-swap'))
const schema = loadProviderSchema('fal', EASEL_FACE_SWAP_APP)

describe('Face swap on Easel (face-swap)', () => {
  it('is a family, off by default', () => {
    expect(RUNNER_FAMILIES).toContain('face-swap')
    expect(classUpgradeOn('FaceSwap', NO_FAMILIES)).toBeNull()
    expect(classUpgradeOn('FaceSwap', ON)).toMatchObject({ family: 'face-swap' })
    expect(RUNNER_NODE_RULES.FaceSwap?.upgrade?.family).toBe('face-swap')
  })

  it('sends face, target, gender and hair choice, fitting the schema', () => {
    const call = easelFaceSwap({ face: 'https://x/f.png', target: 'https://x/t.png', inputs: { gender: 'Female', keep_hair_from: 'The picture' } })
    expect(call).toEqual({
      provider: 'fal',
      endpoint: 'easel-ai/advanced-face-swap',
      payload: {
        face_image_0: { url: 'https://x/f.png' },
        gender_0: 'female',
        target_image: { url: 'https://x/t.png' },
        workflow_type: 'target_hair',
        upscale: true,
      },
    })
    expect(checkPayload(schema, call.payload)).toEqual([])
  })

  it('maps "keep hair from face photo" to user_hair', () => {
    expect(FACE_SWAP_HAIR_OPTIONS).toEqual(['The picture', 'The face photo'])
    expect(FACE_SWAP_HAIR_DEFAULT).toBe('The picture')
    expect(faceSwapWorkflow({ keep_hair_from: 'The face photo' })).toBe('user_hair')
    expect(faceSwapWorkflow({ keep_hair_from: FACE_SWAP_HAIR_DEFAULT })).toBe('target_hair')
    expect(faceSwapWorkflow({})).toBe('target_hair')
  })

  it('has no gender until one is picked', () => {
    expect(FACE_SWAP_GENDER_OPTIONS).toEqual(['Not chosen', 'Male', 'Female', 'Non-binary'])
    expect(FACE_SWAP_GENDER_DEFAULT).toBe('Not chosen')
    expect(faceSwapGender({ gender: FACE_SWAP_GENDER_DEFAULT })).toBeNull()
    expect(faceSwapGender({ gender: '' })).toBeNull()
    expect(faceSwapGender({ gender: 'robot' })).toBeNull()
    expect(faceSwapGender({ gender: 'Non-binary' })).toBe('non-binary')
    expect(() => easelFaceSwap({ face: 'a', target: 'b', inputs: {} })).toThrow(FACE_SWAP_NEEDS_GENDER)
  })

  it('is priced flat at fal\'s face swap\'s $0.001 (LC1); Easel\'s $0.05 card is kept for the way back', () => {
    const c = editCalls('FaceSwap', { gender: 'Male' })
    if ('refused' in c) throw new Error(c.refused)
    expect(c.calls[0]!.endpoint).toBe(FAL_FACE_SWAP_APP)
    expect(EDIT_RATES[FAL_FACE_SWAP_APP]).toMatchObject({ unit: 'per_image', usd: 0.001, service: 'fal' })
    expect(EDIT_RATES[EASEL_FACE_SWAP_APP]).toMatchObject({ unit: 'per_image', usd: 0.05, service: 'fal' })
    expect(editMaxUsd(c.calls[0]!)).toBeGreaterThan(0)
  })

  it('has no backup', () => {
    expect(RUNNER_ROUTES['FaceSwap+face-swap']).toMatchObject({ first: 'fal', backup: null })
  })

  it('takes a node fed by two LoadImages only while the family is on', () => {
    const prompt = {
      1: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
      2: { class_type: 'LoadImage', inputs: { image: 'b.png' } },
      3: { class_type: 'FaceSwap', inputs: { source_face: ['1', 0], target_frames: ['2', 0], gender: 'Female', keep_hair_from: 'The picture' } },
    }
    expect(runnerTakesNode(prompt, '3', new Set(['cards', 'face-swap']))).toBe(true)
    expect(runnerTakesNode(prompt, '3', new Set(['cards']))).toBe(false)
  })

  it('no longer refuses a missing gender (LC1: fal\'s face swap takes none; Easel needed one)', () => {
    const prompt = {
      1: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
      2: { class_type: 'LoadImage', inputs: { image: 'b.png' } },
      3: { class_type: 'FaceSwap', inputs: { source_face: ['1', 0], target_frames: ['2', 0], gender: FACE_SWAP_GENDER_DEFAULT, keep_hair_from: 'The picture' } },
    }
    expect(requestProblems(prompt, { runner: true })).toEqual([])
  })
})

describe('one picture only', () => {
  const prompt: ApiPrompt = {
    11: { class_type: 'Image', inputs: { image: 'face.png' } },
    12: { class_type: 'Image', inputs: { image: 'target.png' } },
    1: { class_type: 'FaceSwap', inputs: { source_face: ['11', 0], target_frames: ['12', 0], gender: 'Female', keep_hair_from: 'The picture' } },
  }
  const file = (filename: string): OutputFile => ({ filename, subfolder: '', type: 'output' })
  const planWith = (targets: OutputFile[], handed: OutputFile[]) => planNode({
    prompt, nodeId: '1', gateOpen: false, families: ON,
    filesFrom: link => link[0] === '12' ? targets : [file('face.png')],
    toUrl: async f => { handed.push(f); return `https://fal.storage/${f.filename}` },
  })

  it('a batch of several pictures (video frames) is refused before anything is handed off', async () => {
    const handed: OutputFile[] = []
    await expect(planWith([file('f1.png'), file('f2.png')], handed)).rejects.toThrow(FACE_SWAP_ONE_PICTURE)
    expect(handed).toEqual([])
  })

  it('a single picture is planned as before', async () => {
    const handed: OutputFile[] = []
    const p = await planWith([file('target.png')], handed)
    expect(p.kind).toBe('provider')
    expect(handed.map(f => f.filename)).toEqual(['face.png', 'target.png'])
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

const FACE_PNG = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).png().toBuffer()
const TARGET_PNG = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#204080' } }).png().toBuffer()

describe('the runner engine', () => {
  const take: ApiPrompt = {
    11: { class_type: 'Image', inputs: { image: 'face.png' } },
    12: { class_type: 'Image', inputs: { image: 'target.png' } },
    1: { class_type: 'FaceSwap', inputs: { source_face: ['11', 0], target_frames: ['12', 0], gender: 'Female', keep_hair_from: 'The face photo' } },
    2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  }
  const kit = (families: ReadonlySet<RunnerFamily>) => {
    const k = makeKit({ hosted: true, deps: { families: () => families } })
    fs.writeFileSync(path.join(k.root, 'input', 'face.png'), FACE_PNG)
    fs.writeFileSync(path.join(k.root, 'input', 'target.png'), TARGET_PNG)
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
      expect(submitted.map(r => r.endpoint)).toEqual([FAL_FACE_SWAP_APP])
      // LC1: fal's face swap takes the two pictures only (no gender, no hair choice).
      expect(submitted[0]!.payload).toEqual({ base_image_url: 'https://fal.storage/target.png', swap_image_url: 'https://fal.storage/face.png' })
      expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['settled'])
      expect((await k.store.get(runId))!.status).toBe('done')
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
