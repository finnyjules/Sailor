#version 300 es
precision highp float;
uniform sampler2D u_image0;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_texCoord;
layout(location = 0) out vec4 fragColor0;

// CRYSTAL: a cut gem over the picture. Flat facets radiate from the centre in
// rings, each one bending the picture its own way, splitting it into a spectrum
// and catching the light on the faces that turn toward it. A port of the
// Shaders.com "Crystal" component (polygon shape); its default preset is the
// "Fluid Chrome" design.
//
// Stand-alone the gem is a regular polygon (Sides, Radius, Center). As a Frame
// lens the Frame hands over the layer's silhouette as a soft height field
// (u_shape, manifest followsShape), so the facets fill whatever shape the layer is.

uniform float u_centerX;
uniform float u_centerY;
uniform float u_radius;          // gem radius as a fraction of the shorter side
uniform float u_sides;           // polygon sides, stand-alone only
uniform float u_facets;          // how many times the facet pattern repeats around the centre
uniform float u_refraction;      // how strongly each facet bends the picture
uniform float u_dispersion;      // spectral split along the bend
uniform float u_innerZoom;       // magnification seen through the gem
uniform float u_edgeSoftness;    // fade at the boundary
uniform float u_lightAngle;      // where the light comes from, degrees clockwise from the right
uniform float u_highlights;      // brightening on faces toward the light, never darkens
uniform float u_shadows;         // darkening on faces away from the light, never brightens
uniform float u_brightness;      // overall push toward brilliant white
uniform float u_fresnel;         // even glow around the rim
uniform float u_fresnelSoftness; // how far the glow reaches inward
uniform vec3  u_fresnelColor;
uniform float u_cutout;          // 0 keep the picture outside the gem, 1 make it transparent

// Supplied by the Frame when the effect follows a layer's shape (see glass_lens).
uniform sampler2D u_shape;
uniform float u_hasShape;
uniform float u_shapeCX;
uniform float u_shapeCY;
uniform float u_shapeSize;

const float TAU = 6.28318530718;
const float PI  = 3.14159265359;

float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}
vec2 hash22(vec2 p) { float n = hash21(p); return vec2(n, hash21(p + n)); }

// Visible-spectrum colour for a normalised wavelength (the Zucconi fit crystal_prism uses).
vec3 bump3(vec3 x, vec3 y) { vec3 v = 1.0 - x * x; return clamp(v - y, 0.0, 1.0); }
vec3 spectral(float w) {
    vec3 c1 = vec3(3.54585104, 2.93225262, 2.41593945);
    vec3 x1 = vec3(0.69549072, 0.49228336, 0.27699880);
    vec3 y1 = vec3(0.02312639, 0.15225084, 0.52607955);
    vec3 c2 = vec3(3.90307140, 3.21182957, 3.96587128);
    vec3 x2 = vec3(0.11748627, 0.86755042, 0.66077860);
    vec3 y2 = vec3(0.84897130, 0.88445281, 0.73949448);
    return bump3(c1 * (w - x1), y1) + bump3(c2 * (w - x2), y2);
}

// Signed distance to a regular polygon of circumradius R with n sides, flat side down.
float polygonSDF(vec2 q, float R, float n) {
    float a = atan(q.x, q.y) + PI;
    float seg = TAU / n;
    float d = cos(floor(0.5 + a / seg) * seg - a) * length(q);
    return d - R * cos(seg * 0.5);
}

