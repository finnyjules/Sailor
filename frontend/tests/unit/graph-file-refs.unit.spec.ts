/**
 * Stage 6 Task 7 — a submitted graph may only reference files the CALLER owns.
 *
 * The threat: a hand-edited graph carrying `LoadImage.image = "victim.png"` (or
 * `LoadImageOutput.image = <another tenant's output>`, or an `[output]`-
 * annotated value on any upload-flagged input) reads a file the caller never
 * uploaded/produced. `validateGraphFileRefs` refuses (403) BEFORE any credit is
 * held, so a refusal costs nothing. Fail closed: an upload-flagged input whose
 * value is not a plain filename string (a number, an object, a wired link) is
 * refused too — we cannot vet what we cannot read.
 *
 * `shortUserHash` + `injectOutputSubfolder` cover the write side: outputs land
 * in `output/u_<hash>/...` and a client-supplied prefix can never escape the
 * caller's own subfolder.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  validateGraphFileRefs,
  shortUserHash,
  injectOutputSubfolder,
} from '../../server/utils/meterGraphRun'
import { collectUploadFlaggedInputs } from '../../server/utils/engineGate'
import { MeterRefusalError } from '../../server/utils/requestMeter'

/** A ctx whose ownership answers are fully controlled by the test. */
function ctx(overrides: Partial<any> = {}) {
  return {
    uploadFlagged: new Set<string>(['LoadImage.image', 'LoadImageOutput.image']),
    callerHash: 'aaaaaaaaaaaa',
    ownsInput: vi.fn(async (_name: string) => true),
    ownsOutput: vi.fn(async (_annotated: string) => true),
    ...overrides,
  }
}

const loadImage = (image: unknown) => ({ '1': { class_type: 'LoadImage', inputs: { image } } })
const loadOutput = (image: unknown) => ({ '1': { class_type: 'LoadImageOutput', inputs: { image } } })

