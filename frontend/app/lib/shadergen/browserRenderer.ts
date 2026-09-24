/**
 * The engine's TakeRenderer on Sailor's own WebGL2 renderer. Compiles by
 * rendering a tiny frame (ShaderFxRenderer throws "shaderfx compile (id): …"
 * with the info log), judges from two 24×24 samples (t = 2.0 and 3.37) plus a
 * cost measurement against a plain copy, exactly like the spike page.
 * Holds its OWN renderer instance, never the app-wide `shaderFx` singleton.
 */
import type { GenTake } from '~~/shared/shadergen/contract'
import { ShaderFxRenderer, expandPasses, type ShaderPass } from '~/lib/shaderfx/renderer'
import { resolveUniforms } from '~/lib/shaderfx/params'
import type { EffectDef } from '~/lib/shaderfx/types'
import { toEffectDef } from './effectDef'
import { judgeFrames } from './renderChecks'
import type { TakeRenderer } from './engine'

const THUMB = 256
const SAMPLE = 24
const COST_SIZE = 1024
const COST_FRAMES = 10
const COPY_FS = `#version 300 es
precision highp float; uniform sampler2D u_image0; in vec2 v_texCoord; layout(location = 0) out vec4 fragColor0;
void main(){ fragColor0 = texture(u_image0, v_texCoord); }`

function passesFor(def: EffectDef, t: number): ShaderPass[] {
  return expandPasses(def.id, def.source, { ...resolveUniforms(def, {}), u_time: t, u_seed: 0 }, undefined, 1)
}

export function createBrowserTakeRenderer(source: HTMLImageElement | HTMLCanvasElement): TakeRenderer {
  const renderer = new ShaderFxRenderer()
  const defs = new WeakMap<GenTake, EffectDef>()
  let seq = 0
  // One EffectDef (and program id) per take object: attempts never share an id,
  // so the renderer's program cache can't serve an older attempt's source.
  const defFor = (take: GenTake) => {
    let d = defs.get(take)
    if (!d) { d = toEffectDef(take, `shadergen_${++seq}`); defs.set(take, d) }
    return d
  }

  const small = document.createElement('canvas')
  small.width = small.height = SAMPLE
  const sctx = small.getContext('2d', { willReadFrequently: true })!
  const sample = (src: CanvasImageSource) => {
    sctx.clearRect(0, 0, SAMPLE, SAMPLE)
    sctx.drawImage(src, 0, 0, SAMPLE, SAMPLE)
    return sctx.getImageData(0, 0, SAMPLE, SAMPLE).data
  }
  const sourcePx = sample(source)

  const px = new Uint8Array(4)
  function cost(passes: ShaderPass[]): number {
    renderer.render(passes, source, COST_SIZE, COST_SIZE)
    const gl = renderer.outputCanvas!.getContext('webgl2')!
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const t0 = performance.now()
    for (let k = 0; k < COST_FRAMES; k++) {
      renderer.render(passes.map(p => ({ ...p, uniforms: { ...p.uniforms, u_time: 3 + k * 0.01 } })), source, COST_SIZE, COST_SIZE)
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    return (performance.now() - t0) / COST_FRAMES
  }
  let baseline: number | null = null
  const copy: ShaderPass[] = [{ id: '__shadergen_copy', source: COPY_FS, uniforms: {} }]

  return {
    compile(take) {
      try {
        renderer.render(passesFor(defFor(take), 0), source, 64, 64)
        return null
      } catch (e) {
        return String((e as Error)?.message ?? e)
      }
    },
    judge(take) {
      const def = defFor(take)
      renderer.render(passesFor(def, 2.0), source, THUMB, THUMB)
      const a = sample(renderer.outputCanvas!)
      const thumbnail = renderer.outputCanvas!.toDataURL('image/png')
      renderer.render(passesFor(def, 3.37), source, THUMB, THUMB)
      const b = sample(renderer.outputCanvas!)
      if (baseline === null) { cost(copy); baseline = cost(copy) }
      const extraMs = Math.max(0, cost(passesFor(def, 3)) - baseline)
      return { ...judgeFrames({ a, b, source: sourcePx, generative: take.generative, animated: take.animated, extraMs }), thumbnail }
    },
    sheet(takes) {
      const c = document.createElement('canvas')
      c.width = THUMB * takes.length
      c.height = THUMB
      const ctx = c.getContext('2d')!
      takes.forEach((t, i) => {
        renderer.render(passesFor(defFor(t), 2.0), source, THUMB, THUMB)
        ctx.drawImage(renderer.outputCanvas!, i * THUMB, 0)
      })
      return c.toDataURL('image/jpeg', 0.85)
    },
  }
}
