#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform sampler2D u_source;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform float u_pass;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

uniform float u_radius;
uniform float u_focus;
uniform float u_width;

vec3 sampleBlur(vec2 dir, float sigma) {
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
    return sum / wsum;
}

// 3 passes: H-blur → V-blur → keep a sharp horizontal focus band, blur the rest
// (miniature/tilt-shift look).
void main() {
    vec2 texel = 1.0 / u_resolution;
    float sigma = max(u_radius * u_resolution.y, 1.0);
    int p = int(u_pass + 0.5);
    if (p == 0) {
        fragColor0 = vec4(sampleBlur(vec2(texel.x, 0.0), sigma), 1.0);
    } else if (p == 1) {
        fragColor0 = vec4(sampleBlur(vec2(0.0, texel.y), sigma), 1.0);
    } else {
        vec3 sharp = texture(u_source, v_texCoord).rgb;
        vec3 blurred = texture(u_image0, v_texCoord).rgb;
        float d = abs(v_texCoord.y - u_focus);
        float m = smoothstep(u_width, u_width + 0.18, d);
        fragColor0 = vec4(mix(sharp, blurred, m), 1.0);
    }
}
