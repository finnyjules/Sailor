/**
 * `/global_subgraphs` — the blueprint list — served by Sailor itself, read-only
 * (step 3, R10.6, decision 4).
 *
 * A port of ComfyUI's `app/subgraph_manager.py` (`SubgraphManager`): the same
 * entries, ids and bodies, with ComfyUI off.
 *
 *   GET /global_subgraphs        → `{ [id]: { source, name, info } }`
 *   GET /global_subgraphs/{id}   → `{ source, name, info, data }`, or `null`
 *
 * Entries come from two places, in this order (the Python's dict merge):
 *   - `<engine root>/custom_nodes/<pack>/subgraphs/*.json`, source
 *     `custom_node`, pack `custom_nodes.<pack>`;
 *   - `<engine root>/blueprints/*.json`, source `templates`, pack `comfyui`.
 * An id is the sha256 of the source followed by the file's absolute path (so
 * it is the Python's own id for the same folder). `data` is the file's text,
 * read as Python's text mode reads it (UTF-8, newlines folded to `\n`).
 *
 * Differences nobody would notice (matching rule 2): the Python lists once per
 * process and keeps each file's text after its first read; this reads the
 * folder each time. Only the engine root's own `custom_nodes` folder is read
 * (not extra_model_paths.yaml's).
 *
 * Local only: in hosted, `/global_subgraphs` answers an empty list in
 * server/middleware/comfyui-proxy.ts and never reaches this module.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveEngineRoot } from '../utils/inputUploads'
import { isDir, listdirEntries } from './paths'
import { pySplitext } from './objectInfo'

/** The paths served here (boundary-matched by the router). */
export const GLOBAL_SUBGRAPHS_PREFIXES = ['/global_subgraphs']

export interface SubgraphEntry {
  source: 'custom_node' | 'templates'
  name: string
  info: { node_pack: string }
  data?: string
}

interface Located extends SubgraphEntry {
  /** The file's absolute path (forward slashes); never sent. */
  file: string
}

export type GlobalSubgraphsHandler = { name: 'list' } | { name: 'entry', id: string }
export type GlobalSubgraphsMatch = { kind: 'route', handler: GlobalSubgraphsHandler } | { kind: 'notFound' } | { kind: 'badMethod' }

/** The aiohttp route table. HEAD is served as GET (aiohttp's add_get registers both). */
export function matchGlobalSubgraphsRoute(p: string, method: string, decodeSegment: (s: string) => string): GlobalSubgraphsMatch {
  const verb = method === 'HEAD' ? 'GET' : method
  const get = (handler: GlobalSubgraphsHandler): GlobalSubgraphsMatch => verb === 'GET' ? { kind: 'route', handler } : { kind: 'badMethod' }
  if (p === '/global_subgraphs') return get({ name: 'list' })
  const prefix = '/global_subgraphs/'
  if (!p.startsWith(prefix)) return { kind: 'notFound' }
  const seg = p.slice(prefix.length)
  // `{id}` = aiohttp's `[^{}/]+`, matched on the decoded path (an encoded `/` stays `%2F`).
  if (!seg || seg.includes('/')) return { kind: 'notFound' }
  const id = decodeSegment(seg)
  if (/[{}]/.test(id)) return { kind: 'notFound' }
  return get({ name: 'entry', id })
}

/** fnmatch `*.json` under glob: case-sensitive (posix), hidden names never match a leading `*`. */
const isJsonName = (name: string) => !name.startsWith('.') && name.endsWith('.json')

/** `os.scandir` order, or nothing when the folder can't be read (glob swallows the error). */
function entriesOf(dir: string): fs.Dirent[] {
  try { return listdirEntries(dir) }
  catch { return [] }
}

function entry(file: string, source: SubgraphEntry['source'], nodePack: string): [string, Located] {
  const id = createHash('sha256').update(`${source}${file}`, 'utf8').digest('hex')
  return [id, { source, name: pySplitext(path.posix.basename(file))[0], info: { node_pack: nodePack }, file }]
}

/** Every entry, by id, in the Python's order (custom nodes' first, then the blueprints). */
export function globalSubgraphEntries(root: string): Map<string, Located> {
  const out = new Map<string, Located>()
  // folder_paths' custom_nodes folder is under its own realpath'd base; blueprints under the module's path.
  let real = root
  try { real = fs.realpathSync(root) }
  catch {}
  const customNodes = path.join(real, 'custom_nodes')
  for (const pack of entriesOf(customNodes)) {
    if (pack.name.startsWith('.')) continue
    const sub = path.join(customNodes, pack.name, 'subgraphs')
    if (!isDir(sub)) continue
    for (const f of entriesOf(sub)) {
      if (!isJsonName(f.name)) continue
      const file = path.join(sub, f.name).replace(/\\/g, '/')
      const [id, e] = entry(file, 'custom_node', `custom_nodes.${file.split('/').at(-3)}`)
      out.set(id, e)
    }
  }
  const blueprints = path.join(root, 'blueprints')
  for (const f of entriesOf(blueprints)) {
    if (!isJsonName(f.name)) continue
    const file = path.join(blueprints, f.name).replace(/\\/g, '/')
    const [id, e] = entry(file, 'templates', 'comfyui')
    out.set(id, e)
  }
  return out
}

/** `open(path, 'r', encoding='utf-8').read()`: strict UTF-8, a BOM kept, `\r\n` and `\r` read as `\n`. */
function readPyText(file: string): string {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file))
  return text.replace(/\r\n?/g, '\n')
}

const sanitized = (e: Located, data?: string): SubgraphEntry =>
  data === undefined ? { source: e.source, name: e.name, info: e.info } : { source: e.source, name: e.name, info: e.info, data }

export interface GlobalSubgraphsResult {
  status: number
  body: unknown
  headers?: Record<string, string>
}

/**
 * Serve one matched route. Throws where the Python raised (an unreadable or
 * non-UTF-8 file); the router turns that into aiohttp's 500. No engine root
 * lists nothing, as the Python does with no blueprints folder.
 */
export function runGlobalSubgraphs(h: GlobalSubgraphsHandler, root: string | null = resolveEngineRoot()): GlobalSubgraphsResult {
  const all = root ? globalSubgraphEntries(root) : new Map<string, Located>()
  if (h.name === 'list') {
    const body: Record<string, SubgraphEntry> = {}
    for (const [id, e] of all) body[id] = sanitized(e)
    return { status: 200, body }
  }
  // `Object.prototype` names (`constructor`…) are never ids: a Map, not an object lookup.
  const e = all.get(h.id)
  // `web.json_response(None)`: a JSON null, 200 (h3 would turn a null body into a 204).
  if (!e) return { status: 200, body: 'null', headers: { 'content-type': 'application/json; charset=utf-8' } }
  return { status: 200, body: sanitized(e, readPyText(e.file)) }
}
