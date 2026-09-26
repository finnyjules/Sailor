/**
 * Render a template layout to a PNG: layout JSON → satori (SVG) → resvg
 * (PNG). Both libraries are pure JS, no native browser needed. Curated fonts
 * are loaded once and reused across renders.
 *
 * Called by the route (server/api/render-template.post.ts) and by the
 * runner's Smart Layout card (server/runner/cards/smartLayout.ts), which
 * hands every image layer as a `data:` URL (it has no HTTP origin).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { RenderRequest } from './schema'
import { readManifest, USER_FONTS_DIR } from './fonts-store'
import { ImageLimitError, inlineTreeImages, type ImageFetcher } from './inlineImages'
import { TemplateSizeError, templateToSatori } from './translate'
import { safeImageFetcher } from './safeFetch'
import { RENDER_TIMEOUT, svgToPngInProcess } from './renderProcess'
import { isHosted } from '../utils/deployMode'
import { TEMPLATE_FONTS } from '../../shared/template-fonts'
import { resolveTokens } from '../../shared/template-grid/tokens'
import { resolveLibraryFaceByFamily } from '../utils/libraryFontManifest'

interface LoadedFont {
  name: string
  data: ArrayBuffer
  weight: 400 | 700
  style: 'normal'
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

// Curated families (shared/template-fonts.ts) — read once from node_modules.
let curatedCache: LoadedFont[] | null = null

async function loadCuratedFonts(): Promise<LoadedFont[]> {
  if (curatedCache) return curatedCache
  const out: LoadedFont[] = []
  for (const fam of TEMPLATE_FONTS) {
    for (const w of fam.weights) {
      try {
        const buf = await readFile(join(process.cwd(), 'node_modules', w.modulePath))
        out.push({ name: fam.name, data: toArrayBuffer(buf), weight: w.weight, style: 'normal' })
      } catch {
        // Missing fontsource file — skip; Inter (also curated) still covers.
      }
    }
  }
  curatedCache = out
  return out
}

// Uploaded ("Brand fonts") families — read from the gitignored user dir each
// render (few, small files; avoids cross-render staleness on re-upload). The
// single-covers-both manifest mirror means a one-file family registers 400+700.
async function loadUploadedFonts(): Promise<LoadedFont[]> {
  const manifest = await readManifest()
  const out: LoadedFont[] = []
  const bytesByFile = new Map<string, ArrayBuffer>()  // mirror reads once per render
  for (const fam of manifest) {
    for (const weight of ['400', '700'] as const) {
      const file = fam.weights[weight]
      if (!file) continue
      let data = bytesByFile.get(file)
      if (!data) {
        try {
          data = toArrayBuffer(await readFile(join(USER_FONTS_DIR, file)))
        } catch {
          continue // file removed out from under the manifest — skip
        }
        bytesByFile.set(file, data)
      }
      out.push({ name: fam.family, data, weight: Number(weight) as 400 | 700, style: 'normal' })
    }
  }
  return out
}

// Pangram/Off-Type library families: resolve straight from the committed
// manifest to an on-disk OTF (no network). Checked before Google so a
// library family is never also attempted as a Google family (which would
// 404 — the manifest's family names aren't Google families).
async function loadLibraryFonts(families: string[]): Promise<LoadedFont[]> {
  const out: LoadedFont[] = []
  for (const family of families) {
    for (const weight of [400, 700] as const) {
      const face = resolveLibraryFaceByFamily(family, weight, false)
      if (!face) continue
      try {
        const buf = await readFile(face.path)
        out.push({ name: family, data: toArrayBuffer(buf), weight, style: 'normal' })
      } catch {
        // File missing on disk despite manifest entry — skip this weight.
      }
    }
  }
  return out
}

// Non-curated families picked in the editor's font picker: fetch TTFs from
// Google Fonts on first use and cache for the process lifetime. A non-browser
// User-Agent makes Google return TTF sources — satori can't parse woff2.
const googleCache = new Map<string, LoadedFont[]>()
const googleFailed = new Set<string>()

async function loadGoogleFamily(family: string): Promise<LoadedFont[]> {
  const cached = googleCache.get(family)
  if (cached) return cached
  if (googleFailed.has(family)) return []
  try {
    const f = encodeURIComponent(family).replace(/%20/g, '+')
    const cssRes = await fetch(
      `https://fonts.googleapis.com/css2?family=${f}:wght@400;700&display=swap`,
      { headers: { 'User-Agent': 'curl/8' } },
    )
    if (!cssRes.ok) throw new Error(`css ${cssRes.status}`)
    const css = await cssRes.text()
    const fonts: LoadedFont[] = []
    for (const block of css.split('@font-face').slice(1)) {
      const weight = /font-weight:\s*(\d+)/.exec(block)?.[1]
      const url = /src:\s*url\(([^)]+\.ttf)\)/.exec(block)?.[1]
      if (!url || (weight !== '400' && weight !== '700')) continue
      const ttf = await fetch(url)
      if (!ttf.ok) continue
      fonts.push({ name: family, data: await ttf.arrayBuffer(), weight: Number(weight) as 400 | 700, style: 'normal' })
    }
    if (!fonts.length) throw new Error('no ttf faces')
    googleCache.set(family, fonts)
    return fonts
  } catch {
    googleFailed.add(family)  // don't re-fetch a broken family every render
    return []
  }
}

/** Every fontFamily referenced by the template (v1 incl. per-aspect
 * overrides, v2 element styles). `{{ brand.* }}` tokens resolve against the
 * merged brand so brand-bound fonts are fetched too. */
