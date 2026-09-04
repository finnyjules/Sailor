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

// The inks are a ramp by order: slot 0 is the deepest band, the last the palest. Levels
// wrap every `u_steps`, and every level lands on some ink whatever the step count, so no
// swatch is ever dead.
#define MAXS 8
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;
uniform float u_steps;
vec3 rampLevel(float k) {
    int n = max(1, int(u_rampCount + 0.5));
    float s = max(2.0, floor(u_steps + 0.5));
    float km = mod(k, s);                                    // 0 <= km < s, also for negative k
    int idx = int(floor(km / s * float(n)));
    return u_ramp[clamp(idx - (idx / n) * n, 0, MAXS - 1)];
}

uniform float u_cols;
uniform float u_rings;
uniform float u_warp;
uniform float u_grain;
uniform float u_calm;
uniform float u_ripple;
uniform float u_speed;
uniform float u_mix;

void main() {
    float W = u_resolution.x, H = u_resolution.y;
    float cols = max(4.0, floor(u_cols + 0.5));
    float cw = W / cols;
    float rows = max(3.0, floor(H / cw + 0.5));
    float ch = H / rows;
    float asp = W / H;

    // The cell, mirrored: each cell reads the field at its own quadrant's coordinates, so
    // the four quadrants are one decision read four times.
    vec2 pxy = vec2(v_texCoord.x * W, (1.0 - v_texCoord.y) * H);
    float i = floor(pxy.x / cw), j = floor(pxy.y / ch);
    float mi = min(i, cols - 1.0 - i), mj = min(j, rows - 1.0 - j);
    float u = (mi + 0.5) / cols, v = (mj + 0.5) / rows;
    float dx = (0.5 - u) * asp, dy = 0.5 - v;
    float r = length(vec2(dx, dy)) / length(vec2(0.5 * asp, 0.5));

    // Rings pushed off true: a slow field swings whole lobes out of round, a quick one
    // roughens their edges.
    float slow = fbmN(vec2(u * 3.2 + 3.1, v * 3.2 + 7.7), u_seed + 11.0, 3) - 0.5;
    float fast = fbmN(vec2(u * 9.5 + 13.7, v * 9.5 + 2.3), u_seed + 17.0, 2) - 0.5;
    r += (slow * 1.35 + fast * 0.5) * u_warp;

    // Ripple marches the bands outward a level at a time; still at Speed 0.
    float march = u_time * u_speed * 0.5 * u_ripple;
    float calmR = u_calm * 0.55;
    float lvl;
    if (r <= calmR) {
        lvl = 0.0;                                           // the quiet middle is the innermost band
    } else {
        // Grain works in whole levels, not in radius: a tenth of a level never crosses a
        // boundary, so it would do nothing you could see.
        float g = (fbmN(vec2(u * 21.0 + 1.3, v * 21.0 + 9.1), u_seed + 29.0, 2) - 0.5) * u_grain * 2.4;
        lvl = (r - calmR) / (1.0 - calmR) * max(1.0, u_rings) + g + march;
    }
    vec3 col = rampLevel(floor(lvl));

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        col = mix(col, texture(u_image0, v_texCoord).rgb, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
