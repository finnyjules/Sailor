#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_strength;
uniform float u_centerX;
uniform float u_centerY;

void main() {
    vec2 c = vec2(u_centerX, u_centerY);
    vec2 dir = v_texCoord - c;
    const int N = 24;
    vec3 col = vec3(0.0);
    for (int i = 0; i < N; i++) {
        float s = float(i) / float(N - 1);
        float scale = 1.0 - u_strength * s;
        col += texture(u_image0, clamp(c + dir * scale, 0.0, 1.0)).rgb;
    }
    fragColor0 = vec4(col / float(N), 1.0);
}
