import type { EmbedSurface, EmbedHandle } from '../contract'
import { ShaderFxRenderer } from '~/lib/shaderfx/renderer'
import { composePasses } from '~/lib/shaderstudio/passes'
// applyMotion/motionConfigFor come from motion.ts specifically (not resolve.ts,
// which re-exports motionConfigFor) — resolve.ts transitively imports Vue via
// frameSource.ts, and this file is bundled standalone for the exported embed
// (vite.embed.config.ts: "nothing here may pull in Vue, Nuxt, or anything that
// reaches the network").
import { applyMotion, motionConfigFor } from '~/lib/shaderstudio/motion'
import type { ShaderStudioConfig } from '~/lib/shaderstudio/types'
import type { EffectDef } from '~/lib/shaderfx/types'

/**
 * A shader embed carries the studio config verbatim PLUS the EffectDefs it
 * references, inlined. The exported file must never reach the network, so it
 * cannot resolve ids against the catalog (`~/lib/shaderfx/catalog`) the way the
 * studio does — `resolveDef` below reads the inlined array instead.
 */
export interface ShaderEmbedConfig {
  cfg: ShaderStudioConfig
  defs: EffectDef[]
  /** Loop length in seconds — composePasses wants `t` in seconds, not t01. */
  duration: number
  /**
   * The studio's source image, inlined as a data: URI. Shader Studio is
   * input-driven ("Add a source first"), so a real piece stacks passes over an
   * image — it must travel with the export. Null only for generative effects
   * that ignore their input.
   */
  baseDataUrl: string | null
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('shader embed: inlined source image failed to decode'))
    img.src = dataUrl
  })
}

/**
 * Generative shader effects synthesize their own image, so the base texture is a
 * 1x1 opaque black pixel rather than an uploaded asset. Keeping it 1x1 means an
 * export carries no image payload at all.
 */
function blackPixel(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 1
  c.height = 1
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, 1, 1)
  return c
}

const shaderEmbedSurface: EmbedSurface = {
  kind: 'shader',
  // ShaderFxRenderer composites onto an opaque base; it does not currently
  // produce a transparent result. Declared false rather than assumed.
  caps: { alpha: false },

  async mount(container: HTMLElement, config: unknown): Promise<EmbedHandle> {
    const embed = config as ShaderEmbedConfig
    if (!embed?.cfg?.effects?.length) throw new Error('shader embed: config has no effects')

    // v1 covers generative, texture-free effects only (see the spec's asset
    // decision). Throw loudly rather than render something subtly wrong —
    // a silent wrong-looking export is worse than a failed one.
    const textured = embed.defs.filter(d => d.textures?.length)
    if (textured.length) {
      throw new Error(
        `shader embed: effects with texture assets are not supported yet (${textured.map(d => d.id).join(', ')})`,
      )
    }

    const resolveDef = (id: string): EffectDef | null =>
      embed.defs.find(d => d.id === id) ?? null

    // Own instance, not the app singleton — two embeds must not share a context.
    const renderer = new ShaderFxRenderer()
    // Decoding happens here, at mount, so setTime stays synchronous.
    const base: TexImageSource = embed.baseDataUrl
      ? await loadImage(embed.baseDataUrl)
      : blackPixel()
    // Guard against a zero-width/height container (e.g. mounted before layout
    // settles) — an unguarded 0 reaches ShaderFxRenderer.render as a canvas
    // dimension. Mirrors the gradient adapter's identical guard
    // (~/lib/embed/surfaces/gradient.ts).
    let w = Math.max(1, container.clientWidth || 512)
    let h = Math.max(1, container.clientHeight || 512)
    let mounted: HTMLCanvasElement | null = null

    const draw = (t01: number) => {
      const t = t01 * embed.duration
      // Mirrors ShaderStudioSurface.vue's renderFrame exactly: a config with
      // motion tracks is evaluated through applyMotion, keyed to THIS export's
      // clock (motionConfigFor), before composePasses ever sees it. Without
      // this, keyframed params stay stuck at their base values in the export —
      // only generative effects (driven by u_time internally) would still
      // appear to animate.
      const animated = (embed.cfg.motion?.tracks?.length ?? 0) > 0
      const cfg = animated ? applyMotion(motionConfigFor(embed.cfg, embed.duration), t) : embed.cfg
      // composePasses is the studio's own composer — layer blend, opacity,
      // captureSource sequencing and the post stack all live in it. Never
      // reimplement any of that here.
      const passes = composePasses(cfg, resolveDef, t, undefined, embed.duration)
      const out = renderer.render(passes, base, w, h)
      if (out !== mounted) {
        if (mounted) mounted.remove()
        out.style.display = 'block'
        out.style.width = '100%'
        out.style.height = '100%'
        container.appendChild(out)
        mounted = out
      }
    }

    // Draw once at mount so the container is never empty before the first tick.
    draw(0)

    return {
      setTime: (t01: number) => draw(t01),
      setSize: (nw: number, nh: number) => {
        w = Math.max(1, Math.round(nw))
        h = Math.max(1, Math.round(nh))
      },
      destroy: () => {
        if (mounted) { mounted.remove(); mounted = null }
        renderer.dispose()
      },
    }
  },
}

export default shaderEmbedSurface
