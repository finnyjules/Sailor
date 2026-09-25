// What the canvas tells the one prompt: a chip label for the selection and 2–3
// suggestions. Labels quote the node's own title (UI-copy rule), never a role.
// "What does this do?" is how Explain is reached now (spec §5).

export interface PromptNode { id: string; title: string; type: string; hasImages: boolean }

export function selectionLabel(sel: PromptNode[]): string | null {
  if (!sel.length) return null
  if (sel.length > 1) return `${sel.length} nodes`
  const only = sel[0]!
  return only.title.trim() || only.type
}

export function canvasSuggestions(sel: PromptNode[], graphEmpty: boolean): string[] {
  if (!sel.length) return graphEmpty ? ['A red fox in the snow', 'What can Sailor make?'] : ['What does this graph do?', 'What should I try next?']
  if (sel.length > 1) return ['What do these do?', 'Connect these']
  return sel[0]!.hasImages ? ['What does this do?', 'Make it warmer', 'Upscale it'] : ['What does this do?', 'What can I connect to this?']
}
