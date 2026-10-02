/**
 * Stage 5 round-3 security review — R1 + R2 + R4: ownership-scoped overwrite on
 * the hosted /upload sink.
 *
 * ROUND 2 shipped a byte-sniff: any multipart body whose bytes matched
 * /name=(?:"overwrite"|overwrite)/ was refused with a 403. Round 3 found both
 * halves of that wrong.
 *
 * R1 — the sniff is bypassable. aiohttp (the engine's parser) accepts spellings
 * the regex never matched. Measured on THIS repo's aiohttp against the exact
 * bytes below (post.get("overwrite") == "true" in every OK row):
 *
 *     Content-Disposition parameter        aiohttp        undici (ours)
 *     name="overwrite"                     overwrite      overwrite
 *     name ="overwrite"                    overwrite      body REJECTED
 *     name= "overwrite"                    overwrite      body REJECTED
 *     name = "overwrite"                   overwrite      body REJECTED
 *     name*=utf-8''overwrite               overwrite      body REJECTED
 *     name=overwrite                       overwrite      body REJECTED
 *     NAME="overwrite"                     overwrite      body REJECTED
 *     name="over\write"                    overwrite      over\write  (!)
 *
 * So the gate parses instead of scanning, with the project's own parser
 * (server/utils/multipart.ts → undici). Everything undici refuses is a body the
 * two parsers cannot agree about, and is refused with a 400 rather than
 * forwarded — the smuggles never reach the engine either way. The one row where
 * undici succeeds and aiohttp still reads `overwrite` is the backslash escape,
 * so a backslash in ANY part name is refused too: it is the whole remaining
 * divergence surface, and it reaches `subfolder` and `type` as readily as
 * `overwrite` — a body checked against one path and written to another.
 *
 * R2 — refusing the field outright breaks Sailor. Eight app call sites append
 * overwrite=true (Compositor, Inpaint, LoRA trainer, Scene3D, layout agent,
 * canvas drops), nearly all on freshly-minted unique filenames. So the decision
 * is ownership-scoped, not a blanket refusal: your own file, or a name nobody
 * has claimed and nothing on disk answers to.
 *
 * R4 — the body is buffered to be parsed, so it needs an explicit cap.
 *
 * Engine-free Phase A (A4): the gate no longer forwards the body to ComfyUI —
 * the SAME parsed form is written natively (server/native/uploads.ts). The
 * ownership rules below are unchanged; "reached the engine" now reads "was
 * written to the (temp) engine folders".
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The cached engine-health check (server/native/engineHealth.ts) is stubbed:
// its 3 s process-wide cache would otherwise carry one test's engine state
// into the next, and a real probe would reach whatever is on :8188. 'up'
// (the default) defers to each test's own fetch stub, as before the check.
const engineHealthState = vi.hoisted(() => ({ value: 'up' as 'up' | 'down' }))
vi.mock('../../server/native/engineHealth', async orig => ({
  ...(await orig() as object),
  engineHealth: async () => engineHealthState.value,
}))
beforeEach(() => { engineHealthState.value = 'up' })

const rawBody = vi.fn(async () => undefined as Buffer | undefined)
const requestHeader = vi.fn((_e: any, _n: string) => undefined as string | undefined)
vi.mock('h3', async (orig) => {
  const actual = await orig() as any
  return {
    ...actual,
    readRawBody: (...a: any[]) => rawBody(...(a as [])),
    getRequestHeader: (...a: any[]) => requestHeader(...(a as [any, string])),
    setResponseStatus: (_e: any, s: number) => { lastStatus = s },
    setResponseHeader: () => {},
  }
})

let lastStatus = 0

// The on-disk half of the "is this name free?" question. Mocked so the suite
// never depends on what happens to be sitting in the dev engine's input dir.
const existsOnDisk = vi.fn((_p: string) => false)
vi.mock('node:fs', async (orig) => {
  const actual = await orig() as any
  return { ...actual, existsSync: (p: any) => existsOnDisk(String(p)) }
})

let mode: 'local' | 'hosted' = 'local'
vi.mock('../../server/utils/deployMode', () => ({
  deployMode: () => mode,
  isHosted: () => mode === 'hosted',
}))

// Nitro auto-imports the real middleware uses at module scope.
const g = globalThis as any
g.defineEventHandler = (fn: any) => fn
g.createError = (o: { statusCode: number, message?: string, statusMessage?: string }) => {
  const err = new Error(o.message ?? o.statusMessage) as Error & { statusCode: number }
  err.statusCode = o.statusCode
  return err
}
const proxyRequest = vi.fn(async (_e: any, url: string) => ({ proxiedTo: url }))
g.proxyRequest = proxyRequest

const { handleHostedUpload, normalizeFieldName, decideOverwrite, MAX_UPLOAD_BYTES }
  = await import('../../server/utils/engineGate')
const { __setInputUploadsDbForTests, __setInputUploadsEngineRootForTests, canonicalUploadKey }
  = await import('../../server/utils/inputUploads')
const middleware = (await import('../../server/middleware/comfyui-proxy')).default as any

// ---------------------------------------------------------------- fake tables

const owners = new Map<string, string>()
const queries: string[] = []
__setInputUploadsDbForTests({
  async query(sql: string, params: unknown[] = []) {
    queries.push(sql)
    if (/insert\s+into\s+input_uploads/i.test(sql)) {
      const [key, user] = params as string[]
      // ON CONFLICT DO NOTHING — the first owner keeps the name.
      if (!owners.has(key)) owners.set(key, user)
      return { rows: [] }
    }
    if (/select\s+user_id\s+from\s+input_uploads/i.test(sql)) {
      const [key] = params as string[]
      const u = owners.get(key)
      return { rows: u ? [{ user_id: u }] : [] }
    }
    throw new Error(`unexpected sql: ${sql}`)
  },
})

// Nothing here may reach a real engine: uploads are written natively now.
const fetchMock = vi.fn(async () => { throw new Error('uploads must not be forwarded to the engine') })
;(globalThis as any).fetch = fetchMock

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const { tmpdir } = await import('node:os')
let root = ''
/** Every file the upload wrote under the temp engine root, as `type/sub/name`. */
function written(): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string) => {
    for (const e of realFs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(`${d}/${e.name}`, r)
      else out.push(r)
    }
  }
  if (root) walk(root, '')
  return out.sort()
}

