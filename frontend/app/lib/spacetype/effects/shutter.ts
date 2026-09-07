import * as THREE from 'three'
import type { ControlSpec, Params, SpaceTypeEffect } from '../effect'
import { parseFills, fillAtlasTexture, SRGB_TO_LINEAR_GLSL, fillAnchor, fillScreenVec } from '../fills'
import { hash11, parseEase, holdFraction, sceneBlend } from '../motion'
import { stripAlpha } from '~/lib/color/convert'
import { defaultFillsFor } from '../palette'

/**
 * Shutter — geometric "speed lines" sliced typography.
 *
 * Stacks N overlapping copies of each word. Every copy shares ONE horizontal stripe grid (same count
 * and positions, so the white lines stay continuous across the word), but the THICKNESS of the black
 * stripe within each line differs per copy: the bottom copy of the pile has the thinnest stripes, the
 * top copy the thickest. The copies are nudged horizontally by an even spacing and unioned — the
 * offset, differently-weighted copies interleave into geometric speed lines.
 *
 * Multi-string: a newline-separated `text` stacks into a centred poster, each line getting its own
 * shutter treatment (shared settings). Colour: `colorMode` is mono (one colour), palette (each copy
 * fades between two colours — the trailing speed lines change hue) or fill (ONE fill PER COPY from
 * the fill list, bottom-of-pile → top — each row a solid colour or a studio pattern).
 *
 * `progress` (0 = intact word, 1 = fully fanned/sliced) drives both the horizontal spread and the
 * stripe gaps, so at 0 every copy collapses back to one solid word. Motion uses the scene-sequenced
 * model (see ../motion): `mode` static freezes on the `progress` pose; loop cycles `scenes` poses
 * (seeded amount + spread variations sized by `variance`) with hold / transition / ease timing.
 */

// inkA sampling margins: horizontal is roomy so nudged copies can trail into transparent space;
// vertical is tight so stacked words sit close. Mirrored into the plane sizing below.
const MX = 1.5
const MY = 1.15

// One fill per copy (bottom of pile → top). Each can be a solid colour or a studio pattern.
// Seeded from the canonical Vessell palette (see palette.ts), like every other fill-list effect.
const FILL_DEFAULT = defaultFillsFor(4, 'shutter')

