#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_size;

void main() {
    vec2 cellPx = vec2(max(u_size * u_resolution.y, 1.0));
    vec2 px = v_texCoord * u_resolution;
    vec2 cuv = (floor(px / cellPx) + 0.5) * cellPx / u_resolution;
    fragColor0 = vec4(texture(u_image0, clamp(cuv, 0.0, 1.0)).rgb, 1.0);
}
