// Paint materials catalogue: live GLSL "looks" for brush strokes, ported from the prototype
// docs/superpowers/specs/assets/2026-09-26-shader-brush-prototype.html (layProg material
// branches, L566-603; MATERIALS table L123-131).
//
// MATERIAL_GLSL declares shadeMaterial(...) only. It requires the caller to have already
// declared hash/noise/fbm/hsv (the NOISE block in lib/brushTips/engine.ts) — it does not
// redefine them. Every coordinate here is a Frame unit (REF_W = 1080), never device px or
// gl_FragCoord, so a look is identical at every render size (uCss/gl_FragCoord banned by test).
//
// The paint branch (uMat == 0) is not a material — it is today's plain fill, handled elsewhere.
// Neon (mat 5) is not handled here either: the engine does its own sprayed-light halo pass:
// shadeMaterial returns vec4(0) for mat == 5.

export type MaterialId = 'foil' | 'chrome' | 'lava' | 'ink' | 'neon' | 'oil'

export const MATERIAL_IDS: readonly MaterialId[] = ['foil', 'chrome', 'lava', 'ink', 'neon', 'oil']

export interface MaterialDef {
  id: MaterialId
  label: string
  /** CSS background for the swatch button. */
  swatch: string
  /** Flat #rrggbb fallback: used by the Canvas2D path (no WebGL2) and anywhere a single colour stands in for the material. */
  swatchColor: string
  /** 1..6, the GLSL uMat value shadeMaterial expects (uMat 0 is plain paint, not a material). */
  index: number
}

export const MATERIALS: Record<MaterialId, MaterialDef> = {
  foil: {
    id: 'foil',
    label: 'Holographic foil',
    swatch: 'conic-gradient(from 30deg, #ffd1f0, #c9d8ff, #bff5e6, #fff3b8, #ffc9d9, #ffd1f0)',
    swatchColor: '#d9c8f0',
    index: 1,
  },
  chrome: {
    id: 'chrome',
    label: 'Liquid chrome',
    swatch: 'linear-gradient(160deg, #f6f8ff 0 35%, #545a66 48%, #d9dde6 60%, #1b1d22 100%)',
    swatchColor: '#c4c9d4',
    index: 2,
  },
  lava: {
    id: 'lava',
    label: 'Lava',
    swatch: 'radial-gradient(circle at 40% 40%, #ffe07a, #ff5a12 45%, #2a0f0a 80%)',
    swatchColor: '#ff6a1a',
    index: 3,
  },
  ink: {
    id: 'ink',
    label: 'Marbled ink',
    swatch: 'linear-gradient(135deg, #0e1440, #1d6d7a 55%, #efe3cf 62%, #122050)',
    swatchColor: '#1d4e6e',
    index: 4,
  },
  neon: {
    id: 'neon',
    label: 'Neon',
    swatch: 'radial-gradient(circle, #fff 0 18%, #ff4fd8 35%, rgba(255,79,216,0.15) 70%), #1a0f22',
    swatchColor: '#ff4fd8',
    index: 5,
  },
  oil: {
    id: 'oil',
    label: 'Oil slick',
    swatch: 'linear-gradient(120deg, #050507 20%, #6b2cff 40%, #16c7a8 55%, #ffb000 68%, #050507 85%)',
    swatchColor: '#3a2a6e',
    index: 6,
  },
}

export function isMaterialId(x: unknown): x is MaterialId {
  return typeof x === 'string' && (MATERIAL_IDS as readonly string[]).includes(x)
}