const controls: ControlSpec[] = [
  // TYPE.
  { key: 'text', label: 'Text', kind: 'textList', default: 'NO\nWANT\nZERO\nDAYS', group: 'Type' },
  { key: 'textCase', label: 'Case', kind: 'select', options: ['upper', 'asis'], default: 'upper', group: 'Type' },
  { key: 'font', label: 'Font', kind: 'font', default: 'Archivo Black', group: 'Type' },
  { key: 'typeYScale', label: 'Type size', kind: 'slider', min: 40, max: 320, step: 2, default: 220, group: 'Type' },
  { key: 'typeWeight', label: 'Type weight', kind: 'slider', min: 100, max: 900, step: 10, default: 800, group: 'Type' },
  { key: 'tracking', label: 'Tracking', kind: 'slider', min: -20, max: 80, step: 1, default: 0, group: 'Type' },
  // SLICE — the stacked, horizontally-nudged striped copies.
  { key: 'copies', label: 'Copies', kind: 'slider', min: 1, max: 6, step: 1, default: 4, group: 'Slice' },
  { key: 'spacing', label: 'Horizontal spacing', kind: 'slider', min: 0, max: 0.3, step: 0.005, default: 0.02, group: 'Slice' },
  { key: 'stripes', label: 'Stripes', kind: 'slider', min: 4, max: 120, step: 1, default: 22, group: 'Slice' },
  { key: 'thicknessBottom', label: 'Thickness · bottom copy', kind: 'slider', min: 0.05, max: 1, step: 0.02, default: 0.32, group: 'Slice' },
  { key: 'thicknessTop', label: 'Thickness · top copy', kind: 'slider', min: 0.05, max: 1, step: 0.02, default: 0.86, group: 'Slice' },
  { key: 'progress', label: 'Progress', kind: 'slider', min: 0, max: 1, step: 0.01, default: 1, group: 'Slice' },
  // LAYOUT — multi-string stacking.
  { key: 'rowGap', label: 'Line gap', kind: 'slider', min: -0.3, max: 1, step: 0.02, default: 0.12, group: 'Layout' },
  // MOTION — scene-sequenced (same model as Corner Pin). Static freezes on the Progress pose.
  { key: 'mode', label: 'Mode', kind: 'select', options: ['static', 'loop'], default: 'static', group: 'Motion',
    hint: 'static = freeze on the Progress pose; loop = animate through the scenes' },
  { key: 'scenes', label: 'Scenes', kind: 'slider', min: 2, max: 8, step: 1, default: 3, group: 'Motion',
    hint: 'how many distinct sliced poses it cycles through per loop',
    showIf: { key: 'mode', equals: 'loop' } },
  { key: 'variance', label: 'Variance', kind: 'slider', min: 0, max: 1, step: 0.02, default: 0.6, group: 'Motion',
    hint: 'how far auto-generated scenes deviate from the Progress pose (0 = no motion)',
    showIf: { key: 'mode', equals: 'loop' } },
  { key: 'holdTime', label: 'Hold time', kind: 'slider', min: 0, max: 10, step: 0.1, default: 3, group: 'Motion',
    hint: 'how long it dwells on each scene (relative to Transition time; absolute speed = studio loop length)',
    showIf: { key: 'mode', equals: 'loop' } },
  { key: 'transitionTime', label: 'Transition time', kind: 'slider', min: 0.1, max: 10, step: 0.1, default: 1.5, group: 'Motion',
    hint: 'how long the animated move between scenes takes (relative to Hold time)',
    showIf: { key: 'mode', equals: 'loop' } },
  { key: 'ease', label: 'Ease', kind: 'curve', default: '[0.42,0,0.58,1]', group: 'Motion',
    showIf: { key: 'mode', equals: 'loop' } },
  { key: 'seed', label: 'Seed', kind: 'slider', min: 1, max: 50, step: 1, default: 7, group: 'Motion',
    hint: 're-roll the auto-generated scene poses',
    showIf: { key: 'mode', equals: 'loop' } },
  // TRANSFORM (applied by the engine from these param keys).
  { key: 'scale', label: 'Scale', kind: 'slider', min: 0.4, max: 2.5, step: 0.05, default: 1, group: 'Transform' },
  { key: 'rotateZ', label: 'Rotate', kind: 'slider', min: -3.14, max: 3.14, step: 0.01, default: 0, group: 'Transform' },
  // COLOR.
  { key: 'colorMode', label: 'Color mode', kind: 'select', options: ['mono', 'palette', 'fill'], default: 'mono', group: 'Color',
    hint: 'mono = one colour; palette = two-colour fade across copies; fill = one fill per copy from the list' },
  { key: 'textColor', label: 'Text (mono)', kind: 'color', default: '#000000', group: 'Color',
    showIf: { key: 'colorMode', equals: 'mono' } },
  { key: 'paletteA', label: 'Palette · trailing', kind: 'color', default: '#10b981', group: 'Color',
    showIf: { key: 'colorMode', equals: 'palette' } },
  { key: 'paletteB', label: 'Palette · front', kind: 'color', default: '#0a0a0a', group: 'Color',
    showIf: { key: 'colorMode', equals: 'palette' } },
  { key: 'fill', label: 'Fills (one per copy)', kind: 'fillList', default: FILL_DEFAULT, group: 'Color',
    hint: 'fill mode: row 1 = bottom copy (trailing) … last row = top copy (front); wraps if fewer rows than copies',
    showIf: { key: 'colorMode', equals: 'fill' } },
  { key: 'bgColor', label: 'Background', kind: 'color', default: '#ffffff', group: 'Color' },
]

interface ShutterState { materials: THREE.ShaderMaterial[]; bg: THREE.MeshBasicMaterial }
// Per-scene state lives on the built root's userData (see update()), NOT a module var: the card
// preview and the headless frame source run two concurrent engines over this singleton effect, and
// the engine caches multiple roots per instance — a shared var would let whichever built last own
// it, freezing every other surface. buildScene stashes it on root.userData.shutterState.

