#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_levels;

void main() {
    vec3 c = texture(u_image0, v_texCoord).rgb;
    float L = max(u_levels, 2.0) - 1.0;
    fragColor0 = vec4(floor(c * L + 0.5) / L, 1.0);
}
