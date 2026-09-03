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

uniform vec3 u_sea;
uniform vec3 u_land;
uniform float u_level;
uniform float u_edge;
uniform float u_scale;
uniform float u_detail;
uniform float u_cell;
uniform float u_speed;
uniform float u_mix;

void main() {
    // Snap to a coarse pixel grid first so the dither is chunky, not per-device-pixel.
    float cell = max(u_cell, 1.0);
    vec2 px = floor(v_texCoord * u_resolution / cell);
    vec2 uv = (px + 0.5) * cell / u_resolution;
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (uv - 0.5) * asp * u_scale;
    float t = u_time * u_speed * 0.1;
    int oct = int(clamp(u_detail, 1.0, 8.0) + 0.5);

    float h = fbmN(p + vec2(t, -t * 0.7), u_seed, oct);
    // Coastline: the chance of "land" rises across the shore band, and the ordered
    // dither turns that chance into a stippled edge.
    float e = max(u_edge, 1e-4);   // equal smoothstep edges are undefined in GLSL; keep a hair of width
    float prob = smoothstep(u_level - e, u_level + e, h);
    float land = step(bayer4(px), prob);
    vec3 col = mix(u_sea, u_land, land);

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        vec3 img = texture(u_image0, v_texCoord).rgb;
        col = mix(col, img, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