function n(p: Params, k: string): number { return Number(p[k]) }
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const COLOR_MODE: Record<string, number> = { mono: 0, palette: 1, fill: 2 }

/** A scene's sliced pose: how much it's sliced (`amount` = effective progress) and how wide the
 *  copies fan (`spread` = spacing multiplier). Scene 0 is the user's Progress pose; later scenes are
 *  seeded deviations sized by `variance`. Pure → unit-testable. */
export function shutterPose(scene: number, baseAmount: number, variance: number, seed: number): { amount: number; spread: number } {
  if (scene <= 0) return { amount: clamp01(baseAmount), spread: 1 }
  const amount = clamp01(baseAmount + hash11(seed * 131 + scene * 31.7) * variance)
  const spread = Math.max(0.05, 1 + hash11(seed * 131 + scene * 17.1 + 4.2) * variance * 1.5)
  return { amount, spread }
}

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'

const MAX_LAYERS = 6

const FRAG = [
  'precision highp float;',
  'varying vec2 vUv;',
  'uniform sampler2D uText; uniform vec3 uBg;',
  'uniform float uWf; uniform float uVMid; uniform float uVH;',        // this word's placement in the atlas
  'uniform float uCopies; uniform float uSpacing; uniform float uStripes;',
  'uniform float uThickA; uniform float uThickB; uniform float uProgress;',
  'uniform float uColorMode; uniform vec3 uTextColor; uniform vec3 uPalA; uniform vec3 uPalB;',
  'uniform sampler2D uFill; uniform float uFillCount; uniform float uFillTiling;',
  'uniform float uFillAnchor; uniform vec2 uFillScreen;',   // 0=object(glyph UV) 1=frame(screen space)
  SRGB_TO_LINEAR_GLSL,
  // Centre this word's glyphs in the plane (roomy in x for the nudge, tight in y so lines stack close).
  'float inkA(vec2 p){',
  '  float tx = (p.x - 0.5) * uWf * ' + MX.toFixed(3) + ' + uWf * 0.5;',
  '  float ty = uVMid + (p.y - 0.5) * uVH * ' + MY.toFixed(3) + ';',
  '  float a = texture2D(uText, vec2(clamp(tx, 0.0, 1.0), clamp(ty, 0.0, 1.0))).a;',
  '  return a * step(0.0, tx) * step(tx, uWf) * step(0.0, ty) * step(ty, 1.0);',
  '}',
  // One copy: the word nudged horizontally by dx, masked by the SHARED stripe grid (uStripes lines).
  // `duty` is the per-copy stripe thickness (ink fraction of each line); the grid is the same for all.
  'float stripeCopy(vec2 uv, float dx, float duty){',
  '  float w = inkA(vec2(uv.x - dx, uv.y));',
  '  if (duty >= 0.999) return w;',                                    // no gaps -> solid word
  '  float s = fract(uv.y * uStripes);',
  '  float m = 1.0 - smoothstep(duty - 0.02, duty + 0.02, s);',        // 1 in stripe, 0 in gap
  '  return w * m;',
  '}',
  // Colour for copy k of kf (t = 0 bottom .. 1 top): one colour, a two-colour palette fade, or this
  // copy\'s own fill from the per-copy fill atlas (band = k, wrapping if fewer fills than copies).
  'vec3 copyColor(float t, float kf, vec2 uv){',
  '  if (uColorMode < 0.5) return uTextColor;',
  '  if (uColorMode < 1.5) return mix(uPalA, uPalB, t);',
  '  float band = mod(kf, uFillCount);',
  '  vec2 fillUv = uFillAnchor > 0.5 ? gl_FragCoord.xy / uFillScreen : vec2(fract(uv.x * uFillTiling), clamp(uv.y, 0.0, 1.0));',
  '  vec2 fuv = vec2(fillUv.x, (band + fillUv.y) / uFillCount);',
  '  return stLin(texture2D(uFill, fuv).rgb);',
  '}',
  'const int MAX_LAYERS = ' + MAX_LAYERS + ';',
  'void main(){',
  // Paint uCopies overlapping copies bottom-to-top over the background. Each copy k shares the stripe
  // grid but has its own thickness (bottom thin -> top thick) and an even horizontal nudge. Both the
  // spread and the thinning scale with progress, so progress 0 collapses every copy to one solid word.
  '  vec3 col = uBg;',
  '  for (int k = 0; k < MAX_LAYERS; k++){',
  '    if (float(k) >= uCopies) break;',
  '    float t = (uCopies > 1.0) ? float(k) / (uCopies - 1.0) : 0.0;', // 0 = bottom of pile, 1 = top
  '    float dx = (float(k) - (uCopies - 1.0) * 0.5) * uSpacing * uProgress;',
  '    float duty = mix(1.0, mix(uThickA, uThickB, t), uProgress);',
  '    float ink = stripeCopy(vUv, dx, duty);',
  '    col = mix(col, copyColor(t, float(k), vUv), ink);',
  '  }',
  '  gl_FragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(0.4545)), 1.0);',
  '}',
].join('\n')

