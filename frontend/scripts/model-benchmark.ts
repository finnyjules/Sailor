/**
 * Makes the image model benchmark pictures (app/data/model-benchmark.ts).
 *
 * Each picture is a normal "Generate an image" run posted to the dev server,
 * so it goes through the same runner, price and hold as a real one. PAID:
 * it prints the count and the estimated cost and asks before starting.
 *
 *   npx tsx scripts/model-benchmark.ts [--prompts redhead,neon-sign] [--models nano-banana-2,…] [--redo] [--yes]
 *
 * Needs the dev server on 127.0.0.1:3002 (override with BENCHMARK_SERVER).
 * The model list follows the local .env's NUXT_PUBLIC_RUNNER_FAMILIES, like the picker.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import sharp from 'sharp'
import { IMAGE_MODELS } from '../app/data/image-models'
import {
  BENCHMARK_ASPECT_RATIO, BENCHMARK_PROMPTS, BENCHMARK_SEED, benchmarkFile, benchmarkModels, planBenchmark,
  type BenchmarkJob, type BenchmarkManifest,
} from '../app/data/model-benchmark'
import { NO_FAMILIES, parseFamilies } from '../shared/runner/families'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'public/model-benchmark')
const MANIFEST = join(OUT_DIR, 'manifest.json')
const SERVER = process.env.BENCHMARK_SERVER ?? 'http://127.0.0.1:3002'
const SIZE = 640
const QUALITY = 80
const CONCURRENCY = 4
const TIMEOUT_MS = 10 * 60_000

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)
const list = (name: string) => arg(name)?.split(',').map(s => s.trim()).filter(Boolean)

function envFamilies() {
  const env = readFileSync(join(ROOT, '.env'), 'utf8')
  const enabled = /^NUXT_PUBLIC_RUNNER_ENABLED=(.*)$/m.exec(env)?.[1]?.trim() === 'true'
  const raw = /^NUXT_PUBLIC_RUNNER_FAMILIES=(.*)$/m.exec(env)?.[1]?.trim()
  return enabled ? parseFamilies(raw ?? '') : NO_FAMILIES
}

function readManifest(): BenchmarkManifest {
  if (!existsSync(MANIFEST)) return { version: 1, results: {} }
  return JSON.parse(readFileSync(MANIFEST, 'utf8')) as BenchmarkManifest
}

function writeManifest(m: BenchmarkManifest) {
  mkdirSync(OUT_DIR, { recursive: true })
  const tmp = `${MANIFEST}.tmp`
  writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`)
  renameSync(tmp, MANIFEST)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Picture = { filename: string, subfolder?: string, type?: string }
type Waiter = { resolve: (p: Picture) => void, reject: (e: Error) => void, picture?: Picture }

// The runner reports through one server-sent event stream (GET /api/runs/events),
// shaped like ComfyUI's WebSocket events. One reader serves every job, and
// reconnects if the stream drops. It is only the fast path: each job also
// looks for its own saved file (onRunner), so a dropped stream can't lose one.
const waiters = new Map<string, Waiter>()
let events: AbortController | null = null

async function openEvents(): Promise<void> {
  events = new AbortController()
  const signal = events.signal
  let ready!: () => void
  const opened = new Promise<void>(r => (ready = r))
  void (async () => {
    while (!signal.aborted) {
      try {
        const res = await fetch(`${SERVER}/api/runs/events`, { signal })
        if (!res.ok || !res.body) throw new Error(`runner events: ${res.status}`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let cut: number
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, cut)
            buf = buf.slice(cut + 2)
            if (block.includes('event: ready')) ready()
            for (const line of block.split('\n')) if (line.startsWith('data: ')) onEvent(line.slice(6))
          }
        }
      }
      catch { /* dropped, or closed at the end of the run */ }
      if (!signal.aborted) await sleep(1000)
    }
  })()
  await Promise.race([opened, sleep(3000)])
}

