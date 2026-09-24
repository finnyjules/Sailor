// The blank-project modal's own lineup (spec 2026-09-23). Deliberately separate
// from STUDIO_OPTIONS (the toolbar Studios door), which keeps studios that are
// not ready to be a first impression (Shot Director, Lip-Sync).
import { SPACE_TYPE_ENABLED } from '~/lib/spaceTypeEnabled'

export type StartPickId =
  | 'gen' | 'style' | 'edit' | 'upscale' | 'video'
  | 'expressive' | 'gradient' | 'shader' | 'pattern' | 'shape' | 'vectortype' | 'scene3d' | 'moodboard'

export interface StartTile {
  id: StartPickId
  name: string
  /** One short line under the name; must fit one line on the tile. */
  line: string
  kind: 'ai' | 'hand'
  /** Picking it spends credits when run — the tile carries the pastel dot. */
  credits: boolean
}

export const START_AI: StartTile[] = [
  { id: 'gen', name: 'Generate an image', line: 'Describe it, pick a model', kind: 'ai', credits: true },
  { id: 'style', name: 'An image in a style', line: 'Your prompt, a chosen look', kind: 'ai', credits: true },
  { id: 'edit', name: 'Edit an image', line: 'Change it in words', kind: 'ai', credits: true },
  { id: 'upscale', name: 'Upscale an image', line: 'Sharper, up to 4×', kind: 'ai', credits: true },
  { id: 'video', name: 'Generate a video', line: 'From words or a picture', kind: 'ai', credits: true },
]

const HAND: StartTile[] = [
  { id: 'expressive', name: 'Expressive', line: 'Type that moves', kind: 'hand', credits: false },
  { id: 'gradient', name: 'Gradient', line: 'Soft colour fields', kind: 'hand', credits: false },
  { id: 'shader', name: 'Shader', line: 'Live, animated surfaces', kind: 'hand', credits: false },
  { id: 'pattern', name: 'Pattern', line: 'Repeats and terrazzo', kind: 'hand', credits: false },
  { id: 'shape', name: 'Shape', line: 'Marks built from copies', kind: 'hand', credits: false },
  { id: 'vectortype', name: 'Vector type', line: 'Letters you can stretch', kind: 'hand', credits: false },
  { id: 'scene3d', name: '3D', line: 'A lit scene with objects', kind: 'hand', credits: false },
  { id: 'moodboard', name: 'Moodboard', line: 'Collect your references', kind: 'hand', credits: false },
]

export function startHandTiles(spaceTypeEnabled: boolean = SPACE_TYPE_ENABLED): StartTile[] {
  return spaceTypeEnabled ? HAND : HAND.filter(t => t.id !== 'expressive')
}
