import { makeShowcaseEffect } from './showcase'
import { tunnelLayout } from '../layouts/tunnel'

/** Card tunnel — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showTunnelEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showtunnel', layout: tunnelLayout })