void main() {
    vec4 base = texture(u_image0, v_texCoord);
    float shortSide = min(u_resolution.x, u_resolution.y);
    vec2 asp = u_resolution / shortSide;
    vec2 p = v_texCoord * asp;

    vec2 c, rel;
    float R, cover, depth;
    if (u_hasShape > 0.5) {
        // Shape mode. R is the rim field (0.5 on the outline, blurred inward); G is
        // the true distance to the outline, 0 on the edge and 1 at the deepest point.
        // Coverage and the facet rings read G, so a star's thin arms are covered
        // and ringed like the rest; the fresnel rim reads R.
        c = vec2(u_shapeCX, u_shapeCY) * asp;
        R = max(u_shapeSize, 0.001);
        rel = p - c;
        vec4 sh = texture(u_shape, v_texCoord);
        depth = clamp((sh.r - 0.5) * 2.0, 0.0, 1.0);
        // Antialiased coverage from the SMOOTH rim field (R), not the faceted thumbnail distance
        // (G): R's 0.5 contour is the true outline, so an fwidth step gives a crisp, non-stepped
        // edge instead of the thumbnail's stair-steps; edgeSoftness widens the feather (see chrome).
        float aaCov = fwidth(sh.r) + 1e-5;
        cover = smoothstep(0.5 - aaCov - u_edgeSoftness * 0.15, 0.5 + aaCov, sh.r);
    } else {
        c = vec2(u_centerX, u_centerY) * asp;
        R = max(u_radius, 0.001);
        rel = p - c;
        float d = polygonSDF(rel, R, max(floor(u_sides + 0.5), 3.0));
        float soft = max(u_edgeSoftness, 0.001) * R;
        cover = 1.0 - smoothstep(0.0, soft, d);
        depth = clamp(-d / (0.35 * R), 0.0, 1.0);   // 0 at the rim, 1 a third of the way in
    }

    // ---- Facets: a kaleidoscope of ringed triangles ----
    // The angle is folded into `facets` mirrored sectors, so the pattern repeats
    // around the centre the way a cut stone does. Inside a sector the space is
    // ringed (rings tighter near the centre) and each ring is split into cells,
    // more of them the further out, each cell cut on its diagonal into two flat
    // triangular faces. A face's normal is seeded, then turned back into the world
    // by the sector it sits in, so the light falls on one side of the gem.
    float r = length(rel);
    // How far out this pixel sits, 0 at the middle and 1 on the outline: the
    // circle's own radius stand-alone, the silhouette's depth when following a shape.
    float rn = u_hasShape > 0.5 ? clamp(1.0 - texture(u_shape, v_texCoord).g, 0.0, 1.0) : clamp(r / R, 0.0, 1.0);
    float ang = atan(rel.y, rel.x);
    float n = max(floor(u_facets + 0.5), 3.0);
    float seg = TAU / n;
    float aw = ang + PI;
    float sector = floor(aw / seg);
    float af = aw - sector * seg;                // 0 .. seg
    float mirror = af > seg * 0.5 ? -1.0 : 1.0;  // second half of the sector is a mirror
    af = min(af, seg - af);                      // folded: 0 .. seg/2

    const float RINGS = 10.0;
    float rk = sqrt(rn) * RINGS;                 // rings tighter toward the centre
    float ring = min(floor(rk), RINGS - 1.0);
    float fr = rk - ring;
    // Cells per half-sector: as many as keep a cell about as wide as its ring is tall,
    // so the faces come out roughly equilateral rather than as thin spokes.
    float rMid = pow((ring + 0.5) / RINGS, 2.0) * R;
    float ringH = ((ring + 1.0) * (ring + 1.0) - ring * ring) / (RINGS * RINGS) * R;
    float m = max(floor(2.0 * rMid * seg * 0.5 / ringH + 0.5), 1.0);
    float u = af / (seg * 0.5) * m;
    float ci = floor(u);
    float fu = u - ci;
    float tri = (fu + fr < 1.0) ? 0.0 : 1.0;
    vec2 cid = vec2(ring * 37.0 + ci, tri + u_seed * 0.173);

    // Face normal in the sector's own frame (radial, tangential), leaning outward
    // more on the outer rings, with a seeded tilt so no two faces match.
    vec2 jit = (hash22(cid) - 0.5) * 1.6;
    float lean = mix(0.1, 0.6, ring / (RINGS - 1.0));
    vec2 nLocal = vec2(lean + jit.x, jit.y * mirror);   // (radial, tangential)
    vec2 outDir = vec2(cos(ang), sin(ang));
    vec2 tanDir = vec2(-outDir.y, outDir.x);
    vec3 nrm = normalize(vec3(outDir * nLocal.x + tanDir * nLocal.y, 1.0));

    // ---- Refraction: each face shifts its slice of the picture along its normal ----
    float mag = 0.6 + 0.4 * hash21(cid + 4.0);
    vec2 shift = -nrm.xy * u_refraction * R * 0.18 * mag;
    vec2 q = c + rel / max(u_innerZoom, 0.1);
    vec2 baseUv = (q + shift) / asp;

    // ---- Dispersion: integrate across the spectrum, each wavelength bent a little differently ----
    vec2 dispDir = length(shift) > 1e-5 ? normalize(shift) / asp : vec2(0.0);
    float spread = u_dispersion * R * 0.1 * mag;
    const int NSPEC = 12;
    vec3 col = vec3(0.0);
    vec3 wsum = vec3(0.0);
    for (int i = 0; i < NSPEC; i++) {
        float t = (float(i) + 0.5) / float(NSPEC);
        vec3 sw = spectral(t);
        vec2 off = dispDir * spread * (t - 0.5) * 2.0;
        col += texture(u_image0, clamp(baseUv + off, 0.0, 1.0)).rgb * sw;
        wsum += sw;
    }
    col /= max(wsum, vec3(1e-4));

    // ---- Lighting: faces toward the light brighten, faces away darken ----
    float la = radians(u_lightAngle);
    vec3 L = normalize(vec3(cos(la), -sin(la), 0.9));      // degrees clockwise as on screen
    float ndl = dot(nrm, L);
    float lit = max(ndl, 0.0);
    float spec = pow(lit, 20.0);
    col += u_highlights * (0.08 * lit + 1.8 * spec);
    col *= 1.0 - u_shadows * max(-ndl, 0.0);
    col *= u_brightness;

    // Seams: a thin light line where faces meet (cell walls, ring walls, the diagonal).
    float cellW = seg * 0.5 / m * r;                      // a cell's angular width in units
    float ringW = ringH;
    float dU = min(fu, 1.0 - fu) * cellW;
    float dR = min(fr, 1.0 - fr) * ringW;
    float dD = abs(fu + fr - 1.0) * 0.7071 * min(cellW, ringW);
    float seamPx = 1.2 / shortSide;
    float seam = 1.0 - smoothstep(0.0, seamPx * 1.5, min(min(dU, dR), dD));
    col += seam * 0.08 * u_brightness;

    // ---- Fresnel rim ----
    float fw = max(u_fresnelSoftness, 0.001);
    float fres = pow(clamp(1.0 - depth, 0.0, 1.0), 1.0 / fw) * u_fresnel;
    col += u_fresnelColor * fres;

    vec3 outside = u_cutout > 0.5 ? vec3(0.0) : base.rgb;
    float aOut = u_cutout > 0.5 ? 0.0 : base.a;
    fragColor0 = vec4(mix(outside, clamp(col, 0.0, 1.0), cover), mix(aOut, 1.0, cover));
}
