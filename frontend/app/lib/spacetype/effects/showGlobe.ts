import { makeShowcaseEffect } from './showcase'
import { globeLayout } from '../layouts/globe'

/** Card globe — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showGlobeEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showglobe', layout: globeLayout })
