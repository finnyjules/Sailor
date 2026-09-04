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
// The tool's two fixed noise stacks: three taps for the curtain, two for the blots.
float fbm3(vec2 p, float k) { return vnoise(p, k) * 0.55 + vnoise(p * 2.13, k + 11.0) * 0.28 + vnoise(p * 4.31, k + 23.0) * 0.17; }
float fbm2t(vec2 p, float k) { return vnoise(p, k) * 0.62 + vnoise(p * 2.13, k + 11.0) * 0.38; }

// Ink 1 is the neon; inks 2.. are the ground tints. Colours are squared before blending
// and square-rooted after, so mixes stay glowing instead of muddy.
#define MAXS 8
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;

uniform float u_streaks;
uniform float u_cover;
uniform float u_soft;
uniform float u_blot;
uniform float u_grain;
uniform float u_bleed;
uniform float u_speed;
uniform float u_mix;

void main() {
    float W = u_resolution.x, H = u_resolution.y;
    float mind = min(W, H);
    // Canvas coordinates centred, scaled by the short side, y DOWN (as the tool).
    vec2 pxy = vec2(v_texCoord.x * W, (1.0 - v_texCoord.y) * H);
    float nx = (pxy.x - W * 0.5) / mind * 1.7;
    float ny = (pxy.y - H * 0.5) / mind * 1.7;

    int n = max(1, int(u_rampCount + 0.5));
    vec3 neon = u_ramp[0] * u_ramp[0];
    int nB = max(1, n - 1);                                  // ground tints; a lone ink is its own ground

    // Bleed lets the whole wash wander on a closed circle; still at Speed 0.
    float ph = u_time * u_speed * 0.3;
    float AA = min(1.6, u_bleed);
    float zx = 0.45 * AA * cos(ph), zy = 0.45 * AA * sin(ph);

    float th = 1.0 - u_cover * 0.9;
    float del = 0.06 + u_soft * 0.24;
    float stf = 2.6 * u_streaks + 1.2;
    float bsc = 0.9 + u_blot * 2.2;
    float gr = u_grain * 13.0 / 255.0;

    // Seeded offsets stand in for the tool's per-seed random placements.
    float sox = hash2(vec2(1.0, 0.0), u_seed) * 53.0, soy = hash2(vec2(2.0, 0.0), u_seed) * 29.0;

    // Soft pastel ground: the base inks blot into each other.
    float gx = nx * bsc + zx * 0.5, gy = ny * bsc + zy * 0.5;
    vec3 acc = vec3(0.0); float sw = 0.0;
    for (int b = 0; b < MAXS - 1; b++) {
        if (b >= nB) break;
        float ox = hash2(vec2(float(b), 3.0), u_seed) * 37.0, oy = hash2(vec2(float(b), 4.0), u_seed) * 43.0;
        float nz = fbm2t(vec2(gx + ox, gy + oy), 60.0 + float(b));
        float w = pow(max(nz, 0.002), 3.4);
        vec3 tint = (n > 1) ? u_ramp[clamp(b + 1, 0, MAXS - 1)] : u_ramp[0];
        acc += w * tint * tint; sw += w;
    }
    vec3 ground = acc / max(sw, 1e-6);

    // The neon curtain: tall thin noise, ragged edges, soft halo.
    float q1 = fbm3(vec2(nx * 1.9 + 3.1, ny * 1.9 + 8.7), 91.0);
    float sx2 = nx * stf + 0.5 * (q1 - 0.5) + sox + zx;
    float sy2 = ny * 0.5 + soy + zy * 0.4;
    float st = fbm3(vec2(sx2, sy2), 77.0) * 0.72 + fbm3(vec2(sx2 * 2.4, sy2 * 2.1), 78.0) * 0.28;
    float m = smoothstep(th - del, th + del, st);
    vec3 sq = mix(ground, neon, m);

    // Grain with the tool's soft-blob character: the tool paints ~260 px wide and scales
    // up smooth, so its per-pixel grain becomes soft bumps; value noise at that lattice
    // gives the same.
    float lat = 260.0 / mind;
    float g2 = (vnoise(pxy * lat, u_seed + 7.0) - 0.5) * gr;
    vec3 col = clamp(sqrt(max(sq, 0.0)) + g2, 0.0, 1.0);

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        col = mix(col, texture(u_image0, v_texCoord).rgb, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
