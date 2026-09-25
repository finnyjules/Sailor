// Which worker runs a routed request in a studio (AI in Sailor spec §4; stage 4
// plan rulings 1–4). Every studio keeps its own agent; this only decides whether
// the request goes to it or gets a plain message. Pure.
import type { RouterKind } from '~~/shared/promptRouter/router'
import { DISPATCH_MESSAGES } from '~/lib/prompt/canvasDispatch'

export type StudioPromptPlace = 'studio' | 'frame' | 'template' | 'scene3d'
export type StudioDispatch = { worker: 'ask'; text: string } | { worker: 'message'; message: string }

export const VARY_REQUEST = 'Three different directions'

export const STUDIO_MESSAGES = {
  newEffect: DISPATCH_MESSAGES.newEffect,
  copyInFrame: 'Copy is written in Frame. Open a Frame to write or rewrite its words.',
  layoutInFrame: 'Layouts are arranged in Frame. Open a Frame to try other layouts.',
  noWorker3d: '3D can’t take instructions yet. Use the tools below, or the inspector.',
  nothingToVary: 'Type what to change, or pick an action in the inspector.',
} as const

export function studioDispatch(
  kind: RouterKind,
  text: string,
  o: { place: StudioPromptPlace; hasWorker: boolean; canTakes: boolean; fromMenu?: boolean },
): StudioDispatch {
  const t = text.trim()
  if (!o.hasWorker) return { worker: 'message', message: STUDIO_MESSAGES.noWorker3d }
  if (kind === 'new-effect') return { worker: 'message', message: STUDIO_MESSAGES.newEffect }
  if ((kind === 'copy' || kind === 'layout') && o.place === 'studio')
    return { worker: 'message', message: kind === 'copy' ? STUDIO_MESSAGES.copyInFrame : STUDIO_MESSAGES.layoutInFrame }
  if (!t) {
    if (kind === 'tweak' && o.fromMenu && o.canTakes) return { worker: 'ask', text: VARY_REQUEST }
    return { worker: 'message', message: STUDIO_MESSAGES.nothingToVary }
  }
  return { worker: 'ask', text: t }
}

const LABEL_MAX = 24
const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s)

/** Frame's prompt chip (plan ruling 19): the layer's own words, never a guessed role. */
export function frameSelectionLabel(layers: { kind: string; text?: string | null; name?: string | null }[]): string | null {
  if (!layers.length) return null
  if (layers.length > 1) return `${layers.length} layers`
  const l = layers[0]!
  const text = (l.text ?? '').replace(/\s+/g, ' ').trim()
  if (l.kind === 'text' && text) {
    const cut = text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text
    return `“${cut}” · text`
  }
  const name = (l.name ?? '').trim()
  return name || sentence(l.kind)
}
