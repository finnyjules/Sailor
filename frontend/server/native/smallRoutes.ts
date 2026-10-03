/**
 * The small /sailor routes Sailor now serves itself — the route table for
 * shaderCatalog.ts, spacePresets.ts, fontSubset.ts and inputHousekeeping.ts,
 * in aiohttp's shape (paths, verbs, `{param}` segments).
 *
 * `/sailor/models` stays claimed with no route in it (step 3, R10.5): Sailor
 * no longer downloads or reports model bundles, and a request there answers
 * 404 here rather than reaching the engine's downloader.
 * `/sailor/font_subset` is checked here and, locally, still subset by the
 * engine while it runs; without it, and always in hosted (R10.9), the font
 * comes back whole (fontSubset.ts says why).
 */
import type { H3Event } from 'h3'
import { getRequestHeader } from 'h3'
import { engineFolder } from './paths'
import { catalogDir, shaderAssetRoute, shaderEffectsRoute } from './shaderCatalog'
import {
  sailorScenesDir,
  spaceDefaultSaveRoute,
  spaceDefaultsRoute,
  spaceThumbnailGetRoute,
  spaceThumbnailSaveRoute,
  spaceThumbnailsRoute,
} from './spacePresets'
import { fontSubsetRoute } from './fontSubset'
import { cleanupFramesRoute, clearDatasetRoute, saveCaptionsRoute } from './inputHousekeeping'
import { ENGINE_FORWARD_TIMEOUT_MS, forwardToEngine } from './media'
import { isHosted } from '../utils/deployMode'

export interface SmallResult {
  status: number
  body: unknown
  headers?: Record<string, string>
}

/** The namespaces these routes own (boundary-matched by the router). */
export const SMALL_PREFIXES = [
  '/sailor/shader_effects',
  '/sailor/space_defaults',
  '/sailor/space_default',
  '/sailor/space_thumbnails',
  '/sailor/space_thumbnail',
  '/sailor/font_subset',
  '/sailor/lora',
  '/sailor/motion',
  '/sailor/models',
]

export type SmallHandler =
  | { name: 'shaderEffects' | 'spaceDefaults' | 'spaceThumbnails' | 'fontSubset' | 'saveCaptions' | 'clearDataset' | 'cleanupFrames' }
  | { name: 'shaderAsset', assetName: string }
  | { name: 'spaceDefaultSave' | 'spaceThumbnailGet' | 'spaceThumbnailSave', effectId: string }

export type SmallMatch = { kind: 'route', handler: SmallHandler } | { kind: 'notFound' } | { kind: 'badMethod' }

/** The aiohttp route table. HEAD is served as GET (aiohttp's add_get registers both). */
export function matchSmallRoute(p: string, method: string, decodeSegment: (s: string) => string): SmallMatch {
  const verb = method === 'HEAD' ? 'GET' : method
  const byVerb = (table: Record<string, SmallHandler>): SmallMatch => {
    const h = table[verb]
    return h ? { kind: 'route', handler: h } : { kind: 'badMethod' }
  }
  switch (p) {
    case '/sailor/shader_effects': return byVerb({ GET: { name: 'shaderEffects' } })
    case '/sailor/space_defaults': return byVerb({ GET: { name: 'spaceDefaults' } })
    case '/sailor/space_thumbnails': return byVerb({ GET: { name: 'spaceThumbnails' } })
    case '/sailor/font_subset': return byVerb({ POST: { name: 'fontSubset' } })
    case '/sailor/lora/save_captions': return byVerb({ POST: { name: 'saveCaptions' } })
    case '/sailor/lora/clear_dataset': return byVerb({ POST: { name: 'clearDataset' } })
    case '/sailor/motion/cleanup_frames': return byVerb({ POST: { name: 'cleanupFrames' } })
  }
  // `{param}` = aiohttp's `[^{}/]+`, matched on the decoded path (an encoded `/` stays `%2F`).
  const param = (prefix: string): string | null => {
    if (!p.startsWith(prefix)) return null
    const seg = p.slice(prefix.length)
    if (!seg || seg.includes('/')) return null
    const value = decodeSegment(seg)
    return /[{}]/.test(value) ? null : value
  }
  const asset = param('/sailor/shader_effects/assets/')
  if (asset !== null) return byVerb({ GET: { name: 'shaderAsset', assetName: asset } })
  const preset = param('/sailor/space_default/')
  if (preset !== null) return byVerb({ POST: { name: 'spaceDefaultSave', effectId: preset } })
  const thumb = param('/sailor/space_thumbnail/')
  if (thumb !== null) {
    return byVerb({ GET: { name: 'spaceThumbnailGet', effectId: thumb }, POST: { name: 'spaceThumbnailSave', effectId: thumb } })
  }
  return { kind: 'notFound' }
}

