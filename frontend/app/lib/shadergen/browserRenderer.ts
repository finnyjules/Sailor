/**
 * The engine's TakeRenderer on Sailor's own WebGL2 renderer. Compiles by
 * rendering a tiny frame (ShaderFxRenderer throws "shaderfx compile (id): …"
 * with the info log), judges from two 24×24 samples (t = 2.0 and 3.37), four more
 * for the seamless-loop check (t = 0, LOOP, and one step either side of the wrap), plus a
 * cost measurement against a plain copy, exactly like the spike page — except
 * that cost is only measured for a take that already passes the other checks,
 * and a single timed frame that is already far too slow stands in for the
 * 10-frame average. A lost WebGL context (a shader hung the GPU) throws
 * ContextLostError from compile, judge and sheet, so the engine aborts instead
 * of reporting every later take as broken.
 * Holds its OWN renderer instance, never the app-wide `shaderFx` singleton.
 */
import type { GenTake } from '~~/shared/shadergen/contract'
import { ShaderFxRenderer, expandPasses, type ShaderPass } from '~/lib/shaderfx/renderer'
import { resolveUniforms } from '~/lib/shaderfx/params'
import type { EffectDef } from '~/lib/shaderfx/types'
import { toEffectDef } from './effectDef'
import { HARD_FLAGS, judgeFrames, THRESHOLDS } from './renderChecks'
import { ContextLostError, type TakeRenderer } from './engine'

const THUMB = 256
const SAMPLE = 24
const COST_SIZE = 1024
const COST_FRAMES = 10
/** One frame this slow is heavy beyond doubt; don't render ten more. */
const SINGLE_FRAME_GIVE_UP_MS = 5 * THRESHOLDS.heavyMs
const COPY_FS = `#version 300 es
precision highp float; uniform sampler2D u_image0; in vec2 v_texCoord; layout(location = 0) out vec4 fragColor0;
void main(){ fragColor0 = texture(u_image0, v_texCoord); }`

/** The loop length takes are judged and previewed with (u_loop): LOOP()'s own default. */
export const JUDGE_LOOP = 4
/** One step either side of the wrap, for the seamless-loop check. */
const LOOP_STEP = JUDGE_LOOP / 60

/** Takes are judged on a copy of the picture at most this big on its long edge. The renderer
 *  uploads its picture on every draw, the timed "heavy" frames included: a full-size photo made
 *  every take "heavy" (a 4096 px upload is ≈1 s a frame; its noise alone is far over 8 ms). */
export const TAKE_SOURCE_EDGE = 512

/** The size a picture is copied at for judging: long edge ≤ TAKE_SOURCE_EDGE, aspect kept. */
export function takeSourceSize(w: number, h: number): { w: number; h: number } {
  const k = Math.min(1, TAKE_SOURCE_EDGE / Math.max(w, h, 1))
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }
}

/** A still copy of the picture at the judging size (also a fixed frame of a canvas that redraws). */
function judgingCopy(src: HTMLImageElement | HTMLCanvasElement): HTMLImageElement | HTMLCanvasElement {
  const w = (src as HTMLImageElement).naturalWidth || src.width
  const h = (src as HTMLImageElement).naturalHeight || src.height
  if (!w || !h) return src
  const size = takeSourceSize(w, h)
  const c = document.createElement('canvas')
  c.width = size.w; c.height = size.h
  const ctx = c.getContext('2d')
  if (!ctx) return src
  ctx.drawImage(src, 0, 0, size.w, size.h)
  return c
}

function passesFor(def: EffectDef, t: number): ShaderPass[] {
  return expandPasses(def.id, def.source, { ...resolveUniforms(def, {}), u_time: t, u_loop: JUDGE_LOOP, u_seed: 0 }, undefined, 1)
}

