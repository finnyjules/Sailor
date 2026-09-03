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

uniform float u_threads;
uniform float u_thickness;
uniform float u_flow;
uniform float u_scale;
uniform float u_speed;
uniform float u_mix;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (v_texCoord - 0.5) * asp * u_scale;
    float t = u_time * u_speed * 0.1;

    // Two-stage warp: the field bends itself so the threads flow instead of ripple.
    vec2 q = vec2(fbmN(p + vec2(t, 0.0), u_seed, 5), fbmN(p + vec2(0.0, -t), u_seed + 5.0, 5));
    float v = fbmN(p + u_flow * (q - 0.5) * 2.5, u_seed + 17.0, 6);

    // Threads are iso-lines of the warped field, `u_threads` of them across 0..1.
    float f = v * u_threads + t * 2.0;
    float dEdge = abs(fract(f + 0.5) - 0.5) * 2.0;   // 0 on a thread, 1 midway between
    float aa = fwidth(f) * 2.0;
    // Thread weight breathes along its length so it reads as fibre, not a contour map.
    float th = u_thickness * (0.5 + fbmN(p * 3.0 + 7.0, u_seed + 41.0, 3));
    float line = 1.0 - smoothstep(th - aa, th + aa, dEdge);

    // Each thread picks its own ink; the first ink is the ground between threads.
    vec3 ink = rampAt(0.2 + 0.8 * fract(floor(f) * 0.618034));
    vec3 col = mix(u_ramp[0], ink, line);

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        vec3 img = texture(u_image0, v_texCoord).rgb;
        col = mix(col, img, u_mix);
    }
    fragColor0 = vec4(col, 1.0);
}
