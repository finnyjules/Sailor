/**
 * Measured inputs, frozen for the run (Task G1 fix round 3, R3 + R4).
 *
 * The hosted /prompt gate measures an input file when the prompt is
 * submitted, but ComfyUI opens it when the node runs, which can be much later
 * (the queue). The owner may overwrite their own file in between, and a
 * pinned cache signature could serve an old picture. So every file the gate
 * measures for money (a picture feeding a size-priced node, a lip-sync's
 * sound or video, a Seedance reference) is first COPIED to a name owned by
 * this run and named by the sha-256 of its bytes, then measured from that
 * copy; the forwarded prompt names the copy (rewriteMeasuredInputs). ComfyUI
 * then reads exactly the bytes that were measured and priced, however long
 * the prompt waits, and the new name is also a new cache signature.
 *
 * The copies:
 *  - live flat in the engine's INPUT folder (`/view?filename=…&type=input`
 *    references, read by nodes_replicate.py's parse_view_ref, take no
 *    subfolder), named `g1-<run token>-<sha256>.<original extension>` — the
 *    extension kept because the engine guesses the media type from it
 *    (mimetypes.guess_type) and lists audio cards' files by it;
 *  - are unannotated, so LoadImage, the Image card, LoadAudio and the Audio
 *    card (folder_paths.get_annotated_filepath, input by default) and the
 *    `/view` references all resolve them in the input folder;
 *  - are made by copyFile (a copy-on-write clone where the disk offers one)
 *    to a random temporary name, hashed, then renamed: the bytes hashed and
 *    measured are the bytes the engine reads. The run token is random, so no
 *    upload can take the name first, and an existing file with no owner row
 *    can't be overwritten by anyone (engineGate.ts decideOverwrite);
 *  - are not owned by anyone: the ownership check runs on the caller's own
 *    names before any copy is made, and a later prompt naming a copy is
 *    refused by the same check (no owner row);
 *  - are removed when the run ends (its settle watcher returns: success,
 *    error or timeout), or at once when the request is refused or the
 *    engine doesn't queue it. A timed-out run that runs later finds its copy
 *    gone and fails at its loader, before any provider call.
 * Copies left by a stopped server are swept at the first snapshot after a
 * start, once older than STALE_SNAPSHOT_MS.
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { annotatedFilepath, engineFolder, resolveInside } from '../native/paths'
import { readViewRef, type MediaFileRef } from '../../shared/pricing/clipSettings'

/** Copies larger than this are not made (the input is then left unmeasured, as a larger read is). */
export const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024
/** A copy older than this, found on a sweep, belongs to no live run (the settle watcher gives up after 30 minutes). */
export const STALE_SNAPSHOT_MS = 3 * 60 * 60 * 1000
const PREFIX = 'g1-'

/** A file the gate reads: an annotated engine value, or a `/view` input name read literally. */
export type SnapshotSource = MediaFileRef

export interface GateSnapshots {
  /** The run's copy of `source` (its path, and the name the prompt gives it), or null when it can't be made. */
  take(source: SnapshotSource): Promise<{ path: string, name: string } | null>
  /** The copy's name for `source` if one was made, else null. */
  nameFor(source: SnapshotSource): string | null
  /** Remove every copy (idempotent). */
  release(): Promise<void>
}

/** Where `source` lives on disk, as the engine resolves it, or null. */
export function sourcePath(source: SnapshotSource, folder: (name: 'input' | 'output' | 'temp') => string | null = engineFolder): string | null {
  let dir: string | null
  let name: string
  if (source.literalInput) { dir = folder('input'); name = source.value }
  else {
    const a = annotatedFilepath(source.value)
    dir = folder(a.type ?? 'input')
    name = a.name
  }
  return dir && name ? resolveInside(dir, name) : null
}

let swept = false

async function sweepStale(inputDir: string, now: number): Promise<void> {
  let names: string[]
  try { names = await readdir(inputDir) }
  catch { return }
  await Promise.all(names.filter(n => n.startsWith(PREFIX)).map(async (n) => {
    const p = path.join(inputDir, n)
    try {
      const st = await stat(p)
      if (st.isFile() && now - st.mtimeMs > STALE_SNAPSHOT_MS) await unlink(p)
    }
    catch { /* gone already */ }
  }))
}

async function sha256Of(file: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer)
  return h.digest('hex')
}

/** The extension kept on a copy: the source's, when it is a plain one. */
function extensionOf(name: string): string {
  const ext = path.extname(name).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''
}

