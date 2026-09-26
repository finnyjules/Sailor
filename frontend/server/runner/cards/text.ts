/**
 * The Text and 3D model cards (step 3, R1.1). Their value is their static
 * evaluator (#shared/runner/staticValues.ts), planned by staticDerive
 * (../executors.ts); both are ComfyUI output nodes that echo it as
 * `ui.text` (comfy_extras/nodes_text.py TextNode, nodes_model3d.py
 * Model3DNode), which is what the card shows.
 */
import type { RunnerValue } from '../types'

/** `ui = {"text": [value]}`: slot 0's text. */
export function textCardUi(values: Record<number, RunnerValue>): { text: string[] } {
  return { text: [(values[0] as { text: string }).text] }
}