beforeEach(() => {
  fetchMock.mockClear()
  if (root) realFs.rmSync(root, { recursive: true, force: true })
  root = realFs.mkdtempSync(`${tmpdir()}/engine-upload-ownership-`)
  for (const d of ['input', 'output', 'temp']) realFs.mkdirSync(`${root}/${d}`)
  rawBody.mockReset()
  requestHeader.mockReset()
  requestHeader.mockReturnValue(`multipart/form-data; boundary=${BOUNDARY}`)
  existsOnDisk.mockReset()
  existsOnDisk.mockReturnValue(false)
  owners.clear()
  queries.length = 0
  lastStatus = 0
  // S2: root resolution also goes through the (mocked) node:fs existsSync,
  // so without an override every test's engine-root marker check would ride
  // the SAME existsOnDisk mock as the on-disk file check above — a test that
  // sets existsOnDisk to false to mean "nothing on disk" would incidentally
  // also make the root unresolvable. Pin a resolved (temp) root by default so
  // these tests keep exercising the on-disk-existence decision they're
  // named for; the dedicated S2 tests below override this back to null. The
  // gate's disk check still rides the existsOnDisk mock; the native write
  // uses stat, so it sees the real temp folders.
  __setInputUploadsEngineRootForTests(root)
})

// ------------------------------------------------------------------- fixtures

const BOUNDARY = '----WebKitFormBoundaryABC'

type Part = { disposition: string, value: string }