export const shutterEffect: SpaceTypeEffect = {
  id: 'shutter',
  label: 'Shutter',
  controls,
  liveKeys: ['copies', 'spacing', 'stripes', 'thicknessBottom', 'thicknessTop', 'progress', 'mode', 'scenes', 'variance', 'holdTime', 'transitionTime', 'ease', 'seed', 'scale', 'rotateZ', 'colorMode', 'textColor', 'paletteA', 'paletteB', 'bgColor'],

  loopRates(params) {
    // Static = frozen (no motion). Loop = one full scene ring per loop → single seamless cycle.
    return String(params.mode ?? 'static') === 'static' ? [] : [1]
  },

  buildScene(three, params, textTexture) {
    const root = new three.Group()
    const tex = textTexture.clone()
    tex.wrapS = tex.wrapT = three.ClampToEdgeWrapping
    tex.needsUpdate = true

    const ud = textTexture.userData ?? {}
    const img = textTexture.image as { width?: number; height?: number } | undefined
    const texAspect = Math.max(0.1, (img?.width ?? 1) / (img?.height ?? 1))
    const numTexts = Math.max(1, Math.round(Number(ud.numTexts ?? 1)))
    const wordFracs = (ud.wordFracs as number[] | undefined) ?? [1]
    const wordInkFracs = (ud.wordInkFracs as number[] | undefined) ?? [1]
    const inkVH = Math.max(0.02, Number(ud.inkHeightFrac ?? 0.6))
    const inkVMid0 = Number(ud.inkVMid ?? 0.5)

    // Per-copy fill atlas (one band per fill row); cached singleton, not disposed by the engine.
    const fills = parseFills(params.fill)
    const fillTex = fillAtlasTexture(three, fills)
    const fillCount = Math.max(1, fills.length)

    // Per-word ink aspect (width / height), used for plane sizing.
    const aspects: number[] = []
    for (let wi = 0; wi < numTexts; wi++) {
      const wf = Math.max(0.02, (wordFracs[wi] ?? 1) * (wordInkFracs[wi] ?? 1))
      aspects.push(Math.max(0.05, (wf * texAspect) / inkVH))
    }

    // Poster layout: each word gets an equal world-height window H; word 0 (first line) on top.
    // Fit vertically first, then shrink to fit the widest word horizontally so nothing overflows.
    const BOX = 9
    const gapFrac = Math.max(-0.6, n(params, 'rowGap'))
    let H = BOX / (numTexts + gapFrac * (numTexts - 1))
    const widthAt = (h: number) => Math.max(...aspects.map(a => (MX / MY) * h * a))
    if (widthAt(H) > BOX) H *= BOX / widthAt(H)
    const step = H * (1 + gapFrac)
    const topY = (step * (numTexts - 1)) / 2

    // Full-field background behind every word so the poster reads as one continuous colour
    // (the line gaps between words show this, not the studio backdrop).
    const bgMat = new three.MeshBasicMaterial({ color: new three.Color(stripAlpha(String(params.bgColor))) })
    const bgMesh = new three.Mesh(new three.PlaneGeometry(60, 60), bgMat)
    bgMesh.position.z = -0.5
    root.add(bgMesh)

    const materials: THREE.ShaderMaterial[] = []
    for (let wi = 0; wi < numTexts; wi++) {
      const wf = Math.max(0.02, (wordFracs[wi] ?? 1) * (wordInkFracs[wi] ?? 1))
      const vmid = inkVMid0 + wi / numTexts                 // this row's ink centre in full-atlas v
      const planeH = H
      const planeW = (MX / MY) * H * aspects[wi]!           // preserve ink aspect under the asymmetric margins
      const yc = topY - wi * step                           // word 0 highest

      const material = new three.ShaderMaterial({
        side: three.DoubleSide,
        uniforms: {
          uText: { value: tex },
          uBg: { value: new three.Color(stripAlpha(String(params.bgColor))) },
          uWf: { value: wf }, uVMid: { value: vmid }, uVH: { value: inkVH },
          uCopies: { value: 4 }, uSpacing: { value: 0.02 }, uStripes: { value: 22 },
          uThickA: { value: 0.32 }, uThickB: { value: 0.86 }, uProgress: { value: 1 },
          uColorMode: { value: 0 },
          uTextColor: { value: new three.Color(stripAlpha(String(params.textColor))) },
          uPalA: { value: new three.Color(stripAlpha(String(params.paletteA))) },
          uPalB: { value: new three.Color(stripAlpha(String(params.paletteB))) },
          uFill: { value: fillTex }, uFillCount: { value: fillCount }, uFillTiling: { value: 1 },
          uFillAnchor: { value: fillAnchor(fills[0]!) }, uFillScreen: { value: fillScreenVec(three) },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
      })
      const mesh = new three.Mesh(new three.PlaneGeometry(planeW, planeH), material)
      mesh.position.y = yc
      mesh.userData.tex = tex
      root.add(mesh)
      materials.push(material)
    }

    root.userData.shutterState = { materials, bg: bgMat } as ShutterState
    shutterEffect.update(0, params, root)
    return root
  },

  update(t01, params, root) {
    const s = root?.userData?.shutterState as ShutterState | undefined
    if (!s) return
    const copies = Math.min(MAX_LAYERS, Math.max(1, Math.round(n(params, 'copies'))))
    const baseSpacing = Math.max(0, n(params, 'spacing'))
    const stripes = Math.max(1, n(params, 'stripes'))
    const thickA = clamp01(n(params, 'thicknessBottom'))
    const thickB = clamp01(n(params, 'thicknessTop'))
    const mode = COLOR_MODE[String(params.colorMode)] ?? 0

    // Scene-sequenced motion: blend the current/next scene poses (amount + spread) at loop time t01.
    const isStatic = String(params.mode ?? 'static') === 'static'
    const baseAmount = n(params, 'progress')
    const variance = clamp01(n(params, 'variance'))
    const seed = Math.round(n(params, 'seed'))
    const holdFrac = holdFraction(n(params, 'holdTime'), n(params, 'transitionTime'))
    const { cur, nxt, e } = sceneBlend(t01, n(params, 'scenes'), holdFrac, parseEase(params.ease), isStatic)
    const a0 = shutterPose(cur, baseAmount, variance, seed)
    const a1 = shutterPose(nxt, baseAmount, variance, seed)
    const prog = lerp(a0.amount, a1.amount, e)
    const spacing = baseSpacing * lerp(a0.spread, a1.spread, e)

    for (const m of s.materials) {
      const u = m.uniforms
      u.uCopies!.value = copies
      u.uSpacing!.value = spacing
      u.uStripes!.value = stripes
      u.uThickA!.value = thickA
      u.uThickB!.value = thickB
      u.uProgress!.value = prog
      u.uColorMode!.value = mode
      ;(u.uTextColor!.value as THREE.Color).set(stripAlpha(String(params.textColor)))
      ;(u.uPalA!.value as THREE.Color).set(stripAlpha(String(params.paletteA)))
      ;(u.uPalB!.value as THREE.Color).set(stripAlpha(String(params.paletteB)))
      ;(u.uBg!.value as THREE.Color).set(stripAlpha(String(params.bgColor)))
    }
    s.bg.color.set(stripAlpha(String(params.bgColor)))
  },
}
