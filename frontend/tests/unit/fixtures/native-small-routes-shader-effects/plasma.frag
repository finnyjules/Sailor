#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_scale;
uniform float u_speed;
uniform float u_hue;
uniform float u_contrast;

vec3 pal(float t) {
    return 0.5 + 0.5 * cos(6.28318 * (vec3(1.0) * t + vec3(0.0, 0.33, 0.66) + u_hue));
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 p = (v_texCoord - 0.5) * asp * u_scale;
    float t = u_time * u_speed;

    // Classic summed-sine plasma — fully deterministic across runtimes.
    float v = 0.0;
    v += sin(p.x * 1.7 + t);
    v += sin(p.y * 1.3 - t * 1.1);
    v += sin((p.x + p.y) * 1.1 + t * 0.7);
    float r = length(p);
    v += sin(r * 2.5 - t * 1.3);
    v *= 0.25;
    v = v * 0.5 + 0.5;
    v = clamp((v - 0.5) * (0.8 + u_contrast * 2.0) + 0.5, 0.0, 1.0);

    fragColor0 = vec4(pal(v), 1.0);
}
