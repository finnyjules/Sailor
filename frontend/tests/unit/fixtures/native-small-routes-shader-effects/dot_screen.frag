#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_size;
uniform float u_angle;

// Per-channel rotated dot grid (classic CMY screen): each channel sampled on a
// grid rotated by a different angle, dot radius driven by channel darkness.
float channelDots(float value, float ang) {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    mat2 R = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
    vec2 g = (R * ((v_texCoord - 0.5) * asp)) / u_size;
    float d = length(fract(g) - 0.5);
    float radius = sqrt(clamp(1.0 - value, 0.0, 1.0)) * 0.7071;
    return smoothstep(radius, radius - 0.08, d);   // 1 inside the dot
}

void main() {
    vec3 col = texture(u_image0, v_texCoord).rgb;
    float a = radians(u_angle);
    // Subtractive screens on white: more ink where the channel is darker.
    float c = channelDots(col.r, a);
    float m = channelDots(col.g, a + radians(20.0));
    float y = channelDots(col.b, a + radians(40.0));
    vec3 ink = 1.0 - vec3(1.0 - col.r, 1.0 - col.g, 1.0 - col.b) * vec3(c, m, y);
    fragColor0 = vec4(ink, 1.0);
}
