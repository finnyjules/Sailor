/**
 * LC8 (B3): the type an auto-sink (VueNodeCanvas materializeAutoImageSinks)
 * judges an output slot by. The run reads a wire by the output's INDEX
 * (graphToPrompt sends `[node, slot]`), and the engine and the runner type
 * that index from the node catalogue (/object_info `output`), not from the
 * card's own saved outputs list. A list that drifted from the catalogue (an
 * extra output saved ahead of the real ones: a Load video frames card listing
 * IMAGE, frames, fps where the catalogue has frames, fps) must not grow an
 * Image card on slot 1, which carries the rate (FLOAT).
 *
 * The catalogue's type wins where the class is in it; a slot past its
 * outputs gets no sink; a class it doesn't hold (a frontend-only card)
 * keeps the card's own type.
 */
export function autoSinkSlotType(
  cardType: string,
  catalogOutputs: readonly unknown[] | null | undefined,
  index: number,
): string | null {
  const own = String(cardType).toUpperCase()
  if (!Array.isArray(catalogOutputs)) return own
  if (index < 0 || index >= catalogOutputs.length) return null
  const t = catalogOutputs[index]
  if (typeof t !== 'string') return null
  return t.toUpperCase() === own ? own : null
}
