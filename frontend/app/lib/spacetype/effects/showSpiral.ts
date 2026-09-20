import { makeShowcaseEffect } from './showcase'
import { spiralLayout } from '../layouts/spiral'

/** Spiral stream — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showSpiralEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showspiral', layout: spiralLayout })
