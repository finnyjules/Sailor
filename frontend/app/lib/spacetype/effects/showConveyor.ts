import { makeShowcaseEffect } from './showcase'
import { conveyorLayout } from '../layouts/conveyor'

/** Conveyor belt — a Showcase card layout as its own effect (see ./showcase.ts). */
export const showConveyorEffect = /* @__PURE__ */ makeShowcaseEffect({ id: 'showconveyor', layout: conveyorLayout })
