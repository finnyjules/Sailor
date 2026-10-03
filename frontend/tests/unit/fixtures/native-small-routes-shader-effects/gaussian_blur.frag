#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_pass;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_radius;

// Separable Gaussian: pass 0 blurs horizontally, pass 1 vertically.
void main() {
    vec2 texel = 1.0 / u_resolution;
    vec2 dir = (u_pass < 0.5) ? vec2(texel.x, 0.0) : vec2(0.0, texel.y);
    float sigma = max(u_radius * u_resolution.y, 1.0);
    int K = int(clamp(sigma * 2.0, 1.0, 24.0));

    vec3 sum = texture(u_image0, v_texCoord).rgb;
    float wsum = 1.0;
    for (int i = 1; i <= 24; i++) {
        if (i > K) break;
        float w = exp(-0.5 * float(i * i) / (sigma * sigma));
        sum += texture(u_image0, clamp(v_texCoord + dir * float(i), 0.0, 1.0)).rgb * w;
        sum += texture(u_image0, clamp(v_texCoord - dir * float(i), 0.0, 1.0)).rgb * w;
        wsum += 2.0 * w;
    }
    fragColor0 = vec4(sum / wsum, 1.0);
}
