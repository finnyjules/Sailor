/**
 * The contract between Sailor and the model that writes shader effects
 * (AI in Sailor spec §7.2). Sailor supplies the preamble and the helpers; the
 * model writes only the effect's own uniforms, functions and main() — the
 * "body" — plus 3–5 dials. Shared by the app (engine, checks) and the server
 * (/api/shader-gen's strict output schema).
 *
 * SHADERGEN_PREAMBLE + SHADERGEN_HELPERS must stay byte-identical to the spike's
 * PRE + LIB (tests/unit/shadergen-contract.unit.spec.ts guards this), so the 24
 * spike takes remain valid bodies.
 */

export const SHADERGEN_PREAMBLE = `#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;
`

export const SHADERGEN_HELPERS = `
float h21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+5.2; a*=0.5; } return s; }
vec3 tex(vec2 uv){ return texture(u_image0, clamp(uv,0.0,1.0)).rgb; }
vec3 blur9(vec2 uv, float r){ vec3 s=vec3(0.0); for(int i=-2;i<=2;i++) for(int j=-2;j<=2;j++) s+=tex(uv+vec2(float(i),float(j))*r); return s/25.0; }
float luma(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
vec2 ASP(){ return vec2(u_resolution.x/u_resolution.y,1.0); }
vec3 hsv2rgb(vec3 c){ vec3 p=abs(fract(c.xxx+vec3(0.0,2.0/3.0,1.0/3.0))*6.0-3.0); return c.z*mix(vec3(1.0),clamp(p-1.0,0.0,1.0),c.y); }
vec3 thinfilm(float d){ return 0.5+0.5*cos(6.28318*(d*vec3(1.0,1.18,1.42)+vec3(0.0,0.1,0.2))); }
`

export const PREAMBLE_UNIFORMS = ['u_image0', 'u_resolution', 'u_time', 'u_seed'] as const

export const LIMITS = {
  minParams: 3,
  maxParams: 5,
  maxLoopIterations: 64,
  maxLoopTextureReads: 32,
  maxBodyChars: 12_000,
} as const

export type GenParamType = 'float' | 'enum' | 'color'

export interface GenParam {
  uniform: string
  label: string
  type: GenParamType
  min?: number
  max?: number
  step?: number
  /** number for float/enum · '#rrggbb' for color */
  default: number | string
  options?: { label: string; value: number }[]
}

export interface GenTake {
  name: string
  animated: boolean
  generative: boolean
  params: GenParam[]
  /** Uniform declarations + functions + main(); no preamble, no helpers. */
  body: string
}

/** The full GLSL ES 3.00 fragment source the renderer compiles. */
export function assembleSource(body: string): string {
  return `${SHADERGEN_PREAMBLE}${SHADERGEN_HELPERS}\n${body.trim()}\n`
}

/** Strict output schema for ONE take (structured outputs, output_config.format). */
export const SHADERGEN_TAKE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'animated', 'generative', 'params', 'body'],
  properties: {
    name: { type: 'string' },
    animated: { type: 'boolean' },
    generative: { type: 'boolean' },
    body: { type: 'string' },
    params: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['uniform', 'label', 'type', 'default'],
        properties: {
          uniform: { type: 'string' },
          label: { type: 'string' },
          type: { type: 'string', enum: ['float', 'enum', 'color'] },
          min: { type: 'number' },
          max: { type: 'number' },
          step: { type: 'number' },
          default: { anyOf: [{ type: 'number' }, { type: 'string' }] },
          options: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'value'],
              properties: { label: { type: 'string' }, value: { type: 'number' } },
            },
          },
        },
      },
    },
  },
} as const
