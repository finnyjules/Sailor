// AI in Sailor spec §2.1a: one prompt component renders every INSTRUCTION prompt.
// This fails if any .vue outside components/prompt/ brings back a prompt of its
// own. Content prompts (the recipe on an element: "Describe a texture…") are a
// different thing (§1.5) and are allowed by name below until stage 6 gives them
// the shared content field.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('../../app', import.meta.url))
const PROMPT_DIRS = ['components/prompt/', 'lib/prompt/']

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(vue|ts)$/.test(name)) acc.push(p)
  }
  return acc
}
const files = walk(appRoot).map(p => ({ rel: relative(appRoot, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))
const outside = (rel: string) => !PROMPT_DIRS.some(d => rel.startsWith(d))
const vueOutside = files.filter(f => f.rel.endsWith('.vue') && outside(f.rel))

/**
 * Fields that sit next to an AI mark but are NOT instruction prompts. Each says
 * why. Stage 6 (the shared content field) replaces most of these; remove an
 * entry when its field moves. Never add an instruction prompt here.
 */
const CONTENT_FIELDS: Record<string, string> = {
  'components/templates/GridPropertyPanel.vue': 'content prompt: the "Rewrite copy" brief field (Describe the copy you want…), not an instruction prompt (stage 6)',
}

describe('only the one prompt takes instructions (spec §2.1a)', () => {
  it('no component imports a retired prompt', () => {
    const bad = vueOutside.filter(f => /import\s+(AgentBar|VibeControlBar|CanvasPromptBar)\b/.test(f.text)).map(f => f.rel)
    expect(bad).toEqual([])
  })

  it('the prompt’s own words appear only in the prompt', () => {
    const sig = /aria-label="Ask Sailor"|['"`]Ask Sailor['"`]|Change or ask about/
    const bad = files.filter(f => outside(f.rel) && sig.test(f.text)).map(f => f.rel)
    expect(bad).toEqual([])
  })

  it('no text field sits beside an AI mark outside the prompt, unless it is a named content field', () => {
    const bad: string[] = []
    for (const f of vueOutside) {
      const tpl = f.text.slice(f.text.indexOf('<template'))
      const lines = tpl.split('\n')
      lines.forEach((line, i) => {
        if (!/<(input|textarea)\b/.test(line)) return
        if (/type="(range|checkbox|radio|color|file|number)"/.test(line)) return
        const near = lines.slice(Math.max(0, i - 6), i + 7).join('\n')
        if (/<AiMark\b|✦|<Sparkles\b/.test(near) && !CONTENT_FIELDS[f.rel]) bad.push(`${f.rel}:${i + 1}`)
      })
    }
    expect(bad).toEqual([])
  })

  it('every allowlisted content field still exists and still has a reason', () => {
    for (const [rel, why] of Object.entries(CONTENT_FIELDS)) {
      expect(files.some(f => f.rel === rel), rel).toBe(true)
      expect(why.length).toBeGreaterThan(10)
    }
  })
})
