import { makeShowcaseEffect } from './showcase'
import { wheelLayout } from '../layouts/wheel'

/** Wheel spin — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showWheelEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showwheel', layout: wheelLayout })
