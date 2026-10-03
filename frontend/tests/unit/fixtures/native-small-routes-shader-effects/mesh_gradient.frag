#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_speed;
uniform float u_blend;
uniform float u_hue;
uniform float u_saturation;

vec3 pal(float t) {
    vec3 base = 0.5 + 0.5 * cos(6.28318 * (vec3(1.0) * t + vec3(0.0, 0.33, 0.66) + u_hue));
    return mix(vec3(dot(base, vec3(0.299, 0.587, 0.114))), base, u_saturation);
}

void main() {
    vec2 asp = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 uv = (v_texCoord - 0.5) * asp + 0.5;
    float t = u_time * u_speed * 0.4;

    // Four drifting color anchors, soft inverse-distance blend → smooth mesh.
    vec3 col = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 4; i++) {
        float fi = float(i);
        vec2 c = 0.5 + 0.42 * vec2(
            sin(t + fi * 1.7 + u_seed * 0.01),
            cos(t * 1.13 + fi * 2.3 + u_seed * 0.017)
        );
        float dist = length(uv - c);
        float w = 1.0 / pow(dist + 0.04, mix(1.5, 3.5, u_blend));
        col += pal(0.15 + fi * 0.23) * w;
        wsum += w;
    }
    col /= max(wsum, 1e-4);
    fragColor0 = vec4(clamp(col, 0.0, 1.0), 1.0);
}