function raw(parts: Part[]): Buffer {
  const chunks = parts.map(p =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; ${p.disposition}\r\n\r\n${p.value}\r\n`)
  return Buffer.from(chunks.join('') + `--${BOUNDARY}--\r\n`, 'latin1')
}

/** A browser-shaped upload: one file part plus whatever fields are asked for. */
function upload(o: { filename?: string, fields?: Record<string, string> } = {}): Buffer {
  const parts: Part[] = [{
    disposition: `name="image"; filename="${o.filename ?? 'a.png'}"`,
    value: 'PIXELS',
  }]
  for (const [k, v] of Object.entries(o.fields ?? {})) parts.push({ disposition: `name="${k}"`, value: v })
  return raw(parts)
}

const ev = (path = '/upload/image', userId: string | null = 'u1') => ({ path, context: { userId } }) as any

// --------------------------------------------------------------------- R1

describe('R1 — the overwrite field is found by a parser, not by a byte scan', () => {
  // Every spelling aiohttp resolves to `overwrite` but the round-2 regex missed.
  const SMUGGLES: [string, string][] = [
    ['space before =', `name ="overwrite"`],
    ['space after =', `name= "overwrite"`],
    ['spaces both sides', `name = "overwrite"`],
    ['RFC 2231 extended', `name*=utf-8''overwrite`],
  ]

  for (const [label, disposition] of SMUGGLES) {
    it(`refuses the ${label} smuggle instead of forwarding it — victim owns the name`, async () => {
      owners.set('input::victim.png', 'u2')
      rawBody.mockResolvedValue(raw([
        { disposition: `name="image"; filename="victim.png"`, value: 'PIXELS' },
        { disposition, value: 'true' },
      ]))
      await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 400 })
      expect(written(), 'the smuggle must never be written').toEqual([])
    })

    it(`refuses the ${label} smuggle for the OWNER too — the two parsers disagree about these bytes`, async () => {
      owners.set('input::mine.png', 'u1')
      rawBody.mockResolvedValue(raw([
        { disposition: `name="image"; filename="mine.png"`, value: 'PIXELS' },
        { disposition, value: 'true' },
      ]))
      await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 400 })
      expect(written()).toEqual([])
    })
  }

  it('refuses the backslash-escape divergence, which undici DOES parse', async () => {
    // undici reads this field name as `over\write`; aiohttp un-escapes it to
    // `overwrite` and honours it — the one smuggle that survives a strict parse.
    owners.set('input::victim.png', 'u2')
    rawBody.mockResolvedValue(raw([
      { disposition: `name="image"; filename="victim.png"`, value: 'PIXELS' },
      { disposition: `name="over\\write"`, value: 'true' },
    ]))
    await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 400 })
    expect(written()).toEqual([])
  })

  it('refuses a backslash in ANY field name, not just overwrite', async () => {
    // `sub\folder` is `subfolder` to the engine and an unknown field to us, so
    // the path we check and the path it writes would be different files.
    owners.set('input:clips:victim.png', 'u2')
    rawBody.mockResolvedValue(raw([
      { disposition: `name="image"; filename="victim.png"`, value: 'PIXELS' },
      { disposition: `name="sub\\folder"`, value: 'clips' },
      { disposition: `name="overwrite"`, value: 'true' },
    ]))
    await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 400 })
    expect(written()).toEqual([])
  })

  it('gates on ANY truthy overwrite part, not on the one a lookup would find', async () => {
    // aiohttp's post.get() returns the FIRST occurrence; a decoy `false` after a
    // real `true` (or before it) must not decide this for us either way.
    owners.set('input::victim.png', 'u2')
    for (const values of [['true', 'false'], ['false', 'true']]) {
      rawBody.mockResolvedValue(raw([
        { disposition: `name="image"; filename="victim.png"`, value: 'PIXELS' },
        { disposition: `name="overwrite"`, value: values[0]! },
        { disposition: `name="overwrite"`, value: values[1]! },
      ]))
      await expect(handleHostedUpload(ev()), `values ${values.join(',')}`)
        .rejects.toMatchObject({ statusCode: 403 })
      expect(written()).toEqual([])
    }
  })

  it('normalizeFieldName un-escapes, trims and lowercases', () => {
    expect(normalizeFieldName('over\\write')).toBe('overwrite')
    expect(normalizeFieldName(' OverWrite ')).toBe('overwrite')
    expect(normalizeFieldName('overwrite_note')).toBe('overwrite_note')
  })
})

// --------------------------------------------------------------------- LC3

describe('LC3 — part headers must be canonical, whatever the Node version\'s undici accepts', () => {
  // Node 26's undici 8 parses every one of these without complaint, so "undici
  // refused it" no longer covers them. Each is refused for the OWNER — the
  // case where ownership alone would have let the write through.
  const NON_CANONICAL: [string, string][] = [
    ['unquoted value', `name=overwrite`],
    ['upper-case parameter', `NAME="overwrite"`],
    ['duplicate name parameter (undici takes the last)', `name="note"; name="overwrite"`],
    ['extended parameter after a plain one', `name="note"; name*=utf-8''overwrite`],
    ['unknown extra parameter', `name="overwrite"; size="4"`],
    ['tab instead of space', `name="overwrite";\tfilename="x"`],
  ]
  for (const [label, disposition] of NON_CANONICAL) {
    it(`refuses ${label}`, async () => {
      owners.set('input::mine.png', 'u1')
      rawBody.mockResolvedValue(raw([
        { disposition: `name="image"; filename="mine.png"`, value: 'PIXELS' },
        { disposition, value: 'true' },
      ]))
      await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 400 })
      expect(written()).toEqual([])
    })
  }

  /** A body with hand-written header blocks, for the line-level smuggles. */
  function rawHeaders(parts: { headers: string, value: string }[]): Buffer {
    return Buffer.from(parts.map(p => `--${BOUNDARY}\r\n${p.headers}\r\n\r\n${p.value}\r\n`).join('')
      + `--${BOUNDARY}--\r\n`, 'latin1')
  }
  const IMAGE = { headers: `Content-Disposition: form-data; name="image"; filename="mine.png"`, value: 'PIXELS' }
  const LINE_SMUGGLES: [string, string][] = [
    ['a bare-LF header line (a line reader splitting on \\n sees a second header)',
      `Content-Disposition: form-data; name="note"\nContent-Disposition: form-data; name ="overwrite"`],
    ['two Content-Disposition headers', `Content-Disposition: form-data; name="note"\r\nContent-Disposition: form-data; name="overwrite"`],
    ['a folded header line', `Content-Disposition: form-data;\r\n name="overwrite"`],
    ['a space before the colon', `Content-Disposition : form-data; name="overwrite"`],
    ['a part with no Content-Disposition', `Content-Type: text/plain`],
  ]
  for (const [label, headers] of LINE_SMUGGLES) {
    it(`refuses ${label}`, async () => {
      owners.set('input::mine.png', 'u1')
      rawBody.mockResolvedValue(rawHeaders([IMAGE, { headers, value: 'true' }]))
      await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 400 })
      expect(written()).toEqual([])
    })
  }

  it('refuses a body whose Content-Type names no boundary', async () => {
    requestHeader.mockReturnValue('multipart/form-data')
    rawBody.mockResolvedValue(upload({ filename: 'mine.png' }))
    await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 400 })
    expect(written()).toEqual([])
  })

  it('accepts what a real encoder writes — Node\'s own FormData, non-ASCII and backslash in the filename', async () => {
    const fd = new FormData()
    fd.append('image', new Blob(['PIXELS'], { type: 'image/png' }), 'été a\\b.png')
    fd.append('overwrite', 'false')
    const req = new Request('http://x/upload/image', { method: 'POST', body: fd })
    const ct = req.headers.get('content-type')!
    requestHeader.mockImplementation((_e, n) => n.toLowerCase() === 'content-type' ? ct : undefined)
    rawBody.mockResolvedValue(Buffer.from(await req.arrayBuffer()))
    await handleHostedUpload(ev())
    expect(written()).toHaveLength(1)
  })
})

// --------------------------------------------------------------------- R2

describe('R2 — overwrite is scoped to the owner, not refused outright', () => {
  it('ALLOWS the recorded owner to overwrite their own file', async () => {
    owners.set('input::mine.png', 'u1')
    rawBody.mockResolvedValue(upload({ filename: 'mine.png', fields: { overwrite: 'true' } }))
    existsOnDisk.mockReturnValue(true)

    await handleHostedUpload(ev())
    expect(written()).toEqual(['input/mine.png'])
  })

  it('REFUSES a cross-tenant overwrite with a 403 that names the conflict', async () => {
    owners.set('input::victim.png', 'u2')
    rawBody.mockResolvedValue(upload({ filename: 'victim.png', fields: { overwrite: 'true' } }))

    await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 403 })
    expect(written()).toEqual([])
  })

  it('ALLOWS overwrite of a fresh name — no owner, nothing on disk — and records it', async () => {
    rawBody.mockResolvedValue(upload({ filename: 'agent_gen_123.png', fields: { overwrite: 'true' } }))

    await handleHostedUpload(ev())
    expect(written()).toEqual(['input/agent_gen_123.png'])
    expect(owners.get('input::agent_gen_123.png')).toBe('u1')
  })

  it('REFUSES overwrite of an unclaimed name that ALREADY EXISTS on disk', async () => {
    // Pre-gate uploads carry no ownership row. An existing file with no owner
    // is somebody's — it is not a free name.
    existsOnDisk.mockReturnValue(true)
    rawBody.mockResolvedValue(upload({ filename: 'legacy.png', fields: { overwrite: 'true' } }))

    await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 403 })
    expect(written()).toEqual([])
  })

  it('treats only aiohttp-truthy values as an overwrite request', async () => {
    // server.py: `overwrite == "true" or overwrite == "1"`. Anything else and
    // the engine auto-suffixes, so there is nothing to gate.
    owners.set('input::victim.png', 'u2')
    for (const [i, v] of ['false', '0', 'yes', ''].entries()) {
      // Distinct bytes each time, so the write auto-suffixes instead of
      // answering the identical earlier file.
      rawBody.mockResolvedValue(raw([
        { disposition: 'name="image"; filename="victim.png"', value: `PIXELS${i}` },
        { disposition: 'name="overwrite"', value: v },
      ]))
      await handleHostedUpload(ev())
      expect(written().length, `overwrite=${JSON.stringify(v)} is not an overwrite`).toBe(i + 1)
    }
    for (const v of ['true', '1', 'TRUE', ' true ']) {
      rawBody.mockResolvedValue(upload({ filename: 'victim.png', fields: { overwrite: v } }))
      await expect(handleHostedUpload(ev()), `overwrite=${JSON.stringify(v)} must be gated`)
        .rejects.toMatchObject({ statusCode: 403 })
    }
  })

  it('never gates an upload that declares no overwrite — the engine auto-suffixes', async () => {
    owners.set('input::victim.png', 'u2')
    existsOnDisk.mockReturnValue(true)
    rawBody.mockResolvedValue(upload({ filename: 'victim.png' }))
    await handleHostedUpload(ev())
    expect(written()).toEqual(['input/victim.png'])
  })

  it('keys ownership by type + subfolder, not by filename alone', async () => {
    owners.set('input:clips:v.png', 'u2')
    rawBody.mockResolvedValue(upload({ filename: 'v.png', fields: { subfolder: 'clips', overwrite: 'true' } }))
    await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 403 })

    // Same filename, different subfolder: a different file, not the victim's.
    rawBody.mockResolvedValue(upload({ filename: 'v.png', fields: { subfolder: 'other', overwrite: 'true' } }))
    await handleHostedUpload(ev())
    expect(written()).toEqual(['input/other/v.png'])
  })

  it('decideOverwrite is the whole rule', () => {
    expect(decideOverwrite('u1', 'u1', true)).toBe(true)
    expect(decideOverwrite('u1', 'u2', false)).toBe(false)
    expect(decideOverwrite('u1', null, false)).toBe(true)
    expect(decideOverwrite('u1', null, true)).toBe(false)
  })

  // S2: an unresolvable engine root (see engine-root-resolve.unit.spec.ts)
  // means the disk half of the question is UNKNOWABLE, not "false" — treating
  // it as false would open every unclaimed name to anyone while the server is
  // misconfigured. null must fail closed exactly like existsOnDisk === true.
  it('decideOverwrite fails CLOSED when the disk answer is unknown (root unresolved)', () => {
    expect(decideOverwrite('u1', null, null)).toBe(false)
    // Ownership still wins outright — an unresolved root doesn't relitigate
    // a claim the OWNERSHIP table already answered.
    expect(decideOverwrite('u1', 'u1', null)).toBe(true)
    expect(decideOverwrite('u1', 'u2', null)).toBe(false)
  })
})

// ------------------------------------------------------------------- S1

describe('S1 — the ownership check and the record key are canonicalized the SAME way', () => {
  it('canonicalUploadKey folds an unrecognized type to "input", matching engineDirForType', () => {
    expect(canonicalUploadKey('bogus', '', 'v.png')).toBe(canonicalUploadKey('input', '', 'v.png'))
    expect(canonicalUploadKey(undefined, '', 'v.png')).toBe(canonicalUploadKey('input', '', 'v.png'))
    expect(canonicalUploadKey(null, '', 'v.png')).toBe(canonicalUploadKey('input', '', 'v.png'))
    // output/temp are real engine dirs and must NOT fold into input.
    expect(canonicalUploadKey('output', '', 'v.png')).not.toBe(canonicalUploadKey('input', '', 'v.png'))
    expect(canonicalUploadKey('temp', '', 'v.png')).not.toBe(canonicalUploadKey('input', '', 'v.png'))
  })

  it('canonicalUploadKey folds subfolder "." to "" — same physical directory', () => {
    expect(canonicalUploadKey('input', '.', 'v.png')).toBe(canonicalUploadKey('input', '', 'v.png'))
  })

  it('a real subfolder is left alone — not every alias collapses', () => {
    expect(canonicalUploadKey('input', 'clips', 'v.png')).not.toBe(canonicalUploadKey('input', '', 'v.png'))
  })

  // The exploit shape this closes: a victim's file is recorded under the
  // canonical key, and an attacker's overwrite request uses an alias
  // (type=bogus, or subfolder=".") that the OLD code checked ownership on
  // verbatim — producing a check-key that matched no row, while
  // uploadExistsOnDisk's OWN independent normalization happened to still
  // find the file on disk and deny it. That "protected by luck" chain is
  // exactly what this closes: existsOnDisk is forced to false/unknown-false
  // below, so ONLY a correct ownership-key match can produce the deny.
  for (const alias of [
    { label: 'type=bogus', fields: { type: 'bogus', overwrite: 'true' } },
    { label: 'subfolder=.', fields: { type: 'input', subfolder: '.', overwrite: 'true' } },
  ]) {
    it(`denies a victim-owned file via the OWNERSHIP check under the ${alias.label} alias, even when disk says "not there"`, async () => {
      owners.set(canonicalUploadKey('input', '', 'v.png'), 'victim')
      existsOnDisk.mockReturnValue(false) // disk check alone would say "free"
      rawBody.mockResolvedValue(upload({ filename: 'v.png', fields: alias.fields }))

      await expect(handleHostedUpload(ev('/upload/image', 'attacker')))
        .rejects.toMatchObject({ statusCode: 403 })
      expect(written(), 'the clobber must never be written').toEqual([])
    })
  }

  it('the OWNER themself can still overwrite under an alias — canonicalization is symmetric', async () => {
    owners.set(canonicalUploadKey('input', '', 'mine.png'), 'u1')
    rawBody.mockResolvedValue(upload({ filename: 'mine.png', fields: { subfolder: '.', overwrite: 'true' } }))
    await handleHostedUpload(ev('/upload/image', 'u1'))
    expect(written()).toEqual(['input/mine.png'])

    // type=bogus passes the gate too; the native write then refuses the
    // unknown type itself (the Python crashed on it), writing nothing new.
    rawBody.mockResolvedValue(upload({ filename: 'mine.png', fields: { type: 'bogus', overwrite: 'true' } }))
    await handleHostedUpload(ev('/upload/image', 'u1'))
    expect(lastStatus).toBe(400)
    expect(written()).toEqual(['input/mine.png'])
  })

  it('the post-response record is canonicalized too, so a later alias check matches it', async () => {
    rawBody.mockResolvedValue(upload({ filename: 'fresh.png', fields: { subfolder: '.', overwrite: 'true' } }))

    expect(await handleHostedUpload(ev('/upload/image', 'u1'))).toEqual({ name: 'fresh.png', subfolder: '.', type: 'input' })
    expect(owners.get(canonicalUploadKey('input', '', 'fresh.png'))).toBe('u1')
  })
})

// ------------------------------------------------------------------- S2

describe('S2 — the overwrite path fails CLOSED when the engine root cannot be resolved', () => {
  it('refuses an overwrite with a 403 naming the misconfiguration, not the generic ownership message', async () => {
    __setInputUploadsEngineRootForTests(null)
    rawBody.mockResolvedValue(upload({ filename: 'anything.png', fields: { overwrite: 'true' } }))

    await expect(handleHostedUpload(ev('/upload/image', 'u1')))
      .rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/engine|configur/i) })
    expect(written()).toEqual([])
  })

  it('an OWNED file still overwrites fine even with the root unresolved — ownership never needed the disk', async () => {
    __setInputUploadsEngineRootForTests(null)
    owners.set(canonicalUploadKey('input', '', 'mine.png'), 'u1')
    rawBody.mockResolvedValue(upload({ filename: 'mine.png', fields: { overwrite: 'true' } }))

    // Past the gate; the write itself then has no folder to go to.
    await handleHostedUpload(ev('/upload/image', 'u1'))
    expect(lastStatus).toBe(503)
  })
})

// ------------------------------------------------------------- recording

describe('ownership is recorded from the name actually stored', () => {
  it('records the auto-suffixed name the write actually stored', async () => {
    realFs.writeFileSync(`${root}/input/shot.png`, 'someone else')
    rawBody.mockResolvedValue(upload({ filename: 'shot.png' }))

    await handleHostedUpload(ev())
    expect(written()).toEqual(['input/shot (1).png', 'input/shot.png'])
    expect(owners.get('input::shot (1).png')).toBe('u1')
    expect(owners.has('input::shot.png'), 'the REQUESTED name was never written').toBe(false)
  })

  it('records subfolder and type from the response too', async () => {
    rawBody.mockResolvedValue(upload({ filename: 'm.png', fields: { type: 'temp', subfolder: 'clips' } }))
    await handleHostedUpload(ev())
    expect(written()).toEqual(['temp/clips/m.png'])
    expect(owners.get('temp:clips:m.png')).toBe('u1')
  })

  it('keeps the FIRST owner on conflict', async () => {
    owners.set('input::a.png', 'u2')
    rawBody.mockResolvedValue(upload({ filename: 'a.png' }))
    await handleHostedUpload(ev('/upload/image', 'u1'))
    expect(owners.get('input::a.png')).toBe('u2')
  })

  it('records nothing when the upload was not accepted', async () => {
    rawBody.mockResolvedValue(raw([{ disposition: 'name="type"', value: 'input' }]))
    expect(await handleHostedUpload(ev())).toBe('')
    expect(lastStatus).toBe(400)
    expect(owners.size).toBe(0)
  })
})

// --------------------------------------------------------------------- R4

describe('R4 — the buffered body has an explicit cap', () => {
  it('rejects an over-cap Content-Length with 413 before reading or parsing', async () => {
    requestHeader.mockImplementation((_e: any, n: string) =>
      n === 'content-length' ? String(MAX_UPLOAD_BYTES + 1) : `multipart/form-data; boundary=${BOUNDARY}`)
    await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 413 })
    expect(rawBody, 'must not buffer a body it has already refused').not.toHaveBeenCalled()
    expect(written()).toEqual([])
  })

  it('rejects an over-cap body that lied about its length', async () => {
    rawBody.mockResolvedValue(Buffer.alloc(MAX_UPLOAD_BYTES + 1))
    await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 413 })
    expect(written()).toEqual([])
  })

  it('caps at 100 MiB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024)
  })
})

// ------------------------------------------------------------- path safety

describe('the ownership key can never be built from a traversing path', () => {
  const BAD = [
    { filename: '../../secret.png' },
    { filename: 'a/../../secret.png' },
    { filename: '/etc/passwd' },
    { filename: 'a\\b.png' },
    { filename: 'x.png', fields: { subfolder: '../..' } },
    { filename: 'x.png', fields: { subfolder: '/abs' } },
    { filename: 'x.png', fields: { subfolder: 'a\\b' } },
  ]
  for (const c of BAD) {
    it(`400s ${JSON.stringify(c)}`, async () => {
      rawBody.mockResolvedValue(upload({ ...c, fields: { ...(c.fields ?? {}), overwrite: 'true' } }))
      await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 400 })
      expect(written()).toEqual([])
    })
  }

  it('allows an ordinary nested subfolder', async () => {
    rawBody.mockResolvedValue(upload({ filename: 'a.png', fields: { subfolder: 'clips/2026', overwrite: 'true' } }))
    await handleHostedUpload(ev())
    expect(written()).toEqual(['input/clips/2026/a.png'])
  })
})

// ------------------------------------------------------------ the write

describe('the parser decides, and the parsed form is what gets written', () => {
  it('writes the checked upload natively, byte for byte, and never forwards it', async () => {
    rawBody.mockResolvedValue(upload({ filename: 'a.png', fields: { overwrite: 'true' } }))
    await handleHostedUpload(ev())
    expect(realFs.readFileSync(`${root}/input/a.png`, 'utf8')).toBe('PIXELS')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the request body exactly once', async () => {
    rawBody.mockResolvedValue(upload())
    await handleHostedUpload(ev())
    expect(rawBody).toHaveBeenCalledTimes(1)
  })

  it('serves every spelling of the two routes, pool worker included, and 404s the rest', async () => {
    for (const [i, p] of ['/upload/image?comfyWorker=2', '/comfyui/upload/image', '/api/upload/image', '/comfyui/api/upload/image'].entries()) {
      rawBody.mockResolvedValue(upload({ filename: `w${i}.png` }))
      await handleHostedUpload(ev(p))
      expect(lastStatus, p).toBe(200)
    }
    expect(written()).toEqual(['input/w0.png', 'input/w1.png', 'input/w2.png', 'input/w3.png'])

    rawBody.mockResolvedValue(upload({ filename: 'x.png' }))
    expect(await handleHostedUpload(ev('/upload/elsewhere'))).toBe('404: Not Found')
    expect(lastStatus).toBe(404)
    expect(written()).toHaveLength(4)
  })

  it('refuses /upload/mask in hosted mode with a 403, before the body is read (controller ruling)', async () => {
    // original_ref can name any tenant's output; the masked copy would be
    // written under the caller's name.
    for (const p of ['/upload/mask', '/api/upload/mask', '/comfyui/upload/mask?comfyWorker=1', '/comfyui/api/upload/mask']) {
      rawBody.mockClear()
      rawBody.mockResolvedValue(raw([
        { disposition: 'name="image"; filename="m.png"', value: 'PIXELS' },
        { disposition: 'name="original_ref"', value: '{"filename":"victim.png","type":"output"}' },
      ]))
      await expect(handleHostedUpload(ev(p)), p).rejects.toMatchObject({ statusCode: 403, message: 'Mask uploads are not available in hosted mode' })
      expect(rawBody, `${p}: refused before the body is read`).not.toHaveBeenCalled()
    }
    expect(written()).toEqual([])
    expect(queries).toEqual([])
  })

  it('returns the write\'s status and body', async () => {
    rawBody.mockResolvedValue(upload())
    const out = await handleHostedUpload(ev())
    expect(out).toEqual({ name: 'a.png', subfolder: '', type: 'input' })
    expect(lastStatus).toBe(200)
  })

  it('requires a session', async () => {
    await expect(handleHostedUpload(ev('/upload/image', null))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('400s a body that is not multipart at all', async () => {
    rawBody.mockResolvedValue(Buffer.from('{"json":true}'))
    requestHeader.mockImplementation((_e: any, n: string) => n === 'content-type' ? 'application/json' : undefined)
    await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 400 })
    expect(written()).toEqual([])
  })
})

// ------------------------------------------------------------------ local

describe('local mode — no table, no gate (single user)', () => {
  it('writes POST /upload/image WITH overwrite=true natively, never proxying', async () => {
    mode = 'local'
    proxyRequest.mockClear()
    realFs.writeFileSync(`${root}/input/victim.png`, 'old')
    rawBody.mockResolvedValue(upload({ filename: 'victim.png', fields: { overwrite: 'true' } }))
    owners.set('input::victim.png', 'someone-else')

    const out = await middleware({ path: '/upload/image', method: 'POST', context: {} })
    expect(out).toEqual({ name: 'victim.png', subfolder: '', type: 'input' })
    expect(realFs.readFileSync(`${root}/input/victim.png`, 'utf8')).toBe('PIXELS')
    expect(proxyRequest).not.toHaveBeenCalled()
    expect(queries, 'the local path never touches the ownership table').toEqual([])
    mode = 'hosted'
  })
})

afterAll(() => { if (root) realFs.rmSync(root, { recursive: true, force: true }) })

// ------------------------------------------------------- R11.9c fix round 2

describe('R11.9c fix round 2 (N3): a shader bake folder takes only the bake’s own frames', () => {
  const FRAME = `shader_bake_${'a'.repeat(32)}.png`
  const FOLDER = `shader_bake/${'b'.repeat(32)}`
  it('a frame named as the bake names it is written', async () => {
    rawBody.mockResolvedValue(upload({ filename: FRAME, fields: { subfolder: FOLDER, overwrite: 'true' } }))
    await handleHostedUpload(ev())
    expect(written()).toContain(`input/${FOLDER}/${FRAME}`)
  })
  it('anything else (a .claimed marker, another name), by any spelling of the folder, is refused before disk', async () => {
    for (const [filename, subfolder] of [['.claimed', FOLDER], ['a.png', FOLDER], ['.claimed', ` ./${FOLDER}/ `], ['x.png', 'shader_bake'], ['x.png', `other/../${FOLDER}`], ['x.png', FOLDER.replace('/', '\\')]] as const) {
      rawBody.mockResolvedValue(upload({ filename, fields: { subfolder } }))
      await expect(handleHostedUpload(ev()), `${subfolder} ${filename}`).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(written()).toEqual([])
  })
  it('fix round 3 (B2): a bake given up takes no more frames (its tombstone), before disk', async () => {
    realFs.mkdirSync(`${root}/input/shader_bake/.abandoned`, { recursive: true })
    realFs.writeFileSync(`${root}/input/shader_bake/.abandoned/${'b'.repeat(32)}`, '')
    rawBody.mockResolvedValue(upload({ filename: FRAME, fields: { subfolder: FOLDER, overwrite: 'true' } }))
    await expect(handleHostedUpload(ev())).rejects.toMatchObject({ statusCode: 409 })
    expect(written()).toEqual([`input/shader_bake/.abandoned/${'b'.repeat(32)}`])
  })
})
