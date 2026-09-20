import { makeShowcaseEffect } from './showcase'
import { cloudLayout } from '../layouts/cloud'

/** Orbit globe — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showCloudEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showcloud', layout: cloudLayout })
