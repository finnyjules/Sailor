/**
 * A runner node's results per output slot (R0, step 3). The one place that
 * says how a slot is read, which files a value names, and what a wired
 * value looks like to the node that reads it.
 */
import { GATE_CLASS, isLink, type ApiPrompt } from '#shared/runner/graph'
import { outputKind } from '#shared/runner/values'
import type { NodeRecord, OutputFile, RunnerValue } from './types'

/** The most characters one text value may carry (a long transcript fits; a run record stays small). */
export const MAX_VALUE_TEXT_CHARS = 262_144
export const VALUE_TOO_LONG = 'This text is too long to pass on (over 262,144 characters)'
export const VALUE_NOT_FINITE = 'This number can’t be passed on (it isn’t a finite number)'

/**
 * What a link to (this record, slot) reads. A record without values reads
 * as before R0: a later slot of a node that keeps per-slot files reads
 * those (the Frame's protect_mask), every other slot reads `outputs`.
 */
export function slotValue(rec: NodeRecord | undefined, slot: number): RunnerValue | undefined {
  if (!rec) return undefined
  if (rec.values) return Object.prototype.hasOwnProperty.call(rec.values, slot) ? rec.values[slot] : undefined
  if (slot > 0 && rec.slotOutputs) return { kind: 'files', files: rec.slotOutputs[slot] ?? [] }
  return { kind: 'files', files: rec.outputs }
}

/** The files a value names (none for text, numbers, booleans and JSON). */
export function filesOf(v: RunnerValue | undefined): OutputFile[] {
  if (!v) return []
  switch (v.kind) {
    case 'files':
    case 'mask':
      return v.files
    case 'glb':
      return v.file ? [v.file] : []
    default:
      return []
  }
}

const fileKey = (f: OutputFile) => `${f.type}:${f.subfolder}:${f.filename}`

/** Every file named across a node's values, once, in slot order. */
export function filesOfValues(values: Record<number, RunnerValue>): OutputFile[] {
  const seen = new Map<string, OutputFile>()
  for (const slot of Object.keys(values).map(Number).sort((a, b) => a - b)) {
    for (const f of filesOf(values[slot])) if (!seen.has(fileKey(f))) seen.set(fileKey(f), f)
  }
  return [...seen.values()]
}

export type Literal = string | number | boolean

/** The value as a typed widget would hold it, or undefined for files and masks (which stay wires). */
export function literalOf(v: RunnerValue | undefined): Literal | undefined {
  switch (v?.kind) {
    case 'text': return v.text
    case 'number': return v.value
    case 'boolean': return v.value
    case 'json': return v.text
    case 'glb': return v.url
    default: return undefined
  }
}

/** Throws the plain refusal for a value the runner can't keep or pass on. */
export function checkValue(v: RunnerValue): void {
  const text = v.kind === 'text' || v.kind === 'json' ? v.text : v.kind === 'glb' ? v.url : null
  if (text !== null && text.length > MAX_VALUE_TEXT_CHARS) throw new Error(VALUE_TOO_LONG)
  if (v.kind === 'number' && !Number.isFinite(v.value)) throw new Error(VALUE_NOT_FINITE)
}

export const WIRED_VALUE_MISSING = 'A value this step reads was not made'

/**
 * The workflow as one node's builder reads it: every wire into that node
 * that carries a value (text, a number, true/false, JSON text, an address)
 * replaced by the value itself, exactly as ComfyUI's execute() receives it.
 * Wires that carry files or masks are left as wires. `injected` lists the
 * non-blank texts substituted (moderated at the node's turn, R0.5). A value
 * wire whose value is missing is refused: never sent as blank. A Gate
 * keeps its wire: it hands on whatever reaches it (executors.ts reads the
 * source's value through `valueFrom`).
 */
export function withWiredValues(
  prompt: ApiPrompt, nodeId: string, valueAt: (link: [string, number]) => RunnerValue | undefined,
): { prompt: ApiPrompt; injected: { input: string; text: string }[] } {
  const node = prompt[nodeId]
  if (!node || node.class_type === GATE_CLASS) return { prompt, injected: [] }
  let inputs: Record<string, unknown> | null = null
  const injected: { input: string; text: string }[] = []
  for (const [name, v] of Object.entries(node.inputs ?? {})) {
    if (!isLink(v)) continue
    const kind = outputKind(prompt, v)
    if (kind === 'files' || kind === 'mask') continue
    const lit = literalOf(valueAt(v))
    if (lit === undefined) throw new Error(WIRED_VALUE_MISSING)
    inputs ??= { ...node.inputs }
    inputs[name] = lit
    if (typeof lit === 'string' && lit.trim()) injected.push({ input: name, text: lit })
  }
  return inputs ? { prompt: { ...prompt, [nodeId]: { ...node, inputs } }, injected } : { prompt, injected: [] }
}
