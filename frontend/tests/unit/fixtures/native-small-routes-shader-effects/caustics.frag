#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
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
vec3 pal(float t, float hue) { return 0.5 + 0.5 * cos(6.28318 * (vec3(1.0) * t + vec3(0.0, 0.33, 0.66) + hue)); }

uniform float u_scale;
uniform float u_speed;
uniform float u_intensity;
uniform float u_hue;

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = v_texCoord * asp * u_scale;
    float t = u_time * u_speed * 0.3;
    float c = 0.0, amp = 1.0;
    vec2 q = p;
    for (int i = 0; i < 3; i++) {
        float n = vnoise(q + vec2(t, -t * 0.7), u_seed + float(i) * 5.0);
        float ridge = 1.0 - abs(n * 2.0 - 1.0);   // bright thin veins
        c += pow(ridge, 3.0) * amp;
        q = q * 1.8 + n;
        amp *= 0.6;
    }
    c = pow(c, 1.5) * u_intensity;
    vec3 col = pal(0.55 + c * 0.2, u_hue) * c + vec3(0.0, 0.02, 0.05);
    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
