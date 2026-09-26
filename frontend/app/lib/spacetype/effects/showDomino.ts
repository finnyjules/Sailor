import { makeShowcaseEffect } from './showcase'
import { dominoLayout } from '../layouts/domino'

/** Domino fall — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showDominoEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showdomino', layout: dominoLayout })