export function createGateSnapshots(opts: {
  folder?: (name: 'input' | 'output' | 'temp') => string | null
  token?: string
  now?: () => number
} = {}): GateSnapshots {
  const folder = opts.folder ?? engineFolder
  const token = opts.token ?? randomBytes(12).toString('hex')
  const now = opts.now ?? Date.now
  const bySource = new Map<string, Promise<{ path: string, name: string } | null>>()
  const byKey = new Map<string, string>()
  const made = new Set<string>()
  const keyOf = (s: SnapshotSource) => `${s.literalInput ? 'view' : 'engine'}:${s.value}`
  let released = false

  const copy = async (src: string): Promise<{ path: string, name: string } | null> => {
    const inputDir = folder('input')
    if (!inputDir) return null
    if (!swept) { swept = true; await sweepStale(inputDir, now()) }
    try {
      const st = await stat(src)
      if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return null
    }
    catch { return null }
    const tmp = path.join(inputDir, `${PREFIX}${token}-${randomBytes(8).toString('hex')}.tmp`)
    made.add(tmp)
    try {
      await copyFile(src, tmp, constants.COPYFILE_FICLONE)
      const sha = await sha256Of(tmp)
      const name = `${PREFIX}${token}-${sha}${extensionOf(src)}`
      const final = path.join(inputDir, name)
      made.add(final)
      await rename(tmp, final)
      made.delete(tmp)
      if (released) { await unlink(final).catch(() => {}); return null }
      return { path: final, name }
    }
    catch {
      await unlink(tmp).catch(() => {})
      made.delete(tmp)
      return null
    }
  }

  return {
    take(source) {
      const src = sourcePath(source, folder)
      if (!src || released) return Promise.resolve(null)
      let p = bySource.get(src)
      if (!p) { p = copy(src); bySource.set(src, p) }
      return p.then((r) => {
        if (r) byKey.set(keyOf(source), r.name)
        return r
      })
    },
    nameFor(source) {
      return byKey.get(keyOf(source)) ?? null
    },
    async release() {
      released = true
      await Promise.all([...bySource.values()].map(p => p.catch(() => null)))
      await Promise.all([...made].map(f => unlink(f).catch(() => {})))
      made.clear()
    },
  }
}

/** Tests: sweep again on the next snapshot. */
export function __resetSnapshotSweepForTests(): void { swept = false }

// ── The forwarded prompt names the copies ─────────────────────────────────

type Prompt = Record<string, any>

/** The node inputs holding an engine file value the gate measures: pictures (graphInputPixels) and sounds (graphInputSeconds). */
const ENGINE_FILE_SLOTS: Readonly<Record<string, readonly string[]>> = {
  LoadImage: ['image'],
  Image: ['image'],
  LoadAudio: ['audio'],
  Audio: ['audio'],
}

/**
 * The `/view` references inside `model_options` the gate measures: a
 * lip-sync's sound and face video (clipSettings secondsPricedMedia), and a
 * Seedance node's reference videos and sounds (graphInputSeconds
 * seedanceReferenceLists).
 */
const VIEW_REF_KEYS: Readonly<Record<string, readonly string[]>> = {
  LipSyncNode: ['audio', 'face_video'],
  GenerateVideoNode: ['video_urls', 'audio_urls'],
}

/** The problem when a measured reference can't be renamed exactly in its node's options. */
export const MEASURED_REF_UNRENAMABLE = 'Sailor can\'t prepare one of this step\'s linked files for the run. Add the file again, then run once more.'

/** A `/view` reference's input file name, read exactly as the gate read it to measure it (clipSettings readViewRef), or null. */
function viewRefName(v: unknown): string | null {
  let r: ReturnType<typeof readViewRef> = null
  try { r = readViewRef(v) }
  catch { r = null }
  return r?.name && !r.refused ? r.name : null
}

/** Every string equal to a key of `map`, replaced (a deep copy). */
function replaceStrings(v: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof v === 'string') return map.get(v) ?? v
  if (Array.isArray(v)) return v.map(x => replaceStrings(x, map))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceStrings(x, map)]))
  return v
}

/**
 * The prompt with every measured file named by its run copy (a new object;
 * the caller's is untouched), or the problems where a copy can't be named
 * exactly (refused). Engine file values are replaced outright. A `/view`
 * reference inside `model_options` (JSON text) is replaced in place, the
 * reference's own JSON string swapped for the copy's, so no other byte of
 * the options changes; the result is parsed back and must equal the options
 * with only those references changed, else it is refused.
 */
export function rewriteMeasuredInputs(prompt: Prompt, snaps: Pick<GateSnapshots, 'nameFor'>): { prompt: Prompt } | { problems: { nodeId: string, classType: string, input: string, message: string }[] } {
  const out = structuredClone(prompt) as Prompt
  const problems: { nodeId: string, classType: string, input: string, message: string }[] = []
  for (const [nodeId, node] of Object.entries(out)) {
    const ct = node?.class_type
    const inputs = node?.inputs
    if (typeof ct !== 'string' || !inputs || typeof inputs !== 'object') continue
    for (const slot of ENGINE_FILE_SLOTS[ct] ?? []) {
      const v = inputs[slot]
      if (typeof v !== 'string' || !v) continue
      const copy = snaps.nameFor({ value: v, literalInput: false })
      if (copy) inputs[slot] = copy
    }
    const keys = VIEW_REF_KEYS[ct]
    const raw = inputs.model_options
    if (!keys || typeof raw !== 'string' || !raw) continue
    let options: unknown
    try { options = JSON.parse(raw) }
    catch { continue }
    if (!options || typeof options !== 'object' || Array.isArray(options)) continue
    const map = new Map<string, string>()
    for (const key of keys) {
      const v = (options as Record<string, unknown>)[key]
      for (const ref of Array.isArray(v) ? v : [v]) {
        const name = viewRefName(ref)
        const copy = name ? snaps.nameFor({ value: name, literalInput: true }) : null
        if (copy && typeof ref === 'string') map.set(ref, `/view?filename=${encodeURIComponent(copy)}&type=input`)
      }
    }
    if (!map.size) continue
    let text = raw
    for (const [from, to] of map) text = text.split(JSON.stringify(from)).join(JSON.stringify(to))
    let reread: unknown
    try { reread = JSON.parse(text) }
    catch { reread = undefined }
    if (JSON.stringify(reread) !== JSON.stringify(replaceStrings(options, map))) {
      problems.push({ nodeId, classType: ct, input: 'model_options', message: MEASURED_REF_UNRENAMABLE })
      continue
    }
    inputs.model_options = text
  }
  return problems.length ? { problems } : { prompt: out }
}
