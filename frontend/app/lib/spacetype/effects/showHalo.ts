import { makeShowcaseEffect } from './showcase'
import { haloLayout } from '../layouts/halo'

/** Photo orbit — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showHaloEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showhalo', layout: haloLayout })
