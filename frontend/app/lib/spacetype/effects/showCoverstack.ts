import { makeShowcaseEffect } from './showcase'
import { coverstackLayout } from '../layouts/coverstack'

/** Cover stack — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showCoverstackEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showcoverstack', layout: coverstackLayout })
