/**
 * The Shader effect's baked frames on disk (step 3, R11.9c fix round 1, I2
 * and I4). The browser uploads each frame as it draws it, into a folder of
 * its own for that bake: `input/shader_bake/<32 random hex>/`, so two
 * accounts whose frames are byte for byte the same never share a name (the
 * hosted upload gate would refuse the second: the name is the first's), and
 * no one can take a name another bake will use. A bake is "claimed" when a
 * run starts that names its frames (a `.claimed` marker in its folder naming
 * the run, written before the run is persisted, after its checks and
 * moderation): its frames are then the run's inputs, kept while the run can
 * still need them (running, or paused at a Gate: a resume or a Gate's redo
 * renders the node again from them). Fix round 2 (N1): when the run ends
 * (done, error, stopped: no longer resumable) its claim is let go and a
 * folder no run claims any more is deleted (`releaseShaderBakes`); a server
 * start does the same for every run no longer in progress, as it lets go of
 * their kept files (`releaseInactiveShaderBakes`, beside kept.keepOnly). A
 * folder never claimed is not a delivered bake and
 * is deleted: when the browser abandons it (Stop, or a failure mid-bake:
 * POST /api/runs/shader-bake-abandon), else once it is older than
 * SHADER_BAKE_UNCLAIMED_MS (`sweepShaderBakes`, run now and then at a run's
 * start and on an abandon). Bakes named before fix round 1 (flat
 * `shader_bake_<hash>.png`) are still read; they are not swept.
 */
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { ApiPrompt } from '#shared/runner/graph'
import { parseShaderBaked } from '#shared/runner/shaderBakeKey'
import { parseInputFileRef } from './inputs'

/** The folder every bake folder is in, under input. */
export const SHADER_BAKE_ROOT = 'shader_bake'
/** A bake folder as its frames' subfolder names it. */
const BAKE_FOLDER = /^shader_bake\/([0-9a-f]{32})$/
/** The marker a run's start writes into each bake folder it reads. */
export const CLAIMED_MARKER = '.claimed'
/** How old an unclaimed bake folder may get before the sweep deletes it (a bake in progress keeps touching it). */
export const SHADER_BAKE_UNCLAIMED_MS = 6 * 60 * 60 * 1000
/** The sweep runs at most this often. */
export const SHADER_BAKE_SWEEP_EVERY_MS = 10 * 60 * 1000

/** A bake folder's subfolder (`shader_bake/<hex>`), or null for anything else. */
export function bakeFolderOf(subfolder: string): string | null {
  const s = subfolder.replace(/\\/g, '/').replace(/\/+$/, '')
  return BAKE_FOLDER.test(s) ? s : null
}

/** Every bake folder a prompt's Shader effects read. */
export function bakeFoldersOf(prompts: readonly ApiPrompt[]): string[] {
  const out = new Set<string>()
  for (const p of prompts) {
    for (const n of Object.values(p)) {
      if (n.class_type !== 'ShaderEffect') continue
      for (const f of parseShaderBaked(n.inputs?.sailor_baked)?.files ?? []) {
        const ref = parseInputFileRef(f)
        const folder = ref ? bakeFolderOf(ref.subfolder) : null
        if (folder) out.add(folder)
      }
    }
  }
  return [...out]
}

function folderPath(inputRoot: string, folder: string): string | null {
  const root = resolve(inputRoot)
  const p = resolve(root, folder)
  return p.startsWith(root + sep) && bakeFolderOf(folder) ? p : null
}

/** The runs a claimed folder's marker names (one per line). */
async function claimsOf(p: string): Promise<string[] | null> {
  try { return (await readFile(join(p, CLAIMED_MARKER), 'utf8')).split('\n').map(x => x.trim()).filter(Boolean) }
  catch { return null }
}

/**
 * A run that reads these bake folders has started: each is claimed for it
 * (never swept or abandoned while claimed). Fix round 2 (N3): `ownsAll`
 * (hosted) must say every file in the folder is the run's owner's, else the
 * folder is not claimed (another account's file in it can't pin it). Returns
 * the folders claimed.
 */
