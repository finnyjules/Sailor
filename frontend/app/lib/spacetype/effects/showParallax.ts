import { makeShowcaseEffect } from './showcase'
import { parallaxLayout } from '../layouts/parallax'

/** Parallax drift — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showParallaxEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showparallax', layout: parallaxLayout })