function collectFamilies(template: unknown, brand: Record<string, unknown>): string[] {
  const fams = new Set<string>()
  const resolve = (f: unknown) => {
    if (typeof f !== 'string' || !f.trim()) return
    const r = String(resolveTokens(f.trim(), {}, brand)).trim()
    if (r) fams.add(r)
  }
  const t = template as { elements?: unknown[]; sections?: { children?: unknown[] }[] }
  const elements = [
    ...(t?.elements ?? []),
    ...(t?.sections ?? []).flatMap(s => s?.children ?? []),   // v3 section children
  ]
  for (const el of elements as any[]) {
    resolve(el?.style?.fontFamily)
    for (const ov of Object.values(el?.overrides ?? {})) resolve((ov as any)?.style?.fontFamily)
  }
  return [...fams]
}

async function loadFonts(template: unknown, brand: Record<string, unknown>): Promise<LoadedFont[]> {
  const merged = { ...((template as any)?.brand ?? {}), ...brand }
  // Tiers: curated → uploaded → library → Google. Google fills only families
  // in none of the local sets, so a library (or uploaded) family wins a name
  // collision with a Google one, and is never ALSO attempted as Google.
  const curated = await loadCuratedFonts()
  const uploaded = await loadUploadedFonts()
  const referenced = collectFamilies(template, merged)
  const library = await loadLibraryFonts(referenced.filter(n =>
    !curated.some(f => f.name === n) && !uploaded.some(f => f.name === n)))
  const localNames = new Set([...curated, ...uploaded, ...library].map(f => f.name))
  const extra = (await Promise.all(
    referenced.filter(n => !localNames.has(n)).map(loadGoogleFamily),
  )).flat()
  return [...curated, ...uploaded, ...library, ...extra]
}

/** An image in the layout could not be fetched: the route answers 502. */
export class TemplateImageError extends Error {}

export interface RenderOptions {
  /** How http(s) images are fetched: the safe fetcher (./safeFetch.ts) by default. */
  fetcher?: ImageFetcher
  /** Stops the render (its process is killed). */
  signal?: AbortSignal
}

/** One render's whole deadline (fix round 3): fetches, bakes and the render together, queue waits included. */
export const RENDER_DEADLINE_MS = 60_000

/**
 * The PNG for one render request: the route's body before R1.6, with the
 * satori and resvg steps in the render process (./renderProcess.ts) and images
 * fetched under the safe policy (fix round 1). Same code, same fonts, same bytes.
 * Round 3: one deadline for the whole render, and Stop (or the client going
 * away) ends its fetches and bakes too; the pictures' limits refused plainly.
 */
export async function renderTemplatePng(body: RenderRequest, opts: RenderOptions = {}): Promise<Uint8Array> {
  const deadline = AbortSignal.timeout(g.__sailorRenderDeadlineMs ?? RENDER_DEADLINE_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline

  // The layout's own limits first (size, elements, text): nothing is loaded for one refused.
  const { tree, width, height } = templateToSatori(
    body.template,
    body.aspect,
    body.props ?? {},
    body.brand ?? {},
    body.width && body.height ? { width: body.width, height: body.height } : undefined,
    body.outputId,
  )

  const fonts = await loadFonts(body.template, (body.brand ?? {}) as Record<string, unknown>)

  // Inline every remote image as a data URI BEFORE satori: its own remote
  // loading fails silently (a 404 just skips the image → plausible-but-wrong
  // output). A dead URL now rejects the render with a clear error instead.
  try {
    await inlineTreeImages(tree, opts.fetcher ?? safeImageFetcher({ hosted: isHosted() }), { signal })
  } catch (e) {
    if (signal.aborted) throw new Error(deadline.aborted && !opts.signal?.aborted ? RENDER_TIMEOUT : 'Stopped')
    if (e instanceof ImageLimitError) throw new TemplateSizeError(e.message)
    throw new TemplateImageError(String((e as Error).message ?? e).slice(0, 200))
  }

  // satori → SVG, resvg → PNG (fitTo: original honours the size satori sized
  // to), in the render process: the tree is plain objects, the fonts their bytes.
  return svgToPngInProcess({
    tree, width, height,
    fonts: fonts.map((f) => ({ name: f.name, data: f.data, weight: f.weight, style: f.style })),
  }, signal)
}

const g = globalThis as unknown as { __sailorRenderDeadlineMs?: number }

/** Tests only: the render's whole deadline (null restores a minute). */
export function __setRenderDeadlineForTests(ms: number | null): void {
  g.__sailorRenderDeadlineMs = ms ?? undefined
}