export async function claimShaderBakes(inputRoot: string, folders: readonly string[], runId: string, ownsAll: (folder: string, filenames: string[]) => Promise<boolean> = async () => true): Promise<string[]> {
  const claimed: string[] = []
  for (const f of folders) {
    const p = folderPath(inputRoot, f)
    if (!p) continue
    try {
      const names = (await readdir(p)).filter(n => n !== CLAIMED_MARKER)
      if (!(await ownsAll(f, names))) continue
      const runs = (await claimsOf(p)) ?? []
      await writeFile(join(p, CLAIMED_MARKER), [...new Set([...runs, runId])].join('\n'))
      claimed.push(f)
    }
    catch { /* a folder that isn't there: its frames fail plainly at the node's turn */ }
  }
  return claimed
}

/**
 * Fix round 2 (N1): this run has ended (no longer resumable): its claim on
 * each folder is let go, and a folder no run claims any more is deleted.
 */
export async function releaseShaderBakes(inputRoot: string, folders: readonly string[], runId: string): Promise<void> {
  for (const f of folders) {
    const p = folderPath(inputRoot, f)
    if (!p) continue
    const runs = await claimsOf(p)
    if (!runs) continue
    const left = runs.filter(r => r !== runId)
    try {
      if (left.length) await writeFile(join(p, CLAIMED_MARKER), left.join('\n'))
      else await rm(p, { recursive: true, force: true })
    }
    catch { /* gone meanwhile */ }
  }
}

/**
 * Fix round 2 (N1, N2): at a server start, as the kept files of runs no
 * longer in progress are let go (kept.keepOnly): every claim naming a run
 * not in `activeRunIds` is let go, and a folder left unclaimed by it is
 * deleted (a run that ended while the server was down, or a claim whose run
 * was never saved).
 */
export async function releaseInactiveShaderBakes(inputRoot: string, activeRunIds: ReadonlySet<string>): Promise<number> {
  let removed = 0
  const base = join(resolve(inputRoot), SHADER_BAKE_ROOT)
  let dirs: string[]
  try { dirs = await readdir(base) }
  catch { return 0 }
  for (const d of dirs) {
    if (!/^[0-9a-f]{32}$/.test(d)) continue
    const p = join(base, d)
    const runs = await claimsOf(p)
    if (!runs) continue
    const left = runs.filter(r => activeRunIds.has(r))
    if (left.length === runs.length) continue
    try {
      if (left.length) await writeFile(join(p, CLAIMED_MARKER), left.join('\n'))
      else { await rm(p, { recursive: true, force: true }); removed++ }
    }
    catch { /* gone meanwhile */ }
  }
  return removed
}

/**
 * The browser gave up on this bake (Stop, a failure): its folder is deleted,
 * unless a run has claimed it, or (`owns`, hosted) a frame in it isn't the
 * caller's. Returns whether it was deleted.
 */
export async function abandonShaderBake(inputRoot: string, folder: string, owns: (filename: string) => Promise<boolean>): Promise<boolean> {
  const p = folderPath(inputRoot, folder)
  if (!p) return false
  let names: string[]
  try { names = await readdir(p) }
  catch { return false }
  if (names.includes(CLAIMED_MARKER)) return false
  for (const n of names) if (!(await owns(n))) return false
  await rm(p, { recursive: true, force: true })
  return true
}

let lastSweep = 0

/** Test seam: forget when the sweep last ran. */
export function __resetShaderBakeSweepForTests(): void { lastSweep = 0 }

/**
 * Deletes every unclaimed bake folder older than SHADER_BAKE_UNCLAIMED_MS (its
 * newest change), at most once every SHADER_BAKE_SWEEP_EVERY_MS. Never throws.
 */
export async function sweepShaderBakes(inputRoot: string, now = Date.now()): Promise<number> {
  if (now - lastSweep < SHADER_BAKE_SWEEP_EVERY_MS) return 0
  lastSweep = now
  let removed = 0
  const base = join(resolve(inputRoot), SHADER_BAKE_ROOT)
  let dirs: string[]
  try { dirs = await readdir(base) }
  catch { return 0 }
  for (const d of dirs) {
    if (!/^[0-9a-f]{32}$/.test(d)) continue
    const p = join(base, d)
    try {
      // Fix round 2 (N4): a claimed folder is skipped from its marker alone (its frames aren't listed).
      if (await stat(join(p, CLAIMED_MARKER)).then(() => true, () => false)) continue
      const names = await readdir(p)
      let newest = (await stat(p)).mtimeMs
      for (const n of names) newest = Math.max(newest, (await stat(join(p, n))).mtimeMs)
      if (now - newest < SHADER_BAKE_UNCLAIMED_MS) continue
      await rm(p, { recursive: true, force: true })
      removed++
    }
    catch { /* gone meanwhile */ }
  }
  return removed
}
