import { makeShowcaseEffect } from './showcase'
import { slideLayout } from '../layouts/slide'

/** Stack slide — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showSlideEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showslide', layout: slideLayout })
