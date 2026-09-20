import { makeShowcaseEffect } from './showcase'
import { sphereLayout } from '../layouts/sphere'

/** Sphere wall — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showSphereEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showsphere', layout: sphereLayout })