export function createBrowserTakeRenderer(picture: HTMLImageElement | HTMLCanvasElement): TakeRenderer {
  const source = judgingCopy(picture)
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

  const assertContext = () => {
    if (renderer.outputCanvas?.getContext('webgl2')?.isContextLost()) {
      throw new ContextLostError('The graphics context was lost (a shader probably hung the GPU)')
    }
  }
  /** Runs fn; a lost context wins over whatever else fn threw or returned. */
  const guarded = <T>(fn: () => T): T => {
    let out: T
    try { out = fn() } catch (e) { assertContext(); throw e }
    assertContext()
    return out
  }

  const px = new Uint8Array(4)
  function cost(passes: ShaderPass[]): number {
    renderer.render(passes, source, COST_SIZE, COST_SIZE)
    const gl = renderer.outputCanvas!.getContext('webgl2')!
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const t1 = performance.now()
    renderer.render(passes.map(p => ({ ...p, uniforms: { ...p.uniforms, u_time: 3 } })), source, COST_SIZE, COST_SIZE)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const single = performance.now() - t1
    if (single > SINGLE_FRAME_GIVE_UP_MS) return single
    const t0 = performance.now()
    for (let k = 0; k < COST_FRAMES; k++) {
      renderer.render(passes.map(p => ({ ...p, uniforms: { ...p.uniforms, u_time: 3 + k * 0.01 } })), source, COST_SIZE, COST_SIZE)
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    return (performance.now() - t0) / COST_FRAMES
  }
  let baseline: number | null = null
  const copy: ShaderPass[] = [{ id: '__shadergen_copy', source: COPY_FS, uniforms: {} }]
  // A take still finishing after its set was dropped must not bring the context back.
  let disposed = false
  const live = () => { if (disposed) throw new DOMException('Stopped', 'AbortError') }

  return {
    compile(take) {
      live()
      let err: string | null = null
      try {
        renderer.render(passesFor(defFor(take), 0), source, 64, 64)
      } catch (e) {
        err = String((e as Error)?.message ?? e)
      }
      assertContext()
      return err
    },
    judge: take => guarded(() => {
      live()
      const def = defFor(take)
      renderer.render(passesFor(def, 2.0), source, THUMB, THUMB)
      const a = sample(renderer.outputCanvas!)
      const thumbnail = renderer.outputCanvas!.toDataURL('image/png')
      renderer.render(passesFor(def, 3.37), source, THUMB, THUMB)
      const b = sample(renderer.outputCanvas!)
      // Seamless loop: the same seed at t = 0, t = LOOP, and one step either side of the wrap.
      const at = (t: number) => { renderer.render(passesFor(def, t), source, THUMB, THUMB); return sample(renderer.outputCanvas!) }
      const loop = { start: at(0), end: at(JUDGE_LOOP), beforeEnd: at(JUDGE_LOOP - LOOP_STEP), step: at(LOOP_STEP) }
      assertContext()
      const frames = { a, b, source: sourcePx, generative: take.generative, animated: take.animated, loop }
      const looks = judgeFrames({ ...frames, extraMs: 0 })
      // Already rejected on looks: don't spend GPU time measuring its cost.
      if (looks.flags.some(f => HARD_FLAGS.includes(f))) return { ...looks, thumbnail }
      if (baseline === null) { cost(copy); baseline = cost(copy) }
      const extraMs = Math.max(0, cost(passesFor(def, 3)) - baseline)
      return { ...judgeFrames({ ...frames, extraMs }), thumbnail }
    }),
    sheet: takes => guarded(() => {
      live()
      const c = document.createElement('canvas')
      c.width = THUMB * takes.length
      c.height = THUMB
      const ctx = c.getContext('2d')!
      takes.forEach((t, i) => {
        renderer.render(passesFor(defFor(t), 2.0), source, THUMB, THUMB)
        ctx.drawImage(renderer.outputCanvas!, i * THUMB, 0)
      })
      return c.toDataURL('image/jpeg', 0.85)
    }),
    dispose() {
      if (disposed) return
      disposed = true
      renderer.dispose() // loses the context through WEBGL_lose_context and drops the canvas
    },
  }
}
