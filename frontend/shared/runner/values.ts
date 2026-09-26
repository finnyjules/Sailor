/**
 * What each runner class's output slots carry (R0, step 3 spec), read by the
 * browser (routing, the needs-the-engine names) and the server (the runner).
 * A class not listed carries files on every slot, as before step 3.
 * Keep this file free of imports but ./graph.
 */
import { GATE_CLASS, isLink, type ApiLink, type ApiPrompt } from './graph'

export type ValueKind = 'files' | 'mask' | 'text' | 'number' | 'boolean' | 'json' | 'glb'

/** Every kind a wire can carry that is not files. */
export const VALUE_KINDS_ALL: readonly ValueKind[] = ['mask', 'text', 'number', 'boolean', 'json', 'glb']

/** Output slots that carry something other than files, by class. Rows are added by the cards (R0.4, R1). */
export const OUTPUT_KINDS: Readonly<Record<string, Readonly<Record<number, ValueKind>>>> = {
  PrimitiveString: { 0: 'text' },
  PrimitiveStringMultiline: { 0: 'text' },
  PrimitiveInt: { 0: 'number' },
  PrimitiveFloat: { 0: 'number' },
  PrimitiveBoolean: { 0: 'boolean' },
  Text: { 0: 'text' },
  Moodboard: { 0: 'text' },
  Model3D: { 0: 'text' },
  // R1.3: the bake-replay cards' masks, and LoadImage's MASK (a value only
  // when the LoadImage runs as a card; fed to a Frame the old way it is still
  // the file, which the Frame reads as before).
  TextOnPath: { 1: 'mask' },
  TextMask: { 1: 'mask' },
  LoadImage: { 1: 'mask' },
  // R1.4: the picture utilities' values.
  GetImageSize: { 0: 'number', 1: 'number', 2: 'number' },
  ImageToMask: { 0: 'mask' },
}

/** What a wire carries: the source's declared kind for that slot (through Gates), files by default. */
export function outputKind(
  prompt: ApiPrompt, link: ApiLink,
  kinds: Readonly<Record<string, Readonly<Record<number, ValueKind>>>> = OUTPUT_KINDS,
  depth = 0,
): ValueKind {
  const node = prompt[link[0]]
  if (!node || depth > 64) return 'files'
  if (node.class_type === GATE_CLASS) {
    const d = node.inputs?.data_in
    return isLink(d) ? outputKind(prompt, d, kinds, depth + 1) : 'files'
  }
  const row = Object.prototype.hasOwnProperty.call(kinds, node.class_type) ? kinds[node.class_type] : undefined
  return row && Object.prototype.hasOwnProperty.call(row, link[1]) ? row[link[1]]! : 'files'
}

/**
 * Value inputs of the runner's own node types that have no rule row (the
 * Gate): a Gate hands on whatever reaches it, files as before or a value.
 */
export const BASE_VALUE_INPUTS: Readonly<Record<string, Readonly<Record<string, readonly ValueKind[]>>>> = {
  [GATE_CLASS]: { data_in: ['files', ...VALUE_KINDS_ALL] },
}