function onEvent(raw: string) {
  let msg: { type?: string, data?: any }
  try { msg = JSON.parse(raw) } catch { return }
  const w = msg.data?.prompt_id ? waiters.get(msg.data.prompt_id) : undefined
  if (!w) return
  if (msg.type === 'executed') {
    const img = msg.data.output?.images?.[0] as Picture | undefined
    // The Save node's file is the one to keep; the generator's own will do if it comes alone.
    if (img && (msg.data.node === '2' || !w.picture)) w.picture = img
  }
  else if (msg.type === 'execution_error') w.reject(new Error(String(msg.data.exception_message ?? 'run failed').trim().slice(0, 300)))
  else if (msg.type === 'execution_success') w.picture ? w.resolve(w.picture) : w.reject(new Error('finished with no picture'))
}

function workflowFor(job: BenchmarkJob, prefix: string) {
  return {
    1: {
      class_type: 'GenerateImageNode',
      inputs: {
        model: job.model.id,
        prompt: job.prompt.prompt,
        aspect_ratio: BENCHMARK_ASPECT_RATIO,
        seed: BENCHMARK_SEED,
        model_options: '{}',
      },
    },
    // A run needs an output node; "Generate an image" alone has "no outputs".
    2: {
      class_type: 'SaveImage',
      inputs: {
        images: ['1', 0], filename_prefix: prefix, format: 'png', quality: 90, lossless_webp: false,
        png_compression: 4, scale: 1, max_dimension: 0, embed_metadata: false,
      },
    },
  }
}

const NOT_TAKEN = /not-taken|switched-off/

/** On the runner, as the app sends it. Null when the runner doesn't take this workflow (it then goes to the engine). */
async function onRunner(prompt: ReturnType<typeof workflowFor>, prefix: string): Promise<Picture | null> {
  const res = await fetch(`${SERVER}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ takes: [prompt], workflow: null }) })
  const text = await res.text()
  if (!res.ok) {
    if (NOT_TAKEN.test(text)) return null
    let message = text
    try { message = (JSON.parse(text) as { message?: string }).message ?? text } catch {}
    throw new Error(`refused: ${message.slice(0, 300)}`)
  }
  const id = (JSON.parse(text) as { promptIds?: string[] }).promptIds?.[0]
  if (!id) throw new Error('the runner gave no run id')
  // Each job saves under its own prefix, so its file is always `<prefix>_00001_.png`:
  // poll for it as well as listening, in case the event stream dropped.
  const file: Picture = { filename: `${prefix}_00001_.png`, subfolder: '', type: 'output' }
  return await new Promise<Picture>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => done(() => reject(new Error(`no result after ${TIMEOUT_MS / 60_000} min`))), TIMEOUT_MS)
    const done = (f: () => void) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(poll); waiters.delete(id); f() }
    const poll = setInterval(async () => {
      const q = new URLSearchParams({ filename: file.filename, subfolder: '', type: 'output' })
      const ok = await fetch(`${SERVER}/view?${q}`, { method: 'HEAD' }).then(r => r.ok).catch(() => false)
      if (ok) done(() => resolve(file))
    }, 5000)
    waiters.set(id, { resolve: p => done(() => resolve(p)), reject: e => done(() => reject(e)) })
  })
}

/** On the engine (ComfyUI): POST /prompt, then poll /history. */
async function onEngine(prompt: ReturnType<typeof workflowFor>): Promise<Picture> {
  const res = await fetch(`${SERVER}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: 'model-benchmark', prompt }) })
  const queued = await res.json().catch(() => ({})) as { prompt_id?: string, error?: { message?: string }, node_errors?: unknown }
  if (!res.ok || !queued.prompt_id) throw new Error(`refused: ${queued.error?.message ?? res.status}`)
  const id = queued.prompt_id
  const until = Date.now() + TIMEOUT_MS
  while (Date.now() < until) {
    await sleep(3000)
    const h = await fetch(`${SERVER}/history/${id}`).then(r => r.json()).catch(() => ({})) as Record<string, any>
    const entry = h[id]
    if (!entry) continue
    const status = entry.status as { status_str?: string, completed?: boolean, messages?: [string, any][] } | undefined
    if (status?.status_str === 'error') {
      const err = status.messages?.find(m => m[0] === 'execution_error')?.[1]
      throw new Error(String(err?.exception_message ?? 'run failed').trim().slice(0, 300))
    }
    const img = (entry.outputs?.['2'] ?? entry.outputs?.['1'])?.images?.[0] as Picture | undefined
    if (img) return img
    if (status?.completed) throw new Error('finished with no picture')
  }
  throw new Error(`no result after ${TIMEOUT_MS / 60_000} min`)
}

