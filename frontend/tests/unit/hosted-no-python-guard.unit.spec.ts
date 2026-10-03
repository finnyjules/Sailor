/**
 * Step 3 / C3: Sailor's server starts no Python at all. The last Python
 * caller (voice capture from YouTube) is retired, so no server file may name
 * the repo venv, a python executable or a .py script. A new Python call fails
 * here until it is ported to Node.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SERVER = resolve(__dirname, '../../server')

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

describe('no Python in the server', () => {
  it('no server file names the venv, a python executable or a .py script', () => {
    const naming = files.filter(f => INTERPRETER.test(f.src) || (CHILD.test(f.src) && SCRIPT.test(f.src))).map(f => f.rel).sort()
    expect(naming).toEqual([])
  })

  it('the YouTube voice capture route is gone', () => {
    expect(files.map(f => f.rel)).not.toContain('api/voice-clone/from-youtube.post.ts')
  })

  it('the fal LoRA weights step lifts the tar in Node, not Python', () => {
    const lora = files.find(f => f.rel === 'utils/loraFalWeights.ts')!
    expect(lora.src).not.toMatch(/child_process|execFile|spawn\(/)
    expect(lora.src).toMatch(/extractTarMember/)
  })

  it('Frame Animate keys in Node: no child process, no Python', () => {
    for (const rel of ['api/frame/animate.post.ts', 'frame/clipKey.ts', 'frame/clipKeyRun.ts']) {
      const src = files.find(f => f.rel === rel)!.src
      expect(src, rel).not.toMatch(/child_process|execFile|spawn\(|\.venv|python|\.py['"`]/)
    }
    expect(files.find(f => f.rel === 'api/frame/animate.post.ts')!.src).toMatch(/keyClip\(/)
  })
})
