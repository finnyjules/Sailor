#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_temperature;
uniform float u_tint;

void main() {
    vec3 c = texture(u_image0, v_texCoord).rgb;
    c.r += u_temperature * 0.12;
    c.b -= u_temperature * 0.12;
    c.g += u_tint * 0.10;
    fragColor0 = vec4(clamp(c, 0.0, 1.0), 1.0);
}