/** Runs one job; resolves to the output picture's bytes and where it ran, or throws with the reason. */
async function run(job: BenchmarkJob): Promise<{ bytes: Buffer, where: string }> {
  const prefix = `model_benchmark_${job.prompt.id}_${job.model.id}_${Date.now().toString(36)}`.replace(/[^\w-]/g, '_')
  const prompt = workflowFor(job, prefix)
  let where = 'runner'
  let img = await onRunner(prompt, prefix)
  if (!img) { where = 'engine'; img = await onEngine(prompt) }
  const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' })
  const pic = await fetch(`${SERVER}/view?${q}`)
  if (!pic.ok) throw new Error(`could not fetch the picture: ${pic.status}`)
  return { bytes: Buffer.from(await pic.arrayBuffer()), where }
}

async function main() {
  const promptIds = list('prompts')
  const modelIds = list('models')
  const prompts = promptIds ? BENCHMARK_PROMPTS.filter(p => promptIds.includes(p.id)) : [...BENCHMARK_PROMPTS]
  let models = benchmarkModels(IMAGE_MODELS, envFamilies())
  if (modelIds) models = models.filter(m => modelIds.includes(m.id))
  for (const id of promptIds ?? []) if (!prompts.some(p => p.id === id)) throw new Error(`unknown prompt "${id}"`)
  for (const id of modelIds ?? []) if (!models.some(m => m.id === id)) throw new Error(`"${id}" is not a model the picker shows`)

  const manifest = readManifest()
  const jobs = planBenchmark(prompts, models, manifest, flag('redo'))
  const cost = jobs.reduce((s, j) => s + (j.model.pricePerImage ?? 0), 0)
  console.log(`${prompts.length} prompt(s) × ${models.length} model(s): ${jobs.length} picture(s) to make, about $${cost.toFixed(2)} at listed prices.`)
  if (!jobs.length) return
  if (!flag('yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question('Go ahead? [y/N] ')).trim().toLowerCase()
    rl.close()
    if (answer !== 'y') return console.log('Stopped, nothing made.')
  }

  let made = 0
  const failed: string[] = []
  const queue = [...jobs]
  async function worker() {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const tag = `${job.prompt.id} / ${job.model.id}`
      const results = (manifest.results[job.prompt.id] ??= {})
      try {
        const { bytes, where } = await run(job)
        const file = benchmarkFile(job.prompt.id, job.model.id)
        const dest = join(OUT_DIR, file)
        mkdirSync(dirname(dest), { recursive: true })
        await sharp(bytes).resize(SIZE, SIZE, { fit: 'cover' }).webp({ quality: QUALITY }).toFile(dest)
        results[job.model.id] = { file, made: new Date().toISOString().slice(0, 10) }
        made++
        console.log(`✓ ${tag} (${where})`)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        results[job.model.id] = { failed: reason, at: new Date().toISOString().slice(0, 10) }
        failed.push(`${tag}: ${reason}`)
        console.log(`✗ ${tag}: ${reason}`)
      }
      writeManifest(manifest)
    }
  }
  await openEvents()
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  events?.abort()

  console.log(`\nMade ${made}, failed ${failed.length}.`)
  for (const f of failed) console.log(`  ✗ ${f}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
