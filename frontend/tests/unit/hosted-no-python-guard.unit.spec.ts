/**
 * Step 3, LC7: the hosted image has no Python (R10.10). No server code may
 * start a Python process in hosted. Statically: every server file whose CODE
 * (comments stripped) names the repo venv, a python executable or a .py
 * script is one of the known, hosted-guarded routes, and each child-process
 * call in those files sits right behind an `isHosted()` refusal. A new Python
 * call anywhere else fails here until it is ported or guarded the same way.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SERVER = resolve(__dirname, '../../server')

/** Routes allowed to run a venv script, locally only (both refuse in hosted). */
const GUARDED = new Set([
  'api/frame/animate.post.ts',
  'api/voice-clone/from-youtube.post.ts',
])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return walk(p)
    return /\.(ts|mjs|js)$/.test(n) ? [p] : []
  })
}

/** Block and line comments out, string contents kept (the paths live in strings). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

/** A python interpreter by venv or path, anywhere. */
const INTERPRETER = /\.venv\b|\/bin\/python/
/** A bare interpreter name or a .py script ending a string: only a risk in a file that can start processes. */
const SCRIPT = /['"`](python3?|py)['"`]|\.py['"`]/
const CHILD = /from ['"](node:)?child_process['"]|require\(['"](node:)?child_process['"]\)/
const files = walk(SERVER).map(p => ({ rel: relative(SERVER, p).split('\\').join('/'), src: code(readFileSync(p, 'utf8')) }))

describe('no Python in hosted', () => {
  it('only the guarded routes name the venv, a python executable or a .py script', () => {
    const naming = files.filter(f => INTERPRETER.test(f.src) || (CHILD.test(f.src) && SCRIPT.test(f.src))).map(f => f.rel).sort()
    expect(naming).toEqual([...GUARDED].sort())
  })

  it('the fal LoRA weights step lifts the tar in Node, not Python', () => {
    const lora = files.find(f => f.rel === 'utils/loraFalWeights.ts')!
    expect(lora.src).not.toMatch(/child_process|execFile|spawn\(/)
    expect(lora.src).toMatch(/extractTarMember/)
  })

  for (const rel of GUARDED) {
    it(`${rel} refuses in hosted first and guards every child process`, () => {
      const src = files.find(f => f.rel === rel)!.src
      const handler = src.slice(src.indexOf('defineEventHandler('))
      // The handler's first statement is the hosted refusal.
      expect(handler).toMatch(/^defineEventHandler\(async \(event\) => \{\s*(\/\/[^\n]*\s*)*if \(isHosted\(\)\) throw createError\(/)
      // Every execFile/spawn call has an isHosted() check within the three lines before it.
      const lines = src.split('\n')
      const calls = lines.flatMap((l, i) => /\b(execFile|spawn|execFileSync|spawnSync|exec)\(/.test(l) && !/import/.test(l) ? [i] : [])
      expect(calls.length).toBeGreaterThan(0)
      for (const i of calls) expect(lines.slice(Math.max(0, i - 3), i).join('\n')).toMatch(/isHosted\(\)/)
    })
  }
})