describe('validateGraphFileRefs — input ownership', () => {
  it('passes a graph that references only the caller-owned input file', async () => {
    const c = ctx({ ownsInput: vi.fn(async () => true) })
    await expect(validateGraphFileRefs(loadImage('mine.png'), c)).resolves.toBeUndefined()
    expect(c.ownsInput).toHaveBeenCalledWith('mine.png')
    expect(c.ownsOutput).not.toHaveBeenCalled()
  })

  it('REFUSES (403) a graph referencing another user\'s input file', async () => {
    const c = ctx({ ownsInput: vi.fn(async () => false) })
    await expect(validateGraphFileRefs(loadImage('victim.png'), c)).rejects.toBeInstanceOf(MeterRefusalError)
    await expect(validateGraphFileRefs(loadImage('victim.png'), c)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('routes an [output]-annotated value on a LoadImage input to the OUTPUT check', async () => {
    const c = ctx({ ownsOutput: vi.fn(async () => false), ownsInput: vi.fn(async () => true) })
    await expect(validateGraphFileRefs(loadImage('victim.png [output]'), c)).rejects.toMatchObject({ statusCode: 403 })
    expect(c.ownsOutput).toHaveBeenCalledWith('victim.png [output]')
    expect(c.ownsInput).not.toHaveBeenCalled()
  })

  it('routes an [input]/[temp]/unannotated value to the INPUT check', async () => {
    const c = ctx({ ownsInput: vi.fn(async () => true) })
    await validateGraphFileRefs(loadImage('a.png [input]'), c)
    await validateGraphFileRefs(loadImage('b.png [temp]'), c)
    await validateGraphFileRefs(loadImage('c.png'), c)
    expect(c.ownsInput.mock.calls.map(x => x[0])).toEqual(['a.png', 'b.png', 'c.png'])
    expect(c.ownsOutput).not.toHaveBeenCalled()
  })
})

describe('validateGraphFileRefs — LoadImageOutput is always an OUTPUT read', () => {
  it('checks a LoadImageOutput.image value against OUTPUTS even with no annotation', async () => {
    const c = ctx({ ownsOutput: vi.fn(async () => true), ownsInput: vi.fn(async () => false) })
    await validateGraphFileRefs(loadOutput('u_abc/mine.png'), c)
    expect(c.ownsOutput).toHaveBeenCalledWith('u_abc/mine.png')
    expect(c.ownsInput).not.toHaveBeenCalled()
  })

  it('REFUSES (403) a LoadImageOutput referencing another user\'s output', async () => {
    const c = ctx({ ownsOutput: vi.fn(async () => false) })
    await expect(validateGraphFileRefs(loadOutput('u_other/theirs.png'), c)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('checks LoadImageOutput even when it is NOT in the uploadFlagged set (GRAPH_FILE_READERS map)', async () => {
    const c = ctx({ uploadFlagged: new Set<string>(), ownsOutput: vi.fn(async () => false) })
    await expect(validateGraphFileRefs(loadOutput('theirs.png'), c)).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('validateGraphFileRefs — fail closed on unknown shapes', () => {
  it('REFUSES a flagged input carrying a non-string value (wired link / object / number)', async () => {
    for (const bad of [['9', 0], 42, { a: 1 }, true]) {
      await expect(validateGraphFileRefs(loadImage(bad), ctx())).rejects.toMatchObject({ statusCode: 403 })
    }
  })

  it('skips an absent or empty flagged input (no file referenced)', async () => {
    const c = ctx()
    await validateGraphFileRefs({ '1': { class_type: 'LoadImage', inputs: {} } }, c)
    await validateGraphFileRefs(loadImage(''), c)
    await validateGraphFileRefs(loadImage(null), c)
    expect(c.ownsInput).not.toHaveBeenCalled()
    expect(c.ownsOutput).not.toHaveBeenCalled()
  })

  it('leaves a zero-file graph (no flagged inputs) completely untouched', async () => {
    const c = ctx()
    await validateGraphFileRefs({ '1': { class_type: 'SaveImage', inputs: { images: ['2', 0] } } }, c)
    expect(c.ownsInput).not.toHaveBeenCalled()
    expect(c.ownsOutput).not.toHaveBeenCalled()
  })

  it('ignores a non-flagged string input on an otherwise-flagged node class', async () => {
    // KSampler.seed is a string here but is not upload-flagged — must not be
    // treated as a file reference.
    const c = ctx({ uploadFlagged: new Set(['LoadImage.image']) })
    await validateGraphFileRefs({ '1': { class_type: 'KSampler', inputs: { seed: 'abc.png' } } }, c)
    expect(c.ownsInput).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Task 7b — the unflagged / JSON-embedded / dict-valued file readers.
// Each of these launders a cross-tenant read through an input the object_info
// upload-flag walk never sees; the GRAPH_FILE_READERS map now vets them.
// ---------------------------------------------------------------------------

const node = (class_type: string, inputs: Record<string, unknown>) => ({ '1': { class_type, inputs } })

describe('validateGraphFileRefs — Task 7b newly-covered readers refuse foreign files', () => {
  it('LoadLatent.latent — REFUSES another tenant\'s latent (unflagged string input)', async () => {
    const c = ctx({ ownsInput: vi.fn(async () => false) })
    await expect(validateGraphFileRefs(node('LoadLatent', { latent: 'other.latent' }), c))
      .rejects.toMatchObject({ statusCode: 403 })
    expect(c.ownsInput).toHaveBeenCalledWith('other.latent')
  })

  it('Load3D.image — REFUSES a victim frame smuggled through the image dict', async () => {
    const c = ctx({ ownsOutput: vi.fn(async () => false), ownsInput: vi.fn(async () => true) })
    const g = node('Load3D', { image: { image: 'victim.png [output]', mask: '', normal: '', recording: '' }, model_file: 'ok.glb' })
    await expect(validateGraphFileRefs(g, c)).rejects.toMatchObject({ statusCode: 403 })
    expect(c.ownsOutput).toHaveBeenCalledWith('victim.png [output]')
  })

  it('Load3D.image — a non-object image value fails closed (403)', async () => {
    await expect(validateGraphFileRefs(node('Load3D', { image: 'not-a-dict', model_file: '' }), ctx()))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('Load3D.model_file — REFUSES a foreign model file', async () => {
    const c = ctx({ ownsInput: vi.fn(async () => false) })
    await expect(validateGraphFileRefs(node('Load3D', { image: {}, model_file: 'theirs.glb' }), c))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('Compositor.motion_params — REFUSES a foreign frame embedded in the rendered[] blob', async () => {
    // Own the first frame, not the second: the walk reaches the embedded frame
    // and refuses on it specifically (proving the blob is walked, not skipped).
    const c = ctx({ ownsInput: vi.fn(async (name: string) => name === 'mine1.png') })
    const g = node('Compositor', { motion_params: JSON.stringify({ fps: 30, rendered: ['mine1.png', 'victim_frame.png'] }) })
    await expect(validateGraphFileRefs(g, c)).rejects.toMatchObject({ statusCode: 403 })
    expect(c.ownsInput.mock.calls.map(x => x[0])).toContain('victim_frame.png')
  })

  it('Compositor.motion_params — passes when every rendered frame is owned', async () => {
    const c = ctx({ ownsInput: vi.fn(async () => true) })
    const g = node('Compositor', { motion_params: JSON.stringify({ rendered: ['a.png', 'b.png'] }) })
    await expect(validateGraphFileRefs(g, c)).resolves.toBeUndefined()
    expect(c.ownsInput.mock.calls.map(x => x[0])).toEqual(['a.png', 'b.png'])
  })

  it('Compositor.motion_params — unparseable JSON fails closed (403)', async () => {
    await expect(validateGraphFileRefs(node('Compositor', { motion_params: '{not json' }), ctx()))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('Compositor.motion_params — empty / no-frames blob references nothing', async () => {
    const c = ctx()
    await validateGraphFileRefs(node('Compositor', { motion_params: '' }), c)
    await validateGraphFileRefs(node('Compositor', { motion_params: '{}' }), c)
    await validateGraphFileRefs(node('Compositor', { motion_params: JSON.stringify({ rendered: [] }) }), c)
    expect(c.ownsInput).not.toHaveBeenCalled()
    expect(c.ownsOutput).not.toHaveBeenCalled()
  })

  it('RenderType / TextMask / TextOnPath — REFUSE a foreign rendered string in params', async () => {
    for (const ct of ['RenderType', 'TextMask', 'TextOnPath']) {
      const c = ctx({ ownsInput: vi.fn(async () => false) })
      const g = node(ct, { params: JSON.stringify({ rendered: 'someone_else.png' }) })
      await expect(validateGraphFileRefs(g, c), ct).rejects.toMatchObject({ statusCode: 403 })
      expect(c.ownsInput, ct).toHaveBeenCalledWith('someone_else.png')
    }
  })

  it('KineticType.params — REFUSES a foreign frame in the rendered[] list', async () => {
    const c = ctx({ ownsInput: vi.fn(async () => false) })
    const g = node('KineticType', { params: JSON.stringify({ fps: 12, rendered: ['victim.png'] }) })
    await expect(validateGraphFileRefs(g, c)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('Timeline.edit_state — REFUSES a foreign image-clip path (input semantics, literal)', async () => {
    const c = ctx({ ownsInput: vi.fn(async () => false) })
    const state = { tracks: [{ clips: [{ kind: 'image', path: '../other-tenant/secret.png' }] }] }
    await expect(validateGraphFileRefs(node('Timeline', { edit_state: JSON.stringify(state) }), c))
      .rejects.toMatchObject({ statusCode: 403 })
    expect(c.ownsInput).toHaveBeenCalledWith('../other-tenant/secret.png')
  })

  it('Timeline.edit_state — checks asset_path too, and passes when owned', async () => {
    const c = ctx({ ownsInput: vi.fn(async () => true) })
    const state = { tracks: [{ clips: [{ path: 'mine1.png' }, { asset_path: 'mine2.png' }] }] }
    await validateGraphFileRefs(node('Timeline', { edit_state: JSON.stringify(state) }), c)
    expect(c.ownsInput.mock.calls.map(x => x[0])).toEqual(['mine1.png', 'mine2.png'])
    expect(c.ownsOutput).not.toHaveBeenCalled()
  })

  it('the media readers (LoadVideo/Video/LUT/AudioWaveform/LoadAudio/Painter/WebcamCapture) all vet their filename', async () => {
    const cases: [string, string][] = [
      ['LoadVideo', 'file'], ['Video', 'file'], ['LUT', 'lut_file'],
      ['AudioWaveform', 'audio_file'], ['LoadAudio', 'audio'], ['Audio', 'audio'],
      ['RecordAudio', 'audio'], ['Painter', 'mask'], ['WebcamCapture', 'image'],
      ['LoadVideoFrames', 'file'], ['SaveVideoFrames', 'audio_file'],
      ['Scene3DStudio', 'beauty_image'], ['PoseMannequin', 'result_image'],
    ]
    for (const [ct, input] of cases) {
      const c = ctx({ ownsInput: vi.fn(async () => false) })
      await expect(validateGraphFileRefs(node(ct, { [input]: 'foreign.bin' }), c), ct)
        .rejects.toMatchObject({ statusCode: 403 })
    }
  })
})

// ---------------------------------------------------------------------------
// Task 7b (review Critical) — per-FOLDER readers. Three dataset nodes read an
// attacker-named FOLDER from the shared tree and emit its whole contents. None
// is an annotated per-file ref, so GRAPH_FILE_READERS never saw them; the new
// GRAPH_FOLDER_READERS map vets the folder value against the caller's own
// u_<hash> subtree BEFORE any hold.
// ---------------------------------------------------------------------------

describe('validateGraphFileRefs — Task 7b folder readers (per-FOLDER ownership)', () => {
  const CALLER = 'aaaaaaaaaaaa'
  const OTHER = 'bbbbbbbbbbbb'
  const fctx = (o: Partial<any> = {}) => ctx({ callerHash: CALLER, ...o })

  it('LoadImageDataSetFromFolder — REFUSES (403) another tenant\'s input subfolder', async () => {
    await expect(validateGraphFileRefs(node('LoadImageDataSetFromFolder', { folder: `u_${OTHER}` }), fctx()))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('LoadImageDataSetFromFolder — PASSES the caller\'s own u_<hash> subfolder (and a nested path under it)', async () => {
    await expect(validateGraphFileRefs(node('LoadImageDataSetFromFolder', { folder: `u_${CALLER}` }), fctx()))
      .resolves.toBeUndefined()
    await expect(validateGraphFileRefs(node('LoadImageDataSetFromFolder', { folder: `u_${CALLER}/set1` }), fctx()))
      .resolves.toBeUndefined()
  })

  it('LoadImageDataSetFromFolder — REFUSES a bare folder name (no legitimate use on the shared input tree)', async () => {
    await expect(validateGraphFileRefs(node('LoadImageDataSetFromFolder', { folder: 'randomname' }), fctx()))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('LoadImageDataSetFromFolder — fails closed on traversal / absolute / empty / wired / non-string values', async () => {
    const bads: unknown[] = ['../x', `../u_${CALLER}`, `u_${CALLER}/../u_${OTHER}`, `u_${CALLER}/..`, '/abs/path', 'C:/x', '', '.', '..', undefined, null, 42, ['1', 0], { a: 1 }]
    for (const bad of bads) {
      await expect(validateGraphFileRefs(node('LoadImageDataSetFromFolder', { folder: bad }), fctx()), JSON.stringify(bad))
        .rejects.toMatchObject({ statusCode: 403 })
    }
  })

  it('LoadImageTextDataSetFromFolder — same input-folder rule (foreign refused, own passes)', async () => {
    await expect(validateGraphFileRefs(node('LoadImageTextDataSetFromFolder', { folder: `u_${OTHER}` }), fctx()))
      .rejects.toMatchObject({ statusCode: 403 })
    await expect(validateGraphFileRefs(node('LoadImageTextDataSetFromFolder', { folder: `u_${CALLER}` }), fctx()))
      .resolves.toBeUndefined()
  })

  it('LoadTrainingDataset.folder_name — REFUSES another tenant\'s output folder AND the bare default', async () => {
    await expect(validateGraphFileRefs(node('LoadTrainingDataset', { folder_name: `u_${OTHER}` }), fctx()))
      .rejects.toMatchObject({ statusCode: 403 })
    // default "training_dataset" is not caller-scoped → refused (fail closed).
    await expect(validateGraphFileRefs(node('LoadTrainingDataset', { folder_name: 'training_dataset' }), fctx()))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('LoadTrainingDataset.folder_name — PASSES the caller\'s own u_<hash> output subtree', async () => {
    await expect(validateGraphFileRefs(node('LoadTrainingDataset', { folder_name: `u_${CALLER}/training_dataset` }), fctx()))
      .resolves.toBeUndefined()
  })

  it('folder ownership is a pure string check — it never touches the per-file ownsInput/ownsOutput DB probes', async () => {
    const c = fctx()
    await validateGraphFileRefs(node('LoadTrainingDataset', { folder_name: `u_${CALLER}` }), c)
    expect(c.ownsInput).not.toHaveBeenCalled()
    expect(c.ownsOutput).not.toHaveBeenCalled()
  })
})

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

describe('injectOutputSubfolder', () => {
  const hash = shortUserHash('u1')

  it('prefixes SaveImage output with the caller subfolder, defaulting to ComfyUI', () => {
    const out = injectOutputSubfolder({ '1': { class_type: 'SaveImage', inputs: {} } }, 'u1')
    expect(out['1'].inputs.filename_prefix).toBe(`u_${hash}/ComfyUI`)
  })

  it('preserves a custom prefix as the suffix', () => {
    const out = injectOutputSubfolder({ '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'MyRender' } } }, 'u1')
    expect(out['1'].inputs.filename_prefix).toBe(`u_${hash}/MyRender`)
  })

  it('REPLACES a client-supplied foreign per-user prefix (caller hash appears exactly once)', () => {
    const out = injectOutputSubfolder({ '1': { class_type: 'SaveImage', inputs: { filename_prefix: 'u_deadbeefcafe/evil' } } }, 'u1')
    const p = out['1'].inputs.filename_prefix as string
    expect(p).toBe(`u_${hash}/evil`)
    expect(p.match(/u_/g)?.length).toBe(1)
  })

  it('strips ../ traversal from a client prefix before prefixing', () => {
    const out = injectOutputSubfolder({ '1': { class_type: 'SaveImage', inputs: { filename_prefix: '../../etc/x' } } }, 'u1')
    expect(out['1'].inputs.filename_prefix).toBe(`u_${hash}/etc/x`)
  })

  it('subfolders the Task 7b output classes too (Image / Video / SaveGLB / SaveAnimatedWEBP)', () => {
    for (const ct of ['Image', 'Video', 'SaveGLB', 'SaveAnimatedWEBP', 'SaveWEBM', 'Audio']) {
      const out = injectOutputSubfolder({ '1': { class_type: ct, inputs: {} } }, 'u1')
      expect(out['1'].inputs.filename_prefix, ct).toBe(`u_${hash}/ComfyUI`)
    }
  })

  it('an Image (SaveImage subclass) output lands under the caller u_<hash>/ subfolder', () => {
    const out = injectOutputSubfolder({ '1': { class_type: 'Image', inputs: { filename_prefix: 'Poster' } } }, 'u1')
    expect(out['1'].inputs.filename_prefix).toBe(`u_${hash}/Poster`)
  })

  it('injects into the whole SaveImage family, and does not mutate the input object', () => {
    const src = {
      '1': { class_type: 'SaveVideo', inputs: {} },
      '2': { class_type: 'SaveAudio', inputs: { filename_prefix: 'song' } },
      '3': { class_type: 'KSampler', inputs: { seed: 5 } },
    }
    const out = injectOutputSubfolder(src, 'u1')
    expect(out['1'].inputs.filename_prefix).toBe(`u_${hash}/ComfyUI`)
    expect(out['2'].inputs.filename_prefix).toBe(`u_${hash}/song`)
    expect(out['3'].inputs).toEqual({ seed: 5 })
    // original untouched (clone semantics — no cross-request bleed)
    expect((src['1'].inputs as any).filename_prefix).toBeUndefined()
  })
})

describe('injectOutputSubfolder — Task 7c: writers that place their output through a field OTHER than filename_prefix', () => {
  const hash = shortUserHash('u1')

  it('neutralizes SaveImageDataSetToFolder\'s ../../etc traversal — the MOST SERIOUS Task 7c finding', () => {
    // nodes_dataset.py:237 joins folder_name onto get_output_directory() with a
    // bare os.path.join and NO commonpath containment check — unlike
    // filename_prefix (which routes through folder_paths.get_save_image_path),
    // this field had NO engine-side protection at all before this fix.
    const out = injectOutputSubfolder({ '1': { class_type: 'SaveImageDataSetToFolder', inputs: { folder_name: '../../etc' } } }, 'u1')
    expect(out['1'].inputs.folder_name).toBe(`u_${hash}/etc`)
    // filename_prefix on the SAME node is untouched — folder_name is the
    // traversal-relevant field, not the per-file prefix within that folder.
    expect(out['1'].inputs.filename_prefix).toBeUndefined()
  })

  it('subfolders SaveImageTextDataSetToFolder and SaveTrainingDataset under folder_name too', () => {
    for (const ct of ['SaveImageTextDataSetToFolder', 'SaveTrainingDataset']) {
      const out = injectOutputSubfolder({ '1': { class_type: ct, inputs: { folder_name: 'my-dataset' } } }, 'u1')
      expect(out['1'].inputs.folder_name, ct).toBe(`u_${hash}/my-dataset`)
    }
  })

  it('subfolders SaveLoRA under its own prefix field, defaulting to ComfyUI when absent', () => {
    const out = injectOutputSubfolder({ '1': { class_type: 'SaveLoRA', inputs: {} } }, 'u1')
    expect(out['1'].inputs.prefix).toBe(`u_${hash}/ComfyUI`)
  })

  it('preserves a custom SaveLoRA prefix as the suffix', () => {
    const out = injectOutputSubfolder({ '1': { class_type: 'SaveLoRA', inputs: { prefix: 'loras/my_run' } } }, 'u1')
    expect(out['1'].inputs.prefix).toBe(`u_${hash}/loras/my_run`)
  })

  it('REPLACES a client-supplied foreign per-user segment in a non-filename_prefix field exactly once', () => {
    const out = injectOutputSubfolder({ '1': { class_type: 'SaveImageDataSetToFolder', inputs: { folder_name: 'u_otherhash/evil' } } }, 'u1')
    const v = out['1'].inputs.folder_name as string
    expect(v).toBe(`u_${hash}/evil`)
    expect(v.match(/u_/g)?.length).toBe(1)
  })

  it('leaves Preview3D untouched — no client-controllable path field to rewrite', () => {
    const out = injectOutputSubfolder({ '1': { class_type: 'Preview3D', inputs: { some_other_input: 1 } } }, 'u1')
    expect(out['1'].inputs).toEqual({ some_other_input: 1 })
  })

  it('a zero-output graph (no writer class_type present) is left unaffected', () => {
    const src = { '1': { class_type: 'KSampler', inputs: { seed: 5 } }, '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' } } }
    const out = injectOutputSubfolder(src, 'u1')
    expect(out).toEqual(src)
  })
})
