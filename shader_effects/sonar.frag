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
        v += a * vnoise(p, seed + float(i) * 131.0); norm += a;
        p *= 2.0; a *= 0.5;
    }
    return v / max(norm, 1e-5);
}

// Ink ROLES by slot, as the tool does: 1 ground, 2 land, 3 coast A, 4 coast B. Slots past
// the inks provided wrap round, so a two-ink ramp still draws.
#define MAXS 8
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;
vec3 ink(int role) {
    int n = max(1, int(u_rampCount + 0.5));
    return u_ramp[clamp(role - (role / n) * n, 0, MAXS - 1)];
}

uniform float u_level;
uniform float u_scale;
uniform float u_warp;
uniform float u_grid;
uniform float u_depth;
uniform float u_fringe;
uniform float u_spark;
uniform float u_tide;
uniform float u_speed;
uniform float u_mix;

// Is canvas-local point `l` (0..cw, 0..ch) inside a square of side k centred in the cell?
bool inSquare(vec2 l, float cw, float ch, float k) {
    vec2 c0 = vec2((cw - k) * 0.5, (ch - k) * 0.5);
    return l.x >= c0.x && l.x < c0.x + k && l.y >= c0.y && l.y < c0.y + k;
}

void main() {
    float W = u_resolution.x, H = u_resolution.y;
    float cols = max(12.0, floor(u_grid + 0.5));
    float cw = W / cols;
    float rows = max(6.0, floor(H / cw + 0.5));
    float ch = H / rows;
    float asp = W / H;
    float sc = max(0.5, u_scale);

    // Canvas pixel (y DOWN), its cell, and the position inside the cell.
    vec2 pxy = vec2(v_texCoord.x * W, (1.0 - v_texCoord.y) * H);
    float i = floor(pxy.x / cw), j = floor(pxy.y / ch);
    vec2 local = pxy - vec2(i * cw, j * ch);

    // The field at the cell centre, pushed around by a second field so blobs flow.
    float u = (i + 0.5) / cols, v = (j + 0.5) / rows;
    float x = u * sc * asp, y = v * sc;
    float wx = fbmN(vec2(x * 0.6 + 11.3, y * 0.6 + 3.7), u_seed + 7.0, 3) - 0.5;
    float wy = fbmN(vec2(x * 0.6 + 5.1, y * 0.6 + 19.9), u_seed + 13.0, 3) - 0.5;
    float fv = fbmN(vec2(x + wx * u_warp * 2.4, y + wy * u_warp * 2.4), u_seed, 4);

    // Tide breathes the cut level so the coast advances and retreats; still at Speed 0.
    float tide = sin(u_time * u_speed * 0.5) * 0.10 * min(1.6, u_tide);
    float lvl = clamp(u_level * 0.7 + 0.15, 0.05, 0.95) + tide;
    float band = 0.012 + u_fringe * 0.07;      // how far either side the coast breaks up
    float d = fv - lvl;

    vec3 col = ink(0);
    if (d > band) {
        // Inland: one land square per cell, growing with depth, so the fill carries the
        // field's shading instead of being flat.
        float t = min(1.0, (d - band) / (0.20 * (1.05 - u_depth * 0.85)));
        float k = cw * (0.30 + 0.68 * t);
        if (inSquare(local, cw, ch, k)) col = ink(1);
    } else if (d > -band) {
        // The coast: a speck appears more often the nearer the cell is to the cut, in one
        // of two colours used nowhere else.
        float near = 1.0 - abs(d) / band;
        if (hash2(vec2(i, j), u_seed + 53.0) < near * near * u_spark * 1.35) {
            float k = cw * (0.34 + 0.42 * near);
            if (inSquare(local, cw, ch, k)) col = (hash2(vec2(i, j), u_seed + 59.0) < 0.5) ? ink(2) : ink(3);
        }
    }

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        col = mix(col, texture(u_image0, v_texCoord).rgb, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
