import { describe, it, expect } from 'vitest'
import { createApp, eventHandler, toWebHandler } from 'h3'
import { readUploadedFile } from '~~/server/utils/multipart'

/**
 * Regression cover for the dataset-upload 500 ("Invalid array length").
 *
 * h3's readMultipartFormData parses the body a byte at a time into a plain JS
 * array (`buffer.push(currByte)`). V8 caps a fast-elements array at 2^26
 * entries, so ANY uploaded part over 64 MiB threw RangeError before it ever
 * reached the route. The style trainer zips with STORE (no compression), so a
 * normal photo dataset clears 64 MiB easily.
 */

// Route the request through a real h3 app so the util sees a genuine H3Event.
function webHandlerReading(field?: string) {
  const app = createApp()
  app.use(eventHandler(async (event) => {
    const file = await readUploadedFile(event, field)
    if (!file) return { found: false }
    return {
      found: true,
      size: file.data.byteLength,
      filename: file.filename,
      type: file.type,
      head: [...file.data.subarray(0, 4)],
      tail: [...file.data.subarray(file.data.byteLength - 4)],
    }
  }))
  return toWebHandler(app)
}

function post(body: FormData) {
  return new Request('http://localhost/upload', { method: 'POST', body })
}

// One byte over V8's 2^26 fast-array cap — the exact size that used to throw.
const OVER_ARRAY_CAP = 67_108_864 + 1024

describe('readUploadedFile', () => {
  it('returns the bytes, filename and type of the named part', async () => {
    const fd = new FormData()
    fd.append('file', new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'application/zip' }), 'dataset.zip')

    const res = await webHandlerReading()(post(fd))
    expect(await res.json()).toEqual({
      found: true,
      size: 8,
      filename: 'dataset.zip',
      type: 'application/zip',
      head: [1, 2, 3, 4],
      tail: [5, 6, 7, 8],
    })
  })

  it('reads a part larger than V8\'s 64 MiB array cap without throwing', async () => {
    const bytes = new Uint8Array(OVER_ARRAY_CAP)
    bytes.set([9, 8, 7, 6], 0)
    bytes.set([1, 2, 3, 4], OVER_ARRAY_CAP - 4)

    const fd = new FormData()
    fd.append('file', new Blob([bytes], { type: 'application/zip' }), 'dataset.zip')

    const res = await webHandlerReading()(post(fd))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      found: true,
      size: OVER_ARRAY_CAP,
      filename: 'dataset.zip',
      type: 'application/zip',
      head: [9, 8, 7, 6],
      tail: [1, 2, 3, 4],
    })
  }, 120_000)

  it('ignores other fields and reports a missing part', async () => {
    const fd = new FormData()
    fd.append('notfile', new Blob([new Uint8Array([1])]), 'x.bin')

    const res = await webHandlerReading()(post(fd))
    expect(await res.json()).toEqual({ found: false })
  })

  it('treats an empty part as missing', async () => {
    const fd = new FormData()
    fd.append('file', new Blob([]), 'empty.zip')

    const res = await webHandlerReading()(post(fd))
    expect(await res.json()).toEqual({ found: false })
  })

  it('rejects a body that is not form data with a 400, not a 500', async () => {
    const res = await webHandlerReading()(new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"nope":true}',
    }))
    expect(res.status).toBe(400)
  })

  it('reads a non-default field name', async () => {
    const fd = new FormData()
    fd.append('font', new Blob([new Uint8Array([1, 2, 3, 4])]), 'Inter.ttf')

    const res = await webHandlerReading('font')(post(fd))
    expect((await res.json()).filename).toBe('Inter.ttf')
  })
})

// The helper only protects the routes that use it. Three upload routes stayed on the
// capped reader for seven weeks after it landed; this keeps a fourth from joining them.
describe('no server route calls the capped reader', () => {
  it('readMultipartFormData( appears nowhere under server/', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join, resolve } = await import('node:path')
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [])
    const callers = walk(resolve(__dirname, '../../server'))
      .filter(f => readFileSync(f, 'utf8').split('\n')
        .some(line => !/^\s*(\*|\/\/|\/\*)/.test(line) && /\breadMultipartFormData\s*\(/.test(line)))
    expect(callers).toEqual([])
  })
})
