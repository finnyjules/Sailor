import { makeShowcaseEffect } from './showcase'
import { deckLayout } from '../layouts/deck'

/** Deck peel — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showDeckEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showdeck', layout: deckLayout })
