#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_hasInput;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uint pcg(uint v) { v = v * 747796405u + 2891336453u; v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (v >> 22u) ^ v; }
float hash2(vec2 ip, float seed) {
    uvec2 q = uvec2(ivec2(ip) + 32768);
    uint h = pcg(q.x ^ pcg(q.y ^ pcg(uint(int(seed)))));
    return float(h) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p, float seed) {
    vec2 i = floor(p), f = fract(p);
    vec2 u2 = f * f * (3.0 - 2.0 * f);
    float a = hash2(i, seed), b = hash2(i + vec2(1, 0), seed);
    float c = hash2(i + vec2(0, 1), seed), d = hash2(i + vec2(1, 1), seed);
    return mix(mix(a, b, u2.x), mix(c, d, u2.x), u2.y);
}
float fbmN(vec2 p, float seed, int oct) {
    float v = 0.0, a = 0.5, norm = 0.0;
    for (int i = 0; i < 8; i++) {
        if (i >= oct) break;
        v += a * vnoise(p, seed + float(i) * 17.0); norm += a;
        p *= 2.03; a *= 0.5;
    }
    return v / max(norm, 1e-5);
}
// 4x4 ordered dither threshold (same table as bayer_dither.frag's B4).
const int B4[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
float bayer4(vec2 px) {
    ivec2 p = ivec2(mod(floor(px), 4.0));
    return (float(B4[p.x + p.y * 4]) + 0.5) / 16.0;
}

// The `gradient` param is read as INK ROLES here, not as a ramp: the stops' order is the
// role, their positions are ignored. 1 ground (sea), 2 land, 3 coast fringe, 4 specks,
// 5 deep land, 6 shallows. Fewer stops fall back to the last one provided.
#define MAXS 8
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;
vec3 ink(int role) {
    int n = int(u_rampCount + 0.5);
    int i = clamp(min(role, n - 1), 0, MAXS - 1);
    return u_ramp[i];
}

uniform float u_level;     // Coverage: how much of the frame is land
uniform float u_scale;     // Feature size
uniform float u_warp;      // Distortion: the field pushed through itself
uniform float u_detail;
uniform float u_cell;      // Pixel size of the whole picture
uniform float u_halftone;  // Halftone cells across the short axis
uniform float u_depth;     // How far inland the halftone keeps thinning
uniform float u_fringe;    // Width of the dithered coast band (ink 3)
uniform float u_specks;    // Density of scattered specks near the coast (ink 4)
uniform float u_speed;
uniform float u_mix;

float heightAt(vec2 uv, float t, int oct) {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (uv - 0.5) * asp * u_scale;
    vec2 q = vec2(fbmN(p + vec2(t, 0.0), u_seed, oct), fbmN(p + vec2(2.3, 5.1) - t, u_seed + 7.0, oct));
    return fbmN(p + u_warp * (q - 0.5) * 2.0, u_seed + 17.0, oct);
}

void main() {
    // Snap to a coarse pixel grid first so every edge is chunky, not per-device-pixel.
    float cell = max(u_cell, 1.0);
    vec2 px = floor(v_texCoord * u_resolution / cell);
    vec2 uv = (px + 0.5) * cell / u_resolution;
    float t = u_time * u_speed * 0.1;
    int oct = int(clamp(u_detail, 1.0, 8.0) + 0.5);

    // One level cut through the field: d > 0 is land, d < 0 is sea, d = 0 is the coast.
    float h = heightAt(uv, t, oct);
    float d = h - (1.0 - u_level);

    vec3 col = ink(0);
    if (d > 0.0) {
        // Land: an ordered-dither halftone in SNAPPED-PIXEL space (whole pixel cells, so it
        // cannot beat against the pixel grid) that is solid deep inland and thins to
        // scattered squares at the coast; the squares are the land ink over the ground ink.
        float hcell = max(1.0, floor(u_resolution.y / (max(u_halftone, 4.0) * cell) + 0.5));
        float inland = clamp(d / max(u_depth * 0.25, 1e-3), 0.0, 1.0);
        float dotOn = step(bayer4(floor(px / hcell)), inland);
        col = mix(ink(0), ink(1), dotOn);
        // The innermost land takes the deep ink.
        if (d > 0.22) col = ink(4);
    } else {
        // Shallows: a wide, faintly dithered band of sea just off the coast (ink 6),
        // then the coast fringe right at the shore (ink 3), dithered so it speckles.
        float shallows = 1.0 - smoothstep(0.0, 0.16, -d);
        if (step(bayer4(px + 2.0), shallows * 0.6) > 0.5) col = ink(5);
        float fw = max(u_fringe * 0.12, 1e-4);
        float fringe = 1.0 - smoothstep(0.0, fw, -d);
        if (step(bayer4(px), fringe) > 0.5) col = ink(2);
    }

    // Specks: scattered single pixels of ink 4 along both sides of the coast.
    float near = 1.0 - smoothstep(0.0, 0.08, abs(d));
    if (hash2(px, u_seed + 51.0) < u_specks * 0.35 * near) col = ink(3);

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        vec3 img = texture(u_image0, v_texCoord).rgb;
        col = mix(col, img, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