/** How a handler reads its request body — supplied by the router, which owns the size cap and aiohttp's parse errors. */
export interface BodyReaders {
  json: () => Promise<{ ok: true, value: unknown, raw?: Buffer } | { ok: false, result: SmallResult }>
  bytes: () => Promise<Buffer>
}

const NO_DATA_FOLDER: SmallResult = {
  status: 503,
  body: { error: 'Sailor can\'t find its data folder. Set SAILOR_DATA_ROOT to the folder that holds input/, output/ and user/.' },
}

/**
 * Serve one matched route. Throws where the Python raised an unhandled
 * exception; the router turns that into aiohttp's 500.
 */
export async function runSmallRoute(h: SmallHandler, event: H3Event, read: BodyReaders): Promise<SmallResult> {
  switch (h.name) {
    case 'shaderEffects': {
      const dir = catalogDir()
      return dir ? shaderEffectsRoute(dir) : NO_DATA_FOLDER
    }
    case 'shaderAsset': {
      const dir = catalogDir()
      return dir ? shaderAssetRoute(dir, h.assetName, name => getRequestHeader(event, name)) : NO_DATA_FOLDER
    }
    case 'spaceDefaults':
    case 'spaceThumbnails': {
      const bridge = sailorScenesDir()
      if (!bridge) return NO_DATA_FOLDER
      return h.name === 'spaceDefaults' ? spaceDefaultsRoute(bridge) : spaceThumbnailsRoute(bridge)
    }
    case 'spaceDefaultSave':
    case 'spaceThumbnailGet':
    case 'spaceThumbnailSave': {
      const bridge = sailorScenesDir()
      if (!bridge) return NO_DATA_FOLDER
      if (h.name === 'spaceDefaultSave') return spaceDefaultSaveRoute(bridge, h.effectId, read.json)
      if (h.name === 'spaceThumbnailGet') return spaceThumbnailGetRoute(bridge, h.effectId)
      return spaceThumbnailSaveRoute(bridge, h.effectId, read.bytes)
    }
    case 'fontSubset': {
      // Checked natively first (the Python's own 400s). A font that passes is
      // subset by the engine while it runs — fontTools keeps every table and
      // layout feature, which nothing in Node does (see fontSubset.ts) — and
      // comes back whole when it does not.
      const parsed = await read.json()
      if (!parsed.ok) return parsed.result
      const native = fontSubsetRoute(parsed.value)
      if (native.status !== 200) return native
      // Hosted never reaches the engine (step 3, R10.9): the font comes back whole.
      if (isHosted()) return native
      return (await forwardToEngine(event, '/sailor/font_subset', parsed.raw, ENGINE_FORWARD_TIMEOUT_MS)) ?? native
    }
    case 'saveCaptions':
    case 'clearDataset':
    case 'cleanupFrames': {
      // The Python answers `invalid json` (no detail) for all three.
      const parsed = await read.json()
      if (!parsed.ok) return { status: 400, body: { error: 'invalid json' } }
      const input = engineFolder('input')
      if (!input) return NO_DATA_FOLDER
      if (h.name === 'saveCaptions') return saveCaptionsRoute(input, parsed.value)
      if (h.name === 'clearDataset') return clearDatasetRoute(input, parsed.value)
      return cleanupFramesRoute(input, parsed.value)
    }
  }
}
