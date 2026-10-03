/**
 * Space Type scene presets and their thumbnails, served by Sailor instead of
 * ComfyUI — a port of the handlers in comfy_extras/nodes_timeline.py:
 *
 *   GET  /sailor/space_defaults             (:1906)  every saved preset, by effect id
 *   POST /sailor/space_default/{effect_id}  (:1920)  save one preset (a JSON object)
 *   GET  /sailor/space_thumbnails           (:1937)  every thumbnail's URL, by effect id
 *   POST /sailor/space_thumbnail/{effect_id} (:1963) save one thumbnail (raw PNG bytes)
 *   GET  /sailor/space_thumbnail/{effect_id} (:1949) one thumbnail
 *
 * The folders are `scenes/scene_defaults` and `scenes/scene_thumbnails` under
 * the data root (they lived under `custom_nodes/sailor_bridge/` until C2; a
 * legacy folder is copied across, file by file, the first time it is seen).
 * They follow the data root, so unit tests (whose root is a temp folder) never
 * touch the real ones.
 * Presets are written as `json.dump(scene, f, indent=2)` writes them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveDataRoot } from '../utils/dataRoot'
import { pyDumps } from './pyJson'
import { isDir, isFile, listdir, writeFileAtomic } from './paths'

type Json = any

export interface PresetResult {
  status: number
  body: unknown
  headers?: Record<string, string>
}

/** Copy files the new folder lacks from the old `custom_nodes/sailor_bridge` one (never overwrites). */
function migrateLegacyScenes(root: string, scenes: string): void {
  const legacy = path.join(root, 'custom_nodes', 'sailor_bridge')
  for (const sub of ['scene_defaults', 'scene_thumbnails']) {
    const from = path.join(legacy, sub)
    if (!isDir(from)) continue
    try {
      fs.mkdirSync(path.join(scenes, sub), { recursive: true })
      for (const fn of listdir(from)) {
        const dest = path.join(scenes, sub, fn)
        if (isFile(path.join(from, fn)) && !fs.existsSync(dest)) fs.copyFileSync(path.join(from, fn), dest)
      }
    }
    catch {}
  }
}

/** `scenes/` under the data root; null when the data root is unknown. */
export function sailorScenesDir(): string | null {
  const root = resolveDataRoot()
  if (!root) return null
  const scenes = path.join(root, 'scenes')
  migrateLegacyScenes(root, scenes)
  return scenes
}

/** `_scene_defaults_dir()` */
export const sceneDefaultsDir = (bridgeDir: string) => path.join(bridgeDir, 'scene_defaults')
/** `_scene_thumbnails_dir()` */
export const sceneThumbnailsDir = (bridgeDir: string) => path.join(bridgeDir, 'scene_thumbnails')

/** `_valid_effect_id` — `re.fullmatch(r"[a-z0-9]+", s)`. */
export function isValidEffectId(s: unknown): s is string {
  return typeof s === 'string' && /^[a-z0-9]+$/.test(s)
}

const INVALID_ID: PresetResult = { status: 400, body: { error: 'invalid effect id' } }


/** `_space_defaults_list` — an unreadable or unparseable preset is left out. */
export function spaceDefaultsRoute(bridgeDir: string): PresetResult {
  const out: Record<string, Json> = {}
  const d = sceneDefaultsDir(bridgeDir)
  if (isDir(d)) {
    for (const fn of listdir(d)) {
      if (!fn.endsWith('.json') || !isValidEffectId(fn.slice(0, -5))) continue
      try { out[fn.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(d, fn), 'utf8')) }
      catch {}
    }
  }
  return { status: 200, body: out }
}

/**
 * `_space_default_save`. `readBody` parses the request body the way aiohttp's
 * `request.json()` does; it is only called once the id has been accepted,
 * matching the Python's order of checks.
 */
export async function spaceDefaultSaveRoute(
  bridgeDir: string,
  effectId: string,
  readBody: () => Promise<{ ok: true, value: unknown } | { ok: false, result: PresetResult }>,
): Promise<PresetResult> {
  if (!isValidEffectId(effectId)) return INVALID_ID
  const parsed = await readBody()
  if (!parsed.ok) return parsed.result
  const scene = parsed.value
  if (scene === null || typeof scene !== 'object' || Array.isArray(scene)) {
    return { status: 400, body: { error: 'scene must be an object' } }
  }
  const d = sceneDefaultsDir(bridgeDir)
  fs.mkdirSync(d, { recursive: true })
  writeFileAtomic(path.join(d, `${effectId}.json`), pyDumps(scene, 2))
  return { status: 200, body: { ok: true } }
}

/** `_space_thumbnails_list` — `{ id: "/sailor/space_thumbnail/<id>?v=<whole-second mtime>" }`. */
export function spaceThumbnailsRoute(bridgeDir: string): PresetResult {
  const out: Record<string, string> = {}
  const d = sceneThumbnailsDir(bridgeDir)
  if (isDir(d)) {
    for (const fn of listdir(d)) {
      if (!fn.endsWith('.png') || !isValidEffectId(fn.slice(0, -4))) continue
      const eid = fn.slice(0, -4)
      const st = fs.statSync(path.join(d, fn), { bigint: true })
      out[eid] = `/sailor/space_thumbnail/${eid}?v=${st.mtimeNs / 1_000_000_000n}`
    }
  }
  return { status: 200, body: out }
}

/** `_space_thumbnail_save` — the body is the PNG itself. */
export function spaceThumbnailSaveRoute(bridgeDir: string, effectId: string, readBytes: () => Promise<Buffer>): Promise<PresetResult> | PresetResult {
  if (!isValidEffectId(effectId)) return INVALID_ID
  return readBytes().then((data) => {
    if (!data.length) return { status: 400, body: { error: 'empty body' } }
    const d = sceneThumbnailsDir(bridgeDir)
    fs.mkdirSync(d, { recursive: true })
    writeFileAtomic(path.join(d, `${effectId}.png`), data)
    return { status: 200, body: { ok: true } }
  })
}

/** `_space_thumbnail_get` — `web.Response(body=..., content_type="image/png")`, no cache headers. */
export function spaceThumbnailGetRoute(bridgeDir: string, effectId: string): PresetResult {
  if (!isValidEffectId(effectId)) return INVALID_ID
  const p = path.join(sceneThumbnailsDir(bridgeDir), `${effectId}.png`)
  if (!isFile(p)) return { status: 404, body: { error: 'not found' } }
  return { status: 200, body: fs.readFileSync(p), headers: { 'content-type': 'image/png' } }
}
