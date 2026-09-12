#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// GLASS LENS: a round pane of thick glass over the input. The rim refracts what is
// beneath (pulling the picture inward the way a lens edge does), splits the colours
// along the bend, and carries a directional highlight and a soft fresnel rim.
// A port of the Shaders.com "Glass" component (circle shape); its default preset
// is the "Fluid Chrome" design.
//
// Used as a Frame lens, the whole backdrop is the input and the Frame also hands
// over the layer's silhouette as a soft height field (u_shape), so the rim, bend and
// highlight follow the real shape; Center and Radius then describe only the
// stand-alone circle (u_hasShape = 0).

uniform float u_centerX;         // lens centre
uniform float u_centerY;
uniform float u_radius;          // lens radius as a fraction of the shorter side
uniform float u_refraction;      // how hard the rim bends what is beneath
uniform float u_thickness;       // how far inward from the rim the bend reaches
uniform float u_aberration;      // colour split along the bend
uniform float u_innerZoom;       // magnification of the picture seen through the glass
uniform float u_edgeSoftness;    // fade width at the boundary
uniform float u_blur;            // frosting inside the glass, in pixels
uniform float u_lightAngle;      // where the light comes from, degrees
uniform float u_highlight;       // strength of the rim highlight facing the light
uniform float u_highlightSoftness;
uniform vec3  u_highlightColor;
uniform float u_fresnel;         // even glow around the rim
uniform float u_fresnelSoftness; // how far the glow reaches inward
uniform vec3  u_fresnelColor;
uniform float u_cutout;          // 0 keep the input outside the glass, 1 make it transparent

// Supplied by the Frame when the effect follows a layer's shape (manifest followsShape):
// a blurred silhouette (0 outside, 1 deep inside, 0.5 on the edge), plus the shape's
// centre (texture space, y up) and its half short side as a fraction of the shorter
// canvas side, which stands in for Radius.
uniform sampler2D u_shape;
uniform float u_hasShape;
uniform float u_shapeCX;
uniform float u_shapeCY;
uniform float u_shapeSize;

vec3 sampleLens(vec2 uv, float px) {
    // A small disc blur for frosting; a single tap when clear.
    if (px < 0.25) return texture(u_image0, uv).rgb;
    vec2 s = px / u_resolution;
    vec3 acc = texture(u_image0, uv).rgb * 2.0;
    acc += texture(u_image0, uv + vec2( 1.0,  0.0) * s).rgb;
    acc += texture(u_image0, uv + vec2(-1.0,  0.0) * s).rgb;
    acc += texture(u_image0, uv + vec2( 0.0,  1.0) * s).rgb;
    acc += texture(u_image0, uv + vec2( 0.0, -1.0) * s).rgb;
    acc += texture(u_image0, uv + vec2( 0.7,  0.7) * s).rgb;
    acc += texture(u_image0, uv + vec2(-0.7,  0.7) * s).rgb;
    acc += texture(u_image0, uv + vec2( 0.7, -0.7) * s).rgb;
    acc += texture(u_image0, uv + vec2(-0.7, -0.7) * s).rgb;
    return acc / 10.0;
}

