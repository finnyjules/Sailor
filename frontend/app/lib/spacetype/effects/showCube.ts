import { makeShowcaseEffect } from './showcase'
import { cubeLayout } from '../layouts/cube'

/** Card cube — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showCubeEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showcube', layout: cubeLayout })
