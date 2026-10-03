/**
 * Step 4, C7 — the Python oracles, frozen.
 *
 * A few parity specs used to run ComfyUI's own Python handlers (lifted out of
 * server.py and comfy_extras/ and served by aiohttp) next to Sailor's native
 * ones, over the same temp data root. Python left the repo in C7, so each
 * oracle's answers were recorded once, at the last commit that still held the
 * Python (every parity spec green there), into a fixture beside the spec:
 *
 *   - the answers, with the temp root written as `<ROOT>`;
 *   - every file the Python wrote, changed or removed under that root (the
 *     root written as `<ROOT>` inside them too), with the modification times
 *     it left;
 *   - a hash of the calls, so a spec that changes its calls fails loudly here
 *     instead of comparing against answers to other questions.
 *
 * `frozenOracle(file)` returns a stand-in for the old `python(root, calls)`:
 * it checks the calls against the hash, replays the Python's file changes
 * under today's root, and returns the Python's answers. Nothing here runs or
 * needs Python.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'

export interface FrozenCall {
  /** sha256 of the calls, the temp root written as `<ROOT>`. */
  calls: string
  /** The Python's answers, the temp root written as `<ROOT>`. */
  result: unknown
  /** Files the Python wrote or changed: path under the root → base64 bytes. */
  written: Record<string, string>
  /** Their modification times, in seconds (some answers name a file by its mtime). */
  mtimes: Record<string, number>
  /** Folders the Python made (empty ones included). */
  made: string[]
  /** Paths the Python removed. */
  removed: string[]
}

/** Test name → the oracle calls it made, in order. */
export type FrozenOracle = Record<string, FrozenCall[]>

const ROOT_MARK = '<ROOT>'

/** `bytes` with every `from` written as `to` (the temp root in a file the Python wrote). */
export function swapBytes(bytes: Buffer, from: string, to: string): Buffer {
  const a = Buffer.from(from)
  const parts: Buffer[] = []
  let at = 0
  for (let i = bytes.indexOf(a); i !== -1; i = bytes.indexOf(a, at)) {
    parts.push(bytes.subarray(at, i), Buffer.from(to))
    at = i + a.length
  }
  parts.push(bytes.subarray(at))
  return Buffer.concat(parts)
}

export function hashCalls(root: string, calls: unknown): string {
  return createHash('sha256').update(JSON.stringify(calls).split(root).join(ROOT_MARK)).digest('hex')
}

export function frozenOracle(fixture: string): <T = any>(root: string, calls: unknown) => T[] {
  const data = JSON.parse(fs.readFileSync(fixture, 'utf8')) as FrozenOracle
  const seen = new Map<string, number>()
  return <T>(root: string, calls: unknown): T[] => {
    const name = expect.getState().currentTestName ?? ''
    const i = seen.get(name) ?? 0
    seen.set(name, i + 1)
    const entry = data[name]?.[i]
    if (!entry) throw new Error(`no frozen Python answer for "${name}" call ${i} in ${path.basename(fixture)}`)
    if (hashCalls(root, calls) !== entry.calls) throw new Error(`"${name}" call ${i} asks something other than what the Python was asked (${path.basename(fixture)})`)
    for (const rel of entry.removed) fs.rmSync(path.join(root, rel), { recursive: true, force: true })
    for (const rel of entry.made) fs.mkdirSync(path.join(root, rel), { recursive: true })
    for (const [rel, b64] of Object.entries(entry.written)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
      fs.writeFileSync(path.join(root, rel), swapBytes(Buffer.from(b64, 'base64'), ROOT_MARK, root))
      fs.utimesSync(path.join(root, rel), entry.mtimes[rel]!, entry.mtimes[rel]!)
    }
    return JSON.parse(JSON.stringify(entry.result).split(ROOT_MARK).join(root)) as T[]
  }
}
