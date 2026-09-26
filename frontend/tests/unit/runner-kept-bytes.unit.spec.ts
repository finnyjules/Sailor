// frontend/tests/unit/runner-kept-bytes.unit.spec.ts
/**
 * R0.2: bytes the runner makes itself, kept per run by their sha256, and the
 * one reader that serves them beside the store's files.
 */
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KEPT_GONE, createFileKeptBytes, createMemoryKeptBytes } from '~~/server/runner/keptBytes'
import { createFileAccess } from '~~/server/runner/fileAccess'
import { createEngineResultStore } from '~~/server/runner/results'
import { sha256Hex } from '~~/server/runner/handoff'

const RUN = 'run_00000000-0000-4000-8000-000000000001'
const bytes = new TextEncoder().encode('a picture')

describe('createFileKeptBytes', () => {
  it('keeps bytes once by their sha256, under the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kept-'))
    const kept = createFileKeptBytes(dir)
    const a = await kept.put(RUN, bytes, 'png')
    const b = await kept.put(RUN, bytes, 'png')
    expect(a).toEqual({ filename: `${sha256Hex(bytes)}.png`, subfolder: RUN, type: 'kept' })
    expect(b).toEqual(a)
    expect(readdirSync(join(dir, RUN))).toEqual([`${sha256Hex(bytes)}.png`])
    expect(await kept.read(a)).toEqual(bytes)
    expect(await kept.exists(a)).toBe(true)
    expect(await kept.size(a)).toBe(bytes.length)
  })
  it('says plainly when kept bytes are gone or no longer match their name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kept-'))
    const kept = createFileKeptBytes(dir)
    const a = await kept.put(RUN, bytes, 'png')
    writeFileSync(join(dir, RUN, a.filename), 'tampered')
    await expect(kept.read(a)).rejects.toThrow(KEPT_GONE)
    await expect(kept.read({ ...a, filename: `${'0'.repeat(64)}.png` })).rejects.toThrow(KEPT_GONE)
    expect(await kept.exists({ ...a, filename: `${'0'.repeat(64)}.png` })).toBe(false)
  })
  it('refuses names that are not a kept name, and runs that are not a run id', async () => {
    const kept = createFileKeptBytes(mkdtempSync(join(tmpdir(), 'kept-')))
    await expect(kept.put('../x', bytes, 'png')).rejects.toThrow()
    await expect(kept.read({ filename: '../a.png', subfolder: RUN, type: 'kept' })).rejects.toThrow(KEPT_GONE)
    await expect(kept.read({ filename: `${sha256Hex(bytes)}.png`, subfolder: '..', type: 'kept' })).rejects.toThrow(KEPT_GONE)
  })
  it('lets go of runs no longer in progress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kept-'))
    const kept = createFileKeptBytes(dir)
    const other = 'run_00000000-0000-4000-8000-000000000002'
    await kept.put(RUN, bytes, 'png')
    await kept.put(other, bytes, 'png')
    await kept.keepOnly(new Set([RUN]))
    expect(readdirSync(dir)).toEqual([RUN])
  })
  it('works the same in memory', async () => {
    const kept = createMemoryKeptBytes()
    const a = await kept.put(RUN, bytes, 'glb')
    expect(a.filename).toBe(`${sha256Hex(bytes)}.glb`)
    expect(await kept.read(a)).toEqual(bytes)
    await kept.keepOnly(new Set())
    await expect(kept.read(a)).rejects.toThrow(KEPT_GONE)
  })
})

describe('createFileAccess', () => {
  it('reads kept bytes from the kept store and every other file from the result store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'root-'))
    for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t))
    writeFileSync(join(root, 'input', 'a.png'), 'input bytes')
    const results = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => false })
    const kept = createMemoryKeptBytes()
    const files = createFileAccess(results, kept)
    const k = await kept.put(RUN, bytes, 'png')
    expect(await files.read(k)).toEqual(bytes)
    expect(new TextDecoder().decode(await files.read({ filename: 'a.png', subfolder: '', type: 'input' }))).toBe('input bytes')
    expect(await files.exists(k)).toBe(true)
    expect(await files.size({ filename: 'a.png', subfolder: '', type: 'input' })).toBe(11)
    expect(await files.size({ filename: 'nope.png', subfolder: '', type: 'input' })).toBeNull()
  })
})
