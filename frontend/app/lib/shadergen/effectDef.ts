/** A generated take as a regular EffectDef, so every existing shader path
 *  (renderer, params, dials, fills, embeds) can use it unchanged. */
import { assembleSource, type GenTake } from '~~/shared/shadergen/contract'
import type { EffectDef, EffectParamDef } from '~/lib/shaderfx/types'

export function toEffectDef(take: GenTake, id: string): EffectDef {
  return {
    id,
    name: take.name,
    category: 'mine',
    animated: take.animated,
    passes: 1,
    centerParam: null,
    textures: [],
    generative: take.generative,
    source: assembleSource(take.body),
    params: take.params.map(p => ({ ...p }) as EffectParamDef),
  }
}
