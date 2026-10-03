/**
 * LC16 (B2): no user-facing string in frontend/app tells people about ComfyUI: Sailor has no ComfyUI.
 * Comments are free to name it (history). A line is user-facing when it is code or template text, not a comment.
 * Allowed exceptions: the starter workflows on the home page and the community pages (product call pending),
 * the dev labs, and the few lines below that are wire details, not words shown to anyone.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const APP = join(__dirname, '..', '..', 'app')
const ALLOWED_PATHS = [/^pages\/index\.vue$/, /^pages\/community\//, /^components\/community\//, /^pages\/dev\//]
/** Wire details (an upload field name, a filename prefix), never shown. */
const ALLOWED_LINES = [/fd\.append\('image'/, /widgets_values = \[filename/, /filename: string\s+\/\//]

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|ts)$/.test(e)) out.push(p)
  }
  return out
}

describe('no ComfyUI in what users read', () => {
  it('names ComfyUI in no string or template text outside the allowed pages', () => {
    const hits: string[] = []
    for (const f of walk(APP)) {
      const rel = relative(APP, f)
      if (ALLOWED_PATHS.some(r => r.test(rel))) continue
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (!/ComfyUI/.test(line)) return
        if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line)) return
        if (ALLOWED_LINES.some(r => r.test(line))) return
        hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
      })
    }
    expect(hits).toEqual([])
  })
})
