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

#define MAXS 8
uniform vec3 u_ramp[MAXS];
uniform float u_rampPos[MAXS];
uniform float u_rampCount;
vec3 rampAt(float t) {
    t = clamp(t, 0.0, 1.0);
    int n = int(u_rampCount + 0.5);
    vec3 c = u_ramp[0];
    for (int i = 1; i < MAXS; i++) {
        if (i >= n) break;
        float p0 = u_rampPos[i - 1], p1 = u_rampPos[i];
        c = mix(c, u_ramp[i], clamp((t - p0) / max(p1 - p0, 1e-5), 0.0, 1.0));
    }
    return c;
}
float bandq(float t, float steps) {
    steps = max(steps, 2.0);
    return min(floor(clamp(t, 0.0, 0.9999) * steps), steps - 1.0) / (steps - 1.0);
}

uniform float u_steps;
uniform float u_scale;
uniform float u_bend;
uniform float u_detail;
uniform float u_streak;
uniform float u_drag;
uniform float u_tear;
uniform float u_grain;
uniform float u_cell;
uniform float u_speed;
uniform float u_mix;

// The heat field: fbm pushed through itself by `u_bend` so blobs lean and fold.
float heat(vec2 uv, float t, int oct) {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (uv - 0.5) * asp * u_scale;
    vec2 q = vec2(fbmN(p + vec2(0.0, t), u_seed, oct), fbmN(p + vec2(4.1, 2.7) - t, u_seed + 7.0, oct));
    return fbmN(p + u_bend * (q - 0.5) * 2.5, u_seed + 17.0, oct);
}

void main() {
    float cell = max(u_cell, 1.0);
    vec2 px = floor(v_texCoord * u_resolution / cell);
    vec2 uv = (px + 0.5) * cell / u_resolution;
    float t = u_time * u_speed * 0.15;
    int oct = int(clamp(u_detail, 1.0, 8.0) + 0.5);
    float frame = floor(u_time * u_speed * 10.0);   // row breaks re-roll ~6x/s at default Speed and freeze at Speed 0

    // Drag: every row slides sideways by its own amount. Tear: a few rows jump a long way.
    float row = px.y;
    float dx = (hash2(vec2(row, 0.0), u_seed + frame) - 0.5) * u_drag * 0.25;
    if (hash2(vec2(row, 1.0), u_seed + frame) < u_tear * 0.12) {
        dx += (hash2(vec2(row, 2.0), u_seed + frame) - 0.5) * 0.8;
    }
    vec2 suv = vec2(uv.x + dx, uv.y);

    // Streak: a row holds its hottest value for a stretch to the left (a horizontal max-smear).
    float h = heat(suv, t, oct);
    if (u_streak > 0.0) {
        for (int k = 1; k <= 4; k++) {
            float off = float(k) * u_streak * 0.04;
            h = max(h, heat(suv - vec2(off, 0.0), t, oct) - float(k) * 0.02);
        }
    }
    h = clamp((h - 0.5) * 2.0 + 0.5, 0.0, 1.0);

    float g = (hash2(px, u_seed + 99.0) - 0.5) * u_grain / max(u_steps, 2.0);
    vec3 col = rampAt(bandq(h + g, u_steps));

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        vec3 img = texture(u_image0, v_texCoord).rgb;
        col = mix(col, img, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
