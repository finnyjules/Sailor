/**
 * The recipe call: the model composes readings of the ask from menus we wrote,
 * and never touches a control key.
 *
 * Text only — the pictures do not exist yet at this point in the flow; our code
 * builds and renders every recipe, and a second, seeing call picks between them.
 *
 * Model hardcoded to Haiku for the reason vibe.post.ts documents: this tier has
 * no thinking or latency knob, and passing one makes it reject the whole call.
 * The aimodels source-scan spec checks this file for that knob's name and fails
 * if it appears anywhere, in code or in prose.
 */
import { createError, defineEventHandler, readBody } from 'h3'
import { assertRateLimit } from '../lib/rateLimit'
import { RECIPES_SCHEMA, buildRecipesPrompt, buildSeedMenu, salvageRecipes, type EnginePaletteCandidate } from '~/lib/gradientfx/recipes'
import { MAX_PHRASE_CHARS, optionalApiKey, requireString, resolveAnthropicKey } from '../lib/agentRequest'
import { meterAssist } from '../utils/anthropicMeter'
import { assembleShelf } from '~/lib/color/seedEngine'
import type { CorpusEntry } from '~/lib/color/anchor'

const HEX_RE = /^#[0-9a-fA-F]{6}$/

// Nitro serves public/ through its own asset storage — process.cwd()+'/public'
// is NOT the public root in the built server, so the corpus is read through
// useStorage, not the filesystem or a relative fetch.
let corpus: CorpusEntry[] | null = null
async function getCorpus(): Promise<CorpusEntry[]> {
  if (!corpus) corpus = await useStorage('assets:public').getItem('data/palette-corpus.json') as CorpusEntry[]
  return corpus
}

/** A stable (not model-chosen) pick off `buildSeedMenu()`, keyed to the phrase
 *  so the same ask reuses the same seed across a session. Deliberately simple:
 *  the model still never invents a hex here, it just doesn't have to spend a
 *  schema field naming one either — see the SAFE SUBSET note below. */
function phraseSeedHex(phrase: string): string {
  const menu = buildSeedMenu()
  let h = 0
  for (let i = 0; i < phrase.length; i++) h = (h * 31 + phrase.charCodeAt(i)) >>> 0
  return menu[h % menu.length]!.hex
}

/**
 * The engine palette menu offered to the model alongside the look/mood menus.
 *
 * SAFE SUBSET, not the full index-based pick the brief sketches: the brief's
 * plan adds a `seed` schema field the model fills and a numeric palette index
 * it returns, with `materializeRecipe` reading `paletteMenu[chosenIndex]`.
 * That reshapes RECIPES_SCHEMA and `salvageRecipes` at once, and this route
 * has no "leave it as it was" fallback if a live call ever came back in the
 * old palette-array shape mid-rollout. Instead: derive a seed (a brand/taste
 * key colour if the request ever carries one — none of today's callers do —
 * else a phrase-stable pick off `buildSeedMenu()`), assemble curated/composed
 * palettes from the engine, and hand them to the model as candidates to COPY
 * into the existing `palette: string[]` field. `RECIPES_SCHEMA` and
 * `salvageRecipes` are untouched; a bad or missing corpus just yields no menu
 * and the prompt reads exactly as it did before this task.
 */
async function buildEnginePaletteMenu(phrase: string, yours: { palette: string[] }): Promise<EnginePaletteCandidate[]> {
  const brandSeed = yours.palette.find(c => typeof c === 'string' && HEX_RE.test(c.trim()))
  const seedHex = (brandSeed ?? phraseSeedHex(phrase)).toLowerCase()
  const rows = await getCorpus()
  if (!Array.isArray(rows) || !rows.length) return []
  const shelf = assembleShelf(rows, { seedA: seedHex }, 10)
  return shelf
    .filter(f => Array.isArray(f.hexes) && f.hexes.length >= 2)
    .map(f => ({ hexes: f.hexes, note: f.recipe ?? (f.sourceTag === 1 ? 'sanzo' : 'curated') }))
}

export function buildRecipesRequestBody(prompt: string): Record<string, unknown> {
  return {
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    output_config: { format: { type: 'json_schema', schema: RECIPES_SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  }
}

export default defineEventHandler(async (event) => {
  assertRateLimit(event, 'vibe-recipes', 60)
  const body = await readBody(event)
  const apiKey = resolveAnthropicKey(useRuntimeConfig(event).anthropicApiKey, optionalApiKey(body?.apiKey))
  const phrase = requireString(body?.phrase, 'phrase', MAX_PHRASE_CHARS)
  const yours = body?.yours
  if (!yours || typeof yours !== 'object') {
    throw createError({ statusCode: 400, statusMessage: 'yours (object) is required' })
  }

  const yoursSummary = {
    base: typeof yours.base === 'string' ? yours.base : 'unknown',
    palette: Array.isArray(yours.palette) ? yours.palette.filter((c: unknown) => typeof c === 'string') : [],
  }

  // A soft try: any failure reading the corpus or assembling the shelf just
  // means no engine menu this time, not a failed request — the model still
  // gets a usable prompt in the exact shape it had before this feature.
  let paletteMenu: EnginePaletteCandidate[] = []
  try {
    paletteMenu = await buildEnginePaletteMenu(phrase, yoursSummary)
  }
  catch (err) {
    console.error('[vibe-recipes] engine palette menu unavailable, falling back to model-only palettes:', err)
  }

  const prompt = buildRecipesPrompt(phrase, yoursSummary, paletteMenu)

  await meterAssist(event)

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(buildRecipesRequestBody(prompt)),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error('[vibe-recipes] Anthropic error:', res.status, errText)
      const errBody = (() => { try { return JSON.parse(errText) } catch { return {} } })()
      throw createError({ statusCode: res.status, message: errBody?.error?.message || `Anthropic API error: ${res.status}` })
    }
    const data: any = await res.json()
    const text = data?.content?.find((b: any) => b.type === 'text')?.text
    let parsed: unknown = null
    if (text) { try { parsed = JSON.parse(text) } catch { parsed = null } }
    const recipes = salvageRecipes(parsed)
    if (!recipes.length) {
      // Name it in the SERVER log, like the raw-text logging on the error path
      // above: a parse-level rejection is just as fatal to the flow as a 4xx,
      // and the dev terminal should say which one happened without anyone
      // having to ask for a browser console.
      console.error('[vibe-recipes] no usable recipes in reply:', String(text ?? '').slice(0, 500))
    }
    // Nothing usable is a real failure here — unlike the review pass, there is no
    // "leave it as it was" to fall back to inside this route. The CLIENT degrades
    // to the old blind-generation path on any error, which is the honest place
    // for that decision.
    if (!recipes.length) throw createError({ statusCode: 502, message: 'No usable recipes came back' })
    return { recipes }
  }
  catch (err: any) {
    if (err.statusCode) throw err
    throw createError({ statusCode: 500, message: err?.message || 'Failed to call Claude API' })
  }
})
