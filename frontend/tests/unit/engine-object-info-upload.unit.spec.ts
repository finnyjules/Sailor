/**
 * Stage 5 round-2 security review — F2 and F4.
 *
 * F2: GET /object_info was on the hosted raw allowlist because it "looks
 * static". It is not. ComfyUI builds the LoadImage-family combos by LISTING
 * the input directory, which is shared across tenants until Stage 6 — so every
 * hosted user could read every other user's uploaded filenames, which are also
 * exactly the keys /view checks ownership against. The canvas genuinely needs
 * this endpoint (direct execution's graphToPrompt validates against these
 * schemas client-side), so the response is scrubbed rather than refused.
 *
 * R3 (round 3): emptying the filename LIST is not the whole leak. ComfyUI seeds
 * a COMBO's `default` from the first entry of the same directory listing, so
 * AudioWaveform.audio_file still carried the alphabetically-first filename in
 * the shared input dir after the round-2 scrub.
 *
 * F4 moved out to engine-upload-ownership.unit.spec.ts when the blanket
 * overwrite refusal became an ownership check.
 *
 * The fixture is a REAL /object_info capture (trimmed filename lists) from the
 * dev engine, so it carries the shapes ComfyUI actually emits rather than the
 * one shape a scrubber author would imagine.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { scrubObjectInfo, handleHostedObjectInfo } = await import('../../server/utils/engineGate')
const { ownedInputFilenames, canonicalUploadKey, recordUpload, __setInputUploadsDbForTests } = await import('../../server/utils/inputUploads')

const FIXTURE = fileURLToPath(new URL('./fixtures/object-info-sample.json', import.meta.url))
const catalogText = readFileSync(FIXTURE, 'utf8')
const catalog = () => JSON.parse(catalogText)

const fetchMock = vi.fn()
;(globalThis as any).fetch = fetchMock
// The engine's answer as a real Response: objectInfo.ts reads its exact text.
const engineOk = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

// Default fake input_uploads db: nobody owns anything. handleHostedObjectInfo
// now calls ownedInputFilenames on every request, so every test in this file
// needs SOME db behind it (a real one requires DATABASE_URL, which unit tests
// never set) — individual describe blocks below override this with their own
// Map-backed fake to exercise Stage 6 refilling.
const emptyUploadsDb = { query: async () => ({ rows: [] as { file_key: string }[] }) }
__setInputUploadsDbForTests(emptyUploadsDb)

beforeEach(() => { fetchMock.mockReset() })

// NB: pass `null` for the no-session case — an explicit `undefined` would
// silently fall back to the default parameter and test a signed-in user.
const ev = (path: string, userId: string | null = 'u1') => ({ path, context: { userId } }) as any

// ------------------------------------------------------------------ F2 pure

describe('scrubObjectInfo — the shared input directory never leaves the server', () => {
  it('empties the LEGACY [[files], {image_upload}] combo', () => {
    const before = catalog()
    expect(before.LoadImage.input.required.image[0].length).toBeGreaterThan(0)

    const after = scrubObjectInfo(before) as any
    expect(after.LoadImage.input.required.image[0]).toEqual([])
    expect(after.LoadImageMask.input.required.image[0]).toEqual([])
  })

  it('empties the V2 ["COMBO", {options: [files], *_upload}] combo', () => {
    // The shape a scrubber that only knows the documented tuple form misses
    // entirely — audio/video/3D pickers moved to `options` inside the dict.
    const before = catalog()
    expect(before.LoadAudio.input.required.audio[1].options.length).toBeGreaterThan(0)
    expect(before.LoadVideo.input.required.file[1].options.length).toBeGreaterThan(0)

    const after = scrubObjectInfo(before) as any
    expect(after.LoadAudio.input.required.audio[1].options).toEqual([])
    expect(after.LoadVideo.input.required.file[1].options).toEqual([])
  })

  it('leaks no filename from the real capture anywhere in the scrubbed payload', () => {
    const before = catalog()
    const names = [
      ...before.LoadImage.input.required.image[0],
      ...before.LoadImageMask.input.required.image[0],
      ...before.LoadAudio.input.required.audio[1].options,
      ...before.LoadVideo.input.required.file[1].options,
    ]
    expect(names.length).toBeGreaterThan(0)

    const serialized = JSON.stringify(scrubObjectInfo(before))
    for (const n of names) expect(serialized, `leaked ${n}`).not.toContain(n)
  })

  it('R3 — blanks the DEFAULT, which carries a filename of its own', () => {
    // A real capture: ComfyUI seeds this default with options[0], so the round-2
    // scrubber emptied the list and shipped "Happiness.mp3" anyway.
    const before = catalog()
    const leaked = before.AudioWaveform.input.required.audio_file[1].default
    expect(leaked, 'fixture must carry a real leaking default').toBeTruthy()
    expect(before.AudioWaveform.input.required.audio_file[1].options).toContain(leaked)

    const after = scrubObjectInfo(before) as any
    expect(after.AudioWaveform.input.required.audio_file[1].default).toBe('')
    expect(JSON.stringify(after), `leaked ${leaked}`).not.toContain(leaked)
  })

  it('R3 — leaves defaults on NON-upload widgets alone', () => {
    const before = catalog()
    const after = scrubObjectInfo(before) as any
    expect(after.AudioWaveform.input.required.width).toEqual(before.AudioWaveform.input.required.width)
    expect(after.CLIPTextEncode).toEqual(before.CLIPTextEncode)
  })

  it('PRESERVES the upload flags — the widget must still be an upload widget', () => {
    const after = scrubObjectInfo(catalog()) as any
    expect(after.LoadImage.input.required.image[1].image_upload).toBe(true)
    expect(after.LoadAudio.input.required.audio[1].audio_upload).toBe(true)
    expect(after.LoadVideo.input.required.file[1].video_upload).toBe(true)
  })

  it('leaves every non-upload combo and node schema byte-identical', () => {
    // graphToPrompt validates against these client-side: drop or reorder a
    // node definition and every hosted render breaks.
    const before = catalog()
    const after = scrubObjectInfo(before) as any

    expect(Object.keys(after)).toEqual(Object.keys(before))
    // Same node, two combos: one is an upload picker, one is a plain enum.
    expect(after.LoadImageMask.input.required.channel).toEqual(before.LoadImageMask.input.required.channel)
    expect(after.LatentUpscale).toEqual(before.LatentUpscale)
    expect(after.CLIPTextEncode).toEqual(before.CLIPTextEncode)
    // Flag present but no inline list — must be untouched, not crashed on.
    expect(after.Painter).toEqual(before.Painter)
    expect(after.LoadImageOutput).toEqual(before.LoadImageOutput)
    // Everything on the scrubbed nodes except the filename array survives.
    expect(after.LoadImage.output).toEqual(before.LoadImage.output)
    expect(after.LoadImage.input_order).toEqual(before.LoadImage.input_order)
    expect(Object.keys(after.LoadImage)).toEqual(Object.keys(before.LoadImage))
  })

  it('does not mutate its input', () => {
    const before = catalog()
    scrubObjectInfo(before)
    expect(before.LoadImage.input.required.image[0].length).toBeGreaterThan(0)
  })

  it('survives malformed catalogs rather than 500-ing the canvas', () => {
    expect(scrubObjectInfo(null)).toBe(null)
    expect(scrubObjectInfo({ N: {} })).toEqual({ N: {} })
    expect(scrubObjectInfo({ N: { input: null } })).toEqual({ N: { input: null } })
    expect(scrubObjectInfo({ N: { input: { required: 'nope' } } })).toEqual({ N: { input: { required: 'nope' } } })
  })
})

// ------------------------------------------------- Stage 6 Task 6 — refill

describe('scrubObjectInfo(catalog, ownedFilenames) — refills with the CALLER\'s own uploads', () => {
  it('refills the LEGACY [[files], {image_upload}] combo with exactly the owned list', () => {
    const before = catalog()
    const after = scrubObjectInfo(before, ['mine.png', 'also-mine.png']) as any
    expect(after.LoadImage.input.required.image[0]).toEqual(['mine.png', 'also-mine.png'])
    expect(after.LoadImageMask.input.required.image[0]).toEqual(['mine.png', 'also-mine.png'])
  })

  it('refills the V2 ["COMBO", {options}] combo with exactly the owned list', () => {
    const before = catalog()
    const after = scrubObjectInfo(before, ['mine.mp3']) as any
    expect(after.LoadAudio.input.required.audio[1].options).toEqual(['mine.mp3'])
    expect(after.LoadVideo.input.required.file[1].options).toEqual(['mine.mp3'])
  })

  it('never leaks another tenant\'s filename from the real capture while refilling', () => {
    const before = catalog()
    const othersNames = [
      ...before.LoadImage.input.required.image[0],
      ...before.LoadImageMask.input.required.image[0],
      ...before.LoadAudio.input.required.audio[1].options,
      ...before.LoadVideo.input.required.file[1].options,
      before.AudioWaveform.input.required.audio_file[1].default,
    ]
    expect(othersNames.length).toBeGreaterThan(0)

    const serialized = JSON.stringify(scrubObjectInfo(before, ['caller-owned.png']))
    for (const n of othersNames) expect(serialized, `leaked ${n}`).not.toContain(n)
    expect(serialized).toContain('caller-owned.png')
  })

  it('empty ownership still empties the list — today\'s (Stage 5) behavior, now explicit', () => {
    const before = catalog()
    const after = scrubObjectInfo(before, []) as any
    expect(after.LoadImage.input.required.image[0]).toEqual([])
    expect(after.LoadAudio.input.required.audio[1].options).toEqual([])
  })

  it('omitting the second argument still empties the list (default = [])', () => {
    const after = scrubObjectInfo(catalog()) as any
    expect(after.LoadImage.input.required.image[0]).toEqual([])
  })

  it('default becomes the FIRST owned filename, not the engine\'s own alphabetical pick', () => {
    const before = catalog()
    const after = scrubObjectInfo(before, ['owned-first.mp3', 'owned-second.mp3']) as any
    expect(after.AudioWaveform.input.required.audio_file[1].default).toBe('owned-first.mp3')
  })

  it('default blanks when the caller owns nothing', () => {
    const after = scrubObjectInfo(catalog(), []) as any
    expect(after.AudioWaveform.input.required.audio_file[1].default).toBe('')
  })

  it('the Stage-5 AudioWaveform/Happiness.mp3 default-leak fixture now shows the OWNED file only', () => {
    const before = catalog()
    const leaked = before.AudioWaveform.input.required.audio_file[1].default
    expect(leaked, 'fixture must carry a real leaking default').toBeTruthy()

    const after = scrubObjectInfo(before, ['owned.mp3']) as any
    expect(after.AudioWaveform.input.required.audio_file[1].options).toEqual(['owned.mp3'])
    expect(after.AudioWaveform.input.required.audio_file[1].default).toBe('owned.mp3')
    expect(JSON.stringify(after), `leaked ${leaked}`).not.toContain(leaked)
  })

  it('all non-file data on a refilled node stays byte-identical', () => {
    const before = catalog()
    const after = scrubObjectInfo(before, ['mine.png']) as any
    expect(after.LoadImage.output).toEqual(before.LoadImage.output)
    expect(after.LoadImage.input_order).toEqual(before.LoadImage.input_order)
    expect(after.LoadImage.input.required.image[1].image_upload).toBe(true)
    expect(after.CLIPTextEncode).toEqual(before.CLIPTextEncode)
  })

  it('does not mutate its input, and does not alias the owned-filenames array across specs', () => {
    const before = catalog()
    const owned = ['mine.png']
    const after = scrubObjectInfo(before, owned) as any
    expect(before.LoadImage.input.required.image[0].length).toBeGreaterThan(0)
    // Two different specs refilled from the same `owned` list must not share
    // one array reference — mutating one picker's list must not touch another's.
    expect(after.LoadImage.input.required.image[0]).not.toBe(after.LoadImageMask.input.required.image[0])
    after.LoadImage.input.required.image[0].push('sneaky.png')
    expect(after.LoadImageMask.input.required.image[0]).toEqual(['mine.png'])
    expect(owned).toEqual(['mine.png'])
  })
})

// ------------------------------------------------- Stage 6 Task 6 — ownedInputFilenames

describe('ownedInputFilenames — flat top-level input:: keys, prefix stripped', () => {
  afterEach(() => { __setInputUploadsDbForTests(emptyUploadsDb) })

  it('selects only this user\'s rows, strips the input:: prefix, excludes subfoldered keys', async () => {
    const rows = [
      { file_key: 'input::b.png' },
      { file_key: 'input::a.png' },
      { file_key: 'input:sub:c.png' }, // non-empty subfolder → excluded (not top-level)
      { file_key: 'output::d.png' }, // different kind entirely → excluded
    ]
    const queries: { sql: string, params: unknown[] }[] = []
    __setInputUploadsDbForTests({
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params })
        return { rows }
      },
    })

    const names = await ownedInputFilenames('u1')
    expect(names).toEqual(new Set(['a.png', 'b.png']))
    // SQL filter correctness: user-scoped, flat input:: keys only.
    expect(queries[0]!.sql).toMatch(/user_id\s*=\s*\$1/i)
    expect(queries[0]!.sql).toMatch(/file_key\s+LIKE\s+'input::%'/i)
    expect(queries[0]!.params).toEqual(['u1'])
  })

  it('returns an empty set for a user who owns nothing', async () => {
    __setInputUploadsDbForTests({ async query() { return { rows: [] } } })
    expect(await ownedInputFilenames('nobody')).toEqual(new Set())
  })
})

// --------------------------------------------------------------- F2 handler

describe('handleHostedObjectInfo', () => {
  it('scrubs what the engine returns', async () => {
    fetchMock.mockImplementation(async () => engineOk(catalog()))
    const out = await handleHostedObjectInfo(ev('/object_info')) as any
    expect(out.LoadImage.input.required.image[0]).toEqual([])
    expect(out.LatentUpscale).toEqual(catalog().LatentUpscale)
  })

  it('scrubs the single-node form too (/object_info/LoadImage)', async () => {
    fetchMock.mockImplementation(async () => engineOk({ LoadImage: catalog().LoadImage }))
    const out = await handleHostedObjectInfo(ev('/object_info/LoadImage')) as any
    expect(out.LoadImage.input.required.image[0]).toEqual([])
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8188/object_info/LoadImage')
  })

  it('strips the /comfyui base like the raw proxy did', async () => {
    fetchMock.mockImplementation(async () => engineOk(catalog()))
    await handleHostedObjectInfo(ev('/comfyui/object_info'))
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8188/object_info')
  })

  it('requires a session, and still scrubs when the engine fails (A5: stored catalog served)', async () => {
    await expect(handleHostedObjectInfo(ev('/object_info', null))).rejects.toMatchObject({ statusCode: 401 })
    // Engine-free Phase A: an engine failure no longer 502s — the committed
    // baseline is served (native-object-info.unit.spec.ts covers the 502 when
    // nothing at all is stored), and the scrub still applies to it.
    fetchMock.mockResolvedValue({ ok: false })
    const out = await handleHostedObjectInfo(ev('/object_info')) as any
    expect(out.LoadImage.input.required.image[0]).toEqual([])
    expect(out.KSampler).toBeTruthy()
  })
})

// ------------------------------------------------- Stage 6 Task 6 — refill, end to end

describe('handleHostedObjectInfo — refills the pickers with the CALLER\'s own uploads', () => {
  afterEach(() => { __setInputUploadsDbForTests(emptyUploadsDb) })

  it('lists only the caller\'s own filename in LoadImage\'s combo, sorted', async () => {
    __setInputUploadsDbForTests({
      async query(sql: string, params: unknown[] = []) {
        if (/select\s+file_key\s+from\s+input_uploads/i.test(sql)) {
          const [user] = params as string[]
          return { rows: user === 'u1' ? [{ file_key: 'input::z.png' }, { file_key: 'input::a.png' }] : [] }
        }
        throw new Error(`unexpected sql: ${sql}`)
      },
    })
    fetchMock.mockImplementation(async () => engineOk(catalog()))

    const out = await handleHostedObjectInfo(ev('/object_info', 'u1')) as any
    expect(out.LoadImage.input.required.image[0]).toEqual(['a.png', 'z.png'])
  })

  it('another user\'s uploads never appear, even when someone else owns files', async () => {
    __setInputUploadsDbForTests({
      async query(sql: string, params: unknown[] = []) {
        if (/select\s+file_key\s+from\s+input_uploads/i.test(sql)) {
          const [user] = params as string[]
          return { rows: user === 'u1' ? [{ file_key: 'input::mine.png' }] : [] }
        }
        throw new Error(`unexpected sql: ${sql}`)
      },
    })
    fetchMock.mockImplementation(async () => engineOk(catalog()))

    const out = await handleHostedObjectInfo(ev('/object_info', 'u2')) as any
    expect(out.LoadImage.input.required.image[0]).toEqual([])
    expect(JSON.stringify(out)).not.toContain('mine.png')
  })

  it('integration-shaped: a file uploaded via recordUpload appears in the combo on the very next fetch', async () => {
    const uploads = new Map<string, string>()
    __setInputUploadsDbForTests({
      async query(sql: string, params: unknown[] = []) {
        if (/insert\s+into\s+input_uploads/i.test(sql)) {
          const [key, user] = params as string[]
          if (!uploads.has(key)) uploads.set(key, user)
          return { rows: [] }
        }
        if (/select\s+file_key\s+from\s+input_uploads/i.test(sql)) {
          const [user] = params as string[]
          return { rows: [...uploads.entries()].filter(([, u]) => u === user).map(([file_key]) => ({ file_key })) }
        }
        throw new Error(`unexpected sql: ${sql}`)
      },
    })

    // The upload gate records ownership under the ENGINE's stored name — same
    // call recordUpload makes from handleHostedUpload's success path.
    await recordUpload('u1', canonicalUploadKey('input', '', 'freshly-uploaded.png'))

    fetchMock.mockImplementation(async () => engineOk(catalog()))
    const mine = await handleHostedObjectInfo(ev('/object_info', 'u1')) as any
    expect(mine.LoadImage.input.required.image[0]).toEqual(['freshly-uploaded.png'])

    const other = await handleHostedObjectInfo(ev('/object_info', 'u2')) as any
    expect(other.LoadImage.input.required.image[0]).toEqual([])
  })
})
