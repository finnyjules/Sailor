/**
 * Stage 6 Task 7 — per-user output folders. Step 4, C5: the engine's /prompt
 * gate that checked a submitted graph's file references (validateGraphFileRefs)
 * and wrote outputs under the caller's folder (injectOutputSubfolder) went
 * with the engine (server/utils/meterGraphRun.ts); the runner checks its own
 * file references and saves under `u_<hash>/` (runner/results.ts). What stays:
 * the hash that names the folder, and the catalogue walk.
 */
import { describe, it, expect } from 'vitest'
import { shortUserHash } from '../../server/utils/userHash'
import { collectUploadFlaggedInputs, ownUserFolder } from '../../server/utils/engineGate'

// Step 3, R10.9: the cached fetch of the engine's catalog (loadUploadFlaggedInputs)
// went with the hosted /prompt path; the catalog walk itself stays.
describe('collectUploadFlaggedInputs — derived from an object_info catalog', () => {
  const catalog = {
    // legacy shape: [ ["file", ...], { image_upload: true } ]
    LoadImage: { input: { required: { image: [['a.png', 'b.png'], { image_upload: true }] } } },
    // v2 shape: [ "COMBO", { options:[...], audio_upload: true } ]
    LoadAudio: { input: { required: { audio: ['COMBO', { options: [], audio_upload: true }] } } },
    // no upload flag → not collected (shared model asset)
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['x.safetensors'], {}] } } },
  }

  it('collects every upload-flagged (ClassType.inputName) pair PLUS the hardcoded LoadImageOutput.image', async () => {
    const set = collectUploadFlaggedInputs(catalog)
    expect(set.has('LoadImage.image')).toBe(true)
    expect(set.has('LoadAudio.audio')).toBe(true)
    expect(set.has('CheckpointLoaderSimple.ckpt_name')).toBe(false)
    // Task 7b: LoadImageOutput.image is remote-routed (nodes.py:1951-1959) so
    // it is never object_info-flagged AND no longer added here — the
    // GRAPH_FILE_READERS map covers it explicitly (semantics: output).
    expect(set.has('LoadImageOutput.image')).toBe(false)
  })
})

describe('shortUserHash', () => {
  it('is a deterministic 12-hex-char sha256 prefix with no PII', () => {
    const h = shortUserHash('user_2abc')
    expect(h).toMatch(/^[0-9a-f]{12}$/)
    expect(h).toBe(shortUserHash('user_2abc'))
    expect(h).not.toContain('user')
    expect(shortUserHash('user_2abc')).not.toBe(shortUserHash('user_2abd'))
  })
})

describe('the runner’s folder and the gate’s folder are the same', () => {
  it('ownUserFolder is u_ + shortUserHash', () => {
    expect(ownUserFolder('user_2abc')).toBe(`u_${shortUserHash('user_2abc')}`)
  })
})
