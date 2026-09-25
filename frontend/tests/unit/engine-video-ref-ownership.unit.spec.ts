/**
 * The hosted /prompt gate vets the `/view?filename=X&type=input` links a video
 * node's `model_options` carries (Shot Director's reference lists and first /
 * last frames), the same way it vets LipSyncNode's: every named input file must
 * be the caller's own. External https links name no file and pass.
 */
import { describe, expect, it } from 'vitest'
import { validateGraphFileRefs } from '../../server/utils/meterGraphRun'
import { GRAPH_FILE_READERS, extractFileRefs } from '../../server/utils/engineFileSurface'

const view = (name: string) => `/view?filename=${encodeURIComponent(name)}&type=input`

/** Hosted ownership: the caller owns exactly `owned`; nothing in output/. */
const ctx = (owned: string[]) => ({
  uploadFlagged: new Set<string>(),
  callerHash: 'h',
  ownsInput: async (n: string) => owned.includes(n),
  ownsOutput: async () => false,
})

const graph = (ct: string, opts: unknown) => ({ 1: { class_type: ct, inputs: { model_options: typeof opts === 'string' ? opts : JSON.stringify(opts) } } })

describe.each(['FilmShotNode', 'GenerateVideoNode'])('%s model_options file links', (ct) => {
  it('names every /view input link under the reference lists and the first/last frame keys', () => {
    const spec = GRAPH_FILE_READERS[ct]![0]!
    const mo = JSON.stringify({
      image_urls: [view('a.png'), 'https://cdn.example.com/b.png'],
      video_urls: [view('clip.mp4')],
      audio_urls: [view('voice.mp3')],
      reference_images: [view('r.png'), 42],
      image_url: view('first.png'),
      end_image_url: view('last.png'),
      last_frame_image: 'data:image/png;base64,AAAA',
      image: view('rep.png'),
      prompt: view('not-a-ref-key.png'), // not a key the engine resolves
    })
    expect(extractFileRefs(spec, mo)).toEqual(['r.png', 'a.png', 'clip.mp4', 'voice.mp3', 'rep.png', 'first.png', 'last.png'])
    expect(extractFileRefs(spec, '{}')).toEqual([])
    expect(extractFileRefs(spec, '[1]')).toEqual([])
    expect(extractFileRefs(spec, JSON.stringify({ video_urls: view('v.mp4') }))).toEqual([]) // not a list: the engine skips it
    expect(extractFileRefs(spec, JSON.stringify({ image_url: '/view?filename=x.png&type=output' }))).toEqual([]) // the engine reads only type=input
    expect(extractFileRefs(spec, '{nope')).toBeNull() // unreadable: refused
  })

  it('hosted: another tenant’s file is refused', async () => {
    await expect(validateGraphFileRefs(graph(ct, { video_urls: [view('theirs.mp4')] }), ctx(['mine.mp4'])))
      .rejects.toThrow(new RegExp(`input file you do not own \\(${ct}\\.model_options\\)`))
    await expect(validateGraphFileRefs(graph(ct, { image_url: view('mine.png'), end_image_url: view('theirs.png') }), ctx(['mine.png'])))
      .rejects.toThrow(/input file you do not own/)
    await expect(validateGraphFileRefs(graph(ct, { image_urls: [view('mine.png'), view('theirs.png')] }), ctx(['mine.png'])))
      .rejects.toThrow(/input file you do not own/)
  })

  it('hosted: the caller’s own files are allowed', async () => {
    const opts = { image_urls: [view('a.png')], video_urls: [view('clip.mp4')], audio_urls: [view('voice.mp3')], image_url: view('first.png'), end_image_url: view('last.png') }
    await expect(validateGraphFileRefs(graph(ct, opts), ctx(['a.png', 'clip.mp4', 'voice.mp3', 'first.png', 'last.png']))).resolves.toBeUndefined()
  })

  it('hosted: external https links name no file and are allowed', async () => {
    const opts = { image_urls: ['https://cdn.example.com/a.png'], video_urls: ['https://cdn.example.com/v.mp4'], image_url: 'https://cdn.example.com/f.png' }
    await expect(validateGraphFileRefs(graph(ct, opts), ctx([]))).resolves.toBeUndefined()
    await expect(validateGraphFileRefs(graph(ct, '{}'), ctx([]))).resolves.toBeUndefined()
  })

  it('hosted: a model_options the gate cannot read is refused', async () => {
    await expect(validateGraphFileRefs(graph(ct, '{nope'), ctx([]))).rejects.toThrow(/unexpected shape/)
    await expect(validateGraphFileRefs({ 1: { class_type: ct, inputs: { model_options: ['9', 0] } } }, ctx([]))).rejects.toThrow(/unexpected shape/)
  })
})
