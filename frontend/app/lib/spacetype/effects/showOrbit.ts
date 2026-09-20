import { makeShowcaseEffect } from './showcase'
import { orbitLayout } from '../layouts/orbit'

/** Hero orbit — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showOrbitEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showorbit', layout: orbitLayout })
