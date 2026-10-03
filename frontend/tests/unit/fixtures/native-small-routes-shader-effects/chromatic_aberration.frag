#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_amount;
uniform float u_centerX;
uniform float u_centerY;

void main() {
    // Radial RGB split: shift grows with distance from the center, like a real lens.
    vec2 c = vec2(u_centerX, u_centerY);
    vec2 off = (v_texCoord - c) * u_amount;
    float r = texture(u_image0, clamp(v_texCoord - off, 0.0, 1.0)).r;
    float g = texture(u_image0, v_texCoord).g;
    float b = texture(u_image0, clamp(v_texCoord + off, 0.0, 1.0)).b;
    fragColor0 = vec4(r, g, b, 1.0);
}