void main() {
    vec4 base = texture(u_image0, v_texCoord);
    // Aspect-corrected space where a circle is round and the shorter side is 1.
    float shortSide = min(u_resolution.x, u_resolution.y);
    vec2 asp = u_resolution / shortSide;
    vec2 p = v_texCoord * asp;
    vec2 c, n, rel;
    float R, cover, depth;
    if (u_hasShape > 0.5) {
        // Shape mode: the height field carries the edge. Its blur radius is the glass
        // thickness, so 0.5 is the rim and 1.0 is one thickness inside.
        c = vec2(u_shapeCX, u_shapeCY) * asp;
        R = max(u_shapeSize, 0.001);
        rel = p - c;
        vec4 sh = texture(u_shape, v_texCoord);
        float h = sh.r;
        vec2 px = 1.5 / u_resolution;
        float gx = texture(u_shape, v_texCoord + vec2(px.x, 0.0)).r - texture(u_shape, v_texCoord - vec2(px.x, 0.0)).r;
        float gy = texture(u_shape, v_texCoord + vec2(0.0, px.y)).r - texture(u_shape, v_texCoord - vec2(0.0, px.y)).r;
        vec2 g = vec2(gx, gy) / asp;        // gradient in the round space; points inward
        float gl = length(g);
        n = gl > 1e-6 ? -g / gl : vec2(0.0, 1.0);
        depth = clamp((h - 0.5) * 2.0, 0.0, 1.0);
        // Coverage reads the true distance field (G), not the blurred rim: a thin
        // arm of a star blurs below the halfway level and would otherwise drop out.
        // Antialiased coverage from the SMOOTH rim field (R), not the faceted thumbnail distance
        // (G): R's 0.5 contour is the true outline, so an fwidth step gives a crisp, non-stepped
        // edge instead of the thumbnail's stair-steps; edgeSoftness widens the feather (see chrome).
        float aaCov = fwidth(sh.r) + 1e-5;
        cover = smoothstep(0.5 - aaCov - u_edgeSoftness * 0.15, 0.5 + aaCov, sh.r);
    } else {
        c = vec2(u_centerX, u_centerY) * asp;
        R = max(u_radius, 0.001);
        rel = p - c;
        float r = length(rel);
        n = r > 1e-5 ? rel / r : vec2(0.0, 1.0);
        float d = r - R;                      // signed distance to the rim, negative inside

        // Coverage: solid inside, fading over the edge softness.
        float soft = max(u_edgeSoftness, 0.001) * R;
        cover = 1.0 - smoothstep(0.0, soft, d);

        // Bend: zero at the centre, strongest at the rim, over the glass thickness.
        depth = clamp(-d / (max(u_thickness, 0.001) * R), 0.0, 1.0);
    }
    float bend = 1.0 - depth;
    bend = bend * bend;

    // Refract: pull the sample inward along the normal, plus the inner zoom about the centre.
    float pull = bend * u_refraction * R * 0.5;
    vec2 q = c + rel / max(u_innerZoom, 0.1);
    vec2 baseUv = q / asp;
    vec2 shift = -n * pull / asp;
    float ab = u_aberration * 0.25;
    vec3 col;
    col.r = sampleLens(clamp(baseUv + shift * (1.0 + ab), 0.0, 1.0), u_blur).r;
    col.g = sampleLens(clamp(baseUv + shift,              0.0, 1.0), u_blur).g;
    col.b = sampleLens(clamp(baseUv + shift * (1.0 - ab), 0.0, 1.0), u_blur).b;

    // Directional highlight: a band just inside the rim, on the side facing the light.
    float ang = radians(u_lightAngle);
    // Degrees run clockwise from the right as on screen; v_texCoord.y = 1 is the visual top.
    vec2 L = vec2(cos(ang), -sin(ang));
    float facing = max(dot(n, L), 0.0);
    float hs = mix(24.0, 2.0, clamp(u_highlightSoftness, 0.0, 1.0));
    float rimBand = smoothstep(0.0, 0.35, bend) * (1.0 - smoothstep(0.9, 1.0, bend));
    float glint = pow(facing, hs) * rimBand * u_highlight * 4.0;
    col += u_highlightColor * glint;

    // Fresnel: an even glow that grows toward the rim, reaching inward by its softness.
    float fw = max(u_fresnelSoftness, 0.001);
    float fres = pow(clamp(1.0 - depth, 0.0, 1.0), 1.0 / fw) * u_fresnel;
    col += u_fresnelColor * fres;

    vec3 outside = u_cutout > 0.5 ? vec3(0.0) : base.rgb;
    float aOut = u_cutout > 0.5 ? 0.0 : base.a;
    fragColor0 = vec4(mix(outside, clamp(col, 0.0, 1.0), cover), mix(aOut, 1.0, cover));
}
