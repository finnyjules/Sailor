// frontend/app/lib/shaderstudio/passes.ts
// Compose a ShaderStudioConfig + the selected effect's EffectDef into the flat
// ShaderPass[] consumed by the shaderFx singleton renderer. Order mirrors the
// Morflax panel: effect → duotone → adjust → lens blur → chromatic.

import { resolveUniforms } from '~/lib/shaderfx/params'
import { expandPasses, type ShaderPass, type Uniforms } from '~/lib/shaderfx/renderer'
import type { EffectDef } from '~/lib/shaderfx/types'
import { BLEND_IDX } from '~/lib/studio/blend'
import { ADJUST_FS, BLOOM_FS, CHROMATIC_FS, DUOTONE_FS, GRADIENT_MAP_FS, LENS_BLUR_FS } from './glsl'
import { maskUniforms } from './mask'
import type { ShaderStudioConfig, StudioEffect } from './types'

/** Hex (#rrggbb) → {r,g,b} in 0..1. */
function hexRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

export interface EffectTextureBundle {
  sources: Record<string, TexImageSource>
  uniforms: Record<string, number>
}

/**
 * @param cfg        studio config (already motion-applied for the frame, if animating)
 * @param resolveDef resolves a catalog effect id → EffectDef (or null if not loaded)
 * @param t          time in seconds (drives u_time for animated effects)
 * @param texFor     resolves an effect's textures + extra uniforms for a specific
 *                   stacked layer (browser-side; {} in tests). Receives the layer so
 *                   per-layer data (e.g. the ASCII "Custom" glyph atlas) is resolved
 *                   from the layer being composited, not the active one.
 */
export function composePasses(
  cfg: ShaderStudioConfig,
  resolveDef: (id: string) => EffectDef | null,
  t: number,
  texFor: (def: EffectDef | null, layer: StudioEffect) => EffectTextureBundle = () => ({ sources: {}, uniforms: {} }),
): ShaderPass[] {
  const out: ShaderPass[] = []

  // 1. Stylized effect stack (chain; each layer composites over its input by blend+opacity)
  for (const layer of cfg.effects) {
    if (!layer.enabled || !layer.id) continue
    const def = resolveDef(layer.id)
    if (!def) continue
    const tex = texFor(def, layer)
    const uniforms: Uniforms = {
      ...resolveUniforms(def, layer.params),
      u_time: t, u_seed: cfg.seed, u_hasInput: 1, ...tex.uniforms,
    }
    const needsComposite = layer.blend !== 'normal' || layer.opacity < 0.999
    const masked = !!layer.mask?.enabled
    const expanded = expandPasses(def.id, def.source, uniforms, tex.sources, def.passes ?? 1)
    // A stacked layer (anything already beneath it) captures its input as u_source,
    // so u_source-sampling effects (bloom/glow/tilt_shift) build on the layer below
    // rather than the original image. The base layer keeps the original source.
    const stacked = out.length > 0
    if (stacked) expanded[0] = { ...expanded[0]!, captureSource: true }
    // Snapshot the layer input into the hold buffer before the effect runs when
    // it will be needed downstream: a mask mixes the effect over its own input;
    // a stacked composite blends the output over the image beneath. One snapshot
    // serves both — the mask pass reads the held input without consuming it.
    if (masked || (needsComposite && stacked)) {
      expanded[0] = { ...expanded[0]!, snapshot: true }
    }
    out.push(...expanded)
    // Mask confines the effect: mix(effectInput, effectOutput, maskValue). Runs
    // before any blend composite so the masked result is what gets blended below.
    if (masked) {
      out.push({ id: 'studio:mask', source: '', uniforms: {}, maskComposite: maskUniforms(layer.mask!) })
    }
    if (needsComposite && stacked) {
      out.push({
        id: 'studio:composite', source: '', uniforms: {},
        composite: { blendIdx: BLEND_IDX[layer.blend], opacity: layer.opacity },
      })
    }
  }

  // 2. Duotone
  if (cfg.duotone.enabled) {
    const ink = hexRgb(cfg.duotone.ink), paper = hexRgb(cfg.duotone.paper)
    out.push({ id: 'studio:duotone', source: DUOTONE_FS, uniforms: {
      u_ink_r: ink.r, u_ink_g: ink.g, u_ink_b: ink.b,
      u_paper_r: paper.r, u_paper_g: paper.g, u_paper_b: paper.b,
    } })
  }

  // 2b. Gradient map (multi-stop luminance remap)
  if (cfg.gradientMap?.enabled && cfg.gradientMap.stops?.length) {
    const stops = [...cfg.gradientMap.stops].sort((a, b) => a.pos - b.pos).slice(0, 8)
    const u: Record<string, number> = { u_gm_n: stops.length, u_gm_mix: cfg.gradientMap.mix ?? 1 }
    stops.forEach((s, i) => {
      const c = hexRgb(s.color)
      u[`u_gm_pos[${i}]`] = Math.min(1, Math.max(0, s.pos))
      u[`u_gm_r[${i}]`] = c.r; u[`u_gm_g[${i}]`] = c.g; u[`u_gm_b[${i}]`] = c.b
    })
    out.push({ id: 'studio:gradientMap', source: GRADIENT_MAP_FS, uniforms: u })
  }

  // 3. Adjustments
  if (cfg.adjust.enabled) {
    const a = cfg.adjust
    out.push({ id: 'studio:adjust', source: ADJUST_FS, uniforms: {
      u_exposure: a.exposure, u_brightness: a.brightness, u_contrast: a.contrast,
      u_saturation: a.saturation, u_hue: a.hue, u_temperature: a.temperature, u_tint: a.tint,
    } })
  }

  // 4. Lens blur
  if (cfg.post.blur.enabled) {
    const b = cfg.post.blur
    out.push({ id: 'studio:blur', source: LENS_BLUR_FS, uniforms: {
      u_focusX: b.focusX, u_focusY: b.focusY, u_range: b.range, u_aperture: b.aperture, u_maxBlur: b.maxBlur,
    } })
  }

  // 5. Chromatic aberration
  if (cfg.post.chromatic.enabled) {
    out.push({ id: 'studio:chromatic', source: CHROMATIC_FS, uniforms: { u_amount: cfg.post.chromatic.amount } })
  }

  // 6. Bloom (glows the final composited image)
  if (cfg.post.bloom?.enabled) {
    const bl = cfg.post.bloom
    out.push({ id: 'studio:bloom', source: BLOOM_FS, uniforms: {
      u_threshold: bl.threshold, u_intensity: bl.intensity, u_radius: bl.radius,
    } })
  }

  return out
}
