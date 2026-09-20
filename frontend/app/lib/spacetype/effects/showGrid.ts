import { makeShowcaseEffect } from './showcase'
import { gridLayout } from '../layouts/grid'

/** Grid — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showGridEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showgrid', layout: gridLayout })
