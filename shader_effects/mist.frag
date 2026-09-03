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

uniform float u_blobs;
uniform float u_size;
uniform float u_soft;
uniform float u_grain;
uniform float u_speed;
uniform float u_mix;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 uv = v_texCoord * asp;
    vec2 px = floor(v_texCoord * u_resolution);
    float t = u_time * u_speed * 0.2;
    int n = int(clamp(u_blobs, 1.0, 12.0) + 0.5);

    vec3 col = u_ramp[0];                                  // first ink is the paper
    float sharp = mix(6.0, 1.5, clamp(u_soft, 0.0, 1.0));  // softer = wider falloff
    for (int i = 0; i < 12; i++) {
        if (i >= n) break;
        float fi = float(i);
        // Each wash has a seeded home position and drifts gently around it.
        vec2 c = vec2(hash2(vec2(fi, 0.0), u_seed), hash2(vec2(fi, 1.0), u_seed)) * asp;
        c += 0.08 * vec2(sin(t + fi * 1.7), cos(t * 0.8 + fi * 2.3));
        float d = length(uv - c) / max(u_size, 0.05);
        float w = exp(-d * d * sharp);
        // Spray: per-pixel noise eats into the wash more toward its edge.
        float spray = 1.0 - u_grain * hash2(px, u_seed + 31.0 + fi) * (0.3 + 0.7 * min(d, 1.5));
        w = clamp(w * spray, 0.0, 1.0);
        // Skip the paper ink (ramp position 0) so washes are always the bright inks.
        vec3 ink = rampAt(0.15 + 0.85 * fract(fi * 0.618034 + 0.31));
        col = 1.0 - (1.0 - col) * (1.0 - ink * w);         // screen blend: neon adds light
    }

    if (u_hasInput > 0.5 && u_mix > 0.0) {
        vec3 img = texture(u_image0, v_texCoord).rgb;
        col = mix(col, img, u_mix);
    }
    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
