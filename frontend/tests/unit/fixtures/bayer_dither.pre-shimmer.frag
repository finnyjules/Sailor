#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_scale;
uniform float u_levels;
uniform float u_colored;
uniform float u_pattern;
uniform sampler2D u_blueNoise;

const int BN = 64; // blue-noise tile size (matches bake_blue_noise.py SIZE)

const int B2[4] = int[4](0, 2, 3, 1);
const int B4[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
const int B8[64] = int[64](
   0, 32,  8, 40,  2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37, 63, 31, 55, 23, 61, 29, 53, 21);
const int CL8[64] = int[64](
  24, 10, 12, 26, 35, 47, 49, 37,
   8,  0,  2, 14, 45, 59, 61, 51,
  22,  6,  4, 16, 43, 57, 63, 53,
  30, 20, 18, 28, 33, 41, 55, 39,
  34, 46, 48, 38, 25, 11, 13, 27,
  44, 58, 60, 50,  9,  1,  3, 15,
  42, 56, 62, 52, 23,  7,  5, 17,
  32, 40, 54, 36, 31, 21, 19, 29);

int imod(int a, int b) { int r = a - (a / b) * b; return r < 0 ? r + b : r; }

uint pcg(uint v) { v = v * 747796405u + 2891336453u; uint w = ((v >> ((v >> 28) + 4u)) ^ v) * 277803737u; return (w >> 22) ^ w; }
float ihash(ivec2 p) { uint h = pcg(uint(p.x) * 73856093u ^ pcg(uint(p.y) * 19349663u)); return float(h & 0xffffffu) / 16777216.0; }

float blueAt(ivec2 c, float s) {
  ivec2 p = ivec2(floor(vec2(c) / s));
  return texelFetch(u_blueNoise, ivec2(imod(p.x, BN), imod(p.y, BN)), 0).r;
}

float ditherThreshold(ivec2 c, int pat) {
  if (pat == 0) return (float(B2[imod(c.y, 2) * 2 + imod(c.x, 2)]) + 0.5) / 4.0;
  if (pat == 1) return (float(B4[imod(c.y, 4) * 4 + imod(c.x, 4)]) + 0.5) / 16.0;
  if (pat == 2) return (float(B8[imod(c.y, 8) * 8 + imod(c.x, 8)]) + 0.5) / 64.0;
  if (pat == 3) return (float(CL8[imod(c.y, 8) * 8 + imod(c.x, 8)]) + 0.5) / 64.0;
  if (pat == 4) return (float(imod(c.y, 4)) + 0.5) / 4.0;
  if (pat == 5) return (float(imod(c.x + c.y, 4)) + 0.5) / 4.0;
  if (pat == 6) return ihash(c);
  if (pat == 7) return ihash(c / 2);
  if (pat == 8) return blueAt(c, 1.0);
  if (pat == 9) return blueAt(c, 2.0);
  if (pat == 10) return blueAt(c, 0.5);
  return fract(float(c.x) * 0.7548776662 + float(c.y) * 0.5698402910);
}

void main() {
  float cell = max(u_scale * u_resolution.y, 1.0);
  ivec2 dc = ivec2(floor(v_texCoord * u_resolution / cell));
  vec2 cuv = (vec2(dc) + 0.5) * cell / u_resolution;
  vec3 src = texture(u_image0, clamp(cuv, 0.0, 1.0)).rgb;

  int pat = int(u_pattern + 0.5);
  float L = max(u_levels, 2.0) - 1.0;
  float th = ditherThreshold(dc, pat) - 0.5;
  if (u_colored > 0.5) {
    vec3 col = floor(src * L + th + 0.5) / L;
    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
  } else {
    float lum = dot(src, vec3(0.299, 0.587, 0.114));
    float q = floor(lum * L + th + 0.5) / L;
    fragColor0 = vec4(vec3(clamp(q, 0.0, 1.0)), 1.0);
  }
}
