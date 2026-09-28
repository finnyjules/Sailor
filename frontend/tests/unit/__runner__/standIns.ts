/**
 * For the engine-mechanics specs whose stand-in nodes (a Generate image or
 * video carrying a test plan) play paid nodes that are ComfyUI output nodes
 * (a 3D model, a sound, a value shown on the node): ComfyUI's pruning
 * (shared/runner/validate.ts pruneInvalidOutputs) with each stand-in counted
 * as an output, and everything else pruned for real (R3.8 fix round 2).
 *
 * Each stand-in gets a hidden Image card reading it (an output the pruning
 * knows), taken out of the result again. No imports: the spec's vi.mock
 * factory hands in the real function.
 */
import type { ApiPrompt } from '#shared/runner/graph'

const SINK = '__stand_in_sink_'


export function pruneWithStandIns<R extends { prompt: ApiPrompt; unread: string[] }>(
  real: (p: ApiPrompt, families?: any) => R,
  p: ApiPrompt,
  families: unknown,
  standIn: (n: ApiPrompt[string]) => boolean,
): R {
  const ids = Object.keys(p).filter(id => standIn(p[id]!))
  if (!ids.length) return real(p, families)
  const sinks: ApiPrompt = Object.fromEntries(ids.map(id => [`${SINK}${id}`, { class_type: 'Image', inputs: { image: '', export: false, images: [id, 0], batch_index: -1 } }]))
  const r = real({ ...p, ...sinks }, families)
  const prompt = Object.fromEntries(Object.entries(r.prompt).filter(([id]) => !id.startsWith(SINK)))
  return { ...r, prompt: Object.keys(prompt).length === Object.keys(p).length ? p : prompt, unread: r.unread.filter(id => !id.startsWith(SINK)) }
}

