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
float fbm(vec2 p, float seed) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) { v += a * vnoise(p, seed + float(i) * 17.0); p *= 2.03; a *= 0.5; }
    return v;
}

uniform float u_scale;
uniform float u_speed;
uniform float u_warp;
uniform float u_hue;
uniform float u_contrast;
uniform float u_mix;

vec3 pal(float t) {
    return 0.5 + 0.5 * cos(6.28318 * (vec3(1.0) * t + vec3(0.0, 0.33, 0.66) + u_hue));
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (v_texCoord - 0.5) * asp * u_scale;
    float t = u_time * u_speed * 0.2;

    // Domain-warped fractal field — flowing smoke / marble.
    vec2 q = vec2(fbm(p + vec2(0.0, t), u_seed), fbm(p + vec2(3.7, -t), u_seed + 5.0));
    float vv = fbm(p + u_warp * q + t * 0.5, u_seed + 17.0);
    vv = clamp((vv - 0.5) * (1.0 + u_contrast * 2.0) + 0.5, 0.0, 1.0);
    vec3 field = pal(0.1 + vv + length(q) * 0.15);

    if (u_hasInput > 0.5) {
        // Modulate a connected image: warp it along the fbm flow, then tint by the field.
        vec2 disp = (q - 0.5) * u_warp * 0.12;
        vec3 img = texture(u_image0, clamp(v_texCoord + disp, 0.0, 1.0)).rgb;
        vec3 tinted = img * (0.4 + 1.2 * field);            // field modulates the image colour
        fragColor0 = vec4(clamp(mix(img, tinted, u_mix), 0.0, 1.0), 1.0);
    } else {
        // No input: the pure generative field.
        fragColor0 = vec4(field, 1.0);
    }
}
