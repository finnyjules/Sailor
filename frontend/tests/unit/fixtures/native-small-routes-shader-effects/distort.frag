#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_amount;

// Screen-space UV warp — two decorrelated noise fields drive x/y, scaled to a
// pixel budget. Ported verbatim from shapefx/post.ts's POST_FRAG (its
// uDistort/uResolution/uSeed → this catalog's u_amount/u_resolution/u_seed).
float vhash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float a = vhash(i), b = vhash(i + vec2(1.0, 0.0)), c = vhash(i + vec2(0.0, 1.0)), d = vhash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  vec2 uv = v_texCoord;
  if (u_amount > 0.0) {
    float n1 = vnoise(uv * 6.0 + u_seed);
    float n2 = vnoise(uv * 6.0 - u_seed + 17.3);
    vec2 px = (vec2(n1, n2) - 0.5) * (u_amount * 45.0);
    uv += px / max(u_resolution, vec2(1.0));
  }
  vec4 src = texture(u_image0, clamp(uv, 0.0, 1.0));
  fragColor0 = vec4(clamp(src.rgb, 0.0, 1.0), src.a);
}