// vec4 shadeMaterial(int mat, float a, float d, vec2 surf, bool has, float sU, float sV, float sSeed, float uTime, vec3 N)
// `a` is the coverage this fragment already resolved (grain/tooth folded in by the caller);
// `d` is raw paint density, used only for lava's crust/hot mix. `surf` is the Frame-unit
// surface position (spray groups) — the prototype's `px`. `has` is true when stroke coordinates
// (sU = distance along the stroke, sV = across it, sSeed = the stroke's seed) are valid; round
// and bristle tips always pass has = true, spray without a followed stroke passes has = false
// and surf instead. Returns premultiplied colour for coverage `a`.
//
// diff/spec/wet fold in uRelief = 0 (spray and round paint are flat — the engine's separate
// shade pass handles relief): diff = 1, spec contributes 0, only wet (a function of d) survives.
export const MATERIAL_GLSL = `
vec4 shadeMaterial(int mat, float a, float d, vec2 surf, bool has, float sU, float sV, float sSeed, float uTime, vec3 N){
  if(mat == 5) return vec4(0);
  float flowU = sU - uTime*55.;
  float diff = 1.;
  float spec = 0.;
  float wet = smoothstep(.8, 1., d);
  vec3 col; float sp = .15, emit = 0.;
  if(mat == 1){ // holographic foil
    float t = has ? flowU*.0028 + sV*.55 + fbm(vec2(flowU*.006, sV*1.2 + sSeed))*.8 + N.x*.25
                  : surf.x*.0016 + surf.y*.0011 + fbm(surf/220. + uTime*.06 + sSeed)*.9 + N.x*.25 - uTime*.05;
    col = hsv(fract(t), .42, 1.)*.88 + .1;
    col += step(.994, hash(floor(surf/1.5) + floor(uTime*10.)))*.9*a;
    sp = .8; emit = .35;
  } else if(mat == 2){ // liquid chrome
    float y = has ? -sV*1.3 + N.y*.8 + (fbm(vec2(flowU*.004, sV*.8 + sSeed)) - .5)*1.4
                  : (.5 - surf.y/1080.)*3. + N.y*.8 + (fbm(surf/260. + vec2(uTime*.08, 0.) + sSeed) - .5)*1.6;
    vec3 sky = mix(vec3(.93,.95,1.), vec3(.3,.34,.42), smoothstep(0., 1.1, y));
    vec3 gnd = mix(vec3(.03,.03,.05), vec3(.6,.55,.5), smoothstep(-1.3, 0., y));
    col = y > 0. ? sky : gnd;
    col += smoothstep(.07, 0., abs(y))*.5;
    sp = 1.; emit = .85;
  } else if(mat == 3){ // lava
    vec2 q = has ? vec2(flowU*.008, sV*1.3 + sSeed) : surf/110. + sSeed;
    float f = has ? fbm(q + vec2(fbm(q*1.7 + uTime*.2), 0.)*1.5) : fbm(q + vec2(fbm(q*1.7 + uTime*.25), uTime*.12)*1.6);
    float crust = smoothstep(.47, .6, f);
    vec3 hot = mix(vec3(1.,.25,.02), vec3(1.,.86,.4), smoothstep(.5, 1., d)*(1.-crust));
    col = mix(hot*1.45, vec3(.09,.05,.05), crust);
    emit = 1. - crust; sp = .4*crust;
  } else if(mat == 4){ // marbled ink
    vec2 q = has ? vec2(flowU*.005, sV*1.1 + sSeed*3.) : surf/170. + sSeed*3.;
    vec2 w = vec2(fbm(q + uTime*.05), fbm(q + 5.2));
    float m = fbm(q + w*2.2);
    col = mix(vec3(.05,.07,.22), vec3(.1,.45,.55), smoothstep(.3, .7, m));
    col = mix(col, vec3(.95,.9,.8), smoothstep(.64, .7, m)*.9);
    sp = .5;
  } else { // oil slick (mat == 6)
    float th = has ? fbm(vec2(flowU*.006, sV*1.4 + sSeed))*2. + sV*.6 + N.x*.4 : fbm(surf/200. + sSeed + uTime*.03)*2. + N.x*.4;
    vec3 film = .5 + .5*cos(6.2831*(th + vec3(0., .33, .67)));
    col = mix(vec3(.02,.02,.03), film, .8*smoothstep(.25, .85, has ? fbm(vec2(flowU*.012, sV*2.5 + sSeed)) : fbm(surf/90. + sSeed)));
    sp = .7;
  }
  vec3 lit = col*mix(diff, 1., emit) + spec*(sp + wet*.12);
  return vec4(lit*a, a);
}
`
